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
  cache: {}, // path -> {at, entries, path}：来回翻目录、冷启动都先拿它顶上
  pendingScroll: false,
  renderKey: "",
  limit: 80, // 一屏先画这么多，剩下的滚到底再追加，几百个文件也不卡
  showDel: localStorage.getItem("vaultd.showDel") === "1", // 默认藏起 ×，防误删
  viewer: { items: [], index: -1, zoom: false },
  navSeq: 0, // 目录请求序号：连续点目录时，只让最后一次请求上屏
  selecting: false,
  selected: new Set(),
};
document.body.classList.toggle("show-del", state.showDel);
const $ = (id) => document.getElementById(id);
// 这些键名必须在读取缓存之前就初始化，否则会撞上 const 的暂时性死区。
const LC_KEY = "vaultd.listcache.v1";
const CWD_KEY = "vaultd.cwd";
const SCROLL_KEY = "vaultd.scroll.v1";
state.cache = loadDiskCache();
state.cwd = readCwd();
state.pendingScroll = true; // 冷启动也恢复上次滚动位置

// ---------- 主题：默认跟随系统，手动切过就记住（同时写进原生设置，冷启动窗口底色一致） ----------
const THEME_KEY = "vaultd.theme";
function systemTheme() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function savedTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || (window.Sync && Sync.getTheme && Sync.getTheme()) || "";
  } catch (e) {
    return "";
  }
}
function applyTheme(t, remember) {
  if (t !== "light" && t !== "dark") t = systemTheme();
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === "light" ? "#f2f5f8" : "#0f1419";
  const btn = $("btnTheme");
  if (btn) {
    btn.textContent = t === "light" ? "☾" : "☀";
    btn.title = t === "light" ? "切到深色" : "切到浅色";
  }
  // 只有用户手动切换才写进原生设置；跟随系统时保持为空，系统换了还能跟着换。
  if (remember && window.Sync && Sync.setTheme) {
    try { Sync.setTheme(t); } catch (e) {}
  }
}
applyTheme(savedTheme() || systemTheme(), false);
function themeMode() {
  return savedTheme() || "auto";
}
function renderThemeMode() {
  const m = themeMode();
  const map = { auto: "btnThemeAuto", dark: "btnThemeDark", light: "btnThemeLight" };
  Object.keys(map).forEach((k) => {
    const b = $(map[k]);
    if (b) b.classList.toggle("on", m === k);
  });
}
function setThemeMode(m) {
  try {
    if (m === "auto") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, m);
  } catch (e) { /* 隐私模式可能禁用存储，忽略 */ }
  if (m === "auto" && window.Sync && Sync.setTheme) {
    try { Sync.setTheme(""); } catch (e) {}
  }
  applyTheme(m === "auto" ? systemTheme() : m, m !== "auto");
  renderThemeMode();
}
// 原生侧改了系统深浅色（Activity 不重建）时回调这里：只有用户没手动选过才跟随。
window.vaultdThemeFromSystem = () => {
  if (!savedTheme()) applyTheme(systemTheme(), false);
  renderThemeMode();
  return document.documentElement.dataset.theme;
};

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
const parentOf = (p) => {
  const s = String(p || "").replace(/^\/+|\/+$/g, "");
  const i = s.lastIndexOf("/");
  return i < 0 ? "" : "/" + s.slice(0, i);
};
const baseOf = (p) => String(p || "").replace(/^\/+|\/+$/g, "").split("/").pop();
const normDir = (p) => String(p || "").replace(/^\/+|\/+$/g, "");
const sameDir = (a, b) => normDir(a) === normDir(b);

let busyDepth = 0;
function showBusy(text) {
  busyDepth++;
  $("busyText").textContent = text || "正在处理…";
  $("busy").classList.remove("hidden");
}
function setBusy(text) {
  $("busyText").textContent = text || "正在处理…";
}
function hideBusy() {
  busyDepth = Math.max(0, busyDepth - 1);
  if (!busyDepth) $("busy").classList.add("hidden");
}

// ---------- 跨启动缓存：列表 + 上次目录 + 滚动位置 ----------
// 网关端口现在是固定的，localStorage 才能真的留住；这样冷启动先拿旧列表画一屏，
// 再在后台刷新，看起来就是「秒开」。
function loadDiskCache() {
  try {
    const m = JSON.parse(localStorage.getItem(LC_KEY) || "{}");
    return m && typeof m === "object" ? m : {};
  } catch (e) {
    return {};
  }
}
function saveDiskCache() {
  try {
    const keys = Object.keys(state.cache)
      .sort((a, b) => (state.cache[b].at || 0) - (state.cache[a].at || 0))
      .slice(0, 8);
    const out = {};
    for (const k of keys) {
      const c = state.cache[k];
      const entries = (c.entries || []).slice(0, 600).map((e) => ({
        name: e.name, path: e.path, dir: !!e.dir, size: e.size, mod_time: e.mod_time,
      }));
      out[k] = { at: c.at, path: c.path, entries };
    }
    localStorage.setItem(LC_KEY, JSON.stringify(out));
  } catch (e) {
    // 配额满了就放弃缓存，不影响使用
    try { localStorage.removeItem(LC_KEY); } catch (e2) {}
  }
}
function readCwd() {
  try { return localStorage.getItem(CWD_KEY) || ""; } catch (e) { return ""; }
}
function saveCwd() {
  try { localStorage.setItem(CWD_KEY, state.cwd || ""); } catch (e) {}
}
function readScrollMap() {
  try { return JSON.parse(localStorage.getItem(SCROLL_KEY) || "{}") || {}; } catch (e) { return {}; }
}
function saveScroll() {
  try {
    const m = readScrollMap();
    m[state.cwd || "/"] = window.scrollY || 0;
    const keys = Object.keys(m).slice(-16);
    const out = {};
    for (const k of keys) out[k] = m[k];
    localStorage.setItem(SCROLL_KEY, JSON.stringify(out));
  } catch (e) {}
}
let scrollTimer = 0;
window.addEventListener("scroll", () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(saveScroll, 250);
}, { passive: true });

function restoreScroll() {
  if (!state.pendingScroll) return;
  state.pendingScroll = false;
  const y = readScrollMap()[state.cwd || "/"] || 0;
  if (!y) return;
  requestAnimationFrame(() => window.scrollTo(0, y));
}

