"""Duo - listen to the same song together, in sync, from anywhere.

Run:  uvicorn server:app --host 0.0.0.0 --port 8000
Admin page: /admin (password from ADMIN_PASSWORD, or the generated admin_password.txt)
"""
import asyncio
import html
import json
import mimetypes
import os
import re
import secrets
import shutil
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path

from fastapi import (
    FastAPI, File, Form, HTTPException, Request, Response, UploadFile, WebSocket, WebSocketDisconnect,
)
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

try:
    import yt_dlp  # optional: only needed to download YouTube audio into the library
except ImportError:
    yt_dlp = None

BASE = Path(__file__).parent
DATA_DIR = Path(os.environ.get("DUO_DATA_DIR") or BASE)  # library, history database and admin password
LIBRARY = DATA_DIR / "library"  # songs live here permanently; you can also copy files in by hand
LIBRARY.mkdir(parents=True, exist_ok=True)

MAX_UPLOAD_BYTES = 200 * 1024 * 1024  # per song
MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024  # per zip
MAX_UNZIPPED_BYTES = 5 * 1024 * 1024 * 1024  # total extracted from one zip
AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav", ".flac", ".webm"}
ROOM_CODE = re.compile(r"^[A-Z0-9]{4,12}$")
UNSAFE_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
# A dropped connection (closed tab, lost network) only counts as "left" if they don't come back in time.
LEAVE_GRACE_SECONDS = float(os.environ.get("DUO_LEAVE_GRACE", 60))

# YouTube search needs a free Data API key (see README). Pasting links works without one.
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "").strip()
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
VIDEO_URL = re.compile(r"(?:youtu\.be/|[?&]v=|/(?:embed|shorts|live|v)/)([A-Za-z0-9_-]{11})")
MAX_DOWNLOAD_SECONDS = 3 * 60 * 60  # don't pull hours-long streams into the library
RANGE = re.compile(r"bytes=(\d*)-(\d*)")
AUDIO_TYPES = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg",
               ".oga": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav", ".flac": "audio/flac",
               ".webm": "audio/webm"}

app = FastAPI(title="Duo")


def now() -> float:
    return time.time()


