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
| `WEB_BIND` | 127.0.0.1 | Interface passed through to the target compose. Target compose should publish `${WEB_BIND:-0.0.0.0}:${WEB_PORT:-8023}:80`; keep loopback so the internal port is never public. |
| `TARGET_HEALTH_URL` | http://127.0.0.1:INTERNAL_PORT/api/health | Polled during warm-up. |
| `IDLE_TIMEOUT_MS` | 18000000 (5 h) | Idle time before teardown. |
| `DEPLOY_TIMEOUT_MS` | 300000 | Max wait for the stack to become healthy. |
| `READY_POLL_INTERVAL_MS` | 2000 | Health poll interval. |
| `ESTIMATED_DEPLOY_SECONDS` | 90 | Countdown shown on the warming page. |
| `DEPLOY_BUILD` | false | Run `up -d --build` (needs target repo context). |
| `ADMIN_TOKEN` | (empty) | Gates `POST /_ondemand/deploy`, `/teardown`, and `/redeploy`. |
| `AUTO_REDEPLOY` | true | Poll the rebuild stamp and auto-redeploy when it changes. |
| `REBUILD_STAMP_FILE` | `<compose dir>/.rebuild-stamp` | Path to the stamp file watched for rebuilds. |
| `REBUILD_POLL_INTERVAL_MS` | 30000 | Rebuild-stamp poll interval (ms). |
| `REDEPLOY_TIMEOUT_MS` | `DEPLOY_TIMEOUT_MS` | Max wait for a redeploy to become healthy. |

## Endpoints

- `GET /*` — warming page (idle/warming/stopping/error) or reverse proxy (ready).
- `GET /_ondemand/events` — Server-Sent Events stream of state/progress.
- `GET /_ondemand/status` — JSON status.
- `POST /_ondemand/deploy` — force deploy (admin-token gated).
- `POST /_ondemand/teardown` — force teardown (admin-token gated).
- `POST /_ondemand/redeploy` — teardown then deploy (admin-token gated); streams progress via SSE and returns a status payload.

## Auto-redeploy (rebuild stamp)

When `AUTO_REDEPLOY` is true the gatekeeper watches `REBUILD_STAMP_FILE` (default
`<compose dir>/.rebuild-stamp`) and auto-redeploys whenever its mtime advances —
CI/CD `touch`es the stamp after a successful build+up, the gatekeeper polls every
`REBUILD_POLL_INTERVAL_MS` and tears down then deploys, streaming progress over SSE.
A manual trigger is always available via `POST /_ondemand/redeploy`. Migrations and
seeding remain manual CI steps; the gatekeeper never migrates or seeds.

## Manual control (URL-based)

When `ADMIN_TOKEN` is set, pass it via the `X-Admin-Token` header or the `?token=` query param.

```bash
# Check status
curl http://localhost:8023/_ondemand/status

# Force teardown (stop the full stack, return to listening mode)
curl -X POST "http://localhost:8023/_ondemand/teardown?token=<ADMIN_TOKEN>"

# Force deploy (start the full stack)
curl -X POST "http://localhost:8023/_ondemand/deploy?token=<ADMIN_TOKEN>"

# Force redeploy (teardown then deploy)
curl -X POST "http://localhost:8023/_ondemand/redeploy?token=<ADMIN_TOKEN>"
```

Examples with the default local dev token:

```bash
curl -X POST "http://localhost:8023/_ondemand/teardown?token=local-dev-token"
curl -X POST "http://localhost:8023/_ondemand/deploy?token=local-dev-token"
curl -X POST "http://localhost:8023/_ondemand/redeploy?token=local-dev-token"
```

## Windows service (local Windows only)

The gatekeeper can be installed as a Windows service so it starts automatically at boot and
runs in the background without a visible terminal window.

### Prerequisites
- Run as Administrator.
- Install dependencies: `npm install` (installs `node-windows`).

### Install (run as Administrator)
Option 1 — Batch file (recommended):
```cmd
REM Right-click -> Run as administrator
install-service.bat OnDemandGatekeeper-gazi-portfolio C:\path\to\.env
```

Option 2 — npm (requires admin PowerShell):
```powershell
$env:SERVICE_NAME = "OnDemandGatekeeper-gazi-portfolio"
$env:GATEKEEPER_ENV_FILE = "C:\path\to\.env"
npm run service:install
```

### Uninstall (run as Administrator)
Option 1 — Batch file:
```cmd
uninstall-service.bat OnDemandGatekeeper-gazi-portfolio
```

Option 2 — npm:
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

### Alternative: Scheduled Task (no admin required)

If `sc.exe`/`node-windows` installation fails (e.g. UAC not available), use a PowerShell
Scheduled Task instead. It provides the same benefits (auto-start at logon, hidden, auto-restart).

**Auto-restart on crash:** The scheduled task is configured with `RestartCount=999` and
`RestartInterval=5min`. If the gatekeeper process stops or crashes unexpectedly, the task
scheduler automatically restarts it (up to 999 times, 5 minutes apart). This provides
robust auto-recovery without a separate watchdog process.

```powershell
$gatekeeperDir = "C:\Users\ciphe\Documents\GitHub\on-demand-gatekeeper"
$nodeExe = "C:\Users\ciphe\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.14.0-win-x64\node.exe"
$envFile = "$gatekeeperDir\.env.gazi"   # or .env.ai-invoice

$action = New-ScheduledTaskAction -Execute $nodeExe -Argument "start-instance.js `"$envFile`"" -WorkingDirectory $gatekeeperDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName "OnDemandGatekeeper-gazi-portfolio" -Action $action -Trigger $trigger -Settings $settings -Principal $principal
```

Manage via Task Scheduler (`taskschd.msc`) or PowerShell:
```powershell
Start-ScheduledTask -TaskName "OnDemandGatekeeper-gazi-portfolio"
Stop-ScheduledTask -TaskName "OnDemandGatekeeper-gazi-portfolio"
```

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
