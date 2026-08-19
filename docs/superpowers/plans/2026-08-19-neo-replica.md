# Open-source Neo replica on DeepSeek Harness

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Docker-composed, open-source replica of ProjectDiscovery Neo’s agent roster and orchestration (Fast/Thorough, Planner, Agent Swarm, verification loop) on DeepSeek Harness, with Exa as the search provider and a single global LLM provider/model setting.

**Architecture:** DeepSeek Harness (`dsh`) is the agent runtime. Each Neo specialist is a DSH **preset** (persona + tool filter + skills). A custom `neo` profile patches DSH at boot: Exa search, Docker sandbox subprocess/FS, Playwright browser, Interactsh OAST, issues/memory tools, and an orchestrator that spawns specialists as in-process subagents. LLM routing uses DSH’s existing adapter registry (`ctx.llm`): compose env vars write `$DSH_HOME/settings.yaml` so every agent and the summarizer share one provider/model. Closed-source Neo pieces are replaced with OSS equivalents or explicitly stubbed.

**Tech Stack:** DeepSeek Harness (pinned git SHA, MIT), Cordis plugins (TypeScript), DSH LLM adapters (DeepSeek, OpenAI, Anthropic, OpenRouter, custom OpenAI-compatible), Exa Search API, Docker Compose, Postgres, Playwright, ProjectDiscovery OSS CLIs, Interactsh, GhidraMCP, Nuclei templates from GitHub.

## Global Constraints

- Legal use only: every task requires an explicit target allowlist and an authorization precheck. Default deny anything not in scope.
- Do not clone ProjectDiscovery in-house purpose-built tools, PDCP proprietary APIs, Browserbase/Stagehand/CAPTCHA, Genymotion cloud, jailbroken-iOS hardware, Autospawn/Kata, or Neo’s private knowledge base.
- Agents run on DeepSeek Harness. Do not invent a second agent loop.
- LLM is globally configurable. Do not hardcode DeepSeek as the only model. Use DSH’s built-in adapters and `$DSH_HOME/settings.yaml`; do not write a second LLM client.
- All agents, subagents, and the summarizer inherit the same default `provider` + `model`. Per-agent model overrides are out of v1.
- Web search in the harness uses Exa (`web-search-exa` + `EXA_API_KEY`).
- Everything runs under Docker Compose. One command: `docker compose up --build`.
- Pin `deepseek-ai/deepseek-harness` to a SHA. Treat it as a dependency, not a fork. Our code lives in out-of-tree plugins + a `neo` profile overlay.
- Pre-installed security binaries are reached through `bash` in the sandbox image, not registered one-by-one with the model (matches Neo).
- Typed tools exist only when a CLI wrap is too lossy: issues, memory, OAST, browser, traffic, scope, summarizer hook.
- Shared `/workspace` volume is the cross-agent file bus. Postgres is the issues + task-memory store.
- Android cloud devices and jailbroken iOS are **out of v1 runtime**. Ship the agent presets/skills so they fail closed with a clear “hardware not attached” message.
- No destructive DoS, no CAPTCHA-solving, no lockout-blind credential spraying. Red Team Operator has lockout guardrails.

---

## What Neo actually is (from the docs)

A **task** is the unit of work. Two modes:

| | Fast | Thorough |
|---|---|---|
| Planning | Skipped | Clarify → Planner (spawns ≤3 Explore agents) → user-reviewable plan |
| Execution | One specialist, immediate | Agent Swarm decomposes and runs specialists in parallel |
| Verify | Optional / light | Required: judge + ≤5 independent verifiers; unconfirmed findings are not filed |

The user talks to an **orchestrator**. Subagents return structured results (what they did, files produced, optional next-agent recommendation). All agents share **working memory** (insights, facts, todos, tracked files) and the **sandbox filesystem**. Skills are SKILL.md files, loaded on demand, max 3 active.

Verification is architectural: the agent that finds a vuln is not the agent that confirms it. Judge has no exec tools. Verifiers re-test from scratch. Verdicts: confirmed / false positive / needs retry / informational.

---

## What we will and will not build

### Build (open-source equivalents)

