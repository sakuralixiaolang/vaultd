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
  cache: {}, // path -> {at, entries, path}：来回翻目录不用重新请求
  renderKey: "",
  limit: 80, // 一屏先画这么多，剩下的滚到底再追加，几百个文件也不卡
  showDel: localStorage.getItem("vaultd.showDel") === "1", // 默认藏起 ×，防误删
  viewer: { items: [], index: -1, zoom: false },
};
document.body.classList.toggle("show-del", state.showDel);
const $ = (id) => document.getElementById(id);

// ---------- 主题：默认跟随系统，手动切过就记住 ----------
const THEME_KEY = "vaultd.theme";
function systemTheme() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === "light" ? "#f2f5f8" : "#0f1419";
  const btn = $("btnTheme");
  if (btn) {
    btn.textContent = t === "light" ? "☾" : "☀";
    btn.title = t === "light" ? "切到深色" : "切到浅色";
  }
}
applyTheme(localStorage.getItem(THEME_KEY) || systemTheme());

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
// 网格里只放得下「日期」，时间留给列表/详情
const fmtDay = (s) => {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// 懒执行：元素滚到视口附近才真正去请求缩略图/抽帧。
// 一屏 100 个文件时，这一步能把首屏的图片请求从 100 个压到 10 来个。
let nearObserver = null;
function whenNear(el, fn) {
  if (!el) return;
  if (!("IntersectionObserver" in window)) { fn(); return; }
  if (!nearObserver) {
    nearObserver = new IntersectionObserver((ents) => {
      for (const en of ents) {
        if (!en.isIntersecting) continue;
        nearObserver.unobserve(en.target);
        const cb = en.target.__near;
        if (cb) { delete en.target.__near; cb(); }
      }
    }, { rootMargin: "600px 0px 600px 0px" });
  }
  el.__near = fn;
  nearObserver.observe(el);
}
const joinPath = (dir, name) => "/" + [dir.replace(/\/+$/, ""), name].filter(Boolean).join("/").replace(/^\/+/, "");

let toastTimer = 0;
function toast(msg, kind = "err") {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

// 轻量的删除确认（不用 window.confirm：WebView 里容易不弹）
let askResolve = null;
function askOpen(text, yesLabel, withInput, initValue) {
  const box = $("ask");
  $("askText").textContent = text;
  $("askYes").textContent = yesLabel;
  const inp = $("askInput");
  inp.classList.toggle("hidden", !withInput);
  if (withInput) {
    inp.value = initValue || "";
    inp.placeholder = "输入名称";
  }
  box.classList.remove("hidden");
  if (withInput) setTimeout(() => inp.focus(), 50);
  return new Promise((resolve) => {
    askResolve = resolve;
  });
}
function askDelete(name) {
  return askOpen("删除「" + name + "」？这个操作不能撤销。", "删除", false, "");
}
function askInput(text, value) {
  return askOpen(text, "确定", true, value);
}
(function bindAsk() {
  const done = (ok) => {
    $("ask").classList.add("hidden");
    const withInput = !$("askInput").classList.contains("hidden");
    const val = $("askInput").value;
    $("askYes").textContent = "删除";
    const r = askResolve;
    askResolve = null;
    if (!r) return;
    if (withInput) r(ok ? (val || "") : null);
    else r(!!ok);
  };
  $("askYes").addEventListener("click", () => done(true));
  $("askNo").addEventListener("click", () => done(false));
  $("askInput").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); done(true); }
  });
  $("ask").addEventListener("click", (ev) => { if (ev.target === $("ask")) done(false); });
})();

// 长按删除：按住约 0.6 秒（手指稍微动一下就取消，不影响正常点击）
function bindLongPress(el, entry) {
  let timer = null;
  let sx = 0;
  let sy = 0;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    el.classList.remove("pressing");
  };
  el.addEventListener("pointerdown", (ev) => {
    if (ev.target.classList.contains("kill") || ev.target.classList.contains("del")) return;
    sx = ev.clientX;
    sy = ev.clientY;
    el.classList.add("pressing");
    timer = setTimeout(() => {
      timer = null;
      el.classList.remove("pressing");
      el.__lp = true; // 长按已经处理过了，抬起时别再当成一次点击
      removeEntry(entry);
    }, 600);
  });
  el.addEventListener("click", (ev) => {
    if (el.__lp) {
      el.__lp = false;
      ev.stopPropagation();
      ev.preventDefault();
    }
  }, true);
  el.addEventListener("pointermove", (ev) => {
    if (Math.abs(ev.clientX - sx) > 12 || Math.abs(ev.clientY - sy) > 12) clear();
  });
  el.addEventListener("pointerup", clear);
  el.addEventListener("pointercancel", clear);
  el.addEventListener("pointerleave", clear);
  el.addEventListener("contextmenu", (ev) => ev.preventDefault());
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
  $("setupPanel").classList.toggle("hidden", !state.setupTouched && !!s.configured && !!s.vault_ready);
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

