import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  LlmSettingsError,
  mappedCredentialEnv,
  mappedProfileEnv,
  mergeSettingsYaml,
  renderOwnedSettings,
  renderProfileSettings,
  resolveLlmProfile,
  resolveLlmSelection,
} from '../../docker/dsh/render-llm-settings.mjs'

const renderer = fileURLToPath(new URL('../../docker/dsh/render-llm-settings.mjs', import.meta.url))

function runRenderer(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [renderer, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ...env,
    },
  })
}

describe('resolveLlmSelection', () => {
  it('maps deepseek onto the native deepseek-official route', () => {
    const selection = resolveLlmSelection({
      NEO_LLM_PROVIDER: 'deepseek',
      NEO_LLM_MODEL: 'deepseek-v4-flash',
      NEO_LLM_API_KEY: 'sk-test',
    })
    assert.equal(selection.kind, 'native')
    assert.equal(selection.route, 'deepseek-official')
    assert.equal(selection.keyEnvName, 'DEEPSEEK_API_KEY')
    assert.equal(mappedCredentialEnv(selection).DEEPSEEK_API_KEY, 'sk-test')
  })

  it('accepts a catalog native key when NEO_LLM_API_KEY is empty', () => {
    const selection = resolveLlmSelection({
      NEO_LLM_PROVIDER: 'openai',
      NEO_LLM_MODEL: 'gpt-4.1',
      OPENAI_API_KEY: 'sk-openai',
    })
    assert.equal(selection.route, 'openai')
    assert.equal(selection.apiKey, 'sk-openai')
  })

  it('lets NEO_LLM_API_KEY win over a catalog native key', () => {
    const selection = resolveLlmSelection({
      NEO_LLM_PROVIDER: 'anthropic',
      NEO_LLM_MODEL: 'claude-sonnet-4-5',
      NEO_LLM_API_KEY: 'sk-neo',
      ANTHROPIC_API_KEY: 'sk-old',
    })
    assert.equal(selection.apiKey, 'sk-neo')
    assert.equal(mappedCredentialEnv(selection).ANTHROPIC_API_KEY, 'sk-neo')
  })
})

describe('renderOwnedSettings', () => {
  it('deepseek → agent-default-model only, no llm-pi-ai row', () => {
    const yaml = renderOwnedSettings(resolveLlmSelection({
      NEO_LLM_PROVIDER: 'deepseek',
      NEO_LLM_MODEL: 'deepseek-v4-flash',
      NEO_LLM_API_KEY: 'sk-test',
    }))
    assert.match(yaml, /^- id: agent-default-model$/m)
    assert.match(yaml, /provider: "deepseek-official"/)
    assert.match(yaml, /model: "deepseek-v4-flash"/)
    assert.doesNotMatch(yaml, /llm-pi-ai/)
    assert.doesNotMatch(yaml, /baseURL:/)
    assert.doesNotMatch(yaml, /\bcustom:/)
  })

  it('custom → baseURL present with apiKeyEnv / api / models[{id}]', () => {
    const yaml = renderOwnedSettings(resolveLlmSelection({
      NEO_LLM_PROVIDER: 'custom',
      NEO_LLM_MODEL: 'qwen3:8b',
      NEO_LLM_BASE_URL: 'http://host.docker.internal:11434/v1',
      NEO_LLM_API: 'openai-completions',
      NEO_LLM_API_KEY: 'ollama',
    }))
    assert.match(yaml, /^- id: agent-default-model$/m)
    assert.match(yaml, /provider: "custom"/)
    assert.match(yaml, /model: "qwen3:8b"/)
    assert.match(yaml, /^- id: llm-pi-ai$/m)
    assert.match(yaml, /baseURL: "http:\/\/host\.docker\.internal:11434\/v1"/)
    assert.match(yaml, /apiKeyEnv: "NEO_LLM_API_KEY"/)
    assert.match(yaml, /api: "openai-completions"/)
    assert.match(yaml, /- id: "qwen3:8b"/)
  })

  it('openai catalog route emits llm-pi-ai with only apiKeyEnv', () => {
    const yaml = renderOwnedSettings(resolveLlmSelection({
      NEO_LLM_PROVIDER: 'openai',
      NEO_LLM_MODEL: 'gpt-4.1',
      NEO_LLM_API_KEY: 'sk-openai',
    }))
    assert.match(yaml, /provider: "openai"/)
    assert.match(yaml, /model: "gpt-4.1"/)
    assert.match(yaml, /^- id: llm-pi-ai$/m)
    assert.match(yaml, /apiKeyEnv: "OPENAI_API_KEY"/)
    assert.doesNotMatch(yaml, /baseURL:/)
    assert.doesNotMatch(yaml, /^\s*api:/m)
    assert.doesNotMatch(yaml, /models:/)
    assert.equal(mappedCredentialEnv(resolveLlmSelection({
      NEO_LLM_PROVIDER: 'openai',
      NEO_LLM_MODEL: 'gpt-4.1',
      NEO_LLM_API_KEY: 'sk-openai',
    })).OPENAI_API_KEY, 'sk-openai')
  })
})

