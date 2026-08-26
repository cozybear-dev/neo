import { defineTool } from '@deepseek-ai/dsh-tools';
import { checkScope } from './client.js';
export const name = 'neo-tools-scope';
export const inject = ['tools'];
function render(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value) }];
}
export function apply(ctx) {
    ctx.tools.register(defineTool({
        name: 'scope_check',
        description: 'Check whether a target host (and optional extra hosts) is in the authorized allowlist. Throws if out of scope.',
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
            return checkScope({
                target: String(args.target ?? ''),
                extra_hosts: Array.isArray(args.extra_hosts)
                    ? args.extra_hosts.map((h) => String(h))
                    : undefined,
                task_id: typeof args.task_id === 'string' ? args.task_id : undefined,
            }, { signal: exec.signal });
        },
    }));
}