// 进目录统一走这里：先记住当前滚动位置，再记住目录，回来时原样恢复。
function goTo(dir, opts) {
  const bypass = !!(opts && opts.bypass);
  if (!bypass && isPrivatePath(dir) && !folderUnlocked) {
    if (!$("lockScreen").classList.contains("hidden")) return;
    showLock("folder", "进入「" + baseOf(lockInfo.folder_path) + "」需要验证").then((ok) => {
      if (!ok) return;
      folderUnlocked = true;
      goTo(dir, { bypass: true });
    });
    return;
  }
  if (folderUnlocked && !isPrivatePath(dir)) folderUnlocked = false;
  saveScroll();
  state.cwd = dir || "";
  state.navSeq++;
  state.pendingScroll = true;
  saveCwd();
  loadList().catch((err) => toast("打开目录失败：" + err.message));
}

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
  const yesBtn = $("askYes");
  yesBtn.textContent = yesLabel;
  yesBtn.classList.toggle("danger", yesLabel === "删除");
  yesBtn.classList.toggle("primary", yesLabel !== "删除");
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
function askInput(text, value, yesLabel) {
  return askOpen(text, yesLabel || "确定", true, value);
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
      if (state.selecting) toggleSelected(entry);
      else removeEntry(entry);
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
  window.__statusAt = window.__statusAt || Math.round(performance.now());
  applyStatus(s);
  return s;
}

function applyStatus(s) {
  state.configured = s.configured;
  state.vaultReady = !!s.vault_ready;
  $("keyfp").textContent = s.key_fingerprint ? "密钥指纹 " + s.key_fingerprint + "…" : "还没有配置密钥";
  const dot = $("health");
  dot.className = "dot " + (s.vault_ready ? "ok" : s.configured ? "err" : "");
  // 顶栏只留一句人话状态，细节放设置里的「云端连接」
  const stText = $("statusText");
  if (stText) {
    stText.textContent = s.vault_ready ? "已连接" : s.configured ? "连接失败" : "未接入";
    stText.className = "status-pill " + (s.vault_ready ? "ok" : s.configured ? "err" : "");
  }
  const connLine = $("connLine");
  if (connLine) {
    const modeName = (s.backend || "").indexOf("内置") === 0 ? "中国移动云盘（内置直连）" : (s.backend || "未选择方式");
    connLine.textContent = modeName + (s.configured ? " · 配置已保存" : " · 还没有配置");
  }
  const connBadge = $("connBadge");
  if (connBadge) {
    connBadge.textContent = s.vault_ready ? "已连接" : s.configured ? "连接失败" : "未接入";
    connBadge.className = "badge " + (s.vault_ready ? "ok" : s.configured ? "err" : "");
  }
  // 没配好或连不上时自动打开设置；用户手动开过之后就尊重他的选择，不再抢焦点
  if (!state.setupTouched) {
    const needSetup = !s.configured || !s.vault_ready;
    $("setupPanel").classList.toggle("hidden", !needSetup);
    if (needSetup) setTab("connect");
  }
  syncModalState();
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

function applyEntries(entries, serverPath) {
  if (!window.__firstListAt) window.__firstListAt = Math.round(performance.now());
  state.shownDir = state.cwd; // 界面此刻真正显示的目录，请求失败时回退到它
  state.entries = entries || [];
  showPath(serverPath || "/");
  $("btnUp").disabled = state.cwd === "";
  paintCount();
  refreshTargetOptions();
  renderList();
  restoreScroll();
  if ($("setupPanel") && !$("setupPanel").classList.contains("hidden")) renderSetupFiles();
}

async function loadList(opts) {
  const force = !!(opts && opts.force);
  const quiet = !!(opts && opts.quiet);
  const dir = state.cwd;
  const seq = state.navSeq;
  const cached = state.cache[dir];
  const fresh = cached && Date.now() - (cached.at || 0) < 8000;
  // 有缓存就先画：新到 8 秒内的直接用；更旧的在后台悄悄刷新，页面不空等。
  if (!force && cached && (fresh || (opts && opts.stale))) {
    if (seq !== state.navSeq || dir !== state.cwd) return;
    applyEntries(cached.entries, cached.path);
    if (!fresh) refreshListInBackground();
    return;
  }
  let r;
  try {
    r = await api("/api/list?path=" + encodeURIComponent(dir));
  } catch (err) {
    // 只有还是当前目录时才允许回退；已经离开的旧请求失败不要再把页面掳回根目录。
    if (seq !== state.navSeq || dir !== state.cwd) return;
    // 上次记的目录已经没了（被删/改过名）：退回根目录再来一次，而不是卡在报错上。
    // 只有「目录真的不存在」才退回根目录；网络抖动/超时留在原目录，别把人掳走。
    if (err.code === "NOTFOUND" && dir) {
      state.cwd = "";
      state.navSeq++;
      saveCwd();
      return loadList({ force: true, quiet });
    }
    state.cwd = state.shownDir || "";
    state.navSeq++;
    saveCwd();
    throw err;
  }
  // 连续点目录时，前面慢的请求可能后到；一律丢弃，别覆盖已经打开的层级。
  if (seq !== state.navSeq || dir !== state.cwd) return;
  state.cache[dir] = { at: Date.now(), entries: r.entries || [], path: r.path || "/" };
  applyEntries(state.cache[dir].entries, r.path);
  saveDiskCache();
  saveCwd();
  // 列表既然拉到了，说明后台自己连上了；把状态与错误面板同步过来，
  // 否则手机开机网络晚到时会一直挂着「连接失败」的提示。
  if (state.vaultReady === false) {
    state.vaultReady = true;
    loadStatus().catch(() => {});
  }
}

let bgRefreshTimer = 0;
function refreshListInBackground() {
  clearTimeout(bgRefreshTimer);
  bgRefreshTimer = setTimeout(() => {
    loadList({ force: true, quiet: true }).catch(() => {});
  }, 300);
}

function paintCount() {
  const dirs = state.entries.filter((e) => e.dir).length;
  const files = state.entries.length - dirs;
  $("count").textContent = state.entries.length ? `${dirs} 目录 · ${files} 文件` : "";
}

function showPath(p) {
  const nav = $("crumbs");
  if (!nav) return;
  const segs = (p || "/").split("/").filter(Boolean);
  nav.innerHTML = "";
  const mk = (label, dir, on) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "crumb tap" + (on ? " on" : "");
    b.textContent = label;
    b.title = dir ? "/" + dir : "/";
    b.addEventListener("click", () => { if (!on) goTo(dir); });
    return b;
  };
  nav.appendChild(mk("根目录", "", segs.length === 0));
  let acc = "";
  // 层级太深只显示最后三级，前面用 … 省略，窄屏也能看清当前在哪。
  const start = segs.length > 4 ? segs.length - 3 : 0;
  if (start > 0) {
    const dots = document.createElement("span");
    dots.className = "crumb-dots";
    dots.textContent = "…";
    nav.appendChild(dots);
  }
  for (let i = start; i < segs.length; i++) {
    acc = acc ? acc + "/" + segs[i] : segs[i];
    const sep = document.createElement("span");
    sep.className = "crumb-sep";
    sep.textContent = "›";
    nav.appendChild(sep);
    nav.appendChild(mk(segs[i], acc, i === segs.length - 1));
  }
  nav.scrollLeft = nav.scrollWidth;
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
    $("btnEmptyUp").addEventListener("click", () => openUpload(true));
    return;
  }
  const frag = document.createDocumentFragment();
  const lk = state.cwd + "#" + state.view + "#" + state.sort + "#" + state.filter;
  if (state.limitFor !== lk) {
    state.limitFor = lk;
    state.limit = state.selecting ? shown.length : 80;
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
// 网格里用单色线性图标，和深色面板保持一致；列表行仍沿用轻量字符图标。
const TILE_SVG = {
  folder: '<path d="M3 7.5A2 2 0 0 1 5 5.5h3.6l1.7 2H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  image: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.2" cy="9.6" r="1.6"/><path d="M4 17.2l4.6-4.2 3.3 3 2.7-2.3L20 17.8"/>',
  video: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M10.4 9.4l4.2 2.6-4.2 2.6z"/>',
  audio: '<path d="M9 17.5V8.2l8-1.7v8.6"/><circle cx="6.8" cy="17.5" r="2.2"/><circle cx="14.8" cy="15.6" r="2.2"/>',
  doc: '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4"/><path d="M9 12h6M9 15.5h6"/>',
  archive: '<path d="M4 7.5h16v12h-16z"/><path d="M4 7.5l2-3h12l2 3"/><path d="M9.5 11h5"/>',
  code: '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4"/><path d="M9.8 12l-1.8 1.9 1.8 1.9M14.2 12l1.8 1.9-1.8 1.9"/>',
  pkg: '<path d="M4 8l4-3h8l4 3v10H4z"/><path d="M4 8h16M12 8v10"/>',
  file: '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4"/>'
};
function svgIcon(kind) {
  const d = TILE_SVG[kind] || TILE_SVG.file;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
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
    ph = `<div class="tile-ph dir"><span class="glyph">${svgIcon("folder")}</span></div>`;
  } else if (isImage(e.name)) {
    ph = `<div class="tile-ph"><span class="glyph">${svgIcon("image")}</span></div>`;
  } else {
    const kind = isVideo(e.name) ? "video" : isAudio(e.name) ? "audio" : fileKind(e.name);
    ph = `<div class="tile-ph ${kind}"><span class="glyph">${svgIcon(kind)}</span></div>`;
    badge = `<span class="tile-badge ${kind}">${escapeHtml(extOf(e.name).toUpperCase() || "FILE")}</span>`;
  }
  el.innerHTML = `${ph}${badge}
    <span class="sel-mark"></span>
    <button class="kill" title="删除">✕</button>
    <div class="tile-meta"><div class="tile-name">${escapeHtml(e.name)}</div>
    <div class="tile-size">${e.dir ? "文件夹" : fmtSize(e.size) + (e.mod_time ? " · " + fmtDay(e.mod_time) : "")}</div></div>`;
  paintPick(el, e);
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
    if (state.selecting) { toggleSelected(e); return; }
    e.dir ? goTo(e.path) : openViewer(e);
  });
  el.querySelector(".kill").addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!state.selecting) removeEntry(e);
  });
  bindLongPress(el, e);
  return el;
}

