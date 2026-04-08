---
name: oreilly-ingest-openclaw
description: Automates O'Reilly book discovery, download (default JSON), knowledge generation, and property-graph export using oreilly-ingest web APIs. Use when the user mentions OpenClaw, polling search results, downloading books (json/epub), generating knowledge, fetching agent_knowledge.json, building a Property Graph, or monitoring cookie/auth status.
---

# O'Reilly Ingest + OpenClaw Orchestration

This skill teaches an agent (OpenClaw) how to use the `oreilly-ingest` local web server APIs to:

- search books
- poll a rolling book list and pick new ones
- download JSON
- generate knowledge and wait for completion
- fetch `agent_knowledge.json`
- run the agent's *own* model to extract a high-quality Property Graph (simulate `generate_kg_edges`)
- save the graph to a configured path
- periodically check cookie/auth status and notify on failure

## Assumptions / Configuration

- Server base URL (default): `http://127.0.0.1:8000`
- Output directory for property graphs (required): `KG_OUTPUT_DIR` (absolute path recommended)
- Polling cadence:
  - search list poll: every 5–15 minutes (choose based on load)
  - progress poll: every 1–3 seconds for UI-like, or 3–10 seconds for batch
  - cookie/auth check: every 10 minutes

## Restarting the oreilly-ingest server (use scripts/)

Use this when the API becomes unresponsive, when cookies were updated, or after code changes.

### Docker (recommended)

From the repo root:

```bash
./scripts/start-docker.sh
```

### Verify it is up

- `GET /api/status` should return JSON (HTTP 200 or an auth-related status payload).

## APIs (oreilly-ingest server)

### Search (raw proxy)

- `GET /api/oreilly/search?...`
  - Forwards to O’Reilly `GET https://learning.oreilly.com/api/v2/search/`
  - Returns upstream JSON + status code
  - Supports `q=` alias → `query=`

### Book info & chapters

- `GET /api/book/{book_id}`
  - Fetches book metadata from O’Reilly via the configured HTTP client (requires valid session/cookies).
  - Path segment `{book_id}` is the ISBN / archive id (same id you pass to `POST /api/download`).
  - Returns JSON from `book.fetch(book_id)` on success; `400` with `{ "error": "..." }` on failure.

  **Example**

  `GET /api/book/9781098166298`

- `GET /api/book/{book_id}/chapters`
  - Returns a normalized chapter list for the chapter-selection UI.
  - Response shape: `{ "chapters": [ { "index", "title", "pages", "minutes" } ], "total": N }` (`pages` / `minutes` may be null depending on upstream).
  - `400` with `{ "error": "..." }` if the chapters plugin cannot load the list.

  **Example**

  `GET /api/book/9781098166298/chapters`

### Downloads list (dedupe)

- `GET /api/downloads?page=1&page_size=10&output_dir=...`
  - Use to decide whether a book was downloaded previously (by folder name)

### Download book

- `POST /api/download`
  - Body: `{ "book_id": "<isbn/archive_id>", "format": "json", "output_dir": "...?" }`
  - Returns `{ "status": "started", "book_id": "..." }` or `409` if already running

### Generate knowledge

- `POST /api/generate_knowledge`
  - Body: `{ "book_name": "<download folder name or title>", "output_dir": "...?", "force_full": false }`

### Knowledge generation stats

- `POST /api/knowledge-stats`
  - Summarizes `Knowledge/agent_knowledge.json` for a **downloaded** book folder (no full chapter payload).
  - Body: `{ "book_name": "<folder name or title>", "output_dir": "...?" }` — **`book_name` is required** (aliases: `title`, `name`). This is the slug/folder name under the output directory, not the same field as `book_id` in `/api/download`.
  - Returns fields such as: `exists`, `path`, `error_count`, `chapter_count`, `failed_chapter_keys`, `book_dir`, `book_name` (see `knowledge_stats_for_book` in `core/agent_grain_processor.py`).
  - `404` if the book directory cannot be resolved under the output root.

  **Example**

  ```bash
  curl -s -X POST "http://127.0.0.1:8000/api/knowledge-stats" \
    -H "Content-Type: application/json" \
    -d '{"book_name": "ai-engineering"}'
  ```

### Progress polling

- `GET /api/progress`
  - Used for both download and knowledge generation; check `status` and `percentage`
  - Terminal statuses include: `completed`, `error`, `cancelled`, plus `knowledge_completed`, `knowledge_error`

### Fetch agent knowledge JSON

- `GET /api/agent_knowledge?book_name=...&output_dir=...`
  - Returns the JSON body of `Knowledge/agent_knowledge.json`

### Knowledge-graph LLM prompt (same as `generate_kg_edges`)

- `GET /api/kg/prompt?book_name=...&output_dir=...`
  - Reads `Knowledge/agent_knowledge.json` and returns the full prompt string used by `generate_kg_edges` (field `prompt`), plus `json_preview_max_chars` (embedded JSON is truncated to that length).

### Save knowledge graph to file

