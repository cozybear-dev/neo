import { requireTaskId } from '../../neo-runtime/contracts.mjs'
import {
  constants,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  generateKeyPair,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from 'node:crypto'

export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<{ status: number; text(): Promise<string> }>

export type EnvMap = Record<string, string | undefined>

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>

export type ClientOptions = {
  interactshUrl?: string
  token?: string
  fetch?: FetchLike
  env?: EnvMap
  signal?: AbortSignal
  store?: OastStore
  sleep?: SleepFn
  now?: () => number
}

export type OastKind = 'http' | 'dns'

export type OastSession = {
  id: string
  secretKey: string
  privateKeyPem: string
  publicKeyPem: string
  serverHost: string
  kind: OastKind
  taskId: string
  createdAt: number
  callbackScheme: string
  callbackPort: string
}

export type OastStore = Map<string, OastSession>

export type OastRegistration = {
  id: string
  url: string
  domain: string
}

export type Interaction = {
  protocol: string
  uniqueId: string
  fullId: string
  qType?: string
  rawRequest?: string
  rawResponse?: string
  smtpFrom?: string
  remoteAddress: string
  timestamp: string
}

const defaultStore: OastStore = new Map()
const ALPHABET = '0123456789abcdefghijklmnopqrstuv'
const NONCE_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769'
export function randomNonce(length = 13): string {
  const bytes = randomBytes(length)
  return Array.from({ length }, (_, i) => NONCE_ALPHABET[bytes[i]! % 32]).join(
    '',
  )
}
const TTL = 60 * 60 * 1000

export function interactshUrl(env: EnvMap = process.env): string {
  return (env.INTERACTSH_URL ?? 'http://interactsh:80').replace(/\/+$/, '')
}

export function interactshToken(env: EnvMap = process.env): string | undefined {
  const value = env.INTERACTSH_TOKEN
  return value && value.trim() ? value.trim() : undefined
}

export function randomId(length: number): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length]
  return out
}

export function encodePublicKeyPem(spkiDer: Buffer): string {
  const b64 = spkiDer.toString('base64')
  const lines = b64.match(/.{1,64}/g) ?? [b64]
  return `-----BEGIN RSA PUBLIC KEY-----\n${lines.join('\n')}\n-----END RSA PUBLIC KEY-----\n`
}

export function generateClientKeys(): {
  publicKeyB64: string
  privateKeyPem: string
  publicKeyPem: string
} {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  const spkiB64 = pair.publicKey.toString('base64')
  const lines = spkiB64.match(/.{1,64}/g) ?? [spkiB64]
  const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`
  return {
    publicKeyB64: Buffer.from(encodePublicKeyPem(pair.publicKey)).toString(
      'base64',
    ),
    privateKeyPem: pair.privateKey,
    publicKeyPem,
  }
}

export function decryptMessage(
  privateKeyPem: string,
  aesKeyB64: string,
  secureMessage: string,
): string {
  const aesKey = privateDecrypt(
    {
      key: privateKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(aesKeyB64, 'base64'),
  )
  const cipherText = Buffer.from(secureMessage, 'base64')
  if (cipherText.length < 16) throw new Error('ciphertext too short')
  const iv = cipherText.subarray(0, 16)
  const data = cipherText.subarray(16)
  const decipher = createDecipheriv('aes-256-ctr', aesKey, iv)
  return Buffer.concat([decipher.update(data), decipher.final()])
    .toString('utf8')
    .replace(/[ \t\r\n]+$/, '')
}

/** Test helper: encrypt like interactsh-server (RSA-OAEP SHA-256 AES-256-CTR). */
export function encryptMessage(
  publicKeyPem: string,
  plaintext: string,
): { aesKey: string; data: string } {
  const aesKey = randomBytes(32)
  const wrapped = publicEncrypt(
    {
      key: publicKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey,
  )
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-ctr', aesKey, iv)
  const encrypted = Buffer.concat([
    iv,
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  return {
    aesKey: wrapped.toString('base64'),
    data: encrypted.toString('base64'),
  }
}

export { redactSecrets, renderSafe } from '../../neo-runtime/redact.mjs'

function authHeaders(token: string | undefined): Record<string, string> {
  if (!token) return { 'content-type': 'application/json' }
  return { 'content-type': 'application/json', Authorization: token }
}

async function readJson(
  fetchImpl: FetchLike,
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
): Promise<{ status: number; body: unknown }> {
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)])
    : AbortSignal.timeout(15000)
  const res = await fetchImpl(url, { ...init, signal })
  const text = await res.text()
  if (text.length > 2097152) throw new Error('OAST response exceeds quota')
  if (!text) return { status: res.status, body: null }
  try {
    return { status: res.status, body: JSON.parse(text) }
  } catch {
    throw new Error(`invalid OAST JSON response (${res.status})`)
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.trim()) return body
  if (body && typeof body === 'object') {
    const rec = body as { error?: unknown; message?: unknown }
    if (typeof rec.error === 'string') return rec.error
    if (typeof rec.message === 'string') return rec.message
  }
  return fallback
}

function serverHost(base: string): string {
  try {
    return new URL(base).hostname
  } catch {
    return base.replace(/^https?:\/\//, '').split('/')[0] ?? base
  }
}

function payloadFor(session: OastSession): OastRegistration {
  const nonce = randomNonce()
  const domain = `${session.id}${nonce}.${session.serverHost}`
  const url =
    session.kind === 'http'
      ? `${session.callbackScheme}://${domain}${session.callbackPort}`
      : domain
  return { id: session.id, url, domain }
}

