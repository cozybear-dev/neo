import {
  requireTaskId,
  taskHeaders,
  readJson,
} from '../../neo-runtime/contracts.mjs'
import { childRun, controlCall } from './policy.ts'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AgentPreset,
  SPECIALIST_OUTPUT_SCHEMA,
  failClosedReason,
  getPreset,
  PresetError,
} from './presets.ts'

/** Shared task group can write; unrelated users have no access. */
export const CHILD_ARTIFACT_MKDIR_OPTS = {
  recursive: true,
  mode: 0o770,
} as const

export interface ParallelChild {
  agent_id?: string
  prompt?: string
}

export interface DelegateArgs {
  agent_id?: unknown
  prompt?: unknown
  parallel_group?: unknown
}

export interface SpecialistResult {
  summary: string
  artifacts: string[]
  findings_claimed: Array<Record<string, unknown>>
  next_agent: string
  blockers: string[]
}

export interface ChildRunResult extends SpecialistResult {
  agent_id: string
  run_id: string
  backend: 'spawn' | 'in-process'
  artifact_path: string
}

export interface DelegateResult {
  ok: boolean
  backend: 'spawn' | 'in-process'
  results: ChildRunResult[]
}

export interface SubagentStart {
  start: (
    name: string,
    request: Record<string, unknown>,
  ) => Promise<{
    id?: string
    localAgent?: unknown
    result: Promise<{
      structured?: unknown
      output?: Array<{ type?: string; text?: string }>
      stopReason?: string
      diagnostic?: string
    }>
    dispose: () => Promise<void>
  }>
}

export interface DelegateOptions {
  presets: Map<string, AgentPreset>
  workspaceDir: string
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  parent?: unknown
  callerAgentId?: string
  subagents?: SubagentStart
  concurrency?: number
  runToken?: string
  now?: () => Date
  onSpawnedAgent?: (agent: unknown, agentId: string) => void
  /** Host-registered global tool names. Unknown allowlist entries are dropped so tools.restrict() can apply. */
  knownGlobalTools?: Iterable<string>
  /**
   * Parent-visible tool names (e.g. tools.schemas(parent) ∪ agent-plane builtins).
   * When non-empty, filterAllowlist uses this instead of the plugin-only known set.
   */
  parentVisibleTools?: Iterable<string>
}

const DEFAULT_CONCURRENCY = 4
const activeByTask = new Map<string, number>()
const totalByTask = new Map<string, number>()
const JUDGE_ONLY_CHILD = 'verifier'

/** Agent-plane builtins plus bash (YAML that allows bash can keep it). */
export const DSH_AGENT_PLANE_TOOLS = [
  'bash',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'skill',
  'web_search',
] as const

/**
 * Parent-visible + global schemas, unioned with agent-plane builtins.
 * `schemas(parent)` failure still runs `schemas()` so plugin tools are not stripped.
 */
export function listKnownGlobalTools(
  tools:
    | { schemas?: (scope?: unknown) => Array<{ name?: string }> }
    | undefined,
  parent?: unknown,
): string[] | undefined {
  if (!tools || typeof tools.schemas !== 'function') return undefined
  let fromParent: Array<{ name?: string }> = []
  if (parent != null) {
    try {
      fromParent = tools.schemas(parent) ?? []
    } catch {
      fromParent = []
    }
  }
  let fromGlobal: Array<{ name?: string }> = []
  try {
    fromGlobal = tools.schemas() ?? []
  } catch {
    fromGlobal = []
  }
  const names = [...fromParent, ...fromGlobal]
    .map((schema) => schema?.name)
    .filter(
      (name): name is string => typeof name === 'string' && name.length > 0,
    )
  return [...new Set([...names, ...DSH_AGENT_PLANE_TOOLS])]
}

export function parseParallelGroup(raw: unknown): ParallelChild[] | undefined {
  if (raw == null) return undefined
  if (!Array.isArray(raw)) {
    throw new PresetError(
      'parallel_group must be an array of {agent_id?, prompt}',
    )
  }
  return raw.map((item, i) => {
    if (typeof item === 'string') return { prompt: item }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new PresetError(`parallel_group[${i}] must be an object or string`)
    }
    const rec = item as Record<string, unknown>
    return {
      agent_id: typeof rec.agent_id === 'string' ? rec.agent_id : undefined,
      prompt: typeof rec.prompt === 'string' ? rec.prompt : undefined,
    }
  })
}