async function loadList(opts) {
  const force = !!(opts && opts.force);
  const cached = state.cache[state.cwd];
  if (!force && cached && Date.now() - cached.at < 8000) {
    state.entries = cached.entries;
    showPath(cached.path);
    $("btnUp").disabled = state.cwd === "";
    paintCount();
    refreshTargetOptions();
    renderList();
    return;
  }
  const r = await api("/api/list?path=" + encodeURIComponent(state.cwd));
  state.entries = r.entries || [];
  state.cache[state.cwd] = { at: Date.now(), entries: state.entries, path: r.path || "/" };
  showPath(r.path || "/");
  $("btnUp").disabled = state.cwd === "";
  paintCount();
  refreshTargetOptions();
  renderList();
  // 列表既然拉到了，说明后台自己连上了；把状态与错误面板同步过来，
  // 否则手机开机网络晚到时会一直挂着「连接失败」的提示。
  if (state.vaultReady === false) {
    state.vaultReady = true;
    loadStatus().catch(() => {});
  }
}

function paintCount() {
  const dirs = state.entries.filter((e) => e.dir).length;
  const files = state.entries.length - dirs;
  $("count").textContent = state.entries.length ? `${dirs} 目录 · ${files} 文件` : "";
}

function showPath(p) {
  $("pathbar").textContent = p === "/" ? "根目录 /" : p;
  $("pathbar").title = p;
}