describe('subscription oauth providers', () => {
  it('chatgpt maps onto openai-codex without an API key', () => {
    const selection = resolveLlmSelection({
      NEO_LLM_PROVIDER: 'chatgpt',
    })
    assert.equal(selection.kind, 'oauth')
    assert.equal(selection.route, 'openai-codex')
    assert.equal(selection.model, 'gpt-5.5')
    assert.equal(selection.apiKey, '')
    const yaml = renderOwnedSettings(selection)
    assert.match(yaml, /provider: "openai-codex"/)
    assert.match(yaml, /model: "gpt-5.5"/)
    assert.match(yaml, /openai-codex:\s*\{\}/)
    assert.doesNotMatch(yaml, /apiKeyEnv:/)
    assert.equal(mappedCredentialEnv(selection).OPENAI_API_KEY, undefined)
  })

  it('claude and grok use catalog defaults and keep an explicit model', () => {
    const claude = resolveLlmSelection({ NEO_LLM_PROVIDER: 'claude' })
    assert.equal(claude.route, 'anthropic')
    assert.equal(claude.model, 'claude-sonnet-4-5')
    const grok = resolveLlmSelection({
      NEO_LLM_PROVIDER: 'grok',
      NEO_LLM_MODEL: 'grok-4.5',
    })
    assert.equal(grok.route, 'xai')
    assert.equal(grok.model, 'grok-4.5')
  })

  it('chatgpt plus openai API key is two routes', () => {
    const profile = resolveLlmProfile({
      NEO_LLM_PROVIDER: 'chatgpt',
      NEO_LLM_WORKHORSE_PROVIDER: 'openai',
      NEO_LLM_WORKHORSE_MODEL: 'gpt-4.1',
      NEO_LLM_WORKHORSE_API_KEY: 'sk-openai',
    })
    const yaml = renderProfileSettings('', profile)
    assert.match(yaml, /provider: "openai-codex"/)
    assert.match(yaml, /openai-codex:\s*\{\}/)
    assert.match(yaml, /apiKeyEnv: "OPENAI_API_KEY"/)
    assert.equal(mappedProfileEnv(profile).OPENAI_API_KEY, 'sk-openai')
    assert.equal(mappedProfileEnv(profile).NEO_RESOLVED_WORKHORSE_PROVIDER, 'openai')
  })

  it('rejects claude subscription and anthropic API key on one profile', () => {
    assert.throws(
      () => resolveLlmProfile({
        NEO_LLM_PROVIDER: 'claude',
        NEO_LLM_WORKHORSE_PROVIDER: 'anthropic',
        NEO_LLM_WORKHORSE_MODEL: 'claude-sonnet-4-5',
        NEO_LLM_WORKHORSE_API_KEY: 'sk-ant',
      }),
      (error: unknown) => error instanceof LlmSettingsError
        && /claude subscription and anthropic API key cannot share the anthropic route/.test((error as Error).message),
    )
  })
})

