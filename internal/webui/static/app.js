// 前端只做三件事：列目录（缩略图网格 / 列表）、流式上传、把播放器的 Range 请求打回本地网关。
// 所有解密都发生在网关里，浏览器永远拿不到密钥。

const state = {
  cwd: "",
  entries: [],
  configured: false,
  vaultReady: null,
  nativeFormOpen: false,
  mode: null, // "native" | "webdav"，由 /api/status 决定初值
  status: null,
  view: localStorage.getItem("vaultd.view") || "grid",
  sort: localStorage.getItem("vaultd.sort") || "name",
  filter: localStorage.getItem("vaultd.filter") || "all",
  viewer: { items: [], index: -1, zoom: false },
};
const $ = (id) => document.getElementById(id);

const fmtSize = (n) => {
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n >= 10 ? 0 : 1) + " " + u[i];
};
const fmtDate = (s) => {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const joinPath = (dir, name) => "/" + [dir.replace(/\/+$/, ""), name].filter(Boolean).join("/").replace(/^\/+/, "");

let toastTimer = 0;
function toast(msg, kind = "err") {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

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
  state.status = s;
  applyStatus(s);
  return s;
}

function applyStatus(s) {
  state.configured = s.configured;
  state.vaultReady = !!s.vault_ready;
  $("keyfp").textContent = s.key_fingerprint ? "密钥 " + s.key_fingerprint + "…" : "";
  const dot = $("health");
  dot.className = "dot " + (s.vault_ready ? "ok" : s.configured ? "err" : "");
  $("setupPanel").classList.toggle("hidden", !!s.configured && !!s.vault_ready);
  if (s.vault_error) $("setupMsg").textContent = "连接失败：" + s.vault_error;

  // 接入方式：全新设备（还没配置）默认就是内置直连；老的外部 WebDAV 配置则沿用 WebDAV。
  // 用户可以在设置面板里手动切换，切换只影响表单展示，保存哪个表单就写哪种 backend。
  const nativeOnServer = (s.backend || "").indexOf("内置") === 0;
  if (!state.mode) {
    state.mode = nativeOnServer || !s.configured ? "native" : "webdav";
  }
  const native = state.mode === "native";
  $("btnModeNative").classList.toggle("on", native);
  $("btnModeWebdav").classList.toggle("on", !native);
  $("setupTitle").textContent = native ? "云端接入（内置直连）" : "云端接入（外部 WebDAV）";
  $("webdavForm").classList.toggle("hidden", native);
  $("webdavHint").classList.toggle("hidden", native);
  $("nativeNote").classList.toggle("hidden", !native);
  $("nativeForm").classList.toggle("hidden", !native);
  $("btnNativeToggle").classList.add("hidden");

  if (s.configured && !native) {
    $("fUrl").value = s.webdav_url || $("fUrl").value;
    $("fRemote").value = s.remote_path || "vault";
    $("fChunk").value = s.chunk_size || "500Mi";
  }
}

async function loadList() {
  const r = await api("/api/list?path=" + encodeURIComponent(state.cwd));
  state.entries = r.entries || [];
  showPath(r.path || "/");
  $("btnUp").disabled = state.cwd === "";
  const dirs = state.entries.filter((e) => e.dir).length;
  const files = state.entries.length - dirs;
  $("count").textContent = state.entries.length ? `${dirs} 目录 · ${files} 文件` : "";
  renderList();
  // 列表既然拉到了，说明后台自己连上了；把状态与错误面板同步过来，
  // 否则手机开机网络晚到时会一直挂着「连接失败」的提示。
  if (state.vaultReady === false) {
    state.vaultReady = true;
    loadStatus().catch(() => {});
  }
}

function showPath(p) {
  $("pathbar").textContent = p === "/" ? "根目录 /" : p;
  $("pathbar").title = p;
}

function sortedEntries() {
  const list = [...state.entries];
  list.sort((a, b) => {
    if (!!b.dir !== !!a.dir) return b.dir ? 1 : -1;
    if (state.sort === "size") return (b.size || 0) - (a.size || 0);
    if (state.sort === "time") {
      const ta = Date.parse(a.mod_time || "") || 0;
      const tb = Date.parse(b.mod_time || "") || 0;
      if (tb !== ta) return tb - ta;
    }
    return a.name.localeCompare(b.name, "zh");
  });
  return list;
}

function renderList() {
  const box = $("list");
  box.className = "album" + (state.view === "list" ? " list-mode" : "");
  box.innerHTML = "";
  $("btnGrid").classList.toggle("on", state.view === "grid");
  $("btnList").classList.toggle("on", state.view === "list");
  renderFilters();

  const shown = sortedEntries().filter(matchesFilter);
  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.style.gridColumn = "1 / -1";
    const filtered = state.filter !== "all";
    empty.innerHTML = `<div class="big">${filtered ? "🗂️" : "🗂️"}</div>
      <p>${filtered ? "这个分类下还没有文件" : "这里是空的，可以上传照片、视频或任意文件"}</p>
      <button class="primary tap" id="btnEmptyUp">${filtered ? "上传到当前目录" : "上传第一个文件"}</button>`;
    box.appendChild(empty);
    $("btnEmptyUp").addEventListener("click", () => $("fileInput").click());
    return;
  }
  for (const e of shown) {
    box.appendChild(state.view === "grid" ? tileEl(e) : rowEl(e));
  }
}

