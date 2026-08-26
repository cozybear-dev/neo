export class ScopeDeniedError extends Error {
    result;
    constructor(target, result) {
        super(`target not in scope (${target}): ${result.reason}`);
        this.name = 'ScopeDeniedError';
        this.result = result;
    }
}
export function controlUrl(env = process.env) {
    return (env.CONTROL_URL ?? 'http://control:8090').replace(/\/+$/, '');
}
export function resolveTaskId(arg, env = process.env) {
    const value = arg ?? env.NEO_TASK_ID;
    return value && value.trim() ? value.trim() : undefined;
}
async function readJson(fetchImpl, url, init) {
    const res = await fetchImpl(url, init);
    const text = await res.text();
    if (!text)
        return { status: res.status, body: null };
    try {
        return { status: res.status, body: JSON.parse(text) };
    }
    catch {
        return { status: res.status, body: { error: text } };
    }
}
function asScopeResult(body) {
    const obj = body && typeof body === 'object' ? body : {};
    return {
        allowed: obj.allowed === true,
        matched: typeof obj.matched === 'string' ? obj.matched : '',
        reason: typeof obj.reason === 'string' ? obj.reason : 'unknown scope result',
    };
}
async function checkOne(target, extraHosts, opts) {
    const env = opts.env ?? process.env;
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const taskId = resolveTaskId(opts.taskId, env);
    const payload = { target };
    if (extraHosts && extraHosts.length > 0)
        payload.extra_hosts = extraHosts;
    if (taskId)
        payload.task_id = taskId;
    const { status, body } = await readJson(fetchImpl, `${controlUrl(env)}/scope/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: opts.signal,
    });
    if (status < 200 || status >= 300) {
        const err = body && typeof body === 'object' ? body.error : undefined;
        throw new Error(`scope check failed (${status}): ${typeof err === 'string' ? err : 'http error'}`);
    }
    return asScopeResult(body);
}
export async function checkScope(args, opts = {}) {
    const target = args.target.trim();
    if (!target) {
        throw new ScopeDeniedError(args.target, { allowed: false, matched: '', reason: 'empty target' });
    }
    const extra = (args.extra_hosts ?? []).map((h) => h.trim()).filter(Boolean);
    const merged = { ...opts, taskId: args.task_id ?? opts.taskId };
    const primary = await checkOne(target, extra.length ? extra : undefined, merged);
    if (!primary.allowed)
        throw new ScopeDeniedError(target, primary);
    for (const host of extra) {
        const result = await checkOne(host, undefined, merged);
        if (!result.allowed)
            throw new ScopeDeniedError(host, result);
    }
    return primary;
}
