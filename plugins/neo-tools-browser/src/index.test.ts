import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  browserAct,
  browserEval,
  browserNavigate,
  browserNetwork,
  browserScreenshot,
  connectCdp,
  connectPlaywright,
  rewriteCdpWebSocketUrl,
  ScopeDeniedError,
  type BrowserSession,
  type FetchLike,
  type FsLike,
  type PlaywrightLike,
  type PlaywrightPage,
  type WsLike,
} from './client.ts'

function memFs(): FsLike & { files: Map<string, string | Uint8Array> } {
  const files = new Map<string, string | Uint8Array>()
  return {
    files,
    async mkdir() {},
    async writeFile(path, data) {
      files.set(path, data)
    },
    async appendFile(path, data) {
      const prev = files.get(path)
      const prevS = prev === undefined ? '' : typeof prev === 'string' ? prev : Buffer.from(prev).toString('utf8')
      files.set(path, prevS + data)
    },
  }
}

function allowFetch(extra?: { calls?: Array<{ url: string; body: unknown }> }): FetchLike {
  const calls = extra?.calls
  return async (url, init) => {
    if (init?.signal?.aborted) {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    if (calls) {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null })
    }
    if (url.includes('/scope/check')) {
      return { status: 200, text: async () => JSON.stringify({ allowed: true, matched: 'juice-shop', reason: 'matched allowlist' }) }
    }
    return { status: 200, text: async () => '{}' }
  }
}

function denyFetch(): FetchLike {
  return async (url) => {
    if (url.includes('/scope/check')) {
      return {
        status: 200,
        text: async () => JSON.stringify({ allowed: false, matched: '', reason: 'default deny: no allowlist match' }),
      }
    }
    return { status: 200, text: async () => '{}' }
  }
}

function fakeSession(overrides: Partial<BrowserSession> = {}): BrowserSession & { calls: string[] } {
  const calls: string[] = []
  const requests = [
    {
      id: 'n1',
      method: 'GET',
      url: 'http://juice-shop.lab.internal/',
      headers: {},
      timestamp: '2026-08-20T00:00:00.000Z',
    },
  ]
  return {
    calls,
    async navigate(url, wait) {
      calls.push(`goto:${url}:${wait ?? ''}`)
      return { url, title: 'Juice Shop' }
    },
    async act(args) {
      calls.push(`${args.action}:${args.selector}:${args.text ?? ''}`)
      return { ok: true }
    },
    async evaluate(expression) {
      calls.push(`eval:${expression}`)
      return { ok: true, expression }
    },
    async screenshot() {
      calls.push('screenshot')
      return Buffer.from('png-bytes')
    },
    async network() {
      return requests
    },
    ...overrides,
  }
}

describe('browser_navigate', () => {
  it('calls scope_check then navigates', async () => {
    const session = fakeSession()
    const scopeCalls: Array<{ url: string; body: unknown }> = []
    const result = await browserNavigate(
      { url: 'http://juice-shop.lab.internal/', wait: 'networkidle' },
      {
        session,
        fetch: allowFetch({ calls: scopeCalls }),
        env: { CONTROL_URL: 'http://control:8090', NEO_TASK_ID: 'task-1' },
      },
    )
    assert.deepEqual(result, { url: 'http://juice-shop.lab.internal/', title: 'Juice Shop' })
    assert.equal(scopeCalls[0]?.url, 'http://control:8090/scope/check')
    assert.deepEqual(scopeCalls[0]?.body, { target: 'juice-shop.lab.internal', task_id: 'task-1' })
    assert.equal(session.calls[0], 'goto:http://juice-shop.lab.internal/:networkidle')
  })

  it('throws on allowlist miss and does not navigate', async () => {
    const session = fakeSession()
    await assert.rejects(
      () => browserNavigate(
        { url: 'http://evil.example/' },
        { session, fetch: denyFetch(), env: {} },
      ),
      (err: unknown) => {
        assert.ok(err instanceof ScopeDeniedError)
        assert.match(err.message, /evil\.example/)
        return true
      },
    )
    assert.equal(session.calls.length, 0)
  })

  it('honors abort signal', async () => {
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(
      () => browserNavigate({ url: 'http://juice-shop/' }, { session: fakeSession(), signal: ac.signal, skipScopeCheck: true }),
      (err: unknown) => (err as Error).name === 'AbortError',
    )
  })
})

