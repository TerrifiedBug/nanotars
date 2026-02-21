---
name: add-skill-dashboard
description: Add admin dashboard with system monitoring and task management. Triggers on "add dashboard", "dashboard setup", "admin dashboard", "dashboard skill".
---

# Add Dashboard

Adds an admin dashboard plugin to NanoClaw — a server-rendered web UI for monitoring system health, managing scheduled tasks, viewing messages, and inspecting groups. Uses htmx for live updates, Tailwind CSS for styling, and bearer token auth for security.

## Preflight

Before installing, verify NanoClaw is set up:

```bash
[ -d node_modules ] && echo "DEPS: ok" || echo "DEPS: missing"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "IMAGE: ok" || echo "IMAGE: not built"
(grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null || [ -f ~/.claude/.credentials.json ]) && echo "AUTH: ok" || echo "AUTH: missing"
```

If any check fails, tell the user to run `/nanoclaw-setup` first and stop.

## Prerequisites

- NanoClaw must be set up and running (`/nanoclaw-setup`)
- A `DASHBOARD_SECRET` token (any random string) for authentication

## Install

1. Check current state:
   ```bash
   [ -d plugins/dashboard ] && echo "PLUGIN_EXISTS" || echo "NEED_PLUGIN"
   ```
   If plugin exists, skip to Verify.

2. Generate a dashboard secret and add it to `.env`:
   ```bash
   # Generate a random 32-char hex token
   SECRET=$(openssl rand -hex 16)
   echo "DASHBOARD_SECRET=$SECRET" >> .env
   echo "Generated DASHBOARD_SECRET: $SECRET"
   ```
   Tell the user to save this token — they'll need it to access the dashboard.

3. Configure network binding.

   If `DASHBOARD_HOST` is not already in `.env`, ask the user which network interface to bind on:

   - **Localhost only (recommended)** — `DASHBOARD_HOST=127.0.0.1`. Only this machine can reach the dashboard. Use this if you access it via a VPN/tunnel (WireGuard, Tailscale) that terminates locally, or if you use a reverse proxy (nginx, Caddy).
   - **All interfaces** — `DASHBOARD_HOST=0.0.0.0`. Any device on the LAN can reach the dashboard directly.

   If the user chooses **all interfaces**, warn them:
   > **Security note:** Binding to all interfaces exposes the dashboard to your entire network. The dashboard is protected by Bearer token auth, but the token is sent in cleartext over HTTP. Recommendations:
   > - **Do not expose the port to the internet** — use a firewall rule to restrict access to your LAN/VPN only
   > - For remote access, use a VPN (WireGuard, Tailscale, Pangolin) rather than port-forwarding
   > - If you must expose it publicly, put it behind a reverse proxy with TLS (nginx, Caddy)

   Save the choice:
   ```bash
   echo "DASHBOARD_HOST=127.0.0.1" >> .env   # or 0.0.0.0
   ```

4. Optionally set a custom port (default is 3456):
   ```bash
   # Uncomment to change the port:
   # echo "DASHBOARD_PORT=3456" >> .env
   ```

5. Copy plugin files:
   ```bash
   cp -r .claude/skills/add-skill-dashboard/files/ plugins/dashboard/
   ```

6. Rebuild and restart:
   ```bash
   npm run build
   systemctl restart nanoclaw  # or launchctl on macOS
   ```

## Verify

Test the dashboard is responding:
```bash
SECRET=$(grep DASHBOARD_SECRET .env | cut -d= -f2)
HOST=$(grep DASHBOARD_HOST .env | cut -d= -f2)
PORT=$(grep DASHBOARD_PORT .env | cut -d= -f2)
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $SECRET" http://${HOST:-127.0.0.1}:${PORT:-3456}/
# Should return 200
```

Open in a browser: `http://HOST:PORT/?token=YOUR_SECRET`

The token is saved as a cookie after the first login, so subsequent visits don't need the `?token=` parameter.

## Usage

The dashboard provides:

- **Health bar** — uptime, memory, Node version, PID
- **Channels** — connection status (green/red indicators)
- **Queue** — active containers, per-group state with pending/retry badges
- **Groups** — registered groups table with detail view (CLAUDE.md, sessions, media size)
- **Tasks** — scheduled task management with pause/resume, delete, and run log viewing
- **Create Task** — form to create new scheduled tasks
- **Plugins** — installed plugins with type/scope badges
- **Templates** — available skill templates from `.claude/skills/add-skill-*`
- **Messages** — per-group recent message viewer
- **Send Message** — send a message to any registered group

All sections auto-refresh via htmx (health/queue every 5s, everything else every 10s).

## How It Works

The dashboard runs as a host process hook (onStartup/onShutdown). It starts an HTTP server on `DASHBOARD_HOST:DASHBOARD_PORT` (default `127.0.0.1:3456`) that serves server-rendered HTML with Tailwind CSS and htmx for partial updates. Authentication uses a bearer token from `DASHBOARD_SECRET`. The dashboard reads data through the PluginContext API (monitoring, tasks, messages, plugins) — it never accesses the database directly.

## Troubleshooting

- **503 "Dashboard disabled"** — `DASHBOARD_SECRET` is not set in `.env`. Add it and restart.
- **401 Unauthorized** — wrong token. Check `grep DASHBOARD_SECRET .env`.
- **Connection refused** — check the service is running and `DASHBOARD_HOST`/`DASHBOARD_PORT` match what you're connecting to.
- **Stale data** — htmx auto-refreshes but if the page seems stuck, hard-refresh the browser.

## Remove

1. ```bash
   rm -rf plugins/dashboard/
   ```
2. Remove `DASHBOARD_SECRET`, `DASHBOARD_HOST`, and `DASHBOARD_PORT` from `.env`:
   ```bash
   sed -i '/^DASHBOARD_SECRET=/d; /^DASHBOARD_HOST=/d; /^DASHBOARD_PORT=/d' .env
   ```
3. Rebuild and restart.
