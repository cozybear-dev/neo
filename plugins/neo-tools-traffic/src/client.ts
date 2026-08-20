import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'

export type EnvMap = Record<string, string | undefined>

export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<{ status: number; headers?: { forEach(fn: (value: string, key: string) => void): void } | Record<string, string>; text(): Promise<string> }>

export type FsLike = {
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  readFile(path: string, enc?: string): Promise<string>
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

export type ReplayResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

export type ClientOptions = {
  trafficPath?: string
  fetch?: FetchLike
  fs?: FsLike
  env?: EnvMap
  signal?: AbortSignal
}

export const DEFAULT_TRAFFIC_PATH = '/workspace/traffic/http.jsonl'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

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

export function trafficPath(opts: ClientOptions = {}): string {
  const env = opts.env ?? process.env
  return opts.trafficPath ?? env.TRAFFIC_LOG ?? DEFAULT_TRAFFIC_PATH
}

function nodeFs(): FsLike {
  return {
    mkdir,
    writeFile,
    readFile: (path, enc) => readFile(path, (enc ?? 'utf8') as 'utf8'),
    appendFile,
  }
}

function dirOf(filePath: string): string {
  const i = filePath.lastIndexOf('/')
  return i <= 0 ? '.' : filePath.slice(0, i)
}

export async function appendTraffic(rec: CapturedRequest, opts: ClientOptions = {}): Promise<void> {
  const fs = opts.fs ?? nodeFs()
  const path = trafficPath(opts)
  await fs.mkdir(dirOf(path), { recursive: true })
  await fs.appendFile(path, `${JSON.stringify(rec)}\n`)
}

export async function readTraffic(opts: ClientOptions = {}): Promise<CapturedRequest[]> {
  const fs = opts.fs ?? nodeFs()
  const path = trafficPath(opts)
  let text = ''
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') return []
    throw err
  }
  const out: CapturedRequest[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as CapturedRequest)
    } catch {
      // skip malformed lines
    }
  }
  return out
}

export async function searchTraffic(
  args: { query: string },
  opts: ClientOptions = {},
): Promise<CapturedRequest[]> {
  throwIfAborted(opts.signal)
  const query = args.query.toLowerCase()
  const rows = await readTraffic(opts)
  if (!query) return rows
  return rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query))
}

export function assertSameDestination(originalUrl: string, nextUrl: string): void {
  let original: URL
  let next: URL
  try {
    original = new URL(originalUrl)
    next = new URL(nextUrl, originalUrl)
  } catch {
    throw new Error('invalid url')
  }
  if (original.protocol !== next.protocol || original.host !== next.host) {
    throw new Error('destination host must stay the original')
  }
}

function headerMap(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers || typeof headers !== 'object') return out
  if ('forEach' in headers && typeof (headers as { forEach: unknown }).forEach === 'function') {
    ;(headers as { forEach(fn: (value: string, key: string) => void): void }).forEach((value, key) => {
      out[key] = value
    })
    return out
  }
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function stripHopByHop(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue
    out[k] = v
  }
  return out
}

export async function replayTraffic(
  args: { id: string; edits?: Record<string, unknown> },
  opts: ClientOptions = {},
): Promise<ReplayResponse> {
  throwIfAborted(opts.signal)
  const id = args.id.trim()
  if (!id) throw new Error('id is required')
  const rows = await readTraffic(opts)
  const rec = rows.find((r) => r.id === id)
  if (!rec) throw new Error(`request not found: ${id}`)

  const edits = args.edits ?? {}
  if (edits.host !== undefined) {
    throw new Error('destination host must stay the original')
  }

  let url = rec.url
  if (typeof edits.url === 'string') {
    assertSameDestination(rec.url, edits.url)
    url = edits.url
  }

  let method = rec.method
  if (typeof edits.method === 'string' && edits.method.trim()) method = edits.method.trim()

  let headers = { ...rec.headers }
  if (edits.headers && typeof edits.headers === 'object' && !Array.isArray(edits.headers)) {
    for (const [k, v] of Object.entries(edits.headers as Record<string, unknown>)) {
      if (typeof v === 'string') headers[k] = v
    }
  }

  let body: string | undefined = rec.postData
  if (Object.prototype.hasOwnProperty.call(edits, 'body')) {
    const b = edits.body
    if (b === null || b === undefined) body = undefined
    else if (typeof b === 'string') body = b
    else body = JSON.stringify(b)
  }

  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
  const res = await fetchImpl(url, {
    method,
    headers: stripHopByHop(headers),
    body: method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD' ? undefined : body,
    signal: opts.signal,
  })
  const text = await res.text()
  return {
    status: res.status,
    headers: headerMap(res.headers),
    body: text,
  }
}
