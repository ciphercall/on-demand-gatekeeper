# Integrating the On-Demand Gatekeeper into a new webapp

This guide lets any Docker-based webapp adopt on-demand (sideload) hosting without changing its
application code. The gatekeeper is the only always-on component; the full app sleeps when idle.

## 1. Prerequisites for the target webapp

1. **A compose file** (e.g. `deploy/docker-compose.yml`) defining the stack.
2. **A health endpoint** returning HTTP 200 only when the app and its database are ready
   (e.g. `/api/health`, `/healthz`). The gatekeeper polls this during warm-up.
3. **Pre-built images**: run the target's own build once (`docker compose ... build`), or set
   `DEPLOY_BUILD=true` (requires the target repo context to be reachable at runtime).
4. **A distinct internal port**: choose an `INTERNAL_PORT` (e.g. `8024`) that differs from the
   public port (`8023`). The gatekeeper binds the public port; the full stack binds the internal
   port only while it is up. Publish it through variables so the bind address is parametrised
   (see section 3):

   ```yaml
   ports:
     - "${WEB_BIND:-0.0.0.0}:${WEB_PORT:-8023}:80"
   ```

## 2. Port separation (no target changes)

The gatekeeper overrides `WEB_PORT` via process environment when it invokes `docker compose`.
Docker Compose substitutes `${WEB_PORT}` from the shell environment first, falling back to the
target's `.env`. Therefore:

- The target's `.env` keeps `WEB_PORT=8023` (untouched).
- While up, the full stack's web container binds `INTERNAL_PORT` (8024) on the host.
- The gatekeeper proxies `http://127.0.0.1:INTERNAL_PORT`.
- No source or config file in the target project is modified.

The same environment pass-through carries `WEB_BIND`, which controls the bind *address* rather
than the port — see section 3 for keeping the full stack off the public interface.

## 3. Binding the internal port to localhost

The full stack has to publish its web port on the host so the gatekeeper can proxy to it, but that
port must never be reachable from outside. Publish it through two variables so the bind address is
parametrised in the target compose:

```yaml
services:
  web:
    ports:
      - "${WEB_BIND:-0.0.0.0}:${WEB_PORT:-8023}:80"
```

- `WEB_PORT` is the one the gatekeeper already overrides with `INTERNAL_PORT`.
- `WEB_BIND` defaults to `0.0.0.0`, so the target still works standalone (`docker compose up`).
- The gatekeeper inherits `WEB_BIND` from its own process environment and passes its whole
  environment to `docker compose` (it already injects `WEB_PORT`/`FRONTEND_PORT` from
  `INTERNAL_PORT`), so a single `WEB_BIND=127.0.0.1` in the gatekeeper env is enough. The target's
  `.env` stays untouched, and the gatekeeper env wins over `--env-file` anyway.

If the target hardcodes its mapping (e.g. `"8023:80"`), adding these two variables is the only
change needed — the `0.0.0.0` default keeps standalone behaviour identical, so section 2's "no
target changes" still holds in spirit.

Recommended in the gatekeeper env:

```
PUBLIC_PORT=8023
INTERNAL_PORT=8024
WEB_BIND=127.0.0.1
```

With that, the gatekeeper owns `0.0.0.0:PUBLIC_PORT` and the full stack binds
`127.0.0.1:INTERNAL_PORT` only. Verify with `ss -tlnp | grep -E '8023|8024'` or
`docker ps --format '{{.Names}} {{.Status}} {{.Ports}}'`.

**Do not use a second compose file for this.** A file that only adds a `ports` list (passed via
`TARGET_COMPOSE_OVERRIDE_FILE`) does not replace the original list, because Compose *appends* port
lists across files. The container then gets two host bindings for the same container port: the
second bind fails and the web container is left with no network — it restarts with
`host not found in upstream "app:3000"`.

## 4. Configure the gatekeeper

Copy `on-demand-gatekeeper/.env.example` to `.env` and set:

```
PUBLIC_PORT=8023
TARGET_NAME=my-webapp
TARGET_COMPOSE_FILE=/abs/path/to/my-webapp/deploy/docker-compose.yml
TARGET_ENV_FILE=/abs/path/to/my-webapp/deploy/.env
INTERNAL_PORT=8024
TARGET_HEALTH_URL=http://127.0.0.1:8024/api/health
IDLE_TIMEOUT_MS=18000000
DEPLOY_TIMEOUT_MS=300000
READY_POLL_INTERVAL_MS=2000
ESTIMATED_DEPLOY_SECONDS=90
DEPLOY_BUILD=false
WEB_BIND=127.0.0.1
ADMIN_TOKEN=<random secret>
AUTO_REDEPLOY=true
REBUILD_STAMP_FILE=/abs/path/to/target/.rebuild-stamp
REBUILD_POLL_INTERVAL_MS=30000
REDEPLOY_TIMEOUT_MS=300000
```

## 5. First build (once)

```bash
docker compose -f <target>/deploy/docker-compose.yml --env-file <target>/deploy/.env build
```

## 6. Switch to on-demand

