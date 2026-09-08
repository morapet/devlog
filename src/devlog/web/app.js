// ---------- PWA: service worker + install prompt ----------
if ("serviceWorker" in navigator) {
  // Register at /sw.js so the worker's scope is the whole origin (the server
  // routes both /sw.js and /static/sw.js to the same file for this reason).
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((e) => {
    console.warn("[devlog] service worker registration failed:", e);
  });
}

// Chrome / Edge / Brave fire `beforeinstallprompt` when the PWA is installable.
// Stash the event and reveal an "Install app" button in the header.
let _deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  const btn = document.getElementById("install-pwa");
  if (btn) {
    btn.hidden = false;
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        _deferredInstallPrompt.prompt();
        const { outcome } = await _deferredInstallPrompt.userChoice;
        if (outcome === "accepted") btn.hidden = true;
      } finally {
        btn.disabled = false;
        _deferredInstallPrompt = null;
      }
    };
  }
});
// Hide the button once installed.
window.addEventListener("appinstalled", () => {
  const btn = document.getElementById("install-pwa");
  if (btn) btn.hidden = true;
});

// ---------- tiny utils ----------
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return e;
};
const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  if (r.status === 401) { showLoginOverlay(); throw new Error("401 authentication required"); }
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  if (r.status === 204) return null;
  return r.json();
};

// Shown when the backend requires auth (remote access). Localhost is trusted,
// so this never appears on this machine.
let _loginShown = false;
function showLoginOverlay() {
  if (_loginShown) return;
  _loginShown = true;
  const err = el("div", { class: "hidden text-sm text-red-600 mt-2" });
  const input = el("input", {
    type: "password", placeholder: "Access token",
    class: "w-full border border-slate-300 rounded px-2 py-1.5 text-sm",
  });
  const submit = async () => {
    err.classList.add("hidden");
    try {
      const r = await fetch("/auth/login", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: input.value }),
      });
      if (!r.ok) { err.textContent = "Incorrect token."; err.classList.remove("hidden"); return; }
      location.reload();
    } catch { err.textContent = "Login failed."; err.classList.remove("hidden"); }
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  const overlay = el("div", {
    class: "fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4",
  },
    el("div", { class: "bg-white rounded-lg shadow-xl w-[360px] p-5" },
      el("div", { class: "font-semibold text-slate-900" }, "🔒 Devlog is locked"),
      el("div", { class: "text-sm text-slate-600 mt-1 mb-3" },
        "Enter the access token to continue. Get it on the server with ",
        el("span", { class: "font-mono text-slate-800" }, "devlog token"), "."),
      input,
      el("button", {
        class: "mt-3 w-full px-3 py-1.5 text-sm rounded bg-slate-900 text-white hover:bg-slate-800",
        onclick: submit,
      }, "Unlock"),
      err,
    ),
  );
  document.body.append(overlay);
  setTimeout(() => input.focus(), 50);
}
const toast = (msg, ms = 1800) => {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
};
const fmtDate = (s) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "");

// ---------- state ----------
const TASK_STATUSES = ["todo", "today", "doing", "blocked", "someday", "done", "cancelled"];
const state = {
  projects: [],
  currentProjectId: null, // from /projects/current/resolve
  scopeProjectId: null,   // sidebar selection (null = all)
  pseudo: "home",         // 'home' | 'today' | 'doing' | 'blocked' | 'unread-links' | null
  kind: "task",           // task | note | link
  statusFilter: null,     // (kept for pseudo-views like Today/Doing)
  search: "",
  focusMode: (() => {
    try { return JSON.parse(localStorage.getItem("focusMode") || "false"); }
    catch { return false; }
  })(),
  // Reading-view (focus mode) preferences.
  tocVisible: (() => {
    try { return JSON.parse(localStorage.getItem("tocVisible") || "true"); }
    catch { return true; }
  })(),
  numberHeadings: (() => {
    try { return JSON.parse(localStorage.getItem("numberHeadings") || "false"); }
    catch { return false; }
  })(),
  // List view controls
  sortBy: "status",       // 'status' | 'priority' | 'updated' | 'created' | 'title' | 'time_spent' | 'due'
  groupBy: "none",        // 'none' | 'status' | 'priority' | 'tag'
  listFilter: "",         // in-list substring filter
  items: [],
  taskTotals: {},
  selectedId: null,
  selected: null,
  drafts: {},             // id -> dirty edits
  mobilePane: null,       // phone drill-down: 'projects' forces the project
                          // list; null = derive pane from view state.
};

const STATUS_ORDER = ["doing", "today", "todo", "blocked", "someday", "done", "cancelled"];
const PRIORITY_ORDER = ["high", "normal", "low"];

// ---------- top-level render ----------
async function refreshAll() {
  try {
    state.projects = await api("/projects");
  } catch {}
  try {
    const cp = await api("/projects/current/resolve");
    state.currentProjectId = cp?.id ?? null;
  } catch {}
  renderSidebar();
  renderHeader();
  await dispatchView();
}

function showHomeOnly(show) {
  $("#home-view").classList.toggle("hidden", !show);
  $("#list-pane").classList.toggle("hidden", show);
  $("#detail").classList.toggle("hidden", show);
  $("#splitter").classList.toggle("hidden", show);
}

// Restore saved pane widths and wire up every vertical drag-resizer. Each
// splitter resizes the pane immediately to its left; the width persists in
// localStorage and a double-click restores the default. A `key` collision is
// avoided by giving each splitter its own storage key.
function makeResizable({ pane, splitter, key, def, min, max }) {
  if (!pane || !splitter) return;
  const stored = Number(localStorage.getItem(key) || 0);
  if (stored >= min && stored <= max) pane.style.width = stored + "px";

  let dragging = false;
  let startX = 0;
  let startW = 0;
  splitter.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = pane.getBoundingClientRect().width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.max(min, Math.min(max, startW + (e.clientX - startX)));
    pane.style.width = w + "px";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem(key, String(parseInt(pane.style.width, 10)));
  });
  // Double-click resets to default.
  splitter.addEventListener("dblclick", () => {
    pane.style.width = def + "px";
    localStorage.setItem(key, String(def));
  });
}

(function setupSplitters() {
  // Sidebar | content.  Default matches the `w-56` (224px) Tailwind class.
  makeResizable({
    pane: $("#sidebar"), splitter: $("#sidebar-splitter"),
    key: "sidebarWidth", def: 224, min: 160, max: 500,
  });
  // List | detail.
  makeResizable({
    pane: $("#list-pane"), splitter: $("#splitter"),
    key: "listPaneWidth", def: 320, min: 180, max: 900,
  });
})();

async function dispatchView() {
  // Any dispatchView means we've navigated into Home/list content, leaving the
  // phone project-browser behind — let the pane derive from view state again.
  state.mobilePane = null;
  if (state.pseudo === "home" && !state.search.trim()) {
    showHomeOnly(true);
    await renderHome();
  } else {
    showHomeOnly(false);
    renderTabs();
    renderFilters();
    await reloadList();
  }
  syncMobile();
}

function renderHeader() {
  const cur = state.projects.find((p) => p.id === state.currentProjectId);
  $("#current-project").textContent = cur ? `· ${cur.name} (current)` : "· no current project";
}

function renderSidebar() {
  const sb = $("#sidebar");
  sb.replaceChildren();

  const item = (label, isActive, onclick, extra) =>
    el("button", {
      class: "w-full text-left px-2 py-1 rounded text-sm flex items-center justify-between " +
        (isActive ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"),
      onclick,
    }, el("span", {}, label), extra ? el("span", { class: "text-xs opacity-70" }, extra) : null);

  sb.append(el("button", {
    class: "w-full mb-3 px-3 py-2 bg-slate-900 text-white rounded-md text-sm font-medium hover:bg-slate-700 flex items-center justify-center gap-1",
    onclick: () => openNewItemModal(),
  }, "+ New"));

  sb.append(item("⌂  Home", state.pseudo === "home", () => { state.pseudo = "home"; state.scopeProjectId = null; clearSel(); renderSidebar(); dispatchView(); }));

  sb.append(el("div", { class: "px-1 pt-3 pb-0.5 text-[11px] uppercase tracking-wider text-slate-400 flex items-center justify-between" },
    el("span", {}, "Projects"),
    el("button", {
      class: "text-slate-500 hover:text-slate-900 px-1 leading-none",
      title: "New project",
      onclick: () => openProjectModal(null),
    }, "+"),
  ));

  // Build the 2-level tree: roots first (parent_id null), then their children.
  const roots = state.projects
    .filter((p) => !p.parent_id)
    .sort((a, b) => a.name.localeCompare(b.name));
  const childrenOf = new Map();
  for (const p of state.projects) {
    if (p.parent_id) {
      if (!childrenOf.has(p.parent_id)) childrenOf.set(p.parent_id, []);
      childrenOf.get(p.parent_id).push(p);
    }
  }
  // Also collect orphans whose parent_id points nowhere (e.g. after deletion).
  const validIds = new Set(state.projects.map((p) => p.id));
  const orphans = state.projects.filter((p) => p.parent_id && !validIds.has(p.parent_id));

  for (const p of roots) {
    sb.append(renderProjectRow(p, 0));
    const kids = (childrenOf.get(p.id) || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const k of kids) sb.append(renderProjectRow(k, 1));
  }
  for (const o of orphans) sb.append(renderProjectRow(o, 0));
}

function renderProjectRow(p, depth = 0) {
  const isActive = state.pseudo == null && state.scopeProjectId === p.id;
  const isCurrent = p.id === state.currentProjectId;

  const swatch = p.color
    ? el("span", { class: "inline-block w-2 h-2 rounded-full shrink-0", style: `background:${p.color}` })
    : el("span", { class: "inline-block w-2 h-2 rounded-full shrink-0 bg-slate-300" });

  const indentClass = depth > 0 ? "pl-3 ml-2 border-l border-slate-200" : "";

  return el("div", {
    class: "group flex items-center rounded " + indentClass + " " +
      (isActive ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"),
  },
    el("button", {
      class: "flex-1 min-w-0 text-left px-2 py-1 text-sm flex items-center gap-2",
      onclick: () => { state.scopeProjectId = p.id; state.pseudo = null; clearSel(); renderSidebar(); dispatchView(); },
    },
      swatch,
      el("span", { class: "truncate" }, p.name),
      isCurrent ? el("span", { class: "text-xs opacity-70" }, "•") : null,
    ),
    el("button", {
      class: "px-2 py-1 text-sm opacity-0 group-hover:opacity-100 " +
        (isActive ? "text-white/80 hover:text-white" : "text-slate-500 hover:text-slate-900"),
      title: "Project menu",
      onclick: (e) => { e.stopPropagation(); openProjectModal(p); },
    }, "⋮"),
  );
}

function renderTabs() {
  const t = $("#list-tabs");
  t.replaceChildren();
  for (const k of ["task", "note", "link"]) {
    t.append(el("button", {
      class: "tab-btn " + (state.kind === k ? "active" : ""),
      onclick: () => { state.kind = k; state.statusFilter = null; renderTabs(); renderFilters(); reloadList(); },
    }, k + "s"));
  }
}

function renderFilters() {
  const f = $("#list-filters");
  f.replaceChildren();

  // For pseudo-views we want NO controls — status is implied by the view.
  if (state.pseudo) return;

  const sortOptions = state.kind === "task"
    ? [
        ["status", "Status"], ["priority", "Priority"], ["updated", "Updated"],
        ["created", "Created"], ["title", "Title"], ["time_spent", "Time spent"], ["due", "Due"],
      ]
    : [["updated", "Updated"], ["created", "Created"], ["title", "Title"]];

  const groupOptions = state.kind === "task"
    ? [["none", "None"], ["status", "Status"], ["priority", "Priority"], ["tag", "Tag"]]
    : [["none", "None"], ["tag", "Tag"]];

  const sortSel = el("select", {
    class: "text-xs border border-slate-300 rounded px-1 py-0.5 bg-white",
    onchange: (e) => { state.sortBy = e.target.value; renderList(); },
  }, ...sortOptions.map(([v, label]) => el("option", { value: v, ...(state.sortBy === v ? { selected: "selected" } : {}) }, label)));

  const groupSel = el("select", {
    class: "text-xs border border-slate-300 rounded px-1 py-0.5 bg-white",
    onchange: (e) => { state.groupBy = e.target.value; renderList(); },
  }, ...groupOptions.map(([v, label]) => el("option", { value: v, ...(state.groupBy === v ? { selected: "selected" } : {}) }, label)));

  const filterInput = el("input", {
    type: "search",
    value: state.listFilter,
    placeholder: "Filter…",
    class: "ml-auto w-44 max-w-full text-xs border border-slate-300 rounded px-2 py-0.5 bg-white",
    oninput: (e) => { state.listFilter = e.target.value; renderList(); },
  });

  f.append(
    el("span", { class: "text-slate-400" }, "Sort"), sortSel,
    el("span", { class: "text-slate-400 ml-2" }, "Group"), groupSel,
    filterInput,
  );
}

// ---------- list ----------
async function reloadAndRerender() { renderSidebar(); renderTabs(); renderFilters(); await reloadList(); }

async function reloadList() {
  const list = $("#list");
  list.replaceChildren(el("div", { class: "p-3 text-xs text-slate-400" }, "loading…"));

  let items = [];
  try {
    if (state.search.trim()) {
      const url = new URL("/search", location.origin);
      url.searchParams.set("q", state.search.trim());
      if (state.scopeProjectId != null) url.searchParams.set("project_id", state.scopeProjectId);
      if (state.kind) url.searchParams.set("kind", state.kind);
      url.searchParams.set("limit", "100");
      items = await api(url.pathname + url.search);
    } else if (state.pseudo) {
      const url = new URL("/items", location.origin);
      url.searchParams.set("limit", "200");
      if (state.pseudo === "today") { url.searchParams.set("kind", "task"); url.searchParams.set("status", "today"); }
      else if (state.pseudo === "doing") { url.searchParams.set("kind", "task"); url.searchParams.set("status", "doing"); }
      else if (state.pseudo === "blocked") { url.searchParams.set("kind", "task"); url.searchParams.set("status", "blocked"); }
      else if (state.pseudo === "unread-links") { url.searchParams.set("kind", "link"); url.searchParams.set("is_read", "false"); }
      items = await api(url.pathname + url.search);
    } else {
      const url = new URL("/items", location.origin);
      url.searchParams.set("kind", state.kind);
      url.searchParams.set("limit", "500");
      if (state.scopeProjectId != null) url.searchParams.set("project_id", state.scopeProjectId);
      // server-side status filter only applies for pseudo-views
      if (state.pseudo && state.kind === "task" && state.statusFilter) url.searchParams.set("status", state.statusFilter);
      if (state.pseudo && state.kind === "link" && state.statusFilter)
        url.searchParams.set("is_read", state.statusFilter === "read" ? "true" : "false");
      items = await api(url.pathname + url.search);
    }
  } catch (e) {
    list.replaceChildren(el("div", { class: "p-3 text-sm text-red-600" }, "Failed: " + e.message));
    return;
  }
  state.items = items;
  // For task lists, fetch time totals in parallel so we can show a chip
  state.taskTotals = {};
  if (state.kind === "task" || (state.pseudo && state.pseudo !== "unread-links")) {
    try {
      const url = new URL("/tasks/totals", location.origin);
      if (state.scopeProjectId != null) url.searchParams.set("project_id", state.scopeProjectId);
      state.taskTotals = await api(url.pathname + url.search);
    } catch {}
  }
  renderList();
}

function renderList() {
  const list = $("#list");
  list.replaceChildren();
  if (state.items.length === 0) {
    list.append(el("div", { class: "p-4 text-sm text-slate-400" }, "Nothing here yet."));
    return;
  }

  // Filter
  const q = state.listFilter.trim().toLowerCase();
  const matches = (it) => {
    if (!q) return true;
    const hay = (it.title || "") + " " + (it.body || "") + " " + (it.url || "") + " " + (it.tags || []).join(" ");
    return hay.toLowerCase().includes(q);
  };
  const items = state.items.filter(matches);

  if (items.length === 0) {
    list.append(el("div", { class: "p-4 text-sm text-slate-400" }, q ? "No matches." : "Nothing here yet."));
    return;
  }

  // Sort + Group
  const cmp = sortComparator(state.sortBy);
  if (state.groupBy === "none") {
    items.sort(cmp);
    for (const it of items) list.append(renderListRow(it));
    return;
  }

  const groups = groupItems(items, state.groupBy);
  for (const g of groups) {
    g.items.sort(cmp);
    list.append(el("div", { class: "px-3 py-1.5 text-[11px] uppercase tracking-wider text-slate-500 bg-slate-50 border-b border-slate-200 flex items-center gap-2" },
      el("span", {}, g.label),
      el("span", { class: "text-slate-400" }, "·"),
      el("span", { class: "text-slate-400" }, String(g.items.length)),
    ));
    for (const it of g.items) list.append(renderListRow(it));
  }
}

function sortComparator(by) {
  return (a, b) => {
    switch (by) {
      case "status": {
        const ai = STATUS_ORDER.indexOf(a.status || "todo");
        const bi = STATUS_ORDER.indexOf(b.status || "todo");
        return (ai - bi) || (b.updated_at || "").localeCompare(a.updated_at || "");
      }
      case "priority": {
        const ai = PRIORITY_ORDER.indexOf(a.priority || "normal");
        const bi = PRIORITY_ORDER.indexOf(b.priority || "normal");
        return (ai - bi) || (b.updated_at || "").localeCompare(a.updated_at || "");
      }
      case "title": return (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" });
      case "created": return (b.created_at || "").localeCompare(a.created_at || "");
      case "due": {
        const av = a.due_at || "9999"; const bv = b.due_at || "9999";
        return av.localeCompare(bv);
      }
      case "time_spent": {
        const av = (state.taskTotals || {})[a.id] || 0;
        const bv = (state.taskTotals || {})[b.id] || 0;
        return bv - av;
      }
      case "updated":
      default:
        return (b.updated_at || "").localeCompare(a.updated_at || "");
    }
  };
}

function groupItems(items, by) {
  if (by === "status") {
    const buckets = new Map(STATUS_ORDER.map((s) => [s, []]));
    for (const it of items) {
      const k = it.status || "todo";
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(it);
    }
    return [...buckets.entries()].filter(([, v]) => v.length).map(([k, v]) => ({ key: k, label: k, items: v }));
  }
  if (by === "priority") {
    const buckets = new Map(PRIORITY_ORDER.map((p) => [p, []]));
    buckets.set("(none)", []);
    for (const it of items) {
      const k = it.priority || "(none)";
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(it);
    }
    return [...buckets.entries()].filter(([, v]) => v.length).map(([k, v]) => ({ key: k, label: k, items: v }));
  }
  if (by === "tag") {
    const map = new Map();
    for (const it of items) {
      const tags = (it.tags && it.tags.length) ? it.tags : ["(untagged)"];
      for (const t of tags) {
        if (!map.has(t)) map.set(t, []);
        map.get(t).push(it);
      }
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => ({ key: k, label: k, items: v }));
  }
  return [{ key: "_", label: "", items }];
}

function renderListRow(item) {
  const proj = state.projects.find((p) => p.id === item.projectId || p.id === item.project_id);
  const projectId = item.projectId ?? item.project_id;
  const title = (item.display_label || "").trim() || item.title || (item.url ? hostOf(item.url) : item.body?.slice(0, 60) || "(untitled)");
  const sub = item.kind === "link" ? item.url : (item.body || "").trim().split("\n")[0].slice(0, 120);
  const chips = [];
  if (item.kind === "task" && item.status) chips.push(el("span", { class: "chip " + item.status }, item.status));
  if (item.kind === "task" && item.priority && item.priority !== "normal") chips.push(el("span", { class: "chip " + item.priority }, item.priority));
  if (item.kind === "link" && !item.is_read) chips.push(el("span", { class: "chip" }, "unread"));
  if (proj) chips.push(el("span", { class: "chip" }, proj.name));
  if (item.kind === "task") {
    const secs = (state.taskTotals || {})[item.id];
    if (secs && secs > 0) chips.push(el("span", { class: "chip", title: "Time spent" }, "⏱ " + fmtDuration(secs)));
  }

  const row = el("div", {
    class: "list-row border-l-4 border-transparent px-3 py-2 cursor-pointer hover:bg-slate-50 border-b border-slate-100 " +
      (state.selectedId === item.id ? "selected" : ""),
    onclick: () => selectItem(item.id),
  },
    el("div", { class: "flex items-center justify-between gap-2" },
      el("div", { class: "text-sm font-medium text-slate-900 truncate" }, title),
      el("div", { class: "text-[10px] text-slate-400 shrink-0" }, "#" + item.id),
    ),
    sub ? el("div", { class: "text-xs text-slate-500 truncate mt-0.5" }, sub) : null,
    chips.length ? el("div", { class: "mt-1 flex flex-wrap gap-1" }, ...chips) : null,
  );
  return row;
}

function hostOf(url) { try { return new URL(url).host; } catch { return url; } }

// ---------- detail ----------
async function selectItem(id) {
  state.selectedId = id;
  document.querySelectorAll(".list-row").forEach((r) => r.classList.remove("selected"));
  try {
    state.selected = await api("/items/" + id);
  } catch (e) {
    $("#detail").replaceChildren(el("div", { class: "p-6 text-sm text-red-600" }, "Failed: " + e.message));
    return;
  }
  // Now that an item is selected, apply focus body attr (if focusMode is on).
  _applyFocusBodyAttr();
  // mark selected
  for (const row of document.querySelectorAll(".list-row")) {
    if (row.textContent.includes("#" + id)) row.classList.add("selected");
  }
  renderDetail();
  state.mobilePane = null;
  syncMobile(); // drill into the detail pane on phones
}

function renderDetail() {
  const d = $("#detail");
  d.replaceChildren();
  const it = state.selected;
  renderHeaderItemActions();
  if (!it) {
    d.append(el("div", { class: "p-8 text-slate-400 text-sm" }, "Select an item."));
    return;
  }
  const proj = state.projects.find((p) => p.id === (it.projectId ?? it.project_id));
  const draft = state.drafts[it.id] || {};
  const titleVal = draft.title ?? it.title ?? "";
  const bodyVal = draft.body ?? it.body ?? "";

  // On phones the detail replaces the list; give it a way back.
  const backBar = el("div", { class: "md:hidden sticky top-0 z-10 bg-white border-b border-slate-200 px-3 py-2" },
    el("button", {
      class: "text-sm text-slate-600 flex items-center gap-1 hover:text-slate-900",
      onclick: () => { clearSel(); renderDetail(); },
    }, "← Back to list"));

  const header = el("div", { class: "px-6 pt-5 pb-3 border-b border-slate-200" },
    el("div", { class: "flex items-center gap-2 text-xs text-slate-500" },
      el("span", {}, "#" + it.id),
      el("span", {}, "·"),
      el("span", {}, it.kind),
      proj ? el("span", {}, "·") : null,
      proj ? el("span", {}, proj.name) : null,
      el("span", { class: "ml-auto" }, "updated " + fmtDate(it.updatedAt ?? it.updated_at)),
      // Focus / Share / History live in the top header (see renderHeaderItemActions).
    ),
    it.kind !== "link"
      ? (state.focusMode
          ? el("div", { class: "mt-2 text-2xl font-semibold text-slate-900" }, titleVal || "(untitled)")
          : el("input", {
              type: "text", value: titleVal, placeholder: "Title",
              class: "mt-2 w-full text-2xl font-semibold border-0 focus:outline-none focus:ring-0 px-0",
              oninput: (e) => { setDraftQuiet(it.id, "title", e.target.value); },
            }))
      : el("div", { class: "mt-2" },
          el("a", { href: it.url, target: "_blank", rel: "noopener", class: "text-xl font-semibold text-blue-700 hover:underline" },
            (it.display_label || "").trim() || it.title || it.url),
          el("div", { class: "text-xs text-slate-500 mt-0.5 truncate" }, it.url),
          it.link_description ? el("div", { class: "text-sm text-slate-600 mt-2" }, it.link_description) : null,
        ),
  );

  const meta = renderMeta(it, draft);
  const editor = renderEditor(it, bodyVal);
  const actions = renderActions(it);
  const refs = renderRefs(it);

  d.append(backBar, header);
  if (!state.focusMode) d.append(meta, renderTagsEditor(it));
  if (!state.focusMode && it.kind === "task") d.append(renderTimeBlock(it));
  d.append(editor);
  if (!state.focusMode) d.append(actions);
  d.append(refs);
}

function toggleFocusMode() {
  state.focusMode = !state.focusMode;
  try { localStorage.setItem("focusMode", JSON.stringify(state.focusMode)); } catch {}
  _applyFocusBodyAttr();
  renderDetail();
}

// Keep the body data-attribute in sync with state.focusMode. The CSS in
// style.css uses body[data-focus="1"] to hide the sidebar / list / splitter
// and let the detail pane span the full window width.
//
// Important: focus mode only applies visually when an item is actually
// being viewed. On Home / project lists without a selection, leave the
// layout normal — otherwise reloading the page (with focusMode persisted)
// would hide the sidebar with nothing focused to see.
function _applyFocusBodyAttr() {
  if (state.focusMode && state.selected) document.body.setAttribute("data-focus", "1");
  else document.body.removeAttribute("data-focus");
}
// Apply once on script load so a reload that restores focusMode = true from
// localStorage gives full width immediately.
_applyFocusBodyAttr();

// ---------- phone layout: drill-down stack + bottom tab bar ----------
// The desktop three-pane layout is collapsed into a one-pane-at-a-time stack
// on narrow screens. All the show/hide is done in CSS via body[data-mobile]
// and body[data-pane]; this controller just keeps those attributes in sync
// with the existing nav state (state.pseudo / .scopeProjectId / .selected).
const MOBILE_MQ = window.matchMedia("(max-width: 640px)");
const isMobile = () => MOBILE_MQ.matches;

// Which stack level should be visible, derived from view state (or forced to
// the project browser when the Projects tab was tapped).
function currentMobilePane() {
  if (state.mobilePane === "projects") return "projects";
  if (state.selected) return "detail";
  if (state.pseudo === "home" && !state.search.trim()) return "home";
  return "list";
}

function syncMobile() {
  const body = document.body;
  if (!isMobile()) {
    body.removeAttribute("data-mobile");
    body.removeAttribute("data-pane");
    return;
  }
  const pane = currentMobilePane();
  body.setAttribute("data-mobile", "1");
  body.setAttribute("data-pane", pane);
  // Bottom-bar highlight: list/detail live "under" Projects.
  const activeTab = pane === "home" ? "home" : "projects";
  for (const b of document.querySelectorAll("#mobile-tabbar button")) {
    b.classList.toggle("active", b.dataset.tab === activeTab);
  }
}

// One level up in the stack: detail → list → projects.
function mobileBack() {
  const pane = document.body.getAttribute("data-pane");
  if (pane === "detail") { clearSel(); syncMobile(); }
  else if (pane === "list") { state.mobilePane = "projects"; syncMobile(); }
}

(function setupMobileNav() {
  const back = document.getElementById("mobile-back");
  if (back) back.addEventListener("click", mobileBack);

  const bar = document.getElementById("mobile-tabbar");
  if (bar) {
    bar.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-tab]");
      if (!btn) return;
      switch (btn.dataset.tab) {
        case "home":
          state.pseudo = "home"; state.scopeProjectId = null; state.search = "";
          clearSel(); state.mobilePane = null; renderSidebar(); await dispatchView();
          break;
        case "projects":
          state.mobilePane = "projects"; syncMobile();
          break;
        case "search":
          state.pseudo = "home"; state.search = "";
          clearSel(); state.mobilePane = null; renderSidebar(); await dispatchView();
          document.getElementById("home-search")?.focus();
          break;
        case "new":
          openNewItemModal();
          break;
      }
    });
  }

  // Re-sync when crossing the breakpoint (rotation, resize, desktop⇄mobile).
  MOBILE_MQ.addEventListener("change", syncMobile);
})();

