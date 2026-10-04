/** Mode for a chat-opened task. Unset means thorough. */
export function sessionMode(
  value: string | undefined,
): 'fast' | 'thorough' {
  const mode = value?.trim() || 'thorough'
  if (mode !== 'fast' && mode !== 'thorough')
    throw Object.assign(
      new Error('NEO_MODE_DEFAULT must be fast or thorough'),
      { statusCode: 400 },
    )
  return mode
}

/** Fields the server assigns. The client cannot choose hosts or mode. */
export function sessionGrant(
  allowlist: string[],
  modeDefault: string | undefined,
): { mode: 'fast' | 'thorough'; allowlist: string[]; denylist: string[] } {
  const mode = sessionMode(modeDefault)
  if (!allowlist.length)
    throw Object.assign(new Error('NEO_ALLOWLIST is empty'), {
      statusCode: 400,
    })
  return { mode, allowlist, denylist: [] }
}