describe('browser_act / eval / screenshot / network', () => {
  it('click/type/select dispatch to the session', async () => {
    const session = fakeSession()
    await browserAct({ action: 'click', selector: '#go', instruction: 'submit' }, { session })
    await browserAct({ action: 'type', selector: '#q', text: 'xss', instruction: 'search' }, { session })
    await browserAct({ action: 'select', selector: '#role', text: 'admin', instruction: 'pick role' }, { session })
    assert.deepEqual(session.calls, ['click:#go:', 'type:#q:xss', 'select:#role:admin'])
  })

  it('requires a selector', async () => {
    await assert.rejects(
      () => browserAct({ action: 'click', instruction: 'click the login button' }, { session: fakeSession() }),
      /selector/,
    )
  })

  it('eval returns the page result', async () => {
    const result = await browserEval({ expression: 'document.title' }, { session: fakeSession() })
    assert.deepEqual(result, { result: { ok: true, expression: 'document.title' } })
  })

  it('screenshot writes PNG under /workspace/browser/', async () => {
    const fs = memFs()
    const result = await browserScreenshot({
      session: fakeSession(),
      fs,
      now: () => new Date('2026-08-20T12:00:00.000Z'),
    })
    assert.equal(result.path, '/workspace/browser/screenshot-2026-08-20T12-00-00-000Z.png')
    const bytes = fs.files.get(result.path)
    assert.ok(bytes)
    assert.equal(Buffer.from(bytes as Uint8Array).toString(), 'png-bytes')
  })

  it('network returns captured requests', async () => {
    const result = await browserNetwork({ session: fakeSession() })
    assert.equal(result.requests.length, 1)
    assert.equal(result.requests[0]?.url, 'http://juice-shop.lab.internal/')
  })
})

describe('Playwright connectOverCDP', () => {
  it('connects to http://browser:9222', async () => {
    let connected = ''
    const captured: Array<{ method: string; url: string }> = []
    const page: PlaywrightPage = {
      async goto(url) { return { url } },
      async click() {},
      async fill() {},
      async selectOption() {},
      async evaluate(_fn, arg) { return arg },
      async screenshot() { return Buffer.from('x') },
      url: () => 'http://juice-shop.lab.internal/',
      async title() { return 'Shop' },
      on(event, handler) {
        if (event === 'request') {
          ;(handler as (req: { method(): string; url(): string; headers(): Record<string, string>; postData(): string | null }) => void)({
            method: () => 'GET',
            url: () => 'http://juice-shop.lab.internal/assets/app.js',
            headers: () => ({ accept: '*/*' }),
            postData: () => null,
          })
        }
      },
    }
    const playwright: PlaywrightLike = {
      chromium: {
        async connectOverCDP(endpoint) {
          connected = endpoint
          return {
            contexts: () => [{ pages: () => [page], async newPage() { return page } }],
            async newPage() { return page },
          }
        },
      },
    }
    const fs = memFs()
    const session = await connectPlaywright({
      playwright,
      fs,
      trafficPath: '/workspace/traffic/http.jsonl',
      randomId: () => 'cap-1',
      now: () => new Date('2026-08-20T00:00:00.000Z'),
    })
    assert.equal(connected, 'http://browser:9222')
    const net = await session.network()
    assert.equal(net[0]?.id, 'cap-1')
    assert.equal(net[0]?.url, 'http://juice-shop.lab.internal/assets/app.js')
    const jsonl = fs.files.get('/workspace/traffic/http.jsonl')
    assert.match(String(jsonl), /cap-1/)
    captured.push({ method: net[0]!.method, url: net[0]!.url })
    assert.equal(captured[0]?.method, 'GET')
  })
})

describe('CDP fallback', () => {
  it('rewrites 127.0.0.1 debugger URLs onto the compose host', () => {
    assert.equal(
      rewriteCdpWebSocketUrl('ws://127.0.0.1:9222/devtools/page/abc', 'http://browser:9222'),
      'ws://browser:9222/devtools/page/abc',
    )
  })

  it('opens the page websocket and sends Page.navigate', async () => {
    const sent: string[] = []
    class FakeWs implements WsLike {
      url: string
      readyState = 0
      onopen: ((ev: unknown) => void) | null = null
      onmessage: ((ev: { data?: unknown }) => void) | null = null
      onerror: ((ev: unknown) => void) | null = null
      constructor(url: string) {
        this.url = url
        queueMicrotask(() => {
          this.readyState = 1
          this.onopen?.(null)
        })
      }
      addEventListener(type: string, fn: (ev: { data?: unknown }) => void) {
        if (type === 'open') queueMicrotask(() => fn({}))
        if (type === 'message') this.onmessage = fn
      }
      send(data: string) {
        sent.push(data)
        const msg = JSON.parse(data) as { id: number; method: string }
        const result = msg.method === 'Page.captureScreenshot'
          ? { data: Buffer.from('png').toString('base64') }
          : msg.method === 'Runtime.evaluate'
            ? { result: { value: 'Juice Shop' } }
            : {}
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) }))
      }
      close() {}
    }
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith('/json/list')) {
        return {
          status: 200,
          text: async () => JSON.stringify([
            { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/p1' },
          ]),
        }
      }
      return { status: 200, text: async () => '{}' }
    }
    const session = await connectCdp({
      fetch: fetchImpl,
      ws: FakeWs,
      env: { BROWSER_CDP_URL: 'http://browser:9222' },
      skipScopeCheck: true,
    })
    const nav = await session.navigate('http://juice-shop.lab.internal/')
    assert.equal(nav.title, 'Juice Shop')
    assert.ok(sent.some((s) => s.includes('Page.navigate')))
    assert.ok(sent.some((s) => s.includes('http://juice-shop.lab.internal/')))
    const shot = await session.screenshot()
    assert.equal(Buffer.from(shot).toString(), 'png')
  })
})