| Neo agent | Replica | Runtime |
|---|---|---|
| Orchestrator | `neo-orchestrator` preset | Top-level DSH agent |
| Planner | `planner` preset, no exec tools except explore/browser spawn + file read | Thorough only |
| Agent Swarm | `swarm` preset using continuable in-process subagents | Thorough only |
| Explore | `explore` preset, read-oriented recon | ≤3 parallel during planning |
| Recon | `recon` preset: subfinder, dnsx, crt.sh, whois, httpx **passive flags only** | Discovery |
| Research | `research` preset: Exa search/fetch, GitHub code search via Exa, grep.app via fetch | Discovery |
| CVE Intelligence | `cve` preset: `vulnx` CLI + NVD/OSV/GHSA via HTTP + Exa for live intel | Discovery |
| ProjectDiscovery Agent | `pd-oss` preset: local Nuclei + `nuclei-templates` git clone. Optional PDCP HTTP if `PDCP_API_KEY` is set; otherwise skip cloud inventory | Discovery |
| Sandbox | `sandbox` preset: full toolchain via bash | Default executor |
| Browser | `browser` preset: Playwright against `browser` service (CDP). No stealth/CAPTCHA | Testing |
| API Security | `api` preset: OpenAPI ingest + authenticated HTTP + GraphQL introspection | Testing |
| XSS | `xss` preset: context analysis + Playwright confirm + Interactsh for blind XSS | Testing |
| Red Team Operator | `redteam` preset: Impacket/NetExec/etc with scope + lockout guards | Testing |
| Ghidra | `ghidra` preset: GhidraMCP against `ghidra` service | Testing |
| Deploy | `deploy` preset: docker compose on the `targets` network only | Testing |
| Vuln Triage | `triage` preset: paste/attach + optional GitHub Advisory API; HackerOne only if user supplies token | Analysis |
| GitHub Review | `github-review` preset: `gh` + GitHub API, inline comments, six-dimension proof gate | Analysis |
| Verification (judge) | `judge` preset: **no exec tools**, read artifacts + spawn verifiers | Thorough final phase |
| Verifier | `verifier` preset: full exec, adversarial default = false positive | ≤5 parallel |
| Summarizing | `tools/post-execute` hook, not a user-facing agent | Automatic >10k tokens |
| Custom Agents | DSH presets on disk + a `subagent-manager` persona that writes new preset files | Platform |
| Skills | Our own SKILL.md set covering documented domains | On-demand |

### Stub or skip (closed-source / hardware / SaaS)

- Browserbase cloud browsers, Stagehand AI, CAPTCHA solving
- Genymotion cloud ARM64 Android devices
- Jailbroken iPhone / physical iOS lab
- Autospawn + Kata VM isolation (use ordinary Docker isolation on a `targets` network)
- PDCP asset inventory / leaked-creds / team context unless the user provides a PDCP key
- Neo’s 40 in-house typed tools (replace capabilities, do not clone)
- Neo’s private knowledge base / Codewiki / Codemaps SaaS (approximate with workspace files + tree-sitter later)
- Slack / Linear / Jira / 1Password native product integrations (v1: skip; agents can still use `gh` and HTTP if secrets exist)
- Billing, teams, credits, community agent directory

Android and iOS agents: ship personas + skills. At runtime they check for `ANDROID_SERIAL` / `IOS_SSH_HOST`. If missing, they return a structured “unavailable” result and the swarm continues without them.

---

## System architecture

```
                    ┌─────────────────────────────────────────┐
  User              │  dsh (neo profile)  :3080               │
  browser ─────────►│  orchestrator + presets + plugins       │
                    │  Exa via web-search-exa                 │
                    └───────────┬───────────────┬─────────────┘
                                │ docker exec   │ HTTP
                    ┌───────────▼──────┐  ┌─────▼──────┐
                    │ sandbox          │  │ postgres   │
                    │ PD + redteam     │  │ issues,    │
                    │ /workspace vol   │  │ tasks,     │
                    └───┬──────────┬───┘  │ memory     │
          docker.sock*  │          │      └────────────┘
                    ┌───▼───┐  ┌───▼────────┐  ┌───────────┐
                    │targets│  │ browser    │  │ interactsh│
                    │network│  │ Playwright │  │ OAST      │
                    └───────┘  │ CDP :9222  │  └───────────┘
                               └────────────┘  ┌───────────┐
                                               │ ghidra    │
                                               │ MCP :8080 │
                                               └───────────┘
```

\* `sandbox` is the only service that may talk to the Docker socket, and only to create containers on the isolated `targets` network.

### Thorough-mode sequence

1. User starts a task (`pentest` / `triage` / `audit` / freeform) with target, out-of-scope, secrets, mode.
2. Orchestrator runs authorization + scope check. If Fast: jump to step 6 with one specialist.
3. Clarify (DSH ask-user) until scope is concrete.
4. Planner spawns ≤3 Explore agents in parallel (read-only). Optionally one Browser for visual recon.
5. Planner writes `/workspace/plan.md`. DSH plan mode pauses for user approval.
6. Swarm splits the plan into workstreams, assigns specialists (`persona` + `toolFilter`), runs independent streams in parallel, fans in files + memory.
7. Large tool outputs hit the summarizer hook (>10k tokens; hard truncate >900k).
8. Judge reads artifacts with no exec tools, spawns ≤5 Verifiers with structured output schema `{verdict, evidence_paths, reason}`.
9. Only `confirmed` findings call `issue_create`. Report written to `/workspace/report.md`.

Fast mode: skip 3–5 and 8’s full loop; still write issues only for confirmed claims if the specialist self-reports a finding (Fast may file as `unverified`).

