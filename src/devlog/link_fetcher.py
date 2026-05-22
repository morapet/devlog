"""Fetch URL metadata (title, description, favicon) for links."""
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import httpx
from selectolax.parser import HTMLParser


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


def _parse(html: str, base_url: str) -> LinkMeta:
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
