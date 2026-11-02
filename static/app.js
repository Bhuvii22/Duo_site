// Duo client: keeps a local <audio> element in lock-step with the room's shared playback state.
//
// The server stores playback as {playing, position, updatedAt} in *server* time.
// Each client estimates its clock offset to the server (NTP-style pings), so every
// listener can compute the same "where should we be right now" position and
// nudge its audio towards it.

const $ = (id) => document.getElementById(id);
const audio = $("audio");

let ws = null;
let me = "";
let roomCode = "";
let sid = "";               // this visit's id, so a refresh isn't logged as leave + join
let leaving = false;        // user clicked "Leave room": don't reconnect
let state = null;           // last state from the server
let loadedId = null;        // track id currently loaded into <audio>
let endedSentFor = null;    // avoid reporting the same track end twice
let autoplayBlocked = false;
let seeking = false;        // user is dragging the seek bar

// ---------- Clock sync ----------
let clockOffset = 0;        // serverTime - localTime, in seconds
let clockSamples = [];

const localNow = () => performance.timeOrigin / 1000 + performance.now() / 1000;
const serverNow = () => localNow() + clockOffset;

function sendPing() {
  send({ type: "ping", t0: localNow() });
}

function onPong({ t0, server }) {
  const t1 = localNow();
  const rtt = t1 - t0;
  clockSamples.push({ rtt, offset: server - (t0 + t1) / 2 });
  clockSamples = clockSamples.slice(-10);
  // The sample with the lowest round-trip time is the most trustworthy.
  const best = clockSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  clockOffset = best.offset;
  $("sync").textContent = `Synced · latency ${Math.round(best.rtt * 500)} ms`;
}

// ---------- Connection ----------
function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/${roomCode}`);

  ws.onopen = () => {
    setConn(true);
    send({ type: "join", name: me, sid });
    clockSamples = [];
    for (let i = 0; i < 6; i++) setTimeout(sendPing, i * 150);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "pong") onPong(msg);
    else if (msg.type === "state") onState(msg);
    else if (msg.type === "chat") addChat(msg.name, msg.text);
    else if (msg.type === "library") loadLibrary();
  };
  ws.onclose = () => {
    if (leaving) return;
    setConn(false);
    setTimeout(connect, 1500);
  };
}

function setConn(ok) {
  $("conn").textContent = ok ? "live" : "reconnecting…";
  $("conn").classList.toggle("ok", ok);
}

setInterval(sendPing, 10000);

// ---------- Players ----------
// Two interchangeable backends: <audio> for library songs, YouTube's embedded player for videos.
let playRequestedAt = 0;    // when we first wanted the player to start (to detect blocked autoplay)
let lastPlayAttempt = 0;

const filePlayer = {
  canNudge: true,           // supports tiny speed changes for smooth drift correction
  jumpAt: 0.4,              // seconds of drift before we hard-seek
  lead: 0,                  // learned: how far ahead to aim a jump, to cover the time it takes to load
  canLoad: () => true,
  load(track, startAt) {
    // "#t=" makes the browser download from that point instead of from the start of the file.
    const from = startAt > 1 ? `#t=${startAt.toFixed(1)}` : "";
    audio.src = `/media/${encodeURIComponent(track.song)}${from}`;
  },
  unload() { audio.pause(); audio.removeAttribute("src"); audio.load(); },
  isLoaded: () => !!audio.getAttribute("src"),
  hasMedia: () => audio.readyState >= 1,
  ready: () => audio.readyState >= 1 && !audio.seeking,
  time: () => audio.currentTime,
  duration: () => audio.duration,
  paused: () => audio.paused,
  buffering: () => audio.readyState < 3, // HAVE_FUTURE_DATA: enough to keep playing
  ended: () => audio.ended,
  play() {
    audio.play().catch((err) => { if (err.name === "NotAllowedError") showUnlock(); });
  },
  pause: () => audio.pause(),
  seek: (t) => { audio.currentTime = t; },
  setRate: (r) => { audio.playbackRate = r; },
};

