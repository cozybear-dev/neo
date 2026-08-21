import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getMemory, updateMemory, type FetchLike } from './client.ts'
import { taskIdFromSession } from './task.ts'

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

const TASK_UUID = 'ef2b412d-84ac-4cde-8330-bdfd04154c78'
const ENV_TASK_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const snapshot = {
  insights: ['i1'],
  facts: [{ k: 'v' }],
  todos: [{ text: 't1' }],
  files: ['a.txt'],
}

describe('taskIdFromSession', () => {
  it('derives a UUID from a DSH session id', () => {
    assert.equal(
      taskIdFromSession('session-ef2b412d-84ac-4cde-8330-bdfd04154c78'),
      'ef2b412d-84ac-4cde-8330-bdfd04154c78',
    )
  })
})

describe('memory tools', () => {
  it('memory_get returns insights, facts, todos, files', async () => {
    const fetchImpl = jsonFetch((url, init) => {
      if (url.includes(`/tasks/${TASK_UUID}`) && (init?.method ?? 'GET') === 'GET' && !url.includes('/memory')) {
        return { status: 200, body: { id: TASK_UUID } }
      }
      assert.equal(url, `http://control:8090/tasks/${TASK_UUID}/memory`)
      return { status: 200, body: snapshot }
    })
    const got = await getMemory(
      { task_id: TASK_UUID },
      { fetch: fetchImpl, env: {} },
    )
    assert.deepEqual(got, snapshot)
  })

  it('memory_update returns {ok:true} and sends only provided keys', async () => {
    let method = ''
    let posted: unknown
    const fetchImpl = jsonFetch((url, init) => {
      if (url.includes(`/tasks/${TASK_UUID}`) && (init?.method ?? 'GET') === 'GET' && !url.includes('/memory')) {
        return { status: 200, body: { id: TASK_UUID } }
      }
      method = init?.method ?? ''
      posted = init?.body ? JSON.parse(init.body) : null
      return { status: 200, body: { ...snapshot, insights: ['i2'] } }
    })
    const result = await updateMemory(
      { insights: ['i2'], task_id: TASK_UUID },
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

  it('memory_update without task_id creates the session task then writes', async () => {
    const calls: string[] = []
    const fetchImpl = jsonFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/tasks') && init?.method === 'POST') {
        return { status: 201, body: { id: TASK_UUID } }
      }
      if (url.includes('/memory')) return { status: 200, body: { ok: true } }
      if (url.includes('/tasks/') && (init?.method ?? 'GET') === 'GET') {
        return { status: 404, body: { error: 'task not found' } }
      }
      return { status: 500, body: { error: 'unexpected' } }
    })
    const agent = { id: 'session-ef2b412d-84ac-4cde-8330-bdfd04154c78' }
    await updateMemory(
      { facts: [{ key: 'target', value: 'huntandhackett.com' }] },
      { fetch: fetchImpl, env: {}, agent },
    )
    assert.ok(calls.some((c) => c.startsWith('POST ') && c.endsWith('/tasks')))
  })

  it('uses NEO_TASK_ID and honors abort signal', async () => {
    const ac = new AbortController()
    let seen: AbortSignal | undefined
    const fetchImpl = jsonFetch((url, init) => {
      if (url.includes(`/tasks/${ENV_TASK_UUID}`) && (init?.method ?? 'GET') === 'GET' && !url.includes('/memory')) {
        return { status: 200, body: { id: ENV_TASK_UUID } }
      }
      assert.match(url, new RegExp(`/tasks/${ENV_TASK_UUID}/memory$`))
      seen = init?.signal
      return { status: 200, body: snapshot }
    })
    await getMemory({}, { fetch: fetchImpl, env: { NEO_TASK_ID: ENV_TASK_UUID }, signal: ac.signal })
    assert.equal(seen, ac.signal)
  })

  it('throws on control HTTP errors', async () => {
    const fetchImpl = jsonFetch((url, init) => {
      if (!url.includes('/memory') && (init?.method ?? 'GET') === 'GET') {
        return { status: 200, body: { id: TASK_UUID } }
      }
      return { status: 404, body: { error: 'task not found' } }
    })
    await assert.rejects(
      () => getMemory({ task_id: TASK_UUID }, { fetch: fetchImpl, env: {} }),
      /task not found/,
    )
  })
})