describe('validation', () => {
  it('missing key for a cloud provider fails', () => {
    assert.throws(
      () => resolveLlmSelection({
        NEO_LLM_PROVIDER: 'deepseek',
        NEO_LLM_MODEL: 'deepseek-v4-flash',
        NEO_LLM_API_KEY: '',
      }),
      (error: unknown) => error instanceof LlmSettingsError
        && /DEEPSEEK_API_KEY or NEO_LLM_API_KEY/.test((error as Error).message),
    )
  })

  it('custom without NEO_LLM_BASE_URL fails', () => {
    assert.throws(
      () => resolveLlmSelection({
        NEO_LLM_PROVIDER: 'custom',
        NEO_LLM_MODEL: 'qwen3:8b',
        NEO_LLM_API_KEY: 'ollama',
      }),
      (error: unknown) => error instanceof LlmSettingsError
        && /NEO_LLM_BASE_URL/.test((error as Error).message),
    )
  })

  it('custom without NEO_LLM_MODEL fails', () => {
    assert.throws(
      () => resolveLlmSelection({
        NEO_LLM_PROVIDER: 'custom',
        NEO_LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
      }),
      (error: unknown) => error instanceof LlmSettingsError
        && /NEO_LLM_MODEL/.test((error as Error).message),
    )
  })

  it('unknown provider fails', () => {
    assert.throws(
      () => resolveLlmSelection({
        NEO_LLM_PROVIDER: 'not-a-provider',
        NEO_LLM_MODEL: 'x',
        NEO_LLM_API_KEY: 'k',
      }),
      LlmSettingsError,
    )
  })
})

describe('mergeSettingsYaml env wins', () => {
  it('openai does not wipe catalog llm-pi-ai api / models / baseURL', () => {
    const existing = [
      'llm-pi-ai:',
      '  providers:',
      '    openai:',
      '      apiKeyEnv: OPENAI_API_KEY',
      '      api: openai-completions',
      '      baseURL: https://proxy.example.com:8443',
      '      models:',
      '        - id: gpt-4.1',
      '          contextWindow: 200000',
      'agent-default-model:',
      '  provider: openai',
      '  model: stale',
      '',
    ].join('\n')
    const yaml = mergeSettingsYaml(existing, resolveLlmSelection({
      NEO_LLM_PROVIDER: 'openai',
      NEO_LLM_MODEL: 'gpt-4.1',
      NEO_LLM_API_KEY: 'sk-openai',
    }))
    assert.match(yaml, /provider: "openai"/)
    assert.match(yaml, /model: "gpt-4.1"/)
    assert.match(yaml, /api: openai-completions/)
    assert.match(yaml, /baseURL: https:\/\/proxy\.example\.com:8443/)
    assert.match(yaml, /id: gpt-4.1/)
    assert.match(yaml, /contextWindow: 200000/)
    assert.doesNotMatch(yaml, /model: stale/)
  })

  it('custom upserts baseURL + models without dropping a sibling catalog route', () => {
    const existing = [
      'llm-pi-ai:',
      '  providers:',
      '    openai:',
      '      apiKeyEnv: OPENAI_API_KEY',
      '      models:',
      '        - id: gpt-4.1',
      '',
    ].join('\n')
    const yaml = mergeSettingsYaml(existing, resolveLlmSelection({
      NEO_LLM_PROVIDER: 'custom',
      NEO_LLM_MODEL: 'qwen3:8b',
      NEO_LLM_BASE_URL: 'http://host.docker.internal:11434/v1',
      NEO_LLM_API_KEY: 'ollama',
    }))
    assert.match(yaml, /openai:/)
    assert.match(yaml, /id: gpt-4.1/)
    assert.match(yaml, /custom:/)
    assert.match(yaml, /baseURL: "http:\/\/host\.docker\.internal:11434\/v1"/)
    assert.match(yaml, /- id: "qwen3:8b"/)
    assert.match(yaml, /provider: "custom"/)
  })

  it('patch-form catalog merge keeps api / models / baseURL and refreshes the model', () => {
    const existing = [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      openai:',
      '        api: openai-completions',
      '        baseURL: https://proxy.example.com:8443',
      '        models:',
      '          - id: gpt-4.1',
      '            contextWindow: 200000',
      '- id: agent-default-model',
      '  config:',
      '    provider: openai',
      '    model: stale',
      '',
    ].join('\n')
    const yaml = mergeSettingsYaml(existing, resolveLlmSelection({
      NEO_LLM_PROVIDER: 'openai',
      NEO_LLM_MODEL: 'gpt-4.1',
      NEO_LLM_API_KEY: 'sk-openai',
    }))
    assert.match(yaml, /^- id: agent-default-model$/m)
    assert.match(yaml, /provider: "openai"/)
    assert.match(yaml, /model: "gpt-4.1"/)
    assert.match(yaml, /apiKeyEnv: "OPENAI_API_KEY"/)
    assert.match(yaml, /api: openai-completions/)
    assert.match(yaml, /baseURL: https:\/\/proxy\.example\.com:8443/)
    assert.match(yaml, /id: gpt-4.1/)
    assert.match(yaml, /contextWindow: 200000/)
    assert.doesNotMatch(yaml, /model: stale/)
  })
})

