"""
将 agent_grain_processor 生成的 knowledge 导入 Obsidian Vault。

写入 sources/ 目录（书籍来源溯源卡），包含：
- 章节核心要点 + 行动建议
- 书名/作者 wikilink
- 概念关键词 wikilink（基于 KG 图谱节点，如有）
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

LOGGER = logging.getLogger(__name__)

DEFAULT_OBSIDIAN_VAULT = Path("/home/ubuntu/.openclaw/obsidian_vault")

FOLDERS = {
    "Core_Concept": "concepts",
    "Agent_Type": "concepts",
    "Component": "concepts",
    "Technique": "concepts",
    "Production": "events",
}


def safe_filename(name: str) -> str:
    return "".join(c if c.isalnum() or c in " _-()" else "_" for c in name).strip()[:100]


def _load_book_metadata(knowledge_dir: Path) -> dict:
    """Try to load rich book metadata from the exported .json in book root."""
    book_root = knowledge_dir.parent
    for json_file in sorted(book_root.glob("*.json")):
        if json_file.name.startswith(".") or json_file.name == "agent_knowledge.json":
            continue
        try:
            data = json.loads(json_file.read_text(encoding="utf-8"))
            if isinstance(data, dict) and "metadata" in data:
                meta = data["metadata"]
                if isinstance(meta, dict) and meta.get("title"):
                    return meta
        except Exception:
            continue
    return {}


def _inject_wikilinks(text: str, link_targets: set[str]) -> str:
    """Replace occurrences of known entity/concept names with [[wikilinks]]."""
    if not link_targets:
        return text
    for target in sorted(link_targets, key=len, reverse=True):
        pattern = re.compile(re.escape(target), re.IGNORECASE)
        wikilink = f"[[{target}]]"
        if wikilink not in text:
            text = pattern.sub(wikilink, text, count=1)
    return text


def import_grain_to_obsidian(
    knowledge_dir: str | Path,
    *,
    vault_path: str | Path | None = None,
) -> dict:
    """Import book chapter knowledge into an Obsidian vault.

    Writes to sources/ (chapter cards with wikilinks).
    If kg_graph_openclaw.json exists, also creates concept nodes + edges.
    """
    knowledge_dir = Path(knowledge_dir)
    vault = Path(vault_path or DEFAULT_OBSIDIAN_VAULT)

    result: dict = {
        "vault_path": str(vault),
        "knowledge_dir": str(knowledge_dir),
        "nodes_created": 0,
        "edges_created": 0,
        "chapters_created": 0,
        "errors": [],
    }

    agent_knowledge_path = knowledge_dir / "agent_knowledge.json"
    kg_graph_path = knowledge_dir / "kg_graph_openclaw.json"

    if not agent_knowledge_path.is_file():
        result["errors"].append("agent_knowledge.json not found")
        return result

    try:
        knowledge = json.loads(agent_knowledge_path.read_text(encoding="utf-8"))
    except Exception as e:
        result["errors"].append(f"Failed to read agent_knowledge.json: {e}")
        return result

    chapters = knowledge.get("chapters") if isinstance(knowledge, dict) else None
    if not isinstance(chapters, dict):
        chapters = {}

    ak_metadata = knowledge.get("metadata") if isinstance(knowledge, dict) else {}
    if not isinstance(ak_metadata, dict):
        ak_metadata = {}

    book_meta = _load_book_metadata(knowledge_dir)
    book_title = book_meta.get("title") or ak_metadata.get("source") or knowledge_dir.parent.name
    authors = book_meta.get("authors", [])
    if not isinstance(authors, list):
        authors = []
    publisher = ""
    publishers = book_meta.get("publishers") or book_meta.get("publisher")
    if isinstance(publishers, list) and publishers:
        publisher = publishers[0]
    elif isinstance(publishers, str):
        publisher = publishers

    now_iso = datetime.now(tz=timezone.utc).isoformat()

    # Collect known concept labels for wikilink injection
    graph: dict | None = None
    concept_labels: set[str] = set()
    if kg_graph_path.is_file():
        try:
            graph = json.loads(kg_graph_path.read_text(encoding="utf-8"))
            for node in (graph or {}).get("nodes", []):
                if isinstance(node, dict) and node.get("label"):
                    concept_labels.add(node["label"])
        except Exception as e:
            result["errors"].append(f"Failed to read kg_graph_openclaw.json: {e}")
            graph = None

    # Build wikilink targets: authors + concepts
    wikilink_targets: set[str] = set()
    for author in authors:
        if isinstance(author, str) and len(author) >= 2:
            wikilink_targets.add(author)
    wikilink_targets |= concept_labels

    # --- Phase 1: Chapter source cards → sources/ ---
    sources_dir = vault / "sources"
    try:
        sources_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        result["errors"].append(f"Cannot create sources dir: {e}")

    author_display = ", ".join(authors) if authors else "Unknown"
    book_link = f"[[{book_title}]]"
    author_links = [f"[[{a}]]" for a in authors if isinstance(a, str) and len(a) >= 2]

    for ch_key, ch_data in chapters.items():
        if not isinstance(ch_data, dict):
            continue
        ch_title = ch_data.get("title", ch_key)
        kps = ch_data.get("key_points", [])
        actionable = ch_data.get("actionable", "")

        if not isinstance(kps, list):
            kps = []
        if not kps and not actionable:
            continue

        filename = safe_filename(f"{book_title} - {ch_title}") + ".md"
        file_path = sources_dir / filename

        if file_path.is_file():
            continue

        fm_authors = json.dumps(author_links, ensure_ascii=False) if author_links else "[]"

        lines = [
            "---",
            f'title: "{ch_title}"',
            f'book: "{book_title}"',
            f'authors: {fm_authors}',
            f'chapter_key: "{ch_key}"',
            f'tags: ["book-chapter", "grain-knowledge"]',
            'source: "oreilly-ingest"',
            f'imported_at: "{now_iso}"',
            "---",
            "",
            f"# {ch_title}",
            "",
            f"> {book_link} — {author_display}",
            "",
        ]

        if kps:
            lines.append("## 核心要点")
            lines.append("")
            for kp in kps:
                if isinstance(kp, str) and kp.strip():
                    lines.append(f"- {_inject_wikilinks(kp, wikilink_targets)}")
            lines.append("")

        if actionable and isinstance(actionable, str) and not actionable.startswith("处理失败"):
            lines.append("## 行动建议")
            lines.append("")
            lines.append(_inject_wikilinks(actionable, wikilink_targets))
            lines.append("")

        if author_links:
            lines.append("## 关联")
            lines.append("")
            lines.append(f"- 作者：{', '.join(author_links)}")
            lines.append(f"- 书籍：{book_link}")
            if publisher:
                lines.append(f"- 出版：{publisher}")
            lines.append("")

        try:
            file_path.write_text("\n".join(lines), encoding="utf-8")
            result["chapters_created"] += 1
        except OSError as e:
            result["errors"].append(f"Failed to write chapter {filename}: {e}")

    # --- Phase 2: Graph concept nodes (optional) ---
    node_map: dict[str, str] = {}

    if graph and isinstance(graph, dict):
        for node in graph.get("nodes", []):
            if not isinstance(node, dict):
                continue
            node_id = node.get("id")
            if not node_id:
                continue
            label = node.get("label", node_id)
            ntype = node.get("type", "Core_Concept")

            folder = FOLDERS.get(ntype, "concepts")
            target_dir = vault / folder
            try:
                target_dir.mkdir(parents=True, exist_ok=True)
            except OSError as e:
                result["errors"].append(f"Cannot create dir {folder}: {e}")
                continue

            filename = safe_filename(label) + ".md"
            file_path = target_dir / filename

            node_lines = [
                "---",
                f'title: "{label}"',
                f'aliases: ["{node_id}"]',
                f'tags: ["{ntype}", "grain-kg"]',
                f'type: "{ntype}"',
                f'book: "{book_title}"',
                'source: "oreilly-ingest"',
                f'imported_at: "{now_iso}"',
                "---",
                "",
                f"# {label}",
                "",
                f"**类型**：{ntype}  ",
                f"**来源**：{book_link} — {author_display}",
                "",
            ]

            for _ch_key, ch_data in chapters.items():
                if not isinstance(ch_data, dict):
                    continue
                kps = ch_data.get("key_points")
                if not isinstance(kps, list) or not kps:
                    continue
                ch_title_inner = ch_data.get("title", "")
                matching_kps = [
                    kp for kp in kps
                    if isinstance(kp, str) and (label.lower() in kp.lower() or node_id.lower() in kp.lower())
                ]
                if matching_kps:
                    lines_inner = [f"## 相关要点（{ch_title_inner}）", ""]
                    for kp in matching_kps:
                        lines_inner.append(f"- {kp}")
                    lines_inner.append("")
                    node_lines.extend(lines_inner)

            node_lines.append("## 关系")
            node_lines.append("")

            existed = file_path.is_file()
            try:
                file_path.write_text("\n".join(node_lines), encoding="utf-8")
                node_map[node_id] = f"{folder}/{filename}"
                if not existed:
                    result["nodes_created"] += 1
            except OSError as e:
                result["errors"].append(f"Failed to write {folder}/{filename}: {e}")

        # --- Phase 3: Wikilink edges (idempotent) ---
        for edge in graph.get("edges", []):
            if not isinstance(edge, dict):
                continue
            src = edge.get("source")
            tgt = edge.get("target")
            rel = edge.get("relation", "related_to")

            if src not in node_map or tgt not in node_map:
                continue

            src_path = vault / node_map[src]
            tgt_stem = Path(node_map[tgt]).stem
            link_line = f"- [[{tgt_stem}]] {rel}"

            if not src_path.is_file():
                continue

            try:
                existing = src_path.read_text(encoding="utf-8")
                if link_line in existing:
                    continue
                with open(src_path, "a", encoding="utf-8") as f:
                    f.write(link_line + "\n")
                result["edges_created"] += 1
            except OSError as e:
                result["errors"].append(f"Failed to append edge to {node_map[src]}: {e}")

    LOGGER.info(
        "import_grain_to_obsidian done: chapters=%d nodes=%d edges=%d errors=%d vault=%s",
        result["chapters_created"],
        result["nodes_created"],
        result["edges_created"],
        len(result["errors"]),
        vault,
    )

    return result
