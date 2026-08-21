import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertToolDefinitionCompiles, assertExecuteResultValid } from '../helpers/dsh-schema.ts'
import { NEO_TOOL_NAMES, allNeoToolDefs } from '../helpers/tool-catalog.ts'
import { createTools as scopeTools } from '../../plugins/neo-tools-scope/src/tools.ts'
import { createTools as memoryTools } from '../../plugins/neo-tools-memory/src/tools.ts'
import { createTools as issueTools } from '../../plugins/neo-tools-issues/src/tools.ts'
import { createTools as oastTools } from '../../plugins/neo-tools-oast/src/tools.ts'
import { createTools as sandboxTools } from '../../plugins/neo-sandbox-docker/src/tools.ts'
import { createTools as browserTools } from '../../plugins/neo-tools-browser/src/tools.ts'
import { createTools as trafficTools } from '../../plugins/neo-tools-traffic/src/tools.ts'
import { createTools as deployTools } from '../../plugins/neo-tools-deploy/src/tools.ts'
import { createTools as orchTools } from '../../plugins/neo-orchestrator/src/tools.ts'

type FetchInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

type FetchHandler = (url: string, init?: FetchInit) => {
  status: number
  body?: unknown
  headers?: Record<string, string>
  text?: string
}

type ToolLike = {
  name: string
  parameters: unknown
  output: { schema: unknown }
  execute: (args: Record<string, unknown>, exec: { signal?: AbortSignal; agent?: unknown }) => unknown | Promise<unknown>
}

const exec = { signal: new AbortController().signal }