export function resolveChildren(
  args: DelegateArgs,
): Array<{ agent_id: string; prompt: string }> {
  const topId = typeof args.agent_id === 'string' ? args.agent_id : ''
  const topPrompt = typeof args.prompt === 'string' ? args.prompt : ''
  const group = parseParallelGroup(args.parallel_group)
  if (group) {
    if (group.length === 0)
      throw new PresetError('parallel_group must not be empty')
    return group.map((item, i) => {
      const agent_id = item.agent_id || topId
      const prompt = item.prompt || topPrompt
      if (!agent_id)
        throw new PresetError(`parallel_group[${i}] missing agent_id`)
      if (!prompt) throw new PresetError(`parallel_group[${i}] missing prompt`)
      return { agent_id, prompt }
    })
  }
  if (!topId) throw new PresetError('agent_id is required')
  if (!topPrompt) throw new PresetError('prompt is required')
  return [{ agent_id: topId, prompt: topPrompt }]
}

export function assertParallelGroupSize(
  presets: Map<string, AgentPreset>,
  children: Array<{ agent_id: string }>,
): void {
  const counts = new Map<string, number>()
  for (const child of children) {
    getPreset(presets, child.agent_id)
    counts.set(child.agent_id, (counts.get(child.agent_id) ?? 0) + 1)
  }
  for (const [id, n] of counts) {
    const preset = getPreset(presets, id)
    if (n > preset.max_parallel) {
      throw new PresetError(
        `parallel_group size ${n} exceeds max_parallel ${preset.max_parallel} for agent_id ${id}`,
      )
    }
  }
}

/**
 * DSH `tools.restrict({ allow })` throws on names that are not currently
 * registered global tools (this host has `web_search` but not `web_fetch`).
 * When parentVisible is a non-empty set, intersect YAML with that catalog
 * (agent-plane builtins + parent schemas). Otherwise fall back to known
 * (often plugin-only schemas()); if known is missing/empty, keep the yaml list.
 */
export function filterAllowlist(
  allow: readonly string[],
  known?: Iterable<string>,
  parentVisible?: Iterable<string>,
): string[] {
  const parent = parentVisible != null ? new Set(parentVisible) : undefined
  if (parent && parent.size > 0) {
    return allow.filter((name) => parent.has(name))
  }
  if (known == null) return [...allow]
  const set = known instanceof Set ? known : new Set(known)
  if (set.size === 0) return [...allow]
  return allow.filter((name) => set.has(name))
}

export function assertCallerPolicy(
  callerAgentId: string | undefined,
  children: Array<{ agent_id: string }>,
): void {
  if (
    callerAgentId === 'planner' &&
    children.some((c) => c.agent_id !== 'explore')
  )
    throw new PresetError('planner may only delegate to explore')
  if (callerAgentId !== 'judge') return
  const bad = children.filter((c) => c.agent_id !== JUDGE_ONLY_CHILD)
  if (bad.length > 0) {
    throw new PresetError(
      `judge may only delegate to ${JUDGE_ONLY_CHILD} (got ${bad.map((c) => c.agent_id).join(', ')})`,
    )
  }
}

export function specialistUnavailable(
  agentId: string,
  reason: string,
): SpecialistResult {
  return {
    summary: reason,
    artifacts: [],
    findings_claimed: [],
    next_agent: '',
    blockers: [reason],
  }
}

export function normalizeSpecialist(
  value: unknown,
  fallbackSummary = '',
): SpecialistResult {
  const rec =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const summary =
    typeof rec.summary === 'string' && rec.summary.trim() !== ''
      ? rec.summary
      : fallbackSummary
  const artifacts = Array.isArray(rec.artifacts)
    ? rec.artifacts.filter((a): a is string => typeof a === 'string')
    : []
  const findings_claimed = Array.isArray(rec.findings_claimed)
    ? rec.findings_claimed.filter(
        (f): f is Record<string, unknown> =>
          !!f && typeof f === 'object' && !Array.isArray(f),
      )
    : []
  const next_agent = typeof rec.next_agent === 'string' ? rec.next_agent : ''
  const blockers = Array.isArray(rec.blockers)
    ? rec.blockers.filter((b): b is string => typeof b === 'string')
    : []
  if (!summary) {
    return {
      summary: fallbackSummary || 'child returned no summary',
      artifacts,
      findings_claimed,
      next_agent,
      blockers,
    }
  }
  return { summary, artifacts, findings_claimed, next_agent, blockers }
}

