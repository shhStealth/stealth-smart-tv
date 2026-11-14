#!/usr/bin/env python3
"""
Backend for the Stealth Smart TV dashboard.

Serves the static kiosk UI from ./public, and persists the user's own tiles
(name + URL + optional uploaded icon) to ./data/tiles.json + ./data/icons/ —
the app ships with zero default tiles; everything shown on screen is added
through the dashboard's own "+" tile. It also optionally proxies ECP (Roku
External Control Protocol) calls to a Roku TV, if ROKU_IP is set, so the
browser never has to deal with CORS/mixed content for that.

Usage:
    python3 server.py
    # then open http://localhost:8765 in a kiosk/fullscreen browser window

Config via env vars:
    EDIT_TOKEN - if set, required (as an X-Edit-Token header) to add/remove
                 tiles; viewing the dashboard is never gated by this.
                 Unset by default — anyone who can reach the backend can
                 edit tiles, same as viewing. (optional)
    ROKU_IP    - TV's LAN IP, only needed if you use the ECP fallback (optional)
    NHL_TEAM   - an NHL team's three-letter code (e.g. TOR) to show a "next
                 game" widget in the header; hidden when unset. (optional)
    PORT       - local port to listen on (default 8765)

No pip installs needed — stdlib only, including a small hand-rolled
multipart/form-data parser for icon uploads (avoids depending on the
deprecated `cgi` module).
"""
import datetime
import hmac
import http.server
import json
import os
import re
import threading
import time
import urllib.request
import urllib.error
import uuid
import xml.etree.ElementTree as ET
from http import HTTPStatus

EDIT_TOKEN = os.environ.get("EDIT_TOKEN", "")
ROKU_IP = os.environ.get("ROKU_IP", "")
NHL_TEAM = os.environ.get("NHL_TEAM", "").strip().upper()
ROKU_PORT = 8060
ROKU_BASE = f"http://{ROKU_IP}:{ROKU_PORT}"
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(PROJECT_ROOT, "public")
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
ICONS_DIR = os.path.join(DATA_DIR, "icons")
TILES_FILE = os.path.join(DATA_DIR, "tiles.json")
LISTEN_PORT = int(os.environ.get("PORT", "8765"))

MAX_ICON_BYTES = 2 * 1024 * 1024  # 2 MB
MAX_UPLOAD_BYTES = MAX_ICON_BYTES + 64 * 1024  # a little headroom for form overhead

os.makedirs(ICONS_DIR, exist_ok=True)

TILES_LOCK = threading.Lock()

IMAGE_CONTENT_TYPE_BY_EXT = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
}


