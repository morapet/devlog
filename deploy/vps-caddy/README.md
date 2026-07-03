# devlog on a VPS with HTTPS + password

Any small VPS works (Hetzner CX22, DigitalOcean, Oracle's always-free ARM —
the image is multi-arch). You need a domain (or subdomain) with an A/AAAA
record pointing at the VPS.

## Setup

```bash
# on the VPS, with docker + compose installed
mkdir devlog && cd devlog
curl -sLO https://raw.githubusercontent.com/morapet/devlog/main/deploy/vps-caddy/docker-compose.yml
curl -sLO https://raw.githubusercontent.com/morapet/devlog/main/deploy/vps-caddy/Caddyfile

cat > .env <<EOF
DEVLOG_DOMAIN=devlog.example.com
DEVLOG_PASSWORD=$(openssl rand -base64 24)
EOF
cat .env    # note the generated password — you'll type it on the phone once

docker compose up -d
```

Caddy obtains and renews the TLS certificate automatically. Open
`https://devlog.example.com`, sign in, then on the iPhone: Share →
**Add to Home Screen**. The session cookie lasts 90 days.

- Data: `./data/devlog.db` (SQLite) — back it up with a simple file copy.
- Update: `docker compose pull && docker compose up -d`.
- MCP against the hosted instance:
  `DEVLOG_BASE_URL=https://devlog.example.com DEVLOG_PASSWORD=... devlog-mcp`.
- Firewall: only 80/443 need to be open; devlog itself is not exposed.
