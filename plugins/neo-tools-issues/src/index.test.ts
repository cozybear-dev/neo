import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createIssue, queryIssues, updateIssue } from './client.ts'
const id = 'ef2b412d-84ac-4cde-8330-bdfd04154c78',
  env = { NEO_TASK_ID: id, NEO_TASK_TOKEN: 'fixture' },
  agent = { options: { neoRunId: id, neoRunToken: 'run-fixture' } }
const response = (status: number, body: any) => ({
  status,
  text: async () => JSON.stringify(body),
})
test('candidate creation attributes run, binds task and honors URL', async () => {
  const got = await createIssue(
    { title: 'x', severity: 'high' },
    {
      env,
      agent,
      controlUrl: 'http://fixture',
      fetch: async (url, init) => {
        assert.equal(url, 'http://fixture/issues')
        assert.equal(init?.headers?.['x-neo-run-token'], 'run-fixture')
        assert.equal(JSON.parse(init!.body!).task_id, id)
        return response(201, { id: 'issue' })
      },
    },
  )
  assert.deepEqual(got, { ok: true, id: 'issue' })
})
test('caller confirmed string cannot self verify', async () => {
  await assert.rejects(
    () =>
      createIssue(
        { title: 'x', severity: 'high', verdict: 'confirmed' },
        { env, agent, fetch: async () => response(201, {}) },
      ),
    /independent verification/,
  )
})
test('domain rejection and infrastructure errors preserved', async () => {
  assert.deepEqual(
    await createIssue(
      { title: 'x', severity: 'high' },
      { env, agent, fetch: async () => response(403, { error: 'denied' }) },
    ),
    { ok: false, error: 'denied' },
  )
  await assert.rejects(
    () =>
      createIssue(
        { title: 'x', severity: 'high' },
        { env, agent, fetch: async () => response(502, { error: 'outage' }) },
      ),
    /outage/,
  )
})
test('query forwards mandatory task filters and rejects malformed success', async () => {
  const result = await queryIssues(
    { host: 'fixture', status: 'open' },
    {
      env,
      fetch: async (url) => {
        assert.ok(url.includes('task_id=' + id))
        assert.ok(url.includes('host=fixture'))
        return response(200, { issues: [] })
      },
    },
  )
  assert.deepEqual(result, [])
  await assert.rejects(
    () => queryIssues({}, { env, fetch: async () => response(200, {}) }),
    /invalid issue list/,
  )
})
test('update includes comment verification evidence and CAS revision', async () => {
  let body: any
  await updateIssue(
    {
      id: 'issue',
      revision: 3,
      status: 'confirmed',
      verification_id: id,
      comment: 'verified',
      evidence_paths: ['a'],
    },
    {
      env,
      agent,
      fetch: async (_, init) => {
        body = JSON.parse(init!.body!)
        return response(200, { id: 'issue', revision: 4 })
      },
    },
  )
  assert.deepEqual(body, {
    revision: 3,
    status: 'confirmed',
    verification_id: id,
    comment: 'verified',
    evidence_paths: ['a'],
  })
  await assert.rejects(
    () =>
      updateIssue(
        { id: 'issue', revision: 3 },
        { env, agent, fetch: async () => response(409, { error: 'stale' }) },
      ),
    /stale/,
  )
})