function rowEl(e) {
  const el = document.createElement("div");
  el.className = "item";
  const rowKind = e.dir ? "folder" : isVideo(e.name) ? "video" : isAudio(e.name) ? "audio" : isImage(e.name) ? "image" : fileKind(e.name);
  let thumb = `<span>${svgIcon(rowKind)}</span>`;
  if (!e.dir && isImage(e.name)) {
    thumb = `<img loading="lazy" decoding="async" src="${thumbURL(e, 120)}" alt="">`;
  }
  el.innerHTML = `<span class="sel-mark"></span><div class="thumb">${thumb}</div>
    <div class="txt"><div class="name">${escapeHtml(e.name)}</div>
    <div class="sub">${e.dir ? "文件夹" : KIND_LABEL[isImage(e.name) ? "image" : isVideo(e.name) ? "video" : isAudio(e.name) ? "audio" : fileKind(e.name)] + " · " + fmtSize(e.size) + (e.mod_time ? " · " + fmtDate(e.mod_time) : "")}</div></div>
    <button class="del ghost" title="删除">✕</button>`;
  paintPick(el, e);
  const img = el.querySelector(".thumb img");
  if (img) img.addEventListener("error", () => { el.querySelector(".thumb").innerHTML = svgIcon("image"); });
  if (!e.dir && isVideo(e.name)) whenNear(el, () => attachVideoThumb(el.querySelector(".thumb"), e, "row-vid"));
  el.addEventListener("click", (ev) => {
    if (ev.target.classList.contains("del")) return;
    if (state.selecting) { toggleSelected(e); return; }
    e.dir ? goTo(e.path) : openViewer(e);
  });
  el.querySelector(".del").addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!state.selecting) removeEntry(e);
  });
  bindLongPress(el, e);
  return el;
}

function selectedEntries() {
  return state.entries.filter((e) => state.selected.has(e.path));
}

function paintPick(el, e) {
  el.dataset.path = e.path;
  el.classList.toggle("selected", state.selected.has(e.path));
  const pick = el.querySelector(".sel-mark");
  if (pick) pick.textContent = state.selected.has(e.path) ? "✓" : "";
}

function updateSelUI() {
  const on = state.selecting;
  document.body.classList.toggle("selecting", on);
  $("selBar").classList.toggle("hidden", !on);
  $("selCount").textContent = "已选 " + state.selected.size + " 项";
  $("btnMoveSel").disabled = !state.selected.size;
  $("btnRenameSel").disabled = state.selected.size !== 1;
  $("btnDeleteSel").disabled = !state.selected.size;
  $("btnSelect").classList.toggle("on", on);
}

