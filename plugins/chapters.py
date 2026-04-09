from .base import Plugin
from core.types import ChapterInfo
import config


class ChaptersPlugin(Plugin):
    """Plugin for fetching book chapters and their content."""

    @staticmethod
    def _related_assets_maps(ch: dict) -> tuple[list[str], list[str]]:
        """O'Reilly may send ``related_assets: null``; ``dict.get(k, {}).get`` would crash on null."""
        ra = ch.get("related_assets")
        if not isinstance(ra, dict):
            ra = {}
        images = ra.get("images") or []
        stylesheets = ra.get("stylesheets") or []
        if not isinstance(images, list):
            images = []
        if not isinstance(stylesheets, list):
            stylesheets = []
        return [str(x) for x in images], [str(x) for x in stylesheets]

    def fetch_list(self, book_id: str) -> list[ChapterInfo]:
        """Fetch list of chapters for a book."""
        url = f"{config.API_V2}/epub-chapters/?epub_identifier=urn:orm:book:{book_id}"
        chapters: list[ChapterInfo] = []

        while url:
            data = self.http.get_json(url)
            for ch in data.get("results", []):
                if not isinstance(ch, dict):
                    continue
                imgs, sheets = self._related_assets_maps(ch)
                chapters.append(ChapterInfo(
                    ourn=ch.get("ourn", ""),
                    title=ch.get("title", ""),
                    filename=self._extract_filename(ch.get("reference_id", "")),
                    content_url=ch.get("content_url", ""),
                    images=imgs,
                    stylesheets=sheets,
                    virtual_pages=ch.get("virtual_pages"),
                    minutes_required=ch.get("minutes_required"),
                ))
            url = data.get("next")

        return self._reorder_cover_first(chapters)

    def fetch_toc(self, book_id: str) -> list[dict]:
        url = f"{config.API_V2}/epubs/urn:orm:book:{book_id}/table-of-contents/"
        data = self.http.get_json(url)
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict)]
        if isinstance(data, dict):
            for key in ("results", "toc", "children", "navigation", "items"):
                inner = data.get(key)
                if isinstance(inner, list):
                    return [x for x in inner if isinstance(x, dict)]
        return []

    def fetch_content(self, content_url: str) -> str:
        return self.http.get_text(content_url)

    def _extract_filename(self, reference_id: str) -> str:
        if "-/" in reference_id:
            return reference_id.split("-/")[1]
        return reference_id

    def _reorder_cover_first(self, chapters: list[ChapterInfo]) -> list[ChapterInfo]:
        """Reorder chapters to ensure cover comes first."""
        cover_chapters: list[ChapterInfo] = []
        other_chapters: list[ChapterInfo] = []

        for ch in chapters:
            filename_lower = (ch.get("filename") or "").lower()
            title_lower = (ch.get("title") or "").lower()
            if "cover" in filename_lower or "cover" in title_lower:
                cover_chapters.append(ch)
            else:
                other_chapters.append(ch)

        return cover_chapters + other_chapters