let yt = null;
let ytReady = false;
let ytLoaded = false;
let ytCued = false;         // the player has confirmed the new video (until then its state is stale)
let ytCmdAt = 0;            // when we last controlled the YouTube player ourselves
const ytCmd = () => { ytCmdAt = performance.now(); };

const ytPlayer = {
  canNudge: false,          // YouTube only has coarse speed steps, so we only hard-seek
  jumpAt: 0.35,
  lead: 0,
  canLoad: () => ytReady,
  load(track, startAt) {
    ytCmd();
    ytCued = false;
    yt.cueVideoById(track.videoId, startAt > 1 ? startAt : 0);
    ytLoaded = true;
  },
  unload() { ytCmd(); yt.stopVideo(); ytLoaded = false; },
  isLoaded: () => ytLoaded,
  hasMedia: () => ytReady && ytLoaded && ytCued,
  ready: () => ytReady && ytLoaded && ytCued && yt.getPlayerState() !== YT.PlayerState.BUFFERING,
  // The YouTube script loads after the page, so yt can still be null here.
  time: () => (ytReady && yt.getCurrentTime()) || 0,
  duration: () => (ytReady && yt.getDuration()) || NaN,
  paused: () => ![YT.PlayerState.PLAYING, YT.PlayerState.BUFFERING].includes(yt.getPlayerState()),
  buffering: () => yt.getPlayerState() === YT.PlayerState.BUFFERING,
  ended: () => yt.getPlayerState() === YT.PlayerState.ENDED,
  play() { ytCmd(); yt.playVideo(); },
  pause() { ytCmd(); yt.pauseVideo(); },
  seek(t) { ytCmd(); yt.seekTo(t, true); },
  setRate() {},
};

// Called by the YouTube IFrame API script once it has loaded.
window.onYouTubeIframeAPIReady = () => {
  yt = new YT.Player("yt", {
    playerVars: { controls: 0, disablekb: 1, playsinline: 1, rel: 0 },
    events: {
      onReady: () => {
        ytReady = true;
        yt.setVolume(+$("volume").value * 100);
        sync();
      },
      onStateChange: onYtState,
      onError: () => {
        $("sync").textContent = "This video can't be played here. Skipping…";
        reportEnded();
      },
    },
  });
};

function onYtState(e) {
  const S = YT.PlayerState;
  if (!ytLoaded) return;
  if (e.data === S.CUED || e.data === S.PLAYING) ytCued = true;
  if (!ytCued) return; // still reporting on the previous video
  if (e.data === S.ENDED) reportEnded();
  if (e.data === S.PLAYING && autoplayBlocked) hideUnlock();
  // Someone paused by clicking the video itself: share that with the room.
  // (A video that starts on its own while the room is paused is just paused again by sync.)
  const ours = performance.now() - ytCmdAt < 1500;
  if (!ours && e.data === S.PAUSED && state?.playing && currentTrack()?.kind === "youtube") {
    send({ type: "pause" });
  }
  sync();
}

const playerFor = (track) => (track && track.kind === "youtube" ? ytPlayer : filePlayer);

// ---------- Playback sync ----------
const currentTrack = () =>
  state && state.current != null ? state.queue[state.current] : null;

function expectedPosition() {
  if (!state) return 0;
  let pos = state.position + (state.playing ? serverNow() - state.updatedAt : 0);
  const dur = currentTrack() ? playerFor(currentTrack()).duration() : NaN;
  if (dur > 0) pos = Math.min(pos, dur);
  return Math.max(0, pos);
}

function onState(s) {
  state = s;
  playRequestedAt = 0;
  renderQueue();
  renderMembers();
  sync();
}

