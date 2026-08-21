import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkScope, resolveTaskId, ScopeDeniedError, type FetchLike } from './client.ts'
import { normalizeScopeHost } from './host.ts'
import { createTools } from './tools.ts'
import { assertToolDefinitionCompiles, assertExecuteResultValid } from '../../../tests/helpers/dsh-schema.ts'

describe('normalizeScopeHost', () => {
  it('extracts hostname from absolute URLs', () => {
    assert.equal(normalizeScopeHost('https://x.com/a'), 'x.com')
  })

  it('strips brackets from IPv6 and ports from host:port', () => {
    assert.equal(normalizeScopeHost('[2001:db8::1]:8443'), '2001:db8::1')
    assert.equal(normalizeScopeHost('example.com:8080'), 'example.com')
  })

  it('returns empty for blank input', () => {
    assert.equal(normalizeScopeHost(''), '')
    assert.equal(normalizeScopeHost('   '), '')
  })

  it('does not parse javascript: as a network host', () => {
    // No :// so URL hostname path is not used; fallback is the scheme token only.
    assert.equal(normalizeScopeHost('javascript:alert(1)'), 'javascript')
  })
})

function jsonFetch(
  handler: (url: string, init?: Parameters<FetchLike>[1]) => { status: number; body: unknown },
): FetchLike {
  return async (url, init) => {
    if (init?.signal?.aborted) {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    const { status, body } = handler(url, init)
    return { status, text: async () => JSON.stringify(body) }
  }
}

describe('scope_check', () => {
  it('throws on allowlist miss', async () => {
    const fetchImpl = jsonFetch(() => ({
      status: 200,
      body: { allowed: false, matched: '', reason: 'default deny: no allowlist match' },
    }))
    await assert.rejects(
      () => checkScope({ target: 'evil.example' }, { fetch: fetchImpl, env: {} }),
      (err: unknown) => {
        assert.ok(err instanceof ScopeDeniedError)
        assert.match(err.message, /not in scope/)
        assert.match(err.message, /default deny/)
        assert.equal(err.result.allowed, false)
        return true
      },
    )
  })

  it('returns allowlist hit', async () => {
    const fetchImpl = jsonFetch(() => ({
      status: 200,
      body: { allowed: true, matched: 'juice-shop', reason: 'matched allowlist' },
    }))
    const result = await checkScope({ target: 'juice-shop' }, { fetch: fetchImpl, env: {} })
    assert.deepEqual(result, {
      allowed: true,
      matched: 'juice-shop',
      reason: 'matched allowlist',
    })
  })

  it('posts extra_hosts and task_id, then checks each extra host', async () => {
    const calls: Array<{ url: string; body: unknown; signal?: AbortSignal }> = []
    const ac = new AbortController()
    const fetchImpl = jsonFetch((url, init) => {
      calls.push({
        url,
        body: init?.body ? JSON.parse(init.body) : null,
        signal: init?.signal,
      })
      return {
        status: 200,
        body: { allowed: true, matched: '*.lab.internal', reason: 'matched allowlist' },
      }
    })
    const taskId = 'ef2b412d-84ac-4cde-8330-bdfd04154c78'
    await checkScope(
      { target: 'app.lab.internal', extra_hosts: ['api.lab.internal'], task_id: taskId },
      { fetch: fetchImpl, env: { CONTROL_URL: 'http://control:8090' }, signal: ac.signal },
    )
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.url, 'http://control:8090/scope/check')
    assert.deepEqual(calls[0]?.body, {
      target: 'app.lab.internal',
      extra_hosts: ['api.lab.internal'],
      task_id: taskId,
    })
    assert.equal(calls[0]?.signal, ac.signal)
    assert.deepEqual(calls[1]?.body, { target: 'api.lab.internal', task_id: taskId })
  })

  it('throws when an extra host misses the allowlist', async () => {
    const fetchImpl = jsonFetch((_url, init) => {
      const body = init?.body ? JSON.parse(init.body) as { target: string } : { target: '' }
      if (body.target === 'ok.lab.internal') {
        return { status: 200, body: { allowed: true, matched: '*.lab.internal', reason: 'matched allowlist' } }
      }
      return { status: 200, body: { allowed: false, matched: '', reason: 'default deny: no allowlist match' } }
    })
    await assert.rejects(
      () => checkScope(
        { target: 'ok.lab.internal', extra_hosts: ['evil.example'] },
        { fetch: fetchImpl, env: {} },
      ),
      /evil\.example/,
    )
  })

  it('uses NEO_TASK_ID when task_id is omitted', async () => {
    let posted: unknown
    const fetchImpl = jsonFetch((_url, init) => {
      posted = init?.body ? JSON.parse(init.body) : null
      return { status: 200, body: { allowed: true, matched: 'localhost', reason: 'matched allowlist' } }
    })
    const envTask = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    await checkScope(
      { target: 'localhost' },
      { fetch: fetchImpl, env: { NEO_TASK_ID: envTask } },
    )
    assert.equal((posted as { task_id: string }).task_id, envTask)
  })

  it('prefers agent.options.neoTaskId over the child session id', async () => {
    let posted: unknown
    const fetchImpl = jsonFetch((_url, init) => {
      posted = init?.body ? JSON.parse(init.body) : null
      return { status: 200, body: { allowed: true, matched: 'localhost', reason: 'matched allowlist' } }
    })
    const parentTask = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    await checkScope(
      { target: 'localhost' },
      {
        fetch: fetchImpl,
        env: {},
        agent: {
          id: 'session-ef2b412d-84ac-4cde-8330-bdfd04154c78',
          options: { neoTaskId: parentTask },
        },
      },
    )
    assert.equal((posted as { task_id: string }).task_id, parentTask)
  })

  it('resolveTaskId prefers agent.options.neoTaskId over the child session id', () => {
    const parentTask = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const childSession = 'session-ef2b412d-84ac-4cde-8330-bdfd04154c78'
    assert.equal(
      resolveTaskId(undefined, {}, {
        id: childSession,
        options: { neoTaskId: parentTask },
      }),
      parentTask,
    )
    assert.equal(
      resolveTaskId(undefined, {}, { id: childSession }),
      'ef2b412d-84ac-4cde-8330-bdfd04154c78',
    )
  })

  it('omits non-uuid task_id and uses session-derived UUID', async () => {
    let posted: unknown
    const fetchImpl = jsonFetch((_url, init) => {
      posted = init?.body ? JSON.parse(init.body) : null
      return { status: 200, body: { allowed: true, matched: 'localhost', reason: 'matched allowlist' } }
    })
    await checkScope(
      { target: 'localhost', task_id: 'session-not-a-uuid' },
      {
        fetch: fetchImpl,
        env: {},
        agent: { id: 'session-ef2b412d-84ac-4cde-8330-bdfd04154c78' },
      },
    )
    assert.equal((posted as { task_id: string }).task_id, 'ef2b412d-84ac-4cde-8330-bdfd04154c78')
  })

  it('normalizes URL targets to hostname before POST', async () => {
    let posted: unknown
    const fetchImpl = jsonFetch((_url, init) => {
      posted = init?.body ? JSON.parse(init.body) : null
      return { status: 200, body: { allowed: true, matched: 'x.com', reason: 'matched allowlist' } }
    })
    await checkScope(
      { target: 'https://x.com/path?q=1' },
      { fetch: fetchImpl, env: {} },
    )
    assert.equal((posted as { target: string }).target, 'x.com')
  })

  it('scope_check definition compiles and happy-path output matches schema', async () => {
    const [tool] = createTools({
      fetch: async () => ({
        status: 200,
        text: async () => JSON.stringify({ allowed: true, matched: 'juice-shop', reason: 'matched allowlist' }),
      }),
      env: {},
    })
    assert.equal(tool.name, 'scope_check')
    assertToolDefinitionCompiles(tool)
    const value = await tool.execute(
      { target: 'juice-shop' },
      { signal: new AbortController().signal },
    )
    assertExecuteResultValid(tool, value)
  })
})
