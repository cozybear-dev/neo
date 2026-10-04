import {
  browserAct,
  browserEval,
  browserNavigate,
  browserNetwork,
  browserScreenshot,
  renderSafe,
  type AgentRef,
  type ClientOptions,
} from './client.ts'

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

const capturedRequest = {
  type: 'object' as const,
  additionalProperties: true,
  properties: {
    id: { type: 'string' as const },
    method: { type: 'string' as const },
    url: { type: 'string' as const },
    headers: { type: 'object' as const, additionalProperties: true },
    postData: { type: 'string' as const },
    status: { type: 'number' as const },
    timestamp: { type: 'string' as const },
  },
}

function agentOpt(exec: { agent?: unknown }): AgentRef | undefined {
  const agent = exec.agent
  if (!agent || typeof agent !== 'object') return undefined
  return agent as AgentRef
}

export function createTools(deps?: ClientOptions): ToolDef[] {
  const options = deps ?? {}
  return [
    {
      name: 'browser_navigate',
      description:
        'Navigate an isolated task browser page. Every network request is authorized and mediated by the broker.',
      parameters: {
        url: {
          type: 'string',
          required: true,
          description: 'Absolute URL to open.',
        },
        wait: {
          type: 'string',
          description:
            'Navigation lifecycle: load (default), domcontentloaded, or commit.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string', required: true },
            title: { type: 'string' },
          },
        },
        render: renderSafe,
      },
      async execute(args, exec) {
        return browserNavigate(
          {
            url: String(args.url ?? ''),
            wait: typeof args.wait === 'string' ? args.wait : undefined,
          },
          { ...options, signal: exec.signal, agent: agentOpt(exec) },
        )
      },
    },
    {
      name: 'browser_act',
      description:
        'Click, type, or select in the current page. Provide a CSS selector; instruction is a human-readable note of intent.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['click', 'type', 'select'],
          description: 'DOM action.',
        },
        selector: {
          type: 'string',
          description: 'CSS selector for the target element.',
        },
        text: {
          type: 'string',
          description: 'Text to type or option value to select.',
        },
        instruction: {
          type: 'string',
          required: true,
          description: 'What this action is trying to do.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean', required: true, const: true } },
        },
        render: renderSafe,
      },
      async execute(args, exec) {
        const action =
          args.action === 'type' ||
          args.action === 'select' ||
          args.action === 'click'
            ? args.action
            : 'click'
        return browserAct(
          {
            action,
            selector:
              typeof args.selector === 'string' ? args.selector : undefined,
            text: typeof args.text === 'string' ? args.text : undefined,
            instruction: String(args.instruction ?? ''),
          },
          { ...options, signal: exec.signal, agent: agentOpt(exec) },
        )
      },
    },
    {
      name: 'browser_eval',
      description:
        'Evaluate a JavaScript expression in the current page and return the JSON-serializable result.',
      parameters: {
        expression: {
          type: 'string',
          required: true,
          description: 'JavaScript expression.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { result: { type: 'json' } },
        },
        render: renderSafe,
      },
      async execute(args, exec) {
        return browserEval(
          { expression: String(args.expression ?? '') },
          { ...options, signal: exec.signal, agent: agentOpt(exec) },
        )
      },
    },
    {
      name: 'browser_screenshot',
      description:
        'Capture a PNG screenshot via CDP and write it to the task-owned browser directory.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { path: { type: 'string', required: true } },
        },
        render: renderSafe,
      },
      async execute(_args, exec) {
        return browserScreenshot({
          ...options,
          signal: exec.signal,
          agent: agentOpt(exec),
        })
      },
    },
    {
      name: 'browser_network',
      description:
        'Return HTTP requests captured from the current browser session (also appended to task-owned traffic JSONL).',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            requests: { type: 'array', required: true, items: capturedRequest },
          },
        },
        render: renderSafe,
      },
      async execute(_args, exec) {
        return browserNetwork({
          ...options,
          signal: exec.signal,
          agent: agentOpt(exec),
        })
      },
    },
  ]
}
