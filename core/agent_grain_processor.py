from __future__ import annotations

import json
import os
from collections.abc import Callable, Iterator
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

from core.text_extractor import TextExtractor

# Ollama 直连示例: http://127.0.0.1:11434 ；经 Nginx 反代时常为 http://host/ollama（最终请求 .../api/generate）
DEFAULT_OLLAMA_URL = os.getenv("OLLAMA_URL", "http://172.31.38.168/ollama")
DEFAULT_MODEL = os.getenv("OLLAMA_MODEL", "gemma4-fast")
# 客户端 read timeout；若经 Nginx，需保证 proxy_read_timeout / send_timeout 大于此值，否则会先被网关断开
DEFAULT_OLLAMA_TIMEOUT = int(os.getenv("OLLAMA_TIMEOUT_SECONDS", "600"))


def _utc_now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _call_ollama(
    prompt: str,
    *,
    ollama_url: str,
    model: str,
    timeout_seconds: int = DEFAULT_OLLAMA_TIMEOUT,
) -> str:
    """Call Ollama generate API (optionally via reverse proxy)."""
    data = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {"num_ctx": 4096, "temperature": 0.3},
    }
    resp = requests.post(f"{ollama_url.rstrip('/')}/api/generate", json=data, timeout=timeout_seconds)
    resp.raise_for_status()
    payload = resp.json()
    if not isinstance(payload, dict) or "response" not in payload:
        raise ValueError("Invalid Ollama response payload")
    text = str(payload["response"])
    if text.strip() == "":
        raise ValueError("Empty Ollama response")
    return text


def _extract_json_object(raw: str) -> str:
    """Best-effort: pull the first JSON object from a raw model response."""
    s = (raw or "").strip()
    if not s:
        return s
    # Common case: model already returns pure JSON
    if s.startswith("{") and s.endswith("}"):
        return s
    # Fallback: find first '{' and last '}' and parse that slice
    start = s.find("{")
    end = s.rfind("}")
    if start != -1 and end != -1 and end > start:
        return s[start : end + 1]
    return s


def _chapter_key(idx: int) -> str:
    return f"chapter_{idx}"


def _normalize_chapter_keys(chapters: dict) -> dict:
    """Merge chapter_1 / chapter_001 style keys into canonical chapter_{n}."""
    out: dict[str, dict] = {}
    for k, v in chapters.items():
        if not isinstance(k, str) or not isinstance(v, dict):
            continue
        if k.startswith("chapter_"):
            suffix = k[len("chapter_") :]
            try:
                n = int(suffix)
            except ValueError:
                continue
            out[_chapter_key(n)] = v
    return out


def _chapter_succeeded(entry: dict | None) -> bool:
    """True if this chapter looks successfully generated (not a placeholder failure)."""
    if not entry or not isinstance(entry, dict):
        return False
    act = entry.get("actionable")
    if isinstance(act, str) and act.startswith("处理失败"):
        return False
    kp = entry.get("key_points")
    if not isinstance(kp, list) or len(kp) == 0:
        return False
    return True


def iter_chapters_from_oebps(book_dir: Path) -> Iterator[tuple[str, str]]:
    """Yield (chapter_title, plain_text) from downloaded book directory.

    Expected structure: <book_dir>/OEBPS/*.xhtml written by the downloader.
    """
    oebps = book_dir / "OEBPS"
    if not oebps.is_dir():
        raise FileNotFoundError(f"OEBPS directory not found: {oebps}")

    extractor = TextExtractor()
    files = sorted(oebps.rglob("*.xhtml"))
    if not files:
        # Some books may still have .html if generated differently
        files = sorted(oebps.rglob("*.html"))
    if not files:
        raise FileNotFoundError(f"No chapter files found under: {oebps}")

    for fp in files:
        try:
            raw = fp.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue

        title = fp.stem
        try:
            soup = BeautifulSoup(raw, "html.parser")
            h = soup.find("h1") or soup.find("h2") or soup.find("title")
            if h is not None:
                t = h.get_text(" ", strip=True)
                if t:
                    title = t
        except Exception:
            pass

        text = extractor.extract_text_only(raw)
        text = (text or "").strip()
        if len(text) < 200:
            continue
        yield (title, text)


