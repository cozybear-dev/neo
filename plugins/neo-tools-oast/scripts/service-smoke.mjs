import assert from 'node:assert/strict'
import { request } from 'node:http'
import { registerOast, pollOast, cleanupOast } from '../src/client.ts'
const endpoint = process.env.NEO_OAST_TEST_URL
if (!endpoint)
  throw new Error('NEO_OAST_TEST_URL must point to disposable Interactsh1.4.1')
const env = {
  NEO_TASK_ID: '11111111-1111-4111-8111-111111111111',
  INTERACTSH_URL: endpoint,
  INTERACTSH_CALLBACK_DOMAIN: 'oast.neo.internal',
  INTERACTSH_DNS_ENABLED: 'false',
}
const store = new Map()
const options = {
  env: { ...env, NEO_TASK_TOKEN: 'isolated-service-fixture' },
  store,
  fetch: async (url, init) =>
    url.endsWith('/oast/authorize')
      ? { status: 200, text: async () => JSON.stringify({ allowed: true }) }
      : fetch(url, init),
}
try {
  const reg = await registerOast({ kind: 'http' }, options)
  assert.match(
    reg.domain.slice(reg.id.length).split('.')[0],
    /^[ybndrfg8ejkmcpqxot1uwisza345h769]{13}$/,
  )
  await new Promise((resolve, reject) => {
    const req = request(endpoint, { headers: { Host: reg.domain } }, (res) => {
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('callback timeout')))
    req.end()
  })
  const interactions = await pollOast({ id: reg.id, wait_seconds: 5 }, options)
  assert.ok(
    interactions.some(
      (hit) => hit.protocol === 'http' && hit.fullId.includes(reg.id),
    ),
    JSON.stringify(interactions),
  )
  console.log(
    'Interactsh1.4.1 real registration + generated nonce HTTP callback + decrypted poll passed',
  )
} finally {
  await cleanupOast(options, true)
}
