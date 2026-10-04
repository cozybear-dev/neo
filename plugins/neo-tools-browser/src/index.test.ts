import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  connectCdp,
  browserEval,
  resolveTaskId,
  taskRoot,
  renderSafe,
  rewriteCdpWebSocketUrl,
} from './client.ts'
const id = '11111111-1111-4111-8111-111111111111'
const env = {
  NEO_TASK_ID: id,
  NEO_TASK_TOKEN: 'fixture-token',
  NEO_WORKSPACE_BASE: '/tmp/neo',
}
class Socket {
  static sockets: Socket[] = []
  readyState = 1
  handlers = new Map<string, Function[]>()
  messages: any[] = []
  constructor(url: string) {
    Socket.sockets.push(this)
  }
  addEventListener(name: string, fn: Function) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn])
  }
  emit(method: string, params: any = {}) {
    for (const fn of this.handlers.get('message') ?? [])
      fn({ data: JSON.stringify({ method, params }) })
  }
  close() {
    for (const fn of this.handlers.get('close') ?? []) fn({})
  }
  send(raw: string) {
    const msg = JSON.parse(raw)
    this.messages.push(msg)
    let result: any = {}
    if (msg.method === 'Target.createBrowserContext')
      result = { browserContextId: 'context-' + Socket.sockets.length }
    if (msg.method === 'Target.createTarget') result = { targetId: 'target' }
    if (msg.method === 'Target.attachToTarget')
      result = { sessionId: 'attached' }
    if (msg.method === 'Runtime.evaluate')
      result = msg.params.expression.includes('missing')
        ? { exceptionDetails: { text: 'selector not found' } }
        : { result: { value: 'ok' } }
    queueMicrotask(() => {
      for (const fn of this.handlers.get('message') ?? [])
        fn({ data: JSON.stringify({ id: msg.id, result }) })
      if (msg.method === 'Page.navigate') this.emit('Page.loadEventFired')
    })
  }
}
function setup(status = 200, diskFail = false) {
  let saved = ''
  const calls: any[] = []
  return {
    calls,
    get saved() {
      return saved
    },
    opts: {
      env,
      ws: Socket as any,
      fs: {
        mkdir: async () => {},
        writeFile: async () => {},
        appendFile: async (_p: string, data: string) => {
          if (diskFail) throw new Error('disk full')
          saved += data
        },
      },
      fetch: async (url: string, init?: any) => {
        calls.push({ url, init })
        return {
          status: url.includes('/request') ? status : 200,
          text: async () =>
            JSON.stringify(
              url.includes('/request')
                ? { status: 201, headers: {}, body_base64: '' }
                : {
                    webSocketDebuggerUrl:
                      'ws://127.0.0.1:9223/devtools/browser/x',
                  },
            ),
        }
      },
    },
  }
}
test('task identity fails closed and task directories are isolated', () => {
  assert.throws(() => taskRoot({ env: {} }))
  assert.throws(() => resolveTaskId('bad', env))
  assert.throws(() =>
    resolveTaskId('22222222-2222-4222-8222-222222222222', env),
  )
  assert.equal(taskRoot({ env }), `/tmp/neo/tasks/${id}`)
})
test('CDP creates own context and attaches flattened target before page commands', async () => {
  const a = setup()
  const session = await connectCdp(a.opts)
  const socket = Socket.sockets.at(-1)!
  assert.equal(socket.messages[0].method, 'Target.createBrowserContext')
  assert.equal(
    socket.messages[1].params.browserContextId.startsWith('context-'),
    true,
  )
  assert.equal(
    socket.messages.find((m) => m.method === 'Page.enable').sessionId,
    'attached',
  )
  assert.equal((await session.navigate('http://lab/')).url, 'ok')
  await assert.rejects(
    () =>
      session.act({
        action: 'click',
        selector: 'missing',
        instruction: 'click',
      }),
    /selector not found/,
  )
  await session.close!()
})
test('all paused requests go through task-auth broker and finalized capture is durable', async () => {
  const a = setup()
  const session = await connectCdp(a.opts)
  const socket = Socket.sockets.at(-1)!
  socket.emit('Fetch.requestPaused', {
    requestId: 'r',
    request: { url: 'http://lab/redirect', method: 'GET', headers: {} },
  })
  await new Promise((r) => setTimeout(r, 10))
  const records = await session.network()
  assert.equal(records[0].status, 201)
  assert.equal(JSON.parse(a.saved).status, 201)
  const payload = JSON.parse(
    a.calls.find((c) => c.url.includes('/request')).init.body,
  )
  assert.equal(payload.task_token, 'fixture-token')
  assert.equal(
    socket.messages.some((m) => m.method === 'Fetch.continueRequest'),
    false,
  )
  await session.close!()
})
test('out-of-scope redirect/subresource/eval request blocked without direct network fallback', async () => {
  for (const url of [
    'http://canary/redirect',
    'http://canary/image',
    'http://control:8090/',
  ]) {
    const a = setup(403)
    const session = await connectCdp(a.opts)
    const socket = Socket.sockets.at(-1)!
    socket.emit('Fetch.requestPaused', {
      requestId: 'blocked',
      request: { url, method: 'GET', headers: {} },
    })
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(
      socket.messages.some((m) => m.method === 'Fetch.failRequest'),
      true,
    )
    assert.equal(
      socket.messages.some((m) => m.method === 'Fetch.continueRequest'),
      false,
    )
    await assert.rejects(() => session.network(), /denied/)
    await session.close!()
  }
})
test('write failure is visible and disconnected sessions fail pending commands', async () => {
  const a = setup(200, true)
  const session = await connectCdp(a.opts)
  const socket = Socket.sockets.at(-1)!
  socket.emit('Fetch.requestPaused', {
    requestId: 'r',
    request: { url: 'http://lab/', method: 'GET', headers: {} },
  })
  await new Promise((r) => setTimeout(r, 5))
  await assert.rejects(() => session.network(), /disk full/)
  socket.close()
  await assert.rejects(() => session.evaluate('1'), /disconnected/)
})
test('cancellation closes context and rejects operation', async () => {
  const controller = new AbortController()
  let closed = false
  const session = {
    navigate: async () => ({ url: '' }),
    act: async () => ({ ok: true as const }),
    evaluate: () => new Promise(() => {}),
    screenshot: async () => Buffer.from(''),
    network: async () => [],
    close: async () => {
      closed = true
    },
  }
  const pending = browserEval(
    { expression: '1' },
    { session, signal: controller.signal },
  )
  await new Promise((r) => setTimeout(r, 0))
  controller.abort()
  await assert.rejects(() => pending, /aborted/)
  assert.equal(closed, true)
})
test('model rendering redacts URLs, bodies and headers', () => {
  const text = renderSafe(
    {},
    {
      url: 'http://lab/?token=fixture-secret',
      postData: 'password=body-secret',
      headers: { Authorization: 'header-secret' },
    },
  )[0].text
  for (const secret of ['fixture-secret', 'body-secret', 'header-secret'])
    assert.equal(text.includes(secret), false)
  assert.equal(
    rewriteCdpWebSocketUrl('ws://127.0.0.1:9223/x', 'http://browser:9222'),
    'ws://browser:9222/x',
  )
})
