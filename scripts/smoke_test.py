"""End-to-end smoke test against a running devlog backend.

Used by .github/workflows/ci.yml and runnable locally:

    BASE=http://127.0.0.1:8765 python scripts/smoke_test.py
"""
from __future__ import annotations

import os
import sys

import httpx

BASE = os.environ.get("BASE", "http://127.0.0.1:8765")
client = httpx.Client(base_url=BASE, timeout=20.0)


def call(method: str, path: str, **kwargs):
    r = client.request(method, path, **kwargs)
    if not r.is_success:
        sys.exit(f"FAIL {method} {path} -> {r.status_code}: {r.text}")
    if r.status_code == 204 or not r.content:
        return None
    return r.json()


def expect(actual, expected, label: str):
    if actual != expected:
        sys.exit(f"FAIL {label}: expected {expected!r}, got {actual!r}")
    print(f"  ✓ {label}")


# ----------------- run -----------------

print("== health")
expect(call("GET", "/health")["ok"], True, "ok")

print("== create project")
project = call("POST", "/projects", json={"slug": "smoke", "name": "Smoke test"})
pid = project["id"]
print(f"  project id={pid}")

print("== set current")
call("POST", f"/projects/{pid}/current")

print("== create + start task")
task = call("POST", "/tasks", json={
    "project_id": pid, "title": "Smoke task", "status": "doing",
})
tid = task["id"]
print(f"  task id={tid}")

expect(call("GET", f"/items/{tid}")["status"], "doing", "task status is doing")

sessions = call("GET", f"/tasks/{tid}/sessions")
expect(len(sessions), 1, "one session created")
expect(sessions[0]["is_open"], True, "session is open")

print("== mark done")
call("POST", f"/tasks/{tid}/done")
expect(call("GET", f"/items/{tid}")["status"], "done", "task status is done")

print("== create note + link with refs")
note = call("POST", "/notes", json={
    "project_id": pid, "body": f"hello [[Smoke task]] and #{tid}",
})
nid = note["id"]
link = call("POST", "/links", json={
    "project_id": pid, "url": "https://example.com",
    "annotation": "smoke", "fetch_metadata": False,
})
lid = link["id"]
print(f"  note={nid} link={lid}")

backlinks = call("GET", f"/items/{tid}")["backlinks"]
expect(nid in backlinks, True, f"task backlinks include note {nid}")

print("== FTS search for 'smoke'")
hits = call("GET", "/search", params={"q": "smoke"})
if len(hits) < 2:
    sys.exit(f"FAIL: expected >=2 search hits, got {len(hits)}")
print(f"  ✓ {len(hits)} hits")

print("== tag search")
call("PATCH", f"/tasks/{tid}", json={"tags": ["smoke", "ci"]})
hits = call("GET", "/search", params={"q": "tag:ci"})
expect(len(hits), 1, "tag:ci returns the task")

print("== stats endpoint")
stats = call("GET", "/stats")
expect("total_seconds" in stats, True, "stats response shape")

print("== attachments roundtrip")
att = call("POST", f"/items/{tid}/attachments", json={
    "kind": "drawing", "title": "x", "data_xml": "<x/>", "data_svg": "<svg/>",
})
r = client.get(f"/attachments/{att['id']}/svg")
expect(r.status_code, 200, "svg endpoint 200")
call("DELETE", f"/attachments/{att['id']}")

print("== version history written on body change")
call("PATCH", f"/tasks/{tid}", json={"body": "edited"})
versions = call("GET", f"/items/{tid}/versions")
if not versions:
    sys.exit("FAIL: expected at least one version")
print(f"  ✓ {len(versions)} version(s)")

print("== scoped export/import remaps embedded id tokens")
# A note referencing the task by #id and embedding a drawing by attachment id.
dia = call("POST", f"/items/{tid}/attachments", json={
    "kind": "drawing", "title": "d", "data_xml": "<mxfile/>", "data_svg": "<svg/>",
})
reftext = f"round-trip #{tid} and ![[drawing:{dia['id']}]] and [[Smoke task]]"
refnote = call("POST", "/notes", json={"project_id": pid, "body": reftext})
doc = call("POST", "/export", json={"projects": ["smoke"]})
imported = call("POST", "/import", json={"mode": "merge", "data": doc})
new_slug = imported["projects"][0]
if new_slug == "smoke":
    sys.exit("FAIL: merge import should not reuse the source slug")
# Locate the imported copies (ids differ from the originals).
new_proj = next(p for p in call("GET", "/projects") if p["slug"] == new_slug)
new_items = call("GET", "/items", params={"project_id": new_proj["id"]})
new_task = next(i for i in new_items if i["title"] == "Smoke task")
new_note_id = next(i["id"] for i in new_items if (i.get("body") or "").startswith("round-trip"))
new_note = call("GET", f"/items/{new_note_id}")  # detail: populates refs_out
new_att = call("GET", f"/items/{new_task['id']}/attachments")[0]
body = new_note["body"]
expect(new_task["id"] != tid, True, "imported task got a fresh id")
expect(f"#{new_task['id']}" in body and f"#{tid}" not in body, True, "#ref remapped")
expect(f"![[drawing:{new_att['id']}]]" in body, True, "drawing embed remapped")
expect("[[Smoke task]]" in body, True, "[[title]] link preserved")
expect(new_task["id"] in new_note["refs_out"], True, "refs graph points at imported task")

print("\nAll checks passed ✓")
