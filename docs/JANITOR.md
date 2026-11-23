# Janitor — keeping the VPS disk at a practical minimum

This is the full behaviour reference for the host disk janitor. The quick "what runs, when"
lives in [`../ops/README.md`](../ops/README.md); this page covers *why* each decision was made
and what breaks a running estate.

## Why the gatekeeper is not the answer

The gatekeeper wins RAM and CPU, not disk:

```
on-demand-gatekeeper/src/server.js:273-289   teardown -> docker compose ... down
on-demand-gatekeeper/src/server.js:193-194   'down' -> no -v flag
```

- `compose down` without `-v` **keeps volumes** — correct, that is where the data is.
- The gatekeeper never builds (`DEPLOY_BUILD=false`); it runs `compose up` and needs the images
  to already exist. So an image of an asleep stack is a **cold-start dependency**, not junk.
- Container json logs are removed with the container, but re-created and grown again on every
  wake. Host-side logs (`deploy/logs/*.log`) are not in a container at all.

Consequences, which the rest of this document is built around:

### Never run

| Command | Effect | Guard |
|---|---|---|
| `docker image prune -a` | Deletes images of every **asleep** stack → its next cold start fails until CI re-runs | `assert_safe_command()` exits 64 |
| `docker volume prune` / `--volumes` | Deletes the Postgres / media / uploads volumes of asleep stacks → business data loss | same guard |
| truncating `deploy/logs/*.log` | Kills the dashboard's visitor ingestion until new lines arrive | logrotate only, `copytruncate` |

### Safe, and what the janitor runs

```bash
docker image prune -f                                              # dangling only
docker builder prune -f --keep-storage 10GB --filter until=168h    # capped cache
docker system prune -f                                             # weekly; no -a, no --volumes
```

## Phases

| Phase | What | App repos touched |
|---|---|---|
| 0 | `ops/report.sh` — read-only baseline (`docker system df -v`, `du`, `lsblk`) | none |
| 1 | this janitor: images, build cache, log caps, logrotate, weekly prune + dump trim | none |
| 2 | compose `logging:` limits, post-deploy image prune, n8n/Mailpit retention | 4 repos |
| 3 | approved retention: dashboard visits 90 d, orphaned media report | 2 repos |
| 4 | deferred: DB dumps → R2, `studio-media` → R2 | not implemented |

## Reading the log

```bash
tail -40 /var/log/docker-janitor.log
```

Each pass logs `free before`, every step's result, `free after`, and the net reclaim. A
run that did nothing is visible as `image prune skipped` (free space above the skip
threshold) or `BUILD_ACTIVE` (a deploy was building).

## Verifying it did not break a cold start

The only failure that matters. After any janitor pass:

```bash
# per app: public port is the gatekeeper, internal port is the real stack
for p in 8023:gazi 8024:dropship 5174:ai-invoice 8027:studio; do
  port="${p%%:*}"; name="${p#*:}"
  docker image ls --format '{{.Repository}}' | grep -q . || true
  curl -fsS -o /dev/null "http://127.0.0.1:${port}/" || echo "${name}: wake failed"
  curl -fsS "http://127.0.0.1:${port}/_ondemand/status" | grep -q '"state":"ready"' \
    && echo "${name}: ready" || echo "${name}: NOT ready"
done
docker volume ls -q | wc -l    # must be unchanged from before the pass
```

If a cold start fails, the image was pruned. Recover by re-running that app's CI deploy
(`/opt/deploy-<app>.sh`), which rebuilds the image.

## Tuning

All knobs are `Environment=` lines in `ops/docker-janitor.service` — edit there, then
`systemctl daemon-reload`:

| Key | Default | Meaning |
|---|---|---|
| `MIN_FREE_BYTES` | 8 GiB | act regardless of other gates |
| `SKIP_ABOVE_BYTES` | 35 GiB | skip the image step above this |
| `BUILD_CACHE_KEEP` | 10GB | build-cache budget |
| `BUILD_CACHE_UNTIL` | 168h | ignore cache entries newer than a week |
| `DUMP_KEEP_DAILY` | 7 | newest dumps kept per backups dir |
| `DUMP_KEEP_WEEKLY` | 4 | extra weekly dumps kept per backups dir |
| `DUMP_GLOB_ROOT` | /opt/github | where backups dirs are searched |
| `WEEKLY_ON_DOW` | 0 (Sunday) | which weekday also runs the weekly steps |

## Rollback

```bash
sudo bash ops/install-janitor.sh --uninstall
```

That disables and removes the unit, timer, and logrotate rule. `/etc/docker/daemon.json` is
left in place (log caps are harmless without the janitor) — delete it if you want unbounded
container logs again; the change applies to containers created after that point.
