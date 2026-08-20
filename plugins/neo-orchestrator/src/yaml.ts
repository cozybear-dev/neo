/** Indent-based YAML subset for neo presets (no runtime yaml dependency). */

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue }

interface Line {
  indent: number
  text: string
  raw: string
}

export function parseYaml(source: string): YamlValue {
  const lines = tokenize(source)
  const { value, next } = parseNode(lines, 0, -1)
  if (next < lines.length) {
    throw new Error(`yaml: unexpected content at line "${lines[next]?.raw}"`)
  }
  return value
}

function tokenize(source: string): Line[] {
  const out: Line[] = []
  for (const raw of source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue
    const indent = raw.match(/^ */)?.[0].length ?? 0
    const text = raw.slice(indent)
    if (text.startsWith('#')) continue
    out.push({ indent, text, raw })
  }
  return out
}

function parseNode(lines: Line[], index: number, parentIndent: number): { value: YamlValue; next: number } {
  if (index >= lines.length) return { value: null, next: index }
  const line = lines[index]
  if (!line || line.indent <= parentIndent) return { value: null, next: index }
  if (line.text.startsWith('- ') || line.text === '-') {
    return parseList(lines, index, line.indent)
  }
  return parseMap(lines, index, line.indent)
}

function parseMap(lines: Line[], index: number, indent: number): { value: Record<string, YamlValue>; next: number } {
  const obj: Record<string, YamlValue> = {}
  let i = index
  while (i < lines.length) {
    const line = lines[i]
    if (!line || line.indent < indent) break
    if (line.indent > indent) {
      throw new Error(`yaml: unexpected indent at "${line.raw}"`)
    }
    if (line.text.startsWith('- ')) {
      throw new Error(`yaml: list item where a map key was expected: "${line.raw}"`)
    }
    const colon = splitKey(line.text)
    if (!colon) throw new Error(`yaml: expected key: at "${line.raw}"`)
    const { key, rest } = colon
    if (rest === '|' || rest === '>') {
      const block = collectBlock(lines, i + 1, indent)
      obj[key] = rest === '>' ? foldBlock(block.text) : block.text
      i = block.next
      continue
    }
    if (rest !== '') {
      obj[key] = parseScalar(rest)
      i += 1
      continue
    }
    const child = lines[i + 1]
    if (!child || child.indent <= indent) {
      obj[key] = null
      i += 1
      continue
    }
    const parsed = parseNode(lines, i + 1, indent)
    obj[key] = parsed.value
    i = parsed.next
  }
  return { value: obj, next: i }
}

function parseList(lines: Line[], index: number, indent: number): { value: YamlValue[]; next: number } {
  const items: YamlValue[] = []
  let i = index
  while (i < lines.length) {
    const line = lines[i]
    if (!line || line.indent < indent) break
    if (line.indent > indent) {
      throw new Error(`yaml: unexpected indent at "${line.raw}"`)
    }
    if (!(line.text.startsWith('- ') || line.text === '-')) break
    const rest = line.text === '-' ? '' : line.text.slice(2).trim()
    if (rest === '|' || rest === '>') {
      const block = collectBlock(lines, i + 1, indent)
      items.push(rest === '>' ? foldBlock(block.text) : block.text)
      i = block.next
      continue
    }
    if (rest === '') {
      const child = lines[i + 1]
      if (!child || child.indent <= indent) {
        items.push(null)
        i += 1
        continue
      }
      const parsed = parseNode(lines, i + 1, indent)
      items.push(parsed.value)
      i = parsed.next
      continue
    }
    const kv = splitKey(rest)
    if (kv && kv.rest !== '' && kv.rest !== '|' && kv.rest !== '>') {
      const item: Record<string, YamlValue> = { [kv.key]: parseScalar(kv.rest) }
      let j = i + 1
      while (j < lines.length) {
        const extra = lines[j]
        if (!extra || extra.indent <= indent) break
        if (extra.text.startsWith('- ')) break
        const extraKey = splitKey(extra.text)
        if (!extraKey) break
        if (extraKey.rest === '|' || extraKey.rest === '>') {
          const block = collectBlock(lines, j + 1, extra.indent)
          item[extraKey.key] = extraKey.rest === '>' ? foldBlock(block.text) : block.text
          j = block.next
          continue
        }
        if (extraKey.rest !== '') {
          item[extraKey.key] = parseScalar(extraKey.rest)
          j += 1
          continue
        }
        const parsed = parseNode(lines, j + 1, extra.indent)
        item[extraKey.key] = parsed.value
        j = parsed.next
      }
      items.push(item)
      i = j
      continue
    }
    if (kv && (kv.rest === '' || kv.rest === '|' || kv.rest === '>')) {
      const item: Record<string, YamlValue> = {}
      if (kv.rest === '|' || kv.rest === '>') {
        const block = collectBlock(lines, i + 1, indent)
        item[kv.key] = kv.rest === '>' ? foldBlock(block.text) : block.text
        i = block.next
      } else {
        const parsed = parseNode(lines, i + 1, indent)
        item[kv.key] = parsed.value
        i = parsed.next
      }
      let j = i
      while (j < lines.length) {
        const extra = lines[j]
        if (!extra || extra.indent <= indent) break
        if (extra.text.startsWith('- ')) break
        const extraKey = splitKey(extra.text)
        if (!extraKey) break
        if (extraKey.rest === '|' || extraKey.rest === '>') {
          const block = collectBlock(lines, j + 1, extra.indent)
          item[extraKey.key] = extraKey.rest === '>' ? foldBlock(block.text) : block.text
          j = block.next
          continue
        }
        if (extraKey.rest !== '') {
          item[extraKey.key] = parseScalar(extraKey.rest)
          j += 1
          continue
        }
        const parsed = parseNode(lines, j + 1, extra.indent)
        item[extraKey.key] = parsed.value
        j = parsed.next
      }
      items.push(item)
      i = j
      continue
    }
    items.push(parseScalar(rest))
    i += 1
  }
  return { value: items, next: i }
}

function collectBlock(lines: Line[], index: number, parentIndent: number): { text: string; next: number } {
  const chunks: string[] = []
  let i = index
  let contentIndent: number | undefined
  while (i < lines.length) {
    const line = lines[i]
    if (!line) break
    if (line.indent <= parentIndent) break
    if (contentIndent === undefined) contentIndent = line.indent
    chunks.push(line.raw.slice(contentIndent))
    i += 1
  }
  return { text: chunks.join('\n').replace(/\n+$/, ''), next: i }
}

function foldBlock(text: string): string {
  return text.replace(/\n+/g, (m) => (m.length > 1 ? '\n' : ' ')).trim()
}

function splitKey(text: string): { key: string; rest: string } | undefined {
  const m = text.match(/^([^:#\n][^:\n]*?)\s*:\s*(?:#.*)?(.*)$/)
  if (!m) return undefined
  const key = unquote(m[1]!.trim())
  let rest = (m[2] ?? '').trim()
  const hash = unquotedHashIndex(rest)
  if (hash >= 0) rest = rest.slice(0, hash).trim()
  return { key, rest }
}

function unquotedHashIndex(text: string): number {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#') return i
  }
  return -1
}

export function parseScalar(text: string): YamlValue {
  if (text === '[]') return []
  if (text === '{}') return {}
  if (text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null
  if (text === 'true' || text === 'True' || text === 'yes' || text === 'Yes') return true
  if (text === 'false' || text === 'False' || text === 'no' || text === 'No') return false
  if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text)) return Number(text)
  return unquote(text)
}

function unquote(text: string): string {
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2)
    || (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1)
  }
  return text
}
