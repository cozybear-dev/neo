import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import {
  LlmOAuthImportError,
  importLlmOAuth,
  parseClaudeAuth,
  parseCodexAuth,
  parseGrokAuth,
} from '../../docker/dsh/import-llm-oauth.mjs'

const importer = fileURLToPath(
  new URL('../../docker/dsh/import-llm-oauth.mjs', import.meta.url),
)

function runImporter(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [importer, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ...env,
    },
  })
}

function jwtWithAccount(accountId: string, exp = Math.floor(Date.now() / 1000) + 3600) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
    'base64url',
  )
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
      exp,
    }),
  ).toString('base64url')
  return `${header}.${payload}.sig`
}

const CODEX_ACCOUNT = 'acct_codex_test'
const CODEX_ACCESS = jwtWithAccount(CODEX_ACCOUNT)
const CODEX_REFRESH = 'rt_codex_test'
const CLAUDE_ACCESS = 'sk-ant-oat-test'
const CLAUDE_REFRESH = 'sk-ant-ort-test'
const CLAUDE_EXPIRES = 1_786_000_000_000
const GROK_ACCESS = 'grok_access_test'
const GROK_REFRESH = 'grok_refresh_test'
const GROK_EXPIRES = 1_786_100_000_000

async function withHome<T>(fn: (home: string) => Promise<T>) {
  const home = await mkdtemp(join(tmpdir(), 'neo-oauth-'))
  try {
    return await fn(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('parseCodexAuth', () => {
  it('maps Codex CLI tokens onto a pi-ai oauth grant with accountId', () => {
    const grant = parseCodexAuth({
      tokens: {
        access_token: CODEX_ACCESS,
        refresh_token: CODEX_REFRESH,
        account_id: CODEX_ACCOUNT,
      },
    })
    assert.equal(grant.type, 'oauth')
    assert.equal(grant.access, CODEX_ACCESS)
    assert.equal(grant.refresh, CODEX_REFRESH)
    assert.equal(grant.accountId, CODEX_ACCOUNT)
    assert.equal(typeof grant.expires, 'number')
  })

  it('reads accountId from the ChatGPT JWT when tokens.account_id is missing', () => {
    const grant = parseCodexAuth({
      tokens: {
        access_token: CODEX_ACCESS,
        refresh_token: CODEX_REFRESH,
      },
    })
    assert.equal(grant.accountId, CODEX_ACCOUNT)
  })
})

describe('parseClaudeAuth', () => {
  it('maps claudeAiOauth onto a pi-ai oauth grant', () => {
    const grant = parseClaudeAuth({
      claudeAiOauth: {
        accessToken: CLAUDE_ACCESS,
        refreshToken: CLAUDE_REFRESH,
        expiresAt: CLAUDE_EXPIRES,
      },
    })
    assert.deepEqual(grant, {
      type: 'oauth',
      access: CLAUDE_ACCESS,
      refresh: CLAUDE_REFRESH,
      expires: CLAUDE_EXPIRES,
    })
  })
})

describe('parseGrokAuth', () => {
  it('maps an issuer-keyed OIDC session onto a pi-ai oauth grant', () => {
    const grant = parseGrokAuth({
      'xai::api_key': { key: 'xai-ignored', auth_mode: 'api_key' },
      'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
        key: GROK_ACCESS,
        auth_mode: 'oidc',
        refresh_token: GROK_REFRESH,
        expires_at: GROK_EXPIRES,
      },
    })
    assert.deepEqual(grant, {
      type: 'oauth',
      access: GROK_ACCESS,
      refresh: GROK_REFRESH,
      expires: GROK_EXPIRES,
    })
  })
})

describe('importLlmOAuth', () => {
  it('writes a chatgpt grant from a host Codex file', async () => {
    await withHome(async (home) => {
      const host = join(home, 'codex', 'auth.json')
      await mkdir(join(home, 'codex'), { recursive: true })
      await writeFile(
        host,
        JSON.stringify({
          tokens: {
            access_token: CODEX_ACCESS,
            refresh_token: CODEX_REFRESH,
            account_id: CODEX_ACCOUNT,
          },
        }),
      )
      const dshHome = join(home, 'dsh')
      await mkdir(dshHome, { recursive: true })
      await importLlmOAuth({
        env: {
          NEO_LLM_PROVIDER: 'chatgpt',
          NEO_LLM_OAUTH_CHATGPT_FILE: host,
        },
        dshHome,
      })
      const stored = parseYaml(
        await readFile(join(dshHome, '.credentials.yaml'), 'utf8'),
      ) as {
        version: number
        records: Record<string, { kind: string; payload: Record<string, unknown> }>
      }
      assert.equal(stored.version, 1)
      const record = stored.records['llm-pi-ai/openai-codex']
      assert.equal(record.kind, 'grant')
      assert.equal(record.payload.type, 'oauth')
      assert.equal(record.payload.access, CODEX_ACCESS)
      assert.equal(record.payload.refresh, CODEX_REFRESH)
      assert.equal(record.payload.accountId, CODEX_ACCOUNT)
      assert.equal(typeof record.payload.expires, 'number')
    })
  })

  it('lets the host file replace an existing grant', async () => {
    await withHome(async (home) => {
      const host = join(home, 'claude', '.credentials.json')
      await mkdir(join(home, 'claude'), { recursive: true })
      await writeFile(
        host,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: CLAUDE_ACCESS,
            refreshToken: CLAUDE_REFRESH,
            expiresAt: CLAUDE_EXPIRES,
          },
        }),
      )
      const dshHome = join(home, 'dsh')
      await mkdir(dshHome, { recursive: true })
      await writeFile(
        join(dshHome, '.credentials.yaml'),
        [
          'version: 1',
          'refs:',
          '  EXA_API_KEY: keep-me',
          'records:',
          '  llm-pi-ai/anthropic:',
          '    kind: grant',
          '    payload:',
          '      type: oauth',
          '      access: stale-access',
          '      refresh: stale-refresh',
          '      expires: 1',
          '  other/plugin:',
          '    kind: api-key',
          '    key: sibling',
          '',
        ].join('\n'),
      )
      await importLlmOAuth({
        env: {
          NEO_LLM_PROVIDER: 'claude',
          NEO_LLM_OAUTH_CLAUDE_FILE: host,
        },
        dshHome,
      })
      const stored = parseYaml(
        await readFile(join(dshHome, '.credentials.yaml'), 'utf8'),
      ) as {
        refs: Record<string, string>
        records: Record<string, { kind: string; payload?: Record<string, unknown>; key?: string }>
      }
      assert.equal(stored.refs.EXA_API_KEY, 'keep-me')
      assert.equal(stored.records['other/plugin'].key, 'sibling')
      assert.equal(stored.records['llm-pi-ai/anthropic'].payload?.access, CLAUDE_ACCESS)
      assert.equal(stored.records['llm-pi-ai/anthropic'].payload?.refresh, CLAUDE_REFRESH)
    })
  })

  it('keeps an existing grant when the host file is missing', async () => {
    await withHome(async (home) => {
      const dshHome = join(home, 'dsh')
      await mkdir(dshHome, { recursive: true })
      await writeFile(
        join(dshHome, '.credentials.yaml'),
        [
          'version: 1',
          'records:',
          '  llm-pi-ai/xai:',
          '    kind: grant',
          '    payload:',
          '      type: oauth',
          '      access: stored-access',
          '      refresh: stored-refresh',
          '      expires: 99',
          '',
        ].join('\n'),
      )
      await importLlmOAuth({
        env: {
          NEO_LLM_PROVIDER: 'grok',
          NEO_LLM_OAUTH_GROK_FILE: join(home, 'missing', 'auth.json'),
        },
        dshHome,
      })
      const stored = parseYaml(
        await readFile(join(dshHome, '.credentials.yaml'), 'utf8'),
      ) as {
        records: Record<string, { payload: Record<string, unknown> }>
      }
      assert.equal(stored.records['llm-pi-ai/xai'].payload.access, 'stored-access')
    })
  })

  it('fails closed when chatgpt has no host file and no stored grant', async () => {
    await withHome(async (home) => {
      const dshHome = join(home, 'dsh')
      await mkdir(dshHome, { recursive: true })
      await assert.rejects(
        () =>
          importLlmOAuth({
            env: {
              NEO_LLM_PROVIDER: 'chatgpt',
              NEO_LLM_OAUTH_CHATGPT_FILE: join(home, 'missing', 'auth.json'),
            },
            dshHome,
          }),
        (error: unknown) =>
          error instanceof LlmOAuthImportError
          && /openai-codex/.test((error as Error).message)
          && /\/host-auth\/codex\/auth\.json|NEO_LLM_OAUTH_CHATGPT_FILE/.test(
            (error as Error).message,
          )
          && /device-code|docker compose logs/.test((error as Error).message),
      )
      await assert.rejects(readFile(join(dshHome, '.credentials.yaml'), 'utf8'))
    })
  })

  it('does nothing for an API-key provider', async () => {
    await withHome(async (home) => {
      const dshHome = join(home, 'dsh')
      await mkdir(dshHome, { recursive: true })
      await importLlmOAuth({
        env: {
          NEO_LLM_PROVIDER: 'openai',
          NEO_LLM_MODEL: 'gpt-4.1',
          NEO_LLM_API_KEY: 'sk-openai',
        },
        dshHome,
      })
      await assert.rejects(readFile(join(dshHome, '.credentials.yaml'), 'utf8'))
    })
  })
})

