// Duo admin: room history, live rooms and the common library.

const $ = (id) => document.getElementById(id);

const EVENT_LABELS = {
  joined: "Joined room",
  left: "Left room",
  queued: "Added to queue",
  played: "Played now",
  uploaded: "Uploaded to library",
  deleted: "Deleted from library",
};

async function api(url, options = {}) {
  const r = await fetch(url, options);
  if (r.status === 401 && !url.endsWith("/login")) {
    showLogin();
    throw new Error("Please sign in again");
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || r.statusText);
  return body;
}

function cell(text, className) {
  const td = document.createElement("td");
  td.textContent = text ?? "";
  if (className) td.className = className;
  return td;
}

// ---------- Login ----------
let roomsTimer = null;

function showLogin() {
  clearInterval(roomsTimer);
  $("admin").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("password").focus();
}

function showAdmin() {
  $("login").classList.add("hidden");
  $("admin").classList.remove("hidden");
  loadRooms();
  loadHistory(true);
  loadLibrary();
  clearInterval(roomsTimer);
  roomsTimer = setInterval(loadRooms, 5000);
}

$("login-form").onsubmit = async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  try {
    await api("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("password").value }),
    });
    $("password").value = "";
    showAdmin();
  } catch (err) {
    $("login-error").textContent = err.message;
  }
};

$("logout").onclick = async () => {
  await api("/api/admin/logout", { method: "POST" }).catch(() => {});
  showLogin();
};

// ---------- Live rooms ----------
async function loadRooms() {
  let rooms;
  try { rooms = await api("/api/admin/rooms"); } catch { return; }
  const tbody = $("rooms");
  tbody.innerHTML = "";
  $("room-count").textContent = rooms.length;
  if (!rooms.length) {
    const tr = document.createElement("tr");
    const td = cell("No rooms are open right now.", "muted");
    td.colSpan = 4;
    tr.append(td);
    tbody.append(tr);
  }
  for (const r of rooms) {
    const tr = document.createElement("tr");
    const playing = r.nowPlaying ? `${r.playing ? "▶" : "⏸"} ${r.nowPlaying}` : "—";
    tr.append(
      cell(r.code, "mono"),
      cell(r.members.length ? r.members.join(", ") : "Nobody (queue kept)"),
      cell(playing),
      cell(r.queueLength),
    );
    tbody.append(tr);
  }
}

// ---------- History ----------
let oldestId = 0;
const PAGE = 100;

async function loadHistory(reset) {
  if (reset) {
    oldestId = 0;
    $("history").innerHTML = "";
  }
  const params = new URLSearchParams({
    room: $("f-room").value.trim(),
    user: $("f-user").value.trim(),
    event: $("f-event").value,
    limit: PAGE,
  });
  if (oldestId) params.set("before", oldestId);
  let rows;
  try { rows = await api(`/api/admin/history?${params}`); } catch { return; }

  const tbody = $("history");
  if (reset && !rows.length) {
    const tr = document.createElement("tr");
    const td = cell("No activity yet.", "muted");
    td.colSpan = 5;
    tr.append(td);
    tbody.append(tr);
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    const when = new Date(row.ts * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const label = document.createElement("span");
    label.className = `event ev-${row.event}`;
    label.textContent = EVENT_LABELS[row.event] || row.event;
    const eventCell = cell("");
    eventCell.append(label);
    tr.append(cell(when, "nowrap"), cell(row.room || "—", "mono"), cell(row.user), eventCell, cell(row.detail, "muted"));
    tbody.append(tr);
    oldestId = row.id;
  }
  $("more").classList.toggle("hidden", rows.length < PAGE);
}

$("filters").onsubmit = (e) => {
  e.preventDefault();
  loadHistory(true);
};
$("refresh-history").onclick = () => loadHistory(true);
$("more").onclick = () => loadHistory(false);

// ---------- Library ----------
let library = [];

async function loadLibrary() {
  try { library = await api("/api/library"); } catch { return; }
  $("lib-count").textContent = library.length;
  renderLibrary();
}

function renderLibrary() {
  const q = $("lib-search").value.trim().toLowerCase();
  const ul = $("library");
  ul.innerHTML = "";
  for (const song of library.filter((s) => s.title.toLowerCase().includes(q))) {
    const li = document.createElement("li");

    const main = document.createElement("div");
    main.className = "q-main";
    const title = document.createElement("div");
    title.className = "q-title";
    title.textContent = song.title;
    const info = document.createElement("div");
    info.className = "q-by";
    info.textContent = `${(song.size / 1048576).toFixed(1)} MB`;
    main.append(title, info);

    const del = document.createElement("button");
    del.className = "remove";
    del.textContent = "Delete";
    del.onclick = async () => {
      if (!confirm(`Delete "${song.title}" from the library? It will also be removed from every queue.`)) return;
      try {
        await api(`/api/library/${encodeURIComponent(song.id)}`, { method: "DELETE" });
      } catch (err) {
        alert(err.message);
      }
      loadLibrary();
      loadHistory(true);
    };

    li.append(main, del);
    ul.append(li);
  }
}

$("lib-search").addEventListener("input", renderLibrary);

setupUploads({
  inputs: [$("file"), $("folder")],
  status: $("upload-status"),
  onDone: () => {
    loadLibrary();
    loadHistory(true);
  },
});

// ---------- Start ----------
api("/api/admin/me")
  .then((r) => (r.loggedIn ? showAdmin() : showLogin()))
  .catch(showLogin);
