import { defineTool } from '@deepseek-ai/dsh-tools';
import { getMemory, updateMemory } from './client.js';
export const name = 'neo-tools-memory';
export const inject = ['tools'];
function render(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value) }];
}
const jsonArray = {
    type: 'array',
    items: {
        oneOf: [
            { type: 'string' },
            { type: 'object', additionalProperties: true },
        ],
    },
};
export function apply(ctx) {
    ctx.tools.register(defineTool({
        name: 'memory_get',
        description: 'Read shared task working memory (insights, facts, todos, tracked files).',
        parameters: {
            task_id: { type: 'string', description: 'Task id; defaults to NEO_TASK_ID.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    insights: { ...jsonArray, required: true },
                    facts: { ...jsonArray, required: true },
                    todos: { ...jsonArray, required: true },
                    files: { ...jsonArray, required: true },
                },
            },
            render,
        },
        async execute(args, exec) {
            return getMemory({ task_id: typeof args.task_id === 'string' ? args.task_id : undefined }, { signal: exec.signal });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'memory_update',
        description: 'Update shared task working memory. Only provided keys are replaced; omitted keys are kept.',
        parameters: {
            insights: jsonArray,
            facts: jsonArray,
            todos: jsonArray,
            files: jsonArray,
            task_id: { type: 'string', description: 'Task id; defaults to NEO_TASK_ID.' },
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
            return updateMemory({
                task_id: typeof args.task_id === 'string' ? args.task_id : undefined,
                insights: Array.isArray(args.insights) ? args.insights : undefined,
                facts: Array.isArray(args.facts) ? args.facts : undefined,
                todos: Array.isArray(args.todos) ? args.todos : undefined,
                files: Array.isArray(args.files) ? args.files : undefined,
            }, { signal: exec.signal });
        },
    }));
}
