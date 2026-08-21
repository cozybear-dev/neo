import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
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
  act(args: { action: 'click' | 'type' | 'select'; selector?: string; text?: string; instruction: string }): Promise<ActResult>
  evaluate(expression: string): Promise<unknown>
  screenshot(): Promise<Buffer>
  network(): Promise<CapturedRequest[]>
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
  contexts(): Array<{ pages(): PlaywrightPage[]; newPage(): Promise<PlaywrightPage> }>
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

let cachedSession: Promise<BrowserSession> | undefined

export function resetBrowserSession(): void {
  cachedSession = undefined
}

export function cdpUrl(opts: ClientOptions = {}): string {
  const env = opts.env ?? process.env
  return (opts.cdpUrl ?? env.BROWSER_CDP_URL ?? DEFAULT_CDP_URL).replace(/\/+$/, '')
}

export function rewriteCdpWebSocketUrl(wsUrl: string, httpEndpoint: string): string {
  const http = new URL(httpEndpoint)
  const ws = new URL(wsUrl)
  ws.protocol = http.protocol === 'https:' ? 'wss:' : 'ws:'
  ws.host = http.host
  return ws.toString()
}

export function redactSecrets(value: unknown): unknown {
  const secretKey = /token|secret|authorization|api[_-]?key|private|password|passwd|cookie/i
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk)
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        out[k] = secretKey.test(k) ? '[redacted]' : walk(v)
      }
      return out
    }
    return input
  }
  return walk(value)
}

export function renderSafe(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(redactSecrets(value)) }]
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  }
}

function nodeFs(): FsLike {
  return { mkdir, writeFile, appendFile }
}

function dirOf(filePath: string): string {
  const i = filePath.lastIndexOf('/')
  return i <= 0 ? '.' : filePath.slice(0, i)
}

export async function appendTraffic(rec: CapturedRequest, opts: ClientOptions = {}): Promise<void> {
  const fs = opts.fs ?? nodeFs()
  const path = opts.trafficPath ?? opts.env?.TRAFFIC_LOG ?? DEFAULT_TRAFFIC_PATH
  await fs.mkdir(dirOf(path), { recursive: true })
  await fs.appendFile(path, `${JSON.stringify(rec)}\n`)
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
  const parent = agent?.parent
  const parentOption = typeof parent?.options?.neoTaskId === 'string'
    ? parent.options.neoTaskId
    : undefined
  const option = typeof agent?.options?.neoTaskId === 'string' ? agent.options.neoTaskId : undefined
  const candidates = [
    arg,
    env.NEO_TASK_ID,
    option,
    parentOption,
    taskIdFromSession(parent?.id),
    taskIdFromSession(agent?.parentSession?.id),
    taskIdFromSession(agent?.id),
  ]
  return candidates.map((v) => v?.trim()).find((v) => v && UUID_RE.test(v))
}

export async function assertInScope(target: string, opts: ClientOptions = {}): Promise<void> {
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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: opts.signal,
  })
  const text = await res.text()
  let body: { allowed?: boolean; reason?: string } = {}
  try {
    body = text ? JSON.parse(text) as { allowed?: boolean; reason?: string } : {}
  } catch {
    body = { allowed: false, reason: text || 'invalid scope response' }
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`scope check failed (${res.status}): ${body.reason ?? 'http error'}`)
  }
  if (body.allowed !== true) {
    throw new ScopeDeniedError(host || target, body.reason ?? 'default deny')
  }
}
function recordCapture(opts: ClientOptions, store: CapturedRequest[], partial: Omit<CapturedRequest, 'id' | 'timestamp'>): CapturedRequest {
  const rec: CapturedRequest = {
    id: (opts.randomId ?? randomUUID)(),
    timestamp: (opts.now ?? (() => new Date()))().toISOString(),
    ...partial,
  }
  store.push(rec)
  void appendTraffic(rec, opts)
  return rec
}

export function wrapPlaywrightPage(page: PlaywrightPage, opts: ClientOptions = {}): BrowserSession {
  const requests: CapturedRequest[] = []
  page.on('request', ((req: { method(): string; url(): string; headers(): Record<string, string>; postData(): string | null }) => {
    recordCapture(opts, requests, {
      method: req.method(),
      url: req.url(),
      headers: req.headers(),
      postData: req.postData() ?? undefined,
    })
  }) as (...args: never[]) => unknown)
  page.on('response', ((res: { url(): string; status(): number }) => {
    const hit = [...requests].reverse().find((r) => r.url === res.url() && r.status === undefined)
    if (hit) hit.status = res.status()
  }) as (...args: never[]) => unknown)

  return {
    async navigate(url, wait) {
      await page.goto(url, { waitUntil: wait || 'load' })
      return { url: page.url(), title: await page.title() }
    },
    async act(args) {
      const selector = args.selector?.trim()
      if (!selector) {
        throw new Error('selector is required (instruction-only act needs a CSS selector)')
      }
      if (args.action === 'click') await page.click(selector)
      else if (args.action === 'type') {
        if (args.text === undefined) throw new Error('text is required for type')
        await page.fill(selector, args.text)
      } else if (args.action === 'select') {
        if (args.text === undefined) throw new Error('text is required for select')
        await page.selectOption(selector, args.text)
      } else {
        throw new Error(`unknown action: ${String(args.action)}`)
      }
      return { ok: true as const }
    },
    async evaluate(expression) {
      return page.evaluate((e: string) => eval(e), expression)
    },
    async screenshot() {
      return page.screenshot({ type: 'png' })
    },
    async network() {
      return requests
    },
  }
}

