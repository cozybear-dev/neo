/** Extract a lowercase hostname for scope matching (strip scheme/userinfo/port/path). */
export function normalizeScopeHost(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  try {
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? new URL(trimmed)
      : new URL(`http://${trimmed}`)
    return url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return trimmed.split('/')[0]!.split(':')[0]!.toLowerCase()
  }
}