---

## Repository layout (empty workspace today)

```
neo/
  docker-compose.yml
  docker-compose.ghidra.yml          # optional profile
  .env.example
  README.md
  docker/
    dsh/Dockerfile
    sandbox/Dockerfile
    sandbox/packages.txt
    browser/Dockerfile
    ghidra/Dockerfile
  plugins/                           # out-of-tree DSH plugins (TS)
    neo-profile/                     # cordis.yml + package.json dsh.profile
    neo-sandbox-docker/              # ctx.subprocess + ctx.fs → docker exec
    neo-tools-scope/
    neo-tools-memory/
    neo-tools-issues/
    neo-tools-oast/
    neo-tools-browser/
    neo-tools-traffic/
    neo-summarizer/
    neo-orchestrator/                # system-prompt sections + routing skill
  presets/                           # DSH agent presets (yaml)
    orchestrator.yml
    planner.yml
    swarm.yml
    explore.yml
    recon.yml
    research.yml
    cve.yml
    pd-oss.yml
    sandbox.yml
    browser.yml
    api.yml
    xss.yml
    redteam.yml
    ghidra.yml
    deploy.yml
    triage.yml
    github-review.yml
    judge.yml
    verifier.yml
    android.yml                      # fail-closed
    ios.yml                          # fail-closed
  skills/                            # SKILL.md + references/
  workflows/                         # pentest, triage, code-audit prompt templates
  control/                           # small Fastify/TS issues+memory HTTP used by tools
    src/
    migrations/
  tests/
    unit/
    integration/
    fixtures/dvwa/                   # or juice-shop compose snippet for e2e
  docker/dsh/entrypoint.sh           # renders DSH settings.yaml from NEO_LLM_*
```

DSH itself is cloned at build time into the `dsh` image (`ARG DSH_SHA=...`), not vendored in git.

---

## Docker Compose (target)

Services:

- **dsh** — Node 22, built harness + our plugins, profile `neo`, port 3080. Env: `NEO_LLM_*` (provider/model/key/base URL), `EXA_API_KEY`, optional `PDCP_API_KEY`, `GITHUB_TOKEN`, `HACKERONE_API_TOKEN`. Volume `dsh-home` mounted at `$DSH_HOME`.
- **sandbox** — Ubuntu-based tool image. Shared volume `workspace:/workspace`. No inbound except from `dsh`.
- **browser** — `mcr.microsoft.com/playwright` with Chromium `--remote-debugging-port=9222`. Internal only.
- **interactsh** — `projectdiscovery/interactsh-server` in auth mode. Internal + optional published DNS/HTTP if the user wants real OOB (documented; default is in-network only, which still works for lab targets on `targets`).
- **postgres** — issues, tasks, working memory.
- **control** — issues/memory HTTP API on the internal network.
- **ghidra** — only with `--profile ghidra`.

Networks: `control` (dsh, postgres, control, sandbox, browser, interactsh, ghidra) and `targets` (sandbox + deployed apps only).

---

## Global LLM provider and model

DSH already treats models as plugins: catalog adapters (DeepSeek, OpenAI, Anthropic, OpenRouter) plus custom OpenAI-compatible endpoints via Settings → Models / `$DSH_HOME/settings.yaml` (`llm-pi-ai.providers`, `apiKeyEnv`, `baseURL`, `api: openai-completions`). We expose that as **one compose-time config**, not a UI-only afterthought and not a forked adapter.

### Env (the global option)

Set these in `.env`. Compose passes them into the `dsh` service. An entrypoint renders DSH’s native `settings.yaml` before `dsh web` starts.

```
# Identity — required
NEO_LLM_PROVIDER=deepseek
NEO_LLM_MODEL=deepseek-v4-flash

# Key — used by the selected provider. Catalog providers also accept their native names.
NEO_LLM_API_KEY=

# Catalog keys (optional aliases; entrypoint copies NEO_LLM_API_KEY into the one DSH expects)
# DEEPSEEK_API_KEY=
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# OPENROUTER_API_KEY=

# Custom / OpenAI-compatible (Ollama, vLLM, LiteLLM, OpenAI-compatible gateways)
# Required when NEO_LLM_PROVIDER=custom
NEO_LLM_BASE_URL=
NEO_LLM_API=openai-completions
NEO_LLM_API_KEY_ENV=NEO_LLM_API_KEY

# Optional generation knobs DSH already understands
NEO_LLM_REASONING_EFFORT=
```

`NEO_LLM_PROVIDER` values:

