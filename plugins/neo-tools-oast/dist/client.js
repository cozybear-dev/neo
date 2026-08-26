import { constants, createCipheriv, createDecipheriv, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, randomUUID, } from 'node:crypto';
const defaultStore = new Map();
const ALPHABET = '0123456789abcdefghijklmnopqrstuv';
export function interactshUrl(env = process.env) {
    return (env.INTERACTSH_URL ?? 'http://interactsh:80').replace(/\/+$/, '');
}
export function interactshToken(env = process.env) {
    const value = env.INTERACTSH_TOKEN;
    return value && value.trim() ? value.trim() : undefined;
}
export function randomId(length) {
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++)
        out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
}
export function encodePublicKeyPem(spkiDer) {
    const b64 = spkiDer.toString('base64');
    const lines = b64.match(/.{1,64}/g) ?? [b64];
    return `-----BEGIN RSA PUBLIC KEY-----\n${lines.join('\n')}\n-----END RSA PUBLIC KEY-----\n`;
}
export function generateClientKeys() {
    const pair = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const spkiB64 = pair.publicKey.toString('base64');
    const lines = spkiB64.match(/.{1,64}/g) ?? [spkiB64];
    const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
    return {
        publicKeyB64: Buffer.from(encodePublicKeyPem(pair.publicKey)).toString('base64'),
        privateKeyPem: pair.privateKey,
        publicKeyPem,
    };
}
export function decryptMessage(privateKeyPem, aesKeyB64, secureMessage) {
    const aesKey = privateDecrypt({
        key: privateKeyPem,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
    }, Buffer.from(aesKeyB64, 'base64'));
    const cipherText = Buffer.from(secureMessage, 'base64');
    if (cipherText.length < 16)
        throw new Error('ciphertext too short');
    const iv = cipherText.subarray(0, 16);
    const data = cipherText.subarray(16);
    const decipher = createDecipheriv('aes-256-ctr', aesKey, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8').replace(/[ \t\r\n]+$/, '');
}
/** Test helper: encrypt like interactsh-server (RSA-OAEP SHA-256 AES-256-CTR). */
export function encryptMessage(publicKeyPem, plaintext) {
    const aesKey = randomBytes(32);
    const wrapped = publicEncrypt({
        key: publicKeyPem,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
    }, aesKey);
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-ctr', aesKey, iv);
    const encrypted = Buffer.concat([iv, cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
        aesKey: wrapped.toString('base64'),
        data: encrypted.toString('base64'),
    };
}
export function redactSecrets(value) {
    const secretKey = /token|secret|authorization|api[_-]?key|private/i;
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
function authHeaders(token) {
    if (!token)
        return { 'content-type': 'application/json' };
    return { 'content-type': 'application/json', Authorization: token };
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
    if (typeof body === 'string' && body.trim())
        return body;
    if (body && typeof body === 'object') {
        const rec = body;
        if (typeof rec.error === 'string')
            return rec.error;
        if (typeof rec.message === 'string')
            return rec.message;
    }
    return fallback;
}
function serverHost(base) {
    try {
        return new URL(base).hostname;
    }
    catch {
        return base.replace(/^https?:\/\//, '').split('/')[0] ?? base;
    }
}
function payloadFor(session) {
    const nonce = randomId(13);
    const domain = `${session.id}${nonce}.${session.serverHost}`;
    const url = session.kind === 'http' ? `http://${domain}` : domain;
    return { id: session.id, url, domain };
}
export function normalizeInteraction(raw) {
    const out = {
        protocol: String(raw.protocol ?? ''),
        uniqueId: String(raw['unique-id'] ?? raw.uniqueId ?? ''),
        fullId: String(raw['full-id'] ?? raw.fullId ?? ''),
        remoteAddress: String(raw['remote-address'] ?? raw.remoteAddress ?? ''),
        timestamp: raw.timestamp != null ? String(raw.timestamp) : '',
    };
    const qType = raw['q-type'] ?? raw.qType;
    const rawRequest = raw['raw-request'] ?? raw.rawRequest;
    const rawResponse = raw['raw-response'] ?? raw.rawResponse;
    const smtpFrom = raw['smtp-from'] ?? raw.smtpFrom;
    if (qType != null)
        out.qType = String(qType);
    if (rawRequest != null)
        out.rawRequest = String(rawRequest);
    if (rawResponse != null)
        out.rawResponse = String(rawResponse);
    if (smtpFrom != null)
        out.smtpFrom = String(smtpFrom);
    return out;
}
function parseInteraction(raw) {
    if (typeof raw === 'string') {
        try {
            return parseInteraction(JSON.parse(raw));
        }
        catch {
            return null;
        }
    }
    if (!raw || typeof raw !== 'object')
        return null;
    return normalizeInteraction(raw);
}
export async function defaultSleep(ms, signal) {
    if (ms <= 0)
        return;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(), ms);
        const onAbort = () => {
            clearTimeout(timer);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
        };
        if (!signal)
            return;
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
export async function registerOast(args, opts = {}) {
    if (args.kind !== 'http' && args.kind !== 'dns') {
        throw new Error('kind must be http or dns');
    }
    const env = opts.env ?? process.env;
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const store = opts.store ?? defaultStore;
    const base = (opts.interactshUrl ?? interactshUrl(env)).replace(/\/+$/, '');
    const token = opts.token ?? interactshToken(env);
    const correlationId = randomId(20);
    const secretKey = randomUUID();
    const keys = generateClientKeys();
    const { status, body } = await readJson(fetchImpl, `${base}/register`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
            'public-key': keys.publicKeyB64,
            'secret-key': secretKey,
            'correlation-id': correlationId,
        }),
        signal: opts.signal,
    });
    if (status < 200 || status >= 300) {
        throw new Error(`oast_register failed (${status}): ${errorMessage(body, 'http error')}`);
    }
    const session = {
        id: correlationId,
        secretKey,
        privateKeyPem: keys.privateKeyPem,
        publicKeyPem: keys.publicKeyPem,
        serverHost: serverHost(base),
        kind: args.kind,
    };
    store.set(correlationId, session);
    return payloadFor(session);
}
async function pollOnce(session, opts) {
    const env = opts.env ?? process.env;
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const base = (opts.interactshUrl ?? interactshUrl(env)).replace(/\/+$/, '');
    const token = opts.token ?? interactshToken(env);
    const url = `${base}/poll?id=${encodeURIComponent(session.id)}&secret=${encodeURIComponent(session.secretKey)}`;
    const headers = {};
    if (token)
        headers.Authorization = token;
    const { status, body } = await readJson(fetchImpl, url, {
        method: 'GET',
        headers,
        signal: opts.signal,
    });
    if (status < 200 || status >= 300) {
        throw new Error(`oast_poll failed (${status}): ${errorMessage(body, 'http error')}`);
    }
    const obj = body && typeof body === 'object' ? body : {};
    const out = [];
    const aesKey = typeof obj.aes_key === 'string' ? obj.aes_key : '';
    const data = Array.isArray(obj.data) ? obj.data : [];
    for (const item of data) {
        if (typeof item !== 'string')
            continue;
        try {
            const plain = aesKey ? decryptMessage(session.privateKeyPem, aesKey, item) : item;
            const parsed = parseInteraction(plain);
            if (parsed)
                out.push(parsed);
        }
        catch {
            // skip undecryptable rows
        }
    }
    for (const extra of [obj.extra, obj.tlddata]) {
        if (!Array.isArray(extra))
            continue;
        for (const item of extra) {
            const parsed = parseInteraction(item);
            if (parsed)
                out.push(parsed);
        }
    }
    return out;
}
export async function pollOast(args, opts = {}) {
    const store = opts.store ?? defaultStore;
    const session = store.get(args.id);
    if (!session)
        throw new Error(`unknown oast id: ${args.id}`);
    const waitMs = Math.max(0, (args.wait_seconds ?? 0) * 1000);
    const now = opts.now ?? Date.now;
    const sleep = opts.sleep ?? defaultSleep;
    const deadline = now() + waitMs;
    while (true) {
        const interactions = await pollOnce(session, opts);
        if (interactions.length > 0)
            return interactions;
        const remaining = deadline - now();
        if (remaining <= 0)
            return interactions;
        await sleep(Math.min(1000, remaining), opts.signal);
    }
}
