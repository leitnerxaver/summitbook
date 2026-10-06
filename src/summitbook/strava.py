"""Talking to Strava: logging in, and downloading activities, GPS tracks and photos."""

import json
import os
import sys
import time
import webbrowser
from getpass import getpass
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

from .config import SECRETS_FILE

API = "https://www.strava.com/api/v3"
AUTHORIZE_URL = "https://www.strava.com/oauth/authorize"
TOKEN_URL = "https://www.strava.com/oauth/token"
# activity:read only sees activities visible to Everyone/Followers, and leaves out privacy zones.
SCOPE = "read,activity:read"
LOGIN_PORT = 8723
REDIRECT_URI = f"http://localhost:{LOGIN_PORT}/callback"


class StravaError(Exception):
    pass


class RateLimited(StravaError):
    def __init__(self, daily: bool):
        self.daily = daily
        window = "daily" if daily else "15-minute"
        super().__init__(f"Strava's {window} request limit is reached")


def _request(url: str, *, data: dict | None = None, token: str | None = None):
    """Returns (status, headers, parsed JSON). Network errors raise StravaError."""
    body = urlencode(data).encode() if data is not None else None
    req = Request(url, data=body, headers={"Authorization": f"Bearer {token}"} if token else {})
    try:
        with urlopen(req, timeout=60) as res:
            return res.status, res.headers, json.load(res)
    except HTTPError as err:
        try:
            payload = json.load(err)
        except ValueError:
            payload = None
        return err.code, err.headers, payload
    except OSError as err:
        raise StravaError(f"Could not reach Strava ({err})") from err


# --- Credentials -------------------------------------------------------------


def load_credentials() -> dict:
    creds = json.loads(SECRETS_FILE.read_text()) if SECRETS_FILE.exists() else {}
    # On GitHub (or any server) the login comes from environment variables instead of the file.
    for key in ("client_id", "client_secret", "refresh_token"):
        if value := os.environ.get(f"STRAVA_{key.upper()}"):
            creds[key] = value
    return creds


def save_credentials(creds: dict) -> None:
    SECRETS_FILE.write_text(json.dumps(creds, indent=2))
    SECRETS_FILE.chmod(0o600)


def _token_request(data: dict) -> dict:
    status, _, payload = _request(TOKEN_URL, data=data)
    if status != 200:
        raise StravaError(f"Strava refused the login (HTTP {status}): {payload}")
    return payload


def login(client_id: str | None = None, client_secret: str | None = None) -> None:
    creds = load_credentials()
    client_id = client_id or creds.get("client_id")
    client_secret = client_secret or creds.get("client_secret")
    if not (client_id and client_secret):
        if not sys.stdin.isatty():
            raise StravaError("Run this in a terminal window, or pass --client-id and --client-secret.")
        print("You find both values at https://www.strava.com/settings/api\n")
        client_id = input("Client ID: ").strip()
        client_secret = getpass("Client Secret (nothing appears while you paste, that's normal): ").strip()

    url = AUTHORIZE_URL + "?" + urlencode({
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "approval_prompt": "auto",
        "scope": SCOPE,
    })
    print("\nOpening Strava in your browser. Click 'Authorize' there.")
    print(f"(If no browser opens, copy this link into one: {url})\n")
    query = _wait_for_redirect(url)

    if "error" in query or "code" not in query:
        raise StravaError("Strava access was not granted.")
    if "activity:read" not in query.get("scope", [""])[0]:
        raise StravaError("Please leave the 'View data about your activities' box ticked and try again.")

    token = _token_request({
        "client_id": client_id,
        "client_secret": client_secret,
        "code": query["code"][0],
        "grant_type": "authorization_code",
    })
    save_credentials({
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": token["refresh_token"],
        "access_token": token["access_token"],
        "expires_at": token["expires_at"],
    })
    name = token.get("athlete", {}).get("firstname", "")
    print(f"Connected to Strava{' as ' + name if name else ''}. Your login is saved in {SECRETS_FILE.name}.")