| Value | DSH path | Key |
|---|---|---|
| `deepseek` | built-in DeepSeek adapter | `DEEPSEEK_API_KEY` or `NEO_LLM_API_KEY` |
| `openai` | catalog OpenAI adapter | `OPENAI_API_KEY` or `NEO_LLM_API_KEY` |
| `anthropic` | catalog Anthropic adapter | `ANTHROPIC_API_KEY` or `NEO_LLM_API_KEY` |
| `openrouter` | catalog OpenRouter adapter | `OPENROUTER_API_KEY` or `NEO_LLM_API_KEY` |
| `custom` | `llm-pi-ai` custom provider | `NEO_LLM_API_KEY` + `NEO_LLM_BASE_URL` |

Default remains DeepSeek (`deepseek` / `deepseek-v4-flash`) so a two-key `.env` (`NEO_LLM_API_KEY` + `EXA_API_KEY`) still works.

### How it is applied

1. `docker/dsh/entrypoint.sh` writes `$DSH_HOME/settings.yaml` from the env vars, matching the schema at the pinned DSH SHA (do not invent fields). Persist `DSH_HOME` on a volume so UI changes survive restarts, but **env wins on every boot** for `provider`, `model`, and the selected provider’s credential/base URL so compose is the source of truth.
2. Fail loud at startup if the selected provider has no key (except `custom` with a keyless local endpoint, which still requires `NEO_LLM_BASE_URL` + `NEO_LLM_MODEL`).
3. Subagent `delegate` does **not** pass a different `agentOptions.provider/model`. Children inherit the parent default.
4. Summarizer calls `ctx.llm` with that same default. Never `fetch('https://api.deepseek.com')`.
5. DSH Web UI Settings → Models remains available for live inspection; the next `compose up` resets to env.

Example custom (Ollama on the host):

```
NEO_LLM_PROVIDER=custom
NEO_LLM_MODEL=qwen3:8b
NEO_LLM_BASE_URL=http://host.docker.internal:11434/v1
NEO_LLM_API=openai-completions
NEO_LLM_API_KEY=ollama
```

---

## Plugin contracts (implement these first; agents consume them)

### `neo-sandbox-docker`

Maps DSH `ctx.subprocess` and `ctx.fs` onto `docker exec` into `sandbox`.

```ts
// execute(argv, opts) → { stdout, stderr, exitCode }
// cwd always /workspace unless overridden
// env: merge task secrets from control API, never echo values back
```

### Typed tools

```ts
scope_check({ target: string, extra_hosts?: string[] })
  → { allowed: boolean, matched: string, reason: string }

memory_get() → { insights: string[], facts: Fact[], todos: Todo[], files: string[] }
memory_update({ insights?, facts?, todos?, files? }) → { ok: true }

issue_create({ title, severity, host, evidence_paths, reproduction, verdict })
  → { id: string }  // rejects unless verdict === 'confirmed' in Thorough
issue_query({ host?, severity?, status? }) → Issue[]
issue_update({ id, status, comment }) → { ok: true }

oast_register({ kind: 'http' | 'dns' }) → { id, url, domain }
oast_poll({ id, wait_seconds?: number }) → Interaction[]

browser_navigate({ url, wait?: string })
browser_act({ action: 'click'|'type'|'select', selector?: string, text?: string, instruction: string })
browser_eval({ expression: string })
browser_screenshot() → { path: string }
browser_network() → { requests: CapturedRequest[] }

traffic_search({ query: string }) → CapturedRequest[]
traffic_replay({ id: string, edits?: Record<string, unknown> }) → Response
```

Summarizer: `tools/post-execute` listener. If result tokens > 10000, replace model-facing content with a condensed summary via `ctx.llm` using the global default provider/model (same as the agents). If > 900000 tokens, pre-truncate then summarize. On failure, return truncated original.

---

## Agent presets (persona intent — write the full prompts during implementation)

Every preset file includes: `id`, `when_to_use`, `persona`, `tool_allowlist`, `skills`, `max_parallel`, `readonly` flag.

- **orchestrator** — route by mode and objective; never pentest itself; always pass scope; after specialists, decide verify vs respond.
- **planner** — information gathering only; spawn explore; emit `plan.md` with phases, agents, success criteria; no exploits.
- **swarm** — decompose plan; spawn specialists with `outputSchema`; aggregate; re-delegate on failure.
- **explore** — subfinder/httpx/nmap/naabu/whois/dig/curl + Exa + GitHub; no exploit, no issue_create.
- **recon** — passive only (no direct target HTTP except what passive tools already do internally; prefer CT/passive DNS). Write `/workspace/recon/inventory.json`.
- **research** — Exa-only research; write `/workspace/research/notes.md`.
- **cve** — vulnx + feeds; write `/workspace/cve/map.json` from recon tech fingerprints.
- **pd-oss** — nuclei template search/run against in-scope hosts; optional PDCP.
- **sandbox** — default hands-on tester; full bash + oast + traffic + memory.
- **browser** — only browser_* tools + memory; screenshots under `/workspace/browser/`.
- **api** — OpenAPI/GraphQL; auth secrets; no HTML-XSS rabbit holes (hand those to xss).
- **xss** — context classify then payload; confirm in browser; blind via oast.
- **redteam** — assumed-breach; lockout: stop a spray after N failures per account (config, default 3); OPSEC notes; scope-bound.
- **ghidra** — MCP only; document functions and vuln hypotheses; do not file issues (judge/verifier do).
- **deploy** — compose up on `targets`; return base URL + logs path.
- **triage** — ingest report; reproduce via sandbox/browser; structured verdict.
- **github-review** — diff only; six proof dimensions (attacker control, reachability, sink, guards, framework, impact). Drop if any required dimension is blocked/insufficient.
- **judge** — tools: memory_get, issue_query, fs read, subagent spawn (verifier only). No bash, no browser, no oast.
- **verifier** — default hypothesis = false positive; must produce independent evidence files.

