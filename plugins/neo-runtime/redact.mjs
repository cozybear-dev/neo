const sensitiveKey =
  /token|secret|authorization|api[_-]?key|private|password|passwd|credential|cookie/i

/** Model-facing redaction. Raw evidence belongs in restricted artifacts, never here. */
export function redactText(text, secrets = []) {
  let out = String(text)
  for (const value of secrets
    .filter((v) => typeof v === 'string' && v.length >= 4)
    .sort((a, b) => b.length - a.length)) {
    out = out.split(value).join('[redacted]')
  }
  return out
    .replace(
      /("[^"\r\n]*(?:token|secret|password|passwd|api[_-]?key|credential)[^"\r\n]*"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"[redacted]"',
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      '[redacted private key]',
    )
    .replace(
      /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
      '[redacted authorization]',
    )
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(
      /((?:[?&]|\b)(?:[\w.-]*(?:token|secret|password|passwd|api[_-]?key|credential)[\w.-]*)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^&\s,;"'}]+)/gi,
      '$1[redacted]',
    )
    .replace(
      /^((?:set-cookie|cookie|authorization|proxy-authorization)\s*:\s*).*$/gim,
      '$1[redacted]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted key]')
}

export function redactSecrets(value, secrets = []) {
  const seen = new WeakSet()
  function walk(input) {
    if (typeof input === 'string') {
      // JSON bodies are often embedded as text inside tool results.
      if (/^\s*[\[{]/.test(input)) {
        try {
          return JSON.stringify(walk(JSON.parse(input)))
        } catch {
          /* plain text */
        }
      }
      return redactText(input, secrets)
    }
    if (!input || typeof input !== 'object') return input
    if (seen.has(input)) return '[circular]'
    seen.add(input)
    if (Array.isArray(input)) return input.map(walk)
    return Object.fromEntries(
      Object.entries(input).map(([key, val]) => [
        key,
        sensitiveKey.test(key) ? '[redacted]' : walk(val),
      ]),
    )
  }
  return walk(value)
}

export function environmentSecrets(env = process.env) {
  return Object.entries(env)
    .filter(
      ([key, value]) => sensitiveKey.test(key) && typeof value === 'string',
    )
    .map(([, value]) => value)
}

export function renderSafe(_args, value) {
  return [
    {
      type: 'text',
      text: JSON.stringify(redactSecrets(value, environmentSecrets())),
    },
  ]
}