export async function connectPlaywright(opts: ClientOptions = {}): Promise<BrowserSession> {
  const endpoint = cdpUrl(opts)
  let pw = opts.playwright
  if (!pw && opts.importPlaywright) {
    pw = await opts.importPlaywright()
  }
  if (!pw) {
    try {
      pw = await import('playwright') as unknown as PlaywrightLike
    } catch {
      try {
        pw = await import('playwright-core') as unknown as PlaywrightLike
      } catch {
        pw = undefined
      }
    }
  }
  if (!pw) throw new Error('playwright not available')
  const browser = await pw.chromium.connectOverCDP(endpoint)
  const contexts = browser.contexts()
  const page = contexts[0]?.pages()[0] ?? await (contexts[0]?.newPage() ?? browser.newPage())
  return wrapPlaywrightPage(page, opts)
}

class CdpConn {
  private id = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private events = new Map<string, Array<(params: Record<string, unknown>) => void>>()
  private ws: WsLike

  constructor(ws: WsLike) {
    this.ws = ws
    const onMessage = (ev: { data?: unknown }) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data ?? '')
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
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

  waitOpen(): Promise<void> {
    if (this.ws.readyState === 1) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const ok = () => resolve()
      const fail = () => reject(new Error('cdp websocket error'))
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
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
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

async function fetchJson(fetchImpl: FetchLike, url: string, signal?: AbortSignal): Promise<unknown> {
  const attempts = 3
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    throwIfAborted(signal)
    try {
      const res = await fetchImpl(url, { signal })
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

export async function connectCdp(opts: ClientOptions = {}): Promise<BrowserSession> {
  const endpoint = cdpUrl(opts)
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
  const Ws = opts.ws ?? (globalThis as unknown as { WebSocket: WsCtor }).WebSocket
  if (!Ws) throw new Error('WebSocket is not available for CDP')

  let list = await fetchJson(fetchImpl, `${endpoint}/json/list`, opts.signal) as Array<{
    type?: string
    webSocketDebuggerUrl?: string
  }>
  let pageMeta = Array.isArray(list) ? list.find((p) => p.type === 'page' && p.webSocketDebuggerUrl) : undefined
  if (!pageMeta?.webSocketDebuggerUrl) {
    await fetchImpl(`${endpoint}/json/new?about:blank`, { signal: opts.signal })
    list = await fetchJson(fetchImpl, `${endpoint}/json/list`, opts.signal) as typeof list
    pageMeta = Array.isArray(list) ? list.find((p) => p.type === 'page' && p.webSocketDebuggerUrl) : undefined
  }
  if (!pageMeta?.webSocketDebuggerUrl) {
    const version = await fetchJson(fetchImpl, `${endpoint}/json/version`, opts.signal) as { webSocketDebuggerUrl?: string }
    if (!version?.webSocketDebuggerUrl) throw new Error('no CDP websocket url at ' + endpoint)
    pageMeta = { type: 'page', webSocketDebuggerUrl: version.webSocketDebuggerUrl }
  }

  const wsUrl = rewriteCdpWebSocketUrl(pageMeta.webSocketDebuggerUrl!, endpoint)
  const conn = new CdpConn(new Ws(wsUrl))
  await conn.waitOpen()
  await conn.send('Page.enable')
  await conn.send('Runtime.enable')
  await conn.send('Network.enable')

  const requests: CapturedRequest[] = []
  const byNetworkId = new Map<string, CapturedRequest>()
  conn.on('Network.requestWillBeSent', (params) => {
    const req = params.request as { url?: string; method?: string; headers?: Record<string, string>; postData?: string } | undefined
    if (!req?.url) return
    const rec = recordCapture(opts, requests, {
      method: req.method ?? 'GET',
      url: req.url,
      headers: req.headers ?? {},
      postData: req.postData,
    })
    if (typeof params.requestId === 'string') byNetworkId.set(params.requestId, rec)
  })
  conn.on('Network.responseReceived', (params) => {
    const rec = typeof params.requestId === 'string' ? byNetworkId.get(params.requestId) : undefined
    const response = params.response as { status?: number } | undefined
    if (rec && typeof response?.status === 'number') rec.status = response.status
  })

  return {
    async navigate(url, _wait) {
      await conn.send('Page.navigate', { url })
      const title = await conn.send('Runtime.evaluate', {
        expression: 'document.title',
        returnByValue: true,
      }) as { result?: { value?: unknown } }
      return { url, title: typeof title?.result?.value === 'string' ? title.result.value : undefined }
    },
    async act(args) {
      const selector = args.selector?.trim()
      if (!selector) throw new Error('selector is required (instruction-only act needs a CSS selector)')
      const selJson = JSON.stringify(selector)
      if (args.action === 'click') {
        await conn.send('Runtime.evaluate', {
          expression: `document.querySelector(${selJson})?.click()`,
          userGesture: true,
        })
      } else if (args.action === 'type') {
        if (args.text === undefined) throw new Error('text is required for type')
        const textJson = JSON.stringify(args.text)
        await conn.send('Runtime.evaluate', {
          expression: `(() => { const el = document.querySelector(${selJson}); if (!el) throw new Error('not found'); el.focus(); el.value = ${textJson}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`,
        })
      } else if (args.action === 'select') {
        if (args.text === undefined) throw new Error('text is required for select')
        const textJson = JSON.stringify(args.text)
        await conn.send('Runtime.evaluate', {
          expression: `(() => { const el = document.querySelector(${selJson}); if (!el) throw new Error('not found'); el.value = ${textJson}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`,
        })
      } else {
        throw new Error(`unknown action: ${String(args.action)}`)
      }
      return { ok: true as const }
    },
    async evaluate(expression) {
      const out = await conn.send('Runtime.evaluate', { expression, returnByValue: true }) as {
        result?: { value?: unknown }
        exceptionDetails?: { text?: string }
      }
      if (out?.exceptionDetails) throw new Error(out.exceptionDetails.text ?? 'eval failed')
      return out?.result?.value
    },
    async screenshot() {
      const out = await conn.send('Page.captureScreenshot', { format: 'png' }) as { data?: string }
      if (!out?.data) throw new Error('screenshot empty')
      return Buffer.from(out.data, 'base64')
    },
    async network() {
      return requests
    },
  }
}

export async function openBrowser(opts: ClientOptions = {}): Promise<BrowserSession> {
  if (opts.session) return opts.session
  if (opts.playwright || opts.importPlaywright) return connectPlaywright(opts)
  try {
    return await connectPlaywright(opts)
  } catch {
    return connectCdp(opts)
  }
}

export async function getBrowserSession(opts: ClientOptions = {}): Promise<BrowserSession> {
  if (opts.session) return opts.session
  if (!cachedSession) {
    cachedSession = openBrowser(opts).catch((err) => {
      cachedSession = undefined
      throw err
    })
  }
  return cachedSession
}

export async function browserNavigate(
  args: { url: string; wait?: string },
  opts: ClientOptions = {},
): Promise<NavigateResult> {
  throwIfAborted(opts.signal)
  const url = args.url.trim()
  if (!url) throw new Error('url is required')
  await assertInScope(url, opts)
  const session = await getBrowserSession(opts)
  return session.navigate(url, args.wait)
}

export async function browserAct(
  args: { action: 'click' | 'type' | 'select'; selector?: string; text?: string; instruction: string },
  opts: ClientOptions = {},
): Promise<ActResult> {
  throwIfAborted(opts.signal)
  if (!args.instruction?.trim()) throw new Error('instruction is required')
  if (!args.selector?.trim()) {
    throw new Error('selector is required (instruction-only act needs a CSS selector)')
  }
  const session = await getBrowserSession(opts)
  return session.act(args)
}

export async function browserEval(
  args: { expression: string },
  opts: ClientOptions = {},
): Promise<EvalResult> {
  throwIfAborted(opts.signal)
  const expression = args.expression.trim()
  if (!expression) throw new Error('expression is required')
  const session = await getBrowserSession(opts)
  return { result: await session.evaluate(expression) }
}

export async function browserScreenshot(opts: ClientOptions = {}): Promise<ScreenshotResult> {
  throwIfAborted(opts.signal)
  const session = await getBrowserSession(opts)
  const bytes = await session.screenshot()
  const dir = (opts.screenshotDir ?? opts.env?.BROWSER_SCREENSHOT_DIR ?? DEFAULT_SCREENSHOT_DIR).replace(/\/+$/, '')
  const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-')
  const path = `${dir}/screenshot-${stamp}.png`
  const fs = opts.fs ?? nodeFs()
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path, bytes)
  return { path }
}

export async function browserNetwork(opts: ClientOptions = {}): Promise<NetworkResult> {
  throwIfAborted(opts.signal)
  const session = await getBrowserSession(opts)
  return { requests: await session.network() }
}