function renderFilters() {
  const bar = $("filters");
  const counts = {
    all: state.entries.length,
    image: state.entries.filter((e) => !e.dir && isImage(e.name)).length,
    video: state.entries.filter((e) => !e.dir && isVideo(e.name)).length,
    file: state.entries.filter((e) => !e.dir && !isImage(e.name) && !isVideo(e.name)).length,
  };
  const defs = [["all", "全部"], ["image", "图片"], ["video", "视频"], ["file", "文件"]];
  bar.innerHTML = "";
  for (const [key, label] of defs) {
    const b = document.createElement("button");
    b.className = "chip tap" + (state.filter === key ? " on" : "");
    b.innerHTML = `${label}<span class="n">${counts[key]}</span>`;
    b.addEventListener("click", () => {
      state.filter = key;
      localStorage.setItem("vaultd.filter", key);
      renderList();
    });
    bar.appendChild(b);
  }
}

const EXT_IMG = ["jpg", "jpeg", "png", "gif", "webp", "bmp"];
const EXT_VIDEO = ["mp4", "m4v", "mkv", "mov", "webm", "avi"];
const EXT_AUDIO = ["mp3", "flac", "m4a", "wav", "aac", "ogg"];
const EXT_DOC = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "epub", "rtf", "odt", "pages", "numbers", "key"];
const EXT_ARCHIVE = ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "iso"];
const EXT_CODE = ["json", "xml", "yaml", "yml", "js", "ts", "py", "go", "java", "c", "h", "cpp", "sh", "ps1", "ini", "conf", "log", "sql", "html", "css", "toml"];
const EXT_PKG = ["apk", "exe", "msi", "deb", "dmg", "ipa", "appx"];
const extOf = (n) => (n.split(".").pop() || "").toLowerCase();
const isImage = (n) => EXT_IMG.includes(extOf(n));
const isVideo = (n) => EXT_VIDEO.includes(extOf(n));
const isAudio = (n) => EXT_AUDIO.includes(extOf(n));