function renderTagsEditor(it) {
  const wrap = el("div", { class: "px-6 py-2 border-b border-slate-200 bg-white" });
  let tags = [...(it.tags || [])];

  async function persist() {
    const path = it.kind === "task" ? `/tasks/${it.id}` :
                 it.kind === "note" ? `/notes/${it.id}` : `/links/${it.id}`;
    try {
      const updated = await api(path, { method: "PATCH", body: JSON.stringify({ tags }) });
      if (state.selected?.id === it.id) state.selected = updated;
      const idx = state.items.findIndex((x) => x.id === it.id);
      if (idx >= 0) state.items[idx] = updated;
      renderList();
    } catch (e) { toast(e.message); }
  }

  function refresh(focusInput) {
    wrap.replaceChildren();
    const row = el("div", { class: "flex items-center flex-wrap gap-1.5" },
      el("span", { class: "text-xs uppercase tracking-wider text-slate-500 mr-1" }, "Tags"),
    );

    for (const t of tags) {
      row.append(
        el("span", { class: "chip inline-flex items-center gap-1 pr-1" },
          el("span", {}, t),
          el("button", {
            class: "text-slate-500 hover:text-red-600 leading-none w-3 h-3 inline-flex items-center justify-center",
            title: "Remove",
            onclick: () => { tags = tags.filter((x) => x !== t); refresh(false); persist(); },
          }, "✕"),
        )
      );
    }

    const input = el("input", {
      type: "text",
      placeholder: tags.length ? "+ tag" : "Add tag…",
      class: "text-xs border border-slate-200 rounded px-2 py-0.5 w-28 focus:outline-none focus:ring-1 focus:ring-blue-200",
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === ",") {
          e.preventDefault();
          const v = e.target.value.trim().replace(/,/g, "");
          if (v && !tags.includes(v)) {
            tags.push(v);
            refresh(true);
            persist();
          } else if (v && tags.includes(v)) {
            e.target.value = "";
          }
        } else if (e.key === "Backspace" && e.target.value === "" && tags.length > 0) {
          e.preventDefault();
          tags.pop();
          refresh(true);
          persist();
        }
      },
      onblur: (e) => {
        // commit a pending value if the user clicks away
        const v = e.target.value.trim().replace(/,/g, "");
        if (v && !tags.includes(v)) {
          tags.push(v);
          refresh(false);
          persist();
        }
      },
    });
    row.append(input);

    wrap.append(row);
    if (focusInput) input.focus();
  }

  refresh(false);
  return wrap;
}

function renderTimeBlock(it) {
  const wrap = el("div", { class: "px-6 py-3 border-b border-slate-200 bg-slate-50/60" });
  const summary = el("div", { class: "flex items-center gap-3" });
  const sessionsList = el("div", { class: "mt-3 hidden" });
  let expanded = false;
  let cachedSessions = null;

  const totalEl = el("span", { class: "text-2xl font-semibold tabular-nums text-slate-900" }, "—");
  const subEl = el("span", { class: "text-xs text-slate-500" }, "");

  const refresh = async () => {
    try {
      const sessions = await api(`/tasks/${it.id}/sessions`);
      cachedSessions = sessions;
      const total = sessions.reduce((s, x) => s + (x.duration_seconds || 0), 0);
      totalEl.textContent = fmtDuration(total);
      const openCount = sessions.filter((s) => s.is_open).length;
      subEl.textContent = `${sessions.length} session${sessions.length === 1 ? "" : "s"}${openCount ? ` · ${openCount} open` : ""}`;
      if (expanded) renderSessions();
    } catch (e) {
      totalEl.textContent = "?";
      subEl.textContent = e.message;
    }
  };

  const toggleBtn = el("button", {
    class: "text-xs text-slate-500 hover:text-slate-900 underline",
    onclick: () => {
      expanded = !expanded;
      sessionsList.classList.toggle("hidden", !expanded);
      toggleBtn.textContent = expanded ? "Hide sessions" : "Show sessions";
      if (expanded && cachedSessions) renderSessions();
    },
  }, "Show sessions");

  const addBtn = el("button", {
    class: "ml-auto px-2 py-1 text-xs border border-slate-300 rounded bg-white hover:bg-slate-100 text-slate-700",
    onclick: () => {
      expanded = true;
      sessionsList.classList.remove("hidden");
      toggleBtn.textContent = "Hide sessions";
      renderAddForm();
    },
  }, "+ Add session");

  summary.append(
    el("div", { class: "flex flex-col" },
      el("span", { class: "text-xs uppercase tracking-wider text-slate-500" }, "Time spent"),
      el("div", { class: "flex items-baseline gap-2" }, totalEl, subEl),
    ),
    el("div", { class: "flex-1" }),
    toggleBtn,
    addBtn,
  );

  function renderSessions() {
    sessionsList.replaceChildren();
    if (!cachedSessions || cachedSessions.length === 0) {
      sessionsList.append(el("div", { class: "text-sm text-slate-400 italic" }, "No sessions yet."));
      return;
    }
    for (const s of cachedSessions) sessionsList.append(renderSessionRow(s));
  }

  function renderSessionRow(s) {
    const row = el("div", { class: "flex items-center gap-2 py-1.5 border-b border-slate-200 last:border-0 text-sm" });
    row.append(
      el("div", { class: "flex-1 min-w-0" },
        el("div", {},
          el("span", { class: "tabular-nums" }, fmtSessionTime(s.started_at)),
          el("span", { class: "text-slate-400 mx-1" }, "→"),
          el("span", { class: "tabular-nums" }, s.is_open ? el("em", { class: "text-amber-600" }, "ongoing") : fmtSessionTime(s.ended_at)),
        ),
      ),
      el("div", { class: "tabular-nums font-mono text-slate-700 w-20 text-right" }, fmtDuration(s.duration_seconds)),
      el("button", { class: "text-xs text-slate-500 hover:text-slate-900 underline", onclick: () => enterEditMode(row, s) }, "Edit"),
      el("button", { class: "text-xs text-red-600 hover:underline", onclick: () => deleteSession(s) }, "Delete"),
    );
    return row;
  }

  function enterEditMode(row, s) {
    row.replaceChildren();
    const startInput = el("input", { type: "datetime-local", value: isoToLocalInput(s.started_at), class: "border border-slate-300 rounded px-2 py-1 text-sm" });
    const endInput = el("input", { type: "datetime-local", value: s.ended_at ? isoToLocalInput(s.ended_at) : "", class: "border border-slate-300 rounded px-2 py-1 text-sm" });
    row.append(
      startInput,
      el("span", { class: "text-slate-400" }, "→"),
      endInput,
      el("button", {
        class: "ml-2 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700",
        onclick: async () => {
          try {
            const body = {
              started_at: localInputToIso(startInput.value),
              ended_at: endInput.value ? localInputToIso(endInput.value) : "",
            };
            await api(`/sessions/${s.id}`, { method: "PATCH", body: JSON.stringify(body) });
            toast("Updated");
            await refresh();
          } catch (e) { toast(e.message); }
        },
      }, "Save"),
      el("button", { class: "px-2 py-1 text-xs text-slate-600 hover:underline", onclick: () => renderSessions() }, "Cancel"),
    );
  }

  async function deleteSession(s) {
    if (!confirm(`Delete this session (${fmtDuration(s.duration_seconds)})?`)) return;
    try {
      await api(`/sessions/${s.id}`, { method: "DELETE" });
      toast("Deleted");
      await refresh();
    } catch (e) { toast(e.message); }
  }

  function renderAddForm() {
    const now = new Date();
    const earlier = new Date(now.getTime() - 30 * 60 * 1000);
    const startInput = el("input", { type: "datetime-local", value: isoToLocalInput(earlier.toISOString()), class: "border border-slate-300 rounded px-2 py-1 text-sm" });
    const endInput = el("input", { type: "datetime-local", value: isoToLocalInput(now.toISOString()), class: "border border-slate-300 rounded px-2 py-1 text-sm" });
    const form = el("div", { class: "flex items-center gap-2 py-2 border-b border-slate-200" },
      el("span", { class: "text-xs text-slate-500 w-12" }, "New:"),
      startInput,
      el("span", { class: "text-slate-400" }, "→"),
      endInput,
      el("button", {
        class: "ml-2 px-2 py-1 text-xs bg-slate-900 text-white rounded hover:bg-slate-700",
        onclick: async () => {
          try {
            const body = {
              started_at: localInputToIso(startInput.value),
              ended_at: endInput.value ? localInputToIso(endInput.value) : null,
            };
            await api(`/tasks/${it.id}/sessions`, { method: "POST", body: JSON.stringify(body) });
            toast("Session added");
            await refresh();
          } catch (e) { toast(e.message); }
        },
      }, "Add"),
      el("button", { class: "px-2 py-1 text-xs text-slate-600 hover:underline", onclick: () => renderSessions() }, "Cancel"),
    );
    sessionsList.replaceChildren(form);
  }

  wrap.append(summary, sessionsList);
  refresh();
  return wrap;
}

function renderMeta(it, draft) {
  const row = el("div", { class: "px-6 py-3 flex flex-wrap gap-3 border-b border-slate-200 items-center text-sm" });
  if (it.kind === "task") {
    const status = draft.status ?? it.status ?? "todo";
    const priority = draft.priority ?? it.priority ?? "normal";
    row.append(label("Status",
      el("select", {
        class: "border border-slate-300 rounded px-2 py-1 text-sm",
        onchange: (e) => setDraftLoud(it.id, "status", e.target.value),
      }, ...TASK_STATUSES.map((s) => el("option", { value: s, selected: s === status }, s)))
    ));
    row.append(label("Priority",
      el("select", {
        class: "border border-slate-300 rounded px-2 py-1 text-sm",
        onchange: (e) => setDraftLoud(it.id, "priority", e.target.value),
      }, ...["low", "normal", "high"].map((p) => el("option", { value: p, selected: p === priority }, p)))
    ));
    const dueVal = draft.due_at !== undefined ? draft.due_at : it.due_at;
    row.append(label("Due",
      el("input", {
        type: "date", value: isoToDateInput(dueVal),
        class: "border border-slate-300 rounded px-2 py-1 text-sm",
        onchange: (e) => setDraftLoud(it.id, "due_at", dateInputToIso(e.target.value)),
      })
    ));
    const estMin = draft.estimate_minutes !== undefined ? draft.estimate_minutes : it.estimate_minutes;
    row.append(label("Estimate (h)",
      el("input", {
        type: "number", min: "0", step: "0.25",
        value: estMin != null ? (estMin / 60) : "",
        placeholder: "—", title: "Estimated hours",
        class: "border border-slate-300 rounded px-2 py-1 text-sm w-20",
        onchange: (e) => setDraftLoud(it.id, "estimate_minutes", estimateInputToMinutes(e.target.value)),
      })
    ));
    if ((draft.status ?? it.status) === "blocked") {
      row.append(label("Reason",
        el("input", {
          type: "text", value: draft.blocked_reason ?? it.blocked_reason ?? "",
          class: "border border-slate-300 rounded px-2 py-1 text-sm w-60",
          oninput: (e) => setDraftQuiet(it.id, "blocked_reason", e.target.value),
        })
      ));
    }
  } else if (it.kind === "link") {
    const is_read = draft.is_read ?? it.is_read;
    const display_label = draft.display_label ?? it.display_label ?? "";
    row.append(label("Label",
      el("input", {
        type: "text", value: display_label,
        placeholder: "Optional — shown instead of title",
        class: "border border-slate-300 rounded px-2 py-1 text-sm w-64",
        oninput: (e) => setDraftQuiet(it.id, "display_label", e.target.value),
      })
    ));
    row.append(label("",
      el("label", { class: "flex items-center gap-1 cursor-pointer" },
        el("input", {
          type: "checkbox", ...(is_read ? { checked: "checked" } : {}),
          onchange: (e) => setDraftLoud(it.id, "is_read", e.target.checked),
        }),
        el("span", {}, "Read")
      )
    ));
    const is_pinned = !!it.is_pinned;
    row.append(el("button", {
      class: "ml-auto px-2 py-1 text-xs rounded border " +
        (is_pinned ? "bg-amber-100 border-amber-300 text-amber-800" : "border-slate-300 text-slate-600 hover:bg-slate-50"),
      title: is_pinned ? "Remove bookmark" : "Add bookmark",
      onclick: () => togglePin(it),
    }, is_pinned ? "★ Bookmarked" : "☆ Bookmark"));
  } else if (it.kind === "note") {
    const dueVal = draft.due_at !== undefined ? draft.due_at : it.due_at;
    row.append(label("Date",
      el("input", {
        type: "date", value: isoToDateInput(dueVal),
        title: "Show this note on the calendar for a given day",
        class: "border border-slate-300 rounded px-2 py-1 text-sm",
        onchange: (e) => setDraftLoud(it.id, "due_at", dateInputToIso(e.target.value)),
      })
    ));
  }
  return row;
}

function label(text, child) {
  return el("div", { class: "flex items-center gap-2" },
    text ? el("span", { class: "text-slate-500 text-xs uppercase tracking-wider" }, text) : null,
    child
  );
}

// ---------- markdown toolbar helpers ----------
function _mdBtn(label, title, onClick, extraClass = "") {
  return el("button", {
    class: "px-2 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 min-w-[28px] " + extraClass,
    title, type: "button", onclick: onClick,
  }, label);
}
function _mdSep() {
  return el("span", { class: "inline-block w-px h-5 bg-slate-200 mx-0.5", "aria-hidden": "true" });
}

function _emitInput(ta) {
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

function _mdWrap(ta, before, after, placeholder = "") {
  const s = ta.selectionStart, e = ta.selectionEnd;
  const had = e > s;
  const sel = had ? ta.value.slice(s, e) : placeholder;
  ta.value = ta.value.slice(0, s) + before + sel + after + ta.value.slice(e);
  ta.focus();
  if (had) {
    ta.selectionStart = s + before.length;
    ta.selectionEnd   = s + before.length + sel.length;
  } else {
    // Pre-select the placeholder so the user can type over it
    ta.selectionStart = s + before.length;
    ta.selectionEnd   = s + before.length + placeholder.length;
  }
  _emitInput(ta);
}

function _mdPrefix(ta, prefix) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  const v = ta.value;
  const lineStart = v.lastIndexOf("\n", s - 1) + 1;
  const lineEndIdx = v.indexOf("\n", e);
  const blockEnd = lineEndIdx === -1 ? v.length : lineEndIdx;
  const block = v.slice(lineStart, blockEnd) || ""; // allow on empty line
  let counter = 1;
  const newBlock = (block === "" ? [""] : block.split("\n"))
    .map((line) => prefix === "__num__" ? `${counter++}. ${line}` : prefix + line)
    .join("\n");
  ta.value = v.slice(0, lineStart) + newBlock + v.slice(blockEnd);
  ta.focus();
  ta.selectionStart = lineStart;
  ta.selectionEnd   = lineStart + newBlock.length;
  _emitInput(ta);
}

function _mdInsert(ta, text) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = s + text.length;
  _emitInput(ta);
}

function _mdLink(ta) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.slice(s, e) || "link text";
  const url = prompt("URL", "https://");
  if (!url) return;
  const md = `[${sel}](${url})`;
  ta.value = ta.value.slice(0, s) + md + ta.value.slice(e);
  ta.focus();
  // place selection on the link text portion so the user can refine it
  ta.selectionStart = s + 1;
  ta.selectionEnd   = s + 1 + sel.length;
  _emitInput(ta);
}

