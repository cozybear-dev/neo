import {
  resolveTaskId as boundTaskId,
  taskHeaders,
  taskToken,
} from '../../neo-runtime/contracts.mjs'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, writeFile, open } from 'node:fs/promises'
import { normalizeScopeHost } from './host.ts'

export type EnvMap = Record<string, string | undefined>

export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<{ status: number; text(): Promise<string> }>

export type FsLike = {
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  writeFile(path: string, data: string | Buffer): Promise<void>
  appendFile(path: string, data: string): Promise<void>
}

export type CapturedRequest = {
  id: string
  method: string
  url: string
  headers: Record<string, string>
  postData?: string
  status?: number
  timestamp: string
}

export type NavigateResult = { url: string; title?: string }
export type ActResult = { ok: true }
export type EvalResult = { result: unknown }
export type ScreenshotResult = { path: string }
export type NetworkResult = { requests: CapturedRequest[] }

export type BrowserSession = {
  navigate(url: string, wait?: string): Promise<NavigateResult>
  act(args: {
    action: 'click' | 'type' | 'select'
    selector?: string
    text?: string
    instruction: string
  }): Promise<ActResult>
  evaluate(expression: string): Promise<unknown>
  screenshot(): Promise<Buffer>
  network(): Promise<CapturedRequest[]>
  close?(): Promise<void>
  alive?(): boolean
}

export type PlaywrightPage = {
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>
  click(selector: string): Promise<void>
  fill(selector: string, text: string): Promise<void>
  selectOption(selector: string, value: string): Promise<void>
  evaluate(pageFunction: unknown, arg?: unknown): Promise<unknown>
  screenshot(opts?: { type?: string }): Promise<Buffer>
  url(): string
  title(): Promise<string>
  on(event: string, handler: (...args: never[]) => unknown): void
}

export type PlaywrightBrowser = {
  contexts(): Array<{
    pages(): PlaywrightPage[]
    newPage(): Promise<PlaywrightPage>
  }>
  newPage(): Promise<PlaywrightPage>
}

export type PlaywrightLike = {
  chromium: {
    connectOverCDP(endpoint: string): Promise<PlaywrightBrowser>
  }
}

export type WsLike = {
  readyState?: number
  send(data: string): void
  close(): void
  addEventListener?(type: string, fn: (ev: { data?: unknown }) => void): void
  onopen?: ((ev: unknown) => void) | null
  onmessage?: ((ev: { data?: unknown }) => void) | null
  onerror?: ((ev: unknown) => void) | null
}

export type WsCtor = new (url: string) => WsLike

export type ClientOptions = {
  cdpUrl?: string
  playwright?: PlaywrightLike
  importPlaywright?: () => Promise<PlaywrightLike>
  session?: BrowserSession
  fetch?: FetchLike
  fs?: FsLike
  ws?: WsCtor
  env?: EnvMap
  signal?: AbortSignal
  trafficPath?: string
  screenshotDir?: string
  now?: () => Date
  randomId?: () => string
  skipScopeCheck?: boolean
  agent?: AgentRef
}

export const DEFAULT_CDP_URL = 'http://browser:9222'
export const DEFAULT_SCREENSHOT_DIR = '/workspace/browser'
export const DEFAULT_TRAFFIC_PATH = '/workspace/traffic/http.jsonl'

const sessions = new Map<string, Promise<BrowserSession>>()

export function resetBrowserSession(): void {
  for (const promise of sessions.values())
    void promise.then((s) => s.close?.()).catch(() => {})
  sessions.clear()
}

export function cdpUrl(opts: ClientOptions = {}): string {
  const env = opts.env ?? process.env
  return (opts.cdpUrl ?? env.BROWSER_CDP_URL ?? DEFAULT_CDP_URL).replace(
    /\/+$/,
    '',
  )
}

export function rewriteCdpWebSocketUrl(
  wsUrl: string,
  httpEndpoint: string,
): string {
  const http = new URL(httpEndpoint)
  const ws = new URL(wsUrl)
  ws.protocol = http.protocol === 'https:' ? 'wss:' : 'ws:'
  ws.host = http.host
  return ws.toString()
}

export { redactSecrets, renderSafe } from '../../neo-runtime/redact.mjs'

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  }
}

