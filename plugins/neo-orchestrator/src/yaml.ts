import { parseDocument } from 'yaml'
export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue }
/** YAML 1.2; duplicate keys, aliases and custom tags fail closed. */
export function parseYaml(source: string): YamlValue {
  const document = parseDocument(source, {
    version: '1.2',
    uniqueKeys: true,
    strict: true,
  })
  if (document.errors.length || document.warnings.length)
    throw new Error(
      `invalid preset YAML: ${[...document.errors, ...document.warnings].map((e) => e.message).join('; ')}`,
    )
  return document.toJS({ maxAliasCount: 0 }) as YamlValue
}