function _mdCodeBlock(ta) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.slice(s, e) || "code";
  const needsLeadingNl = s > 0 && ta.value[s - 1] !== "\n";
  const block = (needsLeadingNl ? "\n" : "") + "```\n" + sel + "\n```\n";
  ta.value = ta.value.slice(0, s) + block + ta.value.slice(e);
  ta.focus();
  // place caret/selection inside the code fence
  const openLen = (needsLeadingNl ? 1 : 0) + 4; // "\n```\n" or "```\n"
  ta.selectionStart = s + openLen;
  ta.selectionEnd   = s + openLen + sel.length;
  _emitInput(ta);
}

function _mdAdmonition(ta) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.slice(s, e) || "body";
  const block = `!!! note\n    ${sel.replace(/\n/g, "\n    ")}\n`;
  ta.value = ta.value.slice(0, s) + block + ta.value.slice(e);
  ta.focus();
  ta.selectionStart = s + 4;      // after "!!! "
  ta.selectionEnd   = s + 8;      // selects "note" so user can rename
  _emitInput(ta);
}

function renderEditor(it, bodyVal) {
  const outer = el("div", { class: "px-6 py-3" });

  // ── Focus mode: read-only reading view with an optional TOC rail ──
  if (state.focusMode) {
    outer.className = "";  // reading view manages its own padding/width

    const article = el("div", {
      class: "prose-body focus-article",
      id: "md-preview",
    });

    // Renders the body, decorates headings (ids + optional numbering), and
    // (re)builds the TOC rail. Called on first render and whenever #N titles
    // resolve so the decoration stays consistent.
    const layout = el("div", { class: "focus-layout" });
    let scrollSpy = null;
    function paint() {
      renderMarkdownInto(article, (state.drafts[it.id] && state.drafts[it.id].body) ?? bodyVal);
      const headings = collectHeadings(article, { number: state.numberHeadings });
      layout.replaceChildren();
      layout.classList.toggle("no-toc", !state.tocVisible);
      if (state.tocVisible) {
        const nav = buildTocNav(headings);
        const stored = Number(localStorage.getItem("tocWidth") || 0);
        if (stored >= 140 && stored <= 560) nav.style.width = stored + "px";
        const tocSplit = el("div", { class: "toc-splitter", title: "Drag to resize contents (double-click to reset)" });
        wirePaneSplitter(nav, tocSplit, { key: "tocWidth", def: 256, min: 140, max: 560 });
        layout.append(nav, tocSplit, article);
      } else {
        layout.append(article);
      }
      // Scroll-spy needs the article in the DOM; wire it after this frame.
      if (scrollSpy) { scrollSpy.disconnect(); scrollSpy = null; }
      if (state.tocVisible && headings.length) {
        requestAnimationFrame(() => {
          const nav = layout.querySelector(".md-toc");
          const root = document.getElementById("detail");
          if (nav && document.body.contains(article)) {
            scrollSpy = attachTocScrollSpy(root, article, nav);
          }
        });
      }
    }

    article.addEventListener("click", async (e) => {
      const drawingImg = e.target.closest("[data-edit-drawing]");
      if (drawingImg) {
        // Focus mode: clicking a drawing opens a zoomed lightbox view
        // (drawio editing stays available in edit mode only).
        e.preventDefault();
        const attId = Number(drawingImg.dataset.editDrawing);
        if (attId) openDrawingLightbox(attId);
        return;
      }
      const idAnchor = e.target.closest("[data-ref]");
      if (idAnchor) {
        e.preventDefault();
        const id = Number(idAnchor.dataset.ref);
        if (id) selectItem(id);
        return;
      }
      const titleAnchor = e.target.closest("[data-ref-title]");
      if (titleAnchor) {
        e.preventDefault();
        const hit = await resolveTitleRef(titleAnchor.dataset.refTitle);
        if (hit) selectItem(hit.id);
      }
    });

    // Toggle bar: Contents (TOC) and 1. Numbering. Both persist and re-paint.
    const mkToggle = (label, key, title) => el("button", {
      class: "reader-toggle" + (state[key] ? " on" : ""),
      type: "button",
      title,
      onclick: (e) => {
        state[key] = !state[key];
        try { localStorage.setItem(key, JSON.stringify(state[key])); } catch {}
        e.currentTarget.classList.toggle("on", state[key]);
        paint();
      },
    }, label);
    const toolbar = el("div", { class: "reader-toolbar" },
      mkToggle("☰ Contents", "tocVisible", "Show / hide the table of contents"),
      mkToggle("1. Numbering", "numberHeadings", "Number headings by their level (1, 1.1, 1.1.1…)"),
    );

    paint();

    // Hydrate any #N title decorations, then repaint so titles + TOC agree.
    const ids = extractIdRefs(bodyVal);
    if (ids.length) {
      ensureTitlesFor(ids).then((changed) => {
        if (changed && document.body.contains(article)) paint();
      });
    }

    outer.append(toolbar, layout);
    return outer;
  }

  const wrap = el("div", { class: "edit-split" });

  const ta = el("textarea", {
    class: "edit-editor w-full font-mono text-sm border border-slate-200 rounded p-3 focus:outline-none focus:ring-2 focus:ring-blue-100",
    placeholder: it.kind === "link" ? "Annotation… (markdown)" : "Body… (markdown, supports #42, [[title]], ![[drawing:N]])",
    oninput: (e) => { setDraftQuiet(it.id, "body", e.target.value); updatePreview(e.target.value); },
    spellcheck: "false",
  }, bodyVal);
  // Cmd/Ctrl shortcuts: B = bold, I = italic, K = link.
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if      (k === "b") { e.preventDefault(); _mdWrap(ta, "**", "**", "bold"); }
      else if (k === "i") { e.preventDefault(); _mdWrap(ta, "*",  "*",  "italic"); }
      else if (k === "k") { e.preventDefault(); _mdLink(ta); }
    }
  });

  // Markdown formatting toolbar above the editor.
  const toolbar = el("div", { class: "mb-2 flex flex-wrap items-center gap-1 text-xs select-none" },
    _mdBtn("B",       "Bold (⌘/Ctrl+B)",        () => _mdWrap(ta, "**", "**", "bold"),  "font-bold"),
    _mdBtn("I",       "Italic (⌘/Ctrl+I)",      () => _mdWrap(ta, "*",  "*",  "italic"), "italic"),
    _mdBtn("S",       "Strikethrough",         () => _mdWrap(ta, "~~", "~~", "strike"), "line-through"),
    _mdBtn("</>",     "Inline code",           () => _mdWrap(ta, "`",  "`",  "code"),   "font-mono"),
    _mdSep(),
    _mdBtn("H1",      "Heading 1",             () => _mdPrefix(ta, "# ")),
    _mdBtn("H2",      "Heading 2",             () => _mdPrefix(ta, "## ")),
    _mdBtn("H3",      "Heading 3",             () => _mdPrefix(ta, "### ")),
    _mdSep(),
    _mdBtn("•",       "Bulleted list",         () => _mdPrefix(ta, "- ")),
    _mdBtn("1.",      "Numbered list",         () => _mdPrefix(ta, "__num__")),
    _mdBtn("☐",       "Task list item",        () => _mdPrefix(ta, "- [ ] ")),
    _mdBtn("❝",       "Quote",                 () => _mdPrefix(ta, "> ")),
    _mdSep(),
    _mdBtn("🔗",      "Link (⌘/Ctrl+K)",       () => _mdLink(ta)),
    _mdBtn("```",     "Code block",            () => _mdCodeBlock(ta)),
    _mdBtn("─",       "Horizontal rule",       () => _mdInsert(ta, "\n\n---\n\n")),
    _mdBtn("!!!",     "Note admonition",       () => _mdAdmonition(ta)),
    _mdSep(),
    el("button", {
      class: "px-2 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-100",
      title: "Insert a drawio drawing",
      type: "button",
      onclick: () => openDrawingEditor(it, null, ta),
    }, "✎ Drawing"),
  );

  const preview = el("div", { class: "edit-preview prose-body border border-slate-100 rounded p-3 bg-slate-50 overflow-auto", id: "md-preview" });
  renderMarkdownInto(preview, bodyVal);

  // Selecting rendered text mirrors the matching markdown source into the
  // editor's selection (see mirrorPreviewSelectionToEditor). Deferred a tick so
  // the browser has finalized the selection by the time we read it.
  const mirrorSel = () => setTimeout(() => mirrorPreviewSelectionToEditor(preview, ta), 0);
  preview.addEventListener("mouseup", mirrorSel);
  preview.addEventListener("dblclick", mirrorSel);

  // Click handler: navigate on #N and [[Title]] anchors, edit on drawings.
  preview.addEventListener("click", async (e) => {
    const drawingImg = e.target.closest("[data-edit-drawing]");
    if (drawingImg) {
      e.preventDefault();
      const attId = Number(drawingImg.dataset.editDrawing);
      openDrawingEditor(it, attId, ta);
      return;
    }
    const idAnchor = e.target.closest("[data-ref]");
    if (idAnchor) {
      e.preventDefault();
      const id = Number(idAnchor.dataset.ref);
      if (id) selectItem(id);
      return;
    }
    const titleAnchor = e.target.closest("[data-ref-title]");
    if (titleAnchor) {
      e.preventDefault();
      const title = titleAnchor.dataset.refTitle;
      const hit = await resolveTitleRef(title);
      if (hit) selectItem(hit.id);
      else toast(`No item titled "${title}"`);
    }
  });

  // Fetch titles for any #N refs in the body, then refresh preview once they arrive.
  (async () => {
    const ids = extractIdRefs(bodyVal);
    if (ids.length === 0) return;
    const changed = await ensureTitlesFor(ids);
    if (changed && document.body.contains(preview)) {
      const latest = (state.drafts[it.id] && state.drafts[it.id].body) ?? bodyVal;
      renderMarkdownInto(preview, latest);
    }
  })();

  // Rendered preview on the LEFT, editor on the RIGHT, with a draggable divider.
  const paneSplit = el("div", { class: "edit-pane-splitter", title: "Drag to resize (double-click to reset)" });
  const stored = Number(localStorage.getItem("editPreviewWidth") || 0);
  if (stored >= 240 && stored <= 1600) preview.style.width = stored + "px";
  wirePaneSplitter(preview, paneSplit, { key: "editPreviewWidth", def: null, min: 240, max: 1600 });
  wrap.append(preview, paneSplit, ta);
  outer.append(toolbar, wrap);
  return outer;

  function updatePreview(text) {
    renderMarkdownInto(preview, text);
    const ids = extractIdRefs(text);
    if (ids.some((id) => !_titleCache.has(id))) {
      ensureTitlesFor(ids).then((changed) => {
        if (changed && document.body.contains(preview)) {
          const latest = (state.drafts[it.id] && state.drafts[it.id].body) ?? text;
          renderMarkdownInto(preview, latest);
        }
      });
    }
  }
}