function nodeFs(): FsLike {
  return {
    mkdir: (p, o) => mkdir(p, { ...o, mode: 0o750 }),
    writeFile: (p, d) => writeFile(p, d, { mode: 0o640 }),
    appendFile: async (p, d) => {
      const file = await open(p, 'a', 0o640)
      try {
        if ((await file.stat()).size + Buffer.byteLength(d) > 16777216)
          throw new Error('task traffic capture quota exceeded')
        await file.chmod(0o640)
        await file.writeFile(d)
        await file.sync()
      } finally {
        await file.close()
      }
    },
  }
}

function dirOf(filePath: string): string {
  const i = filePath.lastIndexOf('/')
  return i <= 0 ? '.' : filePath.slice(0, i)
}

const trafficWrites = new Map<string, Promise<void>>()
const trafficBytes = new Map<string, number>()
export async function appendTraffic(
  rec: CapturedRequest,
  opts: ClientOptions = {},
): Promise<void> {
  const fs = opts.fs ?? nodeFs()
  const path = opts.trafficPath ?? `${taskRoot(opts)}/traffic/http.jsonl`
  const data = `${JSON.stringify(rec)}\n`
  const pending = (trafficWrites.get(path) ?? Promise.resolve()).then(
    async () => {
      const next = (trafficBytes.get(path) ?? 0) + Buffer.byteLength(data)
      if (next > 16777216)
        throw new Error('task traffic capture quota exceeded')
      await fs.mkdir(dirOf(path), { recursive: true })
      await fs.appendFile(path, data)
      trafficBytes.set(path, next)
    },
  )
  trafficWrites.set(path, pending)
  await pending
}