function enterSelect() {
  state.selecting = true;
  state.selected.clear();
  state.limit = Math.max(state.limit, state.entries.length);
  renderList(true);
  updateSelUI();
}

function exitSelect() {
  state.selecting = false;
  state.selected.clear();
  renderList(true);
  updateSelUI();
}

function toggleSelected(e) {
  if (state.selected.has(e.path)) state.selected.delete(e.path);
  else state.selected.add(e.path);
  const box = $("list");
  box.querySelectorAll("[data-path]").forEach((el) => {
    if (el.dataset.path === e.path) paintPick(el, e);
  });
  updateSelUI();
}

async function moveSelected() {
  const items = selectedEntries();
  if (!items.length) return;
  const dest = await pickFolder(state.cwd, items.length === 1 ? "移动「" + items[0].name + "」" : "移动 " + items.length + " 项", "移到这里");
  if (dest === null) return;
  const todo = items.filter((e) => !sameDir(parentOf(e.path), dest));
  const blocked = items.filter((e) => dest && (e.path === dest || dest.startsWith(e.path + "/")));
  if (blocked.length) {
    toast("不能把「" + blocked[0].name + "」移进它自己里面");
    return;
  }
  if (!todo.length) {
    toast("已经在目标文件夹里了", "ok");
    return;
  }
  const fails = [];
  showBusy("准备移动…");
  try {
    for (let i = 0; i < todo.length; i++) {
      const e = todo[i];
      setBusy(`正在移动 ${i + 1}/${todo.length}：${e.name}`);
      const to = joinPath(dest, e.name);
      try {
        await api("/api/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: e.path, to }),
        });
      } catch (err) {
        fails.push(e.name + "：" + err.message);
      }
    }
  } finally {
    hideBusy();
  }
  exitSelect();
  await loadList({ force: true }).catch(() => {});
  if (fails.length) toast("有 " + fails.length + " 项没移成：" + fails[0]);
  else toast("已移动 " + todo.length + " 项", "ok");
}

async function renameSelected() {
  const items = selectedEntries();
  if (items.length !== 1) return;
  const e = items[0];
  const name = await askInput("把「" + e.name + "」改成：", e.name, "重命名");
  if (name === null) return;
  const trimmed = String(name).trim();
  if (!trimmed || trimmed === e.name) return;
  if (/[\/\\]/.test(trimmed) || trimmed === "." || trimmed === "..") {
    toast("名称不能包含 / 或 \\");
    return;
  }
  showBusy("正在重命名…");
  try {
    await api("/api/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: e.path, to: joinPath(parentOf(e.path), trimmed) }),
    });
  } catch (err) {
    hideBusy();
    toast("重命名失败：" + err.message);
    return;
  }
  hideBusy();
  exitSelect();
  await loadList({ force: true }).catch(() => {});
  toast("已改名为 " + trimmed, "ok");
}

async function deleteSelected() {
  const items = selectedEntries();
  if (!items.length) return;
  if (!(await askOpen("删除选中的 " + items.length + " 项？这个操作不能撤销。", "删除", false, ""))) return;
  const fails = [];
  showBusy("正在删除…");
  try {
    for (let i = 0; i < items.length; i++) {
      setBusy(`正在删除 ${i + 1}/${items.length}：${items[i].name}`);
      try {
        await api("/api/delete?path=" + encodeURIComponent(items[i].path), { method: "POST" });
      } catch (err) {
        fails.push(items[i].name + "：" + err.message);
      }
    }
  } finally {
    hideBusy();
  }
  exitSelect();
  await loadList({ force: true }).catch(() => {});
  if (fails.length) toast("有 " + fails.length + " 项没删成：" + fails[0]);
  else toast("已删除 " + items.length + " 项", "ok");
}

// 目录选择器：只显示文件夹；点文件夹进入，当前层就是最终目标。
let pickerResolve = null;
let pickerDir = "";
function pickFolder(start, title, okLabel) {
  pickerDir = normDir(start);
  $("pickerTitle").textContent = title || "移动到";
  $("pickerOk").textContent = okLabel || "移到这里";
  $("picker").classList.remove("hidden");
  document.body.classList.add("picking");
  paintPicker(pickerDir);
  return new Promise((resolve) => { pickerResolve = resolve; });
}
function finishPicker(value) {
  $("picker").classList.add("hidden");
  document.body.classList.remove("picking");
  const r = pickerResolve;
  pickerResolve = null;
  if (r) r(value);
}
async function paintPicker(dir) {
  pickerDir = normDir(dir);
  $("pickerPath").textContent = pickerDir ? "/" + pickerDir : "根目录";
  $("pickerUp").disabled = !pickerDir;
  const box = $("pickerList");
  box.innerHTML = `<div class="muted picker-empty"><span class="spin"></span>正在读取…</div>`;
  let r;
  try {
    r = await api("/api/list?path=" + encodeURIComponent(pickerDir));
  } catch (err) {
    box.innerHTML = `<div class="muted picker-empty">读取失败：${escapeHtml(err.message)}</div>`;
    return;
  }
  box.innerHTML = "";
  const dirs = (r.entries || []).filter((e) => e.dir).sort((a, b) => a.name.localeCompare(b.name, "zh"));
  if (!dirs.length) {
    box.innerHTML = `<div class="muted picker-empty">这里没有子文件夹，可以直接移到这里</div>`;
    return;
  }
  for (const e of dirs) {
    const row = document.createElement("button");
    row.className = "pick-row tap";
    row.innerHTML = `<span class="pick-ico">${svgIcon("folder")}</span><span class="pick-name">${escapeHtml(e.name)}</span><span class="pick-go">›</span>`;
    row.addEventListener("click", () => paintPicker(e.path));
    box.appendChild(row);
  }
}
(function bindPicker() {
  $("pickerClose").addEventListener("click", () => finishPicker(null));
  $("pickerMask").addEventListener("click", () => finishPicker(null));
  $("pickerUp").addEventListener("click", () => paintPicker(parentOf(pickerDir)));
  $("pickerOk").addEventListener("click", () => finishPicker(pickerDir));
  $("picker").addEventListener("click", (ev) => { if (ev.target === $("picker")) finishPicker(null); });
  $("btnSelect").addEventListener("click", () => (state.selecting ? exitSelect() : enterSelect()));
  $("btnSelDone").addEventListener("click", exitSelect);
  $("btnMoveSel").addEventListener("click", moveSelected);
  $("btnRenameSel").addEventListener("click", renameSelected);
  $("btnDeleteSel").addEventListener("click", deleteSelected);
})();