export function normalizeInteraction(
  raw: Record<string, unknown>,
): Interaction {
  const out: Interaction = {
    protocol: String(raw.protocol ?? ''),
    uniqueId: String(raw['unique-id'] ?? raw.uniqueId ?? ''),
    fullId: String(raw['full-id'] ?? raw.fullId ?? ''),
    remoteAddress: String(raw['remote-address'] ?? raw.remoteAddress ?? ''),
    timestamp: raw.timestamp != null ? String(raw.timestamp) : '',
  }
  const qType = raw['q-type'] ?? raw.qType
  const rawRequest = raw['raw-request'] ?? raw.rawRequest
  const rawResponse = raw['raw-response'] ?? raw.rawResponse
  const smtpFrom = raw['smtp-from'] ?? raw.smtpFrom
  if (qType != null) out.qType = String(qType)
  if (rawRequest != null) out.rawRequest = String(rawRequest)
  if (rawResponse != null) out.rawResponse = String(rawResponse)
  if (smtpFrom != null) out.smtpFrom = String(smtpFrom)
  return out
}

function parseInteraction(raw: unknown): Interaction | null {
  if (typeof raw === 'string') {
    try {
      return parseInteraction(JSON.parse(raw))
    } catch {
      return null
    }
  }
  if (!raw || typeof raw !== 'object') return null
  return normalizeInteraction(raw as Record<string, unknown>)
}

export async function defaultSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
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

async function authorizeOast(opts: ClientOptions): Promise<void> {
  const env = opts.env ?? process.env
  const task_id = requireTaskId(undefined, env)
  if (!env.NEO_TASK_TOKEN) throw new Error('OAST task credentials required')
  const result = await readJson(
    opts.fetch ?? (globalThis.fetch as FetchLike),
    `${env.NEO_BROKER_URL ?? 'http://broker:8091'}/oast/authorize`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task_id, task_token: env.NEO_TASK_TOKEN }),
      signal: opts.signal,
    },
  )
  if (
    result.status !== 200 ||
    (result.body as { allowed?: boolean })?.allowed !== true
  )
    throw new Error(
      'OAST execution not authorized: task status or current plan approval',
    )
}

