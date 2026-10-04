import { renderSafe } from '../../neo-runtime/redact.mjs'
import {
  getTask,
  getMemory,
  updateMemory,
  updateTask,
  type ClientOptions,
} from './client.ts'
import { type AgentRef } from './task.ts'

export type ToolDef = {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: unknown
    render: (
      args: unknown,
      value: unknown,
    ) => Array<{ type: 'text'; text: string }>
  }
  execute: (
    args: Record<string, unknown>,
    exec: { signal?: AbortSignal; agent?: unknown },
  ) => unknown | Promise<unknown>
}

function render(
  _args: unknown,
  value: unknown,
): Array<{ type: 'text'; text: string }> {
  return renderSafe(_args, value)
}

function agentOpt(exec: { agent?: unknown }): AgentRef | undefined {
  const agent = exec.agent
  if (!agent || typeof agent !== 'object') return undefined
  return agent as AgentRef
}

const jsonArray = {
  type: 'array' as const,
  items: {
    oneOf: [
      { type: 'string' as const },
      { type: 'object' as const, additionalProperties: true },
    ],
  },
}

const stringArray = {
  type: 'array' as const,
  items: { type: 'string' as const },
}

export function createTools(deps?: ClientOptions): ToolDef[] {
  const options = deps ?? {}
  return [
    {
      name: 'task_get',
      description:
        'Inspect this task, its current revision and plan_revision, mode, scope, status, plan, and run outcomes. Read before plan_submit or task_update.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render,
      },
      async execute(_args, exec) {
        return getTask({
          ...options,
          signal: exec.signal,
          agent: agentOpt(exec),
        })
      },
    },
    {
      name: 'memory_get',
      description:
        'Read shared task working memory (insights, facts, todos, tracked files).',
      parameters: {
        task_id: {
          type: 'string',
          description: 'Task id; defaults to authorized NEO_TASK_ID.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            revision: { type: 'number', required: true },
            insights: { ...jsonArray, required: true },
            facts: { ...jsonArray, required: true },
            todos: { ...jsonArray, required: true },
            files: { ...jsonArray, required: true },
          },
        },
        render,
      },
      async execute(args, exec) {
        return getMemory(
          {
            task_id:
              typeof args.task_id === 'string' ? args.task_id : undefined,
          },
          { ...options, signal: exec.signal, agent: agentOpt(exec) },
        )
      },
    },
    {
      name: 'memory_update',
      description:
        'Update shared task working memory. Only provided keys are replaced; omitted keys are kept.',
      parameters: {
        revision: {
          type: 'number',
          required: true,
          description: 'Revision from memory_get; stale writes reject.',
        },
        insights: jsonArray,
        facts: jsonArray,
        todos: jsonArray,
        files: jsonArray,
        task_id: {
          type: 'string',
          description: 'Task id; defaults to authorized NEO_TASK_ID.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true, const: true },
          },
        },
        render,
      },
      async execute(args, exec) {
        return updateMemory(
          {
            task_id:
              typeof args.task_id === 'string' ? args.task_id : undefined,
            revision: Number(args.revision),
            insights: Array.isArray(args.insights) ? args.insights : undefined,
            facts: Array.isArray(args.facts) ? args.facts : undefined,
            todos: Array.isArray(args.todos) ? args.todos : undefined,
            files: Array.isArray(args.files) ? args.files : undefined,
          },
          { ...options, signal: exec.signal, agent: agentOpt(exec) },
        )
      },
    },
    {
      name: 'task_update',
      description:
        'Update task status or objective. Scope and mode authorization use the operator API.',
      parameters: {
        revision: {
          type: 'number',
          description: 'Expected current task revision.',
        },
        status: { type: 'string', description: 'Optional task status.' },
        objective: { type: 'string', description: 'Optional task objective.' },
        task_id: {
          type: 'string',
          description: 'Task id; defaults to authorized NEO_TASK_ID.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true, const: true },
          },
        },
        render,
      },
      async execute(args, exec) {
        return updateTask(
          {
            task_id:
              typeof args.task_id === 'string' ? args.task_id : undefined,
            mode:
              args.mode === 'fast' || args.mode === 'thorough'
                ? args.mode
                : undefined,
            revision:
              typeof args.revision === 'number' ? args.revision : undefined,
            status: typeof args.status === 'string' ? args.status : undefined,
            objective:
              typeof args.objective === 'string' ? args.objective : undefined,
          },
          { ...options, signal: exec.signal, agent: agentOpt(exec) },
        )
      },
    },
  ]
}
