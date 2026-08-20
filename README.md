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

All agents and the summarizer share one global provider/model.

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
| `interactsh` | OAST server (in-network)                     |
| `postgres`   | Issues + task memory                         |
| `control`    | Issues/memory HTTP API                       |
| `juice-shop` | Lab target (`--profile lab`, `targets` only) |

Networks: `control` (orchestration) and `targets` (sandbox + lab apps only).

## Docs

- Agent roster: [`docs/agents.md`](docs/agents.md)
- Plan: `docs/superpowers/plans/2026-08-19-neo-replica.md`
