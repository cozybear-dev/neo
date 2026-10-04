import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getTask, getMemory, updateMemory, updateTask } from './client.ts'
import { resolveTaskId, ensureTaskId } from './task.ts'
const id = 'ef2b412d-84ac-4cde-8330-bdfd04154c78',
  env = { NEO_TASK_ID: id, NEO_TASK_TOKEN: 'fixture' }
const snapshot = {
  revision: 4,
  insights: ['i'],
  facts: ['f'],
  todos: [],
  files: [],
}
const response = (status: number, body: any) => ({
  status,
  text: async () => JSON.stringify(body),
})
test('task_get exposes current task and plan revisions for approval workflow', async () => {
  const task = {
    id,
    revision: 5,
    plan_revision: 2,
    mode: 'thorough',
    status: 'running',
  }
  const result = await getTask({ env, fetch: async () => response(200, task) })
  assert.deepEqual(result, task)
  await assert.rejects(
    getTask({ env, fetch: async () => response(200, { id }) }),
    /invalid task/,
  )
})
test('task binding rejects invalid, different and incidental session identities', () => {
  assert.throws(() => resolveTaskId('bad', env), /invalid explicit/)
  assert.throws(
    () => resolveTaskId('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', env),
    /differs/,
  )
  assert.equal(resolveTaskId(undefined, {}, { id: 'session-' + id }), undefined)
})
test('existing identity is mandatory and never bootstraps task from memory', async () => {
  const calls: any[] = []
  await assert.rejects(
    () =>
      ensureTaskId({
        env,
        fetch: async (url, init) => {
          calls.push(init?.method)
          return response(404, {})
        },
      }),
    /operator must create/,
  )
  assert.deepEqual(calls, ['GET'])
})
test('memory read validates response and overrides control URL', async () => {
  const got = await getMemory(
    {},
    {
      env,
      controlUrl: 'http://fixture',
      fetch: async (url, init) => {
        assert.equal(init?.headers?.authorization, 'Bearer fixture')
        assert.ok(
          url.startsWith('http://fixture') || url.endsWith('/tasks/' + id),
        )
        return response(200, url.endsWith('/memory') ? snapshot : { id })
      },
    },
  )
  assert.deepEqual(got, snapshot)
  await assert.rejects(
    () =>
      getMemory(
        {},
        {
          env,
          fetch: async (url) =>
            response(200, url.endsWith('/memory') ? {} : { id }),
        },
      ),
    /invalid memory/,
  )
})
test('partial write supplies CAS revision and only supplied fields', async () => {
  let body: any
  await updateMemory(
    { facts: ['new'], revision: 4 },
    {
      env,
      fetch: async (url, init) => {
        if (init?.method === 'PUT') body = JSON.parse(init.body!)
        return response(200, url.endsWith('/memory') ? snapshot : { id })
      },
    },
  )
  assert.deepEqual(body, { revision: 4, facts: ['new'] })
})
test('stale writes surface conflict and malformed ignored fields rejected by API', async () => {
  await assert.rejects(
    () =>
      updateMemory(
        { facts: [], revision: 4 },
        {
          env,
          fetch: async (url, init) =>
            response(
              init?.method === 'PUT' ? 409 : 200,
              url.endsWith('/memory')
                ? { ...snapshot, error: 'stale memory revision' }
                : { id },
            ),
        },
      ),
    /stale memory revision/,
  )
})
test('scope and mode changes require operator authorization', async () => {
  await assert.rejects(
    () =>
      updateTask(
        { allowlist: ['evil'] },
        { env, fetch: async () => response(200, { id }) },
      ),
    /operator authorization/,
  )
  await assert.rejects(
    () =>
      updateTask(
        { mode: 'fast', revision: 2 },
        { env, fetch: async () => response(200, { id }) },
      ),
    /operator authorization/,
  )
})
