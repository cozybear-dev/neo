import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  registerOast,
  pollOast,
  cleanupOast,
} from '../plugins/neo-tools-oast/src/client.ts'
import { connectCdp } from '../plugins/neo-tools-browser/src/client.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
process.chdir(root)
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  }).trim()
function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`)
}
async function ready(url) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`service readiness failed: ${url}`)
}
const brokerImage = 'neo-review-broker:fixture'
docker('info')
run('docker', [
  'build',
  '-f',
  'docker/broker/Dockerfile',
  '-t',
  brokerImage,
  '.',
])
run(process.execPath, [
  '--test',
  'broker/policy.test.mjs',
  'broker/runtime.test.mjs',
])
run('bash', ['docker/browser/smoke.sh'])
run('bash', ['plugins/neo-tools-oast/scripts/service-smoke.sh'], {
  NEO_TEST_NODE: process.execPath,
})

// A real broker, target-only service, browser and Interactsh using disposable state.
const suffix = randomUUID().slice(0, 8),
  network = `neo-services-${suffix}`,
  volume = `neo-services-state-${suffix}`,
  browserNetwork = `neo-services-browser-link-${suffix}`
const names = {
  control: `neo-services-control-${suffix}`,
  broker: `neo-services-broker-${suffix}`,
  oast: `neo-services-oast-${suffix}`,
  browser: `neo-services-browser-${suffix}`,
}
const task = randomUUID(),
  otherTask = randomUUID(),
  token = 'service-fixture',
  store = new Map()
let browser, brokerAddress, oastAddress
const created = []
const ip = (name, net = network) =>
  JSON.parse(docker('inspect', name))[0].NetworkSettings.Networks[net].IPAddress
const call = async (path, body = {}, owner = task) => {
  const response = await fetch(`http://${brokerAddress}:8091${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task_id: owner, task_token: token, ...body }),
    signal: AbortSignal.timeout(45000),
  })
  return { http: response.status, ...(await response.json()) }
}
try {
  docker('network', 'create', '--internal', network)
  docker('volume', 'create', volume)
  docker('network', 'create', '--internal', browserNetwork)
  const mock = `require('http').createServer(async(q,r)=>{let text='';for await(const x of q)text+=x;const b=JSON.parse(text);const allowed=b.task_token==='${token}'&&['${task}','${otherTask}'].includes(b.task_id);r.writeHead(allowed?200:403);r.end(JSON.stringify({allowed,denylist:[]}))}).listen(8090,'0.0.0.0')`
  docker(
    'run',
    '-d',
    '--name',
    names.control,
    '--network',
    network,
    '--network-alias',
    'control',
    'node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2',
    'node',
    '-e',
    mock,
  )
  created.push(names.control)
  docker(
    'run',
    '-d',
    '--name',
    names.oast,
    '--network',
    network,
    '--network-alias',
    'interactsh',
    'projectdiscovery/interactsh-server@sha256:246d8988fed0cfefb28f904c4e1ec4a6bb4b6931288d10794a31577687f02471',
    '-d',
    'oast.neo.internal',
    '-ip',
    '127.0.0.1',
    '-sa',
    '-duc',
  )
  created.push(names.oast)
  docker(
    'run',
    '-d',
    '--name',
    names.broker,
    '--network',
    network,
    '--network-alias',
    'broker',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${volume}:/state`,
    '-e',
    `CONTROL_URL=http://${names.control}:8090`,
    '-e',
    'NEO_CONTROL_BROKER_TOKEN=service-fixture',
    '-e',
    'NEO_WORKER_IMAGE=node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2',
    '-e',
    `NEO_STATE_VOLUME=${volume}`,
    '-e',
    `NEO_BROKER_INSTANCE=${suffix}`,
    brokerImage,
  )
  created.push(names.broker)
  brokerAddress = ip(names.broker)
  oastAddress = ip(names.oast)
  await ready(`http://${brokerAddress}:8091/healthz`)
  const spec = {
    services: {
      app: {
        image:
          'node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2',
        command: [
          'node',
          '-e',
          "require('http').createServer((q,r)=>{r.setHeader('content-type','text/html');r.end('<html><title>target-only</title><body>lab</body></html>')}).listen(3000,'0.0.0.0')",
        ],
      },
    },
  }
  const deployed = await call('/deploy/up', { id: 'fixture', spec, port: 3000 })
  assert.equal(deployed.http, 200, JSON.stringify(deployed))
  const ownedContainer = `neo-${task}-fixture-app`
  const response = await call('/request', {
    url: deployed.baseUrl,
    method: 'GET',
    capability: 'traffic',
  })
  assert.equal(response.status, 200, JSON.stringify(response))
  assert.match(
    Buffer.from(response.body_base64, 'base64').toString(),
    /target-only/,
  )
  for (const url of [
    'http://control:8090/',
    'http://127.0.0.1/',
    'http://169.254.169.254/',
    'http://[::ffff:127.0.0.1]/',
  ]) {
    assert.notEqual(
      (await call('/request', { url, capability: 'traffic' })).http,
      200,
      url,
    )
  }
  const other = await call(
    '/deploy/up',
    { id: 'other', spec, port: 3000 },
    otherTask,
  )
  assert.equal(other.http, 200, JSON.stringify(other))
  const otherInfo = JSON.parse(
    docker('inspect', `neo-${otherTask}-other-app`),
  )[0]
  const otherIP =
    otherInfo.NetworkSettings.Networks[`neo-task-${otherTask}`].IPAddress
  assert.notEqual(
    (
      await call('/request', {
        url: `http://${otherIP}:3000/`,
        capability: 'traffic',
      })
    ).http,
    200,
    'cross-task private IP denied',
  )
  assert.notEqual(
    (await call('/request', { url: other.baseUrl, capability: 'traffic' }))
      .http,
    200,
    'cross-task alias denied',
  )
  const env = {
    NEO_TASK_ID: task,
    NEO_TASK_TOKEN: token,
    INTERACTSH_URL: `http://${oastAddress}:80`,
    INTERACTSH_CALLBACK_DOMAIN: 'oast.neo.internal',
    INTERACTSH_DNS_ENABLED: 'false',
    INTERACTSH_CALLBACK_BASE_URL: 'http://broker:8091/oast/callback',
    NEO_BROKER_URL: `http://${brokerAddress}:8091`,
    NEO_WORKSPACE_BASE: '/tmp/neo-services',
  }
  const registration = await registerOast({ kind: 'http' }, { env, store })
  const callbackScript = `fetch(${JSON.stringify(registration.url)}).then(async r=>{await r.text();if(!r.ok)process.exit(1)}).catch(e=>{console.error(e);process.exit(1)})`
  docker('exec', ownedContainer, 'node', '-e', callbackScript)
  const hits = await pollOast(
    { id: registration.id, wait_seconds: 5 },
    { env, store },
  )
  assert.ok(
    hits.some(
      (hit) => hit.protocol === 'http' && hit.fullId.includes(registration.id),
    ),
    'target-only generated URL callback must yield decrypted interaction',
  )
  // Browser has no membership in task networks. Broker alone mediates lab reachability.
  docker(
    'run',
    '-d',
    '--name',
    names.browser,
    '--network',
    browserNetwork,
    'neo-browser-remediation-check',
  )
  created.push(names.browser)
  await ready(`http://${ip(names.browser, browserNetwork)}:9222/json/version`)
  browser = await connectCdp({
    env,
    cdpUrl: `http://${ip(names.browser, browserNetwork)}:9222`,
  })
  assert.equal((await browser.navigate(deployed.baseUrl)).title, 'target-only')
  assert.equal(
    await browser.evaluate(
      'fetch("http://control:8090/healthz").then(()=>"allowed",()=>"blocked")',
    ),
    'blocked',
  )
  await cleanupOast({ env, store }, true)
  await call('/deploy/down', { id: 'fixture' })
  await call('/deploy/down', { id: 'other' }, otherTask)
  console.log(
    'Real broker/target-only browser/replay/OAST callback, control-address denial and cross-task network denial passed',
  )
} finally {
  await browser?.close().catch(() => {})
  for (const owner of [task, otherTask]) {
    for (const id of docker('ps', '-aq', '--filter', `label=neo.task=${owner}`)
      .split('\n')
      .filter(Boolean))
      try {
        docker('rm', '-f', id)
      } catch {}
  }
  for (const name of created.reverse())
    try {
      docker('rm', '-f', name)
    } catch {}
  for (const owner of [task, otherTask])
    try {
      docker('network', 'rm', `neo-task-${owner}`)
    } catch {}
  try {
    docker('volume', 'rm', volume)
  } catch {}
  try {
    docker('network', 'rm', network)
  } catch {}
  try {
    docker('network', 'rm', browserNetwork)
  } catch {}
}
