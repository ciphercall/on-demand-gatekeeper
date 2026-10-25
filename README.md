# On-Demand Gatekeeper

The only always-on component for an on-demand webapp. It listens on `PUBLIC_PORT` and:

1. On the first visitor request, boots the target webapp's **existing** Docker stack in the background.
2. Renders a self-contained countdown / progress page while it boots.
3. Reverse-proxies to the real app once its health check passes (auto-redirect).
4. Tears the full stack down again after `IDLE_TIMEOUT_MS` (default 5 h) with no requests.
5. Exposes a manual off switch (Ctrl+C / admin endpoints).

It is **config-driven** (`env` only) and **never modifies the target project**: it only reads the
target's compose file + `.env` and drives `docker compose` against the host daemon.

## Quick start (host mode — easiest for local dev)

```powershell
cd on-demand-gatekeeper
copy .env.example .env
# edit .env: set TARGET_COMPOSE_FILE / TARGET_ENV_FILE to the target's absolute paths
node --check src/server.js
npm test
node src/server.js
```

Then visit `http://localhost:<PUBLIC_PORT>`.

## Quick start (container mode — Linux / VPS only)

```bash
docker compose -f docker-compose.example.yml up -d --build
```

See the example compose file for the required volume mounts (host docker socket + target dir at
the **same absolute path** as on the host).

**Important notes discovered during real deployment:**

- **Linux only.** Container mode relies on `network_mode: host` so the gatekeeper can reach the
  target's internal port via `127.0.0.1`. On Docker Desktop (Windows/macOS) the container's
  network namespace is isolated and bind-mount paths don't translate, so use **host mode** there.
- **Host networking is required.** With bridge networking the container's `127.0.0.1` is not the
  host, so health checks and proxying to the internal port fail. Use `network_mode: host`.
- **Compose plugin.** The image installs `docker-cli-compose` (not just `docker-cli`) because
  Alpine's `docker-cli` package does not include the `compose` subcommand.
- **UFW / firewall.** On a VPS with a default-deny firewall (e.g. UFW), allow the public port
  before testing externally: `ufw allow 8023/tcp`. Docker bridge-mode port publishing bypasses
  UFW, but host-network mode does not.

## Configuration

See `.env.example`. Key values:

| Key | Default | Meaning |
|---|---|---|
| `PUBLIC_PORT` | 8023 | Port the gatekeeper binds (what clients visit). |
| `TARGET_NAME` | target-app | Label used in logs / status JSON. |
| `TARGET_COMPOSE_FILE` | /target/docker-compose.yml | Absolute path to target compose file (read-only). |
| `TARGET_ENV_FILE` | /target/.env | Absolute path to target .env (read-only). |
| `INTERNAL_PORT` | 8024 | Host port the full stack binds while up. Must differ from `PUBLIC_PORT`. |
| `TARGET_HEALTH_URL` | http://127.0.0.1:INTERNAL_PORT/api/health | Polled during warm-up. |
| `IDLE_TIMEOUT_MS` | 18000000 (5 h) | Idle time before teardown. |
| `DEPLOY_TIMEOUT_MS` | 300000 | Max wait for the stack to become healthy. |
| `READY_POLL_INTERVAL_MS` | 2000 | Health poll interval. |
| `ESTIMATED_DEPLOY_SECONDS` | 90 | Countdown shown on the warming page. |
| `DEPLOY_BUILD` | false | Run `up -d --build` (needs target repo context). |
| `ADMIN_TOKEN` | (empty) | Gates `POST /_ondemand/deploy` and `/teardown`. |

## Endpoints

- `GET /*` — warming page (idle/warming/stopping/error) or reverse proxy (ready).
- `GET /_ondemand/events` — Server-Sent Events stream of state/progress.
- `GET /_ondemand/status` — JSON status.
- `POST /_ondemand/deploy` — force deploy (admin-token gated).
- `POST /_ondemand/teardown` — force teardown (admin-token gated).

## Manual control (URL-based)

When `ADMIN_TOKEN` is set, pass it via the `X-Admin-Token` header or the `?token=` query param.

```bash
# Check status
curl http://localhost:8023/_ondemand/status

# Force teardown (stop the full stack, return to listening mode)
curl -X POST "http://localhost:8023/_ondemand/teardown?token=<ADMIN_TOKEN>"

# Force deploy (start the full stack)
curl -X POST "http://localhost:8023/_ondemand/deploy?token=<ADMIN_TOKEN>"
```

Examples with the default local dev token:

```bash
curl -X POST "http://localhost:8023/_ondemand/teardown?token=local-dev-token"
curl -X POST "http://localhost:8023/_ondemand/deploy?token=local-dev-token"
```

## Windows service (local Windows only)

The gatekeeper can be installed as a Windows service so it starts automatically at boot and
runs in the background without a visible terminal window.

### Prerequisites
- Run as Administrator.
- Install dependencies: `npm install` (installs `node-windows`).

### Install
```powershell
cd on-demand-gatekeeper
$env:SERVICE_NAME = "OnDemandGatekeeper-gazi-portfolio"
$env:GATEKEEPER_ENV_FILE = "C:\path\to\.env"
npm run service:install
```

### Uninstall
```powershell
$env:SERVICE_NAME = "OnDemandGatekeeper-gazi-portfolio"
npm run service:uninstall
```

### Multiple instances
Each project gets its own service with a unique name, port, and env file:
```powershell
# Instance 1: gazi-portfolio (port 8023)
$env:SERVICE_NAME = "OnDemandGatekeeper-gazi-portfolio"
$env:GATEKEEPER_ENV_FILE = "C:\path\to\gazi.env"
npm run service:install

# Instance 2: ai-invoice-po-matching (port 5174)
$env:SERVICE_NAME = "OnDemandGatekeeper-ai-invoice"
$env:GATEKEEPER_ENV_FILE = "C:\path\to\ai-invoice.env"
npm run service:install
```

### Service management
```powershell
# Start/stop/restart via sc.exe or Services.msc
sc start OnDemandGatekeeper-gazi-portfolio
sc stop OnDemandGatekeeper-gazi-portfolio
sc query OnDemandGatekeeper-gazi-portfolio
```

### Notes
- The service runs in host mode (node process) — container mode is not viable on Windows.
- The service reads env vars from the `GATEKEEPER_ENV_FILE` .env file.
- Logs are written to the Windows Event Log (via node-windows).

## Security notes

- Container mode mounts `/var/run/docker.sock`, which grants container root-equivalent host
  access. Run the gatekeeper only on a trusted host, and prefer binding `PUBLIC_PORT` to
  localhost behind a reverse proxy (nginx / Cloudflare Tunnel) on the VPS.
- Set `ADMIN_TOKEN` on any non-local deployment.
- The gatekeeper never writes to the target project; it only reads its compose file + `.env`.

## Requirements for a target webapp

1. A `docker-compose.yml` defining the stack.
2. A health endpoint returning HTTP 200 when the app + database are ready.
3. Pre-built images (run the target's own build once), or `DEPLOY_BUILD=true` with the target
   repo context reachable.
4. An internal port (`INTERNAL_PORT`) distinct from the public port, so the gatekeeper and the
   full stack never bind the same host port. The gatekeeper achieves this by overriding
   `WEB_PORT` via process env when invoking compose; the target's own `.env` is untouched.

See `docs/INTEGRATION.md` for a step-by-step adoption guide.