export async function executeDelegate(
  args: DelegateArgs,
  opts: DelegateOptions,
): Promise<DelegateResult> {
  const taskId = requireTaskId(
    undefined,
    opts.env ?? process.env,
    opts.parent as any,
  )
  const authoritative = await controlCall(
    opts.env ?? process.env,
    opts.parent,
    `/tasks/${taskId}`,
    undefined,
    opts.signal,
  )
  if (!['fast', 'thorough'].includes(authoritative.mode))
    throw new Error('invalid authoritative task mode')
  opts = {
    ...opts,
    env: { ...(opts.env ?? process.env), NEO_MODE: authoritative.mode },
  }
  if (opts.parent && typeof opts.parent === 'object') {
    ;(opts.parent as any).options ??= {}
    ;(opts.parent as any).options.neoMode = authoritative.mode
  }
  const children = resolveChildren(args)
  const active = activeByTask.get(taskId) ?? 0
  const total = totalByTask.get(taskId) ?? 0
  const limit = intEnv(opts.env?.NEO_TASK_CONCURRENCY, 8)
  if (active + children.length > limit)
    throw new PresetError('task shared concurrency limit exceeded')
  if (total + children.length > 128)
    throw new PresetError('task run budget exceeded')
  const depth = Number((opts.parent as any)?.options?.neoDepth ?? 0)
  if (depth >= 8) throw new PresetError('task delegation depth exceeded')
  for (const child of children) getPreset(opts.presets, child.agent_id)
  assertParallelGroupSize(opts.presets, children)
  assertCallerPolicy(opts.callerAgentId, children)
  throwIfAborted(opts.signal)

  const concurrency = Math.max(
    1,
    opts.concurrency ??
      intEnv(opts.env?.NEO_DELEGATE_CONCURRENCY, DEFAULT_CONCURRENCY),
  )
  const useSpawn = Boolean(opts.subagents?.start && opts.parent)
  const backend: 'spawn' | 'in-process' = useSpawn ? 'spawn' : 'in-process'
  activeByTask.set(taskId, active + children.length)
  totalByTask.set(taskId, total + children.length)
  if (totalByTask.size > 256)
    totalByTask.delete(totalByTask.keys().next().value!)
  try {
    const results = await mapPool(
      children,
      concurrency,
      async (child, index) => {
        try {
          return await runOne(child, index, opts, backend)
        } catch (error) {
          return writeChildOutput(
            getPreset(opts.presets, child.agent_id),
            randomUUID(),
            backend,
            specialistUnavailable(
              child.agent_id,
              error instanceof Error ? error.message : 'child failed',
            ),
            join(
              opts.workspaceDir,
              'tasks',
              requireTaskId(
                undefined,
                opts.env ?? process.env,
                opts.parent as any,
              ),
            ),
          )
        }
      },
      opts.signal,
    )
    return {
      ok: backend === 'spawn' && results.every((r) => r.blockers.length === 0),
      backend,
      results,
    }
  } finally {
    const remaining = Math.max(
      0,
      (activeByTask.get(taskId) ?? 0) - children.length,
    )
    if (remaining) activeByTask.set(taskId, remaining)
    else activeByTask.delete(taskId)
  }
}

async function runOne(
  child: { agent_id: string; prompt: string },
  index: number,
  opts: DelegateOptions,
  backend: 'spawn' | 'in-process',
): Promise<ChildRunResult> {
  throwIfAborted(opts.signal)
  const preset = getPreset(opts.presets, child.agent_id)
  const env = opts.env ?? {}
  const identity = await childRun(
    opts.env ?? process.env,
    opts.parent,
    ['planner', 'judge', 'verifier', 'explore', 'swarm'].includes(preset.id)
      ? preset.id
      : 'specialist',
    opts.signal,
  )
  const runId = identity.id
  const dir = join(
    opts.workspaceDir,
    'tasks',
    requireTaskId(undefined, opts.env ?? process.env, opts.parent as any),
    'agents',
    preset.id,
    runId,
  )
  const childOpts = {
    ...opts,
    workspaceDir: join(
      opts.workspaceDir,
      'tasks',
      requireTaskId(undefined, opts.env ?? process.env, opts.parent as any),
    ),
    runToken: identity.run_token,
  }
  const closed = failClosedReason(preset, env)
  const finishAgent = {
    options: {
      neoRunId: runId,
      neoRunToken: identity.run_token,
      neoTaskId: neoTaskIdForChild(opts),
    },
  }
  try {
    mkdirSync(dir, CHILD_ARTIFACT_MKDIR_OPTS)
    const structured = closed
      ? specialistUnavailable(preset.id, closed)
      : backend === 'spawn'
        ? await runSpawn(preset, child.prompt, runId, childOpts)
        : inProcessRecord(preset, child.prompt)
    const result = writeChildOutput(
      preset,
      runId,
      backend,
      structured,
      childOpts.workspaceDir,
    )
    await controlCall(
      env,
      finishAgent,
      `/tasks/${neoTaskIdForChild(opts)}/runs/${runId}/finish`,
      {
        status:
          closed || backend === 'in-process'
            ? 'unavailable'
            : structured.blockers.length
              ? 'failed'
              : 'completed',
        outcome: {
          summary: structured.summary,
          artifacts: result.artifacts,
          blockers: structured.blockers,
        },
      },
      opts.signal,
    )
    return result
  } catch (error) {
    try {
      await controlCall(
        env,
        finishAgent,
        `/tasks/${neoTaskIdForChild(opts)}/runs/${runId}/finish`,
        {
          status: opts.signal?.aborted ? 'cancelled' : 'failed',
          outcome: {
            error: error instanceof Error ? error.message : 'child failed',
          },
        },
      )
    } catch {}
    throw error
  }
}