export class ScopeDeniedError extends Error {
  constructor(target: string, reason: string) {
    super(`target not in scope (${target}): ${reason}`)
    this.name = 'ScopeDeniedError'
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const UUID_EXTRACT_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

export type AgentRef = {
  id?: string
  options?: { neoTaskId?: unknown }
  parent?: { id?: string; options?: { neoTaskId?: unknown } }
  parentSession?: { id?: string }
}

function taskIdFromSession(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  const m = sessionId.match(UUID_EXTRACT_RE)
  return m ? m[0].toLowerCase() : undefined
}

export function resolveTaskId(
  arg: string | undefined,
  env: EnvMap = process.env,
  agent?: AgentRef,
): string | undefined {
  return boundTaskId(arg, env, agent)
}

export async function assertInScope(
  target: string,
  opts: ClientOptions = {},
): Promise<void> {
  if (opts.skipScopeCheck) return
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
  const control = (env.CONTROL_URL ?? 'http://control:8090').replace(/\/+$/, '')
  const taskId = resolveTaskId(undefined, env, opts.agent)
  const host = normalizeScopeHost(target)
  const payload: Record<string, unknown> = { target: host }
  if (taskId) payload.task_id = taskId
  const res = await fetchImpl(`${control}/scope/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...taskHeaders(env, opts.agent) },
    body: JSON.stringify(payload),
    signal: opts.signal,
  })
  const text = await res.text()
  let body: { allowed?: boolean; reason?: string } = {}
  try {
    body = text
      ? (JSON.parse(text) as { allowed?: boolean; reason?: string })
      : {}
  } catch {
    body = { allowed: false, reason: text || 'invalid scope response' }
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `scope check failed (${res.status}): ${body.reason ?? 'http error'}`,
    )
  }
  if (body.allowed !== true) {
    throw new ScopeDeniedError(host || target, body.reason ?? 'default deny')
  }
}
export async function connectPlaywright(
  _opts: ClientOptions = {},
): Promise<BrowserSession> {
  throw new Error('Playwright transport is unsupported; use task-isolated CDP')
}

class CdpConn {
  sessionId?: string
  closed = false
  private id = 0
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private events = new Map<
    string,
    Array<(params: Record<string, unknown>) => void>
  >()
  private ws: WsLike

  constructor(ws: WsLike) {
    this.ws = ws
    const disconnect = () => {
      this.closed = true
      for (const p of this.pending.values())
        p.reject(new Error('CDP disconnected'))
      this.pending.clear()
    }
    if (ws.addEventListener) {
      ws.addEventListener('close', disconnect)
      ws.addEventListener('error', disconnect)
    }
    const onMessage = (ev: { data?: unknown }) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data ?? '')
      let msg: {
        id?: number
        method?: string
        params?: Record<string, unknown>
        result?: unknown
        error?: { message?: string }
      }
      try {
        msg = JSON.parse(raw) as typeof msg
      } catch {
        return
      }
      if (typeof msg.id === 'number') {
        const wait = this.pending.get(msg.id)
        if (!wait) return
        this.pending.delete(msg.id)
        if (msg.error) wait.reject(new Error(msg.error.message ?? 'cdp error'))
        else wait.resolve(msg.result)
        return
      }
      if (msg.method) {
        for (const fn of this.events.get(msg.method) ?? []) fn(msg.params ?? {})
      }
    }
    if (typeof this.ws.addEventListener === 'function') {
      this.ws.addEventListener('message', onMessage)
    } else {
      this.ws.onmessage = onMessage
    }
  }

  close(): void {
    this.ws.close()
  }
  event(method: string): { promise: Promise<void>; cancel: () => void } {
    let cancel = () => {}
    const promise = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        const list = this.events.get(method) ?? []
        this.events.set(
          method,
          list.filter((fn) => fn !== done),
        )
      }
      const done = () => {
        cleanup()
        resolve()
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('navigation deadline exceeded'))
      }, 30000)
      cancel = () => {
        cleanup()
        resolve()
      }
      this.on(method, done)
    })
    return { promise, cancel: () => cancel() }
  }

  waitOpen(): Promise<void> {
    if (this.ws.readyState === 1) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('CDP connection deadline exceeded')),
        10000,
      )
      const ok = () => {
        clearTimeout(timer)
        resolve()
      }
      const fail = () => {
        clearTimeout(timer)
        reject(new Error('cdp websocket error'))
      }
      if (typeof this.ws.addEventListener === 'function') {
        this.ws.addEventListener('open', ok)
        this.ws.addEventListener('error', fail)
      } else {
        this.ws.onopen = ok
        this.ws.onerror = fail
      }
    })
  }

  on(method: string, fn: (params: Record<string, unknown>) => void): void {
    const list = this.events.get(method) ?? []
    list.push(fn)
    this.events.set(method, list)
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('CDP disconnected'))
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('CDP command deadline exceeded'))
      }, 30000)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.ws.send(
        JSON.stringify({ id, method, params, sessionId: this.sessionId }),
      )
    })
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      const err = new Error('aborted')
      err.name = 'AbortError'
      reject(err)
    }
    if (!signal) return
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const attempts = 3
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    throwIfAborted(signal)
    try {
      const res = await fetchImpl(url, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
      })
      const text = await res.text()
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`cdp http ${res.status}: ${text}`)
      }
      return text ? JSON.parse(text) : null
    } catch (err) {
      lastErr = err
      if ((err as Error)?.name === 'AbortError') throw err
      if (i === attempts - 1) break
      await sleep(250, signal)
    }
  }
  throw lastErr
}

export function taskRoot(opts: ClientOptions = {}): string {
  const env = opts.env ?? process.env
  const id = resolveTaskId(undefined, env, opts.agent)
  if (!id) throw new Error('valid task identity required')
  return `${env.NEO_WORKSPACE_BASE ?? '/workspace'}/tasks/${id}`
}

export async function connectCdp(
  opts: ClientOptions = {},
): Promise<BrowserSession> {
  const endpoint = cdpUrl(opts)
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
  const Ws =
    opts.ws ?? (globalThis as unknown as { WebSocket: WsCtor }).WebSocket
  if (!Ws) throw new Error('WebSocket is not available for CDP')
  const version = (await fetchJson(
    fetchImpl,
    `${endpoint}/json/version`,
    opts.signal,
  )) as { webSocketDebuggerUrl?: string }
  if (!version.webSocketDebuggerUrl)
    throw new Error('browser CDP discovery missing websocket URL')
  const conn = new CdpConn(
    new Ws(rewriteCdpWebSocketUrl(version.webSocketDebuggerUrl, endpoint)),
  )
  await conn.waitOpen()
  const context = (await conn.send('Target.createBrowserContext', {
    disposeOnDetach: true,
  })) as { browserContextId: string }
  const target = (await conn.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId: context.browserContextId,
  })) as { targetId: string }
  const attached = (await conn.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })) as { sessionId: string }
  conn.sessionId = attached.sessionId
  await conn.send('Page.enable')
  await conn.send('Runtime.enable')
  await conn.send('Network.enable')
  await conn.send('Network.setBypassServiceWorker', { bypass: true })
  const requests: CapturedRequest[] = []
  const lifecycle = new AbortController()
  let writes = Promise.resolve()
  const activeRequests = new Set<Promise<void>>()
  let captureBytes = 0
  let captureError: unknown
  conn.on('Fetch.requestPaused', (params) => {
    const request = params.request as {
      url: string
      method: string
      headers: Record<string, string>
      postData?: string
    }
    const requestId = params.requestId as string
    const job = (async () => {
      try {
        const env = opts.env ?? process.env
        const id = resolveTaskId(undefined, env, opts.agent)
        const task_token = taskToken(env, opts.agent)
        if (!id) throw new Error('task credentials required')
        const res = await fetchImpl(
          `${env.NEO_BROKER_URL ?? 'http://broker:8091'}/request`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: AbortSignal.any([
              lifecycle.signal,
              AbortSignal.timeout(30000),
            ]),
            body: JSON.stringify({
              task_id: id,
              task_token,
              capability: 'browser',
              url: request.url,
              method: request.method,
              headers: request.headers,
              body_base64:
                request.postData === undefined
                  ? undefined
                  : Buffer.from(request.postData).toString('base64'),
            }),
          },
        )
        if (res.status !== 200)
          throw new Error(`broker denied browser request (${res.status})`)
        const response = JSON.parse(await res.text()) as {
          status: number
          headers: Record<string, string | string[]>
          body_base64: string
        }
        if (
          !Number.isInteger(response.status) ||
          typeof response.body_base64 !== 'string' ||
          response.body_base64.length > 2800000
        )
          throw new Error('invalid or oversized broker response')
        await conn.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: response.status,
          responseHeaders: Object.entries(response.headers).flatMap(
            ([name, value]) =>
              (Array.isArray(value) ? value : [value]).map((v) => ({
                name,
                value: v,
              })),
          ),
          body: response.body_base64,
        })
        if (requests.length >= 1000) throw new Error('capture quota exceeded')
        const rec: CapturedRequest = {
          id: (opts.randomId ?? randomUUID)(),
          timestamp: new Date().toISOString(),
          ...request,
          status: response.status,
        }
        captureBytes += Buffer.byteLength(JSON.stringify(rec))
        if (
          captureBytes > 16777216 ||
          Buffer.byteLength(JSON.stringify(rec)) > 262144
        )
          throw new Error('capture record exceeds quota')
        requests.push(rec)
        writes = writes
          .then(() => appendTraffic(rec, opts))
          .catch((err) => {
            captureError = err
          })
      } catch (err) {
        captureError = err
        await conn
          .send('Fetch.failRequest', {
            requestId,
            errorReason: 'BlockedByClient',
          })
          .catch(() => {})
      }
    })()
    activeRequests.add(job)
    void job.finally(() => activeRequests.delete(job))
  })
  await conn.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Request' }],
  })
  const evaluate = async (expression: string) => {
    const out = (await conn.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result?: { value?: unknown }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }
    if (out.exceptionDetails)
      throw new Error(
        out.exceptionDetails.exception?.description ??
          out.exceptionDetails.text ??
          'evaluation failed',
      )
    return out.result?.value
  }
  return {
    async navigate(url, wait) {
      if (wait && !['load', 'domcontentloaded', 'commit'].includes(wait))
        throw new Error('unsupported navigation wait')
      const loaded = conn.event(
        wait === 'domcontentloaded'
          ? 'Page.domContentEventFired'
          : 'Page.loadEventFired',
      )
      try {
        const result = (await conn.send('Page.navigate', { url })) as {
          errorText?: string
        }
        if (result.errorText)
          throw new Error(`navigation failed: ${result.errorText}`)
        await loaded.promise
      } finally {
        loaded.cancel()
      }
      if (captureError) throw captureError
      return {
        url: String(await evaluate('location.href')),
        title: String(await evaluate('document.title')),
      }
    },
    async act(args) {
      if (!args.selector) throw new Error('selector is required')
      const action =
        args.action === 'click'
          ? 'el.click()'
          : `el.value=${JSON.stringify(args.text)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}))`
      if (args.action !== 'click' && args.text === undefined)
        throw new Error('text is required')
      await evaluate(
        `(()=>{const el=document.querySelector(${JSON.stringify(args.selector)});if(!el)throw new Error('selector not found');${action}})()`,
      )
      return { ok: true }
    },
    evaluate,
    async screenshot() {
      const out = (await conn.send('Page.captureScreenshot', {
        format: 'png',
      })) as { data?: string }
      if (!out.data) throw new Error('empty screenshot')
      return Buffer.from(out.data, 'base64')
    },
    async network() {
      await Promise.all(activeRequests)
      await writes
      if (captureError) throw captureError
      return requests.map((r) => ({ ...r, headers: { ...r.headers } }))
    },
    alive() {
      return !conn.closed
    },
    async close() {
      lifecycle.abort()
      conn.sessionId = undefined
      try {
        await conn.send('Target.disposeBrowserContext', {
          browserContextId: context.browserContextId,
        })
      } finally {
        conn.close()
      }
      await Promise.all(activeRequests)
      await writes
    },
  }
}

export async function openBrowser(
  opts: ClientOptions = {},
): Promise<BrowserSession> {
  if (opts.session) return opts.session
  return connectCdp(opts)
}
export async function getBrowserSession(
  opts: ClientOptions = {},
): Promise<BrowserSession> {
  if (opts.session) return opts.session
  const key = `${taskRoot(opts)}:${cdpUrl(opts)}:${opts.agent?.id ?? 'main'}`
  let session = sessions.get(key)
  if (!session) {
    if (sessions.size >= 16)
      throw new Error('browser session quota exceeded; close idle sessions')
    session = openBrowser({ ...opts, signal: undefined }).catch((err) => {
      sessions.delete(key)
      throw err
    })
    sessions.set(key, session)
    const owned = session
    const timer = setTimeout(
      () => {
        if (sessions.get(key) === owned) {
          sessions.delete(key)
          void owned.then((s) => s.close?.()).catch(() => {})
        }
      },
      30 * 60 * 1000,
    )
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }
  const resolved = await session
  if (resolved.alive && !resolved.alive()) {
    sessions.delete(key)
    return getBrowserSession(opts)
  }
  return resolved
}

export async function browserNavigate(
  args: { url: string; wait?: string },
  opts: ClientOptions = {},
): Promise<NavigateResult> {
  throwIfAborted(opts.signal)
  const url = args.url.trim()
  if (!url) throw new Error('url is required')
  const canonical = new URL(url)
  if (
    !['http:', 'https:'].includes(canonical.protocol) ||
    canonical.username ||
    canonical.password
  )
    throw new Error(
      'browser navigation requires HTTP(S) URL without embedded credentials',
    )
  if (opts.session) await assertInScope(url, opts)
  const session = await getBrowserSession(opts)
  return runOperation(session, () => session.navigate(url, args.wait), opts)
}

export async function browserAct(
  args: {
    action: 'click' | 'type' | 'select'
    selector?: string
    text?: string
    instruction: string
  },
  opts: ClientOptions = {},
): Promise<ActResult> {
  throwIfAborted(opts.signal)
  if (!args.instruction?.trim()) throw new Error('instruction is required')
  if (!args.selector?.trim()) {
    throw new Error(
      'selector is required (instruction-only act needs a CSS selector)',
    )
  }
  const session = await getBrowserSession(opts)
  return runOperation(session, () => session.act(args), opts)
}

export async function browserEval(
  args: { expression: string },
  opts: ClientOptions = {},
): Promise<EvalResult> {
  throwIfAborted(opts.signal)
  const expression = args.expression.trim()
  if (!expression) throw new Error('expression is required')
  const session = await getBrowserSession(opts)
  return {
    result: await runOperation(
      session,
      () => session.evaluate(expression),
      opts,
    ),
  }
}

export async function browserScreenshot(
  opts: ClientOptions = {},
): Promise<ScreenshotResult> {
  throwIfAborted(opts.signal)
  const session = await getBrowserSession(opts)
  const bytes = await runOperation(session, () => session.screenshot(), opts)
  const dir = (opts.screenshotDir ?? `${taskRoot(opts)}/browser`).replace(
    /\/+$/,
    '',
  )
  const stamp = (opts.now ?? (() => new Date()))()
    .toISOString()
    .replace(/[:.]/g, '-')
  const path = `${dir}/screenshot-${stamp}-${(opts.randomId ?? randomUUID)()}.png`
  const fs = opts.fs ?? nodeFs()
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path, bytes)
  return { path }
}

export async function browserNetwork(
  opts: ClientOptions = {},
): Promise<NetworkResult> {
  throwIfAborted(opts.signal)
  const session = await getBrowserSession(opts)
  return {
    requests: await runOperation(session, () => session.network(), opts),
  }
}

async function runOperation<T>(
  session: BrowserSession,
  operation: () => Promise<T>,
  opts: ClientOptions,
): Promise<T> {
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(35000)])
    : AbortSignal.timeout(35000)
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      for (const [key, p] of sessions)
        void p.then((s) => {
          if (s === session) sessions.delete(key)
        })
      void session.close?.().catch(() => {})
      const err = new Error('browser operation aborted')
      err.name = 'AbortError'
      reject(err)
    }
    signal.addEventListener('abort', abort, { once: true })
    operation()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}
