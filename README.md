# Neo (OSS replica) — runbook

Open-source replica of ProjectDiscovery Neo on DeepSeek Harness, Docker Compose, Exa search, and a globally configurable LLM.

## Legal / authorized testing only

Use this project **only** against systems you own or have explicit written authorization to test. `NEO_ALLOWLIST` defaults to deny: out-of-scope hosts are blocked unless explicitly allowlisted. This toolkit does **not** solve CAPTCHAs or bypass access controls outside authorized testing.

## Setup

```bash
cp .env.example .env
# Fill at least NEO_LLM_API_KEY and EXA_API_KEY
```

## Start

```bash
docker compose up --build
```

Open the harness UI: [http://127.0.0.1:3080](http://127.0.0.1:3080)

## Lab targets

Optional vulnerable apps on the isolated `targets` network (no host ports):

```bash
docker compose --profile lab up -d
```

Includes OWASP Juice Shop (`juice-shop`) reachable only from the sandbox on `targets`.

## LLM providers

Set `NEO_LLM_PROVIDER`, `NEO_LLM_MODEL`, and `NEO_LLM_API_KEY` (and `NEO_LLM_BASE_URL` when needed):

| Provider     | Notes                                      |
|--------------|--------------------------------------------|
| `deepseek`   | Default; set API key in `.env`             |
| `openai`     | OpenAI API                                 |
| `anthropic`  | Anthropic Claude API                       |
| `openrouter` | OpenRouter router                          |
| `custom`     | Custom/OpenAI-compatible (e.g. Ollama) via `NEO_LLM_BASE_URL` |

`NEO_LLM_*` is the model for the parent chat and for every delegated child. Two optional roles split that:

| Role | Env prefix | Who uses it |
|------|------------|-------------|
| Orchestration | `NEO_LLM_ORCHESTRATOR_*` | New top-level chats. An existing chat keeps the model it was pinned to. |
| Workhorse | `NEO_LLM_WORKHORSE_*` | Every `delegate()` child, including planner, swarm, judge, and children they spawn. |

A role is active only when its `_MODEL` is set. Other fields for that role fall back to `NEO_LLM_*` when the provider matches. A different provider needs its own key (and `BASE_URL` for `custom`). When the workhorse is unset, children inherit the parent model. Tool summarization uses the model of the agent that executed the tool, so a child summary runs on the workhorse and a parent summary runs on the parent model.

```bash
# Parent chat on Claude, specialists on DeepSeek.
NEO_LLM_PROVIDER=deepseek
NEO_LLM_MODEL=deepseek-v4-flash
NEO_LLM_API_KEY=sk-deepseek
NEO_LLM_ORCHESTRATOR_PROVIDER=anthropic
NEO_LLM_ORCHESTRATOR_MODEL=claude-sonnet-4-5
NEO_LLM_ORCHESTRATOR_API_KEY=sk-ant
NEO_LLM_WORKHORSE_MODEL=deepseek-v4-flash
```

Compose env is applied on every boot. Start a new chat after changing the parent model.

The `dsh` image builds DeepSeek Harness `5badb15009ae1756c3afe0ae0cef1faafc290ccc` (`dsh@0.2.1-alpha.1`). Provider, model, and credential are written to `$DSH_HOME/neo-llm.patch.yml` and passed as `dsh --patch`. `settings.yaml` is a one-shot legacy import; a leftover file is renamed to `settings.yaml.neo-legacy` and is not applied.

A `dsh-home` volume created on harness 0.1 may not open old chats. Start a new chat. Leave the volume in place, and do not run `migrate:sessions-to-v4` unless you choose to migrate those logs yourself.

## Skipped / out of v1

- Browserbase / CAPTCHA solving
- Genymotion cloud Android
- Jailbroken iOS device farm
- ProjectDiscovery Cloud Platform (PDCP) unless `PDCP_API_KEY` is set
- Kata containers / Autospawn
- Neo in-house proprietary tools

## Mobile agents (fail-closed)

Android and iOS agent presets ship with personas/skills but **fail closed** at runtime if hardware is missing (`ANDROID_SERIAL` / `IOS_SSH_HOST`). The swarm continues without them.

## Layout

| Service      | Role                                         |
|--------------|----------------------------------------------|
| `dsh`        | DeepSeek Harness agent runtime               |
| `sandbox`    | Security toolchain + shared `/workspace`     |
| `browser`    | Headless Chromium CDP (internal)             |
| `interactsh` | OAST server (in-network; needs `-domain`)    |
| `postgres`   | Issues + task memory                         |
| `control`    | Issues/memory HTTP API                       |
| `juice-shop` | Lab target (`--profile lab`, `targets` only) |

Networks: `control` (orchestration) and `targets` (sandbox + lab apps only).

The `dsh` service sets `DSH_PERMISSION_MODE=danger-full-access`. Isolation is the `sandbox` container (`sandbox_exec`), not DSH’s same-world `workspace-write` backend (bubblewrap / Landlock / macOS `sandbox-exec` / Windows ACL runner). That backend is not usable in this image, and DSH fail-closes rather than running unconfined — you would see:

```
sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host
```

Start a **new** chat after this change: existing sessions pin sandbox mode at creation. Override with `DSH_PERMISSION_MODE=workspace-write` only if a backend is actually usable.

Interactsh 1.3+ requires a domain and will exit with `No domains specified` if you omit it. Compose passes `-domain oast.neo.internal` by default (`INTERACTSH_DOMAIN`). That is a canary suffix for lab HTTP callbacks, not a public DNS zone. Recreate the service after pulling this change:

```bash
docker compose up -d interactsh
```

## Docs

- Agent roster: [`docs/agents.md`](docs/agents.md)
- Plan: `docs/superpowers/plans/2026-08-19-neo-replica.md`