1. Stop the full stack: `docker compose ... down` (or the target's own deploy script `down`).
2. Start the gatekeeper (host mode or container mode).
3. Visit `http://localhost:PUBLIC_PORT` — you should see the countdown page, then auto-redirect.

## 7. Manual end-to-end test

1. Visit the public URL → warming page appears with countdown.
2. Wait for boot → page auto-redirects to the real app.
3. Browse several routes (home, admin, health, media) → all proxied.
4. Set `IDLE_TIMEOUT_MS=60000` temporarily, wait 1 minute with no requests → full stack tears
   down; visiting again shows the warming page.
5. Stop the gatekeeper (Ctrl+C) → everything is off.

## 8. VPS notes

- Run the gatekeeper as the 24/7 component; remove or disable the always-on full stack.
- Bind `PUBLIC_PORT` to localhost and front it with nginx / Cloudflare Tunnel for HTTPS.
- Allow the public port in the firewall (`ufw allow <PUBLIC_PORT>/tcp`) and never open
  `INTERNAL_PORT`. Docker bridge publishing can bypass UFW, so the `WEB_BIND=127.0.0.1` loopback
  bind from section 3 — not the firewall — is what keeps the internal port private.
- Mount the host docker socket only if you trust the host (container mode). Otherwise run the
  gatekeeper in host mode under systemd / pm2.
- Keep the target's deploy script for one-time builds and migrations; the gatekeeper only
  starts/stops, it does not migrate. Run migrations manually after image updates, plus any seed the
  target needs — the gatekeeper never seeds.
- A deploy script's own health check usually targets the public port; while the gatekeeper owns it
  and the stack is idle, that check can hit the warming page. Verify through `/_ondemand/status`
  and `docker compose ps` instead of trusting the script's exit code.
- Auto-redeploy: CI/CD builds and ups the target, then `touch`es the rebuild stamp
  (`REBUILD_STAMP_FILE`); the gatekeeper polls it (`REBUILD_POLL_INTERVAL_MS`) and auto-runs
  `POST /_ondemand/redeploy` (teardown then deploy), streaming progress over SSE. A manual
  trigger is always available via `POST /_ondemand/redeploy`. Migrations and seeding stay
  manual CI steps — the gatekeeper never migrates or seeds.

## 9. Manual control (URL-based)

When `ADMIN_TOKEN` is set, the admin endpoints require the token via the `X-Admin-Token`
header or the `?token=` query param.

```bash
# Check status (no token needed)
curl http://<host>:<port>/_ondemand/status

# Force teardown (stop the full stack, return to listening mode)
curl -X POST "http://<host>:<port>/_ondemand/teardown?token=<ADMIN_TOKEN>"

# Force deploy (start the full stack)
curl -X POST "http://<host>:<port>/_ondemand/deploy?token=<ADMIN_TOKEN>"

# Force redeploy (teardown then deploy)
curl -X POST "http://<host>:<port>/_ondemand/redeploy?token=<ADMIN_TOKEN>"
```

## 10. Troubleshooting

- **Warming page never resolves**: check `TARGET_HEALTH_URL` returns 200 manually; verify the
  full stack bound `INTERNAL_PORT` (not `PUBLIC_PORT`) — look for port conflicts in
  `docker ps`.
- **Port already in use on PUBLIC_PORT**: the full stack is still running; tear it down first.
- **Internal port exposed on all interfaces**: the target compose hardcodes `0.0.0.0` or omits
  `WEB_BIND`; publish via `${WEB_BIND:-0.0.0.0}:${WEB_PORT:-8023}:80` and set `WEB_BIND=127.0.0.1`
  in the gatekeeper env (section 3).
- **Web container restarting with `host not found in upstream "app:3000"`**: the container never
  started — a port bind conflict — so it has no network. Remove it and re-run a single compose
  invocation.
- **`failed to bind host port 127.0.0.1:8026: address already in use`**: a duplicate `ports` entry
  (typically a leftover override file, see section 3) or a concurrent compose run. Remove the
  container, make sure the override file is gone, then re-run compose once.
- **Build attempted on first request**: set `DEPLOY_BUILD=false` and pre-build images.
- **Teardown did not remove containers**: ensure `docker compose ... down` works manually with
  the same env override (`WEB_PORT=INTERNAL_PORT`, plus `WEB_BIND` if the compose file reads it).
- **Container mode on Windows fails with "not a directory" / bind-mount errors**: Windows (Docker
  Desktop) cannot resolve the compose file's relative bind-mount paths from inside the container.
  Use **host mode** (`node src/server.js`) on Windows instead. Container mode is Linux-only.
- **Container mode health checks / proxy fail ("connection refused" to 127.0.0.1)**: the
  container's localhost is isolated. Use `network_mode: host` (Linux) so the gatekeeper shares
  the host network namespace.
- **`docker: unknown shorthand flag: 'f'` inside the container**: the image is missing the compose
  plugin. Rebuild with `docker-cli-compose` installed (see Dockerfile).
- **External browser times out but `curl` on the VPS works**: a default-deny firewall (UFW) is
  blocking the public port. Run `ufw allow <PUBLIC_PORT>/tcp`. Docker bridge-mode port publishing
  bypasses UFW but host-network mode does not.
- **Media / large uploads fail**: the gatekeeper pipes streams; check nginx timeouts on the VPS
  reverse proxy.
