import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureRunIdentity, resolveTaskId, taskToken } from './contracts.mjs'

const id = '11111111-1111-4111-8111-111111111111'

test('a blank env task id does not shadow the chat task', () => {
  const agent = { options: { neoTaskId: id, neoTaskToken: 'chat-token' } }
  assert.equal(resolveTaskId(undefined, { NEO_TASK_ID: '' }, agent), id)
  assert.equal(resolveTaskId(undefined, { NEO_TASK_ID: '   ' }, {}), undefined)
  assert.equal(taskToken({ NEO_TASK_ID: '', NEO_TASK_TOKEN: '' }, agent), 'chat-token')
  assert.throws(
    () => resolveTaskId(undefined, { NEO_TASK_ID: 'not-a-task' }, {}),
    /invalid bound task_id/,
  )
})

test('run registration retries after failure and shares concurrent attempts', async () => {
  const env = {
    NEO_TASK_ID: '11111111-1111-4111-8111-111111111111',
    NEO_TASK_TOKEN: 'task-secret',
  }
  const agent = {}
  let calls = 0
  const fetchImpl = async () => {
    calls++
    if (calls === 1) throw new Error('temporary control outage')
    return {
      status: 200,
      text: async () =>
        JSON.stringify({ id: 'run-id', run_token: 'run-secret' }),
    }
  }
  await assert.rejects(ensureRunIdentity(env, agent, fetchImpl), /outage/)
  const results = await Promise.all([
    ensureRunIdentity(env, agent, fetchImpl),
    ensureRunIdentity(env, agent, fetchImpl),
  ])
  assert.equal(calls, 2)
  assert.equal(results[0].id, 'run-id')
  assert.equal(results[1].run_token, 'run-secret')
  await ensureRunIdentity(env, agent, fetchImpl)
  assert.equal(calls, 2)
})