describe('importer CLI', () => {
  it('chatgpt --dsh-home writes the openai-codex grant', async () => {
    await withHome(async (home) => {
      const host = join(home, 'auth.json')
      await writeFile(
        host,
        JSON.stringify({
          tokens: {
            access_token: CODEX_ACCESS,
            refresh_token: CODEX_REFRESH,
            account_id: CODEX_ACCOUNT,
          },
        }),
      )
      const dshHome = join(home, 'dsh')
      await mkdir(dshHome, { recursive: true })
      const result = runImporter(['--dsh-home', dshHome], {
        NEO_LLM_PROVIDER: 'chatgpt',
        NEO_LLM_OAUTH_CHATGPT_FILE: host,
      })
      assert.equal(result.status, 0, result.stderr)
      const document = await readFile(join(dshHome, '.credentials.yaml'), 'utf8')
      assert.match(document, /llm-pi-ai\/openai-codex:/)
      assert.match(document, /kind: grant/)
      assert.match(document, /accountId: acct_codex_test/)
    })
  })

  it('entrypoint runs the oauth importer after the renderer', async () => {
    const entrypoint = await readFile(
      new URL('../../docker/dsh/entrypoint.sh', import.meta.url),
      'utf8',
    )
    assert.match(entrypoint, /import-llm-oauth\.mjs/)
    const dockerfile = await readFile(
      new URL('../../docker/dsh/Dockerfile', import.meta.url),
      'utf8',
    )
    assert.match(dockerfile, /COPY docker\/dsh\/import-llm-oauth\.mjs/)
  })
})
