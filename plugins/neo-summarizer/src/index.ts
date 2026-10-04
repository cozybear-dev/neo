import {
  persistRawArtifact,
  taskWorkspace,
} from '../../neo-runtime/artifacts.mjs'
import type { Context } from '@deepseek-ai/cordis'
import {
  createPostExecuteHandler,
  llmCompleteFromStream,
  type ToolExecution,
} from './summarize.js'

export const name = 'neo-summarizer'
export const inject = ['tools']

export {
  CHARS_PER_TOKEN,
  SUMMARY_MAX_TOKENS,
  SUMMARIZE_THRESHOLD_TOKENS,
  PRE_TRUNCATE_TOKENS,
  estimateTokens,
  truncateToTokens,
  flattenPlainText,
  processLargeToolOutput,
  collectStreamText,
  llmCompleteFromStream,
  createPostExecuteHandler,
  resolveObjective,
} from './summarize.js'

export function resolveDefaultModel(
  ctx: Context,
  exec: ToolExecution,
): { provider?: string; model?: string } {
  const opts = exec.agent?.options
  if (opts?.provider && opts?.model) {
    return { provider: opts.provider, model: opts.model }
  }

  const fromService = ctx.get('agentDefaultModel') as
    | { currentSelection?: () => { provider: string; model: string } }
    | undefined
  const selection = fromService?.currentSelection?.()
  if (selection?.provider && selection?.model) {
    return { provider: selection.provider, model: selection.model }
  }

  return {}
}

function resolveLlm(ctx: Context) {
  const llm = (ctx.get('llm') ?? ctx.llm) as
    | {
        stream?: (
          options: Record<string, unknown>,
        ) => AsyncIterable<Record<string, unknown>>
      }
    | undefined
  if (!llm || typeof llm.stream !== 'function') return null
  return llmCompleteFromStream(llm.stream.bind(llm))
}

export function apply(ctx: Context): void {
  ctx.on(
    'tools/post-execute',
    createPostExecuteHandler({
      getLlm: () => resolveLlm(ctx),
      getDefaultModel: (exec) => resolveDefaultModel(ctx, exec),
      persist: (text) =>
        persistRawArtifact(text, { root: taskWorkspace(process.env) }),
    }),
  )
}