@app.middleware("http")
async def no_stale_pages(request: Request, call_next):
    response = await call_next(request)
    # Browsers must re-check pages and scripts, otherwise an update can run with an old app.js.
    if not request.url.path.startswith("/media/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# ---------- History (join / leave / songs) ----------

db = sqlite3.connect(DATA_DIR / "duo.db", check_same_thread=False)
db.execute("""CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY, ts REAL NOT NULL, room TEXT, user TEXT, event TEXT NOT NULL, detail TEXT)""")
db.commit()


def log_event(event: str, room: str = "", user: str = "", detail: str = ""):
    db.execute("INSERT INTO events (ts, room, user, event, detail) VALUES (?, ?, ?, ?, ?)",
               (now(), room, user, event, detail))
    db.commit()


# ---------- Admin login ----------

def load_admin_password() -> str:
    if os.environ.get("ADMIN_PASSWORD"):
        return os.environ["ADMIN_PASSWORD"]
    path = DATA_DIR / "admin_password.txt"
    if not path.exists():
        path.write_text(secrets.token_urlsafe(9))
        print(f"Created an admin password in {path}")
    return path.read_text().strip()


ADMIN_PASSWORD = load_admin_password()
ADMIN_COOKIE = "duo_admin"
ADMIN_SESSION_SECONDS = 12 * 3600
admin_sessions: dict[str, float] = {}  # token -> expiry time


def is_admin(request: Request) -> bool:
    expiry = admin_sessions.get(request.cookies.get(ADMIN_COOKIE, ""))
    return expiry is not None and expiry > now()


def require_admin(request: Request):
    if not is_admin(request):
        raise HTTPException(401, "Admin login required")


class Login(BaseModel):
    password: str


@app.post("/api/admin/login")
async def admin_login(body: Login, response: Response):
    if not secrets.compare_digest(body.password.encode(), ADMIN_PASSWORD.encode()):
        await asyncio.sleep(1)  # slow down password guessing
        raise HTTPException(401, "Wrong password")
    token = secrets.token_urlsafe(32)
    admin_sessions[token] = now() + ADMIN_SESSION_SECONDS
    response.set_cookie(ADMIN_COOKIE, token, max_age=ADMIN_SESSION_SECONDS, httponly=True, samesite="strict")
    return {"ok": True}


@app.post("/api/admin/logout")
async def admin_logout(request: Request, response: Response):
    admin_sessions.pop(request.cookies.get(ADMIN_COOKIE, ""), None)
    response.delete_cookie(ADMIN_COOKIE)
    return {"ok": True}


@app.get("/api/admin/me")
async def admin_me(request: Request):
    return {"loggedIn": is_admin(request)}


@app.get("/api/admin/history")
async def admin_history(request: Request, room: str = "", user: str = "", event: str = "",
                        before: int = 0, limit: int = 100):
    require_admin(request)
    sql, args = "SELECT id, ts, room, user, event, detail FROM events WHERE 1=1", []
    if room:
        sql += " AND room = ?"
        args.append(room.upper())
    if user:
        sql += " AND user LIKE ?"
        args.append(f"%{user}%")
    if event:
        sql += " AND event = ?"
        args.append(event)
    if before:
        sql += " AND id < ?"
        args.append(before)
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(max(1, min(limit, 500)))
    cols = ("id", "ts", "room", "user", "event", "detail")
    return [dict(zip(cols, row)) for row in db.execute(sql, args)]


@app.get("/api/admin/rooms")
async def admin_rooms(request: Request):
    require_admin(request)
    result = []
    for room in rooms.values():
        track = room.queue[room.current] if room.current is not None else None
        result.append({
            "code": room.code,
            "members": room.member_names(),
            "nowPlaying": track["title"] if track else None,
            "playing": room.playing,
            "queueLength": len(room.queue),
        })
    return sorted(result, key=lambda r: r["code"])


# ---------- Library ----------

def library_songs() -> list[dict]:
    songs = [
        {"id": p.name, "title": p.stem, "size": p.stat().st_size}
        for p in LIBRARY.iterdir()
        if p.is_file() and p.suffix.lower() in AUDIO_EXTS
    ]
    return sorted(songs, key=lambda s: s["title"].lower())


def library_path(song_id: str) -> Path:
    """Resolve a song id (its file name) to a file inside the library, or 404."""
    path = LIBRARY / song_id
    if Path(song_id).name != song_id or path.suffix.lower() not in AUDIO_EXTS or not path.is_file():
        raise HTTPException(404, "Song not found")
    return path


def safe_filename(name: str) -> str:
    name = UNSAFE_CHARS.sub("_", Path(name).name).strip(" .")
    stem, ext = Path(name).stem[:150] or "song", Path(name).suffix.lower()
    return f"{stem}{ext}"


# ---------- Rooms ----------

class Room:
    def __init__(self, code: str):
        self.code = code
        self.clients: dict[WebSocket, dict] = {}  # socket -> {"name", "sid"}
        self.pending_leaves: dict[str, asyncio.Task] = {}  # sid -> delayed "left" log
        # Entries: {"id" (unique per entry), "kind": "file"|"youtube", "song" | "videoId", "title", "by"}
        self.queue: list[dict] = []
        self.current: int | None = None
        self.playing = False
        self.position = 0.0  # seconds into the track at `updated_at`
        self.updated_at = now()

    def position_now(self) -> float:
        if self.playing:
            return self.position + (now() - self.updated_at)
        return self.position

    def set_playback(self, *, playing: bool | None = None, position: float | None = None):
        self.position = self.position_now() if position is None else max(0.0, position)
        if playing is not None:
            self.playing = playing
        self.updated_at = now()

    def go_to(self, index: int, playing: bool = True):
        if 0 <= index < len(self.queue):
            self.current = index
            self.set_playback(playing=playing, position=0.0)

    def enqueue(self, entries: list[dict], play_now: bool = False):
        """Add to the end of the queue, or with play_now right after the current song and start it."""
        if not entries:
            return
        if play_now:
            at = len(self.queue) if self.current is None else self.current + 1
            self.queue[at:at] = entries
            self.go_to(at)
        else:
            self.queue.extend(entries)
            if self.current is None:
                self.go_to(0, playing=False)

    def remove(self, index: int):
        if not 0 <= index < len(self.queue):
            return
        self.queue.pop(index)
        if not self.queue:
            self.current, self.playing, self.position = None, False, 0.0
        elif index < self.current:
            self.current -= 1
        elif index == self.current:
            self.go_to(min(index, len(self.queue) - 1), playing=self.playing)

    def is_connected(self, sid: str) -> bool:
        return any(c["sid"] == sid for c in self.clients.values())

    def member_names(self) -> list[str]:
        # One entry per person, even if they have the room open in two tabs.
        return list({c["sid"]: c["name"] for c in self.clients.values()}.values())

    def state(self) -> dict:
        return {
            "type": "state",
            "queue": self.queue,
            "current": self.current,
            "playing": self.playing,
            "position": self.position,
            "updatedAt": self.updated_at,
            "members": self.member_names(),
        }

    async def broadcast(self, msg: dict):
        data = json.dumps(msg)
        for ws in list(self.clients):
            try:
                await ws.send_text(data)
            except Exception:
                self.clients.pop(ws, None)

    async def broadcast_state(self):
        await self.broadcast(self.state())


rooms: dict[str, Room] = {}


async def broadcast_all(msg: dict):
    for room in list(rooms.values()):
        await room.broadcast(msg)


async def log_leave_later(room: Room, sid: str, name: str):
    await asyncio.sleep(LEAVE_GRACE_SECONDS)
    room.pending_leaves.pop(sid, None)
    if not room.is_connected(sid):
        log_event("left", room.code, name, "connection closed")
    if not room.clients and not room.queue and not room.pending_leaves and rooms.get(room.code) is room:
        rooms.pop(room.code, None)


# ---------- HTTP API ----------

@app.get("/api/library")
async def get_library():
    return library_songs()


def store_in_library(tmp: Path, filename: str) -> tuple[str, bool]:
    """Move an uploaded temp file into the library. Returns (song id, was it a duplicate)."""
    size = tmp.stat().st_size
    # Same name and same size: it's the same song, keep the existing copy.
    dest = LIBRARY / filename
    if dest.exists() and dest.stat().st_size == size:
        tmp.unlink()
        return dest.name, True
    n = 2
    while dest.exists():
        dest = LIBRARY / f"{Path(filename).stem} ({n}){Path(filename).suffix}"
        n += 1
    tmp.rename(dest)
    return dest.name, False


def extract_zip(zip_path: Path) -> dict:
    """Add every song inside a zip (any sub-folder) to the library; other files are ignored."""
    added, duplicates, skipped = [], 0, 0
    total = 0
    try:
        archive = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        raise HTTPException(400, "That zip file is damaged or not a real zip")
    with archive:
        for info in archive.infolist():
            # Only the file's own name is used, so paths inside the zip can't escape the library.
            path = info.filename.replace("\\", "/")
            raw_name = path.rsplit("/", 1)[-1]
            filename = safe_filename(raw_name)
            if info.is_dir() or Path(filename).suffix not in AUDIO_EXTS:
                continue
            if raw_name.startswith("._") or path.startswith("__MACOSX/"):
                continue  # macOS metadata, not real songs
            if info.file_size > MAX_UPLOAD_BYTES:
                skipped += 1
                continue
            tmp = LIBRARY / f".upload-{uuid.uuid4().hex}"
            try:
                written = 0
                with archive.open(info) as src, tmp.open("wb") as out:
                    while chunk := src.read(1024 * 1024):
                        written += len(chunk)
                        total += len(chunk)
                        if total > MAX_UNZIPPED_BYTES:
                            raise HTTPException(413, "That zip unpacks to more than 5 GB")
                        if written > MAX_UPLOAD_BYTES:  # don't trust the size the zip claims
                            raise ValueError("too large")
                        out.write(chunk)
                song_id, duplicate = store_in_library(tmp, filename)
                if duplicate:
                    duplicates += 1
                else:
                    added.append(song_id)
            except (ValueError, zipfile.BadZipFile, NotImplementedError, RuntimeError):
                skipped += 1  # too large, corrupt, unsupported compression or password-protected
            finally:
                tmp.unlink(missing_ok=True)
    return {"added": added, "duplicates": duplicates, "skipped": skipped}


@app.post("/api/library")
async def upload_song(request: Request, file: UploadFile = File(...), name: str = Form("")):
    """Upload one song, or a .zip full of songs."""
    filename = safe_filename(file.filename or "")
    is_zip = Path(filename).suffix == ".zip"
    if not is_zip and Path(filename).suffix not in AUDIO_EXTS:
        raise HTTPException(400, f"Unsupported file type '{Path(filename).suffix}'")
    limit = MAX_ZIP_BYTES if is_zip else MAX_UPLOAD_BYTES
    uploader = "Admin" if is_admin(request) else (name.strip()[:40] or "Guest")

    tmp = LIBRARY / f".upload-{uuid.uuid4().hex}"
    size = 0
    try:
        with tmp.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(413, f"File is larger than {limit // (1024 * 1024)} MB")
                out.write(chunk)

        if is_zip:
            result = await asyncio.to_thread(extract_zip, tmp)
            if not result["added"] and not result["duplicates"]:
                raise HTTPException(400, "No playable songs found in that zip")
        else:
            song_id, duplicate = store_in_library(tmp, filename)
            result = {"added": [] if duplicate else [song_id], "duplicates": int(duplicate), "skipped": 0}
    finally:
        tmp.unlink(missing_ok=True)

    for song_id in result["added"]:
        log_event("uploaded", "", uploader, Path(song_id).stem + (f" (from {filename})" if is_zip else ""))
    if result["added"]:
        await broadcast_all({"type": "library"})
    return result


@app.delete("/api/library/{song_id}")
async def delete_song(song_id: str, request: Request):
    require_admin(request)
    library_path(song_id).unlink()
    log_event("deleted", "", "Admin", Path(song_id).stem)
    for room in rooms.values():
        changed = False
        for i in reversed(range(len(room.queue))):
            if room.queue[i].get("song") == song_id:
                room.remove(i)
                changed = True
        if changed:
            await room.broadcast_state()
    await broadcast_all({"type": "library"})
    return {"ok": True}


def read_file(path: Path, start: int, length: int):
    with path.open("rb") as f:
        f.seek(start)
        while length > 0:
            chunk = f.read(min(256 * 1024, length))
            if not chunk:
                break
            length -= len(chunk)
            yield chunk


@app.get("/media/{song_id}")
async def media(song_id: str, request: Request):
    """Serve a song with HTTP Range support. Browsers need it to seek; older Starlette versions lack it."""
    path = library_path(song_id)
    size = path.stat().st_size
    media_type = AUDIO_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    headers = {"Accept-Ranges": "bytes"}
    m = RANGE.fullmatch(request.headers.get("range", "").strip())
    if not m or not (m[1] or m[2]):
        headers["Content-Length"] = str(size)
        return StreamingResponse(read_file(path, 0, size), media_type=media_type, headers=headers)
    if m[1]:
        start, end = int(m[1]), min(int(m[2]) if m[2] else size - 1, size - 1)
    else:  # "bytes=-500": the last 500 bytes
        start, end = max(0, size - int(m[2])), size - 1
    if start > end:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    headers["Content-Length"] = str(end - start + 1)
    return StreamingResponse(read_file(path, start, end - start + 1), status_code=206,
                             media_type=media_type, headers=headers)


# ---------- YouTube ----------

def fetch_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=8) as resp:
        return json.load(resp)


