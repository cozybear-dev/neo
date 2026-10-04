import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  checkScope,
  resolveTaskId,
  ScopeDeniedError,
  type FetchLike,
} from './client.ts'
import { normalizeScopeHost } from './host.ts'
import { createTools } from './tools.ts'
import {
  assertToolDefinitionCompiles,
  assertExecuteResultValid,
} from '../../../tests/helpers/dsh-schema.ts'

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
  handler: (
    url: string,
    init?: Parameters<FetchLike>[1],
  ) => { status: number; body: unknown },
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

const id = 'ef2b412d-84ac-4cde-8330-bdfd04154c78',
  env = { NEO_TASK_ID: id, NEO_TASK_TOKEN: 'fixture' }
describe('scope_check', () => {
  it('requires task identity and credentials', async () => {
    await assert.rejects(
      () =>
        checkScope(
          { target: 'fixture' },
          { env: {}, fetch: jsonFetch(() => ({ status: 200, body: {} })) },
        ),
      /task_id required/,
    )
  })
  it('checks primary and all secondary hosts with bound bearer', async () => {
    const targets: string[] = []
    await checkScope(
      { target: 'http://app.test/a', extra_hosts: ['api.test'] },
      {
        env,
        controlUrl: 'http://fixture',
        fetch: jsonFetch((url, init) => {
          assert.equal(url, 'http://fixture/scope/check')
          assert.equal(init?.headers?.authorization, 'Bearer fixture')
          const body = JSON.parse(init!.body!)
          assert.equal(body.task_id, id)
          assert.equal(body.extra_hosts, undefined)
          targets.push(body.target)
          return {
            status: 200,
            body: { allowed: true, matched: '*.test', reason: 'approved' },
          }
        }),
      },
    )
    assert.deepEqual(targets, ['app.test', 'api.test'])
  })
  it('denies scope miss and malformed successful response', async () => {
    await assert.rejects(
      () =>
        checkScope(
          { target: 'evil' },
          {
            env,
            fetch: jsonFetch(() => ({
              status: 200,
              body: { allowed: false, matched: '', reason: 'denied' },
            })),
          },
        ),
      ScopeDeniedError,
    )
    await assert.rejects(
      () =>
        checkScope(
          { target: 'evil' },
          { env, fetch: jsonFetch(() => ({ status: 200, body: {} })) },
        ),
      /invalid scope response/,
    )
  })
  it('rejects malformed explicit and cross-task IDs', () => {
    assert.throws(() => resolveTaskId('bad', env), /invalid explicit/)
    assert.throws(
      () => resolveTaskId('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', env),
      /differs/,
    )
  })
  it('preserves control errors and cancellation', async () => {
    await assert.rejects(
      () =>
        checkScope(
          { target: 'evil' },
          {
            env,
            fetch: jsonFetch(() => ({
              status: 503,
              body: { error: 'outage' },
            })),
          },
        ),
      /outage/,
    )
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(
      () =>
        checkScope(
          { target: 'fixture' },
          {
            env,
            signal: ac.signal,
            fetch: jsonFetch(() => ({ status: 200, body: {} })),
          },
        ),
      /aborted/,
    )
  })
})
