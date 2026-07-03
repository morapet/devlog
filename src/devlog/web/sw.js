// Devlog service worker. Lets the web UI install as a PWA in Chrome / Edge /
// Safari (iOS 16.4+) and survive offline access to the app shell. The backend
// API is always fetched live — caching it would silently serve stale data.

const VERSION = "devlog-shell-v5";

// The app shell — everything required to bootstrap the UI even offline.
// Versioned via VERSION so a new deploy invalidates the previous cache.
const SHELL = [
    "/",
    "/static/app.js",
    "/static/style.css",
    "/static/manifest.json",
    "/static/icon.svg",
    "/static/icon-maskable.svg",
    "/static/icon-192.png",
    "/static/icon-512.png",
    "/static/apple-touch-icon.png",
];

// Path prefixes that must always go to network (never cached). All of these
// produce dynamic data; serving a stale response would be a bug, not a feature.
const API_PREFIXES = [
    "/auth",
    "/login",
    "/health",
    "/projects",
    "/items",
    "/tasks",
    "/notes",
    "/links",
    "/search",
    "/stats",
    "/sessions",
    "/attachments",
    "/settings",
    "/openapi.json",
    "/docs",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(VERSION).then((cache) => cache.addAll(SHELL))
    );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;

    const url = new URL(req.url);

    // Cross-origin: pass through (Tailwind / markdown-it / mermaid / etc. on CDNs).
    if (url.origin !== self.location.origin) return;

    // Live API: network-only, no fallback. We do NOT want stale stats / items.
    if (API_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p + "/"))) {
        return;
    }

    // Shell + /static/*: cache first, network second (and refresh the cache).
    event.respondWith(
        caches.match(req).then((cached) => {
            const fetched = fetch(req).then((resp) => {
                // Never cache redirected responses — a login redirect must not
                // shadow the app shell.
                if (resp && resp.ok && resp.type === "basic" && !resp.redirected) {
                    const copy = resp.clone();
                    caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
                }
                return resp;
            }).catch(() => cached);
            return cached || fetched;
        })
    );
});

// Allow the page to nudge an update through immediately.
self.addEventListener("message", (e) => {
    if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});
