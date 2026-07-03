"""Fetch URL metadata (title, description, favicon) for links.

Parsing prefers selectolax (fast C extension). Where C extensions can't be
built — notably iSH on iOS, which powers the run-devlog-on-the-phone setup in
clients/ios/ — a regex-based fallback covers the same fields.
"""
import html as _html
import re
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import httpx

try:
    from selectolax.parser import HTMLParser
except ImportError:
    HTMLParser = None


@dataclass
class LinkMeta:
    title: str | None = None
    description: str | None = None
    favicon_url: str | None = None


def _attr(node, name: str) -> str | None:
    if node is None:
        return None
    v = node.attributes.get(name)
    return v.strip() if v else None


def _parse_selectolax(html: str, base_url: str) -> LinkMeta:
    tree = HTMLParser(html)

    def meta(prop: str, attr: str = "property") -> str | None:
        n = tree.css_first(f'meta[{attr}="{prop}"]')
        return _attr(n, "content")

    title = (
        meta("og:title")
        or meta("twitter:title", attr="name")
        or (tree.css_first("title").text(strip=True) if tree.css_first("title") else None)
    )
    description = (
        meta("og:description")
        or meta("description", attr="name")
        or meta("twitter:description", attr="name")
    )
    favicon = None
    for sel in ('link[rel="icon"]', 'link[rel="shortcut icon"]', 'link[rel="apple-touch-icon"]'):
        n = tree.css_first(sel)
        href = _attr(n, "href")
        if href:
            favicon = urljoin(base_url, href)
            break
    if not favicon:
        parsed = urlparse(base_url)
        favicon = f"{parsed.scheme}://{parsed.netloc}/favicon.ico"

    return LinkMeta(title=title, description=description, favicon_url=favicon)


_META_TAG_RE = re.compile(r"<meta\b[^>]*>", re.I)
_LINK_TAG_RE = re.compile(r"<link\b[^>]*>", re.I)
_ATTR_RE = re.compile(r"""([a-zA-Z][\w:-]*)\s*=\s*("[^"]*"|'[^']*')""")
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)


def _tag_attrs(html: str, tag_re: re.Pattern) -> list[dict[str, str]]:
    out = []
    for m in tag_re.finditer(html):
        out.append({k.lower(): v[1:-1] for k, v in _ATTR_RE.findall(m.group(0))})
    return out


def _parse_regex(html: str, base_url: str) -> LinkMeta:
    metas = _tag_attrs(html, _META_TAG_RE)

    def meta(prop: str, attr: str = "property") -> str | None:
        for a in metas:
            if a.get(attr, "").lower() == prop:
                content = _html.unescape(a.get("content", "")).strip()
                if content:
                    return content
        return None

    title = meta("og:title") or meta("twitter:title", attr="name")
    if not title:
        m = _TITLE_RE.search(html)
        title = _html.unescape(m.group(1)).strip() if m else None
    description = (
        meta("og:description")
        or meta("description", attr="name")
        or meta("twitter:description", attr="name")
    )
    favicon = None
    for a in _tag_attrs(html, _LINK_TAG_RE):
        if a.get("rel", "").lower() in ("icon", "shortcut icon", "apple-touch-icon") and a.get("href"):
            favicon = urljoin(base_url, a["href"].strip())
            break
    if not favicon:
        parsed = urlparse(base_url)
        favicon = f"{parsed.scheme}://{parsed.netloc}/favicon.ico"

    return LinkMeta(title=title, description=description, favicon_url=favicon)


def _parse(html: str, base_url: str) -> LinkMeta:
    if HTMLParser is not None:
        return _parse_selectolax(html, base_url)
    return _parse_regex(html, base_url)


async def fetch(url: str, timeout: float = 5.0) -> LinkMeta:
    headers = {"User-Agent": "devlog/0.1 (+https://localhost)"}
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=timeout, headers=headers) as client:
            r = await client.get(url)
            r.raise_for_status()
            ctype = r.headers.get("content-type", "")
            if "html" not in ctype.lower():
                return LinkMeta()
            return _parse(r.text, str(r.url))
    except (httpx.HTTPError, ValueError):
        return LinkMeta()
