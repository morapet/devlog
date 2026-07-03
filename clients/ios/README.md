# devlog entirely on the iPhone (iSH)

Run the backend *on the phone itself* — no computer, no server, no network.
[iSH](https://ish.app) (free, App Store) emulates an x86 Alpine Linux
userland on iOS; devlog's backend is small enough to run inside it, and
Safari talks to it over loopback. `http://localhost` is a secure context,
so the PWA install and the offline shell both work.

## Install

In iSH:

```sh
apk update
apk add git python3 py3-fastapi py3-uvicorn py3-httpx py3-pydantic tzdata
git clone --depth 1 https://github.com/morapet/devlog.git
```

Everything comes from Alpine's package repo as prebuilt binaries — nothing
is compiled on the phone. (`selectolax` and `mcp` are skipped: link-title
fetching falls back to a built-in parser, and the MCP server isn't useful
on-device.)

> If `apk add python3` gives you Python < 3.12, your iSH filesystem is an
> older Alpine. Upgrade it first:
> `sed -i 's/v3\.[0-9]*/v3.21/g' /etc/apk/repositories && apk update && apk upgrade`

## Run

```sh
sh devlog/clients/ios/run.sh
```

Then in Safari open **http://localhost:8765** → Share → **Add to Home
Screen**. The first start takes a little while (iSH emulates x86); after
that it's comfortable for a single user.

## The fine print

- **iOS suspends background apps.** The server only runs while iSH is
  alive. In iSH's settings enable the location-based "stay running in
  background" option, or just reopen iSH before using devlog — the server
  is up again in a few seconds (`sh devlog/clients/ios/run.sh` again after
  a reboot).
- **Data** lives in `~/.local/share/devlog/devlog.db` inside iSH. Back it
  up by copying it out via the Files app (iSH exposes its filesystem) or
  `tar` it somewhere periodically.
- **Drawings (drawio)** are not installed — the vendored webapp is ~120 MB
  and heavy under emulation. Everything else works.
- **Upgrade**: `cd devlog && git pull`.