function sync() {
  const track = currentTrack();
  const player = track ? playerFor(track) : null;

  // Stop whichever backend is not in use, and show the video only for YouTube.
  if (player !== filePlayer && filePlayer.isLoaded()) filePlayer.unload();
  if (player !== ytPlayer && ytPlayer.isLoaded()) ytPlayer.unload();
  $("video-wrap").classList.toggle("hidden", player !== ytPlayer);
  $("layout").classList.toggle("has-video", player === ytPlayer);

  if (!track) {
    loadedId = null;
    renderNowPlaying();
    return;
  }

  if (loadedId !== track.id) {
    if (!player.canLoad()) return; // YouTube script still loading
    loadedId = track.id;
    endedSentFor = null;
    playRequestedAt = 0;
    jumpedTo = null;
    // Joining mid-song: start loading where the room is now, not at 0:00.
    const startAt = state.position + (state.playing ? serverNow() - state.updatedAt : 0);
    player.load(track, startAt + (state.playing ? player.lead : 0));
    setLoading(state.playing);
    renderNowPlaying();
    return; // continue once the media is ready
  }
  if (!player.ready()) return;

  const target = expectedPosition();

  if (!state.playing) {
    setLoading(false);
    if (!player.paused()) player.pause();
    player.setRate(1);
    if (Math.abs(player.time() - target) > 0.25) player.seek(target);
    renderNowPlaying();
    return;
  }

  // Reached the end: tell the server once, it moves everyone to the next song.
  const dur = player.duration();
  if (player.ended() || (dur > 0 && target >= dur - 0.05)) {
    reportEnded();
    return;
  }

  if (player.paused()) {
    // Players can ignore a play() sent while still loading, so keep retrying.
    const t = performance.now();
    if (!playRequestedAt) playRequestedAt = t;
    if (t - lastPlayAttempt > 1500) {
      lastPlayAttempt = t;
      if (Math.abs(player.time() - target) > player.jumpAt) jump(player, target);
      player.play();
    }
    if (t - playRequestedAt > 4000 && !autoplayBlocked) showUnlock(); // browser blocks autoplay
    setLoading(!autoplayBlocked);
    renderNowPlaying();
    return;
  }
  playRequestedAt = 0;
  if (autoplayBlocked) hideUnlock();
  // Still downloading: wait for it. Seeking now would restart the download and never catch up.
  if (player.buffering()) {
    setLoading(true);
    renderNowPlaying();
    return;
  }
  setLoading(false);

  if (jumpedTo != null) {
    // A jump just finished loading. If we landed behind, aim further ahead next time.
    const behind = target - player.time();
    player.lead = Math.min(8, Math.max(0, player.lead + behind));
    jumpedTo = null;
  }

  const drift = player.time() - target; // + means we're ahead
  if (Math.abs(drift) > player.jumpAt) {
    jump(player, target); // too far off: jump
    player.setRate(1);
  } else if (player.canNudge && Math.abs(drift) > 0.03) {
    // small drift: gently speed up / slow down so there is no audible skip
    player.setRate(Math.min(1.05, Math.max(0.95, 1 - drift)));
  } else {
    player.setRate(1);
  }
  renderNowPlaying();
}

// On a slow connection the new spot takes a moment to load, and the song moves on meanwhile.
// So aim ahead by the delay measured last time (player.lead) to land in sync instead of behind.
let jumpedTo = null;

function jump(player, target) {
  const dur = player.duration();
  let to = target + player.lead;
  if (dur > 0) to = Math.min(to, dur - 0.5);
  player.seek(to);
  jumpedTo = to;
}

function setLoading(on) {
  $("loading").classList.toggle("hidden", !on);
}

function reportEnded() {
  const track = currentTrack();
  if (track && endedSentFor !== track.id) {
    endedSentFor = track.id;
    send({ type: "ended", trackId: track.id });
  }
}

audio.addEventListener("loadedmetadata", sync);
audio.addEventListener("canplay", sync);
audio.addEventListener("ended", reportEnded);
audio.addEventListener("error", () => {
  if (!audio.getAttribute("src")) return;
  const reason = audio.error && audio.error.code === 4 ? "this browser can't play this file format" : "the file couldn't be loaded";
  $("sync").textContent = `Can't play this song: ${reason}.`;
});
setInterval(sync, 500);