const baseDeepseek = {
  NEO_LLM_PROVIDER: 'deepseek',
  NEO_LLM_MODEL: 'deepseek-v4-flash',
  NEO_LLM_API_KEY: 'sk-test',
  NEO_LLM_REASONING_EFFORT: 'high',
}

describe('resolveLlmProfile', () => {
  it('matches the one-model patch when no role is set', () => {
    const env = {
      NEO_LLM_PROVIDER: 'deepseek',
      NEO_LLM_MODEL: 'deepseek-v4-flash',
      NEO_LLM_API_KEY: 'sk-test',
    }
    const profile = resolveLlmProfile(env)
    const yaml = renderProfileSettings('', profile)
    assert.equal(yaml, renderOwnedSettings(resolveLlmSelection(env)))
    assert.equal(profile.orchestrator, undefined)
    assert.equal(profile.workhorse, undefined)
    assert.equal(mappedProfileEnv(profile).NEO_RESOLVED_WORKHORSE_MODEL, undefined)
  })

  it('orchestration model replaces the parent default and keeps the base effort', () => {
    const profile = resolveLlmProfile({
      ...baseDeepseek,
      NEO_LLM_ORCHESTRATOR_MODEL: 'deepseek-v4-pro',
    })
    const yaml = renderProfileSettings('', profile)
    assert.match(yaml, /provider: "deepseek-official"/)
    assert.match(yaml, /model: "deepseek-v4-pro"/)
    assert.match(yaml, /reasoningEffort: "high"/)
    assert.doesNotMatch(yaml, /deepseek-v4-flash/)
    assert.doesNotMatch(yaml, /llm-pi-ai/)
    assert.equal(mappedProfileEnv(profile).NEO_RESOLVED_WORKHORSE_PROVIDER, undefined)
  })

  it('orchestration effort overrides the base effort', () => {
    const profile = resolveLlmProfile({
      ...baseDeepseek,
      NEO_LLM_ORCHESTRATOR_MODEL: 'deepseek-v4-pro',
      NEO_LLM_ORCHESTRATOR_REASONING_EFFORT: 'low',
    })
    const yaml = renderProfileSettings('', profile)
    assert.match(yaml, /reasoningEffort: "low"/)
    assert.doesNotMatch(yaml, /reasoningEffort: "high"/)
  })

  it('registers a second provider when the orchestration model uses one', () => {
    const profile = resolveLlmProfile({
      ...baseDeepseek,
      NEO_LLM_ORCHESTRATOR_PROVIDER: 'anthropic',
      NEO_LLM_ORCHESTRATOR_MODEL: 'claude-sonnet-4-5',
      NEO_LLM_ORCHESTRATOR_API_KEY: 'sk-ant',
    })
    const yaml = renderProfileSettings('', profile)
    assert.match(yaml, /provider: "anthropic"/)
    assert.match(yaml, /model: "claude-sonnet-4-5"/)
    assert.match(yaml, /apiKeyEnv: "ANTHROPIC_API_KEY"/)
    assert.doesNotMatch(yaml, /deepseek-official/)
    const mapped = mappedProfileEnv(profile)
    assert.equal(mapped.DEEPSEEK_API_KEY, 'sk-test')
    assert.equal(mapped.ANTHROPIC_API_KEY, 'sk-ant')
    assert.equal(mapped.NEO_LLM_API_KEY, 'sk-test')
  })

  it('keeps the parent model when only the workhorse is set', () => {
    const profile = resolveLlmProfile({
      NEO_LLM_PROVIDER: 'openai',
      NEO_LLM_MODEL: 'gpt-4.1',
      NEO_LLM_API_KEY: 'sk-openai',
      NEO_LLM_WORKHORSE_PROVIDER: 'deepseek',
      NEO_LLM_WORKHORSE_MODEL: 'deepseek-v4-flash',
      NEO_LLM_WORKHORSE_API_KEY: 'sk-ds',
    })
    const yaml = renderProfileSettings('', profile)
    assert.match(yaml, /provider: "openai"/)
    assert.match(yaml, /model: "gpt-4.1"/)
    assert.doesNotMatch(yaml, /deepseek-v4-flash/)
    const mapped = mappedProfileEnv(profile)
    assert.equal(mapped.OPENAI_API_KEY, 'sk-openai')
    assert.equal(mapped.DEEPSEEK_API_KEY, 'sk-ds')
    assert.equal(mapped.NEO_RESOLVED_WORKHORSE_PROVIDER, 'deepseek-official')
    assert.equal(mapped.NEO_RESOLVED_WORKHORSE_MODEL, 'deepseek-v4-flash')
    assert.equal(mapped.NEO_RESOLVED_WORKHORSE_REASONING_EFFORT, undefined)
  })

  it('exports workhorse reasoning effort only when that role sets it', () => {
    const profile = resolveLlmProfile({
      ...baseDeepseek,
      NEO_LLM_WORKHORSE_MODEL: 'deepseek-v4-flash',
      NEO_LLM_WORKHORSE_REASONING_EFFORT: 'low',
    })
    const mapped = mappedProfileEnv(profile)
    assert.equal(mapped.NEO_RESOLVED_WORKHORSE_PROVIDER, 'deepseek-official')
    assert.equal(mapped.NEO_RESOLVED_WORKHORSE_REASONING_EFFORT, 'low')
    assert.match(renderProfileSettings('', profile), /reasoningEffort: "high"/)
  })

  it('lists both model ids on one custom route when the endpoint matches', () => {
    const profile = resolveLlmProfile({
      NEO_LLM_PROVIDER: 'custom',
      NEO_LLM_MODEL: 'qwen3:8b',
      NEO_LLM_BASE_URL: 'http://host.docker.internal:11434/v1',
      NEO_LLM_API_KEY: 'ollama',
      NEO_LLM_WORKHORSE_MODEL: 'qwen3:1.7b',
    })
    const yaml = renderProfileSettings('', profile)
    assert.match(yaml, /model: "qwen3:8b"/)
    assert.match(yaml, /id: "qwen3:8b"/)
    assert.match(yaml, /id: "qwen3:1.7b"/)
    assert.doesNotMatch(yaml, /custom-workhorse/)
    assert.equal(mappedProfileEnv(profile).NEO_RESOLVED_WORKHORSE_PROVIDER, 'custom')
    assert.equal(mappedProfileEnv(profile).NEO_RESOLVED_WORKHORSE_MODEL, 'qwen3:1.7b')
  })

  it('uses a second custom route when the workhorse base URL differs', () => {
    const profile = resolveLlmProfile({
      NEO_LLM_PROVIDER: 'custom',
      NEO_LLM_MODEL: 'qwen3:8b',
      NEO_LLM_BASE_URL: 'http://host-a.invalid/v1',
      NEO_LLM_API_KEY: 'ollama',
      NEO_LLM_WORKHORSE_MODEL: 'llama3:8b',
      NEO_LLM_WORKHORSE_BASE_URL: 'http://host-b.invalid/v1',
      NEO_LLM_WORKHORSE_API_KEY: 'other',
    })
    const yaml = renderProfileSettings('', profile)
    assert.match(yaml, /custom-workhorse:/)
    assert.match(yaml, /baseURL: "http:\/\/host-a.invalid\/v1"/)
    assert.match(yaml, /baseURL: "http:\/\/host-b.invalid\/v1"/)
    assert.equal(mappedProfileEnv(profile).NEO_RESOLVED_WORKHORSE_PROVIDER, 'custom-workhorse')
    assert.equal(mappedProfileEnv(profile).NEO_LLM_WORKHORSE_API_KEY, 'other')
  })

  it('names an orchestration-only custom endpoint custom-orchestrator', () => {
    const profile = resolveLlmProfile({
      ...baseDeepseek,
      NEO_LLM_ORCHESTRATOR_PROVIDER: 'custom',
      NEO_LLM_ORCHESTRATOR_MODEL: 'orchestrator-local',
      NEO_LLM_ORCHESTRATOR_BASE_URL: 'http://orch.invalid/v1',
      NEO_LLM_ORCHESTRATOR_API_KEY: 'orch-key',
    })
    const yaml = renderProfileSettings('', profile)
    assert.match(yaml, /provider: "custom-orchestrator"/)
    assert.match(yaml, /model: "orchestrator-local"/)
    assert.match(yaml, /custom-orchestrator:/)
    assert.equal(mappedProfileEnv(profile).NEO_LLM_ORCHESTRATOR_API_KEY, 'orch-key')
  })

  it('rejects a role field without a model', () => {
    assert.throws(
      () => resolveLlmProfile({
        ...baseDeepseek,
        NEO_LLM_WORKHORSE_PROVIDER: 'openai',
      }),
      (error: unknown) => error instanceof LlmSettingsError
        && /NEO_LLM_WORKHORSE_MODEL/.test((error as Error).message),
    )
  })

  it('rejects two keys on one route', () => {
    assert.throws(
      () => resolveLlmProfile({
        NEO_LLM_PROVIDER: 'openai',
        NEO_LLM_MODEL: 'gpt-4.1',
        NEO_LLM_API_KEY: 'sk-a',
        NEO_LLM_WORKHORSE_PROVIDER: 'openai',
        NEO_LLM_WORKHORSE_MODEL: 'gpt-4.1-mini',
        NEO_LLM_WORKHORSE_API_KEY: 'sk-b',
      }),
      (error: unknown) => error instanceof LlmSettingsError
        && /key/i.test((error as Error).message),
    )
  })

  it('requires a base URL for a custom role on another provider', () => {
    assert.throws(
      () => resolveLlmProfile({
        ...baseDeepseek,
        NEO_LLM_WORKHORSE_PROVIDER: 'custom',
        NEO_LLM_WORKHORSE_MODEL: 'local',
      }),
      (error: unknown) => error instanceof LlmSettingsError
        && /NEO_LLM_WORKHORSE_BASE_URL/.test((error as Error).message),
    )
  })
})

