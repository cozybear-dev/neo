# Neo (OSS replica)

Open-source replica of ProjectDiscovery Neo on DeepSeek Harness, Docker Compose, Exa search, and a globally configurable LLM.

## Legal / authorized use only

Use this project **only** against systems you own or have explicit written authorization to test. Out-of-scope hosts are denied by default (`NEO_ALLOWLIST`). This toolkit does **not** solve CAPTCHAs or bypass access controls outside authorized testing.

## Quick start

```bash
cp .env.example .env
# Fill at least NEO_LLM_API_KEY and EXA_API_KEY
docker compose up --build
```

Useful subsets while the harness/control stubs are unfinished:

```bash
docker compose up --build sandbox browser postgres
docker compose exec sandbox nuclei -version
```

## Layout

| Service    | Role                                      |
|------------|-------------------------------------------|
| `dsh`      | DeepSeek Harness agent runtime (stub)     |
| `sandbox`  | Security toolchain + shared `/workspace`  |
| `browser`  | Headless Chromium CDP on `:9222` (internal) |
| `interactsh` | OAST server (in-network)                |
| `postgres` | Issues + task memory                      |
| `control`  | Issues/memory HTTP API (stub)             |

Networks: `control` (orchestration) and `targets` (sandbox + lab apps only). The sandbox mounts the Docker socket solely to create containers on `targets`.

## Docs

See `docs/superpowers/plans/2026-08-19-neo-replica.md` for the full implementation plan.
