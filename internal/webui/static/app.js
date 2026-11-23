// 前端只需三件事：列目录、流式上传、把播放器的 Range 请求打回本地网关。
// 所有解密都发生在网关里，浏览器永远拿不到密钥。

const state = { cwd: "", entries: [], configured: false, vaultReady: null };
const $ = (id) => document.getElementById(id);

const fmtSize = (n) => {
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n >= 10 ? 0 : 1) + " " + u[i];
};

const joinPath = (dir, name) => "/" + [dir.replace(/\/+$/, ""), name].filter(Boolean).join("/").replace(/^\/+/, "");

async function api(url, opts) {
  const r = await fetch(url, opts);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) {
    const err = new Error((body && body.message) || body || r.statusText);
    err.code = body && body.code;
    err.retryable = !!(body && body.retryable);
    throw err;
  }
  return body;
}

async function loadStatus() {
  const s = await api("/api/status");
  state.configured = s.configured;
  state.vaultReady = !!s.vault_ready;
  $("keyfp").textContent = s.key_fingerprint ? "密钥 " + s.key_fingerprint + "…" : "";
  const dot = $("health");
  dot.className = "dot " + (s.vault_ready ? "ok" : s.configured ? "err" : "");
  $("setupPanel").classList.toggle("hidden", !!s.configured && !!s.vault_ready);
  if (s.vault_error) $("setupMsg").textContent = "连接失败：" + s.vault_error;
  if (s.configured) {
    $("fUrl").value = s.webdav_url || $("fUrl").value;
    $("fRemote").value = s.remote_path || "vault";
    $("fChunk").value = s.chunk_size || "500Mi";
  }
  return s;
}

async function loadList() {
  const r = await api("/api/list?path=" + encodeURIComponent(state.cwd));
  state.entries = r.entries || [];
  $("pathbar").textContent = r.path || "/";
  $("btnUp").disabled = state.cwd === "";
  const dirs = state.entries.filter((e) => e.dir).length;
  const files = state.entries.length - dirs;
  $("count").textContent = dirs || files ? `（${dirs} 个目录 / ${files} 个文件）` : "";
  renderList();
  // 列表既然拉到了，说明后台自己连上了；把状态与错误面板同步过来，
  // 否则手机开机网络晚到时会一直挂着「连接失败」的提示。
  if (state.vaultReady === false) {
    state.vaultReady = true;
    loadStatus().catch(() => {});
  }
}

function renderList() {
  const box = $("list");
  box.innerHTML = "";
  if (!state.entries.length) {
    box.innerHTML = '<div class="empty">这里还是空的，先传一个视频试试。</div>';
    return;
  }
  const sorted = [...state.entries].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, "zh"));
  for (const e of sorted) {
    const row = document.createElement("div");
    row.className = "item";
    const icon = e.dir ? "📁" : mediaIcon(e.name);
    row.innerHTML = `<div class="icon">${icon}</div>
      <div class="name" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</div>
      <div class="size">${e.dir ? "" : fmtSize(e.size)}</div>
      <button class="del ghost" title="删除">✕</button>`;
    row.addEventListener("click", () => {
      if (e.dir) openDir(e.name);
      else openViewer(e);
    });
    row.querySelector(".del").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm("删除 " + e.name + " ？")) return;
      try {
        await api("/api/delete?path=" + encodeURIComponent(e.path), { method: "POST" });
        await loadList();
      } catch (err) { alert("删除失败：" + err.message); }
    });
    box.appendChild(row);
  }
}

