import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
export const DEFAULT_CDP_URL = 'http://browser:9222';
export const DEFAULT_SCREENSHOT_DIR = '/workspace/browser';
export const DEFAULT_TRAFFIC_PATH = '/workspace/traffic/http.jsonl';
let cachedSession;
export function resetBrowserSession() {
    cachedSession = undefined;
}
export function cdpUrl(opts = {}) {
    const env = opts.env ?? process.env;
    return (opts.cdpUrl ?? env.BROWSER_CDP_URL ?? DEFAULT_CDP_URL).replace(/\/+$/, '');
}
export function rewriteCdpWebSocketUrl(wsUrl, httpEndpoint) {
    const http = new URL(httpEndpoint);
    const ws = new URL(wsUrl);
    ws.protocol = http.protocol === 'https:' ? 'wss:' : 'ws:';
    ws.host = http.host;
    return ws.toString();
}
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
function nodeFs() {
    return { mkdir, writeFile, appendFile };
}
function dirOf(filePath) {
    const i = filePath.lastIndexOf('/');
    return i <= 0 ? '.' : filePath.slice(0, i);
}
export async function appendTraffic(rec, opts = {}) {
    const fs = opts.fs ?? nodeFs();
    const path = opts.trafficPath ?? opts.env?.TRAFFIC_LOG ?? DEFAULT_TRAFFIC_PATH;
    await fs.mkdir(dirOf(path), { recursive: true });
    await fs.appendFile(path, `${JSON.stringify(rec)}\n`);
}
export class ScopeDeniedError extends Error {
    constructor(target, reason) {
        super(`target not in scope (${target}): ${reason}`);
        this.name = 'ScopeDeniedError';
    }
}
export async function assertInScope(target, opts = {}) {
    if (opts.skipScopeCheck)
        return;
    const env = opts.env ?? process.env;
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const control = (env.CONTROL_URL ?? 'http://control:8090').replace(/\/+$/, '');
    const taskId = env.NEO_TASK_ID;
    const payload = { target };
    if (taskId && taskId.trim())
        payload.task_id = taskId.trim();
    const res = await fetchImpl(`${control}/scope/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: opts.signal,
    });
    const text = await res.text();
    let body = {};
    try {
        body = text ? JSON.parse(text) : {};
    }
    catch {
        body = { allowed: false, reason: text || 'invalid scope response' };
    }
    if (res.status < 200 || res.status >= 300) {
        throw new Error(`scope check failed (${res.status}): ${body.reason ?? 'http error'}`);
    }
    if (body.allowed !== true) {
        throw new ScopeDeniedError(target, body.reason ?? 'default deny');
    }
}
function recordCapture(opts, store, partial) {
    const rec = {
        id: (opts.randomId ?? randomUUID)(),
        timestamp: (opts.now ?? (() => new Date()))().toISOString(),
        ...partial,
    };
    store.push(rec);
    void appendTraffic(rec, opts);
    return rec;
}
export function wrapPlaywrightPage(page, opts = {}) {
    const requests = [];
    page.on('request', ((req) => {
        recordCapture(opts, requests, {
            method: req.method(),
            url: req.url(),
            headers: req.headers(),
            postData: req.postData() ?? undefined,
        });
    }));
    page.on('response', ((res) => {
        const hit = [...requests].reverse().find((r) => r.url === res.url() && r.status === undefined);
        if (hit)
            hit.status = res.status();
    }));
    return {
        async navigate(url, wait) {
            await page.goto(url, { waitUntil: wait || 'load' });
            return { url: page.url(), title: await page.title() };
        },
        async act(args) {
            const selector = args.selector?.trim();
            if (!selector) {
                throw new Error('selector is required (instruction-only act needs a CSS selector)');
            }
            if (args.action === 'click')
                await page.click(selector);
            else if (args.action === 'type') {
                if (args.text === undefined)
                    throw new Error('text is required for type');
                await page.fill(selector, args.text);
            }
            else if (args.action === 'select') {
                if (args.text === undefined)
                    throw new Error('text is required for select');
                await page.selectOption(selector, args.text);
            }
            else {
                throw new Error(`unknown action: ${String(args.action)}`);
            }
            return { ok: true };
        },
        async evaluate(expression) {
            return page.evaluate((e) => eval(e), expression);
        },
        async screenshot() {
            return page.screenshot({ type: 'png' });
        },
        async network() {
            return requests;
        },
    };
}
export async function connectPlaywright(opts = {}) {
    const endpoint = cdpUrl(opts);
    let pw = opts.playwright;
    if (!pw && opts.importPlaywright) {
        pw = await opts.importPlaywright();
    }
    if (!pw) {
        try {
            pw = await import('playwright');
        }
        catch {
            try {
                pw = await import('playwright-core');
            }
            catch {
                pw = undefined;
            }
        }
    }
    if (!pw)
        throw new Error('playwright not available');
    const browser = await pw.chromium.connectOverCDP(endpoint);
    const contexts = browser.contexts();
    const page = contexts[0]?.pages()[0] ?? await (contexts[0]?.newPage() ?? browser.newPage());
    return wrapPlaywrightPage(page, opts);
}
class CdpConn {
    id = 0;
    pending = new Map();
    events = new Map();
    ws;
    constructor(ws) {
        this.ws = ws;
        const onMessage = (ev) => {
            const raw = typeof ev.data === 'string' ? ev.data : String(ev.data ?? '');
            let msg;
            try {
                msg = JSON.parse(raw);
            }
            catch {
                return;
            }
            if (typeof msg.id === 'number') {
                const wait = this.pending.get(msg.id);
                if (!wait)
                    return;
                this.pending.delete(msg.id);
                if (msg.error)
                    wait.reject(new Error(msg.error.message ?? 'cdp error'));
                else
                    wait.resolve(msg.result);
                return;
            }
            if (msg.method) {
                for (const fn of this.events.get(msg.method) ?? [])
                    fn(msg.params ?? {});
            }
        };
        if (typeof this.ws.addEventListener === 'function') {
            this.ws.addEventListener('message', onMessage);
        }
        else {
            this.ws.onmessage = onMessage;
        }
    }
    waitOpen() {
        if (this.ws.readyState === 1)
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            const ok = () => resolve();
            const fail = () => reject(new Error('cdp websocket error'));
            if (typeof this.ws.addEventListener === 'function') {
                this.ws.addEventListener('open', ok);
                this.ws.addEventListener('error', fail);
            }
            else {
                this.ws.onopen = ok;
                this.ws.onerror = fail;
            }
        });
    }
    on(method, fn) {
        const list = this.events.get(method) ?? [];
        list.push(fn);
        this.events.set(method, list);
    }
    send(method, params) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
}
async function fetchJson(fetchImpl, url, signal) {
    const res = await fetchImpl(url, { signal });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
        throw new Error(`cdp http ${res.status}: ${text}`);
    }
    return text ? JSON.parse(text) : null;
}
export async function connectCdp(opts = {}) {
    const endpoint = cdpUrl(opts);
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const Ws = opts.ws ?? globalThis.WebSocket;
    if (!Ws)
        throw new Error('WebSocket is not available for CDP');
    let list = await fetchJson(fetchImpl, `${endpoint}/json/list`, opts.signal);
    let pageMeta = Array.isArray(list) ? list.find((p) => p.type === 'page' && p.webSocketDebuggerUrl) : undefined;
    if (!pageMeta?.webSocketDebuggerUrl) {
        await fetchImpl(`${endpoint}/json/new?about:blank`, { signal: opts.signal });
        list = await fetchJson(fetchImpl, `${endpoint}/json/list`, opts.signal);
        pageMeta = Array.isArray(list) ? list.find((p) => p.type === 'page' && p.webSocketDebuggerUrl) : undefined;
    }
    if (!pageMeta?.webSocketDebuggerUrl) {
        const version = await fetchJson(fetchImpl, `${endpoint}/json/version`, opts.signal);
        if (!version?.webSocketDebuggerUrl)
            throw new Error('no CDP websocket url at ' + endpoint);
        pageMeta = { type: 'page', webSocketDebuggerUrl: version.webSocketDebuggerUrl };
    }
    const wsUrl = rewriteCdpWebSocketUrl(pageMeta.webSocketDebuggerUrl, endpoint);
    const conn = new CdpConn(new Ws(wsUrl));
    await conn.waitOpen();
    await conn.send('Page.enable');
    await conn.send('Runtime.enable');
    await conn.send('Network.enable');
    const requests = [];
    const byNetworkId = new Map();
    conn.on('Network.requestWillBeSent', (params) => {
        const req = params.request;
        if (!req?.url)
            return;
        const rec = recordCapture(opts, requests, {
            method: req.method ?? 'GET',
            url: req.url,
            headers: req.headers ?? {},
            postData: req.postData,
        });
        if (typeof params.requestId === 'string')
            byNetworkId.set(params.requestId, rec);
    });
    conn.on('Network.responseReceived', (params) => {
        const rec = typeof params.requestId === 'string' ? byNetworkId.get(params.requestId) : undefined;
        const response = params.response;
        if (rec && typeof response?.status === 'number')
            rec.status = response.status;
    });
    return {
        async navigate(url, _wait) {
            await conn.send('Page.navigate', { url });
            const title = await conn.send('Runtime.evaluate', {
                expression: 'document.title',
                returnByValue: true,
            });
            return { url, title: typeof title?.result?.value === 'string' ? title.result.value : undefined };
        },
        async act(args) {
            const selector = args.selector?.trim();
            if (!selector)
                throw new Error('selector is required (instruction-only act needs a CSS selector)');
            const selJson = JSON.stringify(selector);
            if (args.action === 'click') {
                await conn.send('Runtime.evaluate', {
                    expression: `document.querySelector(${selJson})?.click()`,
                    userGesture: true,
                });
            }
            else if (args.action === 'type') {
                if (args.text === undefined)
                    throw new Error('text is required for type');
                const textJson = JSON.stringify(args.text);
                await conn.send('Runtime.evaluate', {
                    expression: `(() => { const el = document.querySelector(${selJson}); if (!el) throw new Error('not found'); el.focus(); el.value = ${textJson}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`,
                });
            }
            else if (args.action === 'select') {
                if (args.text === undefined)
                    throw new Error('text is required for select');
                const textJson = JSON.stringify(args.text);
                await conn.send('Runtime.evaluate', {
                    expression: `(() => { const el = document.querySelector(${selJson}); if (!el) throw new Error('not found'); el.value = ${textJson}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`,
                });
            }
            else {
                throw new Error(`unknown action: ${String(args.action)}`);
            }
            return { ok: true };
        },
        async evaluate(expression) {
            const out = await conn.send('Runtime.evaluate', { expression, returnByValue: true });
            if (out?.exceptionDetails)
                throw new Error(out.exceptionDetails.text ?? 'eval failed');
            return out?.result?.value;
        },
        async screenshot() {
            const out = await conn.send('Page.captureScreenshot', { format: 'png' });
            if (!out?.data)
                throw new Error('screenshot empty');
            return Buffer.from(out.data, 'base64');
        },
        async network() {
            return requests;
        },
    };
}
export async function openBrowser(opts = {}) {
    if (opts.session)
        return opts.session;
    if (opts.playwright || opts.importPlaywright)
        return connectPlaywright(opts);
    try {
        return await connectPlaywright(opts);
    }
    catch {
        return connectCdp(opts);
    }
}
export async function getBrowserSession(opts = {}) {
    if (opts.session)
        return opts.session;
    if (!cachedSession) {
        cachedSession = openBrowser(opts).catch((err) => {
            cachedSession = undefined;
            throw err;
        });
    }
    return cachedSession;
}
export async function browserNavigate(args, opts = {}) {
    throwIfAborted(opts.signal);
    const url = args.url.trim();
    if (!url)
        throw new Error('url is required');
    await assertInScope(url, opts);
    const session = await getBrowserSession(opts);
    return session.navigate(url, args.wait);
}
export async function browserAct(args, opts = {}) {
    throwIfAborted(opts.signal);
    if (!args.instruction?.trim())
        throw new Error('instruction is required');
    if (!args.selector?.trim()) {
        throw new Error('selector is required (instruction-only act needs a CSS selector)');
    }
    const session = await getBrowserSession(opts);
    return session.act(args);
}
export async function browserEval(args, opts = {}) {
    throwIfAborted(opts.signal);
    const expression = args.expression.trim();
    if (!expression)
        throw new Error('expression is required');
    const session = await getBrowserSession(opts);
    return { result: await session.evaluate(expression) };
}
export async function browserScreenshot(opts = {}) {
    throwIfAborted(opts.signal);
    const session = await getBrowserSession(opts);
    const bytes = await session.screenshot();
    const dir = (opts.screenshotDir ?? opts.env?.BROWSER_SCREENSHOT_DIR ?? DEFAULT_SCREENSHOT_DIR).replace(/\/+$/, '');
    const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
    const path = `${dir}/screenshot-${stamp}.png`;
    const fs = opts.fs ?? nodeFs();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path, bytes);
    return { path };
}
export async function browserNetwork(opts = {}) {
    throwIfAborted(opts.signal);
    const session = await getBrowserSession(opts);
    return { requests: await session.network() };
}