// 非媒体文件也分类，决定图标与角标颜色
function fileKind(name) {
  const e = extOf(name);
  if (EXT_ARCHIVE.includes(e)) return "archive";
  if (EXT_DOC.includes(e)) return "doc";
  if (EXT_CODE.includes(e)) return "code";
  if (EXT_PKG.includes(e)) return "pkg";
  return "file";
}
const KIND_LABEL = { archive: "压缩包", doc: "文档", code: "文本", pkg: "安装包", file: "文件", image: "图片", video: "视频", audio: "音频" };
function kindGlyph(name) {
  if (isImage(name)) return "🖼️";
  if (isVideo(name)) return "🎬";
  if (isAudio(name)) return "🎧";
  switch (fileKind(name)) {
    case "archive": return "📦";
    case "doc": return extOf(name) === "pdf" ? "📕" : "📘";
    case "code": return "🧾";
    case "pkg": return "💿";
    default: return "📄";
  }
}
function matchesFilter(e) {
  if (state.filter === "all") return true;
  if (e.dir) return false;
  if (state.filter === "image") return isImage(e.name);
  if (state.filter === "video") return isVideo(e.name);
  return !isImage(e.name) && !isVideo(e.name);
}
const thumbURL = (e, w) => "/api/thumb?w=" + w + "&path=" + encodeURIComponent(e.path);
const streamURL = (e, dl) => "/api/stream?path=" + encodeURIComponent(e.path) + (dl ? "&dl=1" : "");

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fallbackGlyph(name) {
  return kindGlyph(name);
}

function tileEl(e) {
  const el = document.createElement("div");
  el.className = "tile";
  let ph = "";
  let badge = "";
  if (e.dir) {
    ph = `<div class="tile-ph dir"><span class="glyph">📁</span></div>`;
  } else if (isImage(e.name)) {
    ph = `<div class="tile-ph"><span class="glyph">${fallbackGlyph(e.name)}</span></div>`;
  } else {
    const kind = isVideo(e.name) ? "video" : isAudio(e.name) ? "audio" : fileKind(e.name);
    ph = `<div class="tile-ph ${kind}"><span class="glyph">${kindGlyph(e.name)}</span></div>`;
    badge = `<span class="tile-badge ${kind}">${escapeHtml(extOf(e.name).toUpperCase() || "FILE")}</span>`;
  }
  el.innerHTML = `${ph}${badge}
    <button class="kill" title="删除">✕</button>
    <div class="tile-meta"><div class="tile-name">${escapeHtml(e.name)}</div>
    <div class="tile-size">${e.dir ? "文件夹" : fmtSize(e.size)}</div></div>`;
  if (isImage(e.name)) {
    // 缩略图按需解码：先挂 emoji 占位，加载成功再换成正图，失败就保持占位。
    // 注意不能给游离节点设 loading="lazy"，那样浏览器不会发起请求。
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      const holder = el.querySelector(".tile-ph");
      holder.classList.add("filled");
      holder.innerHTML = "";
      holder.appendChild(img);
    };
    img.onerror = () => {};
    img.src = thumbURL(e, 400);
  }
  el.addEventListener("click", (ev) => {
    if (ev.target.classList.contains("kill")) return;
    e.dir ? openDir(e.name) : openViewer(e);
  });
  el.querySelector(".kill").addEventListener("click", (ev) => { ev.stopPropagation(); removeEntry(e); });
  return el;
}

function rowEl(e) {
  const el = document.createElement("div");
  el.className = "item";
  let thumb = `<span>${e.dir ? "📁" : fallbackGlyph(e.name)}</span>`;
  if (!e.dir && isImage(e.name)) {
    thumb = `<img loading="lazy" decoding="async" src="${thumbURL(e, 120)}" alt="">`;
  }
  el.innerHTML = `<div class="thumb">${thumb}</div>
    <div class="txt"><div class="name">${escapeHtml(e.name)}</div>
    <div class="sub">${e.dir ? "文件夹" : KIND_LABEL[isImage(e.name) ? "image" : isVideo(e.name) ? "video" : isAudio(e.name) ? "audio" : fileKind(e.name)] + " · " + fmtSize(e.size) + (e.mod_time ? " · " + fmtDate(e.mod_time) : "")}</div></div>
    <button class="del ghost" title="删除">✕</button>`;
  const img = el.querySelector(".thumb img");
  if (img) img.addEventListener("error", () => { el.querySelector(".thumb").textContent = fallbackGlyph(e.name); });
  el.addEventListener("click", (ev) => {
    if (ev.target.classList.contains("del")) return;
    e.dir ? openDir(e.name) : openViewer(e);
  });
  el.querySelector(".del").addEventListener("click", (ev) => { ev.stopPropagation(); removeEntry(e); });
  return el;
}