// ---------- 应用锁 / 私密文件夹锁 ----------
let lockInfo = { app_lock: false, folder_lock: false, folder_path: "", biometric: false };
let appUnlocked = true;
let folderUnlocked = false;
let lockResolve = null;
let lockKind = "app";
let lockPulse = 0;
let bioPending = false;

function lockApi() {
  return typeof window.Lock !== "undefined" ? window.Lock : null;
}
function refreshLockInfo() {
  const api = lockApi();
  if (!api) {
    lockInfo = { app_lock: false, folder_lock: false, folder_path: "", biometric: false };
    return lockInfo;
  }
  try {
    lockInfo = JSON.parse(api.state());
  } catch (e) {
    lockInfo = { app_lock: false, folder_lock: false, folder_path: "", biometric: false };
  }
  return lockInfo;
}
function isPrivatePath(p) {
  if (!lockInfo.folder_lock || !lockInfo.folder_path) return false;
  const root = normDir(lockInfo.folder_path);
  const q = normDir(p);
  return !!root && (q === root || q.startsWith(root + "/"));
}

function finishLock(ok) {
  $("lockScreen").classList.add("hidden");
  $("lockPin").value = "";
  $("lockErr").textContent = "";
  bioPending = false;
  $("lockBio").disabled = false;
  $("lockBio").textContent = "指纹解锁";
  const r = lockResolve;
  lockResolve = null;
  if (r) r(!!ok);
}

function showLock(kind, sub) {
  if (!$("lockScreen").classList.contains("hidden")) return Promise.resolve(false);
  lockKind = kind;
  const folder = kind === "folder";
  $("lockTitle").textContent = folder ? "私密文件夹已锁定" : "vaultd 已锁定";
  $("lockSub").textContent = sub || (folder ? "输入文件夹 PIN，或用指纹进入" : "输入 PIN 解锁，或用指纹继续");
  $("lockCancel").classList.toggle("hidden", !folder);
  $("lockBio").classList.toggle("hidden", !lockInfo.biometric);
  $("lockErr").textContent = "";
  $("lockPin").value = "";
  $("lockScreen").classList.remove("hidden");
  setTimeout(() => $("lockPin").focus(), 60);
  return new Promise((resolve) => { lockResolve = resolve; });
}

function lockTryPin() {
  const api = lockApi();
  if (!api) { finishLock(true); return; }
  const pin = $("lockPin").value.trim();
  if (!/^\d{4,8}$/.test(pin)) {
    $("lockErr").textContent = "PIN 是 4–8 位数字";
    return;
  }
  if (api.verifyPin(lockKind, pin)) {
    finishLock(true);
    return;
  }
  const card = $("lockScreen").querySelector(".lock-card");
  card.classList.remove("lock-shake");
  void card.offsetWidth;
  card.classList.add("lock-shake");
  $("lockErr").textContent = "PIN 不对，再试一次";
  $("lockPin").select();
}

function lockTryBio() {
  const api = lockApi();
  if (!api || !lockInfo.biometric) return;
  bioPending = true;
  $("lockErr").textContent = "请按指纹…";
  $("lockBio").disabled = true;
  $("lockBio").textContent = "等待指纹";
  try {
    api.biometric(lockKind);
  } catch (e) {
    bioPending = false;
    $("lockBio").disabled = false;
    $("lockBio").textContent = "指纹解锁";
    $("lockErr").textContent = "指纹调用失败：" + e.message;
  }
}

window.__onBioResult = function (ok, msg) {
  if (!bioPending) return;
  bioPending = false;
  $("lockBio").disabled = false;
  $("lockBio").textContent = "指纹解锁";
  if (ok) finishLock(true);
  else $("lockErr").textContent = msg || "指纹没有通过";
};

(function bindLock() {
  $("lockUnlock").addEventListener("click", lockTryPin);
  $("lockBio").addEventListener("click", lockTryBio);
  $("lockCancel").addEventListener("click", () => finishLock(false));
  $("lockPin").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); lockTryPin(); }
  });
})();

// PIN 设置框：confirm=true 时要求输入两次
let pinResolve = null;
function askPin(title, confirm) {
  $("pinTitle").textContent = title || "设置 PIN";
  $("pinInput").value = "";
  $("pinConfirm").value = "";
  $("pinErr").textContent = "";
  $("pinConfirm").classList.toggle("hidden", !confirm);
  $("pinBox").classList.remove("hidden");
  setTimeout(() => $("pinInput").focus(), 50);
  return new Promise((resolve) => { pinResolve = resolve; });
}
function finishPin(value) {
  $("pinBox").classList.add("hidden");
  const r = pinResolve;
  pinResolve = null;
  if (r) r(value);
}
(function bindPin() {
  const submit = () => {
    const a = $("pinInput").value.trim();
    if (!/^\d{4,8}$/.test(a)) { $("pinErr").textContent = "PIN 是 4–8 位数字"; return; }
    if (!$("pinConfirm").classList.contains("hidden") && a !== $("pinConfirm").value.trim()) {
      $("pinErr").textContent = "两次输入不一致";
      return;
    }
    finishPin(a);
  };
  $("pinYes").addEventListener("click", submit);
  $("pinNo").addEventListener("click", () => finishPin(null));
  $("pinInput").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); if (!$("pinConfirm").classList.contains("hidden")) $("pinConfirm").focus(); else submit(); }
  });
  $("pinConfirm").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); submit(); }
  });
  $("pinBox").addEventListener("click", (ev) => { if (ev.target === $("pinBox")) finishPin(null); });
})();

function paintSecurityUI() {
  const api = lockApi();
  const app = !!lockInfo.app_lock;
  const folder = !!lockInfo.folder_lock;
  $("appLockBadge").textContent = app ? "已开启" : "未开启";
  $("appLockBadge").className = "badge " + (app ? "ok" : "");
  $("btnAppLock").textContent = app ? "关闭应用锁" : "开启应用锁";
  $("btnAppLock").classList.toggle("danger", app);
  $("btnAppLock").classList.toggle("primary", !app);
  $("folderLockBadge").textContent = folder ? "已开启" : "未开启";
  $("folderLockBadge").className = "badge " + (folder ? "ok" : "");
  $("btnFolderLock").textContent = folder ? "关闭文件夹锁" : "开启文件夹锁";
  $("btnFolderLock").classList.toggle("danger", folder);
  $("btnFolderLock").classList.toggle("primary", !folder);
  $("folderLockPath").textContent = lockInfo.folder_path || "还没有选择";
  $("appLockMsg").textContent = api
    ? (lockInfo.biometric ? "PIN + 指纹：这台设备可用指纹。" : "PIN 已保存在本机；这台设备没有可用的指纹，只能用 PIN。")
    : "只有安卓 App 支持应用锁；当前是浏览器页面。";
}

