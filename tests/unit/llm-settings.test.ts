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

  it('openai catalog route writes llm-pi-ai.providers.openai', () => {
    const yaml = renderOwnedSettings(resolveLlmSelection({
      NEO_LLM_PROVIDER: 'openai',
      NEO_LLM_MODEL: 'gpt-4.1',
      NEO_LLM_API_KEY: 'sk-openai',
    }))
    assert.match(yaml, /provider: "openai"/)
    assert.match(yaml, /apiKeyEnv: "OPENAI_API_KEY"/)
    assert.doesNotMatch(yaml, /baseURL:/)
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
  it('replaces a leftover custom block when switching to deepseek', () => {
    const existing = [
      'locale:',
      '  preference: en',
      'llm-pi-ai:',
      '  providers:',
      '    custom:',
      '      baseURL: http://old.example/v1',
      'agent-default-model:',
      '  provider: custom',
      '  model: old',
      '',
    ].join('\n')
    const yaml = mergeSettingsYaml(existing, resolveLlmSelection({
      NEO_LLM_PROVIDER: 'deepseek',
      NEO_LLM_MODEL: 'deepseek-v4-flash',
      NEO_LLM_API_KEY: 'sk-test',
    }))
    assert.match(yaml, /locale:/)
    assert.match(yaml, /preference: en/)
    assert.match(yaml, /provider: "deepseek-official"/)
    assert.doesNotMatch(yaml, /llm-pi-ai:/)
    assert.doesNotMatch(yaml, /baseURL:/)
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
      assert.match(document, /apiKeyEnv: "OPENROUTER_API_KEY"/)
      assert.match(result.stdout, /export OPENROUTER_API_KEY='sk-or'/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('env wins over an existing settings.yaml on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neo-llm-'))
    try {
      await writeFile(join(dir, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    custom:\n      baseURL: http://stale\n')
      const result = runRenderer(['--dsh-home', dir], {
        NEO_LLM_PROVIDER: 'deepseek',
        NEO_LLM_MODEL: 'deepseek-v4-flash',
        NEO_LLM_API_KEY: 'sk-test',
      })
      assert.equal(result.status, 0, result.stderr)
      const document = await readFile(join(dir, 'settings.yaml'), 'utf8')
      assert.doesNotMatch(document, /baseURL:/)
      assert.match(document, /deepseek-official/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
