/** Fixed density matching @deepseek-ai/dsh-token-meter (CHARS_PER_TOKEN = 4). */
export const CHARS_PER_TOKEN = 4

/** Summarize when model-facing tool output exceeds this many heuristic tokens. */
export const SUMMARIZE_THRESHOLD_TOKENS = 10_000

/** Pre-truncate input to the LLM when over this many heuristic tokens. */
export const PRE_TRUNCATE_TOKENS = 900_000

/** Cap for the condensed summary returned to the model. */
export const SUMMARY_MAX_TOKENS = 1_500

export type TextBlock = { type: 'text'; text: string }

export type LlmComplete = (input: {
  provider: string
  model: string
  system: string
  user: string
  maxTokens: number
  signal?: AbortSignal
}) => Promise<string>

export type ProcessResult = {
  text: string
  action: 'unchanged' | 'summarized' | 'truncated'
}

/** Heuristic token count (ceil(chars / 4)), same density as DSH token-meter. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Head/tail truncate to ~maxTokens. Preserves start and end; inserts a marker.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return ''
  if (estimateTokens(text) <= maxTokens) return text

  const maxChars = maxTokens * CHARS_PER_TOKEN
  const originalTokens = estimateTokens(text)
  const marker = `\n\n…[truncated from ~${originalTokens} tokens to ~${maxTokens}]…\n\n`
  const budget = Math.max(0, maxChars - marker.length)
  const head = Math.ceil(budget / 2)
  const tail = Math.floor(budget / 2)
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : '')
}

export function flattenPlainText(content: ReadonlyArray<{ type: string; text?: string }>): string | undefined {
  let text = ''
  for (const block of content) {
    if (block.type !== 'text' || typeof block.text !== 'string') return undefined
    text += block.text
  }
  return text
}

function buildSummaryPrompt(toolName: string, objective: string, output: string): { system: string; user: string } {
  return {
    system: [
      'You summarize oversized tool outputs for a security-assessment agent.',
      'Preserve concrete facts: hosts, URLs, paths, status codes, errors, IDs, commands, and findings.',
      'Omit noise and repetition. Do not invent details. Output plain text only.',
      `Keep the summary under ~${SUMMARY_MAX_TOKENS} tokens.`,
    ].join(' '),
    user: [
      `Tool: ${toolName}`,
      `Objective: ${objective}`,
      '',
      'Tool output:',
      output,
    ].join('\n'),
  }
}

/**
 * If text is over the summarize threshold, replace with an LLM summary (via `llm`).
 * Missing llm / missing provider+model / LLM failure → truncated original.
 * Under threshold → unchanged.
 */
export async function processLargeToolOutput(input: {
  text: string
  toolName: string
  objective?: string
  llm?: LlmComplete | null
  provider?: string
  model?: string
  signal?: AbortSignal
}): Promise<ProcessResult> {
  const tokens = estimateTokens(input.text)
  if (tokens <= SUMMARIZE_THRESHOLD_TOKENS) {
    return { text: input.text, action: 'unchanged' }
  }

  const objective = (input.objective && input.objective.trim()) || 'Continue the current agent task'
  let toSummarize = input.text
  if (tokens > PRE_TRUNCATE_TOKENS) {
    toSummarize = truncateToTokens(input.text, PRE_TRUNCATE_TOKENS)
  }

  const provider = input.provider?.trim()
  const model = input.model?.trim()
  if (!input.llm || !provider || !model) {
    return { text: truncateToTokens(input.text, SUMMARY_MAX_TOKENS), action: 'truncated' }
  }

  try {
    if (input.signal?.aborted) {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      throw err
    }
    const prompt = buildSummaryPrompt(input.toolName, objective, toSummarize)
    const summary = await input.llm({
      provider,
      model,
      system: prompt.system,
      user: prompt.user,
      maxTokens: SUMMARY_MAX_TOKENS,
      signal: input.signal,
    })
    const trimmed = summary.trim()
    if (trimmed.length === 0) {
      return { text: truncateToTokens(input.text, SUMMARY_MAX_TOKENS), action: 'truncated' }
    }
    const capped = estimateTokens(trimmed) > SUMMARY_MAX_TOKENS
      ? truncateToTokens(trimmed, SUMMARY_MAX_TOKENS)
      : trimmed
    const header = `[neo-summarizer] Condensed tool result for "${input.toolName}" (was ~${tokens} tokens):\n\n`
    return { text: header + capped, action: 'summarized' }
  } catch {
    return { text: truncateToTokens(input.text, SUMMARY_MAX_TOKENS), action: 'truncated' }
  }
}