const _titleCache = new Map(); // id -> title (or "" if not found)

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Custom admonition plugin: MkDocs-style `!!! type [title]` blocks with
// 4-space-indented body. Emits <div class="admonition <type>"><p class="admonition-title">…</p> …body…</div>.
function admonitionPlugin(md) {
  function rule(state, startLine, endLine, silent) {
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (state.sCount[startLine] - state.blkIndent >= 4) return false; // not at base indent
    if (pos + 4 > max) return false;
    if (state.src.charCodeAt(pos)     !== 0x21 ||
        state.src.charCodeAt(pos + 1) !== 0x21 ||
        state.src.charCodeAt(pos + 2) !== 0x21) return false;
    const header = state.src.slice(pos, max);
    const m = header.match(/^!!!\s+([\w-]+)\s*(?:"([^"]*)")?\s*(.*)$/);
    if (!m) return false;
    if (silent) return true;

    const type = m[1].toLowerCase();
    const title = (m[2] || m[3] || "").trim() || (type.charAt(0).toUpperCase() + type.slice(1));

    // Consume indented body lines.
    let nextLine = startLine + 1;
    const bodyLines = [];
    while (nextLine < endLine) {
      const lineStart = state.bMarks[nextLine];
      const lineMax = state.eMarks[nextLine];
      const raw = state.src.slice(lineStart, lineMax);
      if (raw.trim() === "") {
        // Blank line: may continue if a following line is still indented
        let look = nextLine + 1;
        let continues = false;
        while (look < endLine) {
          const r = state.src.slice(state.bMarks[look], state.eMarks[look]);
          if (r.trim() === "") { look++; continue; }
          if (r.startsWith("    ") || r.startsWith("\t")) continues = true;
          break;
        }
        if (!continues) break;
        bodyLines.push("");
        nextLine++;
        continue;
      }
      if (raw.startsWith("    "))      bodyLines.push(raw.slice(4));
      else if (raw.startsWith("\t"))   bodyLines.push(raw.slice(1));
      else                              break;
      nextLine++;
    }

    // Strip trailing blanks.
    while (bodyLines.length && bodyLines[bodyLines.length - 1] === "") bodyLines.pop();

    const bodyHtml = bodyLines.length ? md.render(bodyLines.join("\n")) : "";

    // Theme per admonition type. Inline styles so external CSS / preflight order doesn't matter.
    const THEME = {
      note:    { border: "#3b82f6", bg: "#eff6ff", title: "#1d4ed8" },
      info:    { border: "#3b82f6", bg: "#eff6ff", title: "#1d4ed8" },
      tip:     { border: "#10b981", bg: "#ecfdf5", title: "#047857" },
      warning: { border: "#f59e0b", bg: "#fffbeb", title: "#b45309" },
      danger:  { border: "#ef4444", bg: "#fef2f2", title: "#b91c1c" },
    };
    const t = THEME[type] || { border: "#94a3b8", bg: "#f8fafc", title: "#475569" };
    const boxStyle = `border-left:4px solid ${t.border};background:${t.bg};padding:0.6em 0.9em;margin:0.8em 0;border-radius:0 6px 6px 0;display:block;`;
    const titleStyle = `font-weight:600;margin:0 0 0.3em;color:${t.title};text-transform:capitalize;display:block;`;

    const token = state.push("html_block", "", 0);
    token.content =
      `<div class="admonition ${md.utils.escapeHtml(type)}" style="${boxStyle}" data-src-start="${startLine}" data-src-end="${nextLine}">\n` +
      `<p class="admonition-title" style="${titleStyle}">${md.utils.escapeHtml(title)}</p>\n` +
      bodyHtml +
      `</div>\n`;
    token.map = [startLine, nextLine];

    state.line = nextLine;
    return true;
  }
  md.block.ruler.before("paragraph", "admonition", rule, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
}

// Lazily-initialized markdown-it instance with our plugins + syntax highlighting.
let _md = null;
function md() {
  if (_md) return _md;
  const m = window.markdownit({
    html: false,
    linkify: true,
    breaks: false,
    typographer: true,
    highlight: (str, lang) => {
      if (lang === "mermaid") {
        // Leave mermaid blocks for post-processor; mark them so we can find them.
        return `<pre class="mermaid-source" data-mermaid="1">${m.utils.escapeHtml(str)}</pre>`;
      }
      if (lang && window.hljs && window.hljs.getLanguage(lang)) {
        try {
          return `<pre><code class="hljs language-${lang}">${window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
        } catch {}
      }
      return `<pre><code class="hljs">${m.utils.escapeHtml(str)}</code></pre>`;
    },
  });
  if (window.markdownitFootnote) m.use(window.markdownitFootnote);
  if (window.markdownitTaskLists) m.use(window.markdownitTaskLists, { enabled: true, label: true });
  if (window.markdownItAnchor) m.use(window.markdownItAnchor.default || window.markdownItAnchor, { level: 2, slugify: (s) => s.toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]/g, "") });
  m.use(admonitionPlugin); // our own — no external dep

  // Tag every rendered block with its source line range (from the token's
  // `.map`). The editor preview uses these to mirror a rendered-text selection
  // back onto the matching markdown in the textarea. `map` is [startLine,
  // endLine) with endLine exclusive; lines are 0-based. Harmless everywhere
  // else — the attributes are just ignored.
  m.core.ruler.push("src_line_map", (state) => {
    for (const tok of state.tokens) {
      // Open tags (nesting 1) and standalone block tokens (fence, hr, code)
      // carry a map; skip closes (-1), inline children, and html_block (its
      // attrs aren't rendered — the admonition plugin injects its own instead).
      if (tok.map && tok.nesting !== -1 && tok.type !== "inline" && tok.type !== "html_block") {
        tok.attrSet("data-src-start", String(tok.map[0]));
        tok.attrSet("data-src-end", String(tok.map[1]));
      }
    }
  });

  _md = m;
  return m;
}

// Initialize Mermaid once.
if (window.mermaid) {
  try { window.mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose" }); } catch {}
}

function renderMarkdown(text) {
  // Used in read-only contexts (history preview). For the editor preview,
  // call renderMarkdownInto on the live element to get clickable refs.
  const div = document.createElement("div");
  renderMarkdownInto(div, text);
  return div.innerHTML;
}

// ---------- edit mode: mirror a rendered-text selection onto the source ----
// When you select text in the rendered preview, we map the touched blocks back
// to their markdown source lines (via the data-src-start/-end attributes the
// `src_line_map` rule stamps on every block) and mirror that range as the
// textarea's selection — so the same passage can be copied either as rendered
// text (from the preview) or as raw markdown (from the editor). Mapping is
// block-granular: selecting part of a paragraph selects that whole paragraph's
// source, which is predictable and robust against markdown/rendered mismatch.

// Char offset where each 0-based line starts; offs[k] = start of line k.
function lineStartOffsets(text) {
  const offs = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") offs.push(i + 1);
  return offs;
}

// Nearest ancestor (self included, up to but excluding `root`) that carries a
// source-line range.
function nearestMappedBlock(node, root) {
  let e = node && node.nodeType === 1 ? node : node && node.parentElement;
  while (e && e !== root) {
    if (e.hasAttribute && e.hasAttribute("data-src-start")) return e;
    e = e.parentElement;
  }
  return null;
}

function mirrorPreviewSelectionToEditor(preview, ta) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  // Only act on selections that live inside this preview.
  if (!preview.contains(range.commonAncestorContainer)) return;

  const startBlock = nearestMappedBlock(range.startContainer, preview);
  const endBlock = nearestMappedBlock(range.endContainer, preview);
  if (!startBlock || !endBlock) return;

  const startLine = Number(startBlock.getAttribute("data-src-start"));
  const endLineExcl = Number(endBlock.getAttribute("data-src-end"));
  if (!Number.isFinite(startLine) || !Number.isFinite(endLineExcl)) return;

  const text = ta.value;
  const offs = lineStartOffsets(text);
  const startCh = offs[Math.max(0, Math.min(startLine, offs.length - 1))];
  let endCh = endLineExcl < offs.length ? offs[endLineExcl] : text.length;
  // `data-src-end` is the line AFTER the block, so endCh points at the start of
  // the next block; trim one trailing newline so we stop at the block's end.
  if (endCh > startCh && text[endCh - 1] === "\n") endCh--;
  if (endCh <= startCh) return;

  try { ta.setSelectionRange(startCh, endCh); } catch { return; }
  // Reveal the mirrored range in the (possibly scrolled) editor without stealing
  // focus, so the rendered selection stays intact and copyable too.
  const cs = getComputedStyle(ta);
  const lineH = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.4) || 18;
  const padTop = parseFloat(cs.paddingTop) || 0;
  const target = padTop + startLine * lineH - ta.clientHeight / 3;
  ta.scrollTop = Math.max(0, target);

  // Offer an explicit choice of which form to copy. An unfocused textarea
  // doesn't paint its selection and a click would reset it, so a small popover
  // is the reliable way to grab the markdown source without losing it.
  showCopyPopover(range.getBoundingClientRect(), sel.toString(), text.slice(startCh, endCh));
}

// Copy `s` to the clipboard, falling back to execCommand for WKWebView / older
// engines where the async Clipboard API is unavailable.
async function copyText(s) {
  try { await navigator.clipboard.writeText(s); return true; } catch {}
  try {
    const t = document.createElement("textarea");
    t.value = s;
    t.style.cssText = "position:fixed;top:-1000px;opacity:0;";
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand("copy");
    t.remove();
    return ok;
  } catch { return false; }
}

let _copyPopover = null;
function hideCopyPopover() { if (_copyPopover) { _copyPopover.remove(); _copyPopover = null; } }

// Floating "copy as…" toolbar shown at a preview selection. `rendered` and
// `markdown` are captured now, so the buttons still copy the right thing even
// after the selection is cleared by the click.
function showCopyPopover(rect, rendered, markdown) {
  hideCopyPopover();
  if (!rendered) return;
  const mkBtn = (label, title, payload) =>
    el("button", {
      type: "button", title,
      onclick: async (e) => {
        e.preventDefault(); e.stopPropagation();
        const ok = await copyText(payload);
        toast(ok ? `Copied ${label}` : "Copy failed");
        hideCopyPopover();
        const s = window.getSelection(); if (s) s.removeAllRanges();
      },
    }, label === "text" ? "⧉ Text" : "⧉ Markdown");

  const pop = el("div", { class: "copy-popover" },
    mkBtn("text", "Copy the rendered text", rendered),
    mkBtn("markdown", "Copy the markdown source", markdown),
  );
  // Keep the selection alive when a button is pressed (prevents the mousedown
  // from moving focus / collapsing the selection before the click lands).
  pop.addEventListener("mousedown", (e) => e.preventDefault());
  document.body.appendChild(pop);

  const w = pop.offsetWidth, h = pop.offsetHeight;
  let top = rect.bottom + 6;
  if (top + h > window.innerHeight - 6) top = Math.max(6, rect.top - h - 6);
  let left = Math.max(6, Math.min(rect.left, window.innerWidth - w - 6));
  pop.style.top = top + "px";
  pop.style.left = left + "px";
  _copyPopover = pop;
}

// Dismiss the copy popover when the selection is gone or the view moves.
document.addEventListener("selectionchange", () => {
  const s = window.getSelection();
  if (!s || s.isCollapsed) hideCopyPopover();
});
document.addEventListener("scroll", hideCopyPopover, true);
window.addEventListener("resize", hideCopyPopover);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideCopyPopover(); });

// ---------- reading-view: table of contents + heading numbering ----------

// Walk the headings of a rendered article, give each a stable id (markdown-it-
// anchor only tags h2+), compute hierarchical "1.2.3" numbers, and — when
// `number` is on — inject the number as a prefix span. Idempotent: re-running
// strips any previously injected spans first. Returns the heading model
// [{id, level, text, number}] in document order, for building the TOC.
function collectHeadings(article, { number }) {
  const hs = Array.from(article.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  if (!hs.length) return [];

  // Normalise so the shallowest heading present counts as depth 0 — a note that
  // starts at ## still numbers 1, 1.1, … instead of being padded from h1.
  const minLevel = Math.min(...hs.map((h) => Number(h.tagName[1])));

  const counters = [];
  const usedIds = new Set();
  const out = [];

  for (const h of hs) {
    // Strip a prior injected number so re-decoration doesn't stack them.
    const old = h.querySelector(":scope > .md-h-num");
    if (old) {
      // also drop the trailing space node we inserted after it
      if (old.nextSibling && old.nextSibling.nodeType === 3) old.nextSibling.remove();
      old.remove();
    }

    const level = Number(h.tagName[1]);
    const depth = level - minLevel; // 0-based
    const text = h.textContent.trim();

    // Ensure an id for anchor navigation (slug matching markdownItAnchor).
    if (!h.id) {
      const base = text.toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]/g, "") || "section";
      let id = base, i = 2;
      while (usedIds.has(id)) id = `${base}-${i++}`;
      h.id = id;
    }
    usedIds.add(h.id);

    // Hierarchical counter: bump this depth, clear anything deeper, and default
    // any skipped intermediate level to 1 so a h2→h4 jump reads "1.1.1".
    counters.length = depth + 1;
    for (let d = 0; d < depth; d++) if (counters[d] == null) counters[d] = 1;
    counters[depth] = (counters[depth] || 0) + 1;
    const num = counters.join(".");

    if (number) {
      const space = document.createTextNode(" ");
      h.insertBefore(space, h.firstChild);
      h.insertBefore(el("span", { class: "md-h-num" }, num), space);
    }

    out.push({ id: h.id, level, text, number: num });
  }
  return out;
}

// Build the sticky TOC nav from a heading model. Clicks scroll the matching
// heading into view within `article`'s scroll container.
function buildTocNav(headings) {
  const nav = el("nav", { class: "md-toc" });
  nav.append(el("div", { class: "md-toc-title" }, "Contents"));
  if (!headings.length) {
    nav.append(el("div", { class: "md-toc-empty" }, "No headings"));
    return nav;
  }
  const minLevel = Math.min(...headings.map((h) => h.level));
  for (const h of headings) {
    const a = el("a", {
      href: "#" + h.id,
      "data-lvl": String(Math.min(h.level - minLevel + 1, 6)),
      "data-toc-id": h.id,
      onclick: (e) => {
        e.preventDefault();
        const target = document.getElementById(h.id);
        if (target) scrollHeadingIntoView(target);
      },
    });
    if (state.numberHeadings) a.append(el("span", { class: "md-toc-num" }, h.number));
    a.append(document.createTextNode(h.text));
    nav.append(a);
  }
  return nav;
}

// Nearest scrollable ancestor of `el` (the element that actually scrolls), or
// null if none — used to scroll a heading to the top on TOC clicks.
function getScrollParent(el) {
  let p = el.parentElement;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
    p = p.parentElement;
  }
  return null;
}

// Animate `el.scrollTop` to `to` ourselves. We do NOT use scrollIntoView({
// behavior:"smooth" }) or scrollTo({behavior:"smooth"}): smooth programmatic
// scrolling of a nested scroll container is unreliable in WebKit (Safari /
// WKWebView / WebKit2GTK), which is why TOC clicks appeared to do nothing.
// Assigning scrollTop works everywhere, so we tween it by hand — and guarantee
// the landing with a timer fallback in case rAF is throttled (e.g. hidden tab).
function smoothScrollTop(el, to, duration = 300) {
  const start = el.scrollTop;
  const diff = to - start;
  if (Math.abs(diff) < 2 || duration <= 0) { el.scrollTop = to; return; }
  const t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic
  let done = false;
  (function step(now) {
    if (done) return;
    const p = Math.min(1, (now - t0) / duration);
    el.scrollTop = start + diff * ease(p);
    if (p < 1) requestAnimationFrame(step);
    else done = true;
  })(t0);
  // rAF doesn't fire in a hidden/background tab; ensure we still land there.
  setTimeout(() => { if (!done) { el.scrollTop = to; done = true; } }, duration + 80);
}

// Scroll `target` into view within its scroll container, animating scrollTop
// ourselves (see smoothScrollTop). `block` is "start" (align to top, with a
// small gap) or "center". Used by both the TOC and the find-in-note bar, which
// otherwise hit the same WebKit smooth-scrollIntoView no-op.
function scrollElementIntoView(target, { block = "start" } = {}) {
  const scroller = getScrollParent(target);
  if (!scroller) { target.scrollIntoView(); return; }
  const rel = target.getBoundingClientRect().top
    - scroller.getBoundingClientRect().top + scroller.scrollTop;
  const to = block === "center"
    ? rel - (scroller.clientHeight / 2) + (target.getBoundingClientRect().height / 2)
    : rel - 8;
  smoothScrollTop(scroller, Math.max(0, to));
}

// Scroll a heading to the top of its scroll container (with a small gap).
function scrollHeadingIntoView(target) {
  scrollElementIntoView(target, { block: "start" });
}

// Highlight the TOC entry for the heading currently nearest the top of the
// scroll container. Returns the IntersectionObserver so callers can disconnect.
function attachTocScrollSpy(scrollRoot, article, nav) {
  const links = new Map();
  nav.querySelectorAll("a[data-toc-id]").forEach((a) => links.set(a.dataset.tocId, a));
  if (!links.size) return null;

  const visible = new Set();
  const setActive = () => {
    let best = null, bestTop = Infinity;
    for (const id of visible) {
      const h = document.getElementById(id);
      if (!h) continue;
      const top = h.getBoundingClientRect().top;
      if (top < bestTop) { bestTop = top; best = id; }
    }
    if (!best) return;
    links.forEach((a, id) => a.classList.toggle("active", id === best));
    const active = links.get(best);
    if (active) active.scrollIntoView({ block: "nearest" });
  };

  const obs = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) visible.add(en.target.id);
      else visible.delete(en.target.id);
    }
    setActive();
  }, { root: scrollRoot, rootMargin: "0px 0px -70% 0px", threshold: 0 });

  article.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => obs.observe(h));
  return obs;
}

// Wire a draggable divider that resizes the pane to its LEFT (used for the TOC
// rail and the edit-mode preview). Unlike makeResizable() this is called on
// every repaint, so it attaches only a mousedown handler to the (fresh)
// splitter element and adds document-level move/up listeners just for the
// duration of a drag — nothing accumulates across repaints. Width persists per
// `key`. Double-click resets: to `def`px when `def` is a number, or (when `def`
// is null) clears the inline width so the CSS default applies.
function wirePaneSplitter(pane, splitter, { key, def, min, max }) {
  let startX = 0, startW = 0;
  const onMove = (e) => {
    const w = Math.max(min, Math.min(max, startW + (e.clientX - startX)));
    pane.style.width = w + "px";
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try { localStorage.setItem(key, String(parseInt(pane.style.width, 10))); } catch {}
  };
  splitter.addEventListener("mousedown", (e) => {
    startX = e.clientX;
    startW = pane.getBoundingClientRect().width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  });
  splitter.addEventListener("dblclick", () => {
    if (def == null) pane.style.removeProperty("width");
    else pane.style.width = def + "px";
    try { localStorage.removeItem(key); } catch {}
  });
}

let _mermaidCounter = 0;
async function processMermaidBlocks(container) {
  if (!window.mermaid) return;
  const blocks = container.querySelectorAll("pre.mermaid-source");
  for (const block of blocks) {
    const source = block.textContent;
    const id = `mermaid-svg-${++_mermaidCounter}`;
    try {
      const { svg } = await window.mermaid.render(id, source);
      const wrap = document.createElement("div");
      wrap.className = "mermaid-block";
      wrap.innerHTML = svg;
      block.replaceWith(wrap);
    } catch (e) {
      const wrap = document.createElement("div");
      wrap.className = "mermaid-block mermaid-error";
      wrap.textContent = "Mermaid error: " + (e?.message || e);
      block.replaceWith(wrap);
    }
  }
}

// Order matters: drawing token first so it doesn't get partially eaten by the [[Title]] rule.
const REF_PATTERN = /!\[\[drawing:(\d+)\]\]|(?<!\w)#(\d+)\b|\[\[([^\[\]\n]+?)\]\]/g;

function renderMarkdownInto(container, text) {
  container.innerHTML = md().render(text || "");
  // Render any ```mermaid blocks (async, but we don't block — they'll appear shortly).
  processMermaidBlocks(container);
  // Walk text nodes outside of <code>/<pre>/<a> and replace #N or [[Title]] with real anchors.
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      let p = node.parentElement;
      while (p && p !== container) {
        const t = p.tagName;
        if (t === "CODE" || t === "PRE" || t === "A") return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);

  for (const tn of nodes) {
    const raw = tn.nodeValue;
    REF_PATTERN.lastIndex = 0;
    if (!REF_PATTERN.test(raw)) continue;
    REF_PATTERN.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = REF_PATTERN.exec(raw)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(raw.slice(last, m.index)));
      if (m[1]) {
        // ![[drawing:N]] — inline drawing (SVG fetched and injected, so markers/styles render correctly)
        const attId = Number(m[1]);
        const box = document.createElement("div");
        box.className = "drawing-box my-3 border border-slate-200 rounded bg-white p-2 inline-block max-w-full cursor-pointer";
        box.title = "Click to edit drawing";
        box.dataset.editDrawing = String(attId);
        box.innerHTML = '<div class="text-xs text-slate-400 p-2">Loading drawing…</div>';
        loadInlineDrawing(box, attId);
        frag.appendChild(box);
      } else if (m[2]) {
        const id = Number(m[2]);
        const title = _titleCache.get(id);
        const a = document.createElement("a");
        a.href = "#";
        a.dataset.ref = String(id);
        a.className = "text-blue-700 underline";
        a.textContent = "#" + id;
        if (title) {
          a.title = title;
          const span = document.createElement("span");
          span.className = "text-slate-500 ml-1 no-underline";
          span.textContent = title;
          a.appendChild(document.createTextNode(" "));
          a.appendChild(span);
        }
        frag.appendChild(a);
      } else if (m[3]) {
        const title = m[3];
        const a = document.createElement("a");
        a.href = "#";
        a.dataset.refTitle = title;
        a.className = "text-blue-700 underline";
        a.textContent = "[[" + title + "]]";
        frag.appendChild(a);
      }
      last = m.index + m[0].length;
    }
    if (last < raw.length) frag.appendChild(document.createTextNode(raw.slice(last)));
    tn.parentNode.replaceChild(frag, tn);
  }
}

function extractIdRefs(text) {
  const ids = new Set();
  for (const m of (text || "").matchAll(/(?<!\w)#(\d+)\b/g)) ids.add(Number(m[1]));
  return [...ids];
}

async function ensureTitlesFor(ids) {
  const missing = ids.filter((id) => !_titleCache.has(id));
  if (missing.length === 0) return false;
  await Promise.all(missing.map(async (id) => {
    try {
      const item = await api(`/items/${id}`);
      _titleCache.set(id, item.title || `${item.kind} #${id}`);
    } catch {
      _titleCache.set(id, ""); // mark as "looked up, not found"
    }
  }));
  return true;
}

async function resolveTitleRef(title) {
  try {
    const items = await api(`/search?q=${encodeURIComponent(title)}&limit=10`);
    const lc = title.toLowerCase();
    return items.find((i) => (i.title || "").toLowerCase() === lc) || items[0] || null;
  } catch {
    return null;
  }
}

function renderActions(it) {
  const wrap = el("div", { class: "px-6 py-3 border-t border-slate-200 flex items-center gap-3 bg-slate-50" });

  // autosave status
  wrap.append(el("span", {
    class: "text-xs text-slate-400",
    "data-autosave-status": "1",
    "data-item-id": String(it.id),
    "data-status": _autosaveStatus.get(it.id) || "",
  }, autosaveLabel(it.id) || "Up to date"));

  // History moved to the top header (see renderHeaderItemActions).
  wrap.append(el("div", { class: "ml-auto" }));
  wrap.append(el("button", {
    class: "px-3 py-1.5 text-sm text-red-600 hover:underline",
    onclick: () => deleteItem(it),
  }, "Delete"));
  return wrap;
}

// ---------- history ----------
async function openHistory(it, anchorBtn) {
  let versions = [];
  try {
    versions = await api(`/items/${it.id}/versions`);
  } catch (e) { toast(e.message); return; }

  // Modal-style centered popup
  const overlay = $("#modal-overlay");
  const m = $("#modal");
  m.replaceChildren();
  m.append(el("div", { class: "flex items-center gap-2 mb-3" },
    el("div", { class: "font-semibold" }, `Version history · #${it.id}`),
    el("button", { class: "ml-auto text-slate-400 hover:text-slate-800", onclick: () => overlay.classList.add("hidden") }, "✕"),
  ));

  if (versions.length === 0) {
    m.append(el("div", { class: "text-sm text-slate-500 italic" }, "No saved versions yet."));
  } else {
    const list = el("div", { class: "space-y-1 max-h-[60vh] overflow-y-auto" });
    for (let i = 0; i < versions.length; i++) {
      const v = versions[i];
      list.append(el("button", {
        class: "w-full text-left px-3 py-2 border border-slate-200 rounded hover:border-slate-400 hover:bg-slate-50",
        onclick: () => previewVersion(it, v, i === 0),
      },
        el("div", { class: "flex items-center gap-2 text-xs text-slate-500" },
          el("span", {}, fmtSessionTime(v.saved_at)),
          i === 0 ? el("span", { class: "chip" }, "current") : null,
        ),
        el("div", { class: "text-sm text-slate-800 truncate mt-0.5" }, v.title || "(untitled)"),
        v.body ? el("div", { class: "text-xs text-slate-500 truncate mt-0.5" }, v.body.split("\n")[0].slice(0, 120)) : null,
      ));
    }
    m.append(list);
  }
  overlay.classList.remove("hidden");
}

function previewVersion(it, v, isCurrent) {
  const overlay = $("#modal-overlay");
  const m = $("#modal");
  m.replaceChildren(
    el("div", { class: "flex items-center gap-2 mb-3" },
      el("button", { class: "text-xs text-slate-500 hover:underline", onclick: () => openHistory(it) }, "← All versions"),
      el("div", { class: "ml-auto text-xs text-slate-500" }, fmtSessionTime(v.saved_at)),
      el("button", { class: "ml-2 text-slate-400 hover:text-slate-800", onclick: () => overlay.classList.add("hidden") }, "✕"),
    ),
    el("div", { class: "text-sm font-semibold text-slate-900 mb-2" }, v.title || "(untitled)"),
    (() => { const d = el("div", { class: "prose-body bg-slate-50 border border-slate-200 rounded p-3 max-h-[55vh] overflow-y-auto" }); renderMarkdownInto(d, v.body || ""); return d; })(),
    el("div", { class: "mt-3 flex gap-2" },
      isCurrent
        ? el("div", { class: "text-xs text-slate-500 italic" }, "This is the current version.")
        : el("button", {
            class: "px-3 py-1.5 text-sm bg-slate-900 text-white rounded hover:bg-slate-700",
            onclick: async () => {
              try {
                const path = it.kind === "task" ? `/tasks/${it.id}` :
                              it.kind === "note" ? `/notes/${it.id}` : `/links/${it.id}`;
                const payload = it.kind === "link"
                  ? { title: v.title, annotation: v.body }
                  : { title: v.title, body: v.body };
                const updated = await api(path, { method: "PATCH", body: JSON.stringify(payload) });
                state.selected = updated;
                const idx = state.items.findIndex((x) => x.id === it.id);
                if (idx >= 0) state.items[idx] = updated;
                overlay.classList.add("hidden");
                delete state.drafts[it.id];
                renderList();
                renderDetail();
                toast("Restored");
              } catch (e) { toast(e.message); }
            },
          }, "Restore this version"),
      el("button", { class: "px-3 py-1.5 text-sm text-slate-600 hover:underline", onclick: () => overlay.classList.add("hidden") }, "Close"),
    ),
  );
  overlay.classList.remove("hidden");
}

function renderRefs(it) {
  const out = it.refs_out || it.refsOut || [];
  const back = it.backlinks || [];
  if (out.length === 0 && back.length === 0) return el("div", {});
  const refList = (ids) => el("div", { class: "flex flex-wrap gap-1.5" },
    ...ids.map((id) => el("button", {
      class: "chip cursor-pointer hover:bg-slate-200",
      onclick: () => selectItem(id),
    }, "#" + id))
  );
  return el("div", { class: "px-6 py-4 border-t border-slate-200" },
    out.length ? el("div", { class: "mb-3" },
      el("div", { class: "text-xs uppercase tracking-wider text-slate-500 mb-1" }, "References"),
      refList(out)) : null,
    back.length ? el("div", {},
      el("div", { class: "text-xs uppercase tracking-wider text-slate-500 mb-1" }, "Backlinks"),
      refList(back)) : null,
  );
}

// ---------- autosave ----------
const _autosaveTimers = new Map();   // itemId -> timeout id
const _autosaveStatus = new Map();   // itemId -> 'modified' | 'saving' | 'saved' | 'error'
const _autosaveLastSaved = new Map();// itemId -> ms

function setAutosaveStatus(id, s) {
  _autosaveStatus.set(id, s);
  if (s === "saved") _autosaveLastSaved.set(id, Date.now());
  const el = document.querySelector(`[data-autosave-status][data-item-id="${id}"]`);
  if (el) {
    el.textContent = autosaveLabel(id);
    el.dataset.status = s;
    el.classList.remove("text-slate-400", "text-blue-600", "text-emerald-600", "text-red-600");
    el.classList.add({
      modified: "text-slate-400",
      saving: "text-blue-600",
      saved: "text-emerald-600",
      error: "text-red-600",
    }[s] || "text-slate-400");
  }
}
function autosaveLabel(id) {
  const s = _autosaveStatus.get(id);
  if (s === "saving") return "Saving…";
  if (s === "modified") return "Modified";
  if (s === "error") return "Save failed";
  if (s === "saved") {
    const ago = Math.floor((Date.now() - (_autosaveLastSaved.get(id) || 0)) / 1000);
    if (ago < 5) return "Saved just now";
    if (ago < 60) return `Saved ${ago}s ago`;
    if (ago < 3600) return `Saved ${Math.floor(ago / 60)}m ago`;
    return "Saved";
  }
  return "";
}

// quiet draft set (text inputs) — no re-render, debounced save
function setDraftQuiet(id, key, val) {
  const d = state.drafts[id] || {};
  d[key] = val;
  state.drafts[id] = d;
  setAutosaveStatus(id, "modified");
  clearTimeout(_autosaveTimers.get(id));
  _autosaveTimers.set(id, setTimeout(() => doAutoSave(id), 700));
}

// loud draft set (selects/checkboxes) — saves immediately and re-renders
function setDraftLoud(id, key, val) {
  const d = state.drafts[id] || {};
  d[key] = val;
  state.drafts[id] = d;
  clearTimeout(_autosaveTimers.get(id));
  doAutoSave(id, /*rerender=*/true);
}

async function doAutoSave(id, rerender = false) {
  const draft = state.drafts[id];
  if (!draft || Object.keys(draft).length === 0) return;
  const it = state.selected;
  if (!it || it.id !== id) return; // detail switched away

  let path;
  const payload = { ...draft };
  if (it.kind === "task") path = `/tasks/${id}`;
  else if (it.kind === "note") path = `/notes/${id}`;
  else { path = `/links/${id}`; if ("body" in payload) { payload.annotation = payload.body; delete payload.body; } }

  setAutosaveStatus(id, "saving");
  try {
    const updated = await api(path, { method: "PATCH", body: JSON.stringify(payload) });
    delete state.drafts[id];
    if (state.selected?.id === id) state.selected = updated;
    const idx = state.items.findIndex((x) => x.id === id);
    if (idx >= 0) state.items[idx] = updated;
    setAutosaveStatus(id, "saved");
    if (rerender) renderDetail();
    else renderList(); // refresh chips/labels in list
  } catch (e) {
    setAutosaveStatus(id, "error");
    toast("Save failed: " + e.message);
  }
}

// Periodically refresh the "Saved Xs ago" label
setInterval(() => {
  const el = document.querySelector("[data-autosave-status]");
  if (el && el.dataset.status === "saved") {
    el.textContent = autosaveLabel(Number(el.dataset.itemId));
  }
}, 5000);

async function quickStatus(it, status) {
  try {
    const url = status === "doing" ? `/tasks/${it.id}/doing` : (status === "done" ? `/tasks/${it.id}/done` : null);
    const updated = url ? await api(url, { method: "POST" }) : await api(`/tasks/${it.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
    state.selected = updated;
    await reloadList();
    renderDetail();
  } catch (e) { toast(e.message); }
}

async function deleteItem(it) {
  if (!confirm(`Delete ${it.kind} #${it.id}?`)) return;
  try {
    await api(`/items/${it.id}`, { method: "DELETE" });
    state.selected = null;
    state.selectedId = null;
    state.items = state.items.filter((x) => x.id !== it.id);
    renderList();
    renderDetail();
    toast("Deleted");
  } catch (e) { toast(e.message); }
}

function clearSel() {
  state.selected = null; state.selectedId = null;
  // Focus mode is only "on" while an item is being viewed; clear the body
  // attribute so the sidebar reappears as soon as the user navigates away.
  if (typeof _applyFocusBodyAttr === "function") _applyFocusBodyAttr();
  if (typeof renderHeaderItemActions === "function") renderHeaderItemActions();
}

// (Header search and global "+ New" buttons removed — search lives inside Home, "+ New" lives in the sidebar.)

function openNewItemModal(opts = {}) {
  const TABS = ["task", "note", "link"];
  let tab = TABS.includes(opts.tab) ? opts.tab : "task";
  // Optional YYYY-MM-DD to pre-fill the date/due field (e.g. from the calendar).
  const presetDate = opts.dueDate || "";
  let projectId = state.scopeProjectId ?? state.currentProjectId ?? state.projects[0]?.id ?? null;

  const overlay = $("#modal-overlay");
  const m = $("#modal");

  // Shared post-create step: close, refresh the list, run any caller hook
  // (the calendar uses it to re-render the month), and toast.
  const afterCreate = () => {
    overlay.classList.add("hidden");
    reloadList();
    if (typeof opts.onCreated === "function") opts.onCreated();
    toast("Created");
  };

  // Tab / Shift+Tab cycles Task → Note → Link, but only when focus is NOT
  // inside an input/textarea/select (so form-field Tab navigation still works).
  const onKeyDown = (e) => {
    if (overlay.classList.contains("hidden")) return;
    if (e.key !== "Tab" || e.metaKey || e.ctrlKey || e.altKey) return;
    const a = document.activeElement;
    const isField = a && ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName);
    if (isField) return; // keep native field tabbing
    e.preventDefault();
    const i = TABS.indexOf(tab);
    tab = TABS[e.shiftKey ? (i - 1 + TABS.length) % TABS.length : (i + 1) % TABS.length];
    render();
  };
  document.addEventListener("keydown", onKeyDown);
  // Tear down the listener when the overlay is hidden by anything.
  const cleanup = new MutationObserver(() => {
    if (overlay.classList.contains("hidden")) {
      document.removeEventListener("keydown", onKeyDown);
      cleanup.disconnect();
    }
  });
  cleanup.observe(overlay, { attributes: true, attributeFilter: ["class"] });

  const render = () => {
    m.replaceChildren();
    m.append(el("div", { class: "flex items-center gap-2 mb-3" },
      ...TABS.map((t) => el("button", {
        class: "tab-btn " + (tab === t ? "active" : ""),
        title: `Switch tab — Tab / Shift+Tab cycle`,
        onclick: () => { tab = t; render(); },
      }, t)),
      el("button", {
        class: "ml-auto text-slate-400 hover:text-slate-800",
        onclick: () => overlay.classList.add("hidden"),
      }, "✕")
    ));

    m.append(label("Project",
      el("select", {
        class: "border border-slate-300 rounded px-2 py-1 text-sm",
        onchange: (e) => { projectId = Number(e.target.value); },
      }, ...state.projects.map((p) => el("option", { value: p.id, selected: p.id === projectId }, p.name)))
    ));

    if (tab === "task") renderTaskForm();
    else if (tab === "note") renderNoteForm();
    else renderLinkForm();
  };

  const renderTaskForm = () => {
    const title = el("input", { type: "text", class: "mt-2 w-full border border-slate-300 rounded px-2 py-1.5 text-sm", placeholder: "Title" });
    const status = el("select", { class: "border border-slate-300 rounded px-2 py-1 text-sm" },
      ...TASK_STATUSES.slice(0, 5).map((s) => el("option", { value: s, selected: s === "todo" }, s)));
    const priority = el("select", { class: "border border-slate-300 rounded px-2 py-1 text-sm" },
      ...["low", "normal", "high"].map((p) => el("option", { value: p, selected: p === "normal" }, p)));
    const due = el("input", { type: "date", value: presetDate, class: "border border-slate-300 rounded px-2 py-1 text-sm" });
    const estimate = el("input", { type: "number", min: "0", step: "0.25", placeholder: "—", title: "Estimated hours", class: "border border-slate-300 rounded px-2 py-1 text-sm w-20" });
    const body = el("textarea", { class: "mt-2 w-full font-mono text-sm border border-slate-300 rounded p-2 min-h-[100px]", placeholder: "Body…" });
    m.append(
      title,
      el("div", { class: "mt-2 flex flex-wrap gap-3" }, label("Status", status), label("Priority", priority), label("Due", due), label("Estimate (h)", estimate)),
      body,
      el("div", { class: "mt-3 flex justify-end gap-2" },
        el("button", { class: "px-3 py-1.5 text-sm text-slate-600 hover:underline", onclick: () => overlay.classList.add("hidden") }, "Cancel"),
        el("button", { class: "px-3 py-1.5 text-sm bg-slate-900 text-white rounded hover:bg-slate-700", onclick: async () => {
          try {
            const payload = {
              project_id: projectId, title: title.value, status: status.value, priority: priority.value,
              body: body.value || null, due_at: dateInputToIso(due.value), estimate_minutes: estimateInputToMinutes(estimate.value),
            };
            await api("/tasks", { method: "POST", body: JSON.stringify(payload) });
            afterCreate();
          } catch (e) { toast(e.message); }
        } }, "Create"))
    );
    setTimeout(() => title.focus(), 0);
  };

  const renderNoteForm = () => {
    const t = el("input", { type: "text", class: "mt-2 w-full border border-slate-300 rounded px-2 py-1.5 text-sm", placeholder: "Title (optional)" });
    const date = el("input", { type: "date", value: presetDate, class: "border border-slate-300 rounded px-2 py-1 text-sm" });
    const body = el("textarea", { class: "mt-2 w-full font-mono text-sm border border-slate-300 rounded p-2 min-h-[200px]", placeholder: "Body (markdown)…" });
    m.append(t,
      el("div", { class: "mt-2" }, label("Date", date)),
      body,
      el("div", { class: "mt-3 flex justify-end gap-2" },
        el("button", { class: "px-3 py-1.5 text-sm text-slate-600 hover:underline", onclick: () => overlay.classList.add("hidden") }, "Cancel"),
        el("button", { class: "px-3 py-1.5 text-sm bg-slate-900 text-white rounded hover:bg-slate-700", onclick: async () => {
          try {
            await api("/notes", { method: "POST", body: JSON.stringify({ project_id: projectId, title: t.value || null, body: body.value, due_at: dateInputToIso(date.value) }) });
            afterCreate();
          } catch (e) { toast(e.message); }
        } }, "Create"))
    );
    setTimeout(() => body.focus(), 0);
  };

  const renderLinkForm = () => {
    const u = el("input", { type: "url", class: "mt-2 w-full border border-slate-300 rounded px-2 py-1.5 text-sm", placeholder: "https://…" });
    const lbl = el("input", { type: "text", class: "mt-2 w-full border border-slate-300 rounded px-2 py-1.5 text-sm", placeholder: "Label (optional — shown instead of title)" });
    const ann = el("textarea", { class: "mt-2 w-full text-sm border border-slate-300 rounded p-2 min-h-[80px]", placeholder: "Annotation (optional)" });
    m.append(u, lbl, ann,
      el("div", { class: "mt-3 flex justify-end gap-2" },
        el("button", { class: "px-3 py-1.5 text-sm text-slate-600 hover:underline", onclick: () => overlay.classList.add("hidden") }, "Cancel"),
        el("button", { class: "px-3 py-1.5 text-sm bg-slate-900 text-white rounded hover:bg-slate-700", onclick: async () => {
          try {
            await api("/links", { method: "POST", body: JSON.stringify({
              project_id: projectId,
              url: u.value,
              display_label: lbl.value.trim() || null,
              annotation: ann.value || null,
            }) });
            afterCreate();
          } catch (e) { toast(e.message); }
        } }, "Create"))
    );
    setTimeout(() => u.focus(), 0);
  };

  render();
  overlay.classList.remove("hidden");
}

function openProjectModal(project) {
  const isEdit = !!project;
  const overlay = $("#modal-overlay");
  const m = $("#modal");
  m.replaceChildren();

  let slug = project?.slug ?? "";
  let name = project?.name ?? "";
  let description = project?.description ?? "";
  let color = project?.color ?? "#64748b";
  let parentId = project?.parent_id ?? null;

  // Disable parent selector when editing a project that has children
  // (otherwise we'd end up 3 levels deep — backend rejects anyway).
  const hasChildren = isEdit && state.projects.some((x) => x.parent_id === project.id);
  // Valid parent candidates: any other root project (and only when this project
  // itself has no children).
  const rootChoices = state.projects.filter(
    (x) => !x.parent_id && (!isEdit || x.id !== project.id)
  );

  const errBox = el("div", { class: "hidden text-sm text-red-600 mt-2" });

  const slugInput = el("input", {
    type: "text", value: slug,
    placeholder: "lowercase-slug",
    class: "w-full border border-slate-300 rounded px-2 py-1.5 text-sm font-mono",
    pattern: "[a-z0-9][a-z0-9-]*",
    ...(isEdit ? { disabled: "disabled" } : {}),
    oninput: (e) => { slug = e.target.value.trim(); },
  });
  const nameInput = el("input", {
    type: "text", value: name, placeholder: "Display name",
    class: "w-full border border-slate-300 rounded px-2 py-1.5 text-sm",
    oninput: (e) => { name = e.target.value; },
  });
  const descInput = el("textarea", {
    placeholder: "Description (optional)",
    class: "w-full border border-slate-300 rounded px-2 py-1.5 text-sm min-h-[60px]",
    oninput: (e) => { description = e.target.value; },
  }, description);
  const colorInput = el("input", {
    type: "color", value: color,
    class: "h-8 w-12 border border-slate-300 rounded cursor-pointer",
    oninput: (e) => { color = e.target.value; },
  });

  const parentSel = el("select", {
    class: "border border-slate-300 rounded px-2 py-1 text-sm w-full",
    ...(hasChildren ? { disabled: "disabled" } : {}),
    onchange: (e) => { parentId = e.target.value === "" ? null : Number(e.target.value); },
  },
    el("option", { value: "", ...(parentId == null ? { selected: "selected" } : {}) }, "— None (root project)"),
    ...rootChoices.map((rp) =>
      el("option", { value: String(rp.id), ...(parentId === rp.id ? { selected: "selected" } : {}) }, rp.name)
    ),
  );

  const save = async () => {
    errBox.classList.add("hidden");
    try {
      if (isEdit) {
        // Backend reads parent_id == 0 as "clear". Use 0 when the user
        // picked None so the column actually gets set to NULL.
        await api(`/projects/${project.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name, description: description || null, color,
            parent_id: parentId == null ? 0 : parentId,
          }),
        });
      } else {
        await api("/projects", {
          method: "POST",
          body: JSON.stringify({
            slug, name, description: description || null, color,
            parent_id: parentId,
          }),
        });
      }
      overlay.classList.add("hidden");
      await refreshAll();
      toast(isEdit ? "Saved" : "Project created");
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
    }
  };

  const setCurrent = async () => {
    try {
      await api(`/projects/${project.id}/current`, { method: "POST" });
      overlay.classList.add("hidden");
      await refreshAll();
      toast("Set as current");
    } catch (e) { errBox.textContent = e.message; errBox.classList.remove("hidden"); }
  };

  const confirmDelete = async () => {
    const typed = prompt(
      `Delete project "${project.name}"? This will also delete ALL its tasks, notes, and links.\n\nType the slug "${project.slug}" to confirm:`
    );
    if (typed !== project.slug) {
      if (typed != null) toast("Slug did not match — not deleted");
      return;
    }
    try {
      await api(`/projects/${project.id}`, { method: "DELETE" });
      // if we were scoped to it, reset
      if (state.scopeProjectId === project.id) state.scopeProjectId = null;
      overlay.classList.add("hidden");
      await refreshAll();
      toast("Project deleted");
    } catch (e) { errBox.textContent = e.message; errBox.classList.remove("hidden"); }
  };

  m.append(
    el("div", { class: "flex items-center gap-2 mb-3" },
      el("div", { class: "font-semibold" }, isEdit ? `Edit project: ${project.slug}` : "New project"),
      el("button", { class: "ml-auto text-slate-400 hover:text-slate-800", onclick: () => overlay.classList.add("hidden") }, "✕"),
    ),
    el("div", { class: "space-y-2" },
      el("div", {},
        el("label", { class: "text-xs uppercase tracking-wider text-slate-500" }, "Slug"),
        slugInput,
        isEdit ? el("div", { class: "text-xs text-slate-400 mt-0.5" }, "Slug cannot be changed.") : null,
      ),
      el("div", {},
        el("label", { class: "text-xs uppercase tracking-wider text-slate-500" }, "Name"),
        nameInput,
      ),
      el("div", {},
        el("label", { class: "text-xs uppercase tracking-wider text-slate-500" }, "Description"),
        descInput,
      ),
      el("div", { class: "flex items-center gap-2" },
        el("label", { class: "text-xs uppercase tracking-wider text-slate-500" }, "Color"),
        colorInput,
      ),
      el("div", {},
        el("label", { class: "text-xs uppercase tracking-wider text-slate-500" }, "Parent project"),
        parentSel,
        hasChildren
          ? el("div", { class: "text-xs text-amber-700 mt-0.5" },
              "This project has children — it cannot itself become a child (2-level limit).")
          : el("div", { class: "text-xs text-slate-400 mt-0.5" },
              "Choose a root project to nest under (max 2 levels)."),
      ),
    ),
    errBox,
    el("div", { class: "mt-4 flex items-center gap-2" },
      isEdit ? el("button", {
        class: "px-3 py-1.5 text-sm text-red-600 hover:underline",
        onclick: confirmDelete,
      }, "Delete") : null,
      el("div", { class: "flex-1" }),
      isEdit && project.id !== state.currentProjectId ? el("button", {
        class: "px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-50",
        onclick: setCurrent,
      }, "Set as current") : null,
      el("button", { class: "px-3 py-1.5 text-sm text-slate-600 hover:underline", onclick: () => overlay.classList.add("hidden") }, "Cancel"),
      el("button", {
        class: "px-3 py-1.5 text-sm bg-slate-900 text-white rounded hover:bg-slate-700",
        onclick: save,
      }, isEdit ? "Save" : "Create"),
    ),
  );

  overlay.classList.remove("hidden");
  setTimeout(() => (isEdit ? nameInput : slugInput).focus(), 0);
}

// Close modal on overlay click
// ---------- data: backup, export & import ----------
const SECTION_LABEL = "text-xs uppercase tracking-wider text-slate-500 mb-1";
const BTN_PLAIN = "px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100";

// Save text to a file. In a browser this is a blob download; inside the native
// (WKWebView) app, WKWebView ignores <a download>, so we hand the bytes to the
// native save-panel bridge instead.
function saveFile(name, text) {
  const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.devlogSave;
  if (bridge) { bridge.postMessage({ name, text }); return; }
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function fmtBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtWhen(iso) {
  if (!iso) return "unknown time";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString();
}

function openDataModal() {
  const overlay = $("#modal-overlay");
  const m = $("#modal");
  m.replaceChildren();
  const close = () => overlay.classList.add("hidden");
  const errBox = el("div", { class: "hidden text-sm text-red-600 mt-2" });
  const showErr = (msg) => { errBox.textContent = msg; errBox.classList.remove("hidden"); };
  const clearErr = () => errBox.classList.add("hidden");

  // ---- Export ----
  const projectBoxes = [];
  const projList = el("div", { class: "max-h-40 overflow-auto border border-slate-200 rounded p-2 space-y-1" });
  for (const p of state.projects) {
    const cb = el("input", { type: "checkbox", checked: true, class: "accent-slate-700" });
    cb.dataset.slug = p.slug;
    projectBoxes.push(cb);
    projList.append(el("label", { class: "flex items-center gap-2 text-sm text-slate-700" },
      cb, el("span", {}, p.name), el("span", { class: "text-slate-400" }, `(${p.slug})`)));
  }
  if (!state.projects.length) projList.append(el("div", { class: "text-sm text-slate-400" }, "No projects yet."));

  const allCb = el("input", { type: "checkbox", checked: true, class: "accent-slate-700" });
  allCb.addEventListener("change", () => projectBoxes.forEach((b) => { b.checked = allCb.checked; }));
  projectBoxes.forEach((b) => b.addEventListener("change", () => {
    allCb.checked = projectBoxes.every((x) => x.checked);
  }));

  const encryptCb = el("input", { type: "checkbox", class: "accent-slate-700" });
  const tokenReveal = el("span", { class: "font-mono text-slate-800 break-all" });
  const showTokenLink = el("button", { class: "text-slate-500 hover:text-slate-800 underline" }, "show token");
  showTokenLink.addEventListener("click", async () => {
    clearErr();
    try {
      const { token } = await api("/export/token");
      tokenReveal.textContent = token;
      showTokenLink.classList.add("hidden");
    } catch (e) { showErr(e.message); }
  });

  const doExport = async () => {
    clearErr();
    const selected = projectBoxes.filter((b) => b.checked).map((b) => b.dataset.slug);
    if (state.projects.length && !selected.length) { showErr("Select at least one project to export."); return; }
    const projects = (selected.length === projectBoxes.length) ? null : selected; // null = all
    try {
      const data = await api("/export", {
        method: "POST",
        body: JSON.stringify({ projects, encrypt: encryptCb.checked }),
      });
      const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      const enc = data.devlog_encrypted ? ".enc" : "";
      saveFile(`devlog-export-${ts}${enc}.json`, JSON.stringify(data, null, 2));
      const what = data.devlog_encrypted ? "encrypted export" :
        (data.partial ? `${data.projects.length} project(s)` : "all projects");
      toast(`Exported ${what}`, 3000);
    } catch (e) { showErr(e.message); }
  };

  // ---- Import ----
  const fileInput = el("input", { type: "file", accept: "application/json,.json", class: "hidden" });
  let parsed = null, encryptedFile = false;
  const tokenInput = el("input", {
    type: "password", placeholder: "Token from the exporting app",
    class: "hidden w-full border border-slate-300 rounded px-2 py-1.5 text-sm mt-2",
  });
  const modeMerge = el("input", { type: "radio", name: "impmode", value: "merge", checked: true, class: "accent-slate-700" });
  const modeReplace = el("input", { type: "radio", name: "impmode", value: "replace_projects", class: "accent-slate-700" });
  const modeRow = el("div", { class: "hidden mt-2 space-y-1 text-sm text-slate-700" },
    el("label", { class: "flex items-center gap-2" }, modeMerge,
      el("span", {}, "Merge — add as new projects (existing data kept)")),
    el("label", { class: "flex items-center gap-2" }, modeReplace,
      el("span", {}, "Replace matching projects — overwrite projects with the same slug")),
  );
  const summary = el("div", { class: "hidden text-sm mt-2 space-y-0.5" });
  const importBtn = el("button", { class: `${BTN_PLAIN} hidden mt-3` }, "Import");

  const countsStr = (tables) => Object.entries(tables)
    .filter(([, v]) => Array.isArray(v) && v.length)
    .map(([k, v]) => `${v.length} ${k}`).join(", ");

  fileInput.addEventListener("change", async () => {
    summary.classList.add("hidden"); modeRow.classList.add("hidden");
    importBtn.classList.add("hidden"); tokenInput.classList.add("hidden");
    clearErr(); parsed = null; encryptedFile = false;
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    let doc;
    try { doc = JSON.parse(await f.text()); }
    catch { showErr("Not a valid JSON file."); return; }

    if (doc && doc.devlog_encrypted) {
      encryptedFile = true;
      parsed = doc;
      summary.replaceChildren(
        el("div", { class: "text-slate-700" }, `File: ${f.name}`),
        el("div", { class: "text-slate-500" }, "Encrypted export — enter the token to import."),
      );
      tokenInput.classList.remove("hidden");
    } else {
      if (doc == null || doc.schema_version !== 1 || typeof doc.tables !== "object") {
        showErr("This does not look like a devlog export (missing schema_version / tables).");
        return;
      }
      parsed = doc;
      const scope = doc.partial ? `Projects: ${(doc.projects || []).join(", ") || "—"}` : "Full backup (all projects)";
      summary.replaceChildren(
        el("div", { class: "text-slate-700" }, `File: ${f.name}`),
        el("div", { class: "text-slate-600" }, scope),
        el("div", { class: "text-slate-500" }, `Contains: ${countsStr(doc.tables)}`),
      );
    }
    summary.classList.remove("hidden");
    modeRow.classList.remove("hidden");
    importBtn.classList.remove("hidden");
  });

  importBtn.addEventListener("click", async () => {
    if (!parsed) return;
    if (encryptedFile && !tokenInput.value) { showErr("Enter the token to decrypt this export."); return; }
    const mode = modeReplace.checked ? "replace_projects" : "merge";
    if (mode === "replace_projects") {
      const typed = prompt(
        "REPLACE matching projects with the file's versions?\n\n" +
        "Projects in this backend that share a slug with the file will be " +
        "deleted and reloaded. Other projects are untouched. A backup is saved first.\n\n" +
        "Type REPLACE to confirm:"
      );
      if (typed !== "REPLACE") { if (typed != null) toast("Not confirmed — nothing changed"); return; }
    }
    clearErr();
    try {
      const res = await api("/import", {
        method: "POST",
        body: JSON.stringify({ mode, data: parsed, token: encryptedFile ? tokenInput.value : null }),
      });
      close();
      await refreshAll();
      const imp = Object.entries(res.imported_counts).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(", ");
      toast(`Imported ${imp || "nothing"}. Backup: ${res.backup_path}`, 6000);
    } catch (e) { showErr(e.message); }
  });

  // ---- Backups ----
  const backupList = el("div", { class: "mt-2 space-y-1 text-sm" });
  const renderBackups = async () => {
    backupList.replaceChildren(el("div", { class: "text-slate-400" }, "Loading…"));
    try {
      const list = await api("/backups");
      if (!list.length) { backupList.replaceChildren(el("div", { class: "text-slate-400" }, "No backups yet.")); return; }
      backupList.replaceChildren(...list.map((b) => el("div", {
        class: "flex items-center gap-2 border border-slate-200 rounded px-2 py-1",
      },
        el("div", { class: "min-w-0" },
          el("div", { class: "text-slate-700" }, fmtWhen(b.created_at)),
          el("div", { class: "text-slate-400 text-xs truncate" }, `${b.tag || "backup"} · ${fmtBytes(b.size)}`)),
        el("button", { class: "ml-auto text-sm text-slate-600 hover:text-slate-900", onclick: () => doRestore(b) }, "Restore"),
        el("button", { class: "text-sm text-red-600 hover:text-red-700", title: "Delete this backup", onclick: () => doDeleteBackup(b) }, "Delete"),
      )));
    } catch (e) { backupList.replaceChildren(el("div", { class: "text-red-600" }, e.message)); }
  };
  const doCreateBackup = async () => {
    clearErr();
    try { await api("/backups", { method: "POST" }); toast("Backup created", 2500); await renderBackups(); }
    catch (e) { showErr(e.message); }
  };
  const doRestore = async (b) => {
    const typed = prompt(
      `RESTORE this backend to the backup from ${fmtWhen(b.created_at)}?\n\n` +
      "This replaces ALL current data with that snapshot. A safety backup of the " +
      "current state is saved first, so you can undo it.\n\n" +
      "Type RESTORE to confirm:"
    );
    if (typed !== "RESTORE") { if (typed != null) toast("Not confirmed — nothing changed"); return; }
    clearErr();
    try {
      const res = await api("/backups/restore", { method: "POST", body: JSON.stringify({ name: b.name, confirm: true }) });
      close();
      await refreshAll();
      toast(`Restored. Safety backup: ${res.safety_backup}`, 6000);
    } catch (e) { showErr(e.message); }
  };
  const doDeleteBackup = async (b) => {
    if (!confirm(`Delete the backup from ${fmtWhen(b.created_at)}? This cannot be undone.`)) return;
    clearErr();
    try { await api(`/backups/${encodeURIComponent(b.name)}`, { method: "DELETE" }); toast("Backup deleted"); await renderBackups(); }
    catch (e) { showErr(e.message); }
  };
  const keepBackupsInput = el("input", { type: "number", min: "0", value: "10",
    class: "w-16 border border-slate-300 rounded px-2 py-1 text-sm" });
  const doPruneBackups = async () => {
    const keep = Math.max(0, parseInt(keepBackupsInput.value, 10) || 0);
    if (!confirm(`Keep the newest ${keep} backup(s) and delete the rest?`)) return;
    clearErr();
    try {
      const res = await api("/backups/prune", { method: "POST", body: JSON.stringify({ keep }) });
      toast(res.deleted.length ? `Deleted ${res.deleted.length} old backup(s)` : "Nothing to delete", 3000);
      await renderBackups();
    } catch (e) { showErr(e.message); }
  };

  // ---- History (version snapshots) ----
  const historyInfo = el("div", { class: "text-sm text-slate-600 mb-2" }, "Loading…");
  const renderHistoryStats = async () => {
    try {
      const s = await api("/versions/stats");
      const v = s.total_versions, i = s.items_with_versions;
      historyInfo.textContent = v === 0
        ? "No saved versions yet."
        : `${v} saved version${v === 1 ? "" : "s"} across ${i} item${i === 1 ? "" : "s"}.`;
    } catch (e) { historyInfo.textContent = e.message; }
  };
  const keepHistoryInput = el("input", { type: "number", min: "0", value: "20",
    class: "w-16 border border-slate-300 rounded px-2 py-1 text-sm" });
  const doCompact = async () => {
    const keep = Math.max(0, parseInt(keepHistoryInput.value, 10) || 0);
    if (!confirm(`Keep only the newest ${keep} version(s) per item and delete older ones?`)) return;
    clearErr();
    try {
      const res = await api("/versions/compact", { method: "POST", body: JSON.stringify({ keep }) });
      toast(res.removed ? `Removed ${res.removed} old version(s)` : "Nothing to compact", 3000);
      await renderHistoryStats();
    } catch (e) { showErr(e.message); }
  };

  m.append(
    el("div", { class: "flex items-center gap-2 mb-3" },
      el("div", { class: "font-semibold" }, "Data — backup, export & import"),
      el("button", { class: "ml-auto text-slate-400 hover:text-slate-800", onclick: close }, "✕"),
    ),
    el("div", { class: "space-y-4" },
      // Export
      el("div", {},
        el("div", { class: SECTION_LABEL }, "Export"),
        el("div", { class: "text-sm text-slate-600 mb-2" }, "Download selected projects as a JSON file."),
        el("label", { class: "flex items-center gap-2 text-sm text-slate-700 font-medium mb-1" },
          allCb, el("span", {}, "All projects")),
        projList,
        el("label", { class: "flex items-center gap-2 text-sm text-slate-700 mt-2" },
          encryptCb, el("span", {}, "Encrypt file with the app token")),
        el("div", { class: "text-xs text-slate-500 mt-1" },
          "You'll need this token to import the file elsewhere. ", showTokenLink, " ", tokenReveal),
        el("button", { class: `${BTN_PLAIN} mt-2`, onclick: doExport }, "⇩ Export"),
      ),
      el("hr", { class: "border-slate-200" }),
      // Import
      el("div", {},
        el("div", { class: SECTION_LABEL }, "Import"),
        el("div", { class: "text-sm text-slate-600 mb-2" }, "Load a devlog export file into this backend."),
        el("button", { class: BTN_PLAIN, onclick: () => fileInput.click() }, "Choose export file…"),
        fileInput, summary, tokenInput, modeRow, importBtn,
      ),
      el("hr", { class: "border-slate-200" }),
      // Backups
      el("div", {},
        el("div", { class: SECTION_LABEL }, "Backups"),
        el("div", { class: "text-sm text-slate-600 mb-2" },
          "Full snapshots of this backend. Restore rolls everything back to a snapshot."),
        el("div", { class: "flex items-center gap-2 flex-wrap" },
          el("button", { class: BTN_PLAIN, onclick: doCreateBackup }, "＋ Create backup now"),
          el("span", { class: "text-sm text-slate-500 ml-1" }, "Keep newest"),
          keepBackupsInput,
          el("button", { class: BTN_PLAIN, onclick: doPruneBackups }, "Clean up old"),
        ),
        backupList,
      ),
      el("hr", { class: "border-slate-200" }),
      // History (version snapshots)
      el("div", {},
        el("div", { class: SECTION_LABEL }, "History"),
        el("div", { class: "text-sm text-slate-600 mb-2" },
          "Every edit snapshots the previous title/body. Compacting keeps the newest few per item and drops the rest — current content is never removed."),
        historyInfo,
        el("div", { class: "flex items-center gap-2 flex-wrap" },
          el("span", { class: "text-sm text-slate-500" }, "Keep newest"),
          keepHistoryInput,
          el("span", { class: "text-sm text-slate-500" }, "per item"),
          el("button", { class: BTN_PLAIN, onclick: doCompact }, "Compact history"),
        ),
      ),
    ),
    errBox,
  );

  renderBackups();
  renderHistoryStats();
  overlay.classList.remove("hidden");
}

$("#data-menu") && $("#data-menu").addEventListener("click", openDataModal);

// ---------- light / dark theme ----------
// The initial theme is applied pre-paint by an inline script in index.html
// (reads localStorage "theme", else the OS preference). Here we just keep the
// header button in sync and flip + persist the choice on click.
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("theme", theme); } catch {}
  const btn = $("#theme-toggle");
  if (btn) btn.textContent = theme === "dark" ? "☀ Light" : "🌙 Dark";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#1e1e1e" : "#0f172a");
}
applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
$("#theme-toggle") && $("#theme-toggle").addEventListener("click", () => {
  applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
});

// ---------- top-header per-item actions (Focus / Share / History) ----------
// These live in the global header next to Data. They act on the currently
// selected item and are hidden when nothing is open.
$("#header-focus")   && $("#header-focus").addEventListener("click",   () => { if (state.selected) toggleFocusMode(); });
$("#header-share")   && $("#header-share").addEventListener("click",   () => { if (state.selected) openShareModal(state.selected); });
$("#header-history") && $("#header-history").addEventListener("click", () => { if (state.selected) openHistory(state.selected, $("#header-history")); });

// Show/hide the header actions for the current selection and keep the Focus
// button's label + active styling in sync with focus mode.
function renderHeaderItemActions() {
  const it = state.selected;
  const focus = $("#header-focus"), share = $("#header-share"), history = $("#header-history");
  const show = !!it;
  for (const b of [focus, share, history]) if (b) b.hidden = !show;
  if (focus) {
    focus.textContent = state.focusMode ? "✏ Edit" : "👁 Focus";
    focus.title = state.focusMode ? "Exit focus mode" : "Focus mode — read-only, hides editor";
    const active = ["bg-amber-100", "border-amber-300", "text-amber-800"];
    const idle = ["text-slate-700", "hover:bg-slate-100"];
    focus.classList.toggle("border-slate-300", !state.focusMode);
    active.forEach((c) => focus.classList.toggle(c, state.focusMode));
    idle.forEach((c) => focus.classList.toggle(c, !state.focusMode));
  }
}

// ---------- read-only share links ----------
function openShareModal(it) {
  const overlay = $("#modal-overlay");
  const m = $("#modal");
  m.replaceChildren();
  const close = () => overlay.classList.add("hidden");
  const errBox = el("div", { class: "hidden text-sm text-red-600 mt-2" });
  const list = el("div", { class: "mt-3 space-y-2" });

  const fmtExp = (iso) => {
    try { return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
    catch { return iso; }
  };

  const copyText = async (text) => {
    try { await navigator.clipboard.writeText(text); toast("Copied"); }
    catch { toast("Copy failed — select the text and copy manually"); }
  };

  const renderShare = (s) => {
    // Primary link is `url` — built from how you're accessing the app, so it
    // works right here. The LAN link only works when the backend serves on the
    // network (serving_lan), so it's shown copyable only then.
    const urlField = el("input", {
      type: "text", value: s.url, readonly: "readonly",
      class: "flex-1 border border-slate-300 rounded px-2 py-1 text-xs font-mono bg-slate-50",
      onclick: (e) => e.target.select(),
    });
    const lanRow = s.serving_lan
      ? el("div", { class: "flex items-center gap-2 text-xs mt-1" },
          el("span", { class: "text-emerald-600 whitespace-nowrap" }, "✓ Other devices"),
          el("input", {
            type: "text", value: s.lan_url, readonly: "readonly",
            class: "flex-1 border border-slate-200 rounded px-2 py-0.5 font-mono bg-slate-50 text-slate-600",
            onclick: (e) => e.target.select(),
          }),
          el("button", { class: "px-2 py-0.5 border border-slate-300 rounded hover:bg-slate-100",
            onclick: () => copyText(s.lan_url) }, "Copy"))
      : el("div", { class: "text-xs mt-1 text-amber-700" },
          "⚠ Reachable only on this machine. To open it on another device, run the ",
          el("span", { class: "font-mono" }, "backend with make serve-lan"),
          " (or ", el("span", { class: "font-mono" }, "--host 0.0.0.0"),
          ") and reopen the app from your machine's network address.");
    return el("div", { class: "border border-slate-200 rounded p-2" },
      el("div", { class: "flex items-center gap-2" },
        urlField,
        el("button", { class: "px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100",
          onclick: () => copyText(s.url) }, "Copy"),
        el("button", { class: "px-2 py-1 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50",
          onclick: async () => {
            try { await api(`/shares/${s.token}`, { method: "DELETE" }); toast("Revoked"); await refresh(); }
            catch (e) { errBox.textContent = e.message; errBox.classList.remove("hidden"); }
          } }, "Revoke"),
      ),
      el("div", { class: "text-xs text-slate-500 mt-1" }, "Expires " + fmtExp(s.expires_at)),
      lanRow,
    );
  };

  const refresh = async () => {
    try {
      const shares = await api(`/items/${it.id}/shares`);
      list.replaceChildren(
        shares.length
          ? el("div", { class: "text-xs uppercase tracking-wider text-slate-500 mb-1" }, "Active links")
          : el("div", { class: "text-sm text-slate-400" }, "No active share links."),
        ...shares.map(renderShare),
      );
    } catch (e) { errBox.textContent = e.message; errBox.classList.remove("hidden"); }
  };

  let days = 30;
  const daysInput = el("input", {
    type: "number", min: "1", value: "30",
    class: "w-16 border border-slate-300 rounded px-2 py-1 text-sm",
    oninput: (e) => { days = Number(e.target.value) || 30; },
  });

  const createBtn = el("button", {
    class: "px-3 py-1.5 text-sm rounded bg-slate-900 text-white hover:bg-slate-800",
    onclick: async () => {
      errBox.classList.add("hidden");
      try {
        await api(`/items/${it.id}/share`, { method: "POST", body: JSON.stringify({ days }) });
        toast("Share link created");
        await refresh();
      } catch (e) { errBox.textContent = e.message; errBox.classList.remove("hidden"); }
    },
  }, "Create link");

  m.append(
    el("div", { class: "flex items-center gap-2 mb-3" },
      el("div", { class: "font-semibold" }, "Share — read-only link"),
      el("button", { class: "ml-auto text-slate-400 hover:text-slate-800", onclick: close }, "✕"),
    ),
    el("div", { class: "text-sm text-slate-600 mb-3" },
      "Creates a link to a read-only ", el("span", { class: "font-medium" }, "focus view"),
      " of this item. Anyone who can reach this backend can open it until it expires."),
    el("div", { class: "flex items-center gap-2" },
      el("span", { class: "text-sm text-slate-600" }, "Expires in"),
      daysInput,
      el("span", { class: "text-sm text-slate-600" }, "days"),
      el("span", { class: "flex-1" }),
      createBtn,
    ),
    list,
    errBox,
  );

  overlay.classList.remove("hidden");
  refresh();
}

$("#modal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-overlay") $("#modal-overlay").classList.add("hidden");
});

// ESC closes any open modal (capture, project, history, drawing preview).
// ---------- find in note (Cmd/Ctrl+F) ----------
// A lightweight in-page find scoped to the open item's detail pane: highlights
// every match and steps between them. Works in both the browser and the native
// (WKWebView) app, which has no built-in find UI.
const find = { bar: null, input: null, count: null, hits: [], active: -1, term: "" };

function findClearHighlights() {
  for (const m of find.hits) {
    const parent = m.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  }
  find.hits = [];
  find.active = -1;
}

function findRun(term) {
  findClearHighlights();
  find.term = term;
  const scope = $("#detail");
  if (!term || !scope || scope.classList.contains("hidden")) { findUpdateCount(); return; }
  const needle = term.toLowerCase();

  // Collect matches first (mutating the tree while walking it is unsafe).
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(needle)) return NodeFilter.FILTER_REJECT;
      const tag = node.parentNode && node.parentNode.nodeName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);

  for (const node of targets) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    let idx = lower.indexOf(needle), from = 0;
    if (idx === -1) continue;
    const frag = document.createDocumentFragment();
    while (idx !== -1) {
      if (idx > from) frag.appendChild(document.createTextNode(text.slice(from, idx)));
      const mark = el("mark", { class: "find-hit" }, text.slice(idx, idx + needle.length));
      frag.appendChild(mark);
      find.hits.push(mark);
      from = idx + needle.length;
      idx = lower.indexOf(needle, from);
    }
    if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
    node.parentNode.replaceChild(frag, node);
  }

  if (find.hits.length) findGo(0);
  findUpdateCount();
}

function findUpdateCount() {
  if (!find.count) return;
  const n = find.hits.length;
  find.count.textContent = n ? `${find.active + 1}/${n}` : (find.term ? "0/0" : "");
  find.count.classList.toggle("none", !!find.term && n === 0);
}

function findGo(i) {
  if (!find.hits.length) return;
  if (find.active >= 0 && find.hits[find.active]) find.hits[find.active].classList.remove("active");
  find.active = (i + find.hits.length) % find.hits.length;
  const m = find.hits[find.active];
  m.classList.add("active");
  scrollElementIntoView(m, { block: "center" });
  findUpdateCount();
}

function findNext(dir) { if (find.hits.length) findGo(find.active + dir); }

function closeFindBar() {
  findClearHighlights();
  find.term = "";
  if (find.bar) { find.bar.remove(); find.bar = null; find.input = find.count = null; }
}

function openFindBar() {
  if (find.bar) { find.input.focus(); find.input.select(); return; }
  find.input = el("input", { type: "text", placeholder: "Find in note…", spellcheck: "false" });
  find.count = el("span", { class: "find-count" });
  const debounced = (() => { let t; return (v) => { clearTimeout(t); t = setTimeout(() => findRun(v), 120); }; })();
  find.input.addEventListener("input", (e) => debounced(e.target.value.trim()));
  find.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); findNext(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); closeFindBar(); }
  });
  find.bar = el("div", { id: "find-bar" },
    el("span", { class: "text-slate-400 text-sm" }, "🔍"),
    find.input,
    find.count,
    el("button", { title: "Previous (Shift+Enter)", onclick: () => findNext(-1) }, "↑"),
    el("button", { title: "Next (Enter)", onclick: () => findNext(1) }, "↓"),
    el("button", { title: "Close (Esc)", onclick: closeFindBar }, "✕"),
  );
  document.body.appendChild(find.bar);
  find.input.focus();
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") {
    // Only hijack the shortcut when an item's detail pane is showing.
    const detail = $("#detail");
    if (state.selected && detail && !detail.classList.contains("hidden")) {
      e.preventDefault();
      openFindBar();
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (find.bar) { e.preventDefault(); closeFindBar(); return; }
  const overlay = $("#modal-overlay");
  if (overlay && !overlay.classList.contains("hidden")) {
    e.preventDefault();
    overlay.classList.add("hidden");
    return;
  }
  // Also dismiss the full-screen drawio drawing editor, if open.
  const drawingOverlay = document.querySelector(".fixed.inset-0.z-20.bg-black\\/40");
  if (drawingOverlay) {
    // Trigger its own close path so it tears down listeners cleanly.
    drawingOverlay.querySelector('[data-action="close"]')?.click();
  }
});

// ---------- inline drawing rendering ----------
const _svgCache = new Map(); // id -> svg text

function _sanitizeDrawioSvg(svg) {
  // Force light color scheme; the default 'light dark' makes colors theme-dependent.
  return svg
    .replace(/color-scheme:\s*light\s+dark;?/gi, "color-scheme: light;")
    .replace(/color-scheme:\s*dark\s+light;?/gi, "color-scheme: light;");
}

async function loadInlineDrawing(box, attId) {
  let svg = _svgCache.get(attId);
  if (svg == null) {
    try {
      const r = await fetch(`/attachments/${attId}/svg`);
      if (!r.ok) throw new Error("HTTP " + r.status);
      svg = await r.text();
      _svgCache.set(attId, svg);
    } catch (e) {
      box.innerHTML = `<div class="text-xs text-red-600 p-2">Failed to load drawing #${attId}: ${e.message}</div>`;
      return;
    }
  }
  // Render inside a Shadow DOM to isolate drawio's foreignObject HTML from
  // the page's Tailwind styles. Otherwise text colors and fonts get clobbered.
  box.innerHTML = "";
  const shadow = box.shadowRoot || box.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { display: inline-block; max-width: 100%; line-height: 0; }
      svg { max-width: 100%; height: auto; display: block; pointer-events: none; background: white; }
      /* drawio uses <foreignObject> with HTML inside; give it sensible defaults */
      foreignObject, foreignObject * {
        font-family: Helvetica, Arial, sans-serif;
        color: #000;
        background: transparent;
      }
      foreignObject div { line-height: 1.2; }
    </style>
    ${_sanitizeDrawioSvg(svg)}
  `;
}

function invalidateDrawingCache(attId) {
  _svgCache.delete(attId);
}

// Lightbox: large read-only viewer for a drawing. Opened from focus mode.
async function openDrawingLightbox(attId) {
  // Backdrop. Click outside the frame OR press Esc to close.
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-30 bg-black/80 flex items-center justify-center p-6 cursor-zoom-out";
  const frame = document.createElement("div");
  frame.className = "bg-white rounded-lg shadow-2xl flex flex-col cursor-default overflow-hidden";
  frame.style.width  = "min(95vw, 1600px)";
  frame.style.height = "min(95vh, 1000px)";
  frame.addEventListener("click", (e) => e.stopPropagation());

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", close);

  // Title bar
  const bar = document.createElement("div");
  bar.className = "h-10 px-3 border-b border-slate-200 flex items-center gap-2 text-sm shrink-0";
  bar.innerHTML = `<span class="text-slate-500">Drawing #${attId}</span><div class="flex-1"></div>`;
  const closeBtn = document.createElement("button");
  closeBtn.className = "text-slate-400 hover:text-slate-800 text-xl leading-none w-6 h-6";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", close);
  bar.appendChild(closeBtn);
  frame.appendChild(bar);

  // SVG container — Shadow DOM isolation + forced full-width scaling.
  const box = document.createElement("div");
  box.className = "flex-1 min-h-0 flex items-center justify-center bg-slate-50 overflow-auto p-4";
  frame.appendChild(box);
  overlay.appendChild(frame);
  document.body.appendChild(overlay);

  // Fetch (or reuse cached) SVG, then render into a shadow root with CSS
  // that scales it to the container instead of its intrinsic pixel size.
  let svg = _svgCache.get(attId);
  if (svg == null) {
    try {
      const r = await fetch(`/attachments/${attId}/svg`);
      svg = await r.text();
      _svgCache.set(attId, svg);
    } catch (e) {
      box.textContent = "Failed to load drawing: " + e.message;
      return;
    }
  }
  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  box.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { display: block; width: 100%; height: 100%; }
      svg {
        width: 100% !important;
        height: 100% !important;
        max-width: 100%;
        max-height: 100%;
        display: block;
        background: white;
        /* preserve aspect ratio while filling the box */
        object-fit: contain;
      }
      foreignObject, foreignObject * {
        font-family: Helvetica, Arial, sans-serif;
        color: #000;
        background: transparent;
      }
      foreignObject div { line-height: 1.2; }
    </style>
    ${_sanitizeDrawioSvg(svg)}
  `;
  // Ensure the SVG itself doesn't carry pixel-locked width/height attrs that
  // override our CSS (drawio exports them by default).
  const svgEl = shadow.querySelector("svg");
  if (svgEl) {
    svgEl.removeAttribute("width");
    svgEl.removeAttribute("height");
    svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
  }
}

// ---------- drawio integration ----------
function openDrawingEditor(item, attachmentId, textarea) {
  // Build a full-viewport modal hosting drawio in an iframe.
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-20 bg-black/40 flex items-center justify-center";
  overlay.innerHTML = `
    <div class="bg-white w-[95vw] h-[90vh] rounded shadow-xl flex flex-col">
      <div class="h-10 px-3 border-b border-slate-200 flex items-center gap-2 text-sm shrink-0">
        <span class="font-medium">${attachmentId ? "Edit drawing #" + attachmentId : "New drawing"}</span>
        <span class="text-xs text-slate-400">${item.kind} #${item.id}</span>
        <div class="flex-1"></div>
        ${attachmentId ? '<button class="px-2 py-1 text-xs text-red-600 hover:underline" data-action="delete">Delete</button>' : ""}
        <button class="px-2 py-1 text-xs text-slate-600 hover:underline" data-action="close">Close without saving</button>
      </div>
      <iframe class="flex-1 border-0 w-full" src="/static/vendor/drawio/index.html?embed=1&proto=json&saveAndExit=1&noSaveBtn=0&spin=1&ui=atlas&libraries=1"></iframe>
    </div>`;
  document.body.appendChild(overlay);
  const iframe = overlay.querySelector("iframe");
  const close = () => {
    window.removeEventListener("message", onMessage);
    overlay.remove();
  };
  overlay.querySelector('[data-action="close"]').addEventListener("click", close);
  const deleteBtn = overlay.querySelector('[data-action="delete"]');
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Delete drawing #${attachmentId}?`)) return;
      try {
        await api(`/attachments/${attachmentId}`, { method: "DELETE" });
        // also strip token from body if textarea provided
        if (textarea) {
          const newVal = textarea.value.replace(new RegExp(`!\\[\\[drawing:${attachmentId}\\]\\]\\s*`, "g"), "");
          if (newVal !== textarea.value) {
            textarea.value = newVal;
            setDraftQuiet(item.id, "body", newVal);
            const preview = document.getElementById("md-preview");
            if (preview) renderMarkdownInto(preview, newVal);
          }
        }
        toast("Drawing deleted");
        close();
      } catch (e) { toast(e.message); }
    });
  }

  let existingXml = null;
  async function loadExisting() {
    if (!attachmentId) return null;
    try {
      const a = await api(`/attachments/${attachmentId}`);
      return a.data_xml || null;
    } catch { return null; }
  }

  let pendingXml = null;

  const onMessage = async (event) => {
    // Only accept messages from our iframe.
    if (event.source !== iframe.contentWindow) return;
    let msg;
    try { msg = typeof event.data === "string" ? JSON.parse(event.data) : event.data; }
    catch { return; }
    if (!msg || typeof msg !== "object") return;

    switch (msg.event) {
      case "init": {
        const xml = existingXml ?? "";
        iframe.contentWindow.postMessage(JSON.stringify({ action: "load", xml }), "*");
        break;
      }
      case "save": {
        // Capture the XML, then ask drawio to export an SVG so we have both.
        pendingXml = msg.xml || "";
        iframe.contentWindow.postMessage(JSON.stringify({
          action: "export", format: "xmlsvg", spinKey: "saving",
        }), "*");
        break;
      }
      case "export": {
        // msg.data is a data URI: data:image/svg+xml;base64,...
        let svg = "";
        try {
          const data = msg.data || "";
          if (data.startsWith("data:")) {
            const comma = data.indexOf(",");
            const meta = data.slice(5, comma); // e.g. "image/svg+xml;base64"
            const payload = data.slice(comma + 1);
            svg = meta.includes("base64") ? atob(payload) : decodeURIComponent(payload);
          } else {
            svg = data;
          }
        } catch (e) {
          toast("Couldn't decode drawing export");
          return;
        }
        try {
          if (attachmentId) {
            await api(`/attachments/${attachmentId}`, {
              method: "PATCH",
              body: JSON.stringify({ data_xml: pendingXml, data_svg: svg }),
            });
            toast("Drawing updated");
            // Refresh inline-rendered SVG.
            invalidateDrawingCache(attachmentId);
            const preview = document.getElementById("md-preview");
            if (preview) {
              for (const box of preview.querySelectorAll(`[data-edit-drawing="${attachmentId}"]`)) {
                box.innerHTML = '<div class="text-xs text-slate-400 p-2">Reloading…</div>';
                loadInlineDrawing(box, attachmentId);
              }
            }
          } else {
            const created = await api(`/items/${item.id}/attachments`, {
              method: "POST",
              body: JSON.stringify({ kind: "drawing", data_xml: pendingXml, data_svg: svg }),
            });
            // insert token into textarea at cursor (or append)
            if (textarea) {
              const insert = `\n![[drawing:${created.id}]]\n`;
              const pos = textarea.selectionStart ?? textarea.value.length;
              const newVal = textarea.value.slice(0, pos) + insert + textarea.value.slice(pos);
              textarea.value = newVal;
              textarea.selectionStart = textarea.selectionEnd = pos + insert.length;
              setDraftQuiet(item.id, "body", newVal);
              const preview = document.getElementById("md-preview");
              if (preview) renderMarkdownInto(preview, newVal);
            }
            toast("Drawing inserted");
          }
        } catch (e) {
          toast("Save failed: " + e.message);
          return;
        }
        close();
        break;
      }
      case "exit":
      case "cancel":
        close();
        break;
    }
  };

  window.addEventListener("message", onMessage);
  loadExisting().then((xml) => { existingXml = xml; /* iframe's init will read it */ });
}

// ---------- pinning ----------
async function togglePin(it) {
  try {
    const r = await api(`/links/${it.id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_pinned: !it.is_pinned }),
    });
    state.selected = r;
    const idx = state.items.findIndex((x) => x.id === it.id);
    if (idx >= 0) state.items[idx] = r;
    renderList();
    renderDetail();
    toast(r.is_pinned ? "Bookmarked" : "Bookmark removed");
  } catch (e) { toast(e.message); }
}

// ---------- Home view ----------
function todayLocalIso() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function isoMinusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function startOfWeekIso() {
  // ISO week: Monday is day 1
  const d = new Date();
  const dow = (d.getDay() + 6) % 7; // 0=Mon..6=Sun
  d.setDate(d.getDate() - dow);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function startOfMonthIso() {
  const d = new Date();
  d.setDate(1);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function isoWeekNumber() {
  // ISO 8601 week number
  const d = new Date();
  const dayNum = (d.getDay() + 6) % 7; // Mon=0
  d.setDate(d.getDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
  return { year: d.getFullYear(), week };
}
function monthLabel() {
  return new Date().toLocaleString(undefined, { month: "long", year: "numeric" });
}
function fmtElapsed(startIso) {
  if (!startIso) return "";
  const start = new Date(startIso);
  const sec = Math.max(0, Math.floor((Date.now() - start.getTime()) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}h ${String(m).padStart(2, "0")}m`
    : `${m}:${String(s).padStart(2, "0")}`;
}
function fmtHours(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0 && m === 0) return "—";
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec === 0) return "0";
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}
function isoToLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localInputToIso(local) {
  if (!local) return null;
  // datetime-local has no tz — interpret as local
  const d = new Date(local);
  return d.toISOString().replace(".000Z", "+00:00");
}
function fmtSessionTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}
// A stored ISO timestamp → the local YYYY-MM-DD for a <input type="date">.
function isoToDateInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// A <input type="date"> value (YYYY-MM-DD) → ISO at local midnight, so the day
// round-trips through local-time bucketing on the calendar without drifting.
function dateInputToIso(dateStr) {
  if (!dateStr) return null;
  return localInputToIso(dateStr + "T00:00");
}
// Parse an "estimate" input (hours as a decimal, e.g. "1.5") → whole minutes.
function estimateInputToMinutes(val) {
  const v = (val ?? "").toString().trim();
  if (v === "") return null;
  const hours = Number(v);
  if (!isFinite(hours) || hours < 0) return null;
  return Math.round(hours * 60);
}
// Minutes → a compact "1h 30m" / "45m" label; "" when unset.
function fmtEstimate(minutes) {
  if (minutes == null) return "";
  return fmtDuration(minutes * 60);
}

// Selected stats periods (sticky within session)
const statsSel = { week: null, month: null }; // each: {range_from, range_to, label} | null=current

// Calendar view: month currently shown on the home page (sticky within session).
const calView = { year: new Date().getFullYear(), month: new Date().getMonth() }; // month is 0-indexed

function currentWeekRange() {
  const wk = isoWeekNumber();
  return {
    range_from: startOfWeekIso(),
    range_to: todayLocalIso(),
    label: `W${String(wk.week).padStart(2, "0")} · this week`,
    is_current: true,
  };
}
function currentMonthRange() {
  return {
    range_from: startOfMonthIso(),
    range_to: todayLocalIso(),
    label: `${monthLabel()} · this month`,
    is_current: true,
  };
}

async function renderHome() {
  const home = $("#home-view");
  home.replaceChildren(el("div", { class: "p-6 text-sm text-slate-400" }, "Loading…"));

  const today = todayLocalIso();
  const weekR = statsSel.week ?? currentWeekRange();
  const monthR = statsSel.month ?? currentMonthRange();

  let pinned = [], doing = [], todayList = [], sToday = null, sWeek = null, sMonth = null, periods = { weeks: [], months: [] };
  try {
    [pinned, doing, todayList, sToday, sWeek, sMonth, periods] = await Promise.all([
      api("/items?kind=link&is_pinned=true&limit=100"),
      api("/items?kind=task&status=doing&limit=20"),
      api("/items?kind=task&status=today&limit=50"),
      api(`/stats?from=${today}&to=${today}`),
      api(`/stats?from=${weekR.range_from}&to=${weekR.range_to}`),
      api(`/stats?from=${monthR.range_from}&to=${monthR.range_to}`),
      api("/stats/periods"),
    ]);
  } catch (e) {
    home.replaceChildren(el("div", { class: "p-6 text-sm text-red-600" }, "Failed: " + e.message));
    return;
  }

  home.replaceChildren(
    el("div", { class: "max-w-5xl mx-auto p-6 space-y-8" },
      bookmarksSection(pinned),
      doingSection(doing),
      todaySection(todayList),
      calendarSection(),
      searchSection(),
      statsSection(sToday, sWeek, sMonth, periods, weekR, monthR),
    )
  );
}

async function refreshStatsOnly() {
  const block = $("#stats-block");
  if (!block) { renderHome(); return; }
  block.replaceChildren(el("div", { class: "text-sm text-slate-400" }, "Updating…"));
  const today = todayLocalIso();
  const weekR = statsSel.week ?? currentWeekRange();
  const monthR = statsSel.month ?? currentMonthRange();
  try {
    const [sToday, sWeek, sMonth, periods] = await Promise.all([
      api(`/stats?from=${today}&to=${today}`),
      api(`/stats?from=${weekR.range_from}&to=${weekR.range_to}`),
      api(`/stats?from=${monthR.range_from}&to=${monthR.range_to}`),
      api("/stats/periods"),
    ]);
    block.replaceWith(statsSection(sToday, sWeek, sMonth, periods, weekR, monthR));
  } catch (e) {
    block.replaceChildren(el("div", { class: "text-sm text-red-600" }, "Failed: " + e.message));
  }
}

// ---------- calendar ----------
const _pad2 = (n) => String(n).padStart(2, "0");
const dateKey = (y, m0, d) => `${y}-${_pad2(m0 + 1)}-${_pad2(d)}`;

function monthRangeIso(year, month) {
  // month is 0-indexed; returns inclusive {from, to} as local YYYY-MM-DD.
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return { from: dateKey(year, month, 1), to: dateKey(year, month, daysInMonth) };
}

// Returns a <section> that mounts the month grid and fetches its own data,
// so the ◀/▶ month navigation can refresh independently of the rest of home.
function calendarSection() {
  const sec = el("section", { id: "calendar-block" },
    el("div", { class: "text-sm text-slate-400" }, "Loading calendar…"),
  );
  renderCalendar(sec);
  return sec;
}

async function renderCalendar(container) {
  const sec = container || $("#calendar-block");
  if (!sec) return;
  const { year, month } = calView;
  const { from, to } = monthRangeIso(year, month);

  let items = [], stats = null;
  try {
    [items, stats] = await Promise.all([
      api("/items?limit=1000"),
      api(`/stats?from=${from}&to=${to}`),
    ]);
  } catch (e) {
    sec.replaceChildren(el("div", { class: "text-sm text-red-600" }, "Calendar failed: " + e.message));
    return;
  }

  // Seconds tracked per local day (keyed YYYY-MM-DD, matching the stats API).
  const secByDay = new Map();
  for (const b of (stats?.by_day || [])) secByDay.set(b.date, b.seconds);

  // Tasks (by due date) and notes (by date) falling in this month, bucketed by
  // local day. Both use the shared due_at column.
  const dueByDay = new Map();
  for (const it of items) {
    if (it.kind !== "task" && it.kind !== "note") continue;
    const due = it.dueAt ?? it.due_at;
    if (!due) continue;
    const d = new Date(due);
    if (d.getFullYear() !== year || d.getMonth() !== month) continue;
    const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate());
    if (!dueByDay.has(key)) dueByDay.set(key, []);
    dueByDay.get(key).push(it);
  }

  const label = new Date(year, month, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leading = (new Date(year, month, 1).getDay() + 6) % 7; // Monday-first offset
  const todayKey = todayLocalIso();

  const nav = (delta) => () => {
    let m = calView.month + delta, y = calView.year;
    if (m < 0) { m = 11; y -= 1; }
    else if (m > 11) { m = 0; y += 1; }
    calView.month = m; calView.year = y;
    renderCalendar();
  };
  const isCurrentMonth = year === new Date().getFullYear() && month === new Date().getMonth();

  const header = el("div", { class: "flex items-center justify-between mb-3" },
    el("h2", { class: "text-sm font-semibold uppercase tracking-wider text-slate-500" }, "Calendar"),
    el("div", { class: "flex items-center gap-1" },
      el("button", {
        class: "px-2 py-0.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded",
        title: "Previous month", onclick: nav(-1),
      }, "◀"),
      el("div", { class: "text-sm font-medium text-slate-700 w-36 text-center" }, label),
      el("button", {
        class: "px-2 py-0.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded",
        title: "Next month", onclick: nav(1),
      }, "▶"),
      isCurrentMonth ? null : el("button", {
        class: "ml-1 px-2 py-0.5 text-xs border border-slate-300 rounded text-slate-600 hover:bg-slate-100",
        title: "Jump to current month",
        onclick: () => { calView.year = new Date().getFullYear(); calView.month = new Date().getMonth(); renderCalendar(); },
      }, "Today"),
    ),
  );

  const dow = el("div", { class: "grid grid-cols-7 gap-1 mb-1" },
    ...["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) =>
      el("div", { class: "text-[10px] font-medium uppercase tracking-wide text-slate-400 text-center" }, d)),
  );

  const cells = [];
  for (let i = 0; i < leading; i++) cells.push(el("div", { class: "min-h-[76px]" }));
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push(calDayCell(year, month, day, { dueByDay, secByDay, todayKey }));
  }

  sec.replaceChildren(header, dow, el("div", { class: "grid grid-cols-7 gap-1" }, ...cells));
}

function calDayCell(year, month, day, { dueByDay, secByDay, todayKey }) {
  const key = dateKey(year, month, day);
  const isToday = key === todayKey;
  const due = dueByDay.get(key) || [];
  const secs = secByDay.get(key) || 0;

  // The whole cell is a click target that opens the day detail; chips inside
  // stop propagation and jump straight to their item.
  const cell = el("div", {
    class: "min-h-[76px] border rounded p-1 flex flex-col gap-0.5 bg-white cursor-pointer hover:border-blue-300 "
      + (isToday ? "border-blue-400 ring-1 ring-blue-200" : "border-slate-200"),
    title: "View / add for this day",
    onclick: () => openDayModal(key),
  });

  cell.append(
    el("div", { class: "flex items-center justify-between" },
      el("span", { class: "text-xs font-medium " + (isToday ? "text-blue-600" : "text-slate-500") }, String(day)),
      secs >= 60 ? el("span", {
        class: "text-[10px] font-mono text-emerald-600 tabular-nums",
        title: "Time tracked",
      }, fmtHours(secs)) : null,
    ),
  );

  for (const it of due.slice(0, 3)) {
    const proj = state.projects.find((p) => p.id === (it.projectId ?? it.project_id));
    const isNote = it.kind === "note";
    const done = it.status === "done";
    const chipColor = done
      ? "line-through text-slate-400 bg-slate-50"
      : isNote ? "text-sky-700 bg-sky-50 hover:bg-sky-100" : "text-amber-800 bg-amber-50 hover:bg-amber-100";
    cell.append(el("button", {
      class: "text-[11px] leading-tight text-left truncate rounded px-1 py-0.5 " + chipColor,
      title: (isNote ? "📝 " : "") + (it.title || "(untitled)") + (proj ? ` — ${proj.name}` : ""),
      onclick: (e) => {
        e.stopPropagation();
        state.pseudo = null; state.scopeProjectId = proj?.id ?? null; state.kind = it.kind;
        clearSel(); renderSidebar(); dispatchView().then(() => selectItem(it.id));
      },
    }, (isNote ? "📝 " : "") + (it.title || "(untitled)")));
  }
  if (due.length > 3) {
    cell.append(el("div", { class: "text-[10px] text-slate-400 px-1" }, `+${due.length - 3} more`));
  }

  return cell;
}

// Day detail: lists what happened on a given local day (worked / completed /
// created / due) and offers quick-add of a task or note dated to that day.
async function openDayModal(dayKey) {
  const overlay = $("#modal-overlay");
  const m = $("#modal");
  const close = () => overlay.classList.add("hidden");

  const heading = new Date(dayKey + "T00:00").toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const openItem = (it) => {
    const proj = state.projects.find((p) => p.id === (it.projectId ?? it.project_id));
    close();
    state.pseudo = null; state.scopeProjectId = proj?.id ?? null; state.kind = it.kind;
    clearSel(); renderSidebar(); dispatchView().then(() => selectItem(it.id));
  };

  const header = el("div", { class: "flex items-center gap-2 mb-3" },
    el("div", { class: "font-semibold text-slate-800" }, heading),
    el("button", { class: "ml-auto text-slate-400 hover:text-slate-800", onclick: close }, "✕"),
  );
  const quickAdd = el("div", { class: "flex gap-2 mb-3" },
    el("button", {
      class: "px-2.5 py-1 text-sm rounded border border-amber-300 text-amber-800 bg-amber-50 hover:bg-amber-100",
      onclick: () => openNewItemModal({ tab: "task", dueDate: dayKey, onCreated: () => { if (state.pseudo === "home") renderCalendar(); } }),
    }, "+ Task"),
    el("button", {
      class: "px-2.5 py-1 text-sm rounded border border-sky-300 text-sky-800 bg-sky-50 hover:bg-sky-100",
      onclick: () => openNewItemModal({ tab: "note", dueDate: dayKey, onCreated: () => { if (state.pseudo === "home") renderCalendar(); } }),
    }, "+ Note"),
  );

  m.replaceChildren(header, quickAdd, el("div", { class: "text-sm text-slate-400" }, "Loading…"));
  overlay.classList.remove("hidden");

  let stats = null, items = [];
  try {
    [stats, items] = await Promise.all([
      api(`/stats?from=${dayKey}&to=${dayKey}`),
      api("/items?limit=1000"),
    ]);
  } catch (e) {
    m.replaceChildren(header, quickAdd, el("div", { class: "text-sm text-red-600" }, "Failed: " + e.message));
    return;
  }

  const byId = new Map(items.map((it) => [it.id, it]));
  const projName = (it) => state.projects.find((p) => p.id === (it.projectId ?? it.project_id))?.name || "";

  // A tappable row for an item, with optional trailing meta (e.g. time spent).
  const itemRow = (it, meta) => el("button", {
    class: "w-full flex items-center gap-2 text-left px-2 py-1.5 rounded hover:bg-slate-100 border border-transparent",
    onclick: () => openItem(it),
  },
    el("span", { class: "text-[10px] uppercase tracking-wide px-1 rounded "
      + (it.kind === "task" ? "bg-amber-100 text-amber-800" : it.kind === "note" ? "bg-sky-100 text-sky-800" : "bg-slate-100 text-slate-600") },
      it.kind),
    el("span", { class: "min-w-0 flex-1 truncate text-sm " + (it.status === "done" ? "line-through text-slate-400" : "text-slate-800") },
      it.title || "(untitled)"),
    projName(it) ? el("span", { class: "text-xs text-slate-400 shrink-0" }, projName(it)) : null,
    meta ? el("span", { class: "text-xs font-mono text-slate-500 shrink-0" }, meta) : null,
  );

  const block = (heading, rows) => rows.length === 0 ? null : el("div", { class: "mb-3" },
    el("div", { class: "text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1" }, heading),
    el("div", { class: "grid gap-0.5" }, ...rows),
  );

  const resolve = (ids) => (ids || []).map((id) => byId.get(id)).filter(Boolean);

  // Worked: from stats by_task (has time + title even if the item is elsewhere).
  const worked = (stats.by_task || []).map((b) => {
    const it = byId.get(b.item_id) || { id: b.item_id, kind: "task", title: b.title, status: b.status, project_id: b.project_id };
    const est = it.estimate_minutes ?? it.estimateMinutes;
    const meta = fmtDuration(b.seconds) + (est != null ? ` / ${fmtEstimate(est)} est` : "");
    return itemRow(it, meta);
  });

  const a = stats.activity || {};
  const completed = resolve(a.tasks_done).map((it) => itemRow(it));
  const createdItems = [...resolve(a.tasks_created), ...resolve(a.notes_created), ...resolve(a.links_created)];
  const created = createdItems.map((it) => itemRow(it));

  // Due / dated that day (tasks by due, notes by date).
  const dueItems = items.filter((it) => {
    if (it.kind !== "task" && it.kind !== "note") return false;
    const due = it.dueAt ?? it.due_at;
    return due && isoToDateInput(due) === dayKey;
  });
  const dueRows = dueItems.map((it) => itemRow(it));

  const totalMeta = stats.total_seconds >= 60
    ? el("div", { class: "text-xs text-slate-500 mb-3" }, "Total time tracked: " + fmtDuration(stats.total_seconds))
    : null;

  const sections = [
    totalMeta,
    block("Due / dated", dueRows),
    block("Worked on", worked),
    block("Completed", completed),
    block("Created", created),
  ].filter(Boolean);

  const bodyChildren = sections.length
    ? sections
    : [el("div", { class: "text-sm text-slate-400 italic" }, "Nothing recorded for this day yet.")];

  m.replaceChildren(header, quickAdd, ...bodyChildren);
}

function sectionHeader(title, sub) {
  return el("div", { class: "flex items-baseline justify-between mb-3" },
    el("h2", { class: "text-sm font-semibold uppercase tracking-wider text-slate-500" }, title),
    sub ? el("div", { class: "text-xs text-slate-400" }, sub) : null,
  );
}

// User-picked tags that act as bookmark group labels (within each project).
// Stored as a comma-separated string in localStorage; parsed lazily.
function getBookmarkGroupTags() {
  try {
    const raw = localStorage.getItem("bookmarkGroupTags") || "";
    return raw.split(",").map((t) => t.trim()).filter(Boolean);
  } catch { return []; }
}
function setBookmarkGroupTags(list) {
  try { localStorage.setItem("bookmarkGroupTags", list.map((t) => t.trim()).filter(Boolean).join(", ")); } catch {}
}

function bookmarksSection(links) {
  const groupTags = getBookmarkGroupTags();

  // A small input in the section header lets the user pick which tags
  // become group labels.
  const groupingInput = el("input", {
    type: "text",
    value: groupTags.join(", "),
    placeholder: "docs, tools, reading…",
    title: "Comma-separated tag names; matching bookmarks are grouped under each",
    class: "ml-2 px-2 py-0.5 text-xs border border-slate-300 rounded w-56 bg-white",
    onchange: (e) => {
      setBookmarkGroupTags(e.target.value.split(","));
      renderHome();  // re-render so the new grouping takes effect
    },
  });
  const groupingControl = el("div", { class: "flex items-center gap-2" },
    el("span", { class: "text-xs text-slate-400" }, "group by tag:"),
    groupingInput,
  );

  if (links.length === 0) {
    return el("section", {},
      el("div", { class: "flex items-baseline justify-between mb-3" },
        el("h2", { class: "text-sm font-semibold uppercase tracking-wider text-slate-500" }, "Bookmarks"),
        groupingControl,
      ),
      el("div", { class: "text-sm text-slate-400 italic" }, "No bookmarks yet — open a link and use ☆ Bookmark."),
    );
  }

  // Group by project first.
  const byProject = new Map();
  for (const link of links) {
    const pid = link.project_id ?? link.projectId;
    if (!byProject.has(pid)) byProject.set(pid, []);
    byProject.get(pid).push(link);
  }

  // Order: current project first, then alphabetical by name.
  const projectGroups = [];
  for (const pid of byProject.keys()) {
    const proj = state.projects.find((p) => p.id === pid);
    projectGroups.push({ project: proj, links: byProject.get(pid) });
  }
  projectGroups.sort((a, b) => {
    const ac = a.project?.id === state.currentProjectId ? 0 : 1;
    const bc = b.project?.id === state.currentProjectId ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return (a.project?.name || "").localeCompare(b.project?.name || "");
  });

  const header = el("div", { class: "flex items-baseline justify-between mb-3 flex-wrap gap-2" },
    el("div", { class: "flex items-baseline gap-2" },
      el("h2", { class: "text-sm font-semibold uppercase tracking-wider text-slate-500" }, "Bookmarks"),
      el("span", { class: "text-xs text-slate-400" }, `${links.length}`),
    ),
    groupingControl,
  );

  const children = [header];
  for (const g of projectGroups) {
    children.push(
      el("div", { class: "mt-3 mb-1 flex items-center gap-2" },
        g.project?.color
          ? el("span", { class: "inline-block w-2 h-2 rounded-full shrink-0", style: `background:${g.project.color}` })
          : null,
        el("button", {
          class: "text-xs font-medium text-slate-600 uppercase tracking-wider hover:text-slate-900",
          onclick: () => {
            if (!g.project) return;
            state.pseudo = null;
            state.scopeProjectId = g.project.id;
            clearSel();
            renderSidebar();
            dispatchView();
          },
        }, g.project?.name || "Unknown project"),
        el("span", { class: "text-xs text-slate-400" }, `· ${g.links.length}`),
        el("div", { class: "flex-1 border-t border-slate-200 ml-2" }),
      ),
      renderBookmarkRows(g.links, groupTags),
    );
  }

  return el("section", {}, ...children);
}

// Within a single project's bookmarks: either a flat tile row (no group tags
// configured) or a labeled mini-row per group tag with an "Other" row for
// bookmarks lacking any of them.
function renderBookmarkRows(links, groupTags) {
  if (groupTags.length === 0) {
    return el("div", { class: "flex flex-wrap gap-2" }, ...links.map(pinnedTile));
  }
  const groupContainer = el("div", { class: "space-y-2" });
  const seen = new Set();   // bookmarks claimed by at least one group tag
  for (const tag of groupTags) {
    const matching = links.filter((l) => (l.tags || []).includes(tag));
    if (matching.length === 0) continue;
    matching.forEach((l) => seen.add(l.id));
    groupContainer.append(el("div", { class: "pl-4 border-l-2 border-slate-200" },
      el("div", { class: "text-[11px] font-medium text-slate-500 mb-1" }, tag),
      el("div", { class: "flex flex-wrap gap-2" }, ...matching.map(pinnedTile)),
    ));
  }
  const other = links.filter((l) => !seen.has(l.id));
  if (other.length > 0) {
    groupContainer.append(el("div", { class: "pl-4 border-l-2 border-slate-200" },
      el("div", { class: "text-[11px] font-medium text-slate-400 mb-1 italic" }, "Other"),
      el("div", { class: "flex flex-wrap gap-2" }, ...other.map(pinnedTile)),
    ));
  }
  return groupContainer;
}

function searchSection() {
  const results = el("div", { class: "mt-3 space-y-1" });
  let timer = null;
  const input = el("input", {
    type: "search",
    id: "home-search",
    placeholder: "Search… (also tries tag:work or tag:urgent)",
    class: "w-full px-3 py-2 text-sm border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400 bg-white",
    oninput: (e) => {
      const q = e.target.value.trim();
      clearTimeout(timer);
      if (!q) { results.replaceChildren(); return; }
      timer = setTimeout(async () => {
        try {
          const items = await api(`/search?q=${encodeURIComponent(q)}&limit=30`);
          results.replaceChildren();
          if (items.length === 0) {
            results.append(el("div", { class: "text-sm text-slate-400 italic px-1" }, "No matches."));
            return;
          }
          for (const item of items) results.append(renderSearchHit(item));
        } catch (err) {
          results.replaceChildren(el("div", { class: "text-sm text-red-600" }, err.message));
        }
      }, 200);
    },
  });
  return el("section", {},
    sectionHeader("Search"),
    input,
    results,
  );
}

function renderSearchHit(item) {
  const proj = state.projects.find((p) => p.id === (item.projectId ?? item.project_id));
  const title = item.title || item.url || (item.body || "").trim().slice(0, 60) || "(untitled)";
  return el("button", {
    class: "w-full text-left px-3 py-2 bg-white border border-slate-200 rounded hover:border-slate-400 hover:bg-slate-50 flex items-center gap-2",
    onclick: () => {
      state.pseudo = null;
      state.kind = item.kind;
      state.scopeProjectId = proj?.id ?? null;
      state.statusFilter = null;
      clearSel();
      renderSidebar();
      dispatchView().then(() => selectItem(item.id));
    },
  },
    el("span", { class: "chip" }, item.kind),
    el("div", { class: "min-w-0 flex-1" },
      el("div", { class: "text-sm font-medium truncate" }, title),
      el("div", { class: "text-xs text-slate-500 truncate" }, proj ? proj.name : ""),
    ),
    el("span", { class: "text-xs text-slate-400 shrink-0" }, "#" + item.id),
  );
}

function pinnedTile(link) {
  const host = (() => { try { return new URL(link.url).host.replace(/^www\./, ""); } catch { return link.url; } })();
  const label = (link.display_label || "").trim() || link.title || host;
  const open = (e) => { if (e.target.tagName !== "BUTTON") window.open(link.url, "_blank", "noopener"); };
  return el("div", {
    class: "group relative flex items-center gap-2 px-3 py-2 bg-white border border-slate-200 rounded hover:border-slate-400 hover:shadow-sm cursor-pointer max-w-[260px]",
    title: link.url,
    onclick: open,
  },
    link.favicon_url
      ? el("img", { src: link.favicon_url, class: "w-4 h-4 shrink-0", referrerpolicy: "no-referrer", onerror: function() { this.style.display = "none"; } })
      : el("span", { class: "w-4 h-4 shrink-0 bg-slate-200 rounded-sm" }),
    el("div", { class: "min-w-0" },
      el("div", { class: "text-sm font-medium text-slate-900 truncate" }, label),
      el("div", { class: "text-[11px] text-slate-500 truncate" }, host),
    ),
    el("button", {
      class: "absolute -top-1.5 -right-1.5 hidden group-hover:flex items-center justify-center w-5 h-5 rounded-full bg-white border border-slate-300 text-slate-500 hover:bg-red-50 hover:text-red-600 hover:border-red-300 text-[11px]",
      title: "Unpin",
      onclick: (e) => { e.stopPropagation(); togglePin(link); renderHome(); },
    }, "✕"),
  );
}

function todaySection(items) {
  if (items.length === 0) {
    return el("section", {},
      sectionHeader("Today"),
      el("div", { class: "text-sm text-slate-400 italic" }, "No tasks queued for today."),
    );
  }
  return el("section", {},
    sectionHeader("Today", `${items.length}`),
    el("div", { class: "grid gap-1.5" }, ...items.map(todayRow)),
  );
}

function todayRow(item) {
  const proj = state.projects.find((p) => p.id === (item.projectId ?? item.project_id));
  return el("div", { class: "flex items-center gap-3 bg-white border border-slate-200 rounded px-3 py-2 hover:border-slate-300" },
    el("div", { class: "min-w-0 flex-1" },
      el("button", {
        class: "text-sm font-medium text-slate-900 hover:underline truncate text-left w-full",
        onclick: () => { state.pseudo = null; state.scopeProjectId = proj?.id ?? null; state.kind = "task"; clearSel(); renderSidebar(); dispatchView().then(() => selectItem(item.id)); },
      }, item.title || "(untitled)"),
      el("div", { class: "text-xs text-slate-500" }, proj ? proj.name : ""),
    ),
    el("button", {
      class: "px-2 py-1 text-xs rounded border border-amber-300 text-amber-800 bg-amber-50 hover:bg-amber-100",
      title: "Start (mark doing)",
      onclick: async () => { try { await api(`/tasks/${item.id}/doing`, { method: "POST" }); await renderHome(); toast("Started"); } catch (e) { toast(e.message); } },
    }, "▶ Start"),
    el("button", {
      class: "px-2 py-1 text-xs rounded border border-slate-300 text-slate-700 hover:bg-slate-50",
      onclick: async () => { try { await api(`/tasks/${item.id}/done`, { method: "POST" }); await renderHome(); toast("Done"); } catch (e) { toast(e.message); } },
    }, "✓ Done"),
  );
}

function doingSection(items) {
  if (items.length === 0) {
    return el("section", {},
      sectionHeader("Doing"),
      el("div", { class: "text-sm text-slate-400 italic" }, "Nothing in progress right now."),
    );
  }
  return el("section", {},
    sectionHeader("Doing", `${items.length}`),
    el("div", { class: "grid gap-2" }, ...items.map(doingRow)),
  );
}

function doingRow(item) {
  const proj = state.projects.find((p) => p.id === (item.projectId ?? item.project_id));
  return el("div", { class: "flex items-center gap-3 bg-white border border-amber-200 rounded px-3 py-2 shadow-sm" },
    el("span", { class: "w-2 h-2 rounded-full bg-amber-400 animate-pulse" }),
    el("div", { class: "min-w-0 flex-1" },
      el("button", {
        class: "text-sm font-medium text-slate-900 hover:underline truncate text-left w-full",
        onclick: () => { state.pseudo = null; state.scopeProjectId = proj?.id ?? null; state.kind = "task"; state.statusFilter = "doing"; selectItem(item.id); renderSidebar(); dispatchView().then(() => selectItem(item.id)); },
      }, item.title || "(untitled)"),
      el("div", { class: "text-xs text-slate-500" }, proj ? proj.name : ""),
    ),
    el("div", { class: "font-mono text-sm text-amber-700 tabular-nums", "data-doing-since": item.doingStartedAt ?? item.doing_started_at ?? "" }, fmtElapsed(item.doingStartedAt ?? item.doing_started_at)),
    el("button", {
      class: "px-2 py-1 text-xs rounded border border-slate-300 text-slate-700 hover:bg-slate-50",
      title: "Pause and move back to Today",
      onclick: async () => { try { await api(`/tasks/${item.id}`, { method: "PATCH", body: JSON.stringify({ status: "today" }) }); await renderHome(); toast("Paused — moved to Today"); } catch (e) { toast(e.message); } },
    }, "⏸ Today"),
    el("button", {
      class: "px-2 py-1 text-xs rounded border border-slate-300 text-slate-700 hover:bg-slate-50",
      onclick: async () => { try { await api(`/tasks/${item.id}/done`, { method: "POST" }); await renderHome(); toast("Done"); } catch (e) { toast(e.message); } },
    }, "✓ Done"),
  );
}

function statsSection(today, week, month, periods, weekR, monthR) {
  const top = (s) => {
    const tasks = (s?.by_task || []).slice(0, 5);
    if (tasks.length === 0) return el("div", { class: "text-sm text-slate-400 italic" }, "No tracked work this period.");
    return el("div", { class: "space-y-1" }, ...tasks.map((t) =>
      el("div", { class: "flex items-center gap-2 text-sm" },
        el("button", {
          class: "flex-1 truncate text-left hover:underline",
          onclick: () => { state.pseudo = null; state.scopeProjectId = t.project_id; state.kind = "task"; clearSel(); renderSidebar(); dispatchView().then(() => selectItem(t.item_id)); },
        }, t.title || `#${t.item_id}`),
        el("span", { class: "font-mono text-slate-600 tabular-nums" }, fmtHours(t.seconds)),
      )));
  };

  const card = (titleNode, sub, s) => el("div", { class: "bg-white border border-slate-200 rounded p-4" },
    el("div", { class: "text-xs uppercase tracking-wider text-slate-500 flex items-center gap-2" }, titleNode),
    el("div", { class: "mt-1 text-2xl font-semibold tabular-nums text-slate-900" }, fmtHours(s?.total_seconds || 0)),
    el("div", { class: "text-xs text-slate-400 mt-0.5" }, sub),
    el("div", { class: "mt-2 text-xs text-slate-500" },
      `${(s?.activity?.tasks_done || []).length} done · ${(s?.activity?.notes_created || []).length} notes · ${(s?.activity?.links_created || []).length} links`),
  );

  // Compact labels
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const compactWeek = (w) => {
    const [sy, sm, sd] = w.range_from.split("-").map(Number);
    const [, em, ed] = w.range_to.split("-").map(Number);
    const range = sm === em ? `${MONTHS[sm - 1]} ${sd}–${ed}` : `${MONTHS[sm - 1]} ${sd} – ${MONTHS[em - 1]} ${ed}`;
    return `W${String(w.week).padStart(2, "0")} · ${range} · ${fmtHours(w.seconds)}`;
  };
  const compactMonth = (m) => `${MONTHS[m.month - 1]} ${m.year} · ${fmtHours(m.seconds)}`;

  // Build a select for weeks
  const cur_w = currentWeekRange();
  const weekOptions = [];
  let seenCurrentWeek = false;
  for (const w of (periods.weeks || [])) {
    const isCurrent = w.range_from === cur_w.range_from;
    if (isCurrent) seenCurrentWeek = true;
    const label = compactWeek(w) + (isCurrent ? " (current)" : "");
    weekOptions.push(el("option", {
      value: `${w.range_from}|${w.range_to}|${label}`,
      ...(weekR.range_from === w.range_from ? { selected: "selected" } : {}),
    }, label));
  }
  if (!seenCurrentWeek) {
    const wk = isoWeekNumber();
    const label = `W${String(wk.week).padStart(2, "0")} (current)`;
    weekOptions.unshift(el("option", {
      value: `${cur_w.range_from}|${cur_w.range_to}|${label}`,
      ...(weekR.range_from === cur_w.range_from ? { selected: "selected" } : {}),
    }, label));
  }
  const weekSelect = el("select", {
    class: "ml-auto text-xs border border-slate-300 rounded px-1 py-0.5 bg-white w-44 max-w-full",
    onchange: (e) => {
      const [from, to, label] = e.target.value.split("|");
      const isCur = from === cur_w.range_from;
      statsSel.week = isCur ? null : { range_from: from, range_to: to, label };
      refreshStatsOnly();
    },
  }, ...weekOptions);

  // Build a select for months
  const cur_m = currentMonthRange();
  const monthOptions = [];
  let seenCurrentMonth = false;
  for (const m of (periods.months || [])) {
    const isCurrent = m.range_from === cur_m.range_from;
    if (isCurrent) seenCurrentMonth = true;
    const label = compactMonth(m) + (isCurrent ? " (current)" : "");
    monthOptions.push(el("option", {
      value: `${m.range_from}|${m.range_to}|${label}`,
      ...(monthR.range_from === m.range_from ? { selected: "selected" } : {}),
    }, label));
  }
  if (!seenCurrentMonth) {
    const label = `${monthLabel()} (current)`;
    monthOptions.unshift(el("option", {
      value: `${cur_m.range_from}|${cur_m.range_to}|${label}`,
      ...(monthR.range_from === cur_m.range_from ? { selected: "selected" } : {}),
    }, label));
  }
  const monthSelect = el("select", {
    class: "ml-auto text-xs border border-slate-300 rounded px-1 py-0.5 bg-white w-44 max-w-full",
    onchange: (e) => {
      const [from, to, label] = e.target.value.split("|");
      const isCur = from === cur_m.range_from;
      statsSel.month = isCur ? null : { range_from: from, range_to: to, label };
      refreshStatsOnly();
    },
  }, ...monthOptions);

  const weekTitle = el("div", { class: "flex items-center gap-2 w-full" },
    el("span", {}, "Week"),
    weekSelect,
  );
  const monthTitle = el("div", { class: "flex items-center gap-2 w-full" },
    el("span", {}, "Month"),
    monthSelect,
  );
  const todayTitle = el("div", { class: "flex items-center gap-2 w-full" },
    el("span", {}, "Today"),
  );

  return el("section", { id: "stats-block" },
    sectionHeader("Stats", "Auto-pauses doing tasks at end of work day"),
    el("div", { class: "grid grid-cols-1 sm:grid-cols-3 gap-3" },
      card(todayTitle, todayLocalIso(), today),
      card(weekTitle, `${weekR.range_from} → ${weekR.range_to}`, week),
      card(monthTitle, `${monthR.range_from} → ${monthR.range_to}`, month),
    ),
    el("div", { class: "mt-4 grid grid-cols-1 md:grid-cols-3 gap-3" },
      el("div", { class: "bg-white border border-slate-200 rounded p-4" },
        el("div", { class: "text-xs uppercase tracking-wider text-slate-500 mb-2" }, "Top tasks · today"), top(today)),
      el("div", { class: "bg-white border border-slate-200 rounded p-4" },
        el("div", { class: "text-xs uppercase tracking-wider text-slate-500 mb-2" }, `Top tasks · ${weekR.label.replace(/ ·.*$/, "")}`), top(week)),
      el("div", { class: "bg-white border border-slate-200 rounded p-4" },
        el("div", { class: "text-xs uppercase tracking-wider text-slate-500 mb-2" }, `Top tasks · ${monthR.label.replace(/ ·.*$/, "")}`), top(month)),
    ),
  );
}

// Live tick for elapsed timers on the Home page
setInterval(() => {
  for (const el of document.querySelectorAll("[data-doing-since]")) {
    const since = el.getAttribute("data-doing-since");
    if (since) el.textContent = fmtElapsed(since);
  }
}, 1000);

// ---------- kick off ----------
refreshAll();
setInterval(() => {
  if (Object.keys(state.drafts).length === 0) {
    if (state.pseudo === "home" && !state.search.trim()) renderHome();
    else reloadList();
  }
}, 15000);