- `POST /api/kg/save`
  - Writes a Property Graph JSON object under `<book_dir>/Knowledge/` for a **downloaded** book.
  - Body:
    - `book_name` (required; aliases `title`, `name`) — folder / slug under the output directory.
    - `graph` (required) — JSON object with your `metadata` / `nodes` / `edges` (same schema as Workflow 3).
    - `output_dir` (optional) — override output root; must pass server validation when set.
    - `filename` (optional, default `kg_graph_openclaw.json`) — basename only; `.json` appended if missing; no path separators.
    - `overwrite` (optional, default `true`) — if `false` and the file exists, returns `409`.
  - Success: `{ "success": true, "path", "book_dir", "book_name", "filename" }`.
  - Errors: `400` for missing fields / invalid filename / path traversal; `404` if book folder not found.

  **Example**

  ```bash
  curl -s -X POST "http://127.0.0.1:8000/api/kg/save" \
    -H "Content-Type: application/json" \
    -d '{"book_name":"ai-engineering","graph":{"metadata":{"source":"local","generated_at":"2026-04-08","total_nodes":0,"total_edges":0},"nodes":[],"edges":[]}}'
  ```

### Cookie/auth status

- `GET /api/status`
  - Use to detect expired/invalid cookies and trigger notification

## Workflow 1: Search a book list (per requirements)

1. Call `GET /api/oreilly/search` with your required filters.
   - Prefer: `include_facets=false`
   - Prefer: `limit=200` (or the maximum your use case allows)
2. Parse results and derive a stable book identifier.
   - Prefer `archive_id` (ISBN-like) when present.
   - Fallback to `ourn` (`urn:orm:book:<id>`) → extract `<id>`.
3. Keep only `formats=book` results if you want books.

**Example query**

`/api/oreilly/search?query=go&formats=book&include_facets=false&limit=50`

## Workflow 2: Poll the list; if not downloaded, run the pipeline

Maintain a small state store (in memory or persisted) with:
- `seen_book_ids` (optional)
- `downloaded_book_names` (from `/api/downloads`)

### 2.1 Dedupe: detect “not downloaded”

1. Call `GET /api/downloads` (page through if needed)
2. Decide whether the candidate book is already present
   - If you store by `book_id`, match against folder naming conventions you use
   - If you store by `title`, match slugified folder names used by the app

### 2.2 Download JSON

1. `POST /api/download` with `{ book_id, format: "json" }`
2. Poll `GET /api/progress` until:
   - `status == "completed"` → download done
   - or `status in ("error","cancelled")` → abort + notify

### 2.3 Generate knowledge and wait

1. Determine `book_name` (downloaded folder name). Use the same `book_name` you see in `/api/downloads`.
2. `POST /api/generate_knowledge` with `{ book_name }`
3. Poll `GET /api/progress` until:
   - `status == "knowledge_completed"` → knowledge done
   - or `status == "knowledge_error"` → abort + notify

### 2.4 Fetch agent_knowledge.json

1. `GET /api/agent_knowledge?book_name=...`
2. Validate the returned JSON is an object with `chapters` (dict-like).

## Workflow 3: Build Property Graph (simulate generate_kg_edges) and save

### 3.1 Output schema (recommended)

Write a single JSON file:

```json
{
  "metadata": { "source": "...", "generated_at": "YYYY-MM-DD", "total_nodes": 0, "total_edges": 0 },
  "nodes": [ { "id": "x", "label": "X", "type": "Core_Concept" } ],
  "edges": [ { "source": "a", "relation": "uses", "target": "b", "source_chapter": "chapter_5" } ]
}
```

Constraints (match repo expectations):
- node types: `Core_Concept | Agent_Type | Component | Technique | Production`
- relations: `uses | requires | enables | improves | coordinates | feeds_into | consists_of | superior_to | combines | detects | measures | extends | critical_for | stores_in`
- include `source_chapter` on every edge

### 3.2 Prompting / Extraction guidance (agent’s own model)

Use the fetched `agent_knowledge.json` (or a truncated preview) as input.
- Hard-require “output JSON only”
- Post-validate:
  - enforce max nodes/edges
  - dedupe node IDs
  - drop edges referencing missing nodes
  - filter relations/types to allowed sets

### 3.3 Save location and naming

Compute output path:
- Base dir: `${KG_OUTPUT_DIR}`
- Subdir: `<book_name>/Knowledge/`
- File: `kg_graph_openclaw.json`

Create directories if missing and write JSON with UTF-8.

Alternatively, call `POST /api/kg/save` with the same `graph` object (see **Save knowledge graph to file** above).

## Workflow 4: Scheduled cookie/auth health check

Every 10 minutes:
1. Call `GET /api/status`
2. If not authenticated / status indicates failure:
   - notify user/operator with the returned payload
   - stop the pipeline (do not start downloads)

## Notifications (recommended)

When notifying, include:
- book identifier (archive_id / ourn)
- phase (`download`, `knowledge`, `graph`, `cookie-check`)
- error message and last `/api/progress` snapshot (if applicable)

## Examples

### Example: end-to-end for one new book

1. `/api/oreilly/search?query=llm&formats=book&include_facets=false&limit=50`
2. Pick `archive_id`
3. `POST /api/download` → poll `/api/progress` → `completed`
4. `POST /api/generate_knowledge` → poll `/api/progress` → `knowledge_completed`
5. `GET /api/agent_knowledge?book_name=...`
6. Run extraction with agent model → write `${KG_OUTPUT_DIR}/<book_name>/Knowledge/kg_graph_openclaw.json`

