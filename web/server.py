"""Web server for O'Reilly Ingest."""

import json
import logging
import logging.handlers
import os
import re
import threading
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from core import Kernel, create_default_kernel
from plugins import ChunkConfig
from plugins.downloader import DownloadProgress
import config


def _setup_logging() -> logging.Logger:
    logs_dir = Path(os.getenv("OREILLY_INGEST_LOG_DIR", str(config.BASE_DIR / "logs"))).resolve()
    logs_dir.mkdir(parents=True, exist_ok=True)

    logger = logging.getLogger("oreilly_ingest")
    if logger.handlers:
        return logger

    level_name = os.getenv("OREILLY_INGEST_LOG_LEVEL", "INFO").upper().strip()
    level = getattr(logging, level_name, logging.INFO)
    logger.setLevel(level)

    fmt = logging.Formatter(
        fmt="%(asctime)s %(levelname)s %(name)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )

    file_handler = logging.handlers.RotatingFileHandler(
        filename=str(logs_dir / "server.log"),
        maxBytes=int(os.getenv("OREILLY_INGEST_LOG_MAX_BYTES", str(10 * 1024 * 1024))),
        backupCount=int(os.getenv("OREILLY_INGEST_LOG_BACKUPS", "5")),
        encoding="utf-8",
    )
    file_handler.setFormatter(fmt)
    logger.addHandler(file_handler)

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(fmt)
    logger.addHandler(stream_handler)

    logger.propagate = False
    return logger


LOGGER = _setup_logging()


class DownloaderHandler(SimpleHTTPRequestHandler):
    """HTTP request handler for the downloader web interface."""

    kernel: Kernel = None
    download_progress: dict = {}
    _progress_lock = threading.Lock()
    # Serializes "may I start?" + Thread() + start() so two concurrent POSTs cannot
    # both pass the in-progress check.
    _download_start_lock = threading.Lock()
    _download_thread: threading.Thread | None = None
    _knowledge_thread: threading.Thread | None = None
    _cancel_requested: bool = False

    _TERMINAL_STATUSES = frozenset(("completed", "error", "cancelled"))

    @classmethod
    def _set_progress(cls, data: dict):
        """Thread-safe progress replacement."""
        with cls._progress_lock:
            cls.download_progress = data

    @classmethod
    def _update_progress(cls, **kwargs):
        """Thread-safe progress update."""
        with cls._progress_lock:
            cls.download_progress.update(kwargs)

    def __init__(self, *args, **kwargs):
        self.static_dir = Path(__file__).parent / "static"
        self._last_status_code: int | None = None
        self._request_start_ts: float | None = None
        self._last_json_response: dict | None = None
        self._last_json_status: int | None = None
        super().__init__(*args, directory=str(self.static_dir), **kwargs)

    def send_response(self, code, message=None):
        self._last_status_code = int(code)
        super().send_response(code, message)

    def do_GET(self):
        self._request_start_ts = time.time()
        parsed = urlparse(self.path)
        path = parsed.path

        try:
            if path == "/api/status":
                self._handle_status()
            elif path == "/api/search":
                params = parse_qs(parsed.query)
                query = params.get("q", params.get("query", [""]))[0]
                self._handle_search(query)
            elif path == "/api/oreilly/search":
                params = parse_qs(parsed.query)
                self._handle_oreilly_search_proxy(params)
            elif match := re.match(r"/api/book/([^/]+)/chapters$", path):
                self._handle_chapters_list(match.group(1))
            elif match := re.match(r"/api/book/([^/]+)$", path):
                self._handle_book_info(match.group(1))
            elif path == "/api/progress":
                self._handle_progress()
            elif path == "/api/settings":
                self._handle_get_settings()
            elif path == "/api/cookies":
                self._handle_get_cookies()
            elif path == "/api/formats":
                self._handle_formats()
            elif path == "/api/downloads":
                params = parse_qs(parsed.query)
                self._handle_downloads_list(params)
            elif path == "/api/downloads/by-id":
                params = parse_qs(parsed.query)
                self._handle_download_by_id(params)
            elif path == "/api/downloads/files":
                params = parse_qs(parsed.query)
                self._handle_downloads_files(params)
            elif path == "/api/agent_knowledge":
                params = parse_qs(parsed.query)
                self._handle_agent_knowledge_get(params)
            elif path == "/api/kg/prompt":
                params = parse_qs(parsed.query)
                self._handle_kg_prompt_get(params)
            else:
                super().do_GET()
        except Exception:
            # Ensure errors are visible in logs and the client gets JSON.
            LOGGER.exception("unhandled_exception method=%s path=%s", self.command, path)
            self._send_json({"error": "Internal server error"}, 500)

        if path.startswith("/api/"):
            self._log_api_request()

    def do_POST(self):
        self._request_start_ts = time.time()
        post_path = urlparse(self.path).path
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8")
        data = json.loads(body) if body else {}

        try:
            if post_path == "/api/download":
                self._handle_download(data)
            elif post_path == "/api/generate_knowledge":
                self._handle_generate_knowledge(data)
            elif post_path == "/api/knowledge-stats":
                self._handle_knowledge_stats(data)
            elif post_path == "/api/kg/save":
                self._handle_kg_save(data)
            elif post_path in ("/api/cookies", "/api/settings/cookies"):
                self._handle_cookies(data)
            elif post_path == "/api/cancel":
                self._handle_cancel()
            elif post_path == "/api/reveal":
                self._handle_reveal(data)
            elif post_path == "/api/settings/output-dir":
                self._handle_set_output_dir(data)
            else:
                self._send_json({"error": "Not found"}, 404)
        except Exception:
            LOGGER.exception("unhandled_exception method=%s path=%s", self.command, post_path)
            self._send_json({"error": "Internal server error"}, 500)

        if post_path.startswith("/api/"):
            self._log_api_request()
            if post_path == "/api/generate_knowledge":
                self._log_generate_knowledge_response()

    def _log_api_request(self):
        try:
            elapsed_ms = 0
            if self._request_start_ts is not None:
                elapsed_ms = int((time.time() - self._request_start_ts) * 1000)
            parsed = urlparse(self.path)
            client_ip = getattr(self, "client_address", ("", 0))[0]
            ua = self.headers.get("User-Agent", "")
            LOGGER.info(
                "api_request method=%s path=%s query=%s status=%s elapsed_ms=%s ip=%s ua=%s",
                self.command,
                parsed.path,
                parsed.query,
                self._last_status_code,
                elapsed_ms,
                client_ip,
                ua,
            )
        except Exception:
            pass

    def _handle_status(self):
        auth = self.kernel["auth"]
        status = auth.get_status()
        self._send_json(status)

    def _handle_search(self, query: str):
        if not query:
            self._send_json({"results": []})
            return

        book = self.kernel["book"]
        results = book.search(query)
        self._send_json({"results": results})

    def _handle_oreilly_search_proxy(self, params: dict):
        """Proxy O'Reilly /api/v2/search/ and return raw JSON.

        This is useful when callers want full search response (facets, next/previous, etc.)
        rather than the simplified `/api/search` results.
        """
        # Convenience alias: allow q=... as query=...
        if "q" in params and "query" not in params:
            params["query"] = params["q"]

        # requests supports dict[str, list[str]] for multi-value query params.
        http = self.kernel.http
        try:
            resp = http.get(f"{config.API_V2}/search/", params=params, timeout=config.REQUEST_TIMEOUT)
        except Exception as e:
            self._send_json({"error": str(e)}, 502)
            return

        status = getattr(resp, "status_code", 502) or 502
        try:
            data = resp.json()
            if isinstance(data, dict):
                self._send_json(data, status)
            else:
                self._send_json({"error": "Upstream returned non-object JSON", "data": data}, status)
        except Exception:
            # Upstream sometimes returns HTML on auth failure; surface as text.
            text = ""
            try:
                text = (resp.text or "")[:4000]
            except Exception:
                text = ""
            self._send_json(
                {
                    "error": "Upstream response is not JSON",
                    "status_code": status,
                    "body_preview": text,
                },
                status,
            )

    def _handle_book_info(self, book_id: str):
        book = self.kernel["book"]
        try:
            info = book.fetch(book_id)
            self._send_json(info)
        except Exception as e:
            self._send_json({"error": str(e)}, 400)

    def _handle_chapters_list(self, book_id: str):
        """Return list of chapters for chapter selection UI."""
        chapters_plugin = self.kernel["chapters"]
        try:
            chapters = chapters_plugin.fetch_list(book_id)
            result = {
                "chapters": [
                    {
                        "index": i,
                        "title": ch.get("title", f"Chapter {i + 1}"),
                        "pages": ch.get("virtual_pages"),
                        "minutes": ch.get("minutes_required"),
                    }
                    for i, ch in enumerate(chapters)
                ],
                "total": len(chapters),
            }
            self._send_json(result)
        except Exception as e:
            self._send_json({"error": str(e)}, 400)

    def _handle_progress(self):
        # Never call _send_json while holding _progress_lock: a slow client would block
        # the whole server and stall background progress_callback -> _set_progress.
        with self._progress_lock:
            payload = dict(self.download_progress)
        self._send_json(payload)

    def _handle_get_settings(self):
        """Return current settings."""
        self._send_json(
            {
                "output_dir": str(config.OUTPUT_DIR),
            }
        )

    def _handle_formats(self):
        """Return available output formats for discovery.

        This endpoint allows any client (web, CLI, etc.) to discover
        supported formats, aliases, and which formats support chapter selection.
        """
        from plugins.downloader import DownloaderPlugin
        self._send_json(DownloaderPlugin.get_formats_info())

    def _handle_downloads_list(self, params: dict):
        """List completed book folders under output dir, newest first, paginated.

        Query: page (1-based), page_size (default 10, max 50), output_dir (optional).
        """
        output_plugin = self.kernel["output"]

        try:
            page = int(params.get("page", ["1"])[0] or "1")
        except ValueError:
            page = 1
        try:
            page_size = int(params.get("page_size", ["10"])[0] or "10")
        except ValueError:
            page_size = 10

        page = max(1, page)
        page_size = min(50, max(1, page_size))

        path_param = (params.get("output_dir") or [""])[0].strip()
        if path_param:
            ok, msg, root = output_plugin.validate_dir(path_param)
            if not ok or root is None:
                self._send_json({"error": msg or "Invalid output directory"}, 400)
                return
        else:
            root = output_plugin.get_default_dir()

        root = root.resolve()
        entries: list[tuple[Path, float, str]] = []
        if root.is_dir():
            for child in root.iterdir():
                if not child.is_dir() or child.name.startswith("."):
                    continue
                book_id = ""
                meta = child / ".book_id"
                if meta.is_file():
                    try:
                        book_id = meta.read_text(encoding="utf-8").strip()
                    except OSError:
                        pass
                if not book_id and not (child / "OEBPS").is_dir():
                    continue
                try:
                    mtime = child.stat().st_mtime
                except OSError:
                    continue
                entries.append((child, mtime, book_id))

        entries.sort(key=lambda x: -x[1])
        total = len(entries)
        start = (page - 1) * page_size
        slice_ = entries[start : start + page_size]

        from core.agent_grain_processor import knowledge_stats_for_book

        items = []
        for book_path, mtime, book_id in slice_:
            stats = knowledge_stats_for_book(book_path)
            items.append(
                {
                    "folder_name": book_path.name,
                    "book_id": book_id,
                    "path": str(book_path.resolve()),
                    "modified_at": datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat(),
                    "knowledge_stats": stats,
                }
            )

        self._send_json(
            {
                "items": items,
                "page": page,
                "page_size": page_size,
                "total": total,
                "output_dir": str(root),
            }
        )

    def _handle_download_by_id(self, params: dict):
        """Resolve a downloaded book directory by `book_id` via `.book_id` marker.

        Query: book_id (required), output_dir (optional)
        """
        book_id = ((params.get("book_id") or params.get("id") or [""])[0] or "").strip()
        if not book_id:
            self._send_json({"error": "book_id required"}, 400)
            return

        output_plugin = self.kernel["output"]
        path_param = (params.get("output_dir") or [""])[0].strip()
        if path_param:
            ok, msg, root = output_plugin.validate_dir(path_param)
            if not ok or root is None:
                self._send_json({"error": msg or "Invalid output directory"}, 400)
                return
        else:
            root = output_plugin.get_default_dir()

        root = root.resolve()
        if not root.is_dir():
            self._send_json({"exists": False, "book_id": book_id, "output_dir": str(root)}, 200)
            return

        from core.agent_grain_processor import knowledge_stats_for_book

        matches: list[dict] = []
        for child in root.iterdir():
            if not child.is_dir() or child.name.startswith("."):
                continue
            meta = child / ".book_id"
            if not meta.is_file():
                continue
            try:
                found_id = meta.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if found_id != book_id:
                continue
            try:
                mtime = child.stat().st_mtime
            except OSError:
                mtime = 0
            
            stats = knowledge_stats_for_book(child)
            matches.append(
                {
                    "folder_name": child.name,
                    "book_id": found_id,
                    "path": str(child.resolve()),
                    "modified_at": (
                        datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat() if mtime else None
                    ),
                    "knowledge_stats": stats,
                }
            )

        if not matches:
            self._send_json({"exists": False, "book_id": book_id, "output_dir": str(root)}, 200)
            return

        # Most recent first
        matches.sort(key=lambda x: x.get("modified_at") or "", reverse=True)
        self._send_json(
            {
                "exists": True,
                "book_id": book_id,
                "output_dir": str(root),
                "matches": matches,
                "book_dir": matches[0]["path"],
                "folder_name": matches[0]["folder_name"],
            }
        )

    def _handle_downloads_files(self, params: dict):
        """Return paths to generated pdf and epub files for a downloaded book.

        Query: book_name (or title / name), output_dir (optional).
        """
        book_name = (
            (params.get("book_name") or params.get("title") or params.get("name") or [""])[0] or ""
        ).strip()
        if not book_name:
            self._send_json({"error": "book_name required (query: book_name=...)"}, 400)
            return

        output_plugin = self.kernel["output"]
        out_dir_str = ((params.get("output_dir") or [""])[0] or "").strip()
        if out_dir_str:
            ok, msg, out_dir = output_plugin.validate_dir(out_dir_str)
            if not ok or out_dir is None:
                self._send_json({"error": msg}, 400)
                return
        else:
            out_dir = output_plugin.get_default_dir()

        book_dir = self._resolve_book_dir_by_name(book_name, out_dir)
        if book_dir is None:
            self._send_json({"error": f"Book directory not found under output: {book_name}"}, 404)
            return

        pdf_files = [str(p.resolve()) for p in book_dir.glob("*.pdf")]
        epub_files = [str(p.resolve()) for p in book_dir.glob("*.epub")]

        self._send_json(
            {
                "book_dir": str(book_dir.resolve()),
                "book_name": book_name,
                "pdf_files": pdf_files,
                "epub_files": epub_files,
            }
        )

    def _handle_set_output_dir(self, data: dict):
        """Handle output directory selection - browse or direct path."""
        system_plugin = self.kernel["system"]
        output_plugin = self.kernel["output"]

        if data.get("browse"):
            # Open native folder picker dialog
            initial_dir = config.OUTPUT_DIR
            selected = system_plugin.show_folder_picker(initial_dir)
            if selected:
                self._send_json({"success": True, "path": str(selected)})
            else:
                self._send_json({"cancelled": True})
            return

        path_str = data.get("path", "").strip()

        if not path_str:
            self._send_json({"error": "path required"}, 400)
            return

        success, message, path = output_plugin.validate_dir(path_str)
        if not success:
            self._send_json({"error": message}, 400)
            return

        self._send_json({"success": True, "path": str(path)})

    @staticmethod
    def _normalize_cookie_body(data: dict) -> dict | None:
        """Accept flat {name: value} or wrapped {"cookies": {name: value}}."""
        if not isinstance(data, dict) or not data:
            return None
        if set(data.keys()) == {"cookies"}:
            inner = data["cookies"]
            if isinstance(inner, dict) and inner:
                return inner
            return None
        return data

    def _handle_get_cookies(self):
        """Return whether cookies are configured (names only, never values)."""
        cookie_path = str(config.COOKIES_FILE.resolve())
        if not config.COOKIES_FILE.exists():
            self._send_json(
                {
                    "configured": False,
                    "path": cookie_path,
                    "cookie_names": [],
                    "count": 0,
                }
            )
            return
        try:
            raw = json.loads(config.COOKIES_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            self._send_json({"error": str(e), "configured": False}, 400)
            return
        if not isinstance(raw, dict):
            self._send_json(
                {"error": "Cookie file must be a JSON object", "configured": False},
                400,
            )
            return
        names = sorted(raw.keys())
        self._send_json(
            {
                "configured": bool(names),
                "path": cookie_path,
                "cookie_names": names,
                "count": len(names),
            }
        )

    def _handle_cookies(self, data: dict):
        """Persist session cookies and reload the HTTP client."""
        cookies = self._normalize_cookie_body(data)
        if cookies is None:
            self._send_json({"error": "Invalid cookie data"}, 400)
            return

        try:
            config.COOKIES_FILE.parent.mkdir(parents=True, exist_ok=True)
            config.COOKIES_FILE.write_text(
                json.dumps(cookies, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            self.kernel.http.reload_cookies()
            self._send_json({"success": True, "count": len(cookies)})
        except Exception as e:
            self._send_json({"error": str(e)}, 500)

    def _handle_cancel(self):
        """Request cancellation of the current download."""
        with self._progress_lock:
            status = self.download_progress.get("status")
            if status and status not in DownloaderHandler._TERMINAL_STATUSES:
                DownloaderHandler._cancel_requested = True
                payload = ({"success": True, "message": "Cancel requested"}, 200)
            else:
                payload = ({"success": False, "message": "No active download"}, 200)
        self._send_json(payload[0], payload[1])

    def _handle_reveal(self, data: dict):
        """Open file manager and select the specified file."""
        path_str = data.get("path", "")
        if not path_str:
            self._send_json({"error": "path required"}, 400)
            return

        path = Path(path_str).resolve()

        if not path.exists():
            self._send_json({"error": "Path does not exist"}, 404)
            return

        system_plugin = self.kernel["system"]
        success = system_plugin.reveal_in_file_manager(path)

        if success:
            self._send_json({"success": True})
        else:
            self._send_json({"error": "Failed to reveal file"}, 500)

    def _handle_download(self, data: dict):
        """Start a book download."""
        book_id = data.get("book_id")
        output_format = data.get("format", "epub")
        LOGGER.debug(
            "download_request book_id=%s format=%s raw_format=%s",
            book_id,
            output_format,
            data.get("format"),
        )
        selected_chapters = data.get("chapters")
        output_dir_str = data.get("output_dir")
        chunking_opts = data.get("chunking", {})
        skip_images = data.get("skip_images", False)

        if not book_id:
            self._send_json({"error": "book_id required"}, 400)
            return

        # Parse chunking config
        chunk_config = None
        if chunking_opts:
            chunk_size = chunking_opts.get("chunk_size", 4000)
            overlap = chunking_opts.get("overlap", 200)
            chunk_config = ChunkConfig(
                chunk_size=chunk_size,
                overlap=overlap,
                respect_boundaries=True,
            )

        # Validate output directory
        output_plugin = self.kernel["output"]
        if output_dir_str:
            success, message, output_dir = output_plugin.validate_dir(output_dir_str)
            if not success:
                self._send_json({"error": message}, 400)
                return
        else:
            output_dir = output_plugin.get_default_dir()

        # Parse formats using plugin (single source of truth)
        from plugins.downloader import DownloaderPlugin
        formats = DownloaderPlugin.parse_formats(output_format)
        LOGGER.debug("download_request parsed_formats=%s", formats)

        start_response: tuple[dict, int] | None = None
        with DownloaderHandler._download_start_lock:
            with self._progress_lock:
                thr = DownloaderHandler._download_thread
                status = self.download_progress.get("status")
                active = bool(status and status not in DownloaderHandler._TERMINAL_STATUSES)

                if thr is not None and thr.is_alive():
                    start_response = ({"error": "Download already in progress"}, 409)
                elif active:
                    # Progress still says "running" but worker is gone — e.g. crashed thread.
                    self.download_progress = {}
                    DownloaderHandler._download_thread = None

            if start_response is None:
                worker = threading.Thread(
                    target=self._download_book_async,
                    args=(
                        book_id,
                        output_dir,
                        formats,
                        selected_chapters,
                        skip_images,
                        chunk_config,
                    ),
                    daemon=True,
                )
                with self._progress_lock:
                    DownloaderHandler._download_thread = worker
                worker.start()

        if start_response is not None:
            self._send_json(start_response[0], start_response[1])
            return

        self._send_json({"status": "started", "book_id": book_id})

    def _resolve_book_dir_by_name(self, book_name: str, output_dir: Path) -> Path | None:
        """Resolve a downloaded book directory by folder name or human title.

        - Prefer exact folder match under output_dir.
        - Fallback to slugified title match.
        """
        from utils import slugify

        name = (book_name or "").strip()
        if not name:
            return None
        out = output_dir.resolve()
        if not out.is_dir():
            return None

        # 1) Exact directory name
        direct = out / name
        if direct.is_dir():
            return direct

        # 2) Slugified match against directory names
        target_slug = slugify(name)
        if not target_slug:
            return None
        for child in out.iterdir():
            if not child.is_dir():
                continue
            # Exact slug match (most common) or slug prefix match (when conflict resolution appends -<book_id>)
            if child.name == target_slug or child.name.startswith(target_slug + "-"):
                return child
        return None

    def _handle_generate_knowledge(self, data: dict):
        """Generate knowledge JSON under the book folder.

        Body: {"book_name": "<folder_name or title>", "output_dir": "...?", "force_full": false}
        """
        book_name = (data.get("book_name") or data.get("title") or data.get("name") or "").strip()
        force_full = bool(data.get("force_full"))
        if not book_name:
            self._send_json({"error": "book_name required"}, 400)
            return

        output_plugin = self.kernel["output"]
        out_dir_str = (data.get("output_dir") or "").strip()
        if out_dir_str:
            ok, msg, out_dir = output_plugin.validate_dir(out_dir_str)
            if not ok or out_dir is None:
                self._send_json({"error": msg}, 400)
                return
        else:
            out_dir = output_plugin.get_default_dir()

        book_dir = self._resolve_book_dir_by_name(book_name, out_dir)
        if book_dir is None:
            self._send_json({"error": f"Book directory not found under output: {book_name}"}, 404)
            return

        start_response: tuple[dict, int] | None = None
        with DownloaderHandler._download_start_lock:
            with self._progress_lock:
                dthr = DownloaderHandler._download_thread
                kth = DownloaderHandler._knowledge_thread
                if (dthr is not None and dthr.is_alive()) or (kth is not None and kth.is_alive()):
                    start_response = ({"error": "Another task is already running"}, 409)

            if start_response is None:
                worker = threading.Thread(
                    target=self._generate_knowledge_async,
                    args=(book_dir, force_full),
                    daemon=True,
                )
                with self._progress_lock:
                    DownloaderHandler._knowledge_thread = worker
                    self.download_progress = {
                        "status": "generating_knowledge",
                        "percentage": 0,
                        "message": f"Starting knowledge generation: {book_dir.name}",
                        "book_dir": str(book_dir),
                        "book_name": book_name,
                    }
                worker.start()

        if start_response is not None:
            self._send_json(start_response[0], start_response[1])
            return

        self._send_json({"status": "started", "book_dir": str(book_dir), "book_name": book_name})

    def _handle_knowledge_stats(self, data: dict):
        """Return failure counts from Knowledge/agent_knowledge.json for a downloaded book.

        Body: {"book_name": "<folder_name or title>", "output_dir": "...?"}
        """
        book_name = (data.get("book_name") or data.get("title") or data.get("name") or "").strip()
        if not book_name:
            self._send_json({"error": "book_name required"}, 400)
            return

        output_plugin = self.kernel["output"]
        out_dir_str = (data.get("output_dir") or "").strip()
        if out_dir_str:
            ok, msg, out_dir = output_plugin.validate_dir(out_dir_str)
            if not ok or out_dir is None:
                self._send_json({"error": msg}, 400)
                return
        else:
            out_dir = output_plugin.get_default_dir()

        book_dir = self._resolve_book_dir_by_name(book_name, out_dir)
        if book_dir is None:
            self._send_json({"error": f"Book directory not found under output: {book_name}"}, 404)
            return

        from core.agent_grain_processor import knowledge_stats_for_book

        stats = knowledge_stats_for_book(book_dir)
        stats["book_dir"] = str(book_dir.resolve())
        stats["book_name"] = book_name
        self._send_json(stats)

    def _handle_agent_knowledge_get(self, params: dict):
        """Return full JSON body of Knowledge/agent_knowledge.json for a downloaded book.

        Query: book_name (or title / name), output_dir (optional).
        """
        book_name = (
            (params.get("book_name") or params.get("title") or params.get("name") or [""])[0] or ""
        ).strip()
        if not book_name:
            self._send_json({"error": "book_name required (query: book_name=...)"}, 400)
            return

        output_plugin = self.kernel["output"]
        out_dir_str = ((params.get("output_dir") or [""])[0] or "").strip()
        if out_dir_str:
            ok, msg, out_dir = output_plugin.validate_dir(out_dir_str)
            if not ok or out_dir is None:
                self._send_json({"error": msg}, 400)
                return
        else:
            out_dir = output_plugin.get_default_dir()

        book_dir = self._resolve_book_dir_by_name(book_name, out_dir)
        if book_dir is None:
            self._send_json({"error": f"Book directory not found under output: {book_name}"}, 404)
            return

        agent_path = book_dir / "Knowledge" / "agent_knowledge.json"
        if not agent_path.is_file():
            self._send_json(
                {
                    "error": "agent_knowledge.json not found",
                    "path": str(agent_path.resolve()),
                    "book_dir": str(book_dir.resolve()),
                },
                404,
            )
            return

        try:
            raw_text = agent_path.read_text(encoding="utf-8")
            data = json.loads(raw_text)
        except json.JSONDecodeError as e:
            self._send_json(
                {
                    "error": f"Invalid JSON in agent_knowledge.json: {e}",
                    "path": str(agent_path.resolve()),
                },
                500,
            )
            return
        except OSError as e:
            self._send_json({"error": str(e), "path": str(agent_path.resolve())}, 500)
            return

        if not isinstance(data, dict):
            self._send_json(
                {"error": "Root JSON value must be an object", "path": str(agent_path.resolve())},
                500,
            )
            return

        self._send_json(data)

    def _handle_kg_prompt_get(self, params: dict):
        """Return the full ``generate_kg_edges`` LLM prompt built from ``agent_knowledge.json``.

        Query: book_name (or title / name), output_dir (optional).
        Same JSON truncation rules as ``build_kg_edges_prompt`` (see json_preview_max_chars).
        """
        book_name = (
            (params.get("book_name") or params.get("title") or params.get("name") or [""])[0] or ""
        ).strip()
        if not book_name:
            self._send_json({"error": "book_name required (query: book_name=...)"}, 400)
            return

        output_plugin = self.kernel["output"]
        out_dir_str = ((params.get("output_dir") or [""])[0] or "").strip()
        if out_dir_str:
            ok, msg, out_dir = output_plugin.validate_dir(out_dir_str)
            if not ok or out_dir is None:
                self._send_json({"error": msg}, 400)
                return
        else:
            out_dir = output_plugin.get_default_dir()

        book_dir = self._resolve_book_dir_by_name(book_name, out_dir)
        if book_dir is None:
            self._send_json({"error": f"Book directory not found under output: {book_name}"}, 404)
            return

        agent_path = book_dir / "Knowledge" / "agent_knowledge.json"
        if not agent_path.is_file():
            self._send_json(
                {
                    "error": "agent_knowledge.json not found",
                    "path": str(agent_path.resolve()),
                    "book_dir": str(book_dir.resolve()),
                },
                404,
            )
            return

        try:
            full_json = json.loads(agent_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            self._send_json({"error": str(e), "path": str(agent_path.resolve())}, 500)
            return

        if not isinstance(full_json, dict):
            self._send_json({"error": "agent_knowledge.json root must be an object"}, 500)
            return

        from core.agent_grain_processor import KG_JSON_PREVIEW_CHARS, build_kg_edges_prompt, knowledge_stats_for_book

        stats = knowledge_stats_for_book(book_dir)
        if stats.get("error_count", 0) > 0:
            self._send_json({"error": f"Cannot generate KG prompt: {stats['error_count']} chapters failed in agent_knowledge.json. Please regenerate knowledge first."}, 400)
            return

        try:
            prompt = build_kg_edges_prompt(full_json)
        except TypeError as e:
            self._send_json({"error": str(e)}, 400)
            return

        debug_prompt_path = (book_dir / "Knowledge" / "_debug_ollama" / "graph_prompt.txt").resolve()
        self._send_json(
            {
                "book_name": book_name,
                "book_dir": str(book_dir.resolve()),
                "agent_json": str(agent_path.resolve()),
                "prompt": prompt,
                "json_preview_max_chars": KG_JSON_PREVIEW_CHARS,
                "saved_prompt_path": str(debug_prompt_path) if debug_prompt_path.is_file() else None,
            }
        )

    def _handle_kg_save(self, data: dict):
        """Save a Property Graph JSON under <book_dir>/Knowledge/.

        Body:
          {
            "book_name": "...",              (required)
            "output_dir": "...?",            (optional)
            "graph": { ... },                (required, JSON object)
            "filename": "kg_graph_openclaw.json", (optional)
            "overwrite": true                (optional, default true)
          }
        """
        book_name = (data.get("book_name") or data.get("title") or data.get("name") or "").strip()
        if not book_name:
            self._send_json({"error": "book_name required"}, 400)
            return

        graph = data.get("graph")
        if not isinstance(graph, dict):
            self._send_json({"error": "graph must be a JSON object"}, 400)
            return

        filename = str(data.get("filename") or "kg_graph_openclaw.json").strip()
        if "/" in filename or "\\" in filename or filename in (".", "..") or filename == "":
            self._send_json({"error": "invalid filename"}, 400)
            return
        if not filename.endswith(".json"):
            filename = filename + ".json"

        overwrite = bool(data.get("overwrite", True))

        output_plugin = self.kernel["output"]
        out_dir_str = (data.get("output_dir") or "").strip()
        if out_dir_str:
            ok, msg, out_dir = output_plugin.validate_dir(out_dir_str)
            if not ok or out_dir is None:
                self._send_json({"error": msg}, 400)
                return
        else:
            out_dir = output_plugin.get_default_dir()

        book_dir = self._resolve_book_dir_by_name(book_name, out_dir)
        if book_dir is None:
            self._send_json({"error": f"Book directory not found under output: {book_name}"}, 404)
            return

        knowledge_dir = (book_dir / "Knowledge").resolve()
        try:
            knowledge_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            self._send_json({"error": str(e), "path": str(knowledge_dir)}, 500)
            return

        target = (knowledge_dir / filename).resolve()
        # Ensure path traversal cannot escape Knowledge/
        if knowledge_dir not in target.parents:
            self._send_json({"error": "invalid path"}, 400)
            return
        if target.exists() and not overwrite:
            self._send_json({"error": "file exists", "path": str(target)}, 409)
            return

        try:
            target.write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError as e:
            self._send_json({"error": str(e), "path": str(target)}, 500)
            return

        self._send_json(
            {
                "success": True,
                "path": str(target),
                "book_dir": str(book_dir.resolve()),
                "book_name": book_name,
                "filename": filename,
            }
        )

    def _generate_knowledge_async(self, book_dir: Path, force_full: bool = False):
        try:
            from core.agent_grain_processor import generate_agent_knowledge

            def on_prog(phase: str, cur: int, total: int):
                pct = 0
                if phase == "starting":
                    pct = 0
                elif phase == "processing_chapter":
                    pct = 5 + int((cur / max(total, 1)) * 90)
                elif phase == "skipped_chapters":
                    pct = 92
                elif phase == "generating_graph":
                    pct = 97
                elif phase == "completed":
                    pct = 100
                self._set_progress(
                    {
                        "status": "generating_knowledge",
                        "percentage": min(99, pct) if pct < 100 else 100,
                        "message": f"{phase} {cur}/{total}",
                        "book_dir": str(book_dir),
                    }
                )

            result = generate_agent_knowledge(book_dir, force_full=force_full, progress_callback=on_prog)
            self._set_progress(
                {
                    "status": "knowledge_completed",
                    "percentage": 100,
                    "book_dir": str(book_dir),
                    **result,
                }
            )
        except Exception as e:
            self._set_progress({"status": "knowledge_error", "error": str(e), "book_dir": str(book_dir)})
    def _download_book_async(
        self,
        book_id: str,
        output_dir: Path,
        formats: list[str],
        selected_chapters: list | None,
        skip_images: bool,
        chunk_config: ChunkConfig | None,
    ):
        """Background download wrapper with error handling."""
        # Reset cancel flag
        DownloaderHandler._cancel_requested = False

        try:
            downloader = self.kernel["downloader"]
            result = downloader.download(
                book_id=book_id,
                output_dir=output_dir,
                formats=formats,
                selected_chapters=selected_chapters,
                skip_images=skip_images,
                chunk_config=chunk_config,
                progress_callback=self._on_progress,
                cancel_check=lambda: DownloaderHandler._cancel_requested,
            )

            self._set_progress(
                {
                    "status": "completed",
                    "book_id": result.book_id,
                    "title": result.title,
                    "percentage": 100,
                    **result.files,
                }
            )
        except Exception as e:
            error_msg = str(e)
            LOGGER.exception("download_failed book_id=%s error=%s", book_id, error_msg)
            if "cancelled" in error_msg.lower():
                self._set_progress({"status": "cancelled", "error": error_msg})
            else:
                self._set_progress({"status": "error", "error": error_msg})

    def _on_progress(self, progress: DownloadProgress):
        """Handle progress updates from the downloader plugin."""
        self._set_progress(
            {
                "status": progress.status,
                "book_id": progress.book_id,
                "percentage": progress.percentage,
                "message": progress.message,
                "eta_seconds": progress.eta_seconds,
                "current_chapter": progress.current_chapter,
                "total_chapters": progress.total_chapters,
                "chapter_title": progress.chapter_title,
            }
        )

    def _send_json(self, data: dict, status: int = 200):
        # 必须带 Content-Length：HTTP/1.1 keep-alive 下否则浏览器无法判定 body 结束，
        # 会出现 DevTools Preview 空、fetch().text() 一直挂起等问题。
        # Keep a copy for endpoint-specific logging (best-effort, in-memory only).
        if isinstance(data, dict):
            self._last_json_response = data
            self._last_json_status = int(status)
        if status >= 400:
            self._log_api_error_response(data, status)
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def _log_generate_knowledge_response(self):
        """Always log generate_knowledge response payload (success or failure)."""
        try:
            parsed = urlparse(self.path)
            client_ip = getattr(self, "client_address", ("", 0))[0]
            elapsed_ms = 0
            if self._request_start_ts is not None:
                elapsed_ms = int((time.time() - self._request_start_ts) * 1000)

            payload = self._last_json_response if isinstance(self._last_json_response, dict) else {}
            status = self._last_json_status if self._last_json_status is not None else self._last_status_code

            # Truncate to avoid huge logs.
            raw = json.dumps(payload, ensure_ascii=False)
            max_chars = int(os.getenv("OREILLY_INGEST_LOG_RESPONSE_MAX_CHARS", "4000"))
            if len(raw) > max_chars:
                raw = raw[:max_chars] + "...(truncated)"

            LOGGER.info(
                "generate_knowledge_response path=%s query=%s status=%s elapsed_ms=%s ip=%s body=%s",
                parsed.path,
                parsed.query,
                status,
                elapsed_ms,
                client_ip,
                raw,
            )
        except Exception:
            pass

    def _log_api_error_response(self, data: dict, status: int):
        """Log error responses in a machine-readable way."""
        try:
            parsed = urlparse(self.path)
            client_ip = getattr(self, "client_address", ("", 0))[0]
            err = None
            msg = None
            if isinstance(data, dict):
                err = data.get("error")
                msg = data.get("message")
            elapsed_ms = 0
            if self._request_start_ts is not None:
                elapsed_ms = int((time.time() - self._request_start_ts) * 1000)
            LOGGER.warning(
                "api_error method=%s path=%s query=%s status=%s elapsed_ms=%s ip=%s error=%r message=%r",
                self.command,
                parsed.path,
                parsed.query,
                status,
                elapsed_ms,
                client_ip,
                err,
                msg,
            )
        except Exception:
            pass

    def log_message(self, format, *args):
        # Route default http.server logs into our logger.
        try:
            LOGGER.info("http %s", (format % args))
        except Exception:
            pass


def create_server(host: str = "localhost", port: int = 8000) -> ThreadingHTTPServer:
    """Create and configure the HTTP server (threaded so /api/status is not blocked by search)."""
    kernel = create_default_kernel()
    DownloaderHandler.kernel = kernel

    server = ThreadingHTTPServer((host, port), DownloaderHandler)
    server.daemon_threads = True
    return server


def run_server(host: str = "localhost", port: int = 8000):
    """Start the HTTP server."""
    server = create_server(host, port)
    LOGGER.info("Server running at http://%s:%s", host, port)
    server.serve_forever()
