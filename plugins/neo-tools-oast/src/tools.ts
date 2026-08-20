import { pollOast, registerOast, renderSafe, type ClientOptions } from './client.ts'

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

const interactionSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    protocol: { type: 'string' as const, required: true },
    uniqueId: { type: 'string' as const, required: true },
    fullId: { type: 'string' as const, required: true },
    qType: { type: 'string' as const },
    rawRequest: { type: 'string' as const },
    rawResponse: { type: 'string' as const },
    smtpFrom: { type: 'string' as const },
    remoteAddress: { type: 'string' as const, required: true },
    timestamp: { type: 'string' as const, required: true },
  },
}

export function createTools(deps?: ClientOptions): ToolDef[] {
  const options = deps ?? {}
  return [
    {
      name: 'oast_register',
      description:
        'Register an Interactsh OAST callback URL (HTTP or DNS). Returns {id,url,domain}. Do not put secrets in payloads.',
      parameters: {
        kind: {
          type: 'string',
          required: true,
          enum: ['http', 'dns'],
          description: 'Callback kind: http returns an http:// URL; dns returns a hostname.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            url: { type: 'string', required: true },
            domain: { type: 'string', required: true },
          },
        },
        render: renderSafe,
      },
      async execute(args, exec) {
        const kind = args.kind === 'dns' ? 'dns' : 'http'
        return registerOast({ kind }, { ...options, signal: exec.signal })
      },
    },
    {
      name: 'oast_poll',
      description: 'Poll an OAST registration for out-of-band interactions. Optional wait_seconds retries until hit or timeout.',
      parameters: {
        id: { type: 'string', required: true, description: 'Id returned by oast_register.' },
        wait_seconds: { type: 'number', description: 'Seconds to wait for an interaction (default 0 = single poll).' },
      },
      output: {
        schema: { type: 'array', items: interactionSchema },
        render: renderSafe,
      },
      async execute(args, exec) {
        return pollOast(
          {
            id: String(args.id ?? ''),
            wait_seconds: typeof args.wait_seconds === 'number' ? args.wait_seconds : undefined,
          },
          { ...options, signal: exec.signal },
        )
      },
    },
  ]
}
