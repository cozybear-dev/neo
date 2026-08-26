import { defineTool } from '@deepseek-ai/dsh-tools';
import { execInSandbox, renderSafe } from './client.js';
export const name = 'neo-sandbox-docker';
export const inject = ['tools'];
// Pin 141eb6f ctx.subprocess / ctx.fs need SubprocessRuntime (PTY, mux collect,
// resolveExecutable, tree terminate) and FileSystem policy events. Those seams
// are not swapped: built-in bash/fs stay local to dsh. sandbox_exec docker-execs
// into SANDBOX_CONTAINER (default neo-sandbox-1). Shared /workspace is the file bus.
export function apply(ctx) {
    ctx.tools.register(defineTool({
        name: 'sandbox_exec',
        description: 'Run a shell command inside the sandbox container via docker exec. cwd is /workspace unless overridden. Does not replace DSH built-in bash; use this for sandbox toolchain binaries (nuclei, nmap, …). Never echo secrets.',
        parameters: {
            command: { type: 'string', required: true, description: 'Shell command passed to bash -lc.' },
            cwd: { type: 'string', description: 'Working directory inside the sandbox (default /workspace).' },
            env: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'Extra environment variables for the exec. Values are not rendered.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    stdout: { type: 'string', required: true },
                    stderr: { type: 'string', required: true },
                    exitCode: { type: 'number', required: true },
                },
            },
            render: renderSafe,
        },
        async execute(args, exec) {
            const envArg = args.env && typeof args.env === 'object' && !Array.isArray(args.env)
                ? Object.fromEntries(Object.entries(args.env)
                    .filter(([, v]) => typeof v === 'string')
                    .map(([k, v]) => [k, v]))
                : undefined;
            return execInSandbox({
                command: String(args.command ?? ''),
                cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
                env: envArg,
            }, { signal: exec.signal });
        },
    }));
}