// 「上传到」下拉：当前目录 + 当前目录下的子文件夹 + 新建文件夹。
// 选新建时才露出输入框，避免平时多占一行。
function refreshTargetOptions() {
  const sel = $("upFolder");
  if (!sel) return;
  const keep = sel.value;
  const dirs = state.entries.filter((e) => e.dir).map((e) => e.name);
  const cur = state.cwd ? "/" + state.cwd : "根目录";
  sel.innerHTML = `<option value="">当前目录（${escapeHtml(cur)}）</option>` +
    dirs.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}/</option>`).join("") +
    `<option value="__new__">＋ 新建文件夹…</option>`;
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  syncNewFolderUI();
}

function syncNewFolderUI() {
  const sel = $("upFolder");
  const wrap = $("newFolderWrap");
  if (!sel || !wrap) return;
  const isNew = sel.value === "__new__";
  wrap.classList.toggle("hidden", !isNew);
  if (isNew && !$("newFolderName").value) {
    const d = new Date();
    $("newFolderName").value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
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

function renderKey() {
  return [
    state.cwd, state.view, state.sort, state.filter,
    state.entries.length,
    state.entries.map((e) => e.path + "|" + e.size + "|" + (e.mod_time || "")).join("\n"),
  ].join("#");
}

function renderList(force) {
  const key = renderKey();
  if (!force && key === state.renderKey && $("list").childElementCount) {
    return; // 内容没变就别重建 DOM：滚动位置、已解码的缩略图都能保住
  }
  state.renderKey = key;
  const box = $("list");
  box.className = "album" + (state.view === "list" ? " list-mode" : "");
  box.innerHTML = "";
  vidThumbBudget = 24; // 每次重绘重置：视频抽帧有网络+解码成本，超量只留图标
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
  const frag = document.createDocumentFragment();
  const lk = state.cwd + "#" + state.view + "#" + state.sort + "#" + state.filter;
  if (state.limitFor !== lk) {
    state.limitFor = lk;
    state.limit = 80;
  }
  for (const e of shown.slice(0, state.limit)) {
    frag.appendChild(state.view === "grid" ? tileEl(e) : rowEl(e));
  }
  box.appendChild(frag);
  paintMore(shown);
}

// 一屏之外的先不建 DOM：几百个文件时首屏直接快一截，滚到底再追加 80 个。
function paintMore(shown) {
  const box = $("list");
  const old = box.querySelector(".more");
  if (old) old.remove();
  if (shown.length <= state.limit) return;
  const btn = document.createElement("button");
  btn.className = "more ghost tap";
  btn.style.gridColumn = "1 / -1";
  btn.style.marginTop = "8px";
  btn.textContent = `显示更多（还有 ${shown.length - state.limit} 项）`;
  btn.addEventListener("click", () => {
    const from = state.limit;
    state.limit += 80;
    const frag = document.createDocumentFragment();
    for (const e of shown.slice(from, state.limit)) {
      frag.appendChild(state.view === "grid" ? tileEl(e) : rowEl(e));
    }
    box.insertBefore(frag, btn);
    paintMore(shown);
  });
  box.appendChild(btn);
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

// 视频缩略图：让 WebView 自己解码出一帧。网关支持 Range，只读前面一小段，
// 不会为了一个格子把整段视频拉下来。
// 注意：不能只 seek 后直接丢进格子——部分 WebView（尤其软件渲染）只解码不合成，
// 屏幕上会留一块黑；所以这里用「静音自动播放 → 拿到一帧立刻暂停 → 画进 canvas」，
// 画出来的像素是确定的。
let vidThumbBudget = 24;
function attachVideoThumb(host, e, cls) {
  if (!host || vidThumbBudget <= 0) return;
  vidThumbBudget--;
  const v = document.createElement("video");
  v.className = cls;
  v.muted = true;
  v.playsInline = true;
  v.setAttribute("muted", "");
  v.setAttribute("playsinline", "");
  v.setAttribute("webkit-playsinline", "");
  v.preload = "auto";
  v.src = streamURL(e) + "#t=0.6";

  let done = false;
  let hard = 0;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(hard);
    const side = Math.min(v.videoWidth || 0, v.videoHeight || 0);
    if (side && v.readyState >= 2) {
      const size = cls === "row-vid" ? 120 : 320;
      const c = document.createElement("canvas");
      c.width = c.height = size;
      c.className = cls;
      try {
        c.getContext("2d").drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, size, size);
        host.classList.add("filled");
        host.prepend(c);
      } catch (_) { /* 抽帧失败就保留原来的图标 */ }
    }
    try { v.pause(); } catch (_) {}
    v.removeAttribute("src");
    try { v.load(); } catch (_) {}
    v.remove(); // 解码器立刻放掉，一屏几十个视频不会一直占内存
  };

  const grab = () => {
    try { v.play().catch(finish); } catch (_) { return finish(); }
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(finish);
    else setTimeout(finish, 400);
    setTimeout(finish, 3000); // 兜底：拿不到帧就退回图标，别留一块黑
  };

  v.addEventListener("loadedmetadata", () => {
    try {
      const t = Math.min(1.2, (v.duration && isFinite(v.duration) ? v.duration : 2) / 3);
      v.currentTime = Math.max(0.2, t);
    } catch (_) { /* 有的格式不给 seek，就从头播一帧 */ }
  });
  v.addEventListener("loadeddata", grab, { once: true });
  v.addEventListener("error", finish);
  // loadeddata 有时候干脆不来（弱网/解码器忙），留个硬超时兜底，
  // 免得格子里一直挂着一个不放的 video 元素。
  hard = setTimeout(finish, 9000);
  host.prepend(v);
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
    <div class="tile-size">${e.dir ? "文件夹" : fmtSize(e.size) + (e.mod_time ? " · " + fmtDay(e.mod_time) : "")}</div></div>`;
  if (isImage(e.name)) {
    // 缩略图等滚到附近再请求：一屏几十个格子同时解码会把手机卡住。
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      const holder = el.querySelector(".tile-ph");
      if (!holder) return;
      holder.classList.add("filled");
      holder.textContent = "";
      holder.appendChild(img);
    };
    img.onerror = () => {};
    whenNear(el, () => { img.src = thumbURL(e, 400); });
  } else if (isVideo(e.name)) {
    whenNear(el, () => attachVideoThumb(el.querySelector(".tile-ph"), e, "tile-vid"));
  }
  el.addEventListener("click", (ev) => {
    if (ev.target.classList.contains("kill")) return;
    e.dir ? openDir(e.name) : openViewer(e);
  });
  el.querySelector(".kill").addEventListener("click", (ev) => { ev.stopPropagation(); removeEntry(e); });
  bindLongPress(el, e);
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
  if (!e.dir && isVideo(e.name)) whenNear(el, () => attachVideoThumb(el.querySelector(".thumb"), e, "row-vid"));
  el.addEventListener("click", (ev) => {
    if (ev.target.classList.contains("del")) return;
    e.dir ? openDir(e.name) : openViewer(e);
  });
  el.querySelector(".del").addEventListener("click", (ev) => { ev.stopPropagation(); removeEntry(e); });
  bindLongPress(el, e);
  return el;
}