async function toggleAppLock() {
  const api = lockApi();
  if (!api) { toast("只有安卓 App 支持应用锁"); return; }
  if (lockInfo.app_lock) {
    if (!(await askOpen("关闭应用锁？下次打开 App 就不需要 PIN 了。", "关闭", false, ""))) return;
    api.clearPin("app");
    appUnlocked = true;
    refreshLockInfo();
    paintSecurityUI();
    toast("应用锁已关闭", "ok");
    return;
  }
  const pin = await askPin("设置应用锁 PIN", true);
  if (pin === null) return;
  if (!api.setPin("app", pin)) { toast("PIN 保存失败"); return; }
  refreshLockInfo();
  paintSecurityUI();
  toast("应用锁已开启，下次启动生效", "ok");
}

async function toggleFolderLock() {
  const api = lockApi();
  if (!api) { toast("只有安卓 App 支持文件夹锁"); return; }
  if (lockInfo.folder_lock) {
    const pin = await askPin("验证私密文件夹 PIN 后关闭", false);
    if (pin === null) return;
    if (!api.verifyPin("folder", pin)) { toast("PIN 不对，没有关闭"); return; }
    api.clearPin("folder");
    folderUnlocked = false;
    refreshLockInfo();
    paintSecurityUI();
    toast("私密文件夹锁已关闭", "ok");
    return;
  }
  let path = await pickFolder("", "选择要上锁的文件夹", "选定这个文件夹");
  if (path === null) return;
  if (!path) { toast("不能锁根目录，请选择子文件夹"); return; }
  const pin = await askPin("设置私密文件夹 PIN", true);
  if (pin === null) return;
  if (!api.setPin("folder", pin)) { toast("PIN 保存失败"); return; }
  if (!api.setFolderPath(path)) {
    api.clearPin("folder");
    toast("文件夹路径保存失败");
    return;
  }
  refreshLockInfo();
  paintSecurityUI();
  folderUnlocked = false;
  toast("已锁上 /" + normDir(path), "ok");
}

async function changeFolderPath() {
  const api = lockApi();
  if (!api) return;
  if (lockInfo.folder_lock) {
    const pin = await askPin("先验证私密文件夹 PIN", false);
    if (pin === null) return;
    if (!api.verifyPin("folder", pin)) { toast("PIN 不对，路径没有改"); return; }
  }
  const path = await pickFolder(lockInfo.folder_path || "", "选择要上锁的文件夹", "选定这个文件夹");
  if (path === null) return;
  if (!path) { toast("不能锁根目录"); return; }
  if (!api.setFolderPath(path)) { toast("路径保存失败"); return; }
  folderUnlocked = false;
  refreshLockInfo();
  paintSecurityUI();
  toast("已改为锁定 /" + normDir(path), "ok");
}

(function bindSecurityUI() {
  $("btnAppLock").addEventListener("click", toggleAppLock);
  $("btnFolderLock").addEventListener("click", toggleFolderLock);
  $("btnFolderPick").addEventListener("click", changeFolderPath);
  $("btnLockNow").addEventListener("click", () => {
    if (!lockInfo.app_lock) { toast("应用锁还没开启", "ok"); return; }
    if (!$("lockScreen").classList.contains("hidden")) return;
    appUnlocked = false;
    showLock("app").then(() => { appUnlocked = true; });
  });
  $("btnFolderUnlockNow").addEventListener("click", () => {
    folderUnlocked = false;
    toast(lockInfo.folder_lock ? "私密文件夹已重新锁上" : "文件夹锁还没开启", "ok");
  });
})();

let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  if (away < 20000) return;
  folderUnlocked = false;
  if (lockInfo.app_lock && $("lockScreen").classList.contains("hidden")) {
    appUnlocked = false;
    showLock("app").then(() => { appUnlocked = true; });
  }
});

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
  goTo(joinPath(state.cwd, name).replace(/^\//, ""));
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
  const parent = state.cwd.split("/").slice(0, -1).join("/");
  goTo(parent);
});
// 设置 / 上传都是独立一层：打开时锁住背后的文件列表滚动
function syncModalState() {
  const setupOpen = $("setupPanel") && !$("setupPanel").classList.contains("hidden");
  const uploadOpen = $("uploadSheet") && !$("uploadSheet").classList.contains("hidden");
  document.body.classList.toggle("modal-open", !!(setupOpen || uploadOpen));
  document.body.classList.toggle("upload-open", uploadOpen);
}
function openSetup(tab) {
  state.setupTouched = true; // 用户手动开过设置，之后状态刷新别再抢焦点
  const panel = $("setupPanel");
  panel.classList.remove("hidden");
  if (tab) setTab(tab);
  renderSetupFiles();
  refreshSyncProgress();
  syncModalState();
}
function closeSetup() {
  $("setupPanel").classList.add("hidden");
  syncModalState();
}
function openUpload(pickNow) {
  $("uploadSheet").classList.remove("hidden");
  syncModalState();
  if (pickNow) setTimeout(() => $("fileInput").click(), 80);
}
function closeUpload() {
  $("uploadSheet").classList.add("hidden");
  syncModalState();
}