function jsonFetch(handler: FetchHandler) {
  return async (url: string, init?: FetchInit) => {
    if (init?.signal?.aborted) {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    const res = handler(url, init)
    return {
      status: res.status,
      headers: res.headers ?? {},
      text: async () => res.text ?? (res.body === undefined ? '' : JSON.stringify(res.body)),
    }
  }
}

function byName(defs: ToolLike[], name: string): ToolLike {
  const def = defs.find((d) => d.name === name)
  assert.ok(def, `missing tool ${name}`)
  return def
}

function muxFrame(type: number, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const header = Buffer.alloc(8)
  header[0] = type
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

function memFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string | Uint8Array>(Object.entries(seed))
  return {
    files,
    async mkdir() {},
    async writeFile(path: string, data: string | Uint8Array) {
      files.set(path, data)
    },
    async readFile(path: string) {
      const v = files.get(path)
      if (v === undefined) {
        const err = new Error('ENOENT') as Error & { code: string }
        err.code = 'ENOENT'
        throw err
      }
      return typeof v === 'string' ? v : Buffer.from(v).toString('utf8')
    },
    async appendFile(path: string, data: string) {
      const prev = files.get(path)
      const prevS = prev === undefined ? '' : typeof prev === 'string' ? prev : Buffer.from(prev).toString('utf8')
      files.set(path, prevS + data)
    },
    async rm() {},
  }
}

function fakeBrowserSession(overrides: Record<string, unknown> = {}) {
  return {
    async navigate(url: string) {
      return { url, title: 'Juice Shop' }
    },
    async act() {
      return { ok: true as const }
    },
    async evaluate() {
      return { ok: true }
    },
    async screenshot() {
      return Buffer.from('png-bytes')
    },
    async network() {
      return []
    },
    ...overrides,
  }
}

describe('Neo tool contract (pin 141eb6f)', () => {
  it('exports every catalog name exactly once and each definition compiles', () => {
    const defs = allNeoToolDefs()
    const names = defs.map((d) => d.name).sort()
    assert.deepEqual(names, [...NEO_TOOL_NAMES].sort())
    for (const def of defs) assertToolDefinitionCompiles(def)
  })

  it('scope_check allowlist hit matches { allowed, matched, reason }', async () => {
    const scope = byName(scopeTools({
      fetch: jsonFetch(() => ({
        status: 200,
        body: { allowed: true, matched: 'juice-shop', reason: 'matched allowlist' },
      })),
      env: {},
    }), 'scope_check')
    const value = await scope.execute({ target: 'juice-shop' }, exec)
    assert.deepEqual(value, { allowed: true, matched: 'juice-shop', reason: 'matched allowlist' })
    assertExecuteResultValid(scope, value)
  })

  it('scope_check deny throws (policy error, not output-schema)', async () => {
    const scope = byName(scopeTools({
      fetch: jsonFetch(() => ({
        status: 200,
        body: { allowed: false, matched: '', reason: 'default deny: no allowlist match' },
      })),
      env: {},
    }), 'scope_check')
    await assert.rejects(
      () => scope.execute({ target: 'evil.example' }, exec),
      /not in scope/,
    )
  })

  it('memory_get returns insights, facts, todos, files', async () => {
    const snapshot = {
      insights: ['i1'],
      facts: [{ k: 'v' }],
      todos: [{ text: 't1' }],
      files: ['a.txt'],
    }
    const taskId = 'ef2b412d-84ac-4cde-8330-bdfd04154c78'
    const memory = byName(memoryTools({
      fetch: jsonFetch((url, init) => {
        if (!url.includes('/memory') && (init?.method ?? 'GET') === 'GET') {
          return { status: 200, body: { id: taskId } }
        }
        return { status: 200, body: snapshot }
      }),
      env: {},
    }), 'memory_get')
    const value = await memory.execute({ task_id: taskId }, exec)
    assert.deepEqual(value, snapshot)
    assertExecuteResultValid(memory, value)
  })

  it('memory_update 200 returns { ok: true }', async () => {
    const taskId = 'ef2b412d-84ac-4cde-8330-bdfd04154c78'
    const memory = byName(memoryTools({
      fetch: jsonFetch((url, init) => {
        if (!url.includes('/memory') && (init?.method ?? 'GET') === 'GET') {
          return { status: 200, body: { id: taskId } }
        }
        return { status: 200, body: { ok: true } }
      }),
      env: {},
    }), 'memory_update')
    const value = await memory.execute({ insights: ['i2'], task_id: taskId }, exec)
    assert.deepEqual(value, { ok: true })
    assertExecuteResultValid(memory, value)
  })

  it('memory_get throws when task_id is missing', async () => {
    const memory = byName(memoryTools({
      fetch: jsonFetch(() => ({ status: 200, body: { insights: [], facts: [], todos: [], files: [] } })),
      env: {},
    }), 'memory_get')
    await assert.rejects(
      () => memory.execute({}, exec),
      /task_id is required/,
    )
  })

  it('issue_create confirmed returns { ok: true, id }', async () => {
    const issue = byName(issueTools({
      fetch: jsonFetch(() => ({ status: 201, body: { id: 'issue-1', status: 'confirmed' } })),
      env: {},
    }), 'issue_create')
    const value = await issue.execute({
      title: 'xss',
      severity: 'high',
      verdict: 'confirmed',
      task_id: 't1',
    }, exec)
    assert.deepEqual(value, { ok: true, id: 'issue-1' })
    assertExecuteResultValid(issue, value)
  })

  it('issue_create thorough reject returns { ok: false, error } and still passes oneOf', async () => {
    const issue = byName(issueTools({
      fetch: jsonFetch(() => ({ status: 400, body: { error: 'thorough mode requires verdict=confirmed' } })),
      env: {},
    }), 'issue_create')
    const value = await issue.execute({
      title: 'maybe xss',
      severity: 'high',
      verdict: 'unverified',
      task_id: 'thorough-task',
    }, exec)
    assert.equal((value as { ok: unknown }).ok, false)
    assert.equal(typeof (value as { error?: unknown }).error, 'string')
    assertExecuteResultValid(issue, value)
  })

  it('issue_query returns an array of objects (extra DB columns allowed)', async () => {
    const issue = byName(issueTools({
      fetch: jsonFetch(() => ({
        status: 200,
        body: {
          issues: [{
            id: 'i1',
            title: 'xss',
            severity: 'high',
            status: 'confirmed',
            host: 'app.lab.internal',
            created_at: '2026-08-20T00:00:00Z',
          }],
        },
      })),
      env: {},
    }), 'issue_query')
    const value = await issue.execute({ host: 'app.lab.internal' }, exec)
    assert.ok(Array.isArray(value))
    assert.equal((value as { id: string }[])[0]?.id, 'i1')
    assertExecuteResultValid(issue, value)
  })

  it('issue_update 200 returns { ok: true }', async () => {
    const issue = byName(issueTools({
      fetch: jsonFetch(() => ({ status: 200, body: { id: 'issue-1', status: 'false_positive' } })),
      env: {},
    }), 'issue_update')
    const value = await issue.execute({ id: 'issue-1', status: 'false_positive' }, exec)
    assert.deepEqual(value, { ok: true })
    assertExecuteResultValid(issue, value)
  })

  it('oast_register 200 returns { id, url, domain } (crypto is real)', async () => {
    const oast = byName(oastTools({
      fetch: jsonFetch((url) => {
        assert.match(url, /\/register$/)
        return { status: 200, body: { message: 'registration successful' } }
      }),
      store: new Map(),
      env: { INTERACTSH_URL: 'http://interactsh:80' },
    }), 'oast_register')
    const value = await oast.execute({ kind: 'http' }, exec) as { id: string; url: string; domain: string }
    assert.equal(typeof value.id, 'string')
    assert.equal(typeof value.url, 'string')
    assert.equal(typeof value.domain, 'string')
    assert.equal('secretKey' in value, false)
    assertExecuteResultValid(oast, value)
  })

  it('oast_poll unknown id throws (do not output-validate)', async () => {
    const oast = byName(oastTools({
      fetch: jsonFetch(() => ({ status: 200, body: {} })),
      store: new Map(),
      env: { INTERACTSH_URL: 'http://interactsh:80' },
    }), 'oast_poll')
    await assert.rejects(
      () => oast.execute({ id: 'missing-id' }, exec),
      /unknown oast id/,
    )
  })

  it('sandbox_exec docker mock returns stdout, stderr, exitCode and no extras', async () => {
    const sandbox = byName(sandboxTools({
      docker: {
        async exec() {
          return { stdout: 'hi\n', stderr: '', exitCode: 0 }
        },
      },
      env: { SANDBOX_CONTAINER: 'neo-sandbox-1' },
    }), 'sandbox_exec')
    const value = await sandbox.execute({ command: 'echo hi' }, exec)
    assert.deepEqual(value, { stdout: 'hi\n', stderr: '', exitCode: 0 })
    assertExecuteResultValid(sandbox, value)
  })

  it('sandbox_exec inspect JSON without ExitCode still returns a number', async () => {
    const sandbox = byName(sandboxTools({
      engine: async (req) => {
        if (req.path.endsWith('/exec') && req.method === 'POST') {
          return { status: 201, body: Buffer.from(JSON.stringify({ Id: 'ex1' })) }
        }
        if (req.path.includes('/exec/ex1/start')) {
          return { status: 200, body: muxFrame(1, 'ok\n') }
        }
        if (req.path.includes('/exec/ex1/json')) {
          return { status: 200, body: Buffer.from(JSON.stringify({ Running: false })) }
        }
        return { status: 500, body: Buffer.from('unexpected') }
      },
      env: { SANDBOX_CONTAINER: 'neo-sandbox-1' },
    }), 'sandbox_exec')
    const value = await sandbox.execute({ command: 'echo ok' }, exec) as {
      stdout: string
      stderr: string
      exitCode: number
    }
    assert.equal(typeof value.exitCode, 'number')
    assert.equal(value.stdout, 'ok\n')
    assertExecuteResultValid(sandbox, value)
  })

  it('sandbox_exec docker 404 throws (infrastructure error)', async () => {
    const sandbox = byName(sandboxTools({
      engine: async () => ({ status: 404, body: Buffer.from('no such container') }),
      env: { SANDBOX_CONTAINER: 'missing' },
    }), 'sandbox_exec')
    await assert.rejects(
      () => sandbox.execute({ command: 'true' }, exec),
      /SANDBOX_CONTAINER/,
    )
  })

  it('browser_eval returns { result } with type json', async () => {
    const browser = byName(browserTools({
      session: fakeBrowserSession({
        async evaluate() {
          return { ok: true }
        },
      }),
      skipScopeCheck: true,
      env: {},
    }), 'browser_eval')
    const value = await browser.execute({ expression: '({ ok: true })' }, exec)
    assert.deepEqual(value, { result: { ok: true } })
    assertExecuteResultValid(browser, value)
  })

  it('browser_screenshot writes a path', async () => {
    const fs = memFs()
    const browser = byName(browserTools({
      session: fakeBrowserSession(),
      fs,
      now: () => new Date('2026-08-20T12:00:00.000Z'),
      env: {},
    }), 'browser_screenshot')
    const value = await browser.execute({}, exec) as { path: string }
    assert.equal(typeof value.path, 'string')
    assert.ok(fs.files.has(value.path))
    assertExecuteResultValid(browser, value)
  })

  it('traffic_search empty/jsonl returns an array of captured requests', async () => {
    const empty = byName(trafficTools({
      fs: memFs(),
      trafficPath: '/workspace/traffic/http.jsonl',
      env: {},
    }), 'traffic_search')
    const emptyValue = await empty.execute({ query: 'login' }, exec)
    assert.deepEqual(emptyValue, [])
    assertExecuteResultValid(empty, emptyValue)

    const rec = {
      id: 'req-1',
      method: 'POST',
      url: 'http://juice-shop.lab.internal/rest/user/login',
      headers: { 'content-type': 'application/json' },
      postData: '{"email":"a@b.c"}',
      status: 200,
      timestamp: '2026-08-20T00:00:00.000Z',
    }
    const search = byName(trafficTools({
      fs: memFs({ '/workspace/traffic/http.jsonl': `${JSON.stringify(rec)}\n` }),
      trafficPath: '/workspace/traffic/http.jsonl',
      env: {},
    }), 'traffic_search')
    const value = await search.execute({ query: 'login' }, exec)
    assert.equal((value as { id: string }[]).length, 1)
    assertExecuteResultValid(search, value)
  })

  it('traffic_replay 200 returns { status, headers, body }', async () => {
    const rec = {
      id: 'req-1',
      method: 'GET',
      url: 'http://juice-shop.lab.internal/',
      headers: { accept: '*/*' },
      timestamp: '2026-08-20T00:00:00.000Z',
    }
    const traffic = byName(trafficTools({
      fs: memFs({ '/workspace/traffic/http.jsonl': `${JSON.stringify(rec)}\n` }),
      trafficPath: '/workspace/traffic/http.jsonl',
      fetch: jsonFetch(() => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        text: '<html>ok</html>',
      })),
      env: {},
    }), 'traffic_replay')
    const value = await traffic.execute({ id: 'req-1' }, exec)
    assert.deepEqual(value, {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<html>ok</html>',
    })
    assertExecuteResultValid(traffic, value)
  })

  it('deploy_up mocked client returns current output object', async () => {
    const deploy = byName(deployTools({
      spawn: async () => ({ stdout: 'cid\n', stderr: '', exitCode: 0 }),
      fs: memFs(),
      env: { NEO_WORKSPACE: '/workspace' },
    }), 'deploy_up')
    const value = await deploy.execute({
      source: 'image',
      ref: 'nginx:alpine',
      network: 'targets',
      id: 'lab1',
    }, exec) as Record<string, unknown>
    assert.equal(value.id, 'lab1')
    assert.equal(value.project, 'neo-target-lab1')
    assert.equal(value.network, 'targets')
    assert.equal(typeof value.baseUrl, 'string')
    assert.equal(typeof value.logPath, 'string')
    assertExecuteResultValid(deploy, value)
  })

  it('deploy_down mocked client returns current output object', async () => {
    const deploy = byName(deployTools({
      spawn: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      fs: memFs(),
      env: { NEO_WORKSPACE: '/workspace' },
    }), 'deploy_down')
    const value = await deploy.execute({ id: 'lab1' }, exec)
    assert.deepEqual(value, { id: 'lab1', project: 'neo-target-lab1', ok: true })
    assertExecuteResultValid(deploy, value)
  })

  it('delegate in-process returns { ok: true, backend, results } including findings_claimed objects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neo-contract-delegate-'))
    const delegate = byName(orchTools({
      presets: undefined,
      workspaceDir: dir,
      env: {},
    }), 'delegate')
    const value = await delegate.execute({
      agent_id: 'explore',
      prompt: 'map the attack surface',
    }, exec) as {
      ok: true
      backend: string
      results: Array<{ findings_claimed: unknown[] }>
    }
    assert.equal(value.ok, true)
    assert.equal(value.backend, 'in-process')
    assert.ok(Array.isArray(value.results))
    assert.ok(Array.isArray(value.results[0]?.findings_claimed))
    assertExecuteResultValid(delegate, value)
  })
})