// ---------- Rendering ----------
const fmt = (s) => {
  if (!isFinite(s)) return "0:00";
  s = Math.floor(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function renderNowPlaying() {
  const track = currentTrack();
  $("title").textContent = track ? track.title : "Nothing playing";
  $("by").textContent = track ? `Added by ${track.by}` : "Pick a song to start";
  const thumb = track && track.kind === "youtube" ? `url("https://i.ytimg.com/vi/${track.videoId}/default.jpg")` : "";
  $("art").style.backgroundImage = thumb;
  $("art").classList.toggle("has-thumb", !!thumb);
  const playing = !!(state && state.playing && track);
  $("toggle").classList.toggle("is-playing", playing);
  $("toggle").setAttribute("aria-label", playing ? "Pause" : "Play");
  document.title = track ? `${playing ? "▶ " : ""}${track.title} · Duo` : "Duo";
}

function tick() {
  requestAnimationFrame(tick); // schedule first, so one error can't freeze the clock for good
  const track = currentTrack();
  const player = track ? playerFor(track) : null;
  const live = player && loadedId === track.id && player.hasMedia();
  const dur = live ? player.duration() : NaN;
  const pos = live ? player.time() : expectedPosition();
  $("dur").textContent = fmt(dur);
  if (!seeking) {
    $("seek").max = isFinite(dur) ? dur : 0;
    $("seek").value = pos;
    $("cur").textContent = fmt(pos);
  }
}
requestAnimationFrame(tick);

function renderQueue() {
  const ol = $("queue");
  ol.innerHTML = "";
  state.queue.forEach((t, i) => {
    const li = document.createElement("li");
    const isCurrent = i === state.current;
    if (isCurrent) li.classList.add("active");
    li.title = isCurrent ? "Playing now" : "Play this song";

    const num = document.createElement("span");
    num.className = "num";
    num.textContent = isCurrent ? "♪" : i + 1;

    const tag = t.kind === "youtube" ? Object.assign(document.createElement("span"), { className: "tag", textContent: "YT" }) : null;
    const main = songText(t.title, `Added by ${t.by}`, tag);

    const rm = rowButton("✕", "remove", "Remove from queue", () => send({ type: "remove", index: i }));

    li.onclick = () => {
      unlockAudio();
      send({ type: "select", index: i });
    };
    li.append(num, main, rm);
    ol.append(li);
  });
  $("queue-count").textContent = state.queue.length || "";
}

// Title + second line, as used by every song list.
function songText(titleText, subText, prefix = null) {
  const main = document.createElement("div");
  main.className = "q-main";
  const title = document.createElement("div");
  title.className = "q-title";
  title.textContent = titleText;
  title.title = titleText;
  if (prefix) title.prepend(prefix);
  const sub = document.createElement("div");
  sub.className = "q-by";
  sub.textContent = subText;
  main.append(title, sub);
  return main;
}

// Small round button inside a song row; clicks don't also trigger the row.
function rowButton(label, className, title, onClick) {
  const btn = document.createElement("button");
  btn.className = `row-btn ${className}`;
  btn.textContent = label;
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.onclick = (e) => {
    e.stopPropagation();
    onClick(btn);
  };
  return btn;
}

function renderMembers() {
  const ul = $("members");
  ul.innerHTML = "";
  for (const name of state.members) {
    const li = document.createElement("li");
    li.textContent = name === me ? `${name} (you)` : name;
    ul.append(li);
  }
  $("count").textContent = state.members.length;
}

function addChat(name, text) {
  const box = $("chat");
  const div = document.createElement("div");
  const b = document.createElement("b");
  b.textContent = `${name}: `;
  div.append(b, document.createTextNode(text));
  box.append(div);
  box.scrollTop = box.scrollHeight;
  // On phones the chat may be on another tab: show how many messages are waiting.
  if (getComputedStyle($("panel-chat")).display === "none") {
    const badge = $("chat-unread");
    badge.textContent = (+badge.textContent || 0) + 1;
    badge.classList.remove("hidden");
  }
}

// ---------- Tabs ----------
// Phones: Music / Up next / Chat show one panel at a time.
for (const btn of document.querySelectorAll("#tabs button")) {
  btn.onclick = () => {
    $("layout").dataset.active = btn.dataset.panel;
    for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("active", b === btn);
    if (btn.dataset.panel === "chat") {
      $("chat-unread").textContent = "";
      $("chat-unread").classList.add("hidden");
      $("chat").scrollTop = $("chat").scrollHeight;
    }
  };
}

// Music panel: Library / YouTube.
function showMusicView(view) {
  $("view-library").classList.toggle("hidden", view !== "library");
  $("view-youtube").classList.toggle("hidden", view !== "youtube");
  $("tab-library").classList.toggle("active", view === "library");
  $("tab-youtube").classList.toggle("active", view === "youtube");
}
$("tab-library").onclick = () => showMusicView("library");
$("tab-youtube").onclick = () => {
  showMusicView("youtube");
  $("yt-input").focus();
};

// ---------- Controls ----------
// Browsers only allow audio to start after a user gesture; any click on a control counts.
function showUnlock() {
  autoplayBlocked = true;
  $("unlock").classList.remove("hidden");
}

function hideUnlock() {
  autoplayBlocked = false;
  playRequestedAt = 0;
  $("unlock").classList.add("hidden");
}

function unlockAudio() {
  if (!autoplayBlocked) return;
  hideUnlock();
  const track = currentTrack();
  if (track && state.playing && loadedId === track.id) playerFor(track).play();
}

$("unlock").onclick = () => {
  unlockAudio();
  sync();
};

$("toggle").onclick = () => {
  unlockAudio();
  if (!currentTrack()) return;
  send({ type: state.playing ? "pause" : "play" });
};
$("next").onclick = () => { unlockAudio(); send({ type: "next" }); };
$("prev").onclick = () => { unlockAudio(); send({ type: "prev" }); };

function skipBy(seconds) {
  const track = currentTrack();
  if (!track) return;
  unlockAudio();
  const dur = playerFor(track).duration();
  let to = Math.max(0, expectedPosition() + seconds);
  if (dur > 0) to = Math.min(to, dur - 1);
  send({ type: "seek", position: to });
  // Visible confirmation, and move the clock right away instead of waiting for the server.
  seeking = false;
  $("cur").textContent = fmt(to);
  const flash = $("skip-flash");
  flash.textContent = seconds > 0 ? `+${seconds}s` : `−${-seconds}s`;
  flash.classList.add("show");
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => flash.classList.remove("show"), 700);
}
$("back10").onclick = () => skipBy(-10);
$("fwd10").onclick = () => skipBy(10);

// Keyboard: ← / → skip 10 seconds, Space plays / pauses (but not while typing).
document.addEventListener("keydown", (e) => {
  if ($("app").classList.contains("hidden") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest("input, textarea, select, button")) return;
  if (e.key === "ArrowLeft") skipBy(-10);
  else if (e.key === "ArrowRight") skipBy(10);
  else if (e.key === " ") $("toggle").click();
  else return;
  e.preventDefault();
});

$("seek").addEventListener("input", () => {
  seeking = true;
  $("cur").textContent = fmt(+$("seek").value);
});
$("seek").addEventListener("change", () => {
  seeking = false;
  send({ type: "seek", position: +$("seek").value });
});
// Letting go without changing the value fires no "change": don't leave the clock frozen.
for (const ev of ["pointerup", "pointercancel", "blur"]) {
  $("seek").addEventListener(ev, () => setTimeout(() => { seeking = false; }, 0));
}

$("volume").addEventListener("input", () => {
  audio.volume = +$("volume").value;
  if (ytReady) yt.setVolume(+$("volume").value * 100);
});

$("copy-link").onclick = async () => {
  const link = `${location.origin}/?room=${roomCode}`;
  try {
    await navigator.clipboard.writeText(link);
    $("copy-link").textContent = "Copied!";
  } catch {
    prompt("Share this link:", link);
  }
  setTimeout(() => ($("copy-link").textContent = "Copy invite link"), 1500);
};

$("chat-form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("chat-input").value.trim();
  if (text) send({ type: "chat", text });
  $("chat-input").value = "";
};

$("clear-queue").onclick = () => {
  if (state && state.queue.length && confirm("Clear the whole queue?")) send({ type: "clear" });
};

// ---------- Library ----------
let library = [];

async function loadLibrary() {
  try {
    library = await (await fetch("/api/library")).json();
  } catch {
    return;
  }
  $("lib-count").textContent = library.length;
  renderLibrary();
}

function visibleLibrary() {
  const q = $("lib-search").value.trim().toLowerCase();
  return q ? library.filter((s) => s.title.toLowerCase().includes(q)) : library;
}

function renderLibrary() {
  const ul = $("library");
  ul.innerHTML = "";
  for (const song of visibleLibrary()) {
    const li = document.createElement("li");
    li.append(
      songText(song.title, `${(song.size / 1048576).toFixed(1)} MB`),
      playNowButton(() => send({ type: "add", songs: [song.id], playNow: true })),
      queueButton(() => send({ type: "add", songs: [song.id] })),
    );
    ul.append(li);
  }
}

$("lib-search").addEventListener("input", renderLibrary);
$("add-all").onclick = () => {
  const songs = visibleLibrary().map((s) => s.id);
  if (songs.length) send({ type: "add", songs });
};

// ---------- YouTube search / paste ----------
let ytSearchEnabled = false;
fetch("/api/config")
  .then((r) => r.json())
  .then((c) => {
    ytSearchEnabled = c.youtubeSearch;
    if (!ytSearchEnabled) $("yt-input").placeholder = "Paste a YouTube link…";
  })
  .catch(() => {});

async function getJson(url) {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || r.statusText);
  return body;
}