// 设置页底部的「网盘文件」：保留老版设置下面能看到文件的感觉，点一条直接打开。
function setupFileKind(e) {
  if (e.dir) return "folder";
  if (isImage(e.name)) return "image";
  if (isVideo(e.name)) return "video";
  if (isAudio(e.name)) return "audio";
  return fileKind(e.name);
}
function renderSetupFiles() {
  const wrap = $("setupFiles");
  if (!wrap) return;
  const here = state.cwd ? state.cwd : "根目录";
  const n = (state.entries || []).length;
  $("setupFilesPath").textContent = here + (n ? " · " + n + " 项" : "");
  wrap.innerHTML = "";
  if (!state.configured) {
    wrap.innerHTML = '<span class="muted">还没接入网盘，先在「云端连接」里完成配置。</span>';
    return;
  }
  const list = sortedEntries();
  if (!list.length) {
    wrap.innerHTML = '<span class="muted">这个目录还没有文件，点「打开网盘」去上传。</span>';
    return;
  }
  const max = 8;
  list.slice(0, max).forEach((e) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "setup-file tap";
    row.innerHTML =
      '<span class="sf-ico">' + svgIcon(setupFileKind(e)) + "</span>" +
      '<span class="sf-txt"><span class="sf-name">' + escapeHtml(e.name) + "</span>" +
      '<span class="sf-sub">' + (e.dir ? "文件夹" : fmtSize(e.size || 0)) + "</span></span>";
    row.addEventListener("click", () => {
      closeSetup();
      if (e.dir) goTo(e.path);
      else openViewer(e);
    });
    wrap.appendChild(row);
  });
  if (list.length > max) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "setup-file tap";
    more.innerHTML = '<span class="sf-ico">…</span><span class="sf-txt"><span class="sf-name">还有 ' +
      (list.length - max) + " 项，点这里看全部</span></span>";
    more.addEventListener("click", () => { closeSetup(); goTo(state.cwd); });
    wrap.appendChild(more);
  }
}
$("btnSetup").addEventListener("click", () => openSetup());
$("btnSetupClose").addEventListener("click", closeSetup);
$("btnSetupBrowse").addEventListener("click", () => {
  closeSetup();
  goTo(state.cwd);
});
$("uploadFab").addEventListener("click", () => openUpload(false));
$("btnUploadClose").addEventListener("click", closeUpload);
$("uploadMask").addEventListener("click", closeUpload);
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (!$("uploadSheet").classList.contains("hidden")) { closeUpload(); return; }
  if (!$("setupPanel").classList.contains("hidden")) closeSetup();
});


// 设置面板切成「接入 / 备份 / 界面」三页，避免一屏滚到底
async function loadCacheStatus() {
  try {
    const c = await api("/api/cache/status");
    const name = c.enabled ? fmtSize(c.bytes) + " / " + fmtSize(c.limit) + " · " + c.files + " 张" : "未启用";
    $("cacheStat").textContent = name;
  } catch (err) {
    $("cacheStat").textContent = "读取失败：" + err.message;
  }
}
async function clearCache() {
  showBusy("正在清理预览缓存…");
  try {
    await api("/api/cache/clear", { method: "POST" });
    toast("预览缓存已清空", "ok");
    await loadCacheStatus();
  } catch (err) {
    toast("清理失败：" + err.message);
  } finally {
    hideBusy();
  }
}
$("btnCacheClear").addEventListener("click", clearCache);

function setTab(name) {
  $("tabConnect").classList.toggle("hidden", name !== "connect");
  $("tabBackup").classList.toggle("hidden", name !== "backup");
  $("tabSecurity").classList.toggle("hidden", name !== "security");
  $("tabUI").classList.toggle("hidden", name !== "ui");
  $("btnTabConnect").classList.toggle("on", name === "connect");
  $("btnTabBackup").classList.toggle("on", name === "backup");
  $("btnTabSecurity").classList.toggle("on", name === "security");
  $("btnTabUi").classList.toggle("on", name === "ui");
  if (name === "backup") loadAlbumCatalog();
  if (name === "ui") loadCacheStatus();
  if (name === "security") {
    refreshLockInfo();
    paintSecurityUI();
  }
}
$("btnTabConnect").addEventListener("click", () => setTab("connect"));
$("btnTabBackup").addEventListener("click", () => setTab("backup"));
$("btnTabSecurity").addEventListener("click", () => setTab("security"));
$("btnTabUi").addEventListener("click", () => setTab("ui"));
// 默认页在文件末尾再设：这里太早，albumCatalog 还没初始化

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
  applyTheme(next, true);
  renderThemeMode();
});
$("btnThemeAuto").addEventListener("click", () => setThemeMode("auto"));
$("btnThemeDark").addEventListener("click", () => setThemeMode("dark"));
$("btnThemeLight").addEventListener("click", () => setThemeMode("light"));

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
    saveScroll();
    goTo(state.cwd.split("/").slice(0, -1).join("/"));
    return true;
  }
  return false;
};

// ---------- 相册自动同步（只有安卓原生桥才有；PC 上整块隐藏） ----------
let syncCur = { enabled: false, dir: "相册备份", wifiOnly: false, result: "", hasPermission: true, gateway: true };

function applySyncState(st) {
  syncCur = st;
  $("btnSyncDir").textContent = st.dir || "相册备份";
  $("btnSyncWifi").textContent = st.wifiOnly ? "已开启" : "已关闭";
  $("btnSyncWifi").classList.toggle("on", !!st.wifiOnly);
  $("btnSyncPerm").classList.toggle("hidden", !!st.hasPermission);
  $("syncMsg").textContent = st.result || "";
  $("btnSyncKeep").textContent = st.keepAlbum === false ? "已关闭" : "已开启";
  $("btnSyncKeep").classList.toggle("on", st.keepAlbum !== false);
  renderAlbumPicks(st.albums || []);
  renderFolders(st.folders || []);
  if ($("folderRoot")) $("folderRoot").textContent = st.folderDir || "文件备份";
  syncToggle("btnContacts", !!st.contacts);
  syncToggle("btnSms", !!st.sms);
  syncToggle("btnCalls", !!st.calls);
  const needPerm = !st.hasPermission || !st.hasContacts || !st.hasSms || !st.hasCalls;
  $("btnPermAll").classList.toggle("hidden", !needPerm);
  $("btnSyncPerm").classList.toggle("hidden", !needPerm);
  paintProgress(st);
}

// 同步进度：浮条 + 设置页状态行；只在总任务 >0 时画百分比。
function paintProgress(pg) {
  if (!pg) return;
  const running = !!pg.running;
  const total = Number(pg.total) || 0;
  const done = Math.min(Number(pg.done) || 0, total || 1e9);
  const el = $("syncBar");
  if (el) {
    el.classList.toggle("hidden", !running);
    if (running) {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      $("syncBarTitle").textContent = total > 0 ? "正在同步相册 " + done + "/" + total : "正在检查新照片";
      $("syncBarPct").textContent = total > 0 ? pct + "%" : "";
      $("syncBarFile").textContent = pg.current || (total > 0 ? "等待上传…" : "正在比对云端清单…");
      $("syncBarFill").style.width = (total > 0 ? Math.max(2, pct) : 3) + "%";
    }
  }
  const line = $("syncState");
  if (line) {
    line.textContent = running
      ? (total > 0 ? "正在同步 " + done + "/" + total : "正在检查新照片…")
      : (pg.enabled ? "运行中" : "未开启");
    line.classList.toggle("busy", running);
  }
  const toggle = $("btnSyncToggle");
  if (toggle && typeof pg.enabled === "boolean") {
    toggle.textContent = pg.enabled ? "关闭自动同步" : "开启自动同步";
    toggle.classList.toggle("primary", !pg.enabled);
  }
}

