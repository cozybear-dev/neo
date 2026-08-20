import { checkScope, type ClientOptions } from './client.ts'

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

export function createTools(deps?: ClientOptions): ToolDef[] {
  const options = deps ?? {}
  return [{
    name: 'scope_check',
    description:
      'Check whether a target host (and optional extra hosts) is in the authorized allowlist. Throws if out of scope.',
    parameters: {
      target: { type: 'string', required: true, description: 'Hostname or URL to authorize.' },
      extra_hosts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional hosts that must also be in scope (e.g. Host header aliases).',
      },
      task_id: { type: 'string', description: 'Task id; defaults to NEO_TASK_ID.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowed: { type: 'boolean', required: true },
          matched: { type: 'string', required: true },
          reason: { type: 'string', required: true },
        },
      },
      render,
    },
    async execute(args, exec) {
      return checkScope(
        {
          target: String(args.target ?? ''),
          extra_hosts: Array.isArray(args.extra_hosts)
            ? args.extra_hosts.map((h) => String(h))
            : undefined,
          task_id: typeof args.task_id === 'string' ? args.task_id : undefined,
        },
        { ...options, signal: exec.signal },
      )
    },
  }]
}
