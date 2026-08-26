import { defineTool } from '@deepseek-ai/dsh-tools';
import { browserAct, browserEval, browserNavigate, browserNetwork, browserScreenshot, renderSafe, } from './client.js';
export const name = 'neo-tools-browser';
export const inject = ['tools'];
const capturedRequest = {
    type: 'object',
    additionalProperties: true,
    properties: {
        id: { type: 'string' },
        method: { type: 'string' },
        url: { type: 'string' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        postData: { type: 'string' },
        status: { type: 'number' },
        timestamp: { type: 'string' },
    },
};
export function apply(ctx) {
    ctx.tools.register(defineTool({
        name: 'browser_navigate',
        description: 'Navigate the shared CDP browser (http://browser:9222) to a URL. Calls Control /scope/check first; throws if out of scope.',
        parameters: {
            url: { type: 'string', required: true, description: 'Absolute URL to open.' },
            wait: {
                type: 'string',
                description: 'Playwright waitUntil: load (default), domcontentloaded, networkidle, commit.',
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
            return browserNavigate({
                url: String(args.url ?? ''),
                wait: typeof args.wait === 'string' ? args.wait : undefined,
            }, { signal: exec.signal });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_act',
        description: 'Click, type, or select in the current page. Provide a CSS selector; instruction is a human-readable note of intent.',
        parameters: {
            action: {
                type: 'string',
                required: true,
                enum: ['click', 'type', 'select'],
                description: 'DOM action.',
            },
            selector: { type: 'string', description: 'CSS selector for the target element.' },
            text: { type: 'string', description: 'Text to type or option value to select.' },
            instruction: { type: 'string', required: true, description: 'What this action is trying to do.' },
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
            const action = args.action === 'type' || args.action === 'select' || args.action === 'click'
                ? args.action
                : 'click';
            return browserAct({
                action,
                selector: typeof args.selector === 'string' ? args.selector : undefined,
                text: typeof args.text === 'string' ? args.text : undefined,
                instruction: String(args.instruction ?? ''),
            }, { signal: exec.signal });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_eval',
        description: 'Evaluate a JavaScript expression in the current page and return the JSON-serializable result.',
        parameters: {
            expression: { type: 'string', required: true, description: 'JavaScript expression.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: { result: {} },
            },
            render: renderSafe,
        },
        async execute(args, exec) {
            return browserEval({ expression: String(args.expression ?? '') }, { signal: exec.signal });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_screenshot',
        description: 'Capture a PNG screenshot via CDP and write it to /workspace/browser/.',
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
            return browserScreenshot({ signal: exec.signal });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_network',
        description: 'Return HTTP requests captured from the current browser session (also appended to /workspace/traffic/http.jsonl).',
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
            return browserNetwork({ signal: exec.signal });
        },
    }));
}
