import { renderSafe, replayTraffic, searchTraffic, type ClientOptions } from './client.ts'

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

const capturedRequest = {
  type: 'object' as const,
  additionalProperties: true,
  properties: {
    id: { type: 'string' as const, required: true },
    method: { type: 'string' as const, required: true },
    url: { type: 'string' as const, required: true },
    headers: { type: 'object' as const, additionalProperties: true },
    postData: { type: 'string' as const },
    status: { type: 'number' as const },
    timestamp: { type: 'string' as const, required: true },
  },
}

export function createTools(deps?: ClientOptions): ToolDef[] {
  const options = deps ?? {}
  return [
    {
      name: 'traffic_search',
      description:
        'Grep captured HTTP requests in /workspace/traffic/http.jsonl (method, URL, headers, body).',
      parameters: {
        query: { type: 'string', required: true, description: 'Case-insensitive substring over the JSONL records.' },
      },
      output: {
        schema: { type: 'array', items: capturedRequest },
        render: renderSafe,
      },
      async execute(args, exec) {
        return searchTraffic(
          { query: String(args.query ?? '') },
          { ...options, signal: exec.signal },
        )
      },
    },
    {
      name: 'traffic_replay',
      description:
        'Replay a captured request by id. Optional edits for method/headers/body/path. Destination host is pinned to the original (cannot change).',
      parameters: {
        id: { type: 'string', required: true, description: 'Captured request id.' },
        edits: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional method, headers, body, or url (same host only).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'number', required: true },
            headers: { type: 'object', additionalProperties: true },
            body: { type: 'string', required: true },
          },
        },
        render: renderSafe,
      },
      async execute(args, exec) {
        return replayTraffic(
          {
            id: String(args.id ?? ''),
            edits: args.edits && typeof args.edits === 'object' && !Array.isArray(args.edits)
              ? args.edits as Record<string, unknown>
              : undefined,
          },
          { ...options, signal: exec.signal },
        )
      },
    },
  ]
}