function addYoutube(video, playNow = false) {
  send({ type: "add_youtube", videoId: video.videoId, title: video.title, playNow });
}

// ▶ next to a song: plays it straight away, slotted in right after the current song.
function playNowButton(onPlay) {
  return rowButton("▶", "play-now", "Play now for everyone", () => {
    unlockAudio();
    onPlay();
  });
}

// + next to a song: adds it to the end of the queue, with a brief ✓.
function queueButton(onAdd) {
  return rowButton("+", "add", "Add to queue", (btn) => {
    onAdd();
    btn.textContent = "✓";
    btn.classList.add("added");
    setTimeout(() => {
      btn.textContent = "+";
      btn.classList.remove("added");
    }, 1500);
  });
}

$("yt-form").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("yt-input").value.trim();
  const status = $("yt-status");
  if (!q) return;
  $("yt-results").innerHTML = "";
  try {
    if (/youtu\.?be/i.test(q)) {
      status.textContent = "Adding…";
      const video = await getJson(`/api/youtube/info?url=${encodeURIComponent(q)}`);
      addYoutube(video);
      status.textContent = `Added "${video.title}" to the queue.`;
      $("yt-input").value = "";
    } else if (!ytSearchEnabled) {
      status.textContent = "Search isn't set up yet, so paste a YouTube link instead. (The README explains how to turn on search.)";
    } else {
      status.textContent = "Searching…";
      const results = await getJson(`/api/youtube/search?q=${encodeURIComponent(q)}`);
      status.textContent = results.length ? "" : "No results.";
      renderResults(results);
    }
  } catch (err) {
    status.textContent = err.message;
  }
};

