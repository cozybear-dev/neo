import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createTools } from './tools.ts'
import { listKnownGlobalTools, type SubagentStart } from './delegate.ts'
import {
  catalogSectionText,
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
  catalogSectionText,
  isSpecialistScope,
  buildModeMachinePrompt,
  normalizeMode,
} from './presets.js'

export {
  DSH_AGENT_PLANE_TOOLS,
  executeDelegate,
  listKnownGlobalTools,
  resolveChildren,
  assertParallelGroupSize,
  parseParallelGroup,
  filterAllowlist,
} from './delegate.js'

function asSubagents(ctx: Context): SubagentStart | undefined {
  const raw = ctx.get('subagents') as SubagentStart | undefined
  if (!raw || typeof raw.start !== 'function') return undefined
  return raw
}

function knownGlobalTools(ctx: Context, parent?: unknown): string[] | undefined {
  const tools = (ctx.get('tools') ?? ctx.tools) as
    | { schemas?: (scope?: unknown) => Array<{ name?: string }> }
    | undefined
  return listKnownGlobalTools(tools, parent)
}

export function apply(ctx: Context): void {
  const presets = loadPresetsFromDir(resolvePresetsDir())
  const workspaceDir = process.env.NEO_WORKSPACE || '/workspace'

  const promptApi = ctx.get('systemPrompt') as Context['systemPrompt']
  if (promptApi && typeof promptApi.section === 'function') {
    promptApi.section({
      name: 'neo:orchestrator',
      order: 50,
      text: (context) => catalogSectionText(context, presets, process.env.NEO_MODE || 'thorough'),
    })
  }

  for (const def of createTools({
    presets,
    workspaceDir,
    env: process.env,
    getSubagents: () => asSubagents(ctx),
    getKnownGlobalTools: (parent?: unknown) => knownGlobalTools(ctx, parent),
  })) ctx.tools.register(defineTool(def))
}
