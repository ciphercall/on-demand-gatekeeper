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
   port only while it is up.

## 2. Port separation (no target changes)

The gatekeeper overrides `WEB_PORT` via process environment when it invokes `docker compose`.
Docker Compose substitutes `${WEB_PORT}` from the shell environment first, falling back to the
target's `.env`. Therefore:

- The target's `.env` keeps `WEB_PORT=8023` (untouched).
- While up, the full stack's web container binds `INTERNAL_PORT` (8024) on the host.
- The gatekeeper proxies `http://127.0.0.1:INTERNAL_PORT`.
- No source or config file in the target project is modified.

## 3. Configure the gatekeeper

Copy `on-demand-gatekeeper/.env.example` to `.env` and set:

```
PUBLIC_PORT=8023
TARGET_NAME=my-webapp
TARGET_COMPOSE_FILE=/abs/path/to/my-webapp/deploy/docker-compose.yml
TARGET_ENV_FILE=/abs/path/to/my-webapp/deploy/.env
INTERNAL_PORT=8024
TARGET_HEALTH_URL=http://127.0.0.1:8024/api/health
IDLE_TIMEOUT_MS=18000000
ADMIN_TOKEN=<random secret>
```

## 4. First build (once)

```bash
docker compose -f <target>/deploy/docker-compose.yml --env-file <target>/deploy/.env build
```

## 5. Switch to on-demand

1. Stop the full stack: `docker compose ... down` (or the target's own deploy script `down`).
2. Start the gatekeeper (host mode or container mode).
3. Visit `http://localhost:PUBLIC_PORT` — you should see the countdown page, then auto-redirect.

## 6. Manual end-to-end test

1. Visit the public URL → warming page appears with countdown.
2. Wait for boot → page auto-redirects to the real app.
3. Browse several routes (home, admin, health, media) → all proxied.
4. Set `IDLE_TIMEOUT_MS=60000` temporarily, wait 1 minute with no requests → full stack tears
   down; visiting again shows the warming page.
5. Stop the gatekeeper (Ctrl+C) → everything is off.

## 7. VPS notes

- Run the gatekeeper as the 24/7 component; remove or disable the always-on full stack.
- Bind `PUBLIC_PORT` to localhost and front it with nginx / Cloudflare Tunnel for HTTPS.
- Mount the host docker socket only if you trust the host (container mode). Otherwise run the
  gatekeeper in host mode under systemd / pm2.
- Keep the target's deploy script for one-time builds and migrations; the gatekeeper only
  starts/stops, it does not migrate. Run migrations manually after image updates.

## 7. Manual control (URL-based)

When `ADMIN_TOKEN` is set, the admin endpoints require the token via the `X-Admin-Token`
header or the `?token=` query param.

```bash
# Check status (no token needed)
curl http://<host>:<port>/_ondemand/status

# Force teardown (stop the full stack, return to listening mode)
curl -X POST "http://<host>:<port>/_ondemand/teardown?token=<ADMIN_TOKEN>"

# Force deploy (start the full stack)
curl -X POST "http://<host>:<port>/_ondemand/deploy?token=<ADMIN_TOKEN>"
```

## 8. Troubleshooting

- **Warming page never resolves**: check `TARGET_HEALTH_URL` returns 200 manually; verify the
  full stack bound `INTERNAL_PORT` (not `PUBLIC_PORT`) — look for port conflicts in
  `docker ps`.
- **Port already in use on PUBLIC_PORT**: the full stack is still running; tear it down first.
- **Build attempted on first request**: set `DEPLOY_BUILD=false` and pre-build images.
- **Teardown did not remove containers**: ensure `docker compose ... down` works manually with
  the same env override (`WEB_PORT=INTERNAL_PORT`).
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