export async function registerOast(
  args: { kind: OastKind },
  opts: ClientOptions = {},
): Promise<OastRegistration> {
  if (args.kind !== 'http' && args.kind !== 'dns') {
    throw new Error('kind must be http or dns')
  }
  const env = opts.env ?? process.env
  const taskId = requireTaskId(undefined, env)
  const callbackDomain = env.INTERACTSH_CALLBACK_DOMAIN
  if (
    !callbackDomain ||
    !/^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/i.test(callbackDomain)
  )
    throw new Error(
      'INTERACTSH_CALLBACK_DOMAIN must name a configured callback DNS suffix',
    )
  if (args.kind === 'dns' && env.INTERACTSH_DNS_ENABLED !== 'true')
    throw new Error('DNS OAST unavailable: wildcard resolver is not configured')
  const callbackScheme = env.INTERACTSH_CALLBACK_SCHEME ?? 'http'
  if (!['http', 'https'].includes(callbackScheme))
    throw new Error('unsupported callback scheme')
  const port = env.INTERACTSH_CALLBACK_PORT
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535))
    throw new Error('invalid callback port')
  const callbackPort =
    port &&
    !(
      (callbackScheme === 'http' && port === '80') ||
      (callbackScheme === 'https' && port === '443')
    )
      ? `:${port}`
      : ''
  const callbackBase = env.INTERACTSH_CALLBACK_BASE_URL
    ? new URL(env.INTERACTSH_CALLBACK_BASE_URL)
    : undefined
  if (
    callbackBase &&
    (!['http:', 'https:'].includes(callbackBase.protocol) ||
      callbackBase.username ||
      callbackBase.password)
  )
    throw new Error('invalid callback base URL')
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
  const store = opts.store ?? defaultStore
  await authorizeOast(opts)
  await cleanupOast(opts)
  if (store.size >= 128) throw new Error('OAST registration quota exceeded')
  const base = (opts.interactshUrl ?? interactshUrl(env)).replace(/\/+$/, '')
  const token = opts.token ?? interactshToken(env)
  const correlationId = randomId(20)
  const secretKey = randomUUID()
  const keys = await generateClientKeysAsync()
  if (opts.signal?.aborted) throw new Error('OAST registration aborted')
  await authorizeOast(opts)

  const { status, body } = await readJson(fetchImpl, `${base}/register`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      'public-key': keys.publicKeyB64,
      'secret-key': secretKey,
      'correlation-id': correlationId,
    }),
    signal: opts.signal,
  })

  if (status < 200 || status >= 300) {
    throw new Error(
      `oast_register failed (${status}): ${errorMessage(body, 'http error')}`,
    )
  }

  const session: OastSession = {
    id: correlationId,
    secretKey,
    privateKeyPem: keys.privateKeyPem,
    publicKeyPem: keys.publicKeyPem,
    serverHost: callbackDomain,
    taskId,
    createdAt: (opts.now ?? Date.now)(),
    callbackScheme,
    callbackPort,
    kind: args.kind,
  }
  store.set(correlationId, session)
  const timer = setTimeout(() => {
    void cleanupOast(opts).catch(() => {})
  }, TTL + 1000)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  const payload = payloadFor(session)
  if (callbackBase && args.kind === 'http') {
    payload.url = `${callbackBase.href.replace(/\/+$/, '')}/${payload.domain}`
  }
  return payload
}

async function pollOnce(
  session: OastSession,
  opts: ClientOptions,
): Promise<Interaction[]> {
  await authorizeOast(opts)
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
  const base = (opts.interactshUrl ?? interactshUrl(env)).replace(/\/+$/, '')
  const token = opts.token ?? interactshToken(env)
  const url = `${base}/poll?id=${encodeURIComponent(session.id)}&secret=${encodeURIComponent(session.secretKey)}`
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = token

  const { status, body } = await readJson(fetchImpl, url, {
    method: 'GET',
    headers,
    signal: opts.signal,
  })
  if (status < 200 || status >= 300) {
    throw new Error(
      `oast_poll failed (${status}): ${errorMessage(body, 'http error')}`,
    )
  }

  const obj =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const out: Interaction[] = []
  const aesKey = typeof obj.aes_key === 'string' ? obj.aes_key : ''
  const data = Array.isArray(obj.data) ? obj.data : []
  if (data.length > 256) throw new Error('OAST interaction quota exceeded')
  if (data.length && !aesKey)
    throw new Error('OAST encrypted response lacks AES key')
  for (const item of data) {
    if (typeof item !== 'string') throw new Error('invalid OAST encrypted row')
    try {
      const plain = aesKey
        ? decryptMessage(session.privateKeyPem, aesKey, item)
        : item
      const parsed = parseInteraction(plain)
      if (!parsed) throw new Error('invalid OAST interaction')
      out.push(parsed)
    } catch {
      throw new Error('OAST interaction decryption or decoding failed')
    }
  }
  for (const extra of [obj.extra, obj.tlddata]) {
    if (!Array.isArray(extra)) continue
    for (const item of extra) {
      const parsed = parseInteraction(item)
      if (!parsed) throw new Error('invalid OAST interaction')
      out.push(parsed)
    }
  }
  return out
}

