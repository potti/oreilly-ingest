import json

import requests

import config
from .base import Plugin


def _cookies_dict_from_file() -> dict:
    if not config.COOKIES_FILE.exists():
        return {}
    try:
        with open(config.COOKIES_FILE) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


class AuthPlugin(Plugin):
    def validate_session(self) -> bool:
        response = self.http.get("/profile/", allow_redirects=False)
        if response.status_code != 200:
            return False
        if '"user_type":"Expired"' in response.text:
            return False
        return True

    def get_status(self) -> dict:
        """Profile check without the shared Session (ThreadingHTTPServer-safe).

        Long-running handlers (e.g. search) may hold the process for a long time on a
        single-threaded server, or contend on Session with other threads. This uses a
        one-off request + cookies from disk so /api/status stays responsive.
        """
        url = f"{config.BASE_URL}/profile/"
        try:
            response = requests.get(
                url,
                cookies=_cookies_dict_from_file(),
                headers=config.HEADERS,
                timeout=config.REQUEST_TIMEOUT,
                allow_redirects=False,
            )
        except requests.RequestException:
            return {"valid": False, "reason": "not_authenticated"}

        if response.status_code != 200:
            return {"valid": False, "reason": "not_authenticated"}

        if '"user_type":"Expired"' in response.text:
            return {"valid": False, "reason": "subscription_expired"}

        return {"valid": True, "reason": None}