def load_tiles():
    if not os.path.isfile(TILES_FILE):
        return []
    try:
        with open(TILES_FILE, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def save_tiles(tiles):
    tmp = TILES_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(tiles, f, indent=2)
    os.replace(tmp, TILES_FILE)


def sniff_image_ext(data):
    """Identify an image by its magic bytes rather than trusting the
    upload's declared filename/content-type."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def parse_multipart_form(body, boundary):
    """Minimal multipart/form-data parser: enough for a browser-generated
    FormData upload (text fields + one file field), without needing the
    deprecated `cgi` module or a pip dependency."""
    fields = {}
    for part in body.split(b"--" + boundary):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        if b"\r\n\r\n" not in part:
            continue
        header_blob, value = part.split(b"\r\n\r\n", 1)
        value = value[:-2] if value.endswith(b"\r\n") else value
        headers = {}
        for line in header_blob.split(b"\r\n"):
            if b":" in line:
                k, v = line.split(b":", 1)
                headers[k.strip().lower()] = v.strip()
        disp = headers.get(b"content-disposition", b"").decode("utf-8", "replace")
        name_match = re.search(r'name="([^"]*)"', disp)
        if not name_match:
            continue
        filename_match = re.search(r'filename="([^"]*)"', disp)
        fields[name_match.group(1)] = {
            "value": value,
            "filename": filename_match.group(1) if filename_match else None,
        }
    return fields


def roku_request(path, method="GET"):
    req = urllib.request.Request(f"{ROKU_BASE}{path}", method=method)
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status, resp.read(), resp.headers.get("Content-Type", "")


# ---- optional NHL "next game" widget (only used if NHL_TEAM is set) ----
#
# The NHL's public stats API doesn't send CORS headers, so the browser
# can't call it directly — the backend fetches it, trims it down to what
# the widget draws, and caches it so any number of TVs polling this
# backend still only hit the NHL a handful of times an hour.

NHL_API = "https://api-web.nhle.com/v1"
# api-web.nhle.com answers urllib's default "Python-urllib/x.y" with a 403.
NHL_USER_AGENT = "stealth-smart-tv (+https://github.com/shhStealth/stealth-smart-tv)"
NHL_SCHEDULE_TTL = 5 * 60
NHL_STANDINGS_TTL = 30 * 60
NHL_LIVE_TTL = 30
# Start pulling live scores this long before puck drop, since the cached
# season schedule can still say "FUT" for a few minutes after it starts.
NHL_LIVE_LEAD_SECONDS = 15 * 60
NHL_LIVE_STATES = ("LIVE", "CRIT")
NHL_DONE_STATES = ("OFF", "FINAL")

_nhl_cache = {}  # path -> (fetched_at, data)
_nhl_cache_lock = threading.Lock()


def nhl_get(path, ttl):
    """GET an NHL API path with a TTL cache. If a refresh fails, keeps
    serving the last good copy (a stale schedule beats a blank widget);
    raises only if there's never been a good copy."""
    now = time.time()
    with _nhl_cache_lock:
        cached = _nhl_cache.get(path)
    if cached and now - cached[0] < ttl:
        return cached[1]
    req = urllib.request.Request(NHL_API + path, headers={"User-Agent": NHL_USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.load(resp)
    except (urllib.error.URLError, TimeoutError, ValueError):
        if cached:
            return cached[1]
        raise
    with _nhl_cache_lock:
        _nhl_cache[path] = (now, data)
    return data


def _ordinal(n):
    if 10 <= n % 100 <= 20:
        return f"{n}th"
    return f"{n}{ {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th') }"


def _nhl_period_label(descriptor):
    if not descriptor:
        return None
    if descriptor.get("periodType") == "SO":
        return "SO"
    number = descriptor.get("number") or 0
    regulation = descriptor.get("maxRegulationPeriods") or 3
    if descriptor.get("periodType") == "OT" or number > regulation:
        overtime = number - regulation
        return "OT" if overtime <= 1 else f"{overtime}OT"
    return _ordinal(number) if number else None


def _nhl_side(side):
    name = (side.get("commonName") or side.get("name") or {}).get("default") or side.get("abbrev")
    return {
        "abbrev": side.get("abbrev"),
        "name": name,
        "logo": side.get("darkLogo") or side.get("logo"),
        "score": side.get("score"),
    }


def _nhl_game(game, team):
    home = game.get("homeTeam", {})
    outcome = (game.get("gameOutcome") or {}).get("lastPeriodType")
    return {
        "id": game.get("id"),
        "start": game.get("startTimeUTC"),
        "state": game.get("gameState"),
        "isHome": home.get("abbrev") == team,
        "home": _nhl_side(home),
        "away": _nhl_side(game.get("awayTeam", {})),
        "period": _nhl_period_label(game.get("periodDescriptor")),
        "decidedIn": outcome if outcome in ("OT", "SO") else None,
    }


def build_nhl_summary(team):
    schedule = nhl_get(f"/club-schedule-season/{team}/now", NHL_SCHEDULE_TTL)
    games = [g for g in schedule.get("games", []) if g.get("gameScheduleState", "OK") == "OK"]
    games.sort(key=lambda g: g.get("startTimeUTC", ""))
    done = [g for g in games if g.get("gameState") in NHL_DONE_STATES]
    upcoming = [g for g in games if g.get("gameState") not in NHL_DONE_STATES]

    summary = {
        "enabled": True,
        "team": {"abbrev": team, "name": team, "logo": None, "record": None, "standing": None},
        "last": _nhl_game(done[-1], team) if done else None,
        "upcoming": [_nhl_game(g, team) for g in upcoming[:3]],
    }

    # Live scores: the season schedule is cached for minutes at a time and
    # carries no game clock, so around game time, overlay today's
    # scoreboard (short TTL) onto whichever upcoming game is underway.
    if summary["upcoming"]:
        first = summary["upcoming"][0]
        try:
            starts_in = datetime.datetime.fromisoformat(first["start"].replace("Z", "+00:00")).timestamp() - time.time()
        except (AttributeError, ValueError):
            starts_in = None
        if first["state"] in NHL_LIVE_STATES or (starts_in is not None and starts_in < NHL_LIVE_LEAD_SECONDS):
            try:
                scoreboard = nhl_get("/score/now", NHL_LIVE_TTL)
                live = next((g for g in scoreboard.get("games", []) if g.get("id") == first["id"]), None)
            except (urllib.error.URLError, TimeoutError, ValueError):
                live = None
            if live:
                merged = _nhl_game(live, team)
                clock = live.get("clock") or {}
                merged["clock"] = clock.get("timeRemaining")
                merged["intermission"] = bool(clock.get("inIntermission"))
                # The scoreboard's sides lack darkLogo; keep the schedule's.
                merged["home"]["logo"] = first["home"]["logo"]
                merged["away"]["logo"] = first["away"]["logo"]
                if merged["state"] in NHL_DONE_STATES:
                    summary["last"] = merged
                    summary["upcoming"] = summary["upcoming"][1:]
                else:
                    summary["upcoming"][0] = merged

    try:
        standings = nhl_get("/standings/now", NHL_STANDINGS_TTL).get("standings", [])
    except (urllib.error.URLError, TimeoutError, ValueError):
        standings = []
    row = next((s for s in standings if (s.get("teamAbbrev") or {}).get("default") == team), None)
    if row:
        summary["team"].update({
            "name": (row.get("teamName") or {}).get("default") or team,
            "logo": row.get("teamLogoDark") or row.get("teamLogo"),
            "record": f"{row.get('wins', 0)}-{row.get('losses', 0)}-{row.get('otLosses', 0)}",
            "standing": f"{_ordinal(row['divisionSequence'])} in {row['divisionName']}"
            if row.get("divisionSequence") and row.get("divisionName") else None,
        })
    return summary


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def log_message(self, fmt, *args):
        pass  # quiet console; comment this out to debug

    def end_headers(self):
        # Without this, responses only carry Last-Modified, and a browser's
        # default heuristic caching can treat static files (style.css,
        # app.js...) as fresh for a while and skip even a revalidation
        # request on plain refresh — edits here can silently not show up
        # until a hard refresh. no-cache forces a revalidation (cheap 304s
        # via Last-Modified) on every load instead.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/apps":
            return self._proxy_apps()
        if self.path == "/api/active-app":
            return self._proxy_active_app()
        if self.path == "/api/tiles":
            return self._list_tiles()
        if self.path == "/api/nhl":
            return self._nhl_summary()
        if self.path.startswith("/api/icon/"):
            return self._proxy_icon(self.path[len("/api/icon/"):])
        if self.path.startswith("/data/icons/"):
            return self._serve_uploaded_icon(self.path[len("/data/icons/"):])
        return super().do_GET()

    def do_POST(self):
        if self.path == "/api/tiles":
            return self._create_tile()
        if self.path.startswith("/api/launch/"):
            return self._proxy_launch(self.path[len("/api/launch/"):])
        if self.path.startswith("/api/key/"):
            return self._proxy_key(self.path[len("/api/key/"):])
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_DELETE(self):
        if self.path.startswith("/api/tiles/"):
            return self._delete_tile(self.path[len("/api/tiles/"):])
        self.send_error(HTTPStatus.NOT_FOUND)

    # ---- user-managed tiles ----

    def _authorized(self):
        if not EDIT_TOKEN:
            return True
        return hmac.compare_digest(self.headers.get("X-Edit-Token", ""), EDIT_TOKEN)

    def _list_tiles(self):
        self._json(200, {"tiles": load_tiles()})

    def _create_tile(self):
        if not self._authorized():
            return self._json(401, {"error": "invalid or missing edit token"})
        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("multipart/form-data"):
            return self._json(400, {"error": "expected multipart/form-data"})
        boundary_match = re.search(r'boundary="?([^";]+)"?', content_type)
        if not boundary_match:
            return self._json(400, {"error": "missing multipart boundary"})
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            return self._json(400, {"error": "request too large"})
        body = self.rfile.read(length)
        try:
            fields = parse_multipart_form(body, boundary_match.group(1).encode())
        except Exception:
            return self._json(400, {"error": "couldn't parse upload"})

        name = fields.get("name", {}).get("value", b"").decode("utf-8", "replace").strip()
        url = fields.get("url", {}).get("value", b"").decode("utf-8", "replace").strip()
        if not name or len(name) > 60:
            return self._json(400, {"error": "name is required (max 60 characters)"})
        if not (url.startswith("http://") or url.startswith("https://")):
            return self._json(400, {"error": "address must start with http:// or https://"})

        tile_id = uuid.uuid4().hex[:12]
        icon_path = None
        icon_field = fields.get("icon")
        if icon_field and icon_field.get("filename"):
            data = icon_field["value"]
            if len(data) > MAX_ICON_BYTES:
                return self._json(400, {"error": "icon must be under 2 MB"})
            ext = sniff_image_ext(data)
            if not ext:
                return self._json(400, {"error": "icon must be a PNG, JPEG, GIF, or WEBP image"})
            filename = f"{tile_id}.{ext}"
            with open(os.path.join(ICONS_DIR, filename), "wb") as f:
                f.write(data)
            icon_path = f"/data/icons/{filename}"

        tile = {"id": tile_id, "name": name, "url": url, "icon": icon_path}
        with TILES_LOCK:
            tiles = load_tiles()
            tiles.append(tile)
            save_tiles(tiles)
        self._json(200, {"tile": tile})

    def _delete_tile(self, tile_id):
        if not self._authorized():
            return self._json(401, {"error": "invalid or missing edit token"})
        with TILES_LOCK:
            tiles = load_tiles()
            removed = [t for t in tiles if t.get("id") == tile_id]
            save_tiles([t for t in tiles if t.get("id") != tile_id])
        for t in removed:
            if t.get("icon"):
                path = os.path.join(ICONS_DIR, os.path.basename(t["icon"]))
                if os.path.isfile(path):
                    os.remove(path)
        self._json(200, {"ok": True})

    def _serve_uploaded_icon(self, filename):
        filename = os.path.basename(filename)  # no path traversal
        path = os.path.join(ICONS_DIR, filename)
        if not os.path.isfile(path):
            return self.send_error(HTTPStatus.NOT_FOUND)
        ext = filename.rsplit(".", 1)[-1].lower()
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", IMAGE_CONTENT_TYPE_BY_EXT.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---- optional NHL widget (only used if NHL_TEAM is set) ----

    def _nhl_summary(self):
        if not NHL_TEAM:
            return self._json(200, {"enabled": False})
        try:
            return self._json(200, build_nhl_summary(NHL_TEAM))
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            return self._json(502, {"enabled": True, "error": str(e)})

    # ---- optional Roku ECP fallback (only used if ROKU_IP is set) ----

    def _proxy_apps(self):
        if not ROKU_IP:
            return self._json(200, {"apps": []})
        try:
            _, body, _ = roku_request("/query/apps")
        except (urllib.error.URLError, TimeoutError) as e:
            return self._json(502, {"error": str(e)})
        root = ET.fromstring(body)
        apps = [
            {"id": el.get("id"), "type": el.get("type"), "name": el.text}
            for el in root.findall("app")
        ]
        self._json(200, {"apps": apps})

    def _proxy_active_app(self):
        if not ROKU_IP:
            return self._json(200, {"name": None, "id": None})
        try:
            _, body, _ = roku_request("/query/active-app")
        except (urllib.error.URLError, TimeoutError) as e:
            return self._json(502, {"error": str(e)})
        root = ET.fromstring(body)
        app_el = root.find("app")
        self._json(200, {
            "name": app_el.text if app_el is not None else None,
            "id": app_el.get("id") if app_el is not None else None,
        })

    def _proxy_icon(self, app_id):
        try:
            _, body, content_type = roku_request(f"/query/icon/{app_id}")
        except (urllib.error.URLError, TimeoutError):
            return self.send_error(HTTPStatus.NOT_FOUND)
        self.send_response(200)
        self.send_header("Content-Type", content_type or "image/webp")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _proxy_launch(self, app_id):
        try:
            roku_request(f"/launch/{app_id}", method="POST")
        except (urllib.error.URLError, TimeoutError) as e:
            return self._json(502, {"ok": False, "error": str(e)})
        self._json(200, {"ok": True})

    def _proxy_key(self, key):
        try:
            roku_request(f"/keypress/{key}", method="POST")
        except (urllib.error.URLError, TimeoutError) as e:
            return self._json(502, {"ok": False, "error": str(e)})
        self._json(200, {"ok": True})


def main():
    server = http.server.ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), Handler)
    print(f"Stealth Smart TV backend running at http://localhost:{LISTEN_PORT}")
    if ROKU_IP:
        print(f"Proxying ECP to TV at {ROKU_BASE}")
    if NHL_TEAM:
        print(f"NHL widget enabled for {NHL_TEAM}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
