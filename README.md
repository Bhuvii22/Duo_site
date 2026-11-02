# Duo — listen together, in sync

Several people open the same room link and hear the same song at the same moment, wherever they are.
Anyone in the room can play, pause, seek, skip, add songs and chat.

## Run it

```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\uvicorn server:app --host 0.0.0.0 --port 8000
```

Always start the server with the `.venv` Python as shown above, so it uses the package versions in `requirements.txt`.

Open http://localhost:8000, enter your name, and join. Leave the room code empty to create a new room.
Then click **Copy invite link** and send it to your friend.

## Controls

- ⏮ / ⏭ change song. **−10s / +10s** skip within the song, or drag the seek bar.
- Keyboard: **← / →** skip 10 seconds, **Space** plays / pauses.
- **▶ Play** next to a library song or YouTube result plays it right away for everyone, right after the current song in the queue.
  **+ Queue** adds it to the end.
- Someone joining while a song is playing hears it from the same moment, after a short "Loading the song…" step.
  On a slow connection the first load can take a few seconds.

## Staying in a room

Your name and room are remembered in the browser, so refreshing or reopening the page puts you straight back in the room.
Click **Leave room** to log out of it.

## Admin page

Open http://localhost:8000/admin.

- **Password:** set `$env:ADMIN_PASSWORD = "..."` before starting the server. If you don't,
  a random password is created the first time the server starts and saved in `admin_password.txt`.
- **Live rooms:** who is in each room right now, and what's playing.
- **History:** who joined or left which room and when, songs added to queues, and library uploads and deletions.
  You can filter by room, name or activity. It's stored in `duo.db` and is never shown inside rooms.
  A refresh or short network drop isn't counted as leaving. If someone closes the tab, "left" is recorded
  after 60 seconds.
- **Common library:** upload songs, folders or zips for everyone, and delete songs. Only the admin can delete.

## Adding songs

- **Library (your own files):** click **Upload files** or **Upload folder**. Zip files are unpacked automatically.
  Songs are saved for good, so you only upload them once.
- **YouTube, by link:** paste any YouTube link (watch, youtu.be, Shorts) into **Add from YouTube**. This works without any setup.
- **YouTube, by search:** type a song name to search. This needs a free YouTube Data API key:
  1. Go to https://console.cloud.google.com/, create a project, then go to **APIs & Services → Library**.
     Enable **YouTube Data API v3**.
  2. Go to **APIs & Services → Credentials → Create credentials → API key**, and copy the key.
  3. Start the server with the key:
     ```powershell
     $env:YOUTUBE_API_KEY = "your-key-here"
     .venv\Scripts\uvicorn server:app --host 0.0.0.0 --port 8000
     ```
  The free quota allows about 100 searches a day. Pasting links doesn't count against it.
- **YouTube, save to library:** paste a link and click the **download** button next to **Go**,
  or click **↓** next to a search result. The song's audio is saved in the common library, so it plays
  like an uploaded song from then on. This uses `yt-dlp` (in `requirements.txt`) and doesn't need ffmpeg.
  Live streams and videos over 3 hours are refused. If downloads start failing, update it with `pip install -U yt-dlp`.

## Listening with someone in another place

Your friend needs to reach your server over the internet. You can do that in two ways:

- **Quick tunnel (no deployment):** run `cloudflared tunnel --url http://localhost:8000`
  (or `ngrok http 8000`) and share the `https://…` URL it prints.
- **Deploy it:** any host that runs Python and supports WebSockets will work, such as Render, Railway, Fly.io or a VPS.
  Start command: `uvicorn server:app --host 0.0.0.0 --port $PORT`

## How the sync works

- The server holds each room's playback state as `{playing, position, updatedAt}` in server time.
- Each browser estimates how far its clock is from the server's, using ping/pong round trips
  and keeping the sample with the lowest latency.
- Every 500 ms each client works out where the song *should* be and corrects itself.
  A small drift is fixed by playing slightly faster or slower (±5%), so you don't hear a skip.
  A drift over 0.4 s is fixed by jumping straight to the right position.
  YouTube videos can't change speed smoothly, so they are only corrected by jumping, once the drift is over 0.35 s.
- When a song ends, every client reports it. The server moves to the next song only once.

## Notes and limits

- **Library:** songs are saved permanently in the `library/` folder. You can also copy music files straight into it yourself.
  Supported formats: mp3, m4a, aac, ogg, opus, wav, flac, webm, up to 200 MB per song. Re-uploading the same file is skipped.
- **Zip files:** up to 2 GB each. Songs in any sub-folder are found, and other files (images, text, macOS `__MACOSX`) are ignored.
  Password-protected zips are not supported.
- **YouTube:** videos play in YouTube's own embedded player, which must stay visible. Some videos block embedding
  and are skipped automatically. Ads, if YouTube shows them, can throw one person briefly out of sync.
- Rooms and their queues are kept in memory, so restarting the server clears the queues. The library is kept.
- On free hosting plans the disk is often wiped on every restart. To keep the library and history there,
  use a persistent disk or volume, and set `DUO_DATA_DIR` to point at it.
- Room users have no accounts: anyone who has the room link can control playback and add songs to the library.
- Only upload music you have the right to share.
