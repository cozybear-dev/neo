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
function errorMessage(body, fallback) {
    if (body && typeof body === 'object' && typeof body.error === 'string') {
        return body.error;
    }
    return fallback;
}
export async function createIssue(args, opts = {}) {
    const env = opts.env ?? process.env;
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const taskId = resolveTaskId(args.task_id ?? opts.taskId, env);
    const payload = {
        title: args.title,
        severity: args.severity,
    };
    if (taskId)
        payload.task_id = taskId;
    if (args.host !== undefined)
        payload.host = args.host;
    if (args.evidence_paths !== undefined)
        payload.evidence_paths = args.evidence_paths;
    if (args.reproduction !== undefined)
        payload.reproduction = args.reproduction;
    if (args.verdict !== undefined)
        payload.verdict = args.verdict;
    const { status, body } = await readJson(fetchImpl, `${controlUrl(env)}/issues`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: opts.signal,
    });
    // Domain-level rejection (e.g. thorough without verdict=confirmed) is a
    // successful tool outcome, not an infrastructure failure.
    if (status >= 400 && status < 500) {
        return { ok: false, error: errorMessage(body, `issue_create rejected (${status})`) };
    }
    if (status < 200 || status >= 300) {
        throw new Error(`issue_create failed (${status}): ${errorMessage(body, 'http error')}`);
    }
    const id = body && typeof body === 'object' ? body.id : undefined;
    if (typeof id !== 'string' || !id) {
        return { ok: false, error: 'issue_create succeeded without an id' };
    }
    return { ok: true, id };
}
export async function queryIssues(args = {}, opts = {}) {
    const env = opts.env ?? process.env;
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const taskId = resolveTaskId(args.task_id ?? opts.taskId, env);
    const params = new URLSearchParams();
    if (args.host)
        params.set('host', args.host);
    if (args.severity)
        params.set('severity', args.severity);
    if (args.status)
        params.set('status', args.status);
    if (taskId)
        params.set('task_id', taskId);
    const qs = params.toString();
    const url = `${controlUrl(env)}/issues${qs ? `?${qs}` : ''}`;
    const { status, body } = await readJson(fetchImpl, url, { method: 'GET', signal: opts.signal });
    if (status < 200 || status >= 300) {
        throw new Error(`issue_query failed (${status}): ${errorMessage(body, 'http error')}`);
    }
    if (Array.isArray(body))
        return body;
    if (body && typeof body === 'object' && Array.isArray(body.issues)) {
        return body.issues;
    }
    return [];
}
export async function updateIssue(args, opts = {}) {
    const env = opts.env ?? process.env;
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const payload = {};
    if (args.status !== undefined)
        payload.status = args.status;
    if (args.comment !== undefined)
        payload.comment = args.comment;
    const { status, body } = await readJson(fetchImpl, `${controlUrl(env)}/issues/${args.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: opts.signal,
    });
    if (status >= 400 && status < 500) {
        throw new Error(errorMessage(body, `issue_update rejected (${status})`));
    }
    if (status < 200 || status >= 300) {
        throw new Error(`issue_update failed (${status}): ${errorMessage(body, 'http error')}`);
    }
    return { ok: true };
}