@app.get("/api/config")
async def config():
    return {"youtubeSearch": bool(YOUTUBE_API_KEY)}


@app.get("/api/youtube/info")
async def youtube_info(url: str):
    """Turn a pasted YouTube link (or bare video id) into {videoId, title, channel, thumb}."""
    url = url.strip()
    match = VIDEO_URL.search(url)
    video_id = match.group(1) if match else url if VIDEO_ID.match(url) else None
    if not video_id:
        raise HTTPException(400, "That doesn't look like a YouTube link")
    watch_url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        info = await asyncio.to_thread(
            fetch_json, "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(watch_url)
        )
    except urllib.error.HTTPError:
        raise HTTPException(404, "Video not found, private, or not allowed to be embedded")
    except Exception:
        raise HTTPException(502, "Couldn't reach YouTube")
    return {
        "videoId": video_id,
        "title": info.get("title", watch_url),
        "channel": info.get("author_name", ""),
        "thumb": f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg",
    }


@app.get("/api/youtube/search")
async def youtube_search(q: str):
    if not YOUTUBE_API_KEY:
        raise HTTPException(503, "Search is not set up. Add a YOUTUBE_API_KEY (see README), or paste a link instead.")
    params = urllib.parse.urlencode({
        "part": "snippet", "type": "video", "videoEmbeddable": "true",
        "maxResults": 15, "q": q[:200], "key": YOUTUBE_API_KEY,
    })
    try:
        data = await asyncio.to_thread(fetch_json, f"https://www.googleapis.com/youtube/v3/search?{params}")
    except urllib.error.HTTPError as e:
        detail = "YouTube search failed"
        if e.code == 403:
            detail = "YouTube search quota used up for today, or the API key is invalid"
        raise HTTPException(502, detail)
    except Exception:
        raise HTTPException(502, "Couldn't reach YouTube")
    return [
        {
            "videoId": item["id"]["videoId"],
            "title": html.unescape(item["snippet"]["title"]),
            "channel": html.unescape(item["snippet"]["channelTitle"]),
            "thumb": item["snippet"]["thumbnails"]["medium"]["url"],
        }
        for item in data.get("items", [])
        if item.get("id", {}).get("videoId")
    ]


