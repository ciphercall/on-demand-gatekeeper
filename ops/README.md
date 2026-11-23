# Host disk janitor (Phase 1)

The gatekeeper keeps the *lightweight* version of a webapp awake — but that only saves RAM
and CPU. It tears a stack down with `docker compose down` (no `-v`, so volumes survive) and it
**never builds** (`DEPLOY_BUILD=false`), which means the images of a sleeping stack must stay
on disk or its next cold start fails. Disk still fills from:

| Consumes disk | Reclaimed by |
|---|---|
| Dangling `<none>` images left by every CI rebuild | `docker image prune -f` |
| BuildKit build cache (builds run **on** the VPS) | `docker builder prune --keep-storage 10GB --filter until=168h` |
| Container json logs (no compose logging limits) | `daemon.json` → `max-size 10m`, `max-file 3` |
| Host access logs (`*/deploy/logs/*.log`) | `logrotate-vps-access` → daily, 14 kept, compressed |
| Stopped containers, unused networks | `docker system prune -f` (weekly) |
| Old DB dumps under `*/backups/` | weekly keep-list: newest 7 + 4 weekly per dir |

## Install

```bash
ssh root@169.58.90.13
cd /opt/github/on-demand-gatekeeper
sudo bash ops/install-janitor.sh            # idempotent
sudo bash ops/install-janitor.sh --dry-run  # show what would change
sudo bash ops/install-janitor.sh --uninstall
```

It installs the script, a systemd unit + timer, `/etc/docker/daemon.json` (log caps only; it
**never restarts Docker**), and `/etc/logrotate.d/vps-access`. It never touches a running stack.

## What runs, and when

One timer, daily 04:15 UTC (`RandomizedDelaySec=300`):

```
systemctl list-timers docker-janitor.timer
systemctl start docker-janitor.service
tail -f /var/log/docker-janitor.log
```

The pass that lands on a Sunday also runs the weekly steps (`WEEKLY_ON_DOW=0` in the unit).

## The two commands it must never run

```bash
docker image prune -a        # deletes the images of every SLEEPING stack -> cold start breaks
docker volume prune          # deletes their Postgres / media volumes -> business data gone
```

Both are refused inside `docker-janitor.sh` by `assert_safe_command()`, including any
`--volumes` flag, and the refusal is logged. The safe verbs are exactly:

```bash
docker image prune -f                                             # dangling only
docker builder prune -f --keep-storage 10GB --filter until=168h
docker system prune -f                                            # no -a, no --volumes
```

## Free-space floor

| Setting | Default | Behaviour |
|---|---|---|
| `MIN_FREE_BYTES` | 8 GiB | Below it, reclaim immediately and log `LOW_SPACE` |
| `SKIP_ABOVE_BYTES` | 35 GiB | Above it, skip the image step (nothing to gain, avoid churn) |

The build cache and log rotation always run; only the image prune is gated.

## Build-in-progress guard

`docker image prune` racing a `compose build` corrupts the build. The script skips the image
step when `pgrep` sees a docker build, or when any `/opt/github/*/.build-lock` is younger than
30 minutes.

## Access logs and the dashboard

`vps-dashboard` tails `*/deploy/logs/*.log` for visitor analytics
(`src/lib/server/ingest.ts`). Rotation uses `copytruncate`, which keeps the inode, so a stack
that happens to be asleep needs no reload. The ingester already tolerates rotation — it resets
its byte offset when `size < state.offset`. **Never truncate those files by hand**; rotate them.

Accepted trade-off of `copytruncate`: lines written in the copy→truncate window (milliseconds)
are not ingested. This is visitor analytics, not business data. The zero-loss alternative —
`create` mode plus a guarded `nginx -s reopen` — is a no-op when the stack is down, which is
why it is not the default.

## Relationship to the workspace docs

The equivalent for the **Windows dev machine** is `SERVER_COMMANDS.md` § *Docker VHDX cleanup /
reclaim* (scheduled tasks `DockerPruneDaily`, `DockerVhdxReclaim`). This page is the Linux VPS
counterpart, and the two deliberately do not share code.

## Not implemented here (Phase 4)

If Phase 1–3 stop being enough: DB dumps → Cloudflare R2 / B2, `studio-media` → R2 behind
Cloudflare with dual-read and a 30-day local cache before cutover. Specified only.