async function removeEntry(e) {
  if (!confirm("删除 " + e.name + " ？")) return;
  try {
    await api("/api/delete?path=" + encodeURIComponent(e.path), { method: "POST" });
    toast("已删除 " + e.name, "ok");
    if (state.viewer.index >= 0) closeViewer();
    await loadList();
  } catch (err) {
    toast("删除失败：" + err.message);
  }
}

function openDir(name) {
  state.cwd = joinPath(state.cwd, name).replace(/^\//, "");
  loadList().catch((err) => toast("打开目录失败：" + err.message));
}

// ---------- 查看器：左右切图 / 双击缩放 / Range 播放 ----------

function viewerItems() {
  return sortedEntries().filter((e) => !e.dir && (isImage(e.name) || isVideo(e.name)));
}

async function openViewer(e) {
  if (!isImage(e.name) && !isVideo(e.name)) {
    state.viewer = { items: [], index: -1, zoom: false };
    $("viewer").classList.remove("hidden");
    renderFileDetail(e);
    return;
  }
  const items = viewerItems();
  const index = items.findIndex((it) => it.path === e.path);
  state.viewer = { items, index: index >= 0 ? index : 0, zoom: false };
  $("viewer").classList.remove("hidden");
  renderViewer();
}

// 普通文件（文档 / 压缩包 / 安装包 / 任意未知格式）走详情页，不做预览，重点是可取回
function renderFileDetail(e) {
  const body = $("viewerBody");
  body.innerHTML = "";
  body.classList.remove("zoomed");
  body.scrollTop = 0;
  body.scrollLeft = 0;
  const kind = isAudio(e.name) ? "audio" : fileKind(e.name);
  const label = KIND_LABEL[kind] || "文件";
  $("viewerTitle").textContent = e.name;
  $("viewerFoot").textContent = label + " · " + fmtSize(e.size) + (e.mod_time ? " · " + fmtDate(e.mod_time) : "");
  $("btnJump").classList.add("hidden");
  $("btnPrev").classList.add("hidden");
  $("btnNext").classList.add("hidden");
  gesture.img = null;

  const card = document.createElement("div");
  card.className = "filecard";
  card.innerHTML = `<div class="fc-icon ${kind}">${kindGlyph(e.name)}</div>
    <div class="fc-name">${escapeHtml(e.name)}</div>
    <div class="fc-sub">${label} · ${fmtSize(e.size)}${e.mod_time ? " · " + fmtDate(e.mod_time) : ""}</div>
    <div class="fc-path">${escapeHtml(e.path)}</div>
    <button class="primary tap" id="btnDownload">下载到本机</button>
    <p class="hint fc-tip">安卓保存到系统「下载」目录，PC 浏览器直接另存为；文件名是解密后的原名。</p>`;
  body.appendChild(card);
  $("btnDownload").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = streamURL(e, true);
    a.download = e.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("已开始下载 " + e.name, "ok");
  });
}

function renderViewer() {
  const { items, index } = state.viewer;
  const e = items[index];
  if (!e) return closeViewer();
  const body = $("viewerBody");
  body.innerHTML = "";
  body.classList.remove("zoomed");
  body.scrollTop = 0;
  body.scrollLeft = 0;
  state.viewer.zoom = false;
  $("viewerTitle").textContent = (index + 1) + "/" + items.length + "  " + e.name;
  $("viewerFoot").textContent = fmtSize(e.size) + (e.mod_time ? " · " + fmtDate(e.mod_time) : "");
  $("btnJump").classList.toggle("hidden", !isVideo(e.name));
  $("btnPrev").classList.toggle("hidden", items.length < 2);
  $("btnNext").classList.toggle("hidden", items.length < 2);
  $("btnPrev").disabled = index <= 0;
  $("btnNext").disabled = index >= items.length - 1;

  if (isVideo(e.name)) {
    const v = document.createElement("video");
    v.controls = true;
    v.preload = "metadata";
    v.autoplay = true;
    v.playsInline = true;
    v.src = "/api/stream?path=" + encodeURIComponent(e.path);
    body.appendChild(v);
    attachSeekProbe(v);
  } else if (isImage(e.name)) {
    const img = document.createElement("img");
    img.src = "/api/stream?path=" + encodeURIComponent(e.path);
    img.alt = e.name;
    body.appendChild(img);
    attachImageGestures(body, img);
  } else {
    const a = document.createElement("a");
    a.href = "/api/stream?path=" + encodeURIComponent(e.path);
    a.textContent = "下载 / 打开";
    a.style.color = "var(--accent)";
    body.appendChild(a);
  }
}

