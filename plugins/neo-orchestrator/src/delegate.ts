import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AgentPreset,
  SPECIALIST_OUTPUT_SCHEMA,
  failClosedReason,
  getPreset,
  PresetError,
} from './presets.ts'

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
  ok: true
  backend: 'spawn' | 'in-process'
  results: ChildRunResult[]
}

export interface SubagentStart {
  start: (name: string, request: Record<string, unknown>) => Promise<{
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
const JUDGE_ONLY_CHILD = 'verifier'

/** Agent-plane builtins plus bash (YAML that allows bash can keep it). */
export const DSH_AGENT_PLANE_TOOLS = [
  'bash', 'read', 'write', 'edit', 'glob', 'grep', 'skill', 'web_search',
] as const

export function parseParallelGroup(raw: unknown): ParallelChild[] | undefined {
  if (raw == null) return undefined
  if (!Array.isArray(raw)) {
    throw new PresetError('parallel_group must be an array of {agent_id?, prompt}')
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

export function resolveChildren(args: DelegateArgs): Array<{ agent_id: string; prompt: string }> {
  const topId = typeof args.agent_id === 'string' ? args.agent_id : ''
  const topPrompt = typeof args.prompt === 'string' ? args.prompt : ''
  const group = parseParallelGroup(args.parallel_group)
  if (group) {
    if (group.length === 0) throw new PresetError('parallel_group must not be empty')
    return group.map((item, i) => {
      const agent_id = item.agent_id || topId
      const prompt = item.prompt || topPrompt
      if (!agent_id) throw new PresetError(`parallel_group[${i}] missing agent_id`)
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

export function assertCallerPolicy(callerAgentId: string | undefined, children: Array<{ agent_id: string }>): void {
  if (callerAgentId !== 'judge') return
  const bad = children.filter((c) => c.agent_id !== JUDGE_ONLY_CHILD)
  if (bad.length > 0) {
    throw new PresetError(`judge may only delegate to ${JUDGE_ONLY_CHILD} (got ${bad.map((c) => c.agent_id).join(', ')})`)
  }
}

export function specialistUnavailable(agentId: string, reason: string): SpecialistResult {
  return {
    summary: reason,
    artifacts: [],
    findings_claimed: [],
    next_agent: '',
    blockers: [reason],
  }
}

export function normalizeSpecialist(value: unknown, fallbackSummary = ''): SpecialistResult {
  const rec = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const summary = typeof rec.summary === 'string' && rec.summary.trim() !== ''
    ? rec.summary
    : fallbackSummary
  const artifacts = Array.isArray(rec.artifacts)
    ? rec.artifacts.filter((a): a is string => typeof a === 'string')
    : []
  const findings_claimed = Array.isArray(rec.findings_claimed)
    ? rec.findings_claimed.filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && !Array.isArray(f))
    : []
  const next_agent = typeof rec.next_agent === 'string' ? rec.next_agent : ''
  const blockers = Array.isArray(rec.blockers)
    ? rec.blockers.filter((b): b is string => typeof b === 'string')
    : []
  if (!summary) {
    return { summary: fallbackSummary || 'child returned no summary', artifacts, findings_claimed, next_agent, blockers }
  }
  return { summary, artifacts, findings_claimed, next_agent, blockers }
}

export async function executeDelegate(args: DelegateArgs, opts: DelegateOptions): Promise<DelegateResult> {
  const children = resolveChildren(args)
  for (const child of children) getPreset(opts.presets, child.agent_id)
  assertParallelGroupSize(opts.presets, children)
  assertCallerPolicy(opts.callerAgentId, children)
  throwIfAborted(opts.signal)

  const concurrency = Math.max(1, opts.concurrency ?? intEnv(opts.env?.NEO_DELEGATE_CONCURRENCY, DEFAULT_CONCURRENCY))
  const useSpawn = Boolean(opts.subagents?.start && opts.parent)
  const backend: 'spawn' | 'in-process' = useSpawn ? 'spawn' : 'in-process'
  const results = await mapPool(children, concurrency, (child, index) => runOne(child, index, opts, backend), opts.signal)
  return { ok: true, backend, results }
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
  const runId = makeRunId(preset.id, index, opts.now)
  const closed = failClosedReason(preset, env)
  const structured = closed
    ? specialistUnavailable(preset.id, closed)
    : backend === 'spawn'
      ? await runSpawn(preset, child.prompt, runId, opts)
      : inProcessRecord(preset, child.prompt)
  return writeChildOutput(preset, runId, backend, structured, opts.workspaceDir)
}

async function runSpawn(
  preset: AgentPreset,
  prompt: string,
  runId: string,
  opts: DelegateOptions,
): Promise<SpecialistResult> {
  const subagents = opts.subagents!
  const skillsNote = preset.skills.length > 0
    ? `\nActivate at most 3 skills from: ${preset.skills.join(', ')}.`
    : ''
  const memoryNote = await formatTaskMemoryInject(opts)
  const childPrompt = [
    prompt,
    '',
    'Return structured output with summary and artifacts[]. Prefer sandbox_exec over bash for scans.',
    `Write working files under /workspace/agents/${preset.id}/.`,
    skillsNote,
  ].join('\n')
  const injectBlocks = memoryNote
    ? [{ type: 'text', text: memoryNote }]
    : undefined
  const run = await subagents.start('spawn', {
    label: preset.id,
    prompt: [{ type: 'text', text: childPrompt }],
    parent: opts.parent,
    signal: opts.signal,
    persona: preset.persona,
    toolFilter: {
      allow: filterAllowlist(
        preset.tool_allowlist,
        opts.knownGlobalTools,
        opts.parentVisibleTools,
      ),
    },
    outputSchema: SPECIALIST_OUTPUT_SCHEMA,
    agentOptions: { neoAgentId: preset.id },
    ...(injectBlocks ? { inject: injectBlocks } : {}),
  })
  try {
    if (run.localAgent && opts.onSpawnedAgent) opts.onSpawnedAgent(run.localAgent, preset.id)
    await injectIntoAgent(run.localAgent, injectBlocks)
    const result = await run.result
    const text = Array.isArray(result.output)
      ? result.output.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
      : ''
    if (result.stopReason && result.stopReason !== 'completed') {
      return specialistUnavailable(
        preset.id,
        result.diagnostic || `subagent ${preset.id} ended (${result.stopReason})`,
      )
    }
    return normalizeSpecialist(result.structured, text || `${preset.id} completed`)
  } finally {
    await run.dispose()
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const UUID_EXTRACT_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

function taskIdFromSession(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  const m = sessionId.match(UUID_EXTRACT_RE)
  return m ? m[0].toLowerCase() : undefined
}

async function formatTaskMemoryInject(opts: DelegateOptions): Promise<string | undefined> {
  const env = opts.env ?? process.env
  const parent = opts.parent && typeof opts.parent === 'object'
    ? opts.parent as { id?: unknown }
    : undefined
  const parentId = typeof parent?.id === 'string' ? parent.id : undefined
  const candidates = [env.NEO_TASK_ID?.trim(), taskIdFromSession(parentId)]
  const taskId = candidates.find((v) => v && UUID_RE.test(v))
  if (!taskId) return undefined
  const control = (env.CONTROL_URL ?? 'http://control:8090').replace(/\/+$/, '')
  const fetchImpl = globalThis.fetch as
    | ((input: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; text(): Promise<string> }>)
    | undefined
  if (typeof fetchImpl !== 'function') return undefined
  try {
    const res = await fetchImpl(`${control}/tasks/${encodeURIComponent(taskId)}/memory`, {
      signal: opts.signal,
    })
    const raw = await res.text()
    if (!res.ok || !raw) return undefined
    const body = JSON.parse(raw) as Record<string, unknown>
    return [
      'Shared task memory (injected on subagent/start):',
      JSON.stringify({
        insights: Array.isArray(body.insights) ? body.insights : [],
        facts: Array.isArray(body.facts) ? body.facts : [],
        todos: Array.isArray(body.todos) ? body.todos : [],
        files: Array.isArray(body.files) ? body.files : [],
      }),
    ].join('\n')
  } catch {
    return undefined
  }
}

async function injectIntoAgent(
  localAgent: unknown,
  blocks: Array<{ type: string; text: string }> | undefined,
): Promise<void> {
  if (!blocks?.length || !localAgent || typeof localAgent !== 'object') return
  const agent = localAgent as { inject?: (payload: unknown) => unknown }
  if (typeof agent.inject !== 'function') return
  try {
    await Promise.resolve(agent.inject(blocks))
  } catch {
    // best-effort; child still runs with start-request inject when supported
  }
}

function inProcessRecord(preset: AgentPreset, prompt: string): SpecialistResult {
  return {
    summary:
      `${preset.id} recorded by the in-process runner (ctx.subagents.start missing). `
      + 'No model child ran; this is not a second agent loop.',
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
  const dir = join(workspaceDir, 'agents', preset.id)
  mkdirSync(dir, { recursive: true })
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
  return result
}

function makeRunId(agentId: string, index: number, now?: () => Date): string {
  const d = (now ? now() : new Date()).toISOString().replace(/[:.]/g, '-')
  return `${d}-${agentId}-${index}`
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
  await Promise.all(Array.from({ length: n }, () => worker()))
  return out
}