def generate_agent_knowledge(
    book_dir: Path,
    *,
    ollama_url: str = DEFAULT_OLLAMA_URL,
    model: str = DEFAULT_MODEL,
    timeout_seconds: int = DEFAULT_OLLAMA_TIMEOUT,
    force_full: bool = False,
    progress_callback: Callable[[str, int, int], None] | None = None,
) -> dict:
    """Generate agent knowledge JSON and write it under the book directory.

    Idempotent:
    - No existing ``agent_knowledge.json`` (or ``force_full``): generate all chapters.
    - Otherwise: only re-call LLM for chapters that are missing or previously failed
      (e.g. ``actionable`` starts with ``处理失败`` or ``key_points`` empty).

    Outputs (under <book_dir>/Knowledge/):
    - agent_knowledge.json
    - kg_graph.json
    """
    book_dir = book_dir.resolve()
    out_dir = book_dir / "Knowledge"
    out_dir.mkdir(parents=True, exist_ok=True)
    debug_dir = out_dir / "_debug_ollama"
    debug_dir.mkdir(parents=True, exist_ok=True)

    chapters = list(iter_chapters_from_oebps(book_dir))
    total = len(chapters)
    if total == 0:
        raise ValueError("No non-empty chapters found in OEBPS")

    def report(phase: str, current: int, total_: int):
        if progress_callback is not None:
            progress_callback(phase, current, total_)

    report("starting", 0, total)

    agent_path = out_dir / "agent_knowledge.json"
    existing_chapters: dict = {}
    if not force_full and agent_path.is_file():
        try:
            prev = json.loads(agent_path.read_text(encoding="utf-8"))
            if isinstance(prev, dict) and isinstance(prev.get("chapters"), dict):
                existing_chapters = _normalize_chapter_keys(prev["chapters"])
        except (json.JSONDecodeError, OSError):
            existing_chapters = {}

    full_json: dict = {
        "metadata": {
            "source": "O'Reilly",
            "model_used": model,
            "processed_at": _utc_now_iso(),
            "book_dir": str(book_dir),
            "ollama_timeout_seconds": timeout_seconds,
        },
        "chapters": dict(existing_chapters),
    }

    to_process: list[tuple[int, str, str, str]] = []
    for idx, (title, content) in enumerate(chapters, 1):
        key = _chapter_key(idx)
        if force_full or not _chapter_succeeded(full_json["chapters"].get(key)):
            to_process.append((idx, title, content, key))

    n_todo = len(to_process)
    if n_todo == 0:
        report("skipped_chapters", total, total)
    else:
        for j, (idx, title, content, key) in enumerate(to_process, 1):
            report("processing_chapter", j, n_todo)
            prompt = (
                f"请严格按以下JSON格式输出本书第{idx}章《{title}》的Agent知识粮：\n"
                "{\n"
                f'  \"title\": \"{title}\",\n'
                '  \"key_points\": [\"要点1\", \"要点2\", ...],\n'
                '  \"actionable\": \"Agent可直接执行的行动清单（3-5条）\"\n'
                "}\n"
                f"内容：{content[:12000]}\n"
                "只输出纯JSON，不要任何解释。"
            )
            try:
                result = _call_ollama(
                    prompt, ollama_url=ollama_url, model=model, timeout_seconds=timeout_seconds
                )
                (debug_dir / f"chapter_{idx:03d}_raw.txt").write_text(result, encoding="utf-8")
                chapter_json = json.loads(_extract_json_object(result))
                full_json["chapters"][key] = chapter_json
            except Exception as e:
                err_txt = f"{type(e).__name__}: {e}"
                try:
                    (debug_dir / f"chapter_{idx:03d}_error.txt").write_text(err_txt, encoding="utf-8")
                except OSError:
                    pass
                full_json["chapters"][key] = {
                    "title": title,
                    "key_points": [],
                    "actionable": f"处理失败: {err_txt}",
                }

    agent_path.write_text(json.dumps(full_json, ensure_ascii=False, indent=2), encoding="utf-8")

    kg_path = out_dir / "kg_graph.json"
    need_graph = n_todo > 0 or force_full or not kg_path.is_file()
    if need_graph:
        report("generating_graph", total, total)
        graph_prompt = (
            "根据下面整本书的Agent JSON，提取知识图谱（聚焦AI Agent核心概念）。\n"
            f"{json.dumps(full_json, ensure_ascii=False)[:8000]}\n"
            "输出纯JSON：\n"
            "{\n"
            "  \"nodes\": [\"节点1\", \"节点2\", ...],\n"
            "  \"edges\": [[\"节点A\", \"关系\", \"节点B\"], ...]\n"
            "}"
        )
        try:
            graph_raw = _call_ollama(
                graph_prompt, ollama_url=ollama_url, model=model, timeout_seconds=timeout_seconds
            )
            (debug_dir / "graph_raw.txt").write_text(graph_raw, encoding="utf-8")
            kg = json.loads(_extract_json_object(graph_raw))
        except Exception:
            kg = {"nodes": [], "edges": []}
        kg_path.write_text(json.dumps(kg, ensure_ascii=False, indent=2), encoding="utf-8")

    report("completed", total, total)
    return {
        "knowledge_dir": str(out_dir),
        "agent_json": str(agent_path),
        "kg_graph": str(kg_path),
        "chapters_total": total,
        "chapters_regenerated": n_todo,
        "force_full": force_full,
    }