import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
export const DEFAULT_TRAFFIC_PATH = '/workspace/traffic/http.jsonl';
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
    'content-length',
]);
export function redactSecrets(value) {
    const secretKey = /token|secret|authorization|api[_-]?key|private|password|passwd|cookie/i;
    const walk = (input) => {
        if (Array.isArray(input))
            return input.map(walk);
        if (input && typeof input === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(input)) {
                out[k] = secretKey.test(k) ? '[redacted]' : walk(v);
            }
            return out;
        }
        return input;
    };
    return walk(value);
}
export function renderSafe(_args, value) {
    return [{ type: 'text', text: JSON.stringify(redactSecrets(value)) }];
}
function throwIfAborted(signal) {
    if (signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
    }
}
export function trafficPath(opts = {}) {
    const env = opts.env ?? process.env;
    return opts.trafficPath ?? env.TRAFFIC_LOG ?? DEFAULT_TRAFFIC_PATH;
}
function nodeFs() {
    return {
        mkdir,
        writeFile,
        readFile: (path, enc) => readFile(path, (enc ?? 'utf8')),
        appendFile,
    };
}
function dirOf(filePath) {
    const i = filePath.lastIndexOf('/');
    return i <= 0 ? '.' : filePath.slice(0, i);
}
export async function appendTraffic(rec, opts = {}) {
    const fs = opts.fs ?? nodeFs();
    const path = trafficPath(opts);
    await fs.mkdir(dirOf(path), { recursive: true });
    await fs.appendFile(path, `${JSON.stringify(rec)}\n`);
}
export async function readTraffic(opts = {}) {
    const fs = opts.fs ?? nodeFs();
    const path = trafficPath(opts);
    let text = '';
    try {
        text = await fs.readFile(path, 'utf8');
    }
    catch (err) {
        const code = err.code;
        if (code === 'ENOENT')
            return [];
        throw err;
    }
    const out = [];
    for (const line of text.split('\n')) {
        if (!line.trim())
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch {
            // skip malformed lines
        }
    }
    return out;
}
export async function searchTraffic(args, opts = {}) {
    throwIfAborted(opts.signal);
    const query = args.query.toLowerCase();
    const rows = await readTraffic(opts);
    if (!query)
        return rows;
    return rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query));
}
export function assertSameDestination(originalUrl, nextUrl) {
    let original;
    let next;
    try {
        original = new URL(originalUrl);
        next = new URL(nextUrl, originalUrl);
    }
    catch {
        throw new Error('invalid url');
    }
    if (original.protocol !== next.protocol || original.host !== next.host) {
        throw new Error('destination host must stay the original');
    }
}
function headerMap(headers) {
    const out = {};
    if (!headers || typeof headers !== 'object')
        return out;
    if ('forEach' in headers && typeof headers.forEach === 'function') {
        ;
        headers.forEach((value, key) => {
            out[key] = value;
        });
        return out;
    }
    for (const [k, v] of Object.entries(headers)) {
        if (typeof v === 'string')
            out[k] = v;
    }
    return out;
}
function stripHopByHop(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        if (HOP_BY_HOP.has(k.toLowerCase()))
            continue;
        out[k] = v;
    }
    return out;
}
export async function replayTraffic(args, opts = {}) {
    throwIfAborted(opts.signal);
    const id = args.id.trim();
    if (!id)
        throw new Error('id is required');
    const rows = await readTraffic(opts);
    const rec = rows.find((r) => r.id === id);
    if (!rec)
        throw new Error(`request not found: ${id}`);
    const edits = args.edits ?? {};
    if (edits.host !== undefined) {
        throw new Error('destination host must stay the original');
    }
    let url = rec.url;
    if (typeof edits.url === 'string') {
        assertSameDestination(rec.url, edits.url);
        url = edits.url;
    }
    let method = rec.method;
    if (typeof edits.method === 'string' && edits.method.trim())
        method = edits.method.trim();
    let headers = { ...rec.headers };
    if (edits.headers && typeof edits.headers === 'object' && !Array.isArray(edits.headers)) {
        for (const [k, v] of Object.entries(edits.headers)) {
            if (typeof v === 'string')
                headers[k] = v;
        }
    }
    let body = rec.postData;
    if (Object.prototype.hasOwnProperty.call(edits, 'body')) {
        const b = edits.body;
        if (b === null || b === undefined)
            body = undefined;
        else if (typeof b === 'string')
            body = b;
        else
            body = JSON.stringify(b);
    }
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const res = await fetchImpl(url, {
        method,
        headers: stripHopByHop(headers),
        body: method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD' ? undefined : body,
        signal: opts.signal,
    });
    const text = await res.text();
    return {
        status: res.status,
        headers: headerMap(res.headers),
        body: text,
    };
}