Structured specialist return (forced `outputSchema`):

```json
{
  "type": "object",
  "properties": {
    "summary": { "type": "string" },
    "artifacts": { "type": "array", "items": { "type": "string" } },
    "findings_claimed": { "type": "array", "items": { "type": "object" } },
    "next_agent": { "type": "string" },
    "blockers": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["summary", "artifacts"]
}
```

---

## Skills to author (public methodology, not PD’s private files)

Write concise SKILL.md files the agents can activate (max 3). Do not copy Neo’s private 850-line Android guide; write original methodology from public OWASP / tool docs.

1. `redteam` 2. `nuclei-templates` 3. `sqlmap-guide` 4. `semgrep` 5. `variant-analysis`
6. `security-findings` 7. `exploitability-verification` 8. `runtime-validation`
9. `android-security` 10. `ios-security` 11. `vpn-guide` 12. `differential-review`
13. `h1-triage` (public H1 API only) 14. `owasp-api` 15. `xss-contexts`

---

## Implementation tasks

### Task 1: Repo skeleton, Compose, sandbox image

**Files:**
- Create: `docker-compose.yml`, `.env.example`, `README.md`, `docker/sandbox/Dockerfile`, `docker/sandbox/packages.txt`, `docker/dsh/Dockerfile`, `docker/browser/Dockerfile`

**Produces:** `docker compose up sandbox browser postgres` starts; `docker compose exec sandbox nuclei -version` works.

- [ ] **Step 1: Write `packages.txt`** with pinned versions where possible: nuclei, subfinder, dnsx, httpx, naabu, katana, tlsx, nmap, sqlmap, ffuf, semgrep, gitleaks, trufflehog, vulnx, interactsh-client, hydra, john, chisel, kerbrute, git, curl, jq, python3, golang, node, mitmproxy, wireguard-tools, openvpn, whois, bind9-dnsutils.

- [ ] **Step 2: Write `docker/sandbox/Dockerfile`** — Ubuntu 24.04, install Go/Python/Node, `go install` the PD tools, copy wordlists (seclists subset or ffuf default), create `/workspace`, non-root user `neo` with sudo for package install.

- [ ] **Step 3: Write `docker/browser/Dockerfile`** — Playwright image, expose 9222, no VNC required.

- [ ] **Step 4: Write `docker-compose.yml`** with `dsh`, `sandbox`, `browser`, `interactsh`, `postgres`, `control`, volumes `workspace` and `pgdata`, networks `control` and `targets`. `dsh` depends_on healthy postgres + sandbox.

- [ ] **Step 5: Write `.env.example`**

```
# Global LLM (DSH adapters). Default = DeepSeek.
NEO_LLM_PROVIDER=deepseek
NEO_LLM_MODEL=deepseek-v4-flash
NEO_LLM_API_KEY=
# NEO_LLM_BASE_URL=                 # required when PROVIDER=custom
# NEO_LLM_API=openai-completions
# NEO_LLM_REASONING_EFFORT=

EXA_API_KEY=
GITHUB_TOKEN=
PDCP_API_KEY=
HACKERONE_API_TOKEN=
NEO_ALLOWLIST=localhost,127.0.0.1,*.lab.internal,juice-shop
NEO_MODE_DEFAULT=thorough
```

- [ ] **Step 6: Smoke the sandbox image** (`docker compose build sandbox && docker compose run --rm sandbox nuclei -version`). Expected: version printed.

- [ ] **Step 7: Commit** `chore: add compose skeleton and sandbox toolchain image`

---

### Task 2: Pin DeepSeek Harness, neo profile, and global LLM bootstrap

**Files:**
- Create: `docker/dsh/Dockerfile`, `docker/dsh/entrypoint.sh`, `plugins/neo-profile/package.json`, `plugins/neo-profile/cordis.yml`, `plugins/neo-profile/cordis.patch.yml`
- Test: `tests/unit/llm-settings.test.ts` (entrypoint/settings renderer; no live LLM)