def _wait_for_redirect(url: str) -> dict:
    result: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path != "/callback":
                self.send_response(404)
                self.end_headers()
                return
            result.update(parse_qs(parsed.query))
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                b"<body style='font:18px system-ui;padding:3em'>"
                b"<h1>Done!</h1><p>You can close this tab and go back to the terminal.</p></body>"
            )

        def log_message(self, *args):
            pass

    with HTTPServer(("127.0.0.1", LOGIN_PORT), Handler) as server:
        webbrowser.open(url)
        while not result:
            server.handle_request()
    return result


# --- API ---------------------------------------------------------------------


class Strava:
    def __init__(self):
        self.token, self.expires_at = self._access_token()

    @staticmethod
    def _access_token() -> tuple[str, int]:
        creds = load_credentials()
        if not creds.get("refresh_token"):
            raise StravaError("You're not connected to Strava yet. Run: uv run summitbook login")
        if creds.get("access_token") and creds.get("expires_at", 0) > time.time() + 120:
            return creds["access_token"], creds["expires_at"]
        token = _token_request({
            "client_id": creds["client_id"],
            "client_secret": creds["client_secret"],
            "grant_type": "refresh_token",
            "refresh_token": creds["refresh_token"],
        })
        if token["refresh_token"] != creds["refresh_token"] and os.environ.get("STRAVA_REFRESH_TOKEN"):
            print("Note: Strava issued a new refresh token; update the STRAVA_REFRESH_TOKEN secret.")
        creds.update({k: token[k] for k in ("access_token", "refresh_token", "expires_at")})
        save_credentials(creds)
        return creds["access_token"], creds["expires_at"]

    def _get(self, path: str, **params):
        if self.expires_at < time.time() + 120:
            self.token, self.expires_at = self._access_token()
        status, headers, payload = _request(f"{API}{path}?{urlencode(params)}", token=self.token)
        if status == 429:
            raise RateLimited(daily=_daily_limit_hit(headers))
        if status == 401:
            raise StravaError("Strava rejected the login. Run: uv run summitbook login")
        if status == 404:
            return None
        if status != 200:
            raise StravaError(f"Strava answered HTTP {status} for {path}: {payload}")
        return payload

    def activities(self) -> list[dict]:
        found, page = [], 1
        while batch := self._get("/athlete/activities", per_page=200, page=page):
            found += batch
            page += 1
        return found

    def track(self, activity_id: int) -> list[list] | None:
        """GPS points as [lat, lon, altitude] (altitude may be None)."""
        streams = self._get(f"/activities/{activity_id}/streams", keys="latlng,altitude", key_by_type="true")
        if not streams or "latlng" not in streams:
            return None
        latlng = streams["latlng"]["data"]
        alt = streams.get("altitude", {}).get("data") or []
        return [[lat, lon, alt[i] if i < len(alt) else None] for i, (lat, lon) in enumerate(latlng)]

    def photos(self, activity_id: int) -> list[dict]:
        def fetch(size):
            return self._get(f"/activities/{activity_id}/photos", size=size, photo_sources="true") or []

        large = {p.get("unique_id"): (p.get("urls") or {}).get("2048") for p in fetch(2048)}
        photos = []
        for p in fetch(600):
            if thumb := (p.get("urls") or {}).get("600"):
                photos.append({
                    "thumb": thumb,
                    "full": large.get(p.get("unique_id")) or thumb,
                    "caption": p.get("caption") or "",
                })
        return photos


def _daily_limit_hit(headers) -> bool:
    for prefix in ("X-ReadRateLimit", "X-RateLimit"):
        try:
            limit = [int(x) for x in headers.get(f"{prefix}-Limit", "").split(",")]
            usage = [int(x) for x in headers.get(f"{prefix}-Usage", "").split(",")]
        except ValueError:
            continue
        if len(limit) > 1 and len(usage) > 1 and usage[1] >= limit[1]:
            return True
    return False
