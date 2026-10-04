import { execInSandbox, renderSafe, type ClientOptions } from './client.ts'

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

export function createTools(deps?: ClientOptions): ToolDef[] {
  const options = deps ?? {}
  return [
    {
      name: 'sandbox_exec',
      description:
        'Run a task-authorized command in a disposable unprivileged worker. Task files synchronize with /workspace; external network is unavailable. Configured lab mode reaches only task-owned lab services. No caller environment or credentials are passed.',
      parameters: {
        command: {
          type: 'string',
          required: true,
          description: 'Shell command passed to bash -lc.',
        },
        cwd: {
          type: 'string',
          description:
            'Working directory inside the sandbox (default /workspace).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stdout: { type: 'string', required: true },
            stderr: { type: 'string', required: true },
            exitCode: { type: 'number', required: true },
            artifactRef: { type: 'string' },
            truncated: { type: 'boolean' },
          },
        },
        render: renderSafe,
      },
      async execute(args, exec) {
        return execInSandbox(
          {
            command: String(args.command ?? ''),
            cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
          },
          { ...options, signal: exec.signal },
        )
      },
    },
  ]
}