**Produces:** `docker compose up dsh` serves Web UI on :3080 with Exa enabled and the default model taken from `NEO_LLM_PROVIDER` / `NEO_LLM_MODEL`. Headless `dsh --profile neo --dump-config` includes our rows. Missing key for a cloud provider exits non-zero.

- [ ] **Step 1: Pin SHA** in Dockerfile `ARG DSH_SHA=<resolved at implement time by git ls-remote>`. Clone, `pnpm install && pnpm run build`. Inspect the pinned tree for the exact `settings.yaml` keys (`provider`, `model`, `llm-pi-ai.providers`, catalog adapter env names) and copy those names verbatim into the entrypoint. Do not guess.

- [ ] **Step 2: Create profile package** with `dsh.profile` listing `dsh-base`, `dsh-web-app`, plus our plugin rows. Enable `web-search-exa`. Disable competing search providers.

- [ ] **Step 3: Write `entrypoint.sh`** that:
  1. Maps `NEO_LLM_API_KEY` onto `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` according to `NEO_LLM_PROVIDER`.
  2. Writes `$DSH_HOME/settings.yaml` setting default `provider` + `model`.
  3. When `NEO_LLM_PROVIDER=custom`, upserts the `llm-pi-ai` custom provider (`apiKeyEnv`, `baseURL`, `api`, `models: [{id}]`).
  4. Exits with a clear error if a cloud provider has an empty key or `custom` is missing `NEO_LLM_BASE_URL` / `NEO_LLM_MODEL`.
  5. Then `exec`s `dsh web` / the image CMD.

- [ ] **Step 4: Unit-test the settings renderer** (extract a small TS or shell-testable function if the entrypoint is awkward): deepseek → no custom block; custom → baseURL present; missing key → non-zero.

- [ ] **Step 5: Inject `EXA_API_KEY`** into the Exa provider config via env.

- [ ] **Step 6: Headless smoke:** `dsh --profile neo --dump-config` includes our rows. With `NEO_LLM_PROVIDER=custom` and a dummy base URL, dump-config / settings.yaml show that provider as default.

- [ ] **Step 7: Commit** `chore: pin dsh, neo profile, and env-driven LLM provider`

---

### Task 3: Control API (issues + memory)

**Files:**
- Create: `control/src/server.ts`, `control/src/db.ts`, `control/migrations/001_init.sql`, `control/package.json`
- Test: `control/src/server.test.ts`

**Interfaces:**
- `GET/PUT /tasks/:id/memory` — `{insights, facts, todos, files}`
- `POST /issues` — create; Thorough path requires `verdict=confirmed`
- `GET /issues?host&severity&status`
- `PATCH /issues/:id`
- `POST /scope/check` — glob allowlist from env + task scope
- `GET /healthz`

Schema (Postgres):

```sql
CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('fast','thorough')),
  objective TEXT NOT NULL,
  allowlist TEXT[] NOT NULL,
  denylist TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE task_memory (
  task_id UUID PRIMARY KEY REFERENCES tasks(id),
  insights JSONB NOT NULL DEFAULT '[]',
  facts JSONB NOT NULL DEFAULT '[]',
  todos JSONB NOT NULL DEFAULT '[]',
  files JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE issues (
  id UUID PRIMARY KEY,
  task_id UUID REFERENCES tasks(id),
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unverified','confirmed','open','false_positive')),
  host TEXT,
  evidence_paths TEXT[] NOT NULL DEFAULT '{}',
  reproduction TEXT,
  verdict TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 1: Write failing tests** for scope deny, issue reject without confirmed verdict, memory merge.

- [ ] **Step 2: Implement Fastify server + migrations.**

- [ ] **Step 3: Add `control` service to compose.** Healthcheck `curl -f http://localhost:8090/healthz`.

- [ ] **Step 4: Commit** `feat: issues and memory control API`

---

### Task 4: DSH tools — scope, memory, issues, OAST

**Files:**
- Create: `plugins/neo-tools-scope/src/index.ts` (and memory/issues/oast siblings)
- Test: `plugins/neo-tools-scope/src/index.test.ts` etc.

**Consumes:** control HTTP, interactsh HTTP API.
**Produces:** `ctx.tools` registrations as specified above.

- [ ] **Step 1: Write unit tests** with mocked fetch: allowlist miss throws; issue_create in thorough without confirmed → error value (not throw if domain-level — return `{ok:false, error}` per DSH “successful domain outcome” rule).

- [ ] **Step 2: Implement plugins with `defineTool`.** Honor `exec.signal`. Never render secret values.

- [ ] **Step 3: Register in `neo-profile` cordis.yml.**

- [ ] **Step 4: Commit** `feat: scope, memory, issues, oast tools`

---

### Task 5: Docker sandbox provider + Playwright browser tools + traffic sidecar

**Files:**
- Create: `plugins/neo-sandbox-docker/src/index.ts`, `plugins/neo-tools-browser/src/index.ts`, `plugins/neo-tools-traffic/src/index.ts`

