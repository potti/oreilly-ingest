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


# Property graph: relations must be chosen from this set (prompt + post-filter).
KG_ALLOWED_RELATIONS = frozenset(
    {
        "uses",
        "requires",
        "enables",
        "improves",
        "coordinates",
        "feeds_into",
        "consists_of",
        "superior_to",
        "combines",
        "detects",
        "measures",
        "extends",
        "critical_for",
        "stores_in",
    }
)

KG_NODE_TYPES = frozenset(
    {
        "Core_Concept",
        "Agent_Type",
        "Component",
        "Technique",
        "Production",
    }
)

KG_MAX_NODES = 30
KG_MAX_EDGES = 50
KG_JSON_PREVIEW_CHARS = 12000


def generate_kg_edges(
    full_json: dict,
    *,
    ollama_url: str,
    model: str,
    timeout_seconds: int,
) -> dict:
    """Extract a property-graph style KG from full agent_knowledge JSON (Ollama / gemma-friendly prompt)."""
    meta_in = full_json.get("metadata") if isinstance(full_json.get("metadata"), dict) else {}
    source_label = str(meta_in.get("book_dir") or meta_in.get("source") or "O'Reilly")
    generated_day = _utc_now_iso()[:10]

    payload_preview = json.dumps(full_json, ensure_ascii=False, indent=2)[:KG_JSON_PREVIEW_CHARS]

    prompt = f"""
你现在是一个知识图谱专家。请严格根据下面整本书的Agent JSON，提取高质量的Property Graph。
只输出纯JSON，不要任何解释、markdown或额外文字。

JSON内容：
{payload_preview}

要求：
1. 节点（nodes）最多{KG_MAX_NODES}个，优先提取核心概念、Agent类型、组件、技术。
2. 关系（edges）最多{KG_MAX_EDGES}条，使用以下固定关系词汇（必须从下面选）：
   - uses, requires, enables, improves, coordinates, feeds_into, consists_of, superior_to, combines, detects, measures, extends, critical_for, stores_in
3. 每条边必须包含 source_chapter 字段（例如 "chapter_5"）。
4. 节点必须有 id、label、type 三个字段；type 必须是以下之一：
   Core_Concept, Agent_Type, Component, Technique, Production

输出格式必须严格如下：
{{
  "metadata": {{
    "source": "{source_label}",
    "generated_at": "{generated_day}",
    "total_nodes": 0,
    "total_edges": 0
  }},
  "nodes": [
    {{"id": "节点ID", "label": "显示名称", "type": "Core_Concept"}}
  ],
  "edges": [
    {{"source": "节点A_id", "relation": "uses", "target": "节点B_id", "source_chapter": "chapter_5"}}
  ]
}}
"""

    def _empty_kg(err: str) -> dict:
        return {
            "metadata": {
                "source": source_label,
                "generated_at": generated_day,
                "total_nodes": 0,
                "total_edges": 0,
                "error": err,
            },
            "nodes": [],
            "edges": [],
        }

    try:
        result = _call_ollama(
            prompt, ollama_url=ollama_url, model=model, timeout_seconds=timeout_seconds
        )
        kg = json.loads(_extract_json_object(result.strip()))
    except Exception as e:
        return _empty_kg(str(e))

    if not isinstance(kg, dict):
        return _empty_kg("parsed payload is not a JSON object")

    raw_nodes = kg.get("nodes")
    raw_edges = kg.get("edges")
    if not isinstance(raw_nodes, list):
        raw_nodes = []
    if not isinstance(raw_edges, list):
        raw_edges = []

    seen_ids: set[str] = set()
    unique_nodes: list[dict] = []
    for node in raw_nodes:
        if not isinstance(node, dict):
            continue
        nid = node.get("id")
        if nid is None or (isinstance(nid, str) and not nid.strip()):
            continue
        nid_s = str(nid).strip()
        if nid_s in seen_ids:
            continue
        seen_ids.add(nid_s)
        label = node.get("label")
        ntype = node.get("type")
        if not isinstance(label, str) or not label.strip():
            label = nid_s
        if not isinstance(ntype, str) or ntype not in KG_NODE_TYPES:
            ntype = "Core_Concept"
        unique_nodes.append({"id": nid_s, "label": label.strip(), "type": ntype})
        if len(unique_nodes) >= KG_MAX_NODES:
            break

    node_ids = {n["id"] for n in unique_nodes}
    valid_edges: list[dict] = []
    for e in raw_edges:
        if not isinstance(e, dict):
            continue
        rel = e.get("relation")
        if not isinstance(rel, str) or rel not in KG_ALLOWED_RELATIONS:
            continue
        src, tgt = e.get("source"), e.get("target")
        if not isinstance(src, str) or not isinstance(tgt, str):
            continue
        src, tgt = src.strip(), tgt.strip()
        if src not in node_ids or tgt not in node_ids:
            continue
        sc = e.get("source_chapter")
        if not isinstance(sc, str) or not sc.strip().startswith("chapter_"):
            continue
        valid_edges.append(
            {
                "source": src,
                "relation": rel,
                "target": tgt,
                "source_chapter": sc.strip(),
            }
        )
        if len(valid_edges) >= KG_MAX_EDGES:
            break

    md = kg.get("metadata") if isinstance(kg.get("metadata"), dict) else {}
    md = {
        "source": str(md.get("source") or source_label),
        "generated_at": str(md.get("generated_at") or generated_day),
        "total_nodes": len(unique_nodes),
        "total_edges": len(valid_edges),
    }
    if "model_used" in meta_in:
        md["model_used"] = meta_in["model_used"]

    return {"metadata": md, "nodes": unique_nodes, "edges": valid_edges}


