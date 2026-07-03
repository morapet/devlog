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

// Show "Sign out" only when the server has password auth enabled.
fetch("/auth/status").then((r) => r.ok ? r.json() : null).then((s) => {
  if (!s || !s.auth_enabled) return;
  const btn = document.getElementById("sign-out");
  if (!btn) return;
  btn.hidden = false;
  btn.onclick = async () => {
    await fetch("/auth/logout", { method: "POST" });
    location.href = "/login";
  };
}).catch(() => {});

// ---------- mobile navigation (phones, < 768px) ----------
// The header hamburger toggles the sidebar drawer; style.css positions it
// off-canvas via body[data-sidebar-open="1"]. Any tap inside the sidebar
// (project row, Home, + New) closes the drawer — the listener sits on the
// #sidebar element itself, so it survives renderSidebar()'s replaceChildren.
function closeSidebarDrawer() { document.body.removeAttribute("data-sidebar-open"); }
(function setupMobileNav() {
  const toggle = document.getElementById("nav-toggle");
  if (toggle) toggle.addEventListener("click", () => {
    if (document.body.hasAttribute("data-sidebar-open")) closeSidebarDrawer();
    else document.body.setAttribute("data-sidebar-open", "1");
  });
  const backdrop = document.getElementById("sidebar-backdrop");
  if (backdrop) backdrop.addEventListener("click", closeSidebarDrawer);
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.addEventListener("click", (e) => {
    if (e.target.closest("button")) closeSidebarDrawer();
  });
})();

// Mirror "an item is selected" onto <body> so style.css can swap the list
// pane for the detail pane on phones (body[data-mobile-detail="1"]).
function _applyMobileDetailAttr() {
  if (state.selected) document.body.setAttribute("data-mobile-detail", "1");
  else document.body.removeAttribute("data-mobile-detail");
}

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
  if (r.status === 401) { location.href = "/login"; throw new Error("401 not authenticated"); }
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  if (r.status === 204) return null;
  return r.json();
};
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
  // List view controls
  sortBy: "status",       // 'status' | 'priority' | 'updated' | 'created' | 'title' | 'time_spent' | 'due'
  groupBy: "none",        // 'none' | 'status' | 'priority' | 'tag'
  listFilter: "",         // in-list substring filter
  items: [],
  taskTotals: {},
  selectedId: null,
  selected: null,
  drafts: {},             // id -> dirty edits
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

// Restore saved list-pane width and wire up the drag-resizer.
(function setupSplitter() {
  const pane = $("#list-pane");
  const splitter = $("#splitter");
  if (!pane || !splitter) return;
  const stored = Number(localStorage.getItem("listPaneWidth") || 0);
  if (stored >= 200 && stored <= 800) pane.style.width = stored + "px";

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
    const w = Math.max(180, Math.min(900, startW + (e.clientX - startX)));
    pane.style.width = w + "px";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem("listPaneWidth", String(parseInt(pane.style.width, 10)));
  });
  // Double-click resets to default
  splitter.addEventListener("dblclick", () => {
    pane.style.width = "320px";
    localStorage.setItem("listPaneWidth", "320");
  });
})();

async function dispatchView() {
  if (state.pseudo === "home" && !state.search.trim()) {
    showHomeOnly(true);
    await renderHome();
  } else {
    showHomeOnly(false);
    renderTabs();
    renderFilters();
    await reloadList();
  }
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
  _applyMobileDetailAttr();
  // mark selected
  for (const row of document.querySelectorAll(".list-row")) {
    if (row.textContent.includes("#" + id)) row.classList.add("selected");
  }
  renderDetail();
}

