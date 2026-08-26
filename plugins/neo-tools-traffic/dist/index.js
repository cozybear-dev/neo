import { defineTool } from '@deepseek-ai/dsh-tools';
import { renderSafe, replayTraffic, searchTraffic } from './client.js';
export const name = 'neo-tools-traffic';
export const inject = ['tools'];
const capturedRequest = {
    type: 'object',
    additionalProperties: true,
    properties: {
        id: { type: 'string', required: true },
        method: { type: 'string', required: true },
        url: { type: 'string', required: true },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        postData: { type: 'string' },
        status: { type: 'number' },
        timestamp: { type: 'string', required: true },
    },
};
export function apply(ctx) {
    ctx.tools.register(defineTool({
        name: 'traffic_search',
        description: 'Grep captured HTTP requests in /workspace/traffic/http.jsonl (method, URL, headers, body).',
        parameters: {
            query: { type: 'string', required: true, description: 'Case-insensitive substring over the JSONL records.' },
        },
        output: {
            schema: { type: 'array', items: capturedRequest },
            render: renderSafe,
        },
        async execute(args, exec) {
            return searchTraffic({ query: String(args.query ?? '') }, { signal: exec.signal });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'traffic_replay',
        description: 'Replay a captured request by id. Optional edits for method/headers/body/path. Destination host is pinned to the original (cannot change).',
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
                    headers: { type: 'object', additionalProperties: { type: 'string' } },
                    body: { type: 'string', required: true },
                },
            },
            render: renderSafe,
        },
        async execute(args, exec) {
            return replayTraffic({
                id: String(args.id ?? ''),
                edits: args.edits && typeof args.edits === 'object' && !Array.isArray(args.edits)
                    ? args.edits
                    : undefined,
            }, { signal: exec.signal });
        },
    }));
}
