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
  mergeSettingsYaml,
  renderOwnedSettings,
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
  it('deepseek → no custom / llm-pi-ai block', () => {
    const yaml = renderOwnedSettings(resolveLlmSelection({
      NEO_LLM_PROVIDER: 'deepseek',
      NEO_LLM_MODEL: 'deepseek-v4-flash',
      NEO_LLM_API_KEY: 'sk-test',
    }))
    assert.match(yaml, /^agent-default-model:/m)
    assert.match(yaml, /provider: "deepseek-official"/)
    assert.match(yaml, /model: "deepseek-v4-flash"/)
    assert.doesNotMatch(yaml, /llm-pi-ai:/)
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
    assert.match(yaml, /provider: "custom"/)
    assert.match(yaml, /model: "qwen3:8b"/)
    assert.match(yaml, /^llm-pi-ai:/m)
    assert.match(yaml, /baseURL: "http:\/\/host\.docker\.internal:11434\/v1"/)
    assert.match(yaml, /apiKeyEnv: "NEO_LLM_API_KEY"/)
    assert.match(yaml, /api: "openai-completions"/)
    assert.match(yaml, /- id: "qwen3:8b"/)
  })

  it('openai catalog route does not emit a stripped llm-pi-ai provider', () => {
    const yaml = renderOwnedSettings(resolveLlmSelection({
      NEO_LLM_PROVIDER: 'openai',
      NEO_LLM_MODEL: 'gpt-4.1',
      NEO_LLM_API_KEY: 'sk-openai',
    }))
    assert.match(yaml, /provider: "openai"/)
    assert.match(yaml, /model: "gpt-4.1"/)
    assert.doesNotMatch(yaml, /llm-pi-ai:/)
    assert.doesNotMatch(yaml, /apiKeyEnv:/)
    assert.doesNotMatch(yaml, /baseURL:/)
    assert.equal(mappedCredentialEnv(resolveLlmSelection({
      NEO_LLM_PROVIDER: 'openai',
      NEO_LLM_MODEL: 'gpt-4.1',
      NEO_LLM_API_KEY: 'sk-openai',
    })).OPENAI_API_KEY, 'sk-openai')
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
    assert.doesNotMatch(result.stdout, /llm-pi-ai:/)
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

  it('writes settings.yaml under --dsh-home', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neo-llm-'))
    try {
      const result = runRenderer(['--dsh-home', dir, '--export'], {
        NEO_LLM_PROVIDER: 'openrouter',
        NEO_LLM_MODEL: 'openrouter/auto',
        NEO_LLM_API_KEY: 'sk-or',
      })
      assert.equal(result.status, 0, result.stderr)
      const document = await readFile(join(dir, 'settings.yaml'), 'utf8')
      assert.match(document, /provider: "openrouter"/)
      assert.doesNotMatch(document, /llm-pi-ai:/)
      assert.doesNotMatch(document, /apiKeyEnv:/)
      assert.match(result.stdout, /export OPENROUTER_API_KEY='sk-or'/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('catalog merge on disk keeps existing llm-pi-ai provider fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neo-llm-'))
    try {
      await writeFile(
        join(dir, 'settings.yaml'),
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
      const document = await readFile(join(dir, 'settings.yaml'), 'utf8')
      assert.match(document, /provider: "openai"/)
      assert.match(document, /baseURL: https:\/\/gateway\.example\/v1/)
      assert.match(document, /api: openai-completions/)
      assert.match(document, /id: gpt-4.1/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
