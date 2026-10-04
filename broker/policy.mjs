export function validId(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id ?? ''))
    throw new Error('invalid deployment id')
  return id
}
export function validateCompose(spec) {
  if (
    !spec ||
    !spec.services ||
    Object.keys(spec).some((k) => !['services', 'name'].includes(k))
  )
    throw new Error('unsupported Compose top-level field')
  const entries = Object.entries(spec.services)
  if (!entries.length || entries.length > 8)
    throw new Error('invalid service count')
  return entries.map(([name, s]) => {
    validId(name)
    const permitted = ['image', 'command', 'environment', 'expose']
    if (Object.keys(s).some((k) => !permitted.includes(k)))
      throw new Error('unsupported or unsafe Compose service field')
    if (
      typeof s.image !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(s.image)
    )
      throw new Error('invalid image')
    for (const key of ['command', 'entrypoint'])
      if (
        s[key] &&
        (!Array.isArray(s[key]) || s[key].some((x) => typeof x !== 'string'))
      )
        throw new Error('commands require argv arrays')
    if (
      s.environment &&
      (typeof s.environment !== 'object' ||
        Array.isArray(s.environment) ||
        Object.entries(s.environment).some(
          ([k, v]) => !/^[A-Z_][A-Z0-9_]*$/.test(k) || typeof v !== 'string',
        ))
    )
      throw new Error('invalid environment')
    return { name, ...s }
  })
}
