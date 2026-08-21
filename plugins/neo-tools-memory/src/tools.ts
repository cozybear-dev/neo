import { getMemory, updateMemory, updateTask, type ClientOptions } from './client.ts'

export type ToolDef = {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: unknown
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  execute: (
    args: Record<string, unknown>,
    exec: { signal?: AbortSignal; agent?: unknown },
  ) => unknown | Promise<unknown>
}

function render(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function agentOpt(exec: { agent?: unknown }): { id?: string } | undefined {
  const agent = exec.agent
  if (agent && typeof agent === 'object' && 'id' in agent) {
    const id = (agent as { id?: unknown }).id
    if (typeof id === 'string') return { id }
  }
  return undefined
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
      name: 'memory_get',
      description: 'Read shared task working memory (insights, facts, todos, tracked files).',
      parameters: {
        task_id: { type: 'string', description: 'Task id; defaults to NEO_TASK_ID or session UUID.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
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
          { task_id: typeof args.task_id === 'string' ? args.task_id : undefined },
          { ...options, signal: exec.signal, agent: agentOpt(exec) },
        )
      },
    },
    {
      name: 'memory_update',
      description:
        'Update shared task working memory. Only provided keys are replaced; omitted keys are kept.',
      parameters: {
        insights: jsonArray,
        facts: jsonArray,
        todos: jsonArray,
        files: jsonArray,
        task_id: { type: 'string', description: 'Task id; defaults to NEO_TASK_ID or session UUID.' },
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
            task_id: typeof args.task_id === 'string' ? args.task_id : undefined,
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
        'Update the current task allowlist/denylist (and optional status/objective) after the user confirms scope.',
      parameters: {
        allowlist: { ...stringArray, description: 'Replace task allowlist (e.g. apex + *.domain).' },
        denylist: { ...stringArray, description: 'Replace task denylist.' },
        status: { type: 'string', description: 'Optional task status.' },
        objective: { type: 'string', description: 'Optional task objective.' },
        task_id: { type: 'string', description: 'Task id; defaults to NEO_TASK_ID or session UUID.' },
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
            task_id: typeof args.task_id === 'string' ? args.task_id : undefined,
            allowlist: Array.isArray(args.allowlist)
              ? args.allowlist.map((h) => String(h))
              : undefined,
            denylist: Array.isArray(args.denylist)
              ? args.denylist.map((h) => String(h))
              : undefined,
            status: typeof args.status === 'string' ? args.status : undefined,
            objective: typeof args.objective === 'string' ? args.objective : undefined,
          },
          { ...options, signal: exec.signal, agent: agentOpt(exec) },
        )
      },
    },
  ]
}