const mediaIcon = (name) => {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["mp4", "m4v", "mkv", "mov", "webm", "avi"].includes(ext)) return "🎬";
  if (["jpg", "jpeg", "png", "gif", "webp", "heic", "bmp"].includes(ext)) return "🖼️";
  if (["mp3", "flac", "m4a", "wav", "aac"].includes(ext)) return "🎧";
  return "📄";
};
const isVideo = (name) => /\.(mp4|m4v|mkv|mov|webm|avi)$/i.test(name);
const isImage = (name) => /\.(jpg|jpeg|png|gif|webp|heic|bmp)$/i.test(name);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function openDir(name) {
  state.cwd = joinPath(state.cwd, name).replace(/^\//, "");
  loadList();
}

async function openViewer(e) {
  const src = "/api/stream?path=" + encodeURIComponent(e.path);
  $("viewer").classList.remove("hidden");
  $("viewerTitle").textContent = e.name;
  $("viewerFoot").textContent = fmtSize(e.size);
  const body = $("viewerBody");
  body.innerHTML = "";
  $("btnJump").classList.toggle("hidden", !isVideo(e.name));

  if (isVideo(e.name)) {
    const v = document.createElement("video");
    v.controls = true;
    v.preload = "metadata";
    v.autoplay = true;
    v.playsInline = true;
    v.src = src;
    body.appendChild(v);
    attachSeekProbe(v);
  } else if (isImage(e.name)) {
    const img = document.createElement("img");
    img.src = src;
    body.appendChild(img);
  } else {
    const a = document.createElement("a");
    a.href = src;
    a.textContent = "下载 / 打开";
    a.style.color = "var(--accent)";
    body.appendChild(a);
  }
}

// 播放器一旦拖到 90%，用 seeked→playing 的间隔量化“起播耗时”，
// 并把浏览器实际发出的请求交给用户核对（网关侧只回 206 + 小段 Content-Range）。
let probeStart = 0;
function attachSeekProbe(v) {
  v.addEventListener("seeked", () => {
    probeStart = performance.now();
    $("viewerFoot").textContent = "已跳转到 " + (v.currentTime / (v.duration || 1) * 100).toFixed(0) + "% ，等待起播…";
  });
  v.addEventListener("playing", () => {
    if (!probeStart) return;
    const ms = Math.round(performance.now() - probeStart);
    $("viewerFoot").textContent = `起播耗时 ${ms} ms · 位置 ${(v.currentTime / (v.duration || 1) * 100).toFixed(1)}% · 总时长 ${(v.duration || 0).toFixed(1)}s`;
    probeStart = 0;
  });
}

$("btnJump").addEventListener("click", () => {
  const v = document.querySelector("#viewerBody video");
  if (!v || !v.duration) return;
  v.currentTime = v.duration * 0.9;
});

$("btnClose").addEventListener("click", () => {
  $("viewer").classList.add("hidden");
  $("viewerBody").innerHTML = "";
  probeStart = 0;
});

$("btnRefresh").addEventListener("click", () => loadList().catch((e) => alert(e.message)));
$("btnUp").addEventListener("click", () => {
  state.cwd = state.cwd.split("/").slice(0, -1).join("/");
  loadList();
});
$("btnSetup").addEventListener("click", () => $("setupPanel").classList.toggle("hidden"));

$("btnSave").addEventListener("click", async () => {
  const payload = {
    url: $("fUrl").value.trim(),
    user: $("fUser").value.trim(),
    pass: $("fPass").value,
    remote_path: $("fRemote").value.trim() || "vault",
    chunk_size: $("fChunk").value.trim() || "500Mi",
  };
  $("setupMsg").textContent = "连接中…";
  try {
    await api("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    $("setupMsg").textContent = "";
    await loadStatus();
    await loadList();
  } catch (err) {
    $("setupMsg").textContent = "失败：" + err.message;
  }
});

// ---------- 上传：流式 + 进度 + 失败分类重试 ----------

const RETRY_DELAYS = [1000, 3000, 8000];

function uploadOne(file, attempt = 0, onProgress) {
  return new Promise((resolve, reject) => {
    const target = joinPath(state.cwd, file.name).replace(/^\//, "");
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", "/api/upload?path=" + encodeURIComponent(target));
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(JSON.parse(xhr.responseText));
      const err = new Error("HTTP " + xhr.status);
      try {
        const body = JSON.parse(xhr.responseText);
        err.message = body.message || err.message;
        err.code = body.code;
        err.retryable = body.retryable;
      } catch (_) {}
      reject(err);
    };
    xhr.onerror = () => { const e = new Error("网络错误"); e.code = "NETWORK"; e.retryable = true; reject(e); };
    xhr.ontimeout = () => { const e = new Error("超时"); e.code = "TIMEOUT"; e.retryable = true; reject(e); };
    xhr.timeout = 0; // 大文件不设死超时，交给服务端
    xhr.send(file);
  });
}

function queueItem(file) {
  const el = document.createElement("div");
  el.className = "queue-item";
  el.innerHTML = `<div class="meta"><span>${escapeHtml(file.name)} · ${fmtSize(file.size)}</span><span class="st">等待</span></div>
    <div class="bar"><i></i></div>`;
  $("queue").appendChild(el);
  const bar = el.querySelector(".bar");
  const fill = el.querySelector("i");
  const st = el.querySelector(".st");

  const run = async (attempt) => {
    st.textContent = attempt ? `重试 ${attempt}/${RETRY_DELAYS.length}` : "上传中";
    try {
      await uploadOne(file, attempt, (p) => {
        fill.style.width = (p * 100).toFixed(1) + "%";
        st.textContent = (p * 100).toFixed(0) + "%";
      });
      fill.style.width = "100%";
      st.textContent = "完成";
    } catch (err) {
      if (err.retryable && attempt < RETRY_DELAYS.length) {
        bar.classList.add("warn");
        st.textContent = `${err.code || "ERR"}，${RETRY_DELAYS[attempt] / 1000}s 后重试`;
        setTimeout(() => { bar.classList.remove("warn"); fill.style.width = "0"; run(attempt + 1); }, RETRY_DELAYS[attempt]);
        return;
      }
      bar.classList.add("err");
      st.textContent = (err.code || "失败") + "：" + err.message;
    }
  };
  return run(0);
}

async function uploadFiles(files) {
  for (const f of files) await queueItem(f);
  await loadList();
}

$("pickFile").addEventListener("click", (ev) => { ev.preventDefault(); $("fileInput").click(); });
$("fileInput").addEventListener("change", (ev) => uploadFiles([...ev.target.files]));
const drop = $("drop");
["dragenter", "dragover"].forEach((n) => drop.addEventListener(n, (ev) => { ev.preventDefault(); drop.classList.add("hot"); }));
["dragleave", "drop"].forEach((n) => drop.addEventListener(n, (ev) => { ev.preventDefault(); drop.classList.remove("hot"); }));
drop.addEventListener("drop", (ev) => uploadFiles([...ev.dataTransfer.files]));

(async function boot() {
  try {
    await loadStatus();
    if (state.configured) await loadList();
  } catch (e) {
    console.error(e);
  }
})();