**Produces:** bash/fs in DSH actually run in `sandbox`; browser_* talk to CDP on `browser:9222`; mitmproxy or Playwright request log feeds `traffic_*`.

- [ ] **Step 1: Implement subprocess provider** using Dockerode against `sandbox` container name from config.

- [ ] **Step 2: Implement Playwright tools** connecting to `ws://browser:9222`. Screenshots written into `/workspace` via sandbox FS.

- [ ] **Step 3: Capture browser requests** into postgres or a jsonl file `/workspace/traffic/http.jsonl` and search/replay from that.

- [ ] **Step 4: Integration test** in compose: `bash` `echo hi > /workspace/t.txt` then `cat` it; `browser_navigate` to a local nginx on `targets`.

- [ ] **Step 5: Commit** `feat: docker sandbox, playwright, traffic tools`

---

### Task 6: Summarizer hook

**Files:**
- Create: `plugins/neo-summarizer/src/index.ts`
- Test: `plugins/neo-summarizer/src/index.test.ts`

- [ ] **Step 1: Test** a 12k-token fake tool result is replaced; a 100-token result is untouched; failure falls back to truncate.

- [ ] **Step 2: Implement `tools/post-execute` waterfall listener.** Call `ctx.llm` with the global default provider/model, objective, and output. Cap summary to ~1500 tokens. Do not open a private HTTP client to any vendor.

- [ ] **Step 3: Commit** `feat: auto-summarize large tool outputs`

---

### Task 7: Agent presets + skills + orchestrator routing

**Files:**
- Create: all `presets/*.yml`, `skills/*/SKILL.md`, `plugins/neo-orchestrator/src/index.ts`, `workflows/*.md`

**Produces:** orchestrator can `spawn` named presets with toolFilter + persona + outputSchema.

- [ ] **Step 1: Write a preset loader** that registers each yaml as a named subagent template (wrapper around `ctx.subagents.start('spawn', { persona, toolFilter, outputSchema })`). Expose a model-facing tool `delegate({ agent_id, prompt, parallel_group? })`.

- [ ] **Step 2: Implement `delegate`** so `parallel_group` starts N children and awaits all (swarm + explore×3 + verifier×5).

- [ ] **Step 3: Author personas** from the Neo docs “What it does / How it fits in” sections. Planner/Explore/Judge must be readonly as specified.

- [ ] **Step 4: Author skills** listed above; DSH skill-filesystem discovers `skills/`.

- [ ] **Step 5: Workflow templates** `workflows/pentest.md`, `triage.md`, `code-audit.md` matching Neo’s form fields (target, schema, out-of-scope, notes, credentials, report format).

- [ ] **Step 6: Commit** `feat: neo agent presets, skills, and delegate tool`

---

### Task 8: Fast vs Thorough orchestration loop

**Files:**
- Modify: `plugins/neo-orchestrator/src/index.ts`, `workflows/pentest.md`
- Test: `tests/integration/modes.test.ts` (mocked LLM if possible; otherwise golden prompt-section snapshot)

**Produces:**
- Fast: orchestrator → one specialist → response; issues may be `unverified`.
- Thorough: clarify → planner (explore×3) → plan approval → swarm → judge → verifiers → issue_create confirmed only → report.

Use DSH plan mode for the approval gate. Inject task memory into every child via `agent.inject` on `subagent/start`.

Iteration loop (from Neo verification docs): max 2 re-executions if judge returns `needs retry` coverage gaps. Write `/workspace/verification/iteration-N.md`.

- [ ] **Step 1: Snapshot-test the orchestrator system prompt** contains mode machine and agent catalog.

- [ ] **Step 2: Implement mode machine** as prompt + `delegate` policy, not a second loop.

- [ ] **Step 3: Commit** `feat: fast and thorough orchestration`

---

### Task 9: Optional Ghidra profile + Deploy agent isolation

**Files:**
- Create: `docker/ghidra/Dockerfile`, `docker-compose.ghidra.yml`, `plugins/neo-tools-deploy/src/index.ts`

**Produces:** `docker compose --profile ghidra up` starts GhidraMCP. Deploy tool can only `docker compose -p neo-target-$id` on network `targets`.