async function removeEntry(e) {
  if (!(await askDelete(e.name))) return;
  try {
    await api("/api/delete?path=" + encodeURIComponent(e.path), { method: "POST" });
    toast("已删除 " + e.name, "ok");
    if (state.viewer.index >= 0) closeViewer();
    await loadList({ force: true });
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

$("btnRefresh").addEventListener("click", () => loadList({ force: true }).catch((err) => toast("刷新失败：" + err.message)));
$("btnUp").addEventListener("click", () => {
  state.cwd = state.cwd.split("/").slice(0, -1).join("/");
  loadList().catch((err) => toast("返回失败：" + err.message));
});
$("pathbar").addEventListener("click", () => {
  if (!state.cwd) return;
  state.cwd = "";
  loadList().catch((err) => toast("返回失败：" + err.message));
});
$("btnSetup").addEventListener("click", () => {
  state.setupTouched = true; // 用户手动开过设置，之后状态刷新别再把它关掉
  $("setupPanel").classList.toggle("hidden");
});

// 设置面板切成「接入 / 备份 / 界面」三页，避免一屏滚到底
function setTab(name) {
  $("tabConnect").classList.toggle("hidden", name !== "connect");
  $("tabBackup").classList.toggle("hidden", name !== "backup");
  $("tabUI").classList.toggle("hidden", name !== "ui");
  $("btnTabConnect").classList.toggle("on", name === "connect");
  $("btnTabBackup").classList.toggle("on", name === "backup");
  $("btnTabUi").classList.toggle("on", name === "ui");
  if (name === "backup") loadAlbumCatalog();
}
$("btnTabConnect").addEventListener("click", () => setTab("connect"));
$("btnTabBackup").addEventListener("click", () => setTab("backup"));
$("btnTabUi").addEventListener("click", () => setTab("ui"));

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
    await loadList({ force: true });
    toast("已连接云端", "ok");
    $("keyfp").textContent = r && r.fingerprint ? "密钥 " + r.fingerprint + "…" : $("keyfp").textContent;
  } catch (err) {
    $("cloudMsg").textContent = "失败：" + err.message;
    toast("接入失败：" + err.message);
    // 服务端是「先落盘再连接」，所以失败时配置其实已经写进去了。
    // 这里补一次状态刷新，否则顶部指纹还停在导入前那把新钥匙，看着像密钥没搬过来。
    try { await loadStatus(); } catch (_) {}
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
    await loadList({ force: true });
    toast("已连接 WebDAV", "ok");
  } catch (err) {
    $("setupMsg").textContent = "失败：" + err.message;
    toast("接入失败：" + err.message);
    state.xferKeys = null; // 配置已写进服务端，密钥不再挂在状态上，避免下次重复提交
    try { await loadStatus(); } catch (_) {}
  }
});

// ---------- 上传：流式 + 进度 + 自动重试 + 手动重试 ----------

const RETRY_DELAYS = [1000, 3000, 8000];

