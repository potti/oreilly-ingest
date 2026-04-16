"""
将 agent_grain_processor 生成的 KG + knowledge 导入 Obsidian Vault。
直接写入指定 vault 目录的子文件夹，支持 wikilink 关系。
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

LOGGER = logging.getLogger(__name__)

DEFAULT_OBSIDIAN_VAULT = Path("/home/ubuntu/.openclaw/obsidian_vault")

FOLDERS = {
    "Core_Concept": "concepts",
    "Agent_Type": "concepts",
    "Component": "concepts",
    "Technique": "writing_styles",
    "Production": "events",
}


def safe_filename(name: str) -> str:
    return "".join(c if c.isalnum() or c in " _-()" else "_" for c in name).strip()[:100]


def import_grain_to_obsidian(
    knowledge_dir: str | Path,
    *,
    vault_path: str | Path | None = None,
) -> dict:
    """Import KG graph + chapter key_points into an Obsidian vault.

    Returns a result dict with counts and any errors (never calls sys.exit).
    """
    knowledge_dir = Path(knowledge_dir)
    vault = Path(vault_path or DEFAULT_OBSIDIAN_VAULT)

    result: dict = {
        "vault_path": str(vault),
        "knowledge_dir": str(knowledge_dir),
        "nodes_created": 0,
        "edges_created": 0,
        "errors": [],
    }

    agent_knowledge_path = knowledge_dir / "agent_knowledge.json"
    kg_graph_path = knowledge_dir / "kg_graph.json"

    if not agent_knowledge_path.is_file():
        result["errors"].append("agent_knowledge.json not found")
    if not kg_graph_path.is_file():
        result["errors"].append("kg_graph.json not found")
    if result["errors"]:
        return result

    try:
        knowledge = json.loads(agent_knowledge_path.read_text(encoding="utf-8"))
    except Exception as e:
        result["errors"].append(f"Failed to read agent_knowledge.json: {e}")
        return result

    try:
        graph = json.loads(kg_graph_path.read_text(encoding="utf-8"))
    except Exception as e:
        result["errors"].append(f"Failed to read kg_graph.json: {e}")
        return result

    chapters = knowledge.get("chapters") if isinstance(knowledge, dict) else None
    if not isinstance(chapters, dict):
        chapters = {}

    # --- Phase 1: Create node markdown files ---
    node_map: dict[str, str] = {}  # node_id -> "folder/filename.md"
    now_iso = datetime.now(tz=timezone.utc).isoformat()

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

        lines = [
            "---",
            f'title: "{label}"',
            f'aliases: ["{node_id}"]',
            f'tags: ["{ntype}", "grain-kg"]',
            f'type: "{ntype}"',
            'source: "agent_grain_processor"',
            f'imported_at: "{now_iso}"',
            "---",
            "",
            f"# {label}",
            "",
            f"**类型**：{ntype}",
            "",
        ]

        # Append key_points from matching chapters (by node label/id in chapter titles)
        for _ch_key, ch_data in chapters.items():
            if not isinstance(ch_data, dict):
                continue
            kps = ch_data.get("key_points")
            if not isinstance(kps, list) or not kps:
                continue
            ch_title = ch_data.get("title", "")
            matching_kps = [kp for kp in kps if isinstance(kp, str) and (label.lower() in kp.lower() or node_id.lower() in kp.lower())]
            if matching_kps:
                lines.append(f"## 相关要点（{ch_title}）")
                lines.append("")
                for kp in matching_kps:
                    lines.append(f"- {kp}")
                lines.append("")

        lines.append("## 关系")
        lines.append("")

        try:
            file_path.write_text("\n".join(lines), encoding="utf-8")
            node_map[node_id] = f"{folder}/{filename}"
            result["nodes_created"] += 1
        except OSError as e:
            result["errors"].append(f"Failed to write {folder}/{filename}: {e}")

    # --- Phase 2: Append wikilinks for edges (idempotent) ---
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
        "import_grain_to_obsidian done: nodes=%d edges=%d errors=%d vault=%s",
        result["nodes_created"],
        result["edges_created"],
        len(result["errors"]),
        vault,
    )

    return result