function renderDetail() {
  const d = $("#detail");
  d.replaceChildren();
  const it = state.selected;
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
      el("button", {
        class: "ml-3 px-2 py-0.5 rounded border " +
          (state.focusMode
            ? "border-amber-300 bg-amber-100 text-amber-800"
            : "border-slate-300 text-slate-600 hover:bg-slate-100"),
        title: state.focusMode ? "Exit focus mode" : "Focus mode — read-only, hides editor",
        onclick: toggleFocusMode,
      }, state.focusMode ? "✏ Edit" : "👁 Focus"),
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

  // ── Focus mode: render preview only, full width ──
  if (state.focusMode) {
    const ro = el("div", {
      // Wide reading column: a generous max keeps long lines comfortable, but
      // the preview gets the full window width minus the side padding now
      // that the sidebar / list pane are hidden by body[data-focus] CSS.
      class: "prose-body bg-white overflow-auto min-h-[300px] max-w-[110ch] mx-auto px-6 py-6",
      id: "md-preview",
    });
    renderMarkdownInto(ro, bodyVal);
    ro.addEventListener("click", async (e) => {
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
    // Hydrate any #N title decorations.
    const ids = extractIdRefs(bodyVal);
    if (ids.length) {
      ensureTitlesFor(ids).then((changed) => {
        if (changed && document.body.contains(ro)) renderMarkdownInto(ro, bodyVal);
      });
    }
    outer.append(ro);
    return outer;
  }

  const wrap = el("div", { class: "grid grid-cols-1 md:grid-cols-2 gap-4 min-h-[300px]" });

  const ta = el("textarea", {
    class: "w-full h-full min-h-[300px] font-mono text-sm border border-slate-200 rounded p-3 focus:outline-none focus:ring-2 focus:ring-blue-100",
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

  const preview = el("div", { class: "prose-body border border-slate-100 rounded p-3 bg-slate-50 overflow-auto", id: "md-preview" });
  renderMarkdownInto(preview, bodyVal);

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

  wrap.append(ta, preview);
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
      `<div class="admonition ${md.utils.escapeHtml(type)}" style="${boxStyle}">\n` +
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

  wrap.append(renderHistoryButton(it));
  wrap.append(el("div", { class: "ml-auto" }));
  wrap.append(el("button", {
    class: "px-3 py-1.5 text-sm text-red-600 hover:underline",
    onclick: () => deleteItem(it),
  }, "Delete"));
  return wrap;
}

// ---------- history ----------
function renderHistoryButton(it) {
  const btn = el("button", {
    class: "px-2 py-1 text-xs rounded border border-slate-300 hover:bg-white text-slate-700",
    onclick: () => openHistory(it, btn),
  }, "History ▾");
  return btn;
}

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
  if (typeof _applyMobileDetailAttr === "function") _applyMobileDetailAttr();
}

// (Header search and global "+ New" buttons removed — search lives inside Home, "+ New" lives in the sidebar.)

function openNewItemModal() {
  const TABS = ["task", "note", "link"];
  let tab = "task";
  let projectId = state.scopeProjectId ?? state.currentProjectId ?? state.projects[0]?.id ?? null;

  const overlay = $("#modal-overlay");
  const m = $("#modal");

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
    const body = el("textarea", { class: "mt-2 w-full font-mono text-sm border border-slate-300 rounded p-2 min-h-[100px]", placeholder: "Body…" });
    m.append(
      title,
      el("div", { class: "mt-2 flex gap-3" }, label("Status", status), label("Priority", priority)),
      body,
      el("div", { class: "mt-3 flex justify-end gap-2" },
        el("button", { class: "px-3 py-1.5 text-sm text-slate-600 hover:underline", onclick: () => overlay.classList.add("hidden") }, "Cancel"),
        el("button", { class: "px-3 py-1.5 text-sm bg-slate-900 text-white rounded hover:bg-slate-700", onclick: async () => {
          try {
            const payload = { project_id: projectId, title: title.value, status: status.value, priority: priority.value, body: body.value || null };
            await api("/tasks", { method: "POST", body: JSON.stringify(payload) });
            overlay.classList.add("hidden");
            reloadList();
            toast("Created");
          } catch (e) { toast(e.message); }
        } }, "Create"))
    );
    setTimeout(() => title.focus(), 0);
  };

  const renderNoteForm = () => {
    const t = el("input", { type: "text", class: "mt-2 w-full border border-slate-300 rounded px-2 py-1.5 text-sm", placeholder: "Title (optional)" });
    const body = el("textarea", { class: "mt-2 w-full font-mono text-sm border border-slate-300 rounded p-2 min-h-[200px]", placeholder: "Body (markdown)…" });
    m.append(t, body,
      el("div", { class: "mt-3 flex justify-end gap-2" },
        el("button", { class: "px-3 py-1.5 text-sm text-slate-600 hover:underline", onclick: () => overlay.classList.add("hidden") }, "Cancel"),
        el("button", { class: "px-3 py-1.5 text-sm bg-slate-900 text-white rounded hover:bg-slate-700", onclick: async () => {
          try {
            await api("/notes", { method: "POST", body: JSON.stringify({ project_id: projectId, title: t.value || null, body: body.value }) });
            overlay.classList.add("hidden"); reloadList(); toast("Created");
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
            overlay.classList.add("hidden"); reloadList(); toast("Created");
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
$("#modal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-overlay") $("#modal-overlay").classList.add("hidden");
});

// ESC closes any open modal (capture, project, history, drawing preview).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
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

// Selected stats periods (sticky within session)
const statsSel = { week: null, month: null }; // each: {range_from, range_to, label} | null=current

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