function step(delta) {
  const { items, index } = state.viewer;
  const next = index + delta;
  if (next < 0 || next >= items.length) return;
  state.viewer.index = next;
  renderViewer();
}

function attachImageGestures(body, img) {
  // 双击切换放大：按点中的位置定位，放大后整页可拖动查看
  img.addEventListener("dblclick", (ev) => {
    ev.preventDefault();
    if (state.viewer.zoom) {
      resetZoom(body, img);
      return;
    }
    const r = img.getBoundingClientRect();
    const rx = r.width ? (ev.clientX - r.left) / r.width : 0.5;
    const ry = r.height ? (ev.clientY - r.top) / r.height : 0.5;
    const vw = body.clientWidth;
    body.classList.add("zoomed");
    img.classList.add("zoom");
    img.style.width = vw * 2 + "px";
    state.viewer.zoom = true;
    $("btnPrev").classList.add("hidden");
    $("btnNext").classList.add("hidden");
    requestAnimationFrame(() => {
      body.scrollLeft = rx * vw * 2 - vw / 2;
      body.scrollTop = ry * img.clientHeight - body.clientHeight / 2;
    });
  });
  gesture.img = img;
}

function resetZoom(body, img) {
  img.classList.remove("zoom");
  img.style.width = "";
  body.classList.remove("zoomed");
  body.scrollLeft = 0;
  body.scrollTop = 0;
  state.viewer.zoom = false;
  const n = state.viewer.items.length;
  $("btnPrev").classList.toggle("hidden", n < 2);
  $("btnNext").classList.toggle("hidden", n < 2);
}

// 单指横滑切图：监听器只在模块里挂一次，viewerBody 每次渲染都是同一个节点
const gesture = { img: null, sx: 0, sy: 0, moved: false };
$("viewerBody").addEventListener("pointerdown", (ev) => {
  if (!gesture.img) return;
  gesture.sx = ev.clientX;
  gesture.sy = ev.clientY;
  gesture.moved = false;
});
$("viewerBody").addEventListener("pointermove", (ev) => {
  if (!gesture.img) return;
  if (Math.abs(ev.clientX - gesture.sx) > 12) gesture.moved = true;
});
$("viewerBody").addEventListener("pointerup", (ev) => {
  if (!gesture.img || !gesture.moved || state.viewer.zoom) return;
  const dx = ev.clientX - gesture.sx;
  const dy = ev.clientY - gesture.sy;
  if (Math.abs(dx) > 60 && Math.abs(dy) < 70) step(dx < 0 ? 1 : -1);
});

// 播放器一旦拖到 90%，用 seeked→playing 的间隔量化“起播耗时”
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

function closeViewer() {
  $("viewer").classList.add("hidden");
  $("viewerBody").innerHTML = "";
  $("viewerBody").classList.remove("zoomed");
  gesture.img = null;
  state.viewer = { items: [], index: -1, zoom: false };
  probeStart = 0;
}

$("btnJump").addEventListener("click", () => {
  const v = document.querySelector("#viewerBody video");
  if (!v || !v.duration) return;
  v.currentTime = v.duration * 0.9;
});
$("btnClose").addEventListener("click", closeViewer);
$("btnPrev").addEventListener("click", () => step(-1));
$("btnNext").addEventListener("click", () => step(1));
document.addEventListener("keydown", (ev) => {
  if ($("viewer").classList.contains("hidden")) return;
  if (ev.key === "ArrowLeft") step(-1);
  if (ev.key === "ArrowRight") step(1);
  if (ev.key === "Escape") closeViewer();
});

