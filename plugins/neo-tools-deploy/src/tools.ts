import { deployDown, deployUp, renderSafe, type ClientOptions } from './client.ts'

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

export function createTools(deps?: ClientOptions): ToolDef[] {
  const options = deps ?? {}
  return [
    {
      name: 'deploy_up',
      description:
        'Bring up an authorized lab stack on the isolated targets network only. ' +
        'Project name is neo-target-<id>. Refuses any network other than targets (e.g. control, bridge). ' +
        'Returns {id,project,network,baseUrl,logPath}.',
      parameters: {
        source: {
          type: 'string',
          required: true,
          enum: ['git', 'image', 'compose'],
          description: 'git clone + compose, single image run, or compose file path.',
        },
        ref: {
          type: 'string',
          required: true,
          description: 'Git URL, image reference, or path to a compose YAML file.',
        },
        network: {
          type: 'string',
          description: 'Docker/compose network (default targets). Hard-fails unless targets.',
        },
        id: {
          type: 'string',
          description: 'Optional deploy id (default random hex). Project = neo-target-<id>.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            project: { type: 'string', required: true },
            network: { type: 'string', required: true },
            baseUrl: { type: 'string', required: true },
            logPath: { type: 'string', required: true },
          },
        },
        render: renderSafe,
      },
      async execute(args, exec) {
        return deployUp(
          {
            source: args.source as 'git' | 'image' | 'compose',
            ref: String(args.ref ?? ''),
            network: typeof args.network === 'string' ? args.network : undefined,
            id: typeof args.id === 'string' ? args.id : undefined,
          },
          { ...options, signal: exec.signal },
        )
      },
    },
    {
      name: 'deploy_down',
      description:
        'Tear down a lab stack started by deploy_up (docker compose -p neo-target-<id> down).',
      parameters: {
        id: { type: 'string', required: true, description: 'Deploy id returned by deploy_up.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            project: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
          },
        },
        render: renderSafe,
      },
      async execute(args, exec) {
        return deployDown(
          { id: String(args.id ?? '') },
          { ...options, signal: exec.signal },
        )
      },
    },
  ]
}
