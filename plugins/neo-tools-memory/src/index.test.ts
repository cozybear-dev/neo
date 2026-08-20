import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getMemory, updateMemory, type FetchLike } from './client.ts'

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

const snapshot = {
  insights: ['i1'],
  facts: [{ k: 'v' }],
  todos: [{ text: 't1' }],
  files: ['a.txt'],
}

describe('memory tools', () => {
  it('memory_get returns insights, facts, todos, files', async () => {
    const fetchImpl = jsonFetch((url) => {
      assert.equal(url, 'http://control:8090/tasks/task-uuid/memory')
      return { status: 200, body: snapshot }
    })
    const got = await getMemory(
      { task_id: 'task-uuid' },
      { fetch: fetchImpl, env: {} },
    )
    assert.deepEqual(got, snapshot)
  })

  it('memory_update returns {ok:true} and sends only provided keys', async () => {
    let method = ''
    let posted: unknown
    const fetchImpl = jsonFetch((_url, init) => {
      method = init?.method ?? ''
      posted = init?.body ? JSON.parse(init.body) : null
      return { status: 200, body: { ...snapshot, insights: ['i2'] } }
    })
    const result = await updateMemory(
      { insights: ['i2'], task_id: 'task-uuid' },
      { fetch: fetchImpl, env: { CONTROL_URL: 'http://control:8090' } },
    )
    assert.deepEqual(result, { ok: true })
    assert.equal(method, 'PUT')
    assert.deepEqual(posted, { insights: ['i2'] })
  })

  it('throws when task id is missing', async () => {
    await assert.rejects(
      () => getMemory({}, { fetch: jsonFetch(() => ({ status: 200, body: snapshot })), env: {} }),
      /task_id is required/,
    )
  })

  it('uses NEO_TASK_ID and honors abort signal', async () => {
    const ac = new AbortController()
    let seen: AbortSignal | undefined
    const fetchImpl = jsonFetch((url, init) => {
      assert.match(url, /\/tasks\/env-task\/memory$/)
      seen = init?.signal
      return { status: 200, body: snapshot }
    })
    await getMemory({}, { fetch: fetchImpl, env: { NEO_TASK_ID: 'env-task' }, signal: ac.signal })
    assert.equal(seen, ac.signal)
  })

  it('throws on control HTTP errors', async () => {
    const fetchImpl = jsonFetch(() => ({ status: 404, body: { error: 'task not found' } }))
    await assert.rejects(
      () => getMemory({ task_id: 'missing' }, { fetch: fetchImpl, env: {} }),
      /task not found/,
    )
  })
})
