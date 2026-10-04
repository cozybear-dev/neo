import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  replayTraffic,
  readTraffic,
  trafficPath,
  renderSafe,
} from './client.ts'
const env = {
  NEO_TASK_ID: '11111111-1111-4111-8111-111111111111',
  NEO_TASK_TOKEN: 'credential',
  NEO_WORKSPACE_BASE: '/tmp/neo',
}
const record = {
  id: 'r',
  method: 'POST',
  url: 'http://lab/base',
  headers: {
    Authorization: 'old',
    Connection: 'X-Extra',
    'X-Extra': 'remove',
    Host: 'bad',
  },
  postData: 'body',
  timestamp: 'now',
}
function opts(status = 200) {
  const calls: any[] = []
  return {
    calls,
    options: {
      env,
      fs: {
        mkdir: async () => {},
        writeFile: async () => {},
        appendFile: async () => {},
        readFile: async () => JSON.stringify(record) + '\n',
      },
      fetch: async (url: string, init: any) => {
        calls.push({ url, init })
        return {
          status,
          text: async () =>
            JSON.stringify({
              status: 302,
              headers: { location: 'http://canary/' },
              body_base64: Buffer.from('reply').toString('base64'),
            }),
        }
      },
    },
  }
}
test('replay canonical relative edit, case-insensitive header replacement and no redirect following', async () => {
  const a = opts()
  const result = await replayTraffic(
    { id: 'r', edits: { url: '../next', headers: { authorization: 'new' } } },
    a.options,
  )
  assert.equal(result.status, 302)
  assert.equal(result.body, 'reply')
  assert.equal(a.calls.length, 1)
  assert.equal(a.calls[0].url, 'http://broker:8091/request')
  const payload = JSON.parse(a.calls[0].init.body)
  assert.equal(payload.url, 'http://lab/next')
  assert.equal(payload.headers.authorization, 'new')
  assert.equal(payload.headers.host, undefined)
  assert.equal(payload.headers['x-extra'], undefined)
  assert.equal(payload.task_token, 'credential')
})
test('scope revoked since capture is denied at current broker boundary', async () => {
  const a = opts(403)
  await assert.rejects(() => replayTraffic({ id: 'r' }, a.options), /denied/)
  assert.equal(a.calls.length, 1)
})
test('cross-origin edits and invalid credentials fail before network submission', async () => {
  const a = opts()
  await assert.rejects(
    () =>
      replayTraffic({ id: 'r', edits: { url: 'http://canary/' } }, a.options),
    /destination/,
  )
  await assert.rejects(
    () => replayTraffic({ id: 'r' }, { ...a.options, env: {} }),
    /identity/,
  )
  assert.equal(a.calls.length, 0)
})
test('task stores are isolated and corrupt or excessive records fail visibly', async () => {
  assert.throws(() => trafficPath({ env: {} }))
  assert.match(trafficPath({ env }), /tasks\/11111111/)
  const a = opts()
  await assert.rejects(
    () =>
      readTraffic({
        ...a.options,
        fs: { ...a.options.fs, readFile: async () => '{invalid' },
      }),
    /corrupt/,
  )
})
test('model-visible body and URL secrets are redacted', () => {
  const rendered = renderSafe(
    {},
    { body: 'password=secret-value', url: 'http://lab/?api_key=key-value' },
  )[0].text
  assert.equal(rendered.includes('secret-value'), false)
  assert.equal(rendered.includes('key-value'), false)
})