async function runSpawn(
  preset: AgentPreset,
  prompt: string,
  runId: string,
  opts: DelegateOptions,
): Promise<SpecialistResult> {
  const timeout = intEnv(opts.env?.NEO_CHILD_TIMEOUT_MS, 900000)
  const deadline = AbortSignal.timeout(timeout)
  opts = {
    ...opts,
    signal: opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline,
  }
  const subagents = opts.subagents!
  const skillsNote =
    preset.skills.length > 0
      ? `\nActivate at most 3 skills from: ${preset.skills.join(', ')}.`
      : ''
  const memoryNote = await formatTaskMemoryInject(opts)
  const childPrompt = [
    prompt,
    '',
    'Return structured output with summary and artifacts[]. Prefer sandbox_exec over bash for scans.',
    `Write working files under ${join(opts.workspaceDir, 'agents', preset.id, runId)}/.`,
    skillsNote,
  ].join('\n')
  const injectBlocks = memoryNote
    ? [{ type: 'text', text: memoryNote }]
    : undefined
  const neoTaskId = neoTaskIdForChild(opts)
  const workhorse = workhorseAgentOptions(opts.env)
  const run = await subagents.start('spawn', {
    label: preset.id,
    prompt: [{ type: 'text', text: childPrompt }],
    parent: opts.parent,
    signal: opts.signal,
    persona: preset.persona.replaceAll(
      '/workspace',
      join(opts.workspaceDir, 'agents', preset.id, runId),
    ),
    toolFilter: {
      allow: filterAllowlist(
        preset.tool_allowlist.filter(
          (name) =>
            name !== 'bash' &&
            (!preset.readonly ||
              ![
                'sandbox_exec',
                'deploy_up',
                'deploy_down',
                'browser_evaluate',
                'browser_eval',
                'browser_act',
                'browser_navigate',
                'traffic_replay',
                'oast_register',
              ].includes(name)),
        ),
        opts.knownGlobalTools,
        opts.parentVisibleTools,
      ),
    },
    outputSchema: SPECIALIST_OUTPUT_SCHEMA,
    agentOptions: {
      neoAgentId: preset.id,
      neoMode: opts.env?.NEO_MODE,
      neoRunId: runId,
      neoDepth: Number((opts.parent as any)?.options?.neoDepth ?? 0) + 1,
      neoRunToken: opts.runToken,
      ...(neoTaskId ? { neoTaskId } : {}),
      ...workhorse,
    },
  })
  try {
    if (run.localAgent && opts.onSpawnedAgent)
      opts.onSpawnedAgent(run.localAgent, preset.id)
    await injectIntoAgent(run.localAgent, injectBlocks)
    const result = await awaitAbortable(run.result, opts.signal)
    const text = Array.isArray(result.output)
      ? result.output
          .map((b) => (typeof b?.text === 'string' ? b.text : ''))
          .join('')
      : ''
    if (result.stopReason && result.stopReason !== 'completed') {
      return specialistUnavailable(
        preset.id,
        result.diagnostic ||
          `subagent ${preset.id} ended (${result.stopReason})`,
      )
    }
    return normalizeSpecialist(
      result.structured,
      text || `${preset.id} completed`,
    )
  } finally {
    await run.dispose()
  }
}

