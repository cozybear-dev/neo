import { defineTool } from '@deepseek-ai/dsh-tools';
import { pollOast, registerOast, renderSafe } from './client.js';
export const name = 'neo-tools-oast';
export const inject = ['tools'];
const interactionSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        protocol: { type: 'string', required: true },
        uniqueId: { type: 'string', required: true },
        fullId: { type: 'string', required: true },
        qType: { type: 'string' },
        rawRequest: { type: 'string' },
        rawResponse: { type: 'string' },
        smtpFrom: { type: 'string' },
        remoteAddress: { type: 'string', required: true },
        timestamp: { type: 'string', required: true },
    },
};
export function apply(ctx) {
    ctx.tools.register(defineTool({
        name: 'oast_register',
        description: 'Register an Interactsh OAST callback URL (HTTP or DNS). Returns {id,url,domain}. Do not put secrets in payloads.',
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
            const kind = args.kind === 'dns' ? 'dns' : 'http';
            return registerOast({ kind }, { signal: exec.signal });
        },
    }));
    ctx.tools.register(defineTool({
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
            return pollOast({
                id: String(args.id ?? ''),
                wait_seconds: typeof args.wait_seconds === 'number' ? args.wait_seconds : undefined,
            }, { signal: exec.signal });
        },
    }));
}
