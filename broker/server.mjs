import http from 'node:http'
import https from 'node:https'
import { BlockList } from 'node:net'
import { lookup } from 'node:dns/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  writeFile,
  readFile,
  chmod,
  chown,
  lstat,
  readdir,
  open,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { validId, validateCompose } from './policy.mjs'
let capabilityPromise
const jobs = new Map()
const activeTasks = new Set()
const cancelled = new Set()
const limit = 1024 * 1024
const root = '/state'
function deniedIP(ip, denylist = []) {
  return denylist.some((pattern) => {
    if (ip === pattern) return true
    if (!pattern.includes('/')) return false
    const [net, bits] = pattern.split('/')
    try {
      const b = new BlockList()
      b.addSubnet(net, Number(bits))
      return b.check(ip)
    } catch {
      return false
    }
  })
}
async function auth(b, capability, target) {
  const r = await fetch(
    `${process.env.CONTROL_URL || 'http://control:8090'}/internal/authorize`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.NEO_CONTROL_BROKER_TOKEN}`,
      },
      body: JSON.stringify({
        task_id: b.task_id,
        task_token: b.task_token,
        capability,
        target,
      }),
      signal: AbortSignal.timeout(5000),
    },
  )
  if (!r.ok) throw new Error('task authorization rejected')
  const p = await r.json()
  if (!p.allowed) throw new Error('scope or approval rejected')
  return p
}
function docker(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const c = spawn('docker', args)
    let out = '',
      err = ''
    const timer = setTimeout(() => c.kill('SIGKILL'), timeout)
    c.stdout.on('data', (x) => {
      out = (out + x).slice(0, limit)
    })
    c.stderr.on('data', (x) => {
      err = (err + x).slice(0, limit)
    })
    c.on('error', reject)
    c.on('close', (code) => {
      clearTimeout(timer)
      if (code)
        reject(new Error(`Docker operation failed: ${err.slice(0, 2048)}`))
      else resolve(out.trim())
    })
  })
}
async function taskNetwork(task) {
  const name = `neo-task-${task}`
  let n
  try {
    n = JSON.parse(await docker(['network', 'inspect', name]))[0]
  } catch {
    await docker([
      'network',
      'create',
      '--internal',
      '--label',
      `neo.task=${task}`,
      name,
    ])
    n = JSON.parse(await docker(['network', 'inspect', name]))[0]
  }
  if (!n.Internal || n.Labels?.['neo.task'] !== task)
    throw new Error('task network ownership or isolation mismatch')
  const self = JSON.parse(await docker(['inspect', process.env.HOSTNAME]))[0]
  if (!self.NetworkSettings.Networks[name])
    await docker([
      'network',
      'connect',
      '--alias',
      'broker',
      name,
      process.env.HOSTNAME,
    ])
  for (const id of (
    await docker([
      'ps',
      '-q',
      '--filter',
      `label=neo.task=${task}`,
      '--filter',
      'label=neo.lab=1',
    ])
  )
    .split('\n')
    .filter(Boolean)) {
    const c = await owned(id, task)
    if (!c.NetworkSettings.Networks[name])
      await docker(['network', 'connect', '--alias', 'juice-shop', name, id])
  }
  return name
}
async function safeWrite(file, data) {
  const f = await open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const stat = await f.stat()
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error('artifact must be regular without hardlinks')
    await f.truncate(0)
    await f.writeFile(data)
    await f.chown(1000, 1000)
  } finally {
    await f.close()
  }
}
async function workspace(task, files = []) {
  const dir = `${root}/files/${task}`
  await mkdir(dir, { recursive: true, mode: 0o700 })
  if (!(await lstat(dir)).isDirectory())
    throw new Error('task workspace is not directory')
  await chown(dir, 1000, 1000)
  if (!Array.isArray(files) || files.length > 128)
    throw new Error('file count exceeded')
  let total = 0
  for (const f of files) {
    if (
      typeof f.path !== 'string' ||
      !/^[a-zA-Z0-9_. /-]+$/.test(f.path) ||
      f.path.startsWith('/') ||
      f.path.split('/').some((p) => p === '..' || p === '.' || !p) ||
      f.path.split('/').length > 16
    )
      throw new Error('invalid artifact path')
    const parts = f.path.split('/')
    let current = dir
    for (const part of parts.slice(0, -1)) {
      current += '/' + part
      await mkdir(current, { recursive: true })
      if (!(await lstat(current)).isDirectory())
        throw new Error('artifact parent is not directory')
      await chown(current, 1000, 1000)
    }
    const data = Buffer.from(f.body_base64, 'base64')
    total += data.length
    if (data.length > 65536 || total > 512000)
      throw new Error('artifact size exceeded')
    await safeWrite(dir + '/' + f.path, data)
  }
  return dir
}
async function artifacts(dir) {
  const result = []
  let total = 0,
    visited = 0
  async function walk(current, prefix, depth) {
    if (depth > 16) return
    for (const e of await readdir(current, { withFileTypes: true })) {
      if (++visited > 256 || result.length >= 128 || total >= 512000) return
      const file = current + '/' + e.name,
        path = prefix + e.name
      const stat = await lstat(file)
      if (stat.isDirectory()) await walk(file, path + '/', depth + 1)
      else if (stat.isFile() && stat.nlink === 1 && stat.size <= 65536) {
        const f = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const check = await f.stat()
          if (!check.isFile() || check.nlink !== 1 || check.size > 65536)
            continue
          const b = await f.readFile()
          if (total + b.length > 512000) return
          total += b.length
          result.push({ path, body_base64: b.toString('base64') })
        } finally {
          await f.close()
        }
      }
    }
  }
  await walk(dir, '', 0)
  return result
}
async function owned(name, task) {
  const raw = await docker(['inspect', name])
  const item = JSON.parse(raw)[0]
  if (item.Config.Labels['neo.task'] !== task)
    throw new Error('resource ownership mismatch')
  return item
}
async function request(b, signal) {
  const policy = await auth(
    b,
    b.capability === 'browser' ? 'browser' : 'traffic',
    b.url,
  )
  const u = new URL(b.url)
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new Error('unsupported URL')
  if (
    [
      'control',
      'postgres',
      'broker',
      'dsh',
      'browser',
      'ghidra',
      'localhost',
    ].includes(u.hostname)
  )
    throw new Error('control plane destination denied')
  await taskNetwork(b.task_id)
  const ownIps = new Set()
  let ownedAddress
  try {
    const net = JSON.parse(
      await docker(['network', 'inspect', `neo-task-${b.task_id}`]),
    )[0]
    if (!net.Internal || net.Labels?.['neo.task'] !== b.task_id)
      throw new Error('invalid task network')
    for (const c of Object.values(net.Containers || {})) {
      const item = JSON.parse(await docker(['inspect', c.Name]))[0]
      if (item.Config.Labels?.['neo.task'] !== b.task_id) continue
      const n = item.NetworkSettings.Networks[net.Name]
      ownIps.add(n.IPAddress)
      if ((n.Aliases || []).includes(u.hostname)) ownedAddress = n.IPAddress
    }
  } catch (e) {
    if (!/No such (object|network)/.test(e.message)) throw e
  }
  const addresses = ownedAddress
    ? [{ address: ownedAddress, family: 4 }]
    : await lookup(u.hostname, { all: true })
  if (addresses.some((a) => a.family !== 4))
    throw new Error('IPv6 proxy destinations unsupported')
  if (!addresses.length) throw new Error('DNS failed')
  const blocked = new Set()
  for (const host of [
    'control',
    'postgres',
    'broker',
    'dsh',
    'browser',
    'ghidra',
  ]) {
    try {
      for (const a of await lookup(host, { all: true })) blocked.add(a.address)
    } catch {}
  }
  for (const id of (await docker(['ps', '-q', '--filter', 'label=neo.task']))
    .split('\n')
    .filter(Boolean)) {
    const item = JSON.parse(await docker(['inspect', id]))[0]
    if (item.Config.Labels['neo.task'] !== b.task_id)
      for (const n of Object.values(item.NetworkSettings.Networks || {}))
        blocked.add(n.IPAddress)
  }
  const self = JSON.parse(await docker(['inspect', process.env.HOSTNAME]))[0]
  for (const n of Object.values(self.NetworkSettings.Networks || {}))
    blocked.add(n.IPAddress)
  const matches = (ip, pattern) => {
    if (ip === pattern) return true
    if (!pattern.includes('/')) return false
    const [net, bits] = pattern.split('/')
    const n = Number(bits)
    const num = (x) =>
      x.split('.').reduce((a, b) => (a * 256 + Number(b)) >>> 0, 0)
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || n < 0 || n > 32) return false
    const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0
    return (num(ip) & mask) === (num(net) & mask)
  }
  const special = new BlockList()
  for (const [ip, bits] of [
    ['0.0.0.0', 8],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
    ['192.0.0.0', 24],
    ['198.18.0.0', 15],
  ])
    special.addSubnet(ip, bits)
  const privateIps = new BlockList()
  for (const [ip, bits] of [
    ['10.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['100.64.0.0', 10],
  ])
    privateIps.addSubnet(ip, bits)
  for (const a of addresses) {
    if (
      special.check(a.address) ||
      (privateIps.check(a.address) && !ownIps.has(a.address))
    )
      throw new Error('non-owned private or reserved destination denied')
    if (
      blocked.has(a.address) ||
      /^(127\.|0\.|169\.254\.)/.test(a.address) ||
      a.address === '::1' ||
      (policy.denylist || []).some((p) => matches(a.address, p))
    )
      throw new Error('resolved destination denied')
  }

  const normalize = (input) =>
    Object.fromEntries(
      Object.entries(input || {}).map(([k, v]) => [k.toLowerCase(), v]),
    )
  const filter = (input) => {
    const normalized = normalize(input)
    const nominated = String(normalized.connection || '')
      .toLowerCase()
      .split(',')
      .map((x) => x.trim())
    return Object.fromEntries(
      Object.entries(normalized).filter(
        ([k]) =>
          ![
            'host',
            'connection',
            'transfer-encoding',
            'content-length',
            'upgrade',
            'te',
            'trailer',
            'keep-alive',
            'proxy-authenticate',
            'proxy-authorization',
          ].includes(k) &&
          !k.startsWith('proxy-') &&
          !nominated.includes(k),
      ),
    )
  }
  const headers = filter(b.headers)
  if (Object.keys(headers).length > 100) throw new Error('too many headers')
  if (!/^[A-Z]{1,16}$/.test(b.method || 'GET') || b.method === 'CONNECT')
    throw new Error('unsupported method')

  if (signal?.aborted) throw new Error('request cancelled')
  return new Promise((resolve, reject) => {
    const r = (u.protocol === 'https:' ? https : http).request(
      u,
      {
        method: b.method || 'GET',
        headers,
        signal,
        lookup: (_h, _o, cb) =>
          _o.all
            ? cb(null, [addresses[0]])
            : cb(null, addresses[0].address, addresses[0].family),
        timeout: 15000,
      },
      (res) => {
        let n = 0
        const chunks = []
        res.on('data', (x) => {
          n += x.length
          if (n > limit) {
            r.destroy(new Error('response limit exceeded'))
            return
          }
          chunks.push(x)
        })
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: filter(res.headers),
            body_base64: Buffer.concat(chunks).toString('base64'),
          }),
        )
      },
    )
    r.on('timeout', () => r.destroy(new Error('request deadline')))
    r.on('error', reject)
    if (b.body_base64) r.write(Buffer.from(b.body_base64, 'base64'))
    r.end()
  })
}
async function handle(path, b, signal) {
  if (path === '/request') return request(b, signal)
  if (path === '/oast/authorize') {
    await auth(b, 'exec')
    return { allowed: true }
  }
  if (path === '/capabilities') {
    await auth(b, 'exec')
    capabilityPromise ||= docker(
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '128',
        '--memory',
        '1g',
        '--cpus',
        '1',
        '--user',
        '1000:1000',
        process.env.NEO_WORKER_IMAGE || 'neo-sandbox:local',
        '/usr/local/bin/neo-capabilities',
      ],
      60000,
    )
      .then(JSON.parse)
      .catch((e) => {
        capabilityPromise = undefined
        throw e
      })
    return capabilityPromise
  }

  if (path === '/exec') {
    await auth(b, 'exec')
    if (activeTasks.has(b.task_id) || jobs.size >= 16)
      throw new Error('task worker already active or quota exceeded')
    activeTasks.add(b.task_id)
    const id = b.job_id || randomUUID()
    let name,
      timer,
      revoke,
      registered = false
    const abort = () => {
      cancelled.add(`${b.task_id}:${id}`)
      if (name) void docker(['rm', '-f', name]).catch(() => {})
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (!/^[0-9a-f-]{36}$/.test(id) || jobs.has(id))
        throw new Error('invalid or reused job id')
      name = `neo-job-${id}`
      jobs.set(id, { name, task: b.task_id })
      registered = true
      if (
        !Array.isArray(b.cmd) ||
        !b.cmd.length ||
        b.cmd.some((x) => typeof x !== 'string') ||
        (b.env && Object.keys(b.env).length)
      )
        throw new Error('invalid exec spec; caller environment unsupported')
      if (
        b.cwd &&
        b.cwd !== '/workspace' &&
        (!b.cwd.startsWith('/workspace/') || b.cwd.split('/').includes('..'))
      )
        throw new Error('cwd must be inside task workspace')
      const workdir = await workspace(b.task_id, b.files)
      const home = workdir + '/.home'
      await mkdir(home, { recursive: true })
      if (!(await lstat(home)).isDirectory())
        throw new Error('invalid home directory')
      await chown(home, 1000, 1000)
      const net = b.network === 'lab' ? await taskNetwork(b.task_id) : 'none'
      const targets = []
      const targetIPs = new Map()
      if (net !== 'none') {
        const ni = JSON.parse(await docker(['network', 'inspect', net]))[0]
        for (const entry of Object.values(ni.Containers || {})) {
          const inspected = JSON.parse(await docker(['inspect', entry.Name]))[0]
          if (inspected.Id.startsWith(process.env.HOSTNAME)) continue
          const item = await owned(entry.Name, b.task_id)
          const alias = item.NetworkSettings.Networks[net].Aliases?.find(
            (x) => x !== entry.Name && x.length < 64,
          )
          if (!alias) throw new Error('missing lab scope alias')
          targets.push(`http://${alias}`)
          targetIPs.set(
            targets.at(-1),
            item.NetworkSettings.Networks[net].IPAddress,
          )
          const policy = await auth(b, 'exec', targets.at(-1))
          if (
            deniedIP(
              item.NetworkSettings.Networks[net].IPAddress,
              policy.denylist,
            )
          )
            throw new Error('resolved lab target excluded')
        }
      }
      const timeout = Math.max(100, Math.min(b.timeout_ms || 120000, 300000))
      await docker([
        'create',
        '--name',
        name,
        '--label',
        `neo.task=${b.task_id}`,
        '--label',
        'neo.worker=1',
        '--label',
        `neo.broker=${process.env.NEO_BROKER_INSTANCE || 'neo-main'}`,
        '--network',
        net,
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '128',
        '--memory',
        '1g',
        '--cpus',
        '1',
        '--user',
        '1000:1000',
        '--env',
        'HOME=/workspace/.home',
        '--workdir',
        b.cwd || '/workspace',
        '--mount',
        `type=volume,src=${process.env.NEO_STATE_VOLUME || 'neo_broker_state'},dst=/workspace,volume-subpath=files/${b.task_id}`,
        '--log-opt',
        'max-size=2m',
        '--log-opt',
        'max-file=1',
        process.env.NEO_WORKER_IMAGE || 'neo-sandbox:local',
        ...b.cmd,
      ])
      if (signal?.aborted || cancelled.has(`${b.task_id}:${id}`))
        throw new Error('job cancelled before start')
      await docker(['start', name])
      revoke = setInterval(
        () =>
          Promise.all([
            auth(b, 'exec'),
            ...targets.map(async (t) => {
              const p = await auth(b, 'exec', t)
              if (deniedIP(targetIPs.get(t), p.denylist))
                throw new Error('resolved target revoked')
            }),
          ]).catch(() => docker(['rm', '-f', name]).catch(() => {})),
        2000,
      )
      timer = setTimeout(
        () => docker(['rm', '-f', name]).catch(() => {}),
        timeout,
      )
      await docker(['wait', name], timeout + 5000)
      const info = await owned(name, b.task_id)
      const stdout = await docker(['logs', name])
      // Remove process namespace before touching attacker-owned artifacts.
      await docker(['rm', '-f', name])
      name = undefined
      const logdir = `${root}/logs/${b.task_id}`
      await mkdir(logdir, { recursive: true, mode: 0o700 })
      await writeFile(`${logdir}/${id}.log`, stdout, { mode: 0o600 })
      return {
        job_id: id,
        artifactRef: `broker://${b.task_id}/exec-${id}.log`,
        truncated: stdout.length >= 65536,
        stdout: stdout.slice(0, 65536),
        stderr: '',
        exitCode: info.State.ExitCode,
        network: net,
        files: await artifacts(workdir),
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      clearTimeout(timer)
      clearInterval(revoke)
      if (name) await docker(['rm', '-f', name]).catch(() => {})
      if (registered) {
        jobs.delete(id)
        cancelled.delete(`${b.task_id}:${id}`)
      }
      activeTasks.delete(b.task_id)
    }
  }
  if (path === '/cancel') {
    await auth(b, 'cleanup')
    if (!/^[0-9a-f-]{36}$/i.test(b.job_id || ''))
      throw new Error('valid job id required')
    const j = jobs.get(b.job_id)
    if (!j) {
      cancelled.add(`${b.task_id}:${b.job_id}`)
      setTimeout(
        () => cancelled.delete(`${b.task_id}:${b.job_id}`),
        300000,
      ).unref()
      return { terminated: true, pending: true }
    }
    if (j.task !== b.task_id) throw new Error('unknown owned job')
    cancelled.add(`${b.task_id}:${b.job_id}`)
    await docker(['rm', '-f', j.name]).catch((e) => {
      if (!/No such (object|container)/.test(e.message)) throw e
    })
    return { terminated: true }
  }
  if (path === '/deploy/up') {
    await auth(b, 'deploy')
    const id = validId(b.id),
      project = `neo-${b.task_id}-${id}`
    const dir = `${root}/${b.task_id}/${id}`
    await mkdir(dir, { recursive: true })
    try {
      await readFile(`${dir}/meta.json`)
      throw new Error('deployment id already exists')
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    const services = validateCompose(b.spec)
    for (const service of services)
      await auth(b, 'deploy', `http://${id}-${service.name}`)
    const net = await taskNetwork(b.task_id)
    const port = Number(b.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('explicit endpoint port required')
    const service = b.service || services[0].name
    if (!services.some((x) => x.name === service))
      throw new Error('unknown endpoint service')
    const meta = {
      id,
      project,
      task: b.task_id,
      containers: [],
      state: 'starting',
      spec: b.spec,
      service,
      port,
    }
    await writeFile(`${dir}/meta.json`, JSON.stringify(meta), { mode: 0o600 })
    try {
      for (const s of services) {
        if (signal?.aborted) throw new Error('deployment cancelled')
        if (`${id}-${s.name}`.length > 63)
          throw new Error('deployment service alias too long')
        const name = `${project}-${s.name}`
        const args = [
          'create',
          '--name',
          name,
          '--label',
          `neo.task=${b.task_id}`,
          '--label',
          `neo.deploy=${id}`,
          '--network',
          net,
          '--network-alias',
          `${id}-${s.name}`,
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--pids-limit',
          '128',
          '--memory',
          '1g',
          '--cpus',
          '1',
          '--log-opt',
          'max-size=2m',
        ]
        for (const [k, v] of Object.entries(s.environment || {}))
          args.push('-e', `${k}=${v}`)
        if (s.entrypoint) throw new Error('entrypoint override unsupported')
        args.push(s.image, ...(s.command || []))
        await docker(args)
        meta.containers.push(name)
        await writeFile(`${dir}/meta.json`, JSON.stringify(meta))
        await docker(['start', name])
      }
      await docker([
        'network',
        'connect',
        '--alias',
        'broker',
        net,
        process.env.HOSTNAME,
      ]).catch(() => {})
      const baseUrl = `http://${id}-${service}:${port}`
      const endpoint = await owned(`${project}-${service}`, b.task_id)
      const readinessUrl = `http://${endpoint.NetworkSettings.Networks[net].IPAddress}:${port}`
      let ready = false
      for (let i = 0; i < 30; i++) {
        if (signal?.aborted) throw new Error('deployment cancelled')
        try {
          const r = await fetch(readinessUrl, {
            headers: { host: `${id}-${service}:${port}` },
            signal: AbortSignal.timeout(1000),
            redirect: 'manual',
          })
          if (r.status < 500) {
            ready = true
            break
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 500))
      }
      if (!ready) throw new Error('deployment readiness deadline')
      meta.state = 'ready'
      meta.baseUrl = baseUrl
      await writeFile(`${dir}/meta.json`, JSON.stringify(meta))
      return {
        id,
        project,
        network: 'targets',
        baseUrl,
        logPath: `broker://${b.task_id}/${id}/meta.json`,
      }
    } catch (e) {
      meta.state = 'failed'
      for (const n of meta.containers)
        await docker(['rm', '-f', n]).catch(() => {})
      await writeFile(`${dir}/meta.json`, JSON.stringify(meta))
      throw e
    }
  }
  if (path === '/deploy/down') {
    await auth(b, 'cleanup')
    const id = validId(b.id),
      dir = `${root}/${b.task_id}/${id}`
    const m = JSON.parse(await readFile(`${dir}/meta.json`))
    for (const n of m.containers) {
      try {
        await owned(n, b.task_id)
        await docker(['rm', '-f', n])
      } catch (e) {
        if (!/No such (object|container)/.test(e.message)) throw e
      }
    }
    m.state = 'removed'
    await writeFile(`${dir}/meta.json`, JSON.stringify(m))
    return { id, project: m.project, ok: true }
  }
  throw new Error('unsupported operation')
}
await mkdir(root, { recursive: true })
for (const id of (
  await docker([
    'ps',
    '-aq',
    '--filter',
    'label=neo.worker=1',
    '--filter',
    `label=neo.broker=${process.env.NEO_BROKER_INSTANCE || 'neo-main'}`,
  ])
)
  .split('\n')
  .filter(Boolean)) {
  const info = JSON.parse(await docker(['inspect', id]))[0]
  if (info.Name.startsWith('/neo-job-')) await docker(['rm', '-f', id])
}

http
  .createServer(async (req, res) => {
    const disconnect = new AbortController()
    res.on('close', () => disconnect.abort())
    try {
      if (req.url?.startsWith('/oast/callback/')) {
        const domain = decodeURIComponent(
          req.url.slice('/oast/callback/'.length),
        )
        const suffix =
          process.env.INTERACTSH_CALLBACK_DOMAIN || 'oast.neo.internal'
        if (
          !['GET', 'POST'].includes(req.method) ||
          !domain.endsWith('.' + suffix) ||
          !new RegExp(
            '^[a-z0-9]{20,80}\\.' + suffix.replaceAll('.', '\\.') + '$',
          ).test(domain)
        )
          throw new Error('invalid callback')
        let size = 0
        const chunks = []
        for await (const x of req) {
          size += x.length
          if (size > 65536) throw new Error('callback too large')
          chunks.push(x)
        }
        const r = http.request(
          'http://interactsh:80/',
          {
            method: req.method,
            headers: {
              host: domain,
              'content-type': req.headers['content-type'] || 'text/plain',
            },
            timeout: 5000,
          },
          (up) => {
            res.statusCode = up.statusCode || 502
            up.pipe(res)
          },
        )
        r.on('timeout', () => r.destroy())
        r.on('error', () => {
          res.statusCode = 502
          res.end('callback unavailable')
        })
        r.end(Buffer.concat(chunks))
        return
      }
      if (req.url === '/healthz') {
        await docker([
          'image',
          'inspect',
          process.env.NEO_WORKER_IMAGE || 'neo-sandbox:local',
        ])
        res.end(
          JSON.stringify({
            ok: true,
            exec_network: 'none',
            compose: 'strict-image-only',
            version: 1,
          }),
        )
        return
      }
      if (req.method !== 'POST') throw new Error('POST required')
      let data = ''
      for await (const x of req) {
        data += x
        if (data.length > limit) throw new Error('request too large')
      }
      const b = JSON.parse(data)
      if (!/^[0-9a-f-]{36}$/i.test(b.task_id || ''))
        throw new Error('valid task required')
      let result
      if (req.url.startsWith('/deploy/')) {
        await auth(b, req.url === '/deploy/down' ? 'cleanup' : 'deploy')
        if (activeTasks.has(b.task_id))
          throw new Error('task mutation already active')
        activeTasks.add(b.task_id)
        try {
          result = await handle(req.url, b, disconnect.signal)
        } finally {
          activeTasks.delete(b.task_id)
        }
      } else result = await handle(req.url, b, disconnect.signal)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(result))
    } catch (e) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: e.message }))
    }
  })
  .listen(8091, '0.0.0.0')
