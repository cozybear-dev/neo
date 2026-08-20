import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createTools } from './tools.ts'
import { type SubagentStart } from './delegate.ts'
import {
  catalogPrompt,
  loadPresetsFromDir,
  resolvePresetsDir,
} from './presets.ts'

export const name = 'neo-orchestrator'
export const inject = ['tools']
export { createTools } from './tools.ts'

export {
  REQUIRED_PRESET_IDS,
  SPECIALIST_OUTPUT_SCHEMA,
  parsePresetYaml,
  loadPresetsFromDir,
  resolvePresetsDir,
  getPreset,
  catalogPrompt,
  buildModeMachinePrompt,
  normalizeMode,
} from './presets.js'

export {
  executeDelegate,
  resolveChildren,
  assertParallelGroupSize,
  parseParallelGroup,
  filterAllowlist,
} from './delegate.js'

function asSubagents(ctx: Context): SubagentStart | undefined {
  const raw = (ctx.get('subagents') ?? ctx.subagents) as SubagentStart | undefined
  if (!raw || typeof raw.start !== 'function') return undefined
  return raw
}

function listKnownGlobalTools(ctx: Context): string[] | undefined {
  const tools = (ctx.get('tools') ?? ctx.tools) as
    | { schemas?: (scope?: unknown) => Array<{ name?: string }> }
    | undefined
  if (!tools || typeof tools.schemas !== 'function') return undefined
  try {
    const names = tools.schemas()
      .map((schema) => schema?.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
    return names.length > 0 ? names : undefined
  } catch {
    return undefined
  }
}

export function apply(ctx: Context): void {
  const presets = loadPresetsFromDir(resolvePresetsDir())
  const workspaceDir = process.env.NEO_WORKSPACE || '/workspace'

  const promptApi = ctx.get('systemPrompt') as Context['systemPrompt']
  if (promptApi && typeof promptApi.section === 'function') {
    promptApi.section({
      name: 'neo:orchestrator',
      order: 50,
      text: () => catalogPrompt(presets, process.env.NEO_MODE || 'thorough'),
    })
  }

  for (const def of createTools({
    presets,
    workspaceDir,
    env: process.env,
    subagents: asSubagents(ctx),
    knownGlobalTools: listKnownGlobalTools(ctx),
  })) ctx.tools.register(defineTool(def))
}