function syncToggle(id, on) {
  const b = $(id);
  if (!b) return;
  b.textContent = on ? "已开启" : "已关闭";
  b.classList.toggle("on", on);
  b.classList.toggle("primary", on);
}

// 相册勾选：不选＝全部；点一下切换。选中的相册在云端各建一个同名文件夹。
let albumCatalog = [];
let albumSelected = [];

// 原生后台把某个相册封面做好后会回调这里：只换那一张图，不整页重排。
window.onAlbumCover = function (name, data) {
  if (!name || !data) return;
  const a = albumCatalog.find((x) => x.name === name);
  if (a) a.cover = data;
  const box = $("albumPicks");
  if (!box) return;
  const picks = box.querySelectorAll(".pick");
  for (const b of picks) {
    if (b.dataset.name === name) {
      b.querySelector(".pick-cover").innerHTML = `<img src="${data}" alt="">`;
      break;
    }
  }
};

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
    b.dataset.name = a.name;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    const sub = [a.path, a.count + " 项"].filter(Boolean).map(escapeHtml).join(" · ");
    b.innerHTML =
      `<span class="pick-cover">${a.cover ? `<img src="${a.cover}" alt="">` : `<span class="pick-ph">📁</span>`}</span>` +
      `<span class="pick-txt"><span class="pick-name">${escapeHtml(a.name)}</span>` +
      `<span class="pick-sub">${sub}</span></span>` +
      `<span class="tick">✓</span>`;
    b.addEventListener("click", () => {
      const i = albumSelected.indexOf(a.name);
      if (i >= 0) albumSelected.splice(i, 1);
      else albumSelected.push(a.name);
      saveAlbums();
    });
    box.appendChild(b);
  }
}

// 任意文件夹：系统目录选择器选中的目录列表
function renderFolders(list) {
  const box = $("folderList");
  if (!box) return;
  if (!Array.isArray(list) || !list.length) {
    box.innerHTML = `<span class="muted">还没添加。可以选「下载」「微信」「Documents」等任意目录，整棵目录递归备份。</span>`;
    return;
  }
  box.innerHTML = "";
  const root = syncCur.folderDir || "文件备份";
  for (const f of list) {
    const name = f.name || "文件夹";
    const d = document.createElement("div");
    d.className = "folder-item";
    d.innerHTML = `<span class="fi-ico">📁</span>` +
      `<span class="fi-t"><span class="fi-n">${escapeHtml(name)}</span>` +
      `<span class="fi-p">云端：${escapeHtml(root + "/" + name)}</span></span>`;
    const x = document.createElement("button");
    x.className = "fx ghost tap";
    x.textContent = "移除";
    x.addEventListener("click", () => {
      try {
        applySyncState(JSON.parse(window.Sync.removeFolder(f.uri)));
        toast("已移除：" + name, "ok");
      } catch (e) {
        toast("移除失败：" + e.message);
      }
    });
    d.appendChild(x);
    box.appendChild(d);
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

// 1.5 秒一次的轻量进度轮询；老包（没有 progress 接口）自动跳过。
function refreshSyncProgress() {
  if (!window.Sync || typeof window.Sync.progress !== "function") return;
  try { paintProgress(JSON.parse(window.Sync.progress())); } catch (e) { /* 忽略 */ }
}
if (window.Sync && typeof window.Sync.progress === "function") {
  setInterval(refreshSyncProgress, 1500);
  refreshSyncProgress();
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
  $("btnSyncDir").addEventListener("click", async () => {
    const now = syncCur.dir || "相册备份";
    const name = await askInput(
      "把云端目录「" + now + "」改名为？（只改名字，已上传的照片不会搬动）",
      now,
      "保存"
    );
    if (name === null) return; // 取消：一个字都不改
    const next = name.trim();
    if (!next || next === now) return;
    if (/[\\/]/.test(next)) { toast("目录名里不能有 / 或 \\"); return; }
    try {
      applySyncState(JSON.parse(window.Sync.setDir(next)));
      toast("云端目录已改为：" + syncCur.dir, "ok");
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
  $("btnAddFolder").addEventListener("click", () => {
    try {
      window.Sync.pickFolder();
      toast("选好文件夹后会自动加入备份列表", "ok");
    } catch (e) { toast("打开目录选择器失败：" + e.message); }
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
renderThemeMode();
// 手机上默认落在「自动备份」；PC 端没有相册备份，落在「云端连接」
setTab(window.Sync ? "backup" : "connect");

function applyShowDel() {
  document.body.classList.toggle("show-del", state.showDel);
  const b = $("btnShowDel");
  if (b) b.textContent = "显示删除按钮（×）：" + (state.showDel ? "开" : "关");
  if (b) b.classList.toggle("on", !!state.showDel);
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

async function initLockGate() {
  refreshLockInfo();
  paintSecurityUI();
  if (lockInfo.app_lock) {
    appUnlocked = false;
    await showLock("app");
    appUnlocked = true;
  }
  // 上次退出时正停在私密文件夹：解锁 App 之后还要再过一次文件夹锁。
  if (isPrivatePath(state.cwd)) {
    folderUnlocked = false;
    const ok = await showLock("folder", "继续上次打开的私密文件夹");
    if (ok) folderUnlocked = true;
    else {
      state.cwd = "";
      saveCwd();
    }
  }
}
window.__lockReady = initLockGate();

(async function boot() {
  await window.__lockReady;
  // 先用上次的缓存把列表画出来，不等 /api/status、更不等云端：
  // 冷启动第一眼就是上次的目录和缩略图，随后再在后台刷新。
  const cached = state.cache[state.cwd];
  window.__bootCacheN = cached && cached.entries ? cached.entries.length : -1;
  if (cached && cached.entries && cached.entries.length) {
    applyEntries(cached.entries, cached.path);
  }
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
      await loadList({ force: i > 0, stale: true });
      saveCwd();
      return;
    } catch (e) {
      console.error(e);
      if (i === 4) toast("列表加载失败：" + e.message);
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
})();