function uploadOne(file, dir, attempt, onProgress) {
  return new Promise((resolve, reject) => {
    const target = joinPath(dir, file.name).replace(/^\//, "");
    const xhr = new XMLHttpRequest();
    const mt = file.lastModified ? "&mtime=" + Math.floor(file.lastModified / 1000) : "";
    xhr.open("PUT", "/api/upload?path=" + encodeURIComponent(target) + mt);
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
  let dir;
  try {
    dir = await resolveUploadDir();
  } catch (e) {
    toast("上传目标无效：" + e.message);
    return;
  }
  for (const f of files) await queueItem(f, dir);
  if ($("upFolder").value === "__new__") {
    $("newFolderName").value = "";
    $("upFolder").value = "";
    syncNewFolderUI();
  }
  await loadList();
}

async function resolveUploadDir() {
  const sel = $("upFolder") ? $("upFolder").value : "";
  if (sel === "__new__") {
    const name = $("newFolderName").value.trim();
    if (!name) throw new Error("先填新文件夹名");
    if (name.includes("/") || name.includes("\\")) throw new Error("文件夹名不能带斜杠");
    const p = joinPath(state.cwd, name).replace(/^\//, "");
    await api("/api/mkdir?path=" + encodeURIComponent(p), { method: "POST" });
    return p;
  }
  return sel ? joinPath(state.cwd, sel).replace(/^\//, "") : state.cwd;
}

$("btnMkdir").addEventListener("click", async () => {
  const d = new Date();
  const suggest = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const name = await askInput("新建文件夹（在当前目录下）", suggest);
  if (name === null || !name.trim()) return;
  try {
    const p = joinPath(state.cwd, name.trim()).replace(/^\//, "");
    await api("/api/mkdir?path=" + encodeURIComponent(p), { method: "POST" });
    toast("已创建 " + name.trim(), "ok");
    await loadList({ force: true });
  } catch (err) {
    toast("创建失败：" + err.message);
  }
});

$("upFolder").addEventListener("change", syncNewFolderUI);
$("btnTheme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

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

// ---------- 相册自动同步（只有安卓原生桥才有；PC 上整块隐藏） ----------
let syncCur = { enabled: false, dir: "相册备份", wifiOnly: false, result: "", hasPermission: true, gateway: true };

function applySyncState(st) {
  syncCur = st;
  $("syncState").textContent = st.enabled ? "运行中" : "未开启";
  $("btnSyncToggle").textContent = st.enabled ? "关闭自动同步" : "开启自动同步";
  $("btnSyncToggle").classList.toggle("primary", !st.enabled);
  $("syncDir").value = st.dir || "相册备份";
  $("btnSyncWifi").textContent = "仅 Wi-Fi：" + (st.wifiOnly ? "开" : "关");
  $("btnSyncPerm").classList.toggle("hidden", !!st.hasPermission);
  $("syncMsg").textContent = st.result || "";
  $("btnSyncKeep").textContent = "按相册名分文件夹：" + (st.keepAlbum === false ? "关" : "开");
  renderAlbumPicks(st.albums || []);
  syncToggle("btnContacts", !!st.contacts);
  syncToggle("btnSms", !!st.sms);
  syncToggle("btnCalls", !!st.calls);
  const needPerm = !st.hasPermission || !st.hasContacts || !st.hasSms || !st.hasCalls;
  $("btnPermAll").classList.toggle("hidden", !needPerm);
  $("btnSyncPerm").classList.toggle("hidden", !needPerm);
}

function syncToggle(id, on) {
  const b = $(id);
  if (!b) return;
  b.textContent = on ? "开" : "关";
  b.classList.toggle("on", on);
  b.classList.toggle("primary", on);
}

// 相册勾选：不选＝全部；点一下切换。选中的相册在云端各建一个同名文件夹。
let albumCatalog = [];
let albumSelected = [];

function renderAlbumPicks(selected) {
  albumSelected = Array.isArray(selected) ? selected.slice() : [];
  const box = $("albumPicks");
  if (!albumCatalog.length) {
    box.innerHTML = `<span class="muted">${window.Sync && !syncCur.hasPermission ? "先点上面「授权访问相册」" : "还没有扫到相册"}</span>`;
    return;
  }
  box.innerHTML = "";
  for (const a of albumCatalog) {
    const on = albumSelected.includes(a.name);
    const b = document.createElement("button");
    b.className = "pick tap" + (on ? " on" : "");
    b.innerHTML = `<span class="tick">${on ? "✓" : "○"}</span><span>${escapeHtml(a.name)}</span><span class="n">${a.count}</span>`;
    b.addEventListener("click", () => {
      const i = albumSelected.indexOf(a.name);
      if (i >= 0) albumSelected.splice(i, 1);
      else albumSelected.push(a.name);
      saveAlbums();
    });
    box.appendChild(b);
  }
}

function saveAlbums() {
  try {
    applySyncState(JSON.parse(window.Sync.setAlbums(JSON.stringify(albumSelected))));
    toast(albumSelected.length ? "只备份：" + albumSelected.join("、") : "备份全部相册", "ok");
  } catch (e) {
    toast("设置失败：" + e.message);
  }
}

function loadAlbumCatalog() {
  if (!window.Sync) return;
  try {
    albumCatalog = JSON.parse(window.Sync.albums()) || [];
  } catch (e) {
    albumCatalog = [];
  }
  renderAlbumPicks(albumSelected);
}

function refreshSyncState() {
  if (!window.Sync) return;
  try {
    applySyncState(JSON.parse(window.Sync.state()));
  } catch (e) { /* 桥还没挂上时忽略 */ }
}

window.onSyncUpdate = function (msg) {
  $("syncMsg").textContent = msg || "";
  refreshSyncState();
};

function initSyncUI() {
  const box = $("syncBox");
  if (!window.Sync) {
    box.classList.add("hidden");
    // PC 端没有系统相册/短信这些数据源，整个「备份」页直接藏掉
    $("btnTabBackup").classList.add("hidden");
    $("tabBackup").classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  refreshSyncState();
  $("btnSyncToggle").addEventListener("click", () => {
    try {
      applySyncState(JSON.parse(window.Sync.setEnabled(!syncCur.enabled)));
      toast(syncCur.enabled ? "自动同步已开启" : "自动同步已关闭", "ok");
    } catch (e) {
      toast("切换失败：" + e.message);
    }
  });
  $("btnSyncNow").addEventListener("click", () => {
    $("syncMsg").textContent = "同步中…";
    try { window.Sync.syncNow(); } catch (e) { toast("同步失败：" + e.message); }
  });
  $("btnSyncPerm").addEventListener("click", () => {
    try { window.Sync.requestPermissions(); } catch (e) { toast("授权失败：" + e.message); }
  });
  $("btnSyncWifi").addEventListener("click", () => {
    try {
      applySyncState(JSON.parse(window.Sync.setWifiOnly(!syncCur.wifiOnly)));
    } catch (e) { toast("设置失败：" + e.message); }
  });
  $("syncDir").addEventListener("change", () => {
    try {
      applySyncState(JSON.parse(window.Sync.setDir($("syncDir").value)));
      toast("同步目录已改为：" + syncCur.dir, "ok");
    } catch (e) { toast("设置失败：" + e.message); }
  });
  $("btnSyncKeep").addEventListener("click", () => {
    try {
      applySyncState(JSON.parse(window.Sync.setKeepAlbum(!(syncCur.keepAlbum !== false))));
      toast(syncCur.keepAlbum !== false ? "云端按相册名分文件夹" : "全部平铺在同步目录里", "ok");
    } catch (e) { toast("设置失败：" + e.message); }
  });
  $("btnAlbumsAll").addEventListener("click", () => {
    albumSelected = [];
    saveAlbums();
  });
  const bindKind = (id, setter, key, label) => {
    $(id).addEventListener("click", () => {
      try {
        applySyncState(JSON.parse(window.Sync[setter](!syncCur[key])));
        toast(label + (syncCur[key] ? "已加入备份" : "已暂停备份"), "ok");
      } catch (e) { toast("设置失败：" + e.message); }
    });
  };
  bindKind("btnContacts", "setContacts", "contacts", "通讯录");
  bindKind("btnSms", "setSms", "sms", "短信");
  bindKind("btnCalls", "setCalls", "calls", "通话记录");
  $("btnPermAll").addEventListener("click", () => {
    try { window.Sync.requestPermissions(); } catch (e) { toast("授权失败：" + e.message); }
  });
  // 打开设置面板时才去扫相册，避免开机就白跑一趟 MediaStore
  $("setupPanel").addEventListener("click", () => loadAlbumCatalog(), { once: true });
  // 面板开着的时候隔几秒刷一次状态（同步是后台线程跑，只能轮询）
  setInterval(() => {
    if ($("setupPanel").classList.contains("hidden")) return;
    refreshSyncState();
    if (syncCur.hasPermission && !albumCatalog.length) loadAlbumCatalog();
  }, 5000);
}
initSyncUI();

function applyShowDel() {
  document.body.classList.toggle("show-del", state.showDel);
  const b = $("btnShowDel");
  if (b) b.textContent = "显示删除按钮（×）：" + (state.showDel ? "开" : "关");
}

(function initUiPrefs() {
  $("uiBox").classList.remove("hidden");
  applyShowDel();
  $("btnShowDel").addEventListener("click", () => {
    state.showDel = !state.showDel;
    localStorage.setItem("vaultd.showDel", state.showDel ? "1" : "0");
    applyShowDel();
    toast(state.showDel ? "已显示删除按钮" : "已隐藏删除按钮，长按文件才能删", "ok");
  });
})();

(async function boot() {
  try {
    await loadStatus();
  } catch (e) {
    console.error(e);
  }
  if (!state.configured) return;
  // 手机开机后 DNS/网络常常比 App 晚到手，首次列表很容易失败。
  // 这里自带退避重试，免得用户对着空白的媒体库以为坏了。
  for (let i = 0; i < 5; i++) {
    try {
      await loadList({ force: true });
      return;
    } catch (e) {
      console.error(e);
      if (i === 4) toast("列表加载失败：" + e.message);
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
})();


