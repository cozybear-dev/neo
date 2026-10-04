import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureRunIdentity } from './contracts.mjs'

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
