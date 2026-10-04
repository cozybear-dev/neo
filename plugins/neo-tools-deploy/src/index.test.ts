import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  deployUp,
  deployDown,
  composeProjectName,
  assertAllowedNetwork,
} from './client.ts'
test('deployment IDs reject traversal and unsafe names', () => {
  for (const id of ['../../outside', '/tmp/x', 'a b', 'A'])
    assert.throws(() => composeProjectName(id))
  assert.equal(composeProjectName('lab-1'), 'neo-target-lab-1')
})
test('reject networks other than targets', () => {
  assert.equal(assertAllowedNetwork(undefined), 'targets')
  assert.throws(() => assertAllowedNetwork('control'))
})
test('deployment requires task identity and explicit endpoint', async () => {
  await assert.rejects(
    deployUp({ source: 'image', ref: 'fixture', id: 'lab' }),
    /port/,
  )
  await assert.rejects(
    deployUp({ source: 'image', ref: 'fixture', id: 'lab', port: 3000 }),
    /identity/,
  )
  await assert.rejects(
    deployUp({ source: 'git', ref: 'fixture', port: 3000 }),
    /unavailable/,
  )
})
test('broker receives owned deployment and cleanup failures propagate', async () => {
  const saved = globalThis.fetch
  const calls: any[] = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(String(options?.body)) })
    return new Response(
      JSON.stringify(
        String(url).endsWith('/down')
          ? { error: 'cleanup failed' }
          : { id: 'lab', baseUrl: 'http://lab-app:3000' },
      ),
      { status: String(url).endsWith('/down') ? 400 : 200 },
    )
  }
  try {
    const env = { NEO_TASK_ID: 'task', NEO_TASK_TOKEN: 'capability' }
    const r = await deployUp(
      { source: 'image', ref: 'fixture:v1', id: 'lab', port: 3000 },
      { env },
    )
    assert.equal(r.baseUrl, 'http://lab-app:3000')
    assert.equal(calls[0].body.task_token, 'capability')
    assert.deepEqual(calls[0].body.spec, {
      services: { app: { image: 'fixture:v1' } },
    })
    await assert.rejects(deployDown({ id: 'lab' }, { env }), /cleanup failed/)
  } finally {
    globalThis.fetch = saved
  }
})