class YoutubeDownload(BaseModel):
    videoId: str
    name: str = ""


download_slots = asyncio.Semaphore(2)  # downloads are slow and heavy; run at most two at once


def download_audio(video_id: str) -> tuple[str, bool, str]:
    """Download a video's audio track into the library. Returns (song id, was it a duplicate, title)."""
    workdir = LIBRARY / f".download-{uuid.uuid4().hex}"
    workdir.mkdir()
    too_long = lambda info, *_: (  # noqa: E731
        "too long" if (info.get("duration") or 0) > MAX_DOWNLOAD_SECONDS or info.get("is_live") else None
    )
    options = {
        # Audio only, in a format browsers play without converting (no ffmpeg needed).
        "format": "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
        "outtmpl": str(workdir / "audio.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "max_filesize": MAX_UPLOAD_BYTES,
        "match_filter": too_long,
    }
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)
        if not info or (info.get("duration") or 0) > MAX_DOWNLOAD_SECONDS or info.get("is_live"):
            raise HTTPException(400, "Live streams and videos over 3 hours can't be downloaded")
        files = [p for p in workdir.iterdir() if p.suffix.lower() in AUDIO_EXTS]
        if not files:
            raise HTTPException(502, "Couldn't get the audio for that video (it may be over 200 MB)")
        title = info.get("title") or video_id
        song_id, duplicate = store_in_library(files[0], safe_filename(title + files[0].suffix.lower()))
        return song_id, duplicate, title
    except yt_dlp.utils.DownloadError as e:
        reason = re.sub(r"^ERROR:\s*(\[[^\]]*\]\s*)*", "", str(e)).splitlines()[0][:200]
        raise HTTPException(502, f"YouTube refused the download: {reason}")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


