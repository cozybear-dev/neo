import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  executeDelegate,
  type DelegateArgs,
  type SubagentStart,
} from './delegate.ts'
import {
  catalogPrompt,
  loadPresetsFromDir,
  resolvePresetsDir,
} from './presets.ts'

export const name = 'neo-orchestrator'
export const inject = ['tools']

export {
  REQUIRED_PRESET_IDS,
  SPECIALIST_OUTPUT_SCHEMA,
  parsePresetYaml,
  loadPresetsFromDir,
  resolvePresetsDir,
  getPreset,
  catalogPrompt,
} from './presets.js'

export {
  executeDelegate,
  resolveChildren,
  assertParallelGroupSize,
  parseParallelGroup,
} from './delegate.js'

const callerIds = new WeakMap<object, string>()

function render(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function asSubagents(ctx: Context): SubagentStart | undefined {
  const raw = (ctx.get('subagents') ?? ctx.subagents) as SubagentStart | undefined
  if (!raw || typeof raw.start !== 'function') return undefined
  return raw
}

function callerAgentId(exec: { agent?: unknown }): string {
  const agent = exec.agent
  if (agent && typeof agent === 'object' && callerIds.has(agent)) {
    return callerIds.get(agent) as string
  }
  if (agent && typeof agent === 'object') {
    const rec = agent as { options?: { neoAgentId?: unknown }; label?: unknown }
    if (typeof rec.options?.neoAgentId === 'string') return rec.options.neoAgentId
    if (typeof rec.label === 'string') return rec.label
  }
  return process.env.NEO_AGENT_ID || 'orchestrator'
}

export function apply(ctx: Context): void {
  const presets = loadPresetsFromDir(resolvePresetsDir())
  const workspaceDir = process.env.NEO_WORKSPACE || '/workspace'

  const promptApi = ctx.systemPrompt
  if (promptApi && typeof promptApi.section === 'function') {
    const text = catalogPrompt(presets)
    promptApi.section({ name: 'neo:orchestrator', order: 50, text })
  }

  ctx.tools.register(defineTool({
    name: 'delegate',
    description:
      'Spawn a named Neo specialist preset (persona + toolFilter + outputSchema). '
      + 'Pass parallel_group to start N children and await all (explore×3, verifier×5, swarm streams). '
      + 'Unknown agent_id is rejected. Size is capped by each preset max_parallel. '
      + 'Children inherit the parent LLM provider/model. Prefer this over a generic subagent tool.',
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: 'Preset id (orchestrator, planner, swarm, explore, recon, …).',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'Complete standalone task for the child. Include scope, mode, and paths.',
      },
      parallel_group: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            agent_id: { type: 'string', description: 'Defaults to the top-level agent_id.' },
            prompt: { type: 'string', description: 'Defaults to the top-level prompt.' },
          },
        },
        description: 'Start N children in parallel and await all. Size cannot exceed preset max_parallel.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, const: true },
          backend: { type: 'string', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                agent_id: { type: 'string', required: true },
                run_id: { type: 'string', required: true },
                backend: { type: 'string', required: true },
                artifact_path: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                artifacts: { type: 'array', items: { type: 'string' }, required: true },
                findings_claimed: { type: 'array', items: { type: 'object' }, required: true },
                next_agent: { type: 'string', required: true },
                blockers: { type: 'array', items: { type: 'string' }, required: true },
              },
            },
          },
        },
      },
      render,
    },
    async execute(args, exec) {
      return executeDelegate(args as DelegateArgs, {
        presets,
        workspaceDir,
        env: process.env,
        signal: exec.signal,
        parent: exec.agent,
        callerAgentId: callerAgentId(exec),
        subagents: asSubagents(ctx),
        onSpawnedAgent: (agent, id) => {
          if (agent && typeof agent === 'object') callerIds.set(agent, id)
        },
      })
    },
  }))
}