// ---------- 顶部/视图控件 ----------

$("btnRefresh").addEventListener("click", () => loadList().catch((err) => toast("刷新失败：" + err.message)));
$("btnUp").addEventListener("click", () => {
  state.cwd = state.cwd.split("/").slice(0, -1).join("/");
  loadList().catch((err) => toast("返回失败：" + err.message));
});
$("pathbar").addEventListener("click", () => {
  if (!state.cwd) return;
  state.cwd = "";
  loadList().catch((err) => toast("返回失败：" + err.message));
});
$("btnSetup").addEventListener("click", () => $("setupPanel").classList.toggle("hidden"));

$("btnGrid").addEventListener("click", () => setView("grid"));
$("btnList").addEventListener("click", () => setView("list"));
function setView(v) {
  state.view = v;
  localStorage.setItem("vaultd.view", v);
  renderList();
}
$("sortSel").value = state.sort;
$("sortSel").addEventListener("change", (ev) => {
  state.sort = ev.target.value;
  localStorage.setItem("vaultd.sort", state.sort);
  renderList();
});

$("btnNativeToggle").addEventListener("click", () => {
  state.nativeFormOpen = !state.nativeFormOpen;
  $("nativeForm").classList.toggle("hidden", !state.nativeFormOpen);
});

$("btnModeNative").addEventListener("click", () => {
  state.mode = "native";
  if (state.status) applyStatus(state.status);
});
$("btnModeWebdav").addEventListener("click", () => {
  state.mode = "webdav";
  if (state.status) applyStatus(state.status);
});

async function saveNative() {
  const payload = {
    backend: "native",
    cloud_provider: "139",
    cloud_authorization: $("fAuth").value.trim(),
    master_key: $("fKey").value.trim(),
    salt: $("fSalt").value.trim(),
    remote_path: $("fRemoteN").value.trim() || "vault",
    chunk_size: $("fChunkN").value.trim() || "500Mi",
  };
  $("cloudMsg").textContent = "连接中…";
  try {
    const r = await api("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    $("cloudMsg").textContent = "";
    $("fAuth").value = "";
    await loadStatus();
    await loadList();
    toast("已连接云端", "ok");
    $("keyfp").textContent = r && r.fingerprint ? "密钥 " + r.fingerprint + "…" : $("keyfp").textContent;
  } catch (err) {
    $("cloudMsg").textContent = "失败：" + err.message;
    toast("接入失败：" + err.message);
    throw err;
  }
}

$("btnSaveCloud").addEventListener("click", () => { saveNative().catch(() => {}); });

// ---- 配置导入：把 PC 导出的 vaultd-config.json 搬到这台设备 ----
const KEY_RE = /^[0-9a-f]{64}$/i;

function fillFromDoc(doc) {
  const auth = (doc.cloud_authorization || "").trim();
  const key = (doc.master_key || "").trim();
  const salt = (doc.salt || "").trim();
  if (key || salt) {
    if (!KEY_RE.test(key) || !KEY_RE.test(salt)) {
      throw new Error("主密钥与盐必须同时提供，且各是 64 位 hex");
    }
  }
  if (!auth && !doc.webdav_url) throw new Error("文件里既没有云端授权串，也没有 WebDAV 地址");
  const webdav = (doc.backend || "") === "webdav" || (!auth && doc.webdav_url);
  if (webdav) {
    state.mode = "webdav";
    if (state.status) applyStatus(state.status);
    $("fUrl").value = doc.webdav_url || "";
    $("fUser").value = doc.webdav_user || "";
    $("fPass").value = doc.webdav_pass || "";
    $("fRemote").value = doc.remote_path || "vault";
    $("fChunk").value = doc.chunk_size || "500Mi";
    // WebDAV 表单里没有密钥字段，导入时先把密钥挂在状态上，保存时一并提交，
    // 否则从新设备导进来还是新生成的那把钥匙，云端旧密文照样解不开。
    state.xferKeys = key && salt ? { master_key: key, salt: salt } : null;
    return "webdav";
  }
  state.mode = "native";
  if (state.status) applyStatus(state.status);
  $("fAuth").value = auth;
  $("fKey").value = key;
  $("fSalt").value = salt;
  $("fRemoteN").value = doc.remote_path || "vault";
  $("fChunkN").value = doc.chunk_size || "500Mi";
  state.xferKeys = null;
  return "native";
}

async function importConfigText(text, label) {
  $("xferMsg").textContent = "解析中…";
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    $("xferMsg").textContent = "不是 JSON：" + e.message;
    return;
  }
  if (doc && doc.type && doc.type !== "vaultd-config") {
    $("xferMsg").textContent = "不是 vaultd 导出的配置文件";
    return;
  }
  let kind;
  try {
    kind = fillFromDoc(doc || {});
  } catch (e) {
    $("xferMsg").textContent = "导入失败：" + e.message;
    return;
  }
  if (kind === "webdav") {
    $("xferMsg").textContent = "已填入 WebDAV 表单" + (label ? "（" + label + "）" : "");
    $("btnSave").click();
    return;
  }
  $("xferMsg").textContent = "已导入" + (label ? "（" + label + "）" : "") + "，正在连接…";
  try {
    await saveNative();
    $("xferMsg").textContent = "已导入并连接云端";
    $("cfgText").value = "";
  } catch (e) {
    $("xferMsg").textContent = "已写入，但连接失败：" + e.message;
  }
}