// ---------- Download from YouTube into the library ----------
async function downloadToLibrary(video) {
  const status = $("yt-status");
  status.textContent = `Downloading "${video.title}" to the library… this can take a minute.`;
  const r = await fetch("/api/youtube/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId: video.videoId, name: me }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || r.statusText);
  status.textContent = body.duplicate
    ? `"${body.title}" is already in the library.`
    : `Saved "${body.title}" to the library.`;
  loadLibrary();
}

$("yt-download").onclick = async () => {
  const q = $("yt-input").value.trim();
  const status = $("yt-status");
  if (!/youtu\.?be/i.test(q)) {
    status.textContent = "Paste a YouTube link first, or use ↓ next to a search result.";
    return;
  }
  const btn = $("yt-download");
  btn.disabled = true;
  try {
    status.textContent = "Finding the video…";
    const video = await getJson(`/api/youtube/info?url=${encodeURIComponent(q)}`);
    await downloadToLibrary(video);
    $("yt-input").value = "";
  } catch (err) {
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};

// ↓ next to a search result: save its audio in the library.
function downloadButton(video) {
  return rowButton("↓", "download", "Download to library", async (btn) => {
    if (btn.classList.contains("busy")) return;
    btn.classList.add("busy");
    btn.textContent = "…";
    try {
      await downloadToLibrary(video);
      btn.textContent = "✓";
      btn.classList.add("added");
    } catch (err) {
      $("yt-status").textContent = err.message;
      btn.textContent = "↓";
    } finally {
      btn.classList.remove("busy");
    }
  });
}

function renderResults(results) {
  const ul = $("yt-results");
  ul.innerHTML = "";
  for (const video of results) {
    const li = document.createElement("li");

    const img = document.createElement("img");
    img.src = video.thumb;
    img.alt = "";
    img.loading = "lazy";

    li.append(
      img,
      songText(video.title, video.channel),
      playNowButton(() => addYoutube(video, true)),
      queueButton(() => addYoutube(video)),
      downloadButton(video),
    );
    ul.append(li);
  }
}

// ---------- Uploads ----------
setupUploads({
  inputs: [$("file"), $("folder")],
  status: $("upload-status"),
  uploaderName: () => me,
  onDone: loadLibrary,
});

// ---------- Join ----------
function newRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => chars[b % chars.length]).join("");
}

