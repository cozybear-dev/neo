import { readJson, controlUrl } from '../../neo-runtime/contracts.mjs'

const OBJECTIVE_MAX = 16384

export type SessionAgent = {
  options?: {
    neoTaskId?: unknown
    neoTaskToken?: unknown
    neoMode?: unknown
  }
}

export type SessionEnv = Record<string, string | undefined>

type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<{ status: number; text(): Promise<string> }>

const pending = new WeakMap<SessionAgent, Promise<void>>()

/** Text of a person-typed chat message. Runtime and skill notes are not tasks. */
export function objectiveFromMessage(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined
  const rec = message as {
    role?: unknown
    source?: { kind?: unknown }
    content?: unknown
  }
  if (rec.role !== 'user' || rec.source?.kind !== 'user') return undefined
  if (!Array.isArray(rec.content)) return undefined
  const text = rec.content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const item = block as { type?: unknown; text?: unknown }
      return item.type === 'text' && typeof item.text === 'string'
        ? item.text.trim()
        : ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
  if (!text) return undefined
  return text.length > OBJECTIVE_MAX ? text.slice(0, OBJECTIVE_MAX) : text
}

export function chatAlreadyBound(env: SessionEnv, agent: SessionAgent): boolean {
  if (env.NEO_TASK_ID?.trim() && env.NEO_TASK_TOKEN?.trim()) return true
  const id = agent.options?.neoTaskId
  const token = agent.options?.neoTaskToken
  return typeof id === 'string' && id.length > 0 && typeof token === 'string' && token.length > 0
}

/** Open one control task for this chat. Later messages reuse it. */
export function openChatSession(
  agent: SessionAgent,
  objective: string,
  deps: { env?: SessionEnv; fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<void> {
  const env = deps.env ?? process.env
  if (chatAlreadyBound(env, agent)) return Promise.resolve()
  const existing = pending.get(agent)
  if (existing) return existing
  const work = performOpen(agent, objective, env, deps.fetch, deps.signal)
  pending.set(agent, work)
  work.catch(() => {
    if (pending.get(agent) === work) pending.delete(agent)
  })
  return work
}

async function performOpen(
  agent: SessionAgent,
  objective: string,
  env: SessionEnv,
  fetchImpl: FetchLike | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const opener = env.NEO_SESSION_OPEN_TOKEN?.trim() ?? ''
  if (!opener) throw new Error('session open is not configured')
  const { status, body } = await readJson(
    fetchImpl ?? (globalThis.fetch as FetchLike),
    `${controlUrl(env)}/session`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opener}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ objective }),
      signal,
    },
  )
  const rec =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  if (
    status < 200 ||
    status >= 300 ||
    typeof rec.id !== 'string' ||
    typeof rec.task_token !== 'string' ||
    (rec.mode !== 'fast' && rec.mode !== 'thorough')
  ) {
    const err = typeof rec.error === 'string' ? rec.error : 'http error'
    throw new Error(`session open failed (${status}): ${err}`)
  }
  agent.options ??= {}
  agent.options.neoTaskId = rec.id
  agent.options.neoTaskToken = rec.task_token
  agent.options.neoMode = rec.mode
}

type InboxPayload = { agent?: SessionAgent; message?: unknown }
type PreStepPayload = { agent?: SessionAgent; messages?: unknown[] }

/** First typed message opens the task. pre-step waits so tools see the credential. */
export function registerSessionOpen(ctx: {
  on?: (name: string, listener: (...args: any[]) => unknown) => unknown
}): void {
  if (typeof ctx.on !== 'function') return
  const deps = { env: process.env, fetch: globalThis.fetch as FetchLike }
  ctx.on('agent/inbox/inserted', (payload: InboxPayload) => {
    const objective = objectiveFromMessage(payload?.message)
    if (!objective || !payload?.agent) return
    void openChatSession(payload.agent, objective, deps).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'session open failed')
    })
  })
  ctx.on(
    'agent/pre-step',
    async (payload: PreStepPayload, next: () => Promise<unknown>) => {
      const agent = payload?.agent
      const objective = (payload?.messages ?? [])
        .map((message) => objectiveFromMessage(message))
        .find((value): value is string => Boolean(value))
      if (agent && objective) await openChatSession(agent, objective, deps)
      return next()
    },
  )
}
