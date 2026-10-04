# Models

Set `NEO_LLM_PROVIDER`, `NEO_LLM_MODEL`, and `NEO_LLM_API_KEY` in `.env`. Set `NEO_LLM_BASE_URL` when the provider needs it. Subscription aliases omit the API key and default `NEO_LLM_MODEL` from the pinned pi-ai catalog.

| Provider | Notes |
| --- | --- |
| `deepseek` | Default. Set the API key in `.env`. |
| `openai` | OpenAI API. |
| `anthropic` | Anthropic Claude API. |
| `openrouter` | OpenRouter. |
| `custom` | OpenAI-compatible endpoint, such as Ollama, via `NEO_LLM_BASE_URL`. |
| `chatgpt` | ChatGPT Plus or Pro via Codex OAuth (`openai-codex`). No API key. Can be used alongside `openai`. |
| `claude` | Claude Pro or Max OAuth on the `anthropic` route. Cannot share a process with an `anthropic` API key. |
| `grok` | SuperGrok or X Premium OAuth (`xai`). No API key. |

`NEO_LLM_*` is the model for the parent chat and for every delegated child. Two optional roles split that:

| Role | Env prefix | Who uses it |
| --- | --- | --- |
| Orchestration | `NEO_LLM_ORCHESTRATOR_*` | New top-level chats. An existing chat keeps the model it was pinned to. |
| Workhorse | `NEO_LLM_WORKHORSE_*` | Every `delegate()` child, including planner, swarm, judge, and children they spawn. |

A role is active only when its `_MODEL` is set. `chatgpt`, `claude`, and `grok` default the model when another field for that role is set. Other fields for that role fall back to `NEO_LLM_*` when the provider matches. A different provider needs its own key, and `BASE_URL` for `custom`. When the workhorse is unset, children inherit the parent model. Tool summarization uses the model of the agent that executed the tool, so a child summary runs on the workhorse and a parent summary runs on the parent model.

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

## Subscription sign-in

Subscription aliases import CLI credentials on boot into `$DSH_HOME/.credentials.yaml`. Uncomment the matching read-only mount in `docker-compose.yml` after the host directory exists. Compose creates a missing bind as an empty directory.

```bash
# ~/.codex  → /host-auth/codex   (auth.json)
# ~/.claude → /host-auth/claude  (.credentials.json)
# ~/.grok   → /host-auth/grok    (auth.json)
NEO_LLM_PROVIDER=chatgpt
# NEO_LLM_MODEL=                 # optional; chatgpt=gpt-5.5, claude=claude-sonnet-4-5, grok=grok-4.7
```

A host file wins over a stored grant. If neither is present, startup fails and prints mount instructions. Override the in-container path with `NEO_LLM_OAUTH_CHATGPT_FILE`, `NEO_LLM_OAUTH_CLAUDE_FILE`, or `NEO_LLM_OAUTH_GROK_FILE`. ChatGPT Codex device-code login publishes no extra ports. Turn on “Enable device code authorization for Codex” in ChatGPT settings first.

## How settings are applied

Compose env is applied on every boot. Start a new chat after changing the parent model.

The `dsh` image builds DeepSeek Harness `5badb15009ae1756c3afe0ae0cef1faafc290ccc` (`dsh@0.2.1-alpha.1`). Provider, model, and credential are written to `$DSH_HOME/neo-llm.patch.yml` and passed as `dsh --patch`. `settings.yaml` is a one-shot legacy import. A leftover file is renamed to `settings.yaml.neo-legacy` and is not applied.

A `dsh-home` volume created on harness 0.1 may not open old chats. Start a new chat. Leave the volume in place. Do not run `migrate:sessions-to-v4` unless you choose to migrate those logs yourself.