/** Host-resolved workhorse route. Both provider and model must be set, or the child inherits. */
export function workhorseAgentOptions(
  env: Record<string, string | undefined> | undefined,
): {
  provider?: string
  model?: string
  reasoningEffort?: string
} {
  const provider = env?.NEO_RESOLVED_WORKHORSE_PROVIDER?.trim() ?? ''
  const model = env?.NEO_RESOLVED_WORKHORSE_MODEL?.trim() ?? ''
  if (provider === '' || model === '') return {}
  const reasoningEffort =
    env?.NEO_RESOLVED_WORKHORSE_REASONING_EFFORT?.trim() ?? ''
  return {
    provider,
    model,
    ...(reasoningEffort !== '' ? { reasoningEffort } : {}),
  }
}

function neoTaskIdForChild(opts: DelegateOptions): string {
  return requireTaskId(undefined, opts.env ?? process.env, opts.parent as any)
}

async function formatTaskMemoryInject(
  opts: DelegateOptions,
): Promise<string | undefined> {
  const env = opts.env ?? process.env
  const response = await readJson(
    globalThis.fetch,
    `${env.CONTROL_URL ?? 'http://control:8090'}/tasks/${neoTaskIdForChild(opts)}/memory`,
    { headers: taskHeaders(env, opts.parent as any), signal: opts.signal },
  )
  if (
    response.status !== 200 ||
    !response.body ||
    !['insights', 'facts', 'todos', 'files'].every((key) =>
      Array.isArray(response.body[key]),
    )
  )
    throw new Error('task memory unavailable or malformed')
  return (
    'Shared task memory (injected on subagent/start):\n' +
    JSON.stringify(response.body)
  )
}

function awaitAbortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup()
      reject(signal.reason ?? new Error('child deadline exceeded'))
    }
    const cleanup = () => signal.removeEventListener('abort', abort)
    if (signal.aborted) {
      promise.catch(() => {})
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

async function injectIntoAgent(
  localAgent: unknown,
  blocks: Array<{ type: string; text: string }> | undefined,
): Promise<void> {
  if (!blocks?.length || !localAgent || typeof localAgent !== 'object') return
  const agent = localAgent as { inject?: (payload: unknown) => unknown }
  if (typeof agent.inject !== 'function') return
  try {
    // Agent.inject queues a UserMessage. A bare content-block array has no
    // source, and the turn then throws reading message.source.kind.
    await Promise.resolve(
      agent.inject({
        role: 'user',
        id: randomUUID(),
        content: blocks,
        source: { kind: 'user' },
      }),
    )
  } catch {
    // best-effort; a child that rejects inject still runs its start prompt
  }
}

function inProcessRecord(
  preset: AgentPreset,
  prompt: string,
): SpecialistResult {
  return {
    summary:
      `${preset.id} recorded by the in-process runner (ctx.subagents.start missing). ` +
      'No model child ran; this is not a second agent loop.',
    artifacts: [],
    findings_claimed: [],
    next_agent: '',
    blockers: [
      'subagent spawn unavailable',
      `persona applied in record only (${preset.id})`,
    ],
    // prompt retained on disk via writeChildOutput meta, not in model-facing blockers
  }
}

function writeChildOutput(
  preset: AgentPreset,
  runId: string,
  backend: 'spawn' | 'in-process',
  structured: SpecialistResult,
  workspaceDir: string,
): ChildRunResult {
  const dir = join(workspaceDir, 'agents', preset.id, runId)
  // mode on mkdirSync is umask-masked (often 0755); chmod forces other-write for neo.
  mkdirSync(dir, { ...CHILD_ARTIFACT_MKDIR_OPTS })
  chmodSync(dir, 0o770)
  const artifactPath = join(dir, `${runId}.json`).replace(/\\/g, '/')
  const artifacts = structured.artifacts.includes(artifactPath)
    ? structured.artifacts
    : [...structured.artifacts, artifactPath]
  const result: ChildRunResult = {
    agent_id: preset.id,
    run_id: runId,
    backend,
    artifact_path: artifactPath,
    summary: structured.summary,
    artifacts,
    findings_claimed: structured.findings_claimed,
    next_agent: structured.next_agent,
    blockers: structured.blockers,
  }
  writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  chmodSync(artifactPath, 0o660)
  return result
}

function intEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : fallback
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const err = new Error('aborted')
  err.name = 'AbortError'
  throw err
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      throwIfAborted(signal)
      const i = next
      next += 1
      if (i >= items.length) return
      out[i] = await fn(items[i]!, i)
    }
  }
  const n = Math.min(limit, items.length)
  const settled = await Promise.allSettled(
    Array.from({ length: n }, () => worker()),
  )
  const failed = settled.find((r) => r.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  return out
}