describe('renderer CLI', () => {
  it('deepseek --print has no custom block and exits 0', () => {
    const result = runRenderer(['--print'], {
      NEO_LLM_PROVIDER: 'deepseek',
      NEO_LLM_MODEL: 'deepseek-v4-flash',
      NEO_LLM_API_KEY: 'sk-test',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /provider: "deepseek-official"/)
    assert.doesNotMatch(result.stdout, /llm-pi-ai/)
  })

  it('custom --print includes baseURL', () => {
    const result = runRenderer(['--print'], {
      NEO_LLM_PROVIDER: 'custom',
      NEO_LLM_MODEL: 'qwen3:8b',
      NEO_LLM_BASE_URL: 'http://example.invalid/v1',
      NEO_LLM_API_KEY: 'ollama',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /baseURL: "http:\/\/example\.invalid\/v1"/)
  })

  it('missing key exits non-zero', () => {
    const result = runRenderer(['--print'], {
      NEO_LLM_PROVIDER: 'openai',
      NEO_LLM_MODEL: 'gpt-4.1',
      NEO_LLM_API_KEY: '',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /OPENAI_API_KEY or NEO_LLM_API_KEY/)
  })

  it('chatgpt --print succeeds without an API key', () => {
    const result = runRenderer(['--print'], {
      NEO_LLM_PROVIDER: 'chatgpt',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /provider: "openai-codex"/)
    assert.doesNotMatch(result.stdout, /apiKeyEnv:/)
  })

  it('writes neo-llm.patch.yml under --dsh-home', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neo-llm-'))
    try {
      const result = runRenderer(['--dsh-home', dir, '--export'], {
        NEO_LLM_PROVIDER: 'openrouter',
        NEO_LLM_MODEL: 'openrouter/auto',
        NEO_LLM_API_KEY: 'sk-or',
      })
      assert.equal(result.status, 0, result.stderr)
      const document = await readFile(join(dir, 'neo-llm.patch.yml'), 'utf8')
      assert.match(document, /provider: "openrouter"/)
      assert.match(document, /^- id: llm-pi-ai$/m)
      assert.match(document, /apiKeyEnv: "OPENROUTER_API_KEY"/)
      assert.doesNotMatch(document, /baseURL:/)
      assert.doesNotMatch(document, /models:/)
      assert.doesNotMatch(document, /sk-or/)
      await assert.rejects(readFile(join(dir, 'settings.yaml'), 'utf8'))
      assert.match(result.stdout, /export OPENROUTER_API_KEY='sk-or'/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('catalog merge on disk keeps existing llm-pi-ai provider fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neo-llm-'))
    try {
      await writeFile(
        join(dir, 'neo-llm.patch.yml'),
        [
          'llm-pi-ai:',
          '  providers:',
          '    openai:',
          '      api: openai-completions',
          '      baseURL: https://gateway.example/v1',
          '      models:',
          '        - id: gpt-4.1',
          '',
        ].join('\n'),
      )
      const result = runRenderer(['--dsh-home', dir], {
        NEO_LLM_PROVIDER: 'openai',
        NEO_LLM_MODEL: 'gpt-4.1',
        NEO_LLM_API_KEY: 'sk-openai',
      })
      assert.equal(result.status, 0, result.stderr)
      const document = await readFile(join(dir, 'neo-llm.patch.yml'), 'utf8')
      assert.match(document, /provider: "openai"/)
      assert.match(document, /apiKeyEnv: "OPENAI_API_KEY"/)
      assert.match(document, /baseURL: https:\/\/gateway\.example\/v1/)
      assert.match(document, /api: openai-completions/)
      assert.match(document, /id: gpt-4.1/)
      await assert.rejects(readFile(join(dir, 'settings.yaml'), 'utf8'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('entrypoint sidelines settings.yaml and passes the cordis patch before app flags', async () => {
    const entrypoint = await readFile(new URL('../../docker/dsh/entrypoint.sh', import.meta.url), 'utf8')
    assert.match(entrypoint, /settings\.yaml\.neo-legacy/)
    assert.match(entrypoint, /neo-llm\.patch\.yml/)
    assert.match(entrypoint, /--patch/)
    assert.match(entrypoint, /--no-open/)
    assert.doesNotMatch(entrypoint, /cat "\$\{DSH_HOME\}\/settings\.yaml"/)
  })
})
