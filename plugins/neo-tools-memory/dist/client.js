export function controlUrl(env = process.env) {
    return (env.CONTROL_URL ?? 'http://control:8090').replace(/\/+$/, '');
}
export function resolveTaskId(arg, env = process.env) {
    const value = arg ?? env.NEO_TASK_ID;
    if (!value || !value.trim()) {
        throw new Error('task_id is required (set NEO_TASK_ID or pass task_id)');
    }
    return value.trim();
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
function asMemory(body) {
    const obj = body && typeof body === 'object' ? body : {};
    return {
        insights: Array.isArray(obj.insights) ? obj.insights : [],
        facts: Array.isArray(obj.facts) ? obj.facts : [],
        todos: Array.isArray(obj.todos) ? obj.todos : [],
        files: Array.isArray(obj.files) ? obj.files : [],
    };
}
export async function getMemory(args = {}, opts = {}) {
    const env = opts.env ?? process.env;
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const id = resolveTaskId(args.task_id ?? opts.taskId, env);
    const { status, body } = await readJson(fetchImpl, `${controlUrl(env)}/tasks/${id}/memory`, {
        method: 'GET',
        signal: opts.signal,
    });
    if (status < 200 || status >= 300) {
        const err = body && typeof body === 'object' ? body.error : undefined;
        throw new Error(`memory_get failed (${status}): ${typeof err === 'string' ? err : 'http error'}`);
    }
    return asMemory(body);
}
export async function updateMemory(args, opts = {}) {
    const env = opts.env ?? process.env;
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const id = resolveTaskId(args.task_id ?? opts.taskId, env);
    const payload = {};
    if (Array.isArray(args.insights))
        payload.insights = args.insights;
    if (Array.isArray(args.facts))
        payload.facts = args.facts;
    if (Array.isArray(args.todos))
        payload.todos = args.todos;
    if (Array.isArray(args.files))
        payload.files = args.files;
    const { status, body } = await readJson(fetchImpl, `${controlUrl(env)}/tasks/${id}/memory`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: opts.signal,
    });
    if (status < 200 || status >= 300) {
        const err = body && typeof body === 'object' ? body.error : undefined;
        throw new Error(`memory_update failed (${status}): ${typeof err === 'string' ? err : 'http error'}`);
    }
    return { ok: true };
}