- [ ] **Step 1: Ghidra image** with [GhidraMCP](https://github.com/LaurieWired/GhidraMCP) (or current maintained fork; pick one at implement time). Headless analyze + MCP HTTP.

- [ ] **Step 2: Deploy tool** `deploy_up({ source: 'git'|'image'|'compose', ref })` / `deploy_down({ id })`. Refuse networks other than `targets`.

- [ ] **Step 3: Commit** `feat: ghidra profile and isolated deploy tool`

---

### Task 10: End-to-end lab and docs

**Files:**
- Create: `tests/fixtures/juice-shop/docker-compose.yml` (or DVWA), `README.md` runbook, `docs/agents.md` (replica map)

**Produces:** documented path:

```
cp .env.example .env   # fill NEO_LLM_API_KEY (or catalog key) and EXA_API_KEY
# optional: set NEO_LLM_PROVIDER / NEO_LLM_MODEL / NEO_LLM_BASE_URL
docker compose up --build
# open http://127.0.0.1:3080
# Thorough pentest against juice-shop on the targets network
```

- [ ] **Step 1: Add juice-shop** on `targets` as optional `--profile lab`.

- [ ] **Step 2: Write README** with architecture, agent map, skipped closed-source items, **LLM provider table** (`NEO_LLM_*` examples for DeepSeek, OpenAI, Anthropic, OpenRouter, Ollama), required keys, safety warning.

- [ ] **Step 3: Manual e2e** Fast recon against juice-shop; Thorough XSS path if keys present. Record what was verified.

- [ ] **Step 4: Commit** `docs: runbook and lab profile`

---

## Agent-by-agent replication notes

### Orchestration
- **Planner** — spawn Explore×3, optional Browser; write plan; no scans that exploit. Thorough only.
- **Agent Swarm** — `delegate` with parallel groups; lifecycle = subagent start/end events; on child error, re-delegate once.

### Discovery
- **Recon** — subfinder, dnsx, tlsx, asnmap, crt.sh via Exa/fetch. Inventory JSON for downstream.
- **ProjectDiscovery Agent** — local nuclei-templates clone; PDCP REST only if key present.
- **Research** — Exa `search` + `contents`; GitHub via Exa; no second search vendor.
- **CVE Intelligence** — `vulnx` in sandbox + Exa for “in the wild”.
- **Explore** — active recon allowed (httpx, nmap, naabu) but read-only regarding exploitation and issue filing.

### Testing
- **Sandbox** — default; nuclei/nmap/ffuf/sqlmap/curl via bash.
- **Browser** — Playwright CDP, screenshots, JS eval, auth cookies from secrets.
- **API Security** — parse OpenAPI from upload or URL; test authz/IDOR/mass-assignment; GraphQL introspection.
- **XSS** — classify reflection context; confirm in browser; blind XSS via oast.
- **Red Team** — VPN/SSH if configured in sandbox; lockout guard in persona + optional hydra wrapper that enforces `-t`/`fail` caps.
- **Android / iOS** — fail-closed stubs.
- **Ghidra** — optional compose profile.
- **Deploy** — docker on `targets` network only.

### Analysis
- **Vuln Triage** — paste/attach workflow first; GitHub Advisory API if token; HackerOne if token.
- **GitHub Review** — `gh pr diff` + six-dimension gate; post comments only if `GITHUB_TOKEN` has permission (tool must ask-user before posting).
- **Verification** — split judge vs verifier (Neo docs contradict slightly; follow the verification architecture: judge has no exec tools).
- **Summarizing** — hook, not a spawnable agent.

---

## Testing strategy

- Unit tests for control API and each typed tool (no network).
- Compose smoke: tool versions, dsh dump-config, postgres migrate.
- Integration: sandbox write/read workspace; browser navigate to lab app; oast_register returns URL.
- Orchestration snapshots: system prompts and preset allowlists.
- Optional live e2e (needs API keys): Fast recon on juice-shop; skipped in CI if keys absent.

---

## Safety

- Authorization precheck text in the pentest workflow; orchestrator refuses empty allowlist.
- `scope_check` before every browser_navigate, nuclei, nmap, hydra.
- Secrets injected as env in sandbox, redacted in tool renderers.
- No CAPTCHA solving, no unscoped internet pentest by default (`NEO_ALLOWLIST`).
- README states this is for systems you are authorized to test.

---

## Risks

- DSH is developer-preview with breaking changes — pin SHA, isolate our plugins. Copy `settings.yaml` field names from that SHA; LLM env mapping is the most likely break.
- Catalog adapter ids (`openai`, `anthropic`, …) must be read from the pinned DSH tree, not assumed from this plan.
- Parallel subagents + one GPU-less API key → rate limits; swarm should cap concurrency (default 4).
- Real OOB Interactsh needs published DNS; lab default is in-network only.
- Playwright without stealth will get blocked by WAFs; acceptable vs Browserbase.
- Ghidra image is heavy; keep it optional.

---

## Done when

`docker compose up --build` with `NEO_LLM_*` (default DeepSeek) and `EXA_API_KEY` yields a working DSH Web UI that can run Fast and Thorough tasks, spawn the open-source specialists, search via Exa, execute tools in the sandbox, confirm XSS-class findings with Playwright + Interactsh, and file only verified issues to Postgres. Switching `NEO_LLM_PROVIDER` / `NEO_LLM_MODEL` (and `NEO_LLM_BASE_URL` for custom) changes the model for every agent without code changes. Closed-source/hardware agents are present as fail-closed stubs. README documents the replica map and LLM options.
