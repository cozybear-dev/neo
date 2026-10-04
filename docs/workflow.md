# Assessment workflow

Set `NEO_ALLOWLIST` to the hosts you are authorized to assess, and set `NEO_MODE_DEFAULT` to `thorough` or `fast`. `thorough` is the default. Then start the stack and open the UI:

```bash
docker compose up -d --build
```

Type the job in the chat. That message is the task. Control copies `NEO_ALLOWLIST` onto it and stores `NEO_MODE_DEFAULT`. Each chat opens its own task. Compose does not create one, and an empty allowlist cannot open one.

Missing ids, invented session ids, mismatched task credentials, and unapproved scope changes are rejected.

## A task you create yourself

Leave `NEO_TASK_ID` and `NEO_TASK_TOKEN` empty for the path above. Set both only when every chat should use a task you created while the stack is up. The operator credential stays in the control service.

```bash
umask 077
printf '%s' '{"mode":"thorough","objective":"Assess the staging app","allowlist":["app.example"],"denylist":[]}' \
  | docker compose exec -T control node dist/operator.js create > .neo-task.json
```

Put `id` and `task_token` from that file into `.env` as `NEO_TASK_ID` and `NEO_TASK_TOKEN`, then run `docker compose up -d`. Those hosts must also be on `NEO_ALLOWLIST`. Keep `.neo-task.json` private. It is excluded from Git.

## Fast and thorough

Fast tasks execute without the plan approval step and record candidate findings. Thorough tasks first use the planner and read-only exploration. `task_get` exposes the current task and plan revisions. `plan_submit` persists the plan, then the operator approves that task id (`NEO_TASK_ID` only when you bound one):

```bash
docker compose exec -T control node dist/operator.js inspect "$TASK_ID"
# Substitute the current revision and plan_revision from inspect:
printf '%s' '{"revision":1,"plan_revision":1}' \
  | docker compose exec -T control node dist/operator.js approve "$TASK_ID"
```

Only the independent operator credential can approve the plan or change scope. Changes to the plan, objective, mode, or scope invalidate approval. The agent creates candidate issues. A separate verifier run records immutable evidence with `verification_record`, and `issue_update` references that proof when confirming the issue. Updates carry revisions so concurrent writes fail visibly.

## Finish or resume

Use `task_update` to move a task through `pending`, `running`, and `completed` or `cancelled`. Terminal tasks reject further execution and writes. Owned deployment cleanup and cancellation remain available. Create a new task for another assessment.

What the running task is allowed to touch is in [Execution and lab limits](execution.md). Day-to-day service care is in [Operations](operations.md).
