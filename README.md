# Neo

Neo is a local workspace for assessing systems you are authorized to test. It runs [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) with task-scoped tools, Docker lab workers, browser automation, and a record of the assessment.

## Requirements

- Docker Engine with volume-subpath support
- Docker Compose v2

## Start

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env`. Set `NEO_LLM_API_KEY`, set `NEO_ALLOWLIST` to the hosts you are authorized to assess, and generate each of these with `openssl rand -hex 32`:

- `NEO_DB_PASSWORD`
- `NEO_CONTROL_ADMIN_TOKEN`
- `NEO_CONTROL_BROKER_TOKEN`
- `INTERACTSH_TOKEN`

The sample model is DeepSeek. Other providers are in [Models](docs/llm.md).

```bash
docker compose up -d --build
docker compose logs --tail 20 dsh
```

Open the `http://127.0.0.1:3080/?token=…` link from those logs. The UI is on loopback. Put an authenticated gateway in front of it before exposing it beyond this machine.

Compose does not create a task. Set `NEO_MODE_DEFAULT` to `thorough` or `fast` (`thorough` when unset), open the UI, and type the job. That message is the task, and its allowlist is `NEO_ALLOWLIST`. [Assessment workflow](docs/workflow.md) covers plan approval and binding a task you create yourself.

## Read next

- [Assessment workflow](docs/workflow.md) covers plans, approval, findings, and finishing a task.
- [Models](docs/llm.md) covers API providers, subscription sign-in, and separate orchestrator and workhorse models.
- [Execution and lab limits](docs/execution.md) covers what workers, deploys, and the browser may do.
- [Operations](docs/operations.md) covers backups, recovery, credentials, and capability reporting.
- [Agents](docs/agents.md) lists which specialist runs which preset.
- [Checks](docs/checks.md) lists typecheck and test commands for changes to Neo.

The folder index is [docs/README.md](docs/README.md).