def _kg_graph_needs_generation(kg_path: Path) -> bool:
    """True if kg_graph.json is missing, unreadable, or has no nodes and no edges."""
    if not kg_path.is_file():
        return True
    try:
        raw = kg_path.read_text(encoding="utf-8").strip()
        if not raw:
            return True
        data = json.loads(raw)
    except (json.JSONDecodeError, OSError):
        return True
    if not isinstance(data, dict):
        return True
    nodes = data.get("nodes")
    edges = data.get("edges")
    n = len(nodes) if isinstance(nodes, list) else 0
    e = len(edges) if isinstance(edges, list) else 0
    if n == 0 and e == 0:
        return True
    return False


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


def knowledge_stats_for_book(book_dir: Path) -> dict:
    """Summarize agent_knowledge.json: how many chapter entries look failed vs total."""
    book_dir = book_dir.resolve()
    agent_path = book_dir / "Knowledge" / "agent_knowledge.json"
    if not agent_path.is_file():
        return {
            "exists": False,
            "path": str(agent_path),
            "error_count": None,
            "chapter_count": 0,
            "failed_chapter_keys": [],
            "message": "尚未生成 Knowledge/agent_knowledge.json",
        }
    try:
        raw_data = json.loads(agent_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        return {
            "exists": True,
            "path": str(agent_path),
            "error_count": None,
            "chapter_count": 0,
            "failed_chapter_keys": [],
            "message": f"无法解析 JSON: {e}",
            "parse_error": True,
        }
    if not isinstance(raw_data, dict):
        return {
            "exists": True,
            "path": str(agent_path),
            "error_count": None,
            "chapter_count": 0,
            "failed_chapter_keys": [],
            "message": "根节点不是对象",
            "parse_error": True,
        }
    chapters = _normalize_chapter_keys(raw_data.get("chapters") or {})

    def _sort_key(k: str) -> int:
        if k.startswith("chapter_"):
            try:
                return int(k[len("chapter_") :])
            except ValueError:
                pass
        return 0

    failed_keys = sorted(
        [k for k, v in chapters.items() if not _chapter_succeeded(v)],
        key=_sort_key,
    )
    return {
        "exists": True,
        "path": str(agent_path),
        "error_count": len(failed_keys),
        "chapter_count": len(chapters),
        "failed_chapter_keys": failed_keys,
        "message": "",
    }


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
    need_graph = n_todo > 0 or force_full or _kg_graph_needs_generation(kg_path)
    if need_graph:
        report("generating_graph", total, total)
        kg = generate_kg_edges(
            full_json,
            ollama_url=ollama_url,
            model=model,
            timeout_seconds=timeout_seconds,
        )
        try:
            gr = json.dumps(kg, ensure_ascii=False, indent=2)
            (debug_dir / "graph_raw.txt").write_text(gr, encoding="utf-8")
        except OSError:
            pass
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