// You stay in your room (across refreshes and browser restarts) until you click "Leave room".
const SESSION_KEY = "duo-session";

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}

function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ name: me, room: roomCode, sid }));
    localStorage.setItem("duo-name", me);
  } catch {}
}

function enterRoom() {
  document.body.classList.add("in-room");
  history.replaceState(null, "", `/?room=${roomCode}`);
  $("room-code").textContent = roomCode;
  $("join").classList.add("hidden");
  $("app").classList.remove("hidden");
  connect();
  loadLibrary();
}

$("join-form").onsubmit = (e) => {
  e.preventDefault();
  me = $("name").value.trim() || "Guest";
  roomCode = ($("room").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || newRoomCode()).slice(0, 12);
  if (roomCode.length < 4) roomCode = roomCode.padEnd(4, "0");
  sid = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
  saveSession();
  // This click is a user gesture: prime the audio element so later play() calls are allowed.
  audio.play().catch(() => {});
  enterRoom();
};

$("leave").onclick = () => {
  if (!confirm("Leave this room?")) return;
  leaving = true;
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  send({ type: "leave" });
  // Give the server a moment to record it, then go back to the start screen.
  const done = () => { location.href = "/"; };
  if (ws) ws.onclose = done;
  setTimeout(done, 1000);
};

const params = new URLSearchParams(location.search);
const urlRoom = (params.get("room") || "").toUpperCase();
const saved = loadSession();
if (saved && saved.room && saved.sid && (!urlRoom || urlRoom === saved.room)) {
  ({ name: me, room: roomCode, sid } = saved);
  enterRoom(); // still in this room from last time
} else {
  $("room").value = urlRoom;
  try { $("name").value = (saved && saved.name) || localStorage.getItem("duo-name") || ""; } catch {}
}