@app.post("/api/youtube/download")
async def youtube_download(body: YoutubeDownload, request: Request):
    """Save a YouTube video's audio in the common library, so it plays like an uploaded song."""
    if yt_dlp is None:
        raise HTTPException(501, "Downloading needs yt-dlp. Run: pip install yt-dlp, then restart the server")
    if not VIDEO_ID.match(body.videoId):
        raise HTTPException(400, "That isn't a YouTube video id")
    uploader = "Admin" if is_admin(request) else (body.name.strip()[:40] or "Guest")
    async with download_slots:
        song_id, duplicate, title = await asyncio.to_thread(download_audio, body.videoId)
    if not duplicate:
        log_event("uploaded", "", uploader, f"{Path(song_id).stem} (from YouTube)")
        await broadcast_all({"type": "library"})
    return {"id": song_id, "title": Path(song_id).stem, "duplicate": duplicate}


# ---------- Real-time room sync ----------

@app.websocket("/ws/{code}")
async def room_socket(ws: WebSocket, code: str):
    code = code.upper()
    if not ROOM_CODE.match(code):
        await ws.close(code=4000)
        return
    await ws.accept()
    room = rooms.get(code) or rooms.setdefault(code, Room(code))

    name, sid, left_on_purpose = "Guest", "", False
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            kind = msg.get("type")

            if kind == "ping":  # clock sync
                await ws.send_text(json.dumps({"type": "pong", "t0": msg.get("t0"), "server": now()}))
                continue

            if kind == "join":
                name = str(msg.get("name") or "Guest").strip()[:40] or "Guest"
                sid = str(msg.get("sid") or uuid.uuid4().hex)[:64]
                pending = room.pending_leaves.pop(sid, None)
                if pending:
                    pending.cancel()  # reconnected (refresh, network blip): not a new visit
                elif not room.is_connected(sid):
                    log_event("joined", code, name)
                room.clients[ws] = {"name": name, "sid": sid}
                await room.broadcast_state()
                continue

            if ws not in room.clients:
                continue  # must join first

            if kind == "leave":
                left_on_purpose = True
                break
            elif kind == "add":
                entries = []
                for song_id in msg.get("songs", [])[:500]:
                    try:
                        path = library_path(str(song_id))
                    except HTTPException:
                        continue
                    entries.append({
                        "id": uuid.uuid4().hex, "kind": "file", "song": path.name, "title": path.stem, "by": name,
                    })
                room.enqueue(entries, play_now=bool(msg.get("playNow")))
                for e in entries:
                    log_event("played" if msg.get("playNow") else "queued", code, name, e["title"])
            elif kind == "add_youtube":
                video_id = str(msg.get("videoId", ""))
                if not VIDEO_ID.match(video_id):
                    continue
                title = str(msg.get("title") or "YouTube video")[:200]
                room.enqueue([{
                    "id": uuid.uuid4().hex, "kind": "youtube", "videoId": video_id, "title": title, "by": name,
                }], play_now=bool(msg.get("playNow")))
                log_event("played" if msg.get("playNow") else "queued", code, name, f"{title} (YouTube)")
            elif kind == "play":
                room.set_playback(playing=True)
            elif kind == "pause":
                room.set_playback(playing=False)
            elif kind == "seek":
                room.set_playback(position=float(msg.get("position", 0)))
            elif kind == "select":
                room.go_to(int(msg.get("index", -1)))
            elif kind == "next" and room.current is not None:
                room.go_to(room.current + 1)
            elif kind == "prev" and room.current is not None:
                if room.position_now() > 3:
                    room.set_playback(position=0.0)
                else:
                    room.go_to(max(0, room.current - 1))
            elif kind == "ended":
                # Every listener reports the end; only advance once per queue entry.
                cur = room.queue[room.current] if room.current is not None else None
                if not cur or cur["id"] != msg.get("trackId"):
                    continue
                if room.current + 1 < len(room.queue):
                    room.go_to(room.current + 1)
                else:
                    room.set_playback(playing=False, position=0.0)
            elif kind == "remove":
                room.remove(int(msg.get("index", -1)))
            elif kind == "clear":
                room.queue, room.current = [], None
                room.set_playback(playing=False, position=0.0)
            elif kind == "chat":
                text = str(msg.get("text", "")).strip()[:500]
                if text:
                    await room.broadcast({"type": "chat", "name": name, "text": text})
                continue
            else:
                continue

            await room.broadcast_state()
    except (WebSocketDisconnect, json.JSONDecodeError, ValueError, TypeError):
        pass
    finally:
        if room.clients.pop(ws, None) is not None:
            if not room.is_connected(sid):  # their last tab in this room
                if left_on_purpose:
                    log_event("left", code, name)
                elif sid not in room.pending_leaves:
                    room.pending_leaves[sid] = asyncio.create_task(log_leave_later(room, sid, name))
            await room.broadcast_state()
        if left_on_purpose:
            try:
                await ws.close()
            except Exception:
                pass  # the browser already closed it
        if not room.clients and not room.queue and not room.pending_leaves and rooms.get(code) is room:
            rooms.pop(code, None)


@app.get("/admin")
async def admin_page():
    return FileResponse(BASE / "static" / "admin.html")


app.mount("/", StaticFiles(directory=BASE / "static", html=True), name="static")
