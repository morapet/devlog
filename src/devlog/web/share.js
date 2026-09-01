// Standalone read-only renderer for a shared item (focus-mode view).
// Talks ONLY to /shares/<token>/data — no write calls, no other item access.

const $ = (s) => document.querySelector(s);

function token() {
  const m = location.pathname.match(/\/share\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

// --- markdown (mirrors the app's setup, minus editor-only bits) ---
let _md = null;
function md() {
  if (_md) return _md;
  const m = window.markdownit({
    html: false, linkify: true, breaks: false, typographer: true,
    highlight: (str, lang) => {
      if (lang === "mermaid") {
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
  if (window.markdownItAnchor) m.use(window.markdownItAnchor.default || window.markdownItAnchor,
    { level: 2, slugify: (s) => s.toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]/g, "") });
  _md = m;
  return m;
}

if (window.mermaid) {
  try { window.mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose" }); } catch {}
}

let _mmc = 0;
async function processMermaid(container) {
  if (!window.mermaid) return;
  for (const block of container.querySelectorAll("pre.mermaid-source")) {
    try {
      const { svg } = await window.mermaid.render(`mmd-${++_mmc}`, block.textContent);
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

// Drawing token first so it isn't partially eaten by the [[Title]] rule.
const REF_PATTERN = /!\[\[drawing:(\d+)\]\]|(?<!\w)#(\d+)\b|\[\[([^[\]\n]+?)\]\]/g;

// Replace refs in text nodes: drawings become the inline SVG; #N and [[Title]]
// become plain (non-navigable) text, since a guest can't open other items.
function resolveRefs(container, drawings) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest("code, pre, a, .mermaid-block")) return NodeFilter.FILTER_REJECT;
      return REF_PATTERN.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  for (const node of targets) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const text = node.nodeValue;
    REF_PATTERN.lastIndex = 0;
    let mm;
    while ((mm = REF_PATTERN.exec(text)) !== null) {
      if (mm.index > last) frag.append(document.createTextNode(text.slice(last, mm.index)));
      const [full, drawId, hashId, title] = mm;
      if (drawId != null) {
        const svg = drawings.get(Number(drawId));
        if (svg) {
          const box = document.createElement("div");
          box.className = "my-3 border border-slate-200 rounded bg-white overflow-auto";
          box.innerHTML = svg;
          const s = box.querySelector("svg");
          if (s) { s.style.maxWidth = "100%"; s.style.height = "auto"; }
          frag.append(box);
        } else {
          frag.append(document.createTextNode(full));
        }
      } else if (hashId != null) {
        frag.append(document.createTextNode("#" + hashId));
      } else if (title != null) {
        const span = document.createElement("span");
        span.className = "text-slate-700";
        span.textContent = title;
        frag.append(span);
      }
      last = mm.index + full.length;
    }
    if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

function fmtDate(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch { return iso; }
}

function showMessage(title, detail) {
  $("#share-root").innerHTML = "";
  const box = document.createElement("div");
  box.className = "py-20 text-center";
  box.innerHTML =
    `<div class="text-lg font-semibold text-slate-700">${title}</div>` +
    (detail ? `<div class="mt-2 text-sm text-slate-500">${detail}</div>` : "");
  $("#share-root").append(box);
}

async function main() {
  const t = token();
  if (!t) { showMessage("Invalid share link"); return; }
  let data;
  try {
    const r = await fetch(`/shares/${encodeURIComponent(t)}/data`);
    if (r.status === 410) { showMessage("This share link has expired."); return; }
    if (!r.ok) { showMessage("This share link is invalid or has been revoked."); return; }
    data = await r.json();
  } catch {
    showMessage("Could not load the shared item.", "The backend may be offline.");
    return;
  }

  const it = data.item;
  document.title = `${it.title || it.url || "Shared"} · devlog`;
  $("#share-expiry").textContent = data.shared?.expires_at
    ? `expires ${fmtDate(data.shared.expires_at)}` : "";

  const root = $("#share-root");
  root.innerHTML = "";

  // Meta line.
  const meta = document.createElement("div");
  meta.className = "flex flex-wrap items-center gap-2 text-xs text-slate-500";
  const bits = [`#${it.id}`, it.kind];
  if (data.project) bits.push(data.project);
  if (it.status) bits.push(it.status);
  meta.textContent = bits.join("  ·  ");
  root.append(meta);

  // Title / link.
  if (it.kind === "link") {
    const wrap = document.createElement("div");
    wrap.className = "mt-2";
    const a = document.createElement("a");
    a.href = it.url; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.className = "text-2xl font-semibold text-blue-700 hover:underline";
    a.textContent = (it.display_label || "").trim() || it.title || it.url;
    wrap.append(a);
    const u = document.createElement("div");
    u.className = "text-xs text-slate-500 mt-0.5 break-all";
    u.textContent = it.url || "";
    wrap.append(u);
    if (it.link_description) {
      const d = document.createElement("div");
      d.className = "text-sm text-slate-600 mt-2";
      d.textContent = it.link_description;
      wrap.append(d);
    }
    root.append(wrap);
  } else {
    const h = document.createElement("div");
    h.className = "mt-2 text-3xl font-semibold text-slate-900";
    h.textContent = it.title || "(untitled)";
    root.append(h);
  }

  // Tags.
  if (Array.isArray(it.tags) && it.tags.length) {
    const tagRow = document.createElement("div");
    tagRow.className = "mt-2 flex flex-wrap gap-1";
    for (const tag of it.tags) {
      const chip = document.createElement("span");
      chip.className = "px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 text-xs";
      chip.textContent = tag;
      tagRow.append(chip);
    }
    root.append(tagRow);
  }

  // Body.
  if (it.body) {
    const body = document.createElement("div");
    body.className = "prose-body mt-5";
    body.innerHTML = md().render(it.body);
    const drawings = new Map((data.attachments || []).map((a) => [a.id, a.svg]));
    resolveRefs(body, drawings);
    processMermaid(body);
    root.append(body);
  }
}

main();
