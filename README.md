# Neo — local assessment workspace

Neo combines DeepSeek Harness, task-scoped tools, Docker lab workers, browser automation, and durable assessment state. Use it for systems you are authorized to assess.

## Setup and task creation

Use Node **22.19+ within 22.x, or >=24** (`.node-version` pins the tested version), Docker Engine with volume-subpath support, and Docker Compose v2.

```bash
npm run setup
cp .env.example .env
chmod 600 .env
```

Fill the model/API settings and generate independent `NEO_DB_PASSWORD`, `NEO_CONTROL_ADMIN_TOKEN`, `NEO_CONTROL_BROKER_TOKEN`, and `INTERACTSH_TOKEN` values (for example, `openssl rand -hex 32`). Keep the operator and broker credentials out of agent containers. A task-specific credential is the only control credential passed to DSH.

```bash
docker compose up -d --build postgres control
umask 077
printf '%s' '{"mode":"thorough","objective":"Assess the local lab","allowlist":["lab-app"],"denylist":[]}' \
  | docker compose exec -T control node dist/operator.js create > .neo-task.json
export NEO_TASK_ID="$(jq -r .id .neo-task.json)"
export NEO_TASK_TOKEN="$(jq -r .task_token .neo-task.json)"
docker compose up -d --build
```

Run `docker compose logs --tail 20 dsh` and open the printed `http://127.0.0.1:3080/?token=…` URL. The UI requires that generated login token and is bound to loopback; control and Postgres have no host ports. Do not expose the UI remotely without an authenticated access gateway. DSH verifies the task and reads its mode from control at startup.

Task creation is deliberate: missing IDs, invented session IDs, mismatched task credentials, and unapproved scope changes are rejected. To resume later, export the same ID and token before starting DSH. Keep `.neo-task.json` private; it is excluded from Git and Docker contexts.

## Assessment workflow

Fast tasks execute without the plan approval step and record candidate findings. Thorough tasks first use the planner and read-only exploration. `task_get` exposes the current task/plan revisions; `plan_submit` persists the plan, then the operator inspects it:

```bash
docker compose exec -T control node dist/operator.js inspect "$NEO_TASK_ID"
# Substitute the current revision and plan_revision from inspect:
printf '%s' '{"revision":1,"plan_revision":1}' \
  | docker compose exec -T control node dist/operator.js approve "$NEO_TASK_ID"
```

Only the independent operator credential can approve the plan or change scope. Changes to the plan, objective, mode, or scope invalidate approval. The agent creates candidate issues; a separate verifier run records immutable evidence with `verification_record`, and `issue_update` references that proof when confirming the issue. Updates carry revisions so concurrent writes fail visibly instead of silently losing changes.

Use `task_update` to move a task through `pending`, `running`, and `completed` or `cancelled`. Terminal tasks reject further execution and writes; owned deployment cleanup and cancellation remain available. Create a new task for another assessment.

## Execution and lab limits

Only the broker owns the host Docker socket. Workers run without that socket, credentials, host mounts, extra capabilities, or sudo. Commands use `sandbox_exec`; direct harness shell tools are blocked. File tools are confined to `/workspace/tasks/<task-id>`, with read-only access to packaged skills and workflows.

`NEO_EXEC_NETWORK=none` is the default. Set `lab` to allow commands to reach authorized containers owned by the same task. External arbitrary network scanners, host VPN devices, privileged containers, and mobile hardware are unsupported in this broker. Browser HTTP requests and traffic replay use the broker's current task policy and DNS checks; browser pages have no direct external network path.

`deploy_up` accepts an image or strict image-only Compose YAML/JSON with an explicit endpoint port. It rejects Dockerfile/Git builds, bind mounts, privileged settings, custom networks, public ports, and unsupported Compose fields. Example: image `node:22.23.3-bookworm-slim`, deployment ID `lab`, service `app`, port `3000`, with a service command that actually listens there. The returned endpoint becomes available only after a readiness check; allowlist its `lab-app` alias explicitly. Failed setup rolls back its containers; `deploy_down` targets persisted task-owned resources.

The optional Juice Shop profile attaches to the task lab network. Its alias must be approved for the task. HTTP OAST uses generated Interactsh payloads through the broker callback relay. DNS OAST requires separately configured callback DNS and is disabled by default. See [capability limits and operations](docs/operations.md).

## Checks

