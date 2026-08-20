import { getMemory, updateMemory, type ClientOptions } from './client.ts'

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

const jsonArray = {
  type: 'array' as const,
  items: {
    oneOf: [
      { type: 'string' as const },
      { type: 'object' as const, additionalProperties: true },
    ],
  },
}

export function createTools(deps?: ClientOptions): ToolDef[] {
  const options = deps ?? {}
  return [
    {
      name: 'memory_get',
      description: 'Read shared task working memory (insights, facts, todos, tracked files).',
      parameters: {
        task_id: { type: 'string', description: 'Task id; defaults to NEO_TASK_ID.' },
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
          { ...options, signal: exec.signal },
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
        task_id: { type: 'string', description: 'Task id; defaults to NEO_TASK_ID.' },
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
          { ...options, signal: exec.signal },
        )
      },
    },
  ]
}