/** Collect text from a ctx.llm.stream()-compatible chunk iterable. */
export async function collectStreamText(
  stream: AsyncIterable<Record<string, unknown>>,
): Promise<string> {
  let text = ''
  let finishKind: string | undefined
  for await (const chunk of stream) {
    const type = chunk.type
    if (type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
    } else if (type === 'block-end') {
      const block = chunk.block as { type?: string; text?: string } | undefined
      if (block?.type === 'text' && typeof block.text === 'string' && text.length === 0) {
        text = block.text
      }
    } else if (type === 'finish') {
      const reason = chunk.reason as { kind?: string } | undefined
      finishKind = reason?.kind
    }
  }
  if (finishKind === 'error' || finishKind === 'aborted') {
    throw new Error(`llm stream finished with ${finishKind}`)
  }
  return text
}

/** Wrap ctx.llm.stream into the LlmComplete used by processLargeToolOutput. */
export function llmCompleteFromStream(
  streamFn: (options: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>,
): LlmComplete {
  return async (input) => {
    const messages = [{
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: input.user }],
      source: { kind: 'plugin', plugin: 'neo-summarizer' },
    }]
    const options: Record<string, unknown> = {
      provider: input.provider,
      model: input.model,
      system: input.system,
      messages,
      maxTokens: input.maxTokens,
    }
    if (input.signal) options.signal = input.signal
    return collectStreamText(streamFn(options))
  }
}

export type ContentBlock = { type: string; text?: string }

export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: unknown; additionalContexts?: unknown[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: unknown[] }

export type ToolExecution = {
  name: string
  parent?: unknown
  signal?: AbortSignal
  agent?: {
    options?: { provider?: string; model?: string; objective?: string }
    session?: { header?: { title?: string; goal?: string } }
  }
}

export type ToolExecutionResult = {
  content: ContentBlock[]
  isError?: boolean
}

export type SummarizerDeps = {
  getLlm: () => LlmComplete | null
  getDefaultModel: (exec: ToolExecution) => { provider?: string; model?: string }
  getObjective?: (exec: ToolExecution) => string
}

export function resolveObjective(exec: ToolExecution): string {
  const header = exec.agent?.session?.header
  const fromHeader = header?.goal ?? header?.title
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader.trim()
  const fromOpts = exec.agent?.options?.objective
  if (typeof fromOpts === 'string' && fromOpts.trim()) return fromOpts.trim()
  return 'Continue the current agent task'
}

/**
 * Cordis `tools/post-execute` waterfall listener. Always awaits `next()`.
 * Oversized plain-text results are summarized (or truncated on failure / missing llm).
 */
export function createPostExecuteHandler(deps: SummarizerDeps) {
  return async (
    exec: ToolExecution,
    result: ToolExecutionResult,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    const decision = await next()
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
    // Nested Code Mode sub-calls: leave model-facing parent result to the outer arm.
    if (exec.parent !== undefined) return decision

    const content = decision.content ?? result.content
    const text = flattenPlainText(content)
    if (text === undefined) return decision

    const { provider, model } = deps.getDefaultModel(exec)
    const processed = await processLargeToolOutput({
      text,
      toolName: exec.name,
      objective: (deps.getObjective ?? resolveObjective)(exec),
      llm: deps.getLlm(),
      provider,
      model,
      signal: exec.signal,
    })

    if (processed.action === 'unchanged') return decision
    return { kind: 'accept', content: [{ type: 'text', text: processed.text }] }
  }
}
