import { requireTaskId, taskToken } from '../../neo-runtime/contracts.mjs'
import { appendFile, mkdir, readFile, writeFile, open } from 'node:fs/promises'

export type EnvMap = Record<string, string | undefined>

export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<{
  status: number
  headers?:
    | { forEach(fn: (value: string, key: string) => void): void }
    | Record<string, string>
  text(): Promise<string>
}>

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
  agent?: unknown
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

export { redactSecrets, renderSafe } from '../../neo-runtime/redact.mjs'

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  }
}

export function trafficPath(opts: ClientOptions = {}): string {
  const env = opts.env ?? process.env
  return (
    opts.trafficPath ??
    `${env.NEO_WORKSPACE_BASE ?? '/workspace'}/tasks/${requireTaskId(undefined, env, opts.agent)}/traffic/http.jsonl`
  )
}

function nodeFs(): FsLike {
  return {
    mkdir: (p, o) => mkdir(p, { ...o, mode: 0o750 }),
    writeFile: (p, d) => writeFile(p, d, { mode: 0o640 }),
    readFile: async (path) => {
      const file = await open(path, 'r')
      try {
        if ((await file.stat()).size > 16777216)
          throw new Error('traffic store exceeds read quota')
        const buffer = Buffer.alloc(16777217)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead > 16777216)
          throw new Error('traffic store exceeds read quota')
        return Buffer.from(buffer.subarray(0, bytesRead)).toString('utf8')
      } finally {
        await file.close()
      }
    },
    appendFile: (p, d) => appendFile(p, d, { mode: 0o640 }),
  }
}

function dirOf(filePath: string): string {
  const i = filePath.lastIndexOf('/')
  return i <= 0 ? '.' : filePath.slice(0, i)
}

export async function appendTraffic(
  rec: CapturedRequest,
  opts: ClientOptions = {},
): Promise<void> {
  const fs = opts.fs ?? nodeFs()
  const path = trafficPath(opts)
  await fs.mkdir(dirOf(path), { recursive: true })
  await fs.appendFile(path, `${JSON.stringify(rec)}\n`)
}

export async function readTraffic(
  opts: ClientOptions = {},
): Promise<CapturedRequest[]> {
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
  if (Buffer.byteLength(text) > 16777216)
    throw new Error('traffic store exceeds read quota')
  const out: CapturedRequest[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as CapturedRequest)
    } catch {
      throw new Error('corrupt traffic record')
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

export function assertSameDestination(
  originalUrl: string,
  nextUrl: string,
): void {
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
  if (
    'forEach' in headers &&
    typeof (headers as { forEach: unknown }).forEach === 'function'
  ) {
    ;(
      headers as { forEach(fn: (value: string, key: string) => void): void }
    ).forEach((value, key) => {
      out[key] = value
    })
    return out
  }
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function stripHopByHop(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  const nominated = new Set(
    (headers.connection ?? '')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim()),
  )
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase()) || nominated.has(k.toLowerCase()))
      continue
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
    url = new URL(edits.url, rec.url).href
  }

  let method = rec.method
  if (typeof edits.method === 'string' && edits.method.trim())
    method = edits.method.trim()

  let headers = Object.fromEntries(
    Object.entries(rec.headers).map(([k, v]) => [k.toLowerCase(), v]),
  )
  if (
    edits.headers &&
    typeof edits.headers === 'object' &&
    !Array.isArray(edits.headers)
  ) {
    for (const [k, v] of Object.entries(
      edits.headers as Record<string, unknown>,
    )) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v
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
  const env = opts.env ?? process.env
  const task_id = requireTaskId(undefined, env, opts.agent)
  const task_token = taskToken(env, opts.agent)
  const canonical = new URL(url)
  if (
    !['http:', 'https:'].includes(canonical.protocol) ||
    canonical.username ||
    canonical.password
  )
    throw new Error('unsupported replay URL')
  if (body && Buffer.byteLength(body) > 262144)
    throw new Error('request body exceeds quota')
  const res = await fetchImpl(
    `${env.NEO_BROKER_URL ?? 'http://broker:8091'}/request`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task_id,
        task_token,
        capability: 'traffic',
        url: canonical.href,
        method,
        headers: stripHopByHop(headers),
        body_base64:
          method.toUpperCase() === 'GET' ||
          method.toUpperCase() === 'HEAD' ||
          body === undefined
            ? undefined
            : Buffer.from(body).toString('base64'),
      }),
      signal: opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    },
  )
  if (res.status !== 200)
    throw new Error(`broker replay denied (${res.status})`)
  const response = JSON.parse(await res.text()) as {
    status: number
    headers: Record<string, string>
    body_base64: string
  }
  if (
    !Number.isInteger(response.status) ||
    typeof response.body_base64 !== 'string' ||
    response.body_base64.length > 2800000
  )
    throw new Error('invalid or oversized broker response')
  return {
    status: response.status,
    headers: response.headers,
    body: Buffer.from(response.body_base64, 'base64').toString('utf8'),
  }
}