export async function pollOast(
  args: { id: string; wait_seconds?: number },
  opts: ClientOptions = {},
): Promise<Interaction[]> {
  const store = opts.store ?? defaultStore
  const session = store.get(args.id)
  if (!session) throw new Error(`unknown oast id: ${args.id}`)
  const taskId = requireTaskId(undefined, opts.env ?? process.env)
  if (session.taskId !== taskId)
    throw new Error('OAST session belongs to another task')
  if ((opts.now ?? Date.now)() - session.createdAt >= TTL) {
    await cleanupOast(opts)
    throw new Error('OAST session expired')
  }
  const seconds = args.wait_seconds ?? 0
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60)
    throw new Error('wait_seconds must be between 0 and 60')
  const waitMs = seconds * 1000
  const outerSignal = opts.signal
  opts = {
    ...opts,
    signal: outerSignal
      ? AbortSignal.any([outerSignal, AbortSignal.timeout(waitMs + 15000)])
      : AbortSignal.timeout(waitMs + 15000),
  }
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const deadline = now() + waitMs

  while (true) {
    const interactions = await pollOnce(session, opts)
    if (interactions.length > 0) return interactions
    const remaining = deadline - now()
    if (remaining <= 0) return interactions
    await sleep(Math.min(1000, remaining), opts.signal)
  }
}

export async function generateClientKeysAsync(): Promise<{
  publicKeyB64: string
  privateKeyPem: string
  publicKeyPem: string
}> {
  const pair = await new Promise<{ publicKey: Buffer; privateKey: string }>(
    (resolve, reject) =>
      generateKeyPair(
        'rsa',
        {
          modulusLength: 2048,
          publicKeyEncoding: { type: 'spki', format: 'der' },
          privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        },
        (err, publicKey, privateKey) =>
          err ? reject(err) : resolve({ publicKey, privateKey }),
      ),
  )
  return {
    publicKeyB64: Buffer.from(encodePublicKeyPem(pair.publicKey)).toString(
      'base64',
    ),
    privateKeyPem: pair.privateKey,
    publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${pair.publicKey
      .toString('base64')
      .match(/.{1,64}/g)!
      .join('\n')}\n-----END PUBLIC KEY-----\n`,
  }
}
export async function cleanupOast(
  opts: ClientOptions = {},
  all = false,
): Promise<void> {
  const store = opts.store ?? defaultStore
  const env = opts.env ?? process.env
  const taskId = requireTaskId(undefined, env)
  const now = (opts.now ?? Date.now)()
  for (const [id, session] of store) {
    if (all ? session.taskId !== taskId : now - session.createdAt < TTL)
      continue
    const response = await readJson(
      opts.fetch ?? (globalThis.fetch as FetchLike),
      `${opts.interactshUrl ?? interactshUrl(env)}/deregister`,
      {
        method: 'POST',
        headers: authHeaders(opts.token ?? interactshToken(env)),
        body: JSON.stringify({
          'correlation-id': id,
          'secret-key': session.secretKey,
        }),
        signal: opts.signal,
      },
    )
    if (response.status < 200 || response.status >= 300)
      throw new Error(`OAST deregistration failed (${response.status})`)
    store.delete(id)
  }
}