$("btnImportCfg").addEventListener("click", () => $("cfgFile").click());

// 手机上「导出」的兜底：有些 WebView 不会把下载交给系统下载器，
// 这里直接把 JSON 铺进文本框，长按全选复制即可传到别的设备。
$("btnExportText").addEventListener("click", async () => {
  $("xferMsg").textContent = "读取中…";
  try {
    const r = await fetch("/api/config/export", { credentials: "same-origin" });
    const t = await r.text();
    if (!r.ok) throw new Error((JSON.parse(t) || {}).message || ("HTTP " + r.status));
    $("cfgText").value = t.trim();
    $("xferMsg").textContent = "已填入下方文本框，长按全选复制";
  } catch (e) {
    $("xferMsg").textContent = "导出失败：" + e.message;
  }
});

$("cfgFile").addEventListener("change", () => {
  const f = $("cfgFile").files && $("cfgFile").files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => importConfigText(String(rd.result || ""), f.name);
  rd.onerror = () => { $("xferMsg").textContent = "读不到这个文件"; };
  rd.readAsText(f);
  $("cfgFile").value = "";
});

$("btnImportText").addEventListener("click", () => {
  const t = $("cfgText").value.trim();
  if (!t) { $("xferMsg").textContent = "先把文件内容粘进来"; return; }
  importConfigText(t, "");
});

