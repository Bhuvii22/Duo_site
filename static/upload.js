// Library uploads, shared by the room page and the admin page.
// Songs and .zip files (unpacked by the server) go into the common library.

const UPLOADABLE = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm|zip)$/i;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Wires file / folder <input>s to upload into the library, reporting progress in `status`.
function setupUploads({ inputs, status, uploaderName = () => "", onDone = () => {} }) {
  const uploadAll = async (e) => {
    const files = [...e.target.files].filter((f) => UPLOADABLE.test(f.name));
    e.target.value = "";
    if (!files.length) {
      status.textContent = "No audio or zip files found.";
      return;
    }
    let added = 0, duplicates = 0, skipped = 0;
    const failed = [];
    for (const [i, file] of files.entries()) {
      try {
        const result = await uploadFile(file, uploaderName(), (pct) => {
          const step = pct < 100 || !/\.zip$/i.test(file.name) ? `${pct}%` : "unpacking…";
          status.textContent = `Uploading ${i + 1}/${files.length}: ${file.name} — ${step}`;
        });
        added += result.added.length;
        duplicates += result.duplicates;
        skipped += result.skipped;
      } catch (err) {
        failed.push(`${file.name} (${err.message})`);
      }
    }
    const parts = [`Added ${plural(added, "song")}`];
    if (duplicates) parts.push(`${plural(duplicates, "song")} already in the library`);
    if (skipped) parts.push(`${skipped} skipped (too large or unreadable)`);
    if (failed.length) parts.push(`${failed.length} failed: ${failed.join(", ")}`);
    status.textContent = `Done. ${parts.join(" · ")}.`;
    onDone();
  };
  for (const input of inputs) input.addEventListener("change", uploadAll);
}

function uploadFile(file, uploaderName, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    form.append("name", uploaderName);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/library");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      if (xhr.status < 300) return resolve(JSON.parse(xhr.responseText));
      let detail = xhr.statusText;
      try { detail = JSON.parse(xhr.responseText).detail; } catch {}
      reject(new Error(detail));
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send(form);
  });
}