```bash
npm run check          # all package typechecks, offline tests, disposable Postgres integration
npm run test:harness   # rebuild current DSH image, then scripted real parent/child execution
npm run test:services  # real broker, browser and Interactsh container tests
npm run test:worker    # rebuild scanner image and verify tools/non-root identity
npm run check:release  # all of the above
```

No real model credentials are used by tests. `npm run test:offline` explicitly excludes Docker integration. A missing database or Docker daemon fails the corresponding integration gate. Compiled `dist` files are generated by `npm run build` and during image packaging, and are not source controlled.

## LLM providers

Set `NEO_LLM_PROVIDER`, `NEO_LLM_MODEL`, and `NEO_LLM_API_KEY` (and `NEO_LLM_BASE_URL` when needed). Subscription aliases omit the API key and default `NEO_LLM_MODEL` from the pinned pi-ai catalog:

| Provider     | Notes                                      |
|--------------|--------------------------------------------|
| `deepseek`   | Default; set API key in `.env`             |
| `openai`     | OpenAI API                                 |
| `anthropic`  | Anthropic Claude API                       |
| `openrouter` | OpenRouter router                          |
| `custom`     | Custom/OpenAI-compatible (e.g. Ollama) via `NEO_LLM_BASE_URL` |
| `chatgpt`    | ChatGPT Plus/Pro via Codex OAuth (`openai-codex`). No API key. Coexists with `openai`. |
| `claude`     | Claude Pro/Max OAuth (`anthropic` route). Cannot share a process with the `anthropic` API key. |
| `grok`       | SuperGrok / X Premium OAuth (`xai`). No API key. |

`NEO_LLM_*` is the model for the parent chat and for every delegated child. Two optional roles split that:

| Role | Env prefix | Who uses it |
|------|------------|-------------|
| Orchestration | `NEO_LLM_ORCHESTRATOR_*` | New top-level chats. An existing chat keeps the model it was pinned to. |
| Workhorse | `NEO_LLM_WORKHORSE_*` | Every `delegate()` child, including planner, swarm, judge, and children they spawn. |

A role is active only when its `_MODEL` is set (`chatgpt` / `claude` / `grok` default the model when another field for that role is set). Other fields for that role fall back to `NEO_LLM_*` when the provider matches. A different provider needs its own key (and `BASE_URL` for `custom`). When the workhorse is unset, children inherit the parent model. Tool summarization uses the model of the agent that executed the tool, so a child summary runs on the workhorse and a parent summary runs on the parent model.

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

Subscription aliases import CLI credentials on boot into `$DSH_HOME/.credentials.yaml`. Uncomment the matching read-only mount in `docker-compose.yml` after the host directory exists (Compose creates a missing bind as an empty directory):

```bash
# ~/.codex  → /host-auth/codex   (auth.json)
# ~/.claude → /host-auth/claude  (.credentials.json)
# ~/.grok   → /host-auth/grok    (auth.json)
NEO_LLM_PROVIDER=chatgpt
# NEO_LLM_MODEL=                 # optional; chatgpt=gpt-5.5, claude=claude-sonnet-4-5, grok=grok-4.7
```

A host file wins over a stored grant. If neither is present, startup fails closed with mount instructions. Override the in-container path with `NEO_LLM_OAUTH_CHATGPT_FILE`, `NEO_LLM_OAUTH_CLAUDE_FILE`, or `NEO_LLM_OAUTH_GROK_FILE`. ChatGPT Codex device-code (no extra published ports) needs “Enable device code authorization for Codex” in ChatGPT settings.

Compose env is applied on every boot. Start a new chat after changing the parent model.

The `dsh` image builds DeepSeek Harness `5badb15009ae1756c3afe0ae0cef1faafc290ccc` (`dsh@0.2.1-alpha.1`). Provider, model, and credential are written to `$DSH_HOME/neo-llm.patch.yml` and passed as `dsh --patch`. `settings.yaml` is a one-shot legacy import; a leftover file is renamed to `settings.yaml.neo-legacy` and is not applied.

A `dsh-home` volume created on harness 0.1 may not open old chats. Start a new chat. Leave the volume in place, and do not run `migrate:sessions-to-v4` unless you choose to migrate those logs yourself.

## Documentation

- [Operations, backup, recovery, and capabilities](docs/operations.md)
- [Agent roster](docs/agents.md)
- [Review findings](docs/reviews/2026-10-04-review.md)
- [Remediation plan and status](docs/plans/2026-10-04-remediation.md)