$("btnSave").addEventListener("click", async () => {
  const payload = {
    url: $("fUrl").value.trim(),
    user: $("fUser").value.trim(),
    pass: $("fPass").value,
    remote_path: $("fRemote").value.trim() || "vault",
    chunk_size: $("fChunk").value.trim() || "500Mi",
    ...(state.xferKeys || {}),
  };
  $("setupMsg").textContent = "连接中…";
  try {
    await api("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    $("setupMsg").textContent = "";
    state.xferKeys = null;
    await loadStatus();
    await loadList();
    toast("已连接 WebDAV", "ok");
  } catch (err) {
    $("setupMsg").textContent = "失败：" + err.message;
    toast("接入失败：" + err.message);
  }
});

// ---------- 上传：流式 + 进度 + 自动重试 + 手动重试 ----------

const RETRY_DELAYS = [1000, 3000, 8000];

function uploadOne(file, dir, attempt, onProgress) {
  return new Promise((resolve, reject) => {
    const target = joinPath(dir, file.name).replace(/^\//, "");
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", "/api/upload?path=" + encodeURIComponent(target));
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(JSON.parse(xhr.responseText || "{}"));
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

function queueItem(file, dir) {
  const el = document.createElement("div");
  el.className = "queue-item";
  el.innerHTML = `<div class="meta"><span class="nm">${escapeHtml(file.name)} · ${fmtSize(file.size)}</span>
    <span class="st">等待</span><button class="retry ghost hidden">重试</button></div>
    <div class="bar"><i></i></div>`;
  $("queue").appendChild(el);
  const bar = el.querySelector(".bar");
  const fill = el.querySelector("i");
  const st = el.querySelector(".st");
  const retryBtn = el.querySelector(".retry");

  const run = async (attempt) => {
    retryBtn.classList.add("hidden");
    bar.classList.remove("err", "warn");
    st.textContent = attempt ? `重试 ${attempt}/${RETRY_DELAYS.length}` : "上传中";
    try {
      await uploadOne(file, dir, attempt, (p) => {
        fill.style.width = (p * 100).toFixed(1) + "%";
        st.textContent = (p * 100).toFixed(0) + "%";
      });
      fill.style.width = "100%";
      st.textContent = "完成";
      bar.style.opacity = ".5";
      // 成功后自动收起，避免队列越积越长；失败项保留以便手动重试
      setTimeout(() => {
        el.classList.add("done");
        setTimeout(() => el.remove(), 500);
      }, 2200);
    } catch (err) {
      if (err.retryable && attempt < RETRY_DELAYS.length) {
        bar.classList.add("warn");
        st.textContent = `${err.code || "ERR"}，${RETRY_DELAYS[attempt] / 1000}s 后重试`;
        setTimeout(() => { bar.classList.remove("warn"); fill.style.width = "0"; run(attempt + 1); }, RETRY_DELAYS[attempt]);
        return;
      }
      bar.classList.add("err");
      fill.style.width = "100%";
      st.textContent = (err.code || "失败") + "：" + err.message;
      retryBtn.classList.remove("hidden");
      toast("上传失败：" + file.name + " · " + err.message);
    }
  };
  retryBtn.addEventListener("click", () => { fill.style.width = "0"; run(0); });
  return run(0);
}

async function uploadFiles(files) {
  if (!files.length) return;
  const dir = state.cwd; // 上传过程中翻目录也不会传错地方
  for (const f of files) await queueItem(f, dir);
  await loadList();
}

$("pickFile").addEventListener("click", (ev) => { ev.preventDefault(); $("fileInput").click(); });
$("fileInput").addEventListener("change", (ev) => {
  uploadFiles([...ev.target.files]).catch((e) => toast("上传出错：" + e.message));
  ev.target.value = "";
});
const drop = $("drop");
["dragenter", "dragover"].forEach((n) => drop.addEventListener(n, (ev) => { ev.preventDefault(); drop.classList.add("hot"); }));
["dragleave", "drop"].forEach((n) => drop.addEventListener(n, (ev) => { ev.preventDefault(); drop.classList.remove("hot"); }));
drop.addEventListener("drop", (ev) => uploadFiles([...ev.dataTransfer.files]).catch((e) => toast("上传出错：" + e.message)));

window.addEventListener("scroll", () => {
  document.querySelector("header").classList.toggle("stuck", window.scrollY > 4);
}, { passive: true });

// 安卓返回键：先关查看器，再退一层目录，都没有才让 App 退出
window.vaultdBack = () => {
  if (!$("viewer").classList.contains("hidden")) {
    closeViewer();
    return true;
  }
  if (state.cwd) {
    state.cwd = state.cwd.split("/").slice(0, -1).join("/");
    loadList().catch((err) => toast("返回失败：" + err.message));
    return true;
  }
  return false;
};

(async function boot() {
  try {
    await loadStatus();
    if (state.configured) await loadList();
  } catch (e) {
    console.error(e);
  }
})();
