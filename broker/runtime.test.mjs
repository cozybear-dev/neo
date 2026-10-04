import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
const d = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
test(
  'real worker containment, cancellation, authorization and task files',
  { timeout: 180000 },
  async () => {
    d(
      'build',
      '-q',
      '-f',
      'docker/broker/Dockerfile',
      '-t',
      'neo-review-broker:fixture',
      '.',
    )
    const suffix = randomUUID().slice(0, 8),
      net = `neo-test-${suffix}`,
      volume = `neo-test-state-${suffix}`,
      control = `neo-test-control-${suffix}`,
      broker = `neo-test-broker-${suffix}`,
      task = randomUUID(),
      tasks = [task]
    let addr
    try {
      d('network', 'create', '--internal', net)
      d('volume', 'create', volume)
      d(
        'run',
        '-d',
        '--name',
        control,
        '--network',
        net,
        'node:22.23.0-bookworm-slim',
        'node',
        '-e',
        `require('http').createServer(async(q,r)=>{let b='';for await(const x of q)b+=x;const v=JSON.parse(b);r.writeHead((v.task_token==='fixture'||v.task_token==='terminal'&&v.capability==='cleanup')?200:403);r.end(JSON.stringify({allowed:v.task_token==='fixture'||v.task_token==='terminal'&&v.capability==='cleanup',denylist:[]}))}).listen(8090,'0.0.0.0')`,
      )
      d(
        'run',
        '-d',
        '--name',
        broker,
        '--network',
        net,
        '-v',
        '/var/run/docker.sock:/var/run/docker.sock',
        '-v',
        `${volume}:/state`,
        '-v',
        `${resolve('broker')}:/app:ro`,
        '-e',
        `CONTROL_URL=http://${control}:8090`,
        '-e',
        'NEO_CONTROL_BROKER_TOKEN=fixture',
        '-e',
        'NEO_WORKER_IMAGE=node:22.23.0-bookworm-slim',
        '-e',
        `NEO_STATE_VOLUME=${volume}`,
        '-e',
        `NEO_BROKER_INSTANCE=${suffix}`,
        'neo-review-broker:fixture',
      )
      addr = JSON.parse(d('inspect', broker))[0].NetworkSettings.Networks[net]
        .IPAddress
      const call = async (path, body) => {
        const r = await fetch(`http://${addr}:8091${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            task_id: task,
            task_token: 'fixture',
            ...body,
          }),
        })
        return { status: r.status, ...(await r.json()) }
      }
      for (let i = 0; i < 30; i++) {
        try {
          await fetch(`http://${addr}:8091/healthz`)
          break
        } catch {
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      const denied = await call('/exec', {
        task_token: 'wrong',
        cmd: ['bash', '-lc', 'echo BAD'],
      })
      assert.equal(denied.status, 400)
      const good = await call('/exec', {
        cmd: [
          'bash',
          '-lc',
          "cat input.txt; test ! -S /var/run/docker.sock; node -e \"require('http').get('http://1.1.1.1').on('error',()=>process.exit(0));setTimeout(()=>process.exit(2),500)\"",
        ],
        files: [
          {
            path: 'input.txt',
            body_base64: Buffer.from('fixture').toString('base64'),
          },
        ],
      })
      assert.equal(good.exitCode, 0)
      assert.match(good.stdout, /fixture/)
      const links = await call('/exec', {
        cmd: [
          'bash',
          '-lc',
          'ln -s /proc/self/environ leak; ln input.txt hard',
        ],
      })
      assert.equal(links.exitCode, 0)
      assert(
        !links.files.some((f) =>
          ['leak', 'hard', 'input.txt'].includes(f.path),
        ),
      )
      const writeLink = await call('/exec', {
        cmd: ['true'],
        files: [{ path: 'leak', body_base64: '' }],
      })
      assert.equal(writeLink.status, 400)
      await call('/exec', { cmd: ['bash', '-lc', 'rm -f leak hard'] })
      const bad = await call('/exec', {
        cmd: ['true'],
        files: [{ path: '../escape', body_base64: '' }],
      })
      assert.equal(bad.status, 400)
      const job_id = randomUUID()
      const running = call('/exec', {
        job_id,
        cmd: ['bash', '-lc', 'sleep 2; echo BAD > marker'],
        timeout_ms: 10000,
      })
      await new Promise((r) => setTimeout(r, 350))
      const cancelled = await call('/cancel', { job_id })
      assert.equal(cancelled.terminated, true)
      await running
      await new Promise((r) => setTimeout(r, 2200))
      const check = await call('/exec', {
        cmd: ['bash', '-lc', 'test ! -f marker'],
      })
      assert.equal(check.exitCode, 0)
      const disconnectedId = randomUUID()
      const controller = new AbortController()
      const disconnected = fetch(`http://${addr}:8091/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          task_id: task,
          task_token: 'fixture',
          job_id: disconnectedId,
          cmd: ['bash', '-lc', 'sleep 2; echo BAD > disconnected-marker'],
        }),
      }).catch(() => {})
      await new Promise((r) => setTimeout(r, 350))
      controller.abort()
      await disconnected
      await new Promise((r) => setTimeout(r, 2200))
      const disconnectCheck = await call('/exec', {
        cmd: ['bash', '-lc', 'test ! -f disconnected-marker'],
      })
      assert.equal(disconnectCheck.exitCode, 0)
      const deployed = await call('/deploy/up', {
        id: 'lab',
        spec: {
          services: {
            app: {
              image: 'node:22.23.0-bookworm-slim',
              command: [
                'node',
                '-e',
                "require('http').createServer((q,r)=>r.end('ready')).listen(3000,'0.0.0.0')",
              ],
            },
          },
        },
        port: 3000,
      })
      assert.equal(deployed.status, 200, JSON.stringify(deployed))
      assert.equal(deployed.baseUrl, 'http://lab-app:3000')
      const labExec = await call('/exec', {
        network: 'lab',
        cmd: [
          'node',
          '-e',
          "fetch('http://lab-app:3000').then(r=>r.text()).then(console.log).catch(()=>process.exit(1))",
        ],
      })
      assert.equal(labExec.exitCode, 0, JSON.stringify(labExec))
      assert.match(labExec.stdout, /ready/)
      const httpResult = await call('/request', {
        url: deployed.baseUrl,
        capability: 'traffic',
      })
      assert.equal(httpResult.status, 200, JSON.stringify(httpResult))
      assert.equal(
        Buffer.from(httpResult.body_base64, 'base64').toString(),
        'ready',
      )
      const other = randomUUID()
      tasks.push(other)
      const second = await call('/deploy/up', {
        task_id: other,
        id: 'lab',
        spec: {
          services: {
            app: {
              image: 'node:22.23.0-bookworm-slim',
              command: [
                'node',
                '-e',
                "require('http').createServer((q,r)=>r.end('other')).listen(3000,'0.0.0.0')",
              ],
            },
          },
        },
        port: 3000,
      })
      assert.equal(second.status, 200)
      const ownedResult = await call('/request', {
        url: deployed.baseUrl,
        capability: 'traffic',
      })
      assert.equal(
        Buffer.from(ownedResult.body_base64, 'base64').toString(),
        'ready',
      )
      const otherIP = JSON.parse(d('inspect', `neo-${other}-lab-app`))[0]
        .NetworkSettings.Networks[`neo-task-${other}`].IPAddress
      assert.equal(
        (
          await call('/request', {
            url: `http://${otherIP}:3000`,
            capability: 'traffic',
          })
        ).status,
        400,
      )
      await call('/deploy/down', { task_id: other, id: 'lab' })
      d('network', 'disconnect', `neo-task-${other}`, broker)
      d('network', 'rm', `neo-task-${other}`)
      const pendingId = randomUUID()
      assert.equal(
        (await call('/cancel', { task_id: other, job_id: pendingId }))
          .terminated,
        true,
      )
      assert.equal(
        (await call('/exec', { job_id: pendingId, cmd: ['true'] })).exitCode,
        0,
      )
      assert.equal(
        (await call('/exec', { task_token: 'terminal', cmd: ['true'] })).status,
        400,
      )
      assert.equal(
        (
          await call('/cancel', {
            task_token: 'terminal',
            job_id: randomUUID(),
          })
        ).terminated,
        true,
      )
      const down = await call('/deploy/down', {
        id: 'lab',
        task_token: 'terminal',
      })
      assert.equal(down.ok, true)
      assert.equal((await call('/deploy/down', { id: 'lab' })).ok, true)
      const traversal = await call('/deploy/up', {
        id: '../../bad',
        spec: { services: { app: { image: 'node:22.23.0-bookworm-slim' } } },
        port: 80,
      })
      assert.equal(traversal.status, 400)
    } finally {
      for (const name of [broker, control]) {
        try {
          d('rm', '-f', name)
        } catch {}
      }
      for (const t of tasks) {
        for (const name of d('ps', '-aq', '--filter', `label=neo.task=${t}`)
          .split('\n')
          .filter(Boolean)) {
          try {
            d('rm', '-f', name)
          } catch {}
        }
        try {
          d('network', 'rm', `neo-task-${t}`)
        } catch {}
      }
      try {
        d('volume', 'rm', volume)
      } catch {}
      try {
        d('network', 'rm', net)
      } catch {}
      for (const name of d('ps', '-aq', '--filter', `label=neo.task=${task}`)
        .split('\n')
        .filter(Boolean)) {
        try {
          d('rm', '-f', name)
        } catch {}
      }
    }
  },
)
