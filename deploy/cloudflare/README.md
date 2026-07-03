# devlog via Cloudflare Tunnel (+ optional Access login)

Free, no open ports, works on any always-on machine at home (PC, Raspberry
Pi, NAS) or a VPS. Requires a domain managed by Cloudflare.

## 1. Create the tunnel

In the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com):
**Networks → Tunnels → Create a tunnel** (Cloudflared connector). Copy the
tunnel token. Add a **Public Hostname**: `devlog.yourdomain.com` →
`http://devlog:8765`.

## 2. Run

```bash
mkdir devlog && cd devlog
curl -sLO https://raw.githubusercontent.com/morapet/devlog/main/deploy/cloudflare/docker-compose.yml

cat > .env <<EOF
TUNNEL_TOKEN=<token from step 1>
DEVLOG_PASSWORD=$(openssl rand -base64 24)
EOF

docker compose up -d
```

`https://devlog.yourdomain.com` now works from anywhere, iPhone included
(Safari → Share → Add to Home Screen).

## 3. Optional: Cloudflare Access in front

Zero Trust → **Access → Applications → Add an application** (Self-hosted),
hostname `devlog.yourdomain.com`, and a policy allowing your email (one-time
PIN) or your Google account. Set the session duration to something long
(e.g. 1 month) so the home-screen app doesn't re-prompt often.

With Access in place the login happens at Cloudflare's edge before traffic
reaches your machine; `DEVLOG_PASSWORD` remains as a second layer (or can be
left unset if you trust Access alone).
