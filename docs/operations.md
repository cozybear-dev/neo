# Operations and capability limits

Day-to-day limits on workers, deploys, and the browser are in [Execution and lab limits](execution.md). How a task moves from plan to findings is in [Assessment workflow](workflow.md).

## Services and trust boundaries

DSH runs as `node`; workers run as an unprivileged user. The broker alone administers Docker. The browser is on an internal link with DSH; all supported HTTP page requests are intercepted and fetched by the broker. Worker lab networks are internal and task-owned. Operator and broker credentials never enter worker environments or DSH settings.

The Docker daemon and broker remain trusted infrastructure. Container isolation is not a replacement for a separate VM when assessing hostile native binaries or kernel exploits. The default runtime deliberately does not provide privileged execution, VPN setup, arbitrary external scanner egress, device passthrough, Git builds, or unrestricted Compose.

Only one worker operates on a task's artifact staging area at a time. A concurrent request reports a conflict; retry after the active command settles. Cancellation terminates the container. Transport failure reports an unknown outcome and does not retry the command automatically. Broker restart removes its own stale workers; task deployments persist for explicit cleanup. Owned cleanup remains authorized after task completion or plan revocation.

## Credentials and existing volumes

Postgres stores the `neo` role password in the `pgdata` volume. Each start sets that password from `NEO_DB_PASSWORD`, and the existing database stays in place when the secret changes. `pg_dump` and `psql` without `-h` use the local trust socket.

Compose stores a chat-opener secret in the `task-state` volume. The first message in a chat opens a task whose allowlist is `NEO_ALLOWLIST`. A hand-made task still goes through `docker compose exec -T control node dist/operator.js create`, as described in [Assessment workflow](workflow.md). The returned task token is displayed only at creation; store it privately. Keep `.env` and task-token files mode `0600`. Model settings and temporary renderer files also use owner-only permissions; temporary exports are deleted before DSH starts.

Existing root-owned `dsh-home` or workspace volumes may need a one-time ownership migration before using the new non-root image. Stop DSH, back up the volumes, then change only those volumes to UID/GID 1000 using a maintenance container. Do not reset or delete existing volumes to fix ownership. Legacy tasks without credentials cannot be adopted by an agent; create an explicitly authorized new task and import reviewed evidence as needed.

## Readiness, logging, migrations

Control `/healthz` reports process liveness; `/readyz` verifies Postgres connectivity. Startup applies checksum-tracked migrations under a database advisory lock. A changed applied migration is an error; add a new migration instead. SIGINT/SIGTERM close the HTTP server and database pool. Control emits structured request/error logs with credentials redacted. Docker worker/deployment logs have size limits.

Useful diagnostics:

```bash
docker compose ps
docker compose logs --tail 100 control broker browser dsh
docker compose exec -T control node -e "fetch('http://localhost:8090/readyz').then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)})"
```

## Backup and recovery

Stop DSH and ongoing workers before a consistent assessment snapshot. Back up the database and the `workspace`, `dsh-home`, `broker-state`, and `task-state` volumes together. `task-state` holds the chat-opener secret. Backups contain credentials and raw evidence; keep them private and encrypted when stored off host.

```bash
umask 077
mkdir -p backups
docker compose exec -T postgres pg_dump -U neo -d neo -Fc > backups/neo.dump
# Verify archive readability before relying on it:
docker compose exec -T postgres pg_restore --list < backups/neo.dump
```

Restore into a **new empty database** first, then validate task, issue, history, and migration rows before selecting it as the application's database. Do not restore over the only production copy. For a disposable validation database:

```bash
docker compose exec -T postgres createdb -U neo neo_restore
docker compose exec -T postgres pg_restore -U neo -d neo_restore --exit-on-error < backups/neo.dump
docker compose exec -T postgres psql -U neo -d neo_restore -c 'SELECT count(*) FROM tasks; SELECT count(*) FROM issue_history;'
```

## Retention and limits

Issue queries accept bounded pagination; task data remains durable across restarts. Browser capture is bounded to 1,000 requests and 16 MiB per capture session, and storage errors are reported. OAST registrations expire locally after one hour and can be deregistered explicitly. Worker file exchange is bounded by file count, depth, individual and aggregate bytes; oversized artifacts produce an error rather than unlimited memory use. Raw summarizer output is stored separately from model-facing redacted summaries.

Archive completed tasks and their matching workspace/broker directories according to your evidence policy. This release never silently deletes durable issues or task evidence. Review volume usage before long-running assessments. For deletion, retain a verified backup and remove only the chosen completed task's namespace through an operator maintenance process.

## Capability reporting

The worker image carries a capability manifest; the broker `/capabilities` endpoint reports installed tools and supported networking. `gh`, SSH/ADB clients and Impacket availability do not grant credentials, network access, or device access. NetExec, mobile device access, VPN setup, and Ghidra agent integration remain unavailable unless a separately reviewed runtime supplies them. Presets must report unavailable capabilities instead of claiming execution succeeded.

The optional Ghidra profile is isolated with its own import/project storage. It is an operator-only integration, not shared access to agent artifacts. Built-in HTTP OAST uses the broker relay; public DNS OAST, SMTP and internet-facing callback publication are not configured automatically.

Generate application dependency inventories with `npm run sbom`; output is written to `dist/sbom/`. These CycloneDX files cover locked production npm dependencies. They complement the worker capability manifest and do not inventory every OS/scanner transitive component.
