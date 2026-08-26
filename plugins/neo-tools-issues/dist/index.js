import { defineTool } from '@deepseek-ai/dsh-tools';
import { createIssue, queryIssues, updateIssue } from './client.js';
export const name = 'neo-tools-issues';
export const inject = ['tools'];
function render(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value) }];
}
const issueObject = {
    type: 'object',
    additionalProperties: true,
    properties: {
        id: { type: 'string' },
        task_id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        title: { type: 'string' },
        severity: { type: 'string' },
        status: { type: 'string' },
        host: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        evidence_paths: { type: 'array', items: { type: 'string' } },
        reproduction: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        verdict: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    },
};
export function apply(ctx) {
    ctx.tools.register(defineTool({
        name: 'issue_create',
        description: 'File a finding. Thorough-mode tasks require verdict=confirmed; otherwise the tool returns {ok:false,error} without throwing.',
        parameters: {
            title: { type: 'string', required: true, description: 'Finding title.' },
            severity: { type: 'string', required: true, description: 'Severity (e.g. critical, high, medium, low, info).' },
            host: { type: 'string', description: 'Affected host.' },
            evidence_paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Workspace paths with proof artifacts.',
            },
            reproduction: { type: 'string', description: 'Reproduction steps.' },
            verdict: {
                type: 'string',
                required: true,
                description: 'Finding verdict. Thorough mode requires confirmed.',
            },
            task_id: { type: 'string', description: 'Task id; defaults to NEO_TASK_ID.' },
        },
        output: {
            schema: {
                oneOf: [
                    {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            ok: { type: 'boolean', required: true, const: true },
                            id: { type: 'string', required: true },
                        },
                    },
                    {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            ok: { type: 'boolean', required: true, const: false },
                            error: { type: 'string', required: true },
                        },
                    },
                ],
            },
            render,
        },
        async execute(args, exec) {
            return createIssue({
                title: String(args.title ?? ''),
                severity: String(args.severity ?? ''),
                host: typeof args.host === 'string' ? args.host : undefined,
                evidence_paths: Array.isArray(args.evidence_paths)
                    ? args.evidence_paths.map((p) => String(p))
                    : undefined,
                reproduction: typeof args.reproduction === 'string' ? args.reproduction : undefined,
                verdict: typeof args.verdict === 'string' ? args.verdict : undefined,
                task_id: typeof args.task_id === 'string' ? args.task_id : undefined,
            }, { signal: exec.signal });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'issue_query',
        description: 'List issues, optionally filtered by host, severity, or status.',
        parameters: {
            host: { type: 'string' },
            severity: { type: 'string' },
            status: { type: 'string' },
            task_id: { type: 'string', description: 'Task id; defaults to NEO_TASK_ID.' },
        },
        output: {
            schema: { type: 'array', items: issueObject },
            render,
        },
        async execute(args, exec) {
            return queryIssues({
                host: typeof args.host === 'string' ? args.host : undefined,
                severity: typeof args.severity === 'string' ? args.severity : undefined,
                status: typeof args.status === 'string' ? args.status : undefined,
                task_id: typeof args.task_id === 'string' ? args.task_id : undefined,
            }, { signal: exec.signal });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'issue_update',
        description: 'Update an issue status and optional comment.',
        parameters: {
            id: { type: 'string', required: true, description: 'Issue id.' },
            status: { type: 'string', required: true, description: 'New status.' },
            comment: { type: 'string', description: 'Optional comment (not rendered if it contains secrets).' },
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
            return updateIssue({
                id: String(args.id ?? ''),
                status: typeof args.status === 'string' ? args.status : undefined,
                comment: typeof args.comment === 'string' ? args.comment : undefined,
            }, { signal: exec.signal });
        },
    }));
}
