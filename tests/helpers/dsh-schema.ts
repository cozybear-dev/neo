/**
 * Test-only pin-matched ValueSchemaSpec compiler for DSH pin 141eb6f.
 * Mirrors packages/core/tools/src/schema.ts + json-schema.ts validation rules
 * without importing @deepseek-ai/dsh-tools.
 */

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'] as const
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const

type JsonSchemaNode = {
  type?: string
  oneOf?: JsonSchemaNode[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchemaNode
  enum?: unknown[]
  const?: unknown
  description?: unknown
  title?: unknown
  default?: unknown
  examples?: unknown
}

type CompiledPropertyMap = {
  properties: Record<string, JsonSchemaNode>
  required?: string[]
}

type NodeDestination =
  | { kind: 'root'; holder: { value?: JsonSchemaNode } }
  | { kind: 'property'; target: Record<string, JsonSchemaNode>; key: string }
  | { kind: 'item'; target: JsonSchemaNode }
  | { kind: 'one-of'; target: JsonSchemaNode[]; index: number }

type PropertyMapDestination =
  | { kind: 'root'; holder: { value?: CompiledPropertyMap } }
  | { kind: 'object'; target: JsonSchemaNode }

type CompileTask =
  | { kind: 'value'; input: unknown; path: string; allowRequired: boolean; destination: NodeDestination }
  | { kind: 'property-map'; input: unknown; path: string; destination: PropertyMapDestination }
  | {
    kind: 'property'
    property: unknown
    path: string
    key: string
    properties: Record<string, JsonSchemaNode>
    required: string[]
  }
  | {
    kind: 'property-map-tail'
    compiled: CompiledPropertyMap
    required: string[]
    destination: PropertyMapDestination
  }
  | { kind: 'leave'; input: object }

function authorError(message: string): never {
  throw new Error(`unsupported JSON schema: ${message}`)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function copyAnnotations(source: Record<string, unknown>, target: JsonSchemaNode): void {
  if (Object.hasOwn(source, 'description')) target.description = source.description
  if (Object.hasOwn(source, 'title')) target.title = source.title
  if (Object.hasOwn(source, 'default')) target.default = source.default
  if (Object.hasOwn(source, 'examples')) target.examples = source.examples
}

function assertAuthorKeys(source: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`)
  }
}

function assignCompiledNode(destination: NodeDestination, node: JsonSchemaNode): void {
  switch (destination.kind) {
    case 'root':
      destination.holder.value = node
      break
    case 'property':
      Object.defineProperty(destination.target, destination.key, {
        value: node,
        enumerable: true,
        configurable: true,
        writable: true,
      })
      break
    case 'item':
      destination.target.items = node
      break
    case 'one-of':
      destination.target[destination.index] = node
      break
  }
}

function assignCompiledPropertyMap(destination: PropertyMapDestination, compiled: CompiledPropertyMap): void {
  if (destination.kind === 'root') {
    destination.holder.value = compiled
  } else {
    destination.target.properties = compiled.properties
  }
}

function runSchemaCompiler(initial: CompileTask): void {
  const seen = new Set<object>()
  const tasks: CompileTask[] = [initial]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      seen.delete(task.input)
      continue
    }
    if (task.kind === 'property-map-tail') {
      if (task.required.length > 0) {
        task.compiled.required = task.required
        if (task.destination.kind === 'object') task.destination.target.required = task.required
      }
      continue
    }
    if (task.kind === 'property') {
      if (!isPlainRecord(task.property)) authorError(`${task.path} must be a value schema object`)
      if (Object.hasOwn(task.property, 'required') && task.property.required !== true) {
        authorError(`${task.path}.required must be true when present`)
      }
      if (Object.hasOwn(task.property, 'required') && task.property.required === true) {
        task.required.push(task.key)
      }
      tasks.push({
        kind: 'value',
        input: task.property,
        path: task.path,
        allowRequired: true,
        destination: { kind: 'property', target: task.properties, key: task.key },
      })
      continue
    }
    if (task.kind === 'property-map') {
      if (!isPlainRecord(task.input)) authorError(`${task.path} must be an object of value schemas`)
      if (seen.has(task.input)) authorError(`${task.path} is circular`)
      seen.add(task.input)
      const compiled: CompiledPropertyMap = { properties: {} }
      const required: string[] = []
      assignCompiledPropertyMap(task.destination, compiled)
      tasks.push({ kind: 'leave', input: task.input })
      tasks.push({ kind: 'property-map-tail', compiled, required, destination: task.destination })
      const entries = Object.entries(task.input)
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]
        if (entry === undefined) continue
        tasks.push({
          kind: 'property',
          property: entry[1],
          path: `${task.path}.${entry[0]}`,
          key: entry[0],
          properties: compiled.properties,
          required,
        })
      }
      continue
    }

    const { input, path } = task
    if (!isPlainRecord(input)) authorError(`${path} must be a value schema object`)
    if (seen.has(input)) authorError(`${path} is circular`)
    seen.add(input)
    const authorKeys = [...ANNOTATION_KEYS, ...(task.allowRequired ? ['required'] : [])]
    const node: JsonSchemaNode = {}
    assignCompiledNode(task.destination, node)
    tasks.push({ kind: 'leave', input })

    if (Object.hasOwn(input, 'oneOf')) {
      assertAuthorKeys(input, path, [...authorKeys, 'oneOf', 'type'])
      if (Object.hasOwn(input, 'type')) authorError(`${path} cannot declare both type and oneOf`)
      if (!isPlainArray(input.oneOf) || input.oneOf.length < 2) {
        authorError(`${path}.oneOf must be an array of at least two value schemas`)
      }
      const branches: JsonSchemaNode[] = []
      node.oneOf = branches
      copyAnnotations(input, node)
      for (let index = input.oneOf.length - 1; index >= 0; index--) {
        tasks.push({
          kind: 'value',
          input: input.oneOf[index],
          path: `${path}.oneOf[${index}]`,
          allowRequired: false,
          destination: { kind: 'one-of', target: branches, index },
        })
      }
      continue
    }

    const inputType = Object.hasOwn(input, 'type') ? input.type : undefined
    switch (inputType) {
      case 'json':
        assertAuthorKeys(input, path, [...authorKeys, 'type'])
        copyAnnotations(input, node)
        break
      case 'object':
        assertAuthorKeys(input, path, [...authorKeys, 'type', 'properties', 'additionalProperties'])
        if (!Object.hasOwn(input, 'additionalProperties') || typeof input.additionalProperties !== 'boolean') {
          authorError(`${path}.additionalProperties must be explicitly true or false`)
        }
        node.type = 'object'
        copyAnnotations(input, node)
        node.additionalProperties = input.additionalProperties as boolean
        if (Object.hasOwn(input, 'properties')) {
          tasks.push({
            kind: 'property-map',
            input: input.properties,
            path: `${path}.properties`,
            destination: { kind: 'object', target: node },
          })
        }
        break
      case 'array':
        assertAuthorKeys(input, path, [...authorKeys, 'type', 'items'])
        node.type = 'array'
        copyAnnotations(input, node)
        if (Object.hasOwn(input, 'items')) {
          tasks.push({
            kind: 'value',
            input: input.items,
            path: `${path}.items`,
            allowRequired: false,
            destination: { kind: 'item', target: node },
          })
        }
        break
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null':
        assertAuthorKeys(input, path, [...authorKeys, 'type', 'enum', 'const'])
        node.type = inputType
        copyAnnotations(input, node)
        if (Object.hasOwn(input, 'enum')) {
          if (!isPlainArray(input.enum) || input.enum.length === 0) {
            authorError(`${path}.enum must be a non-empty array of scalar values`)
          }
          node.enum = Array.from(input.enum)
        }
        if (Object.hasOwn(input, 'const')) node.const = input.const
        break
      default:
        authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
    }
  }
}

/** Compile one author-facing value schema (pin 141eb6f runSchemaCompiler rules). */
export function compileValueSchema(spec: unknown, path = 'schema'): unknown {
  const holder: { value?: JsonSchemaNode } = {}
  runSchemaCompiler({
    kind: 'value',
    input: spec,
    path,
    allowRequired: false,
    destination: { kind: 'root', holder },
  })
  return holder.value ?? authorError(`${path} did not compile`)
}

/** Compile an implicit open parameter object (no additionalProperties required on root). */
export function compileParameters(spec: unknown): unknown {
  const holder: { value?: CompiledPropertyMap } = {}
  runSchemaCompiler({
    kind: 'property-map',
    input: spec,
    path: 'parameters',
    destination: { kind: 'root', holder },
  })
  const compiled = holder.value ?? authorError('parameters did not compile')
  return {
    type: 'object',
    properties: compiled.properties,
    ...(compiled.required === undefined ? {} : { required: compiled.required }),
  }
}

function isJsonNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
}

function diagnosticPath(path: string): string {
  return path === '' ? 'arguments' : path
}

function propertyPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

function checkScalarValue(node: JsonSchemaNode, value: unknown, path: string): string[] {
  if (Object.hasOwn(node, 'enum') && node.enum !== undefined && !node.enum.includes(value)) {
    return [`"${diagnosticPath(path)}" must be one of ${JSON.stringify(node.enum)}`]
  }
  if (Object.hasOwn(node, 'const') && value !== node.const) {
    return [`"${diagnosticPath(path)}" must be ${JSON.stringify(node.const)}`]
  }
  return []
}

function checkValue(schema: JsonSchemaNode, value: unknown, path: string): string[] {
  const oneOf = Object.hasOwn(schema, 'oneOf') ? schema.oneOf : undefined
  if (oneOf !== undefined) {
    let matches = 0
    for (const branch of oneOf) {
      if (checkValue(branch, value, path).length === 0) matches++
    }
    return matches === 1
      ? []
      : [`"${diagnosticPath(path)}" must match exactly one oneOf branch (matched ${matches})`]
  }

  const nodeType = Object.hasOwn(schema, 'type') ? schema.type : undefined
  if (nodeType === undefined) {
    try {
      JSON.parse(JSON.stringify(value))
      return []
    } catch {
      return [`"${diagnosticPath(path)}" must be a lossless JSON value`]
    }
  }

  switch (nodeType) {
    case 'object': {
      if (!isPlainRecord(value)) return [`"${diagnosticPath(path)}" must be an object`]
      const properties = Object.hasOwn(schema, 'properties') ? schema.properties ?? {} : {}
      const violations: string[] = []
      const required = Object.hasOwn(schema, 'required') ? schema.required ?? [] : []
      for (const key of required) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) {
          violations.push(`missing required property "${propertyPath(path, key)}"`)
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) continue
        violations.push(...checkValue(child, value[key], propertyPath(path, key)))
      }
      if (Object.hasOwn(schema, 'additionalProperties') && schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(properties, key)) {
            violations.push(
              `"${propertyPath(path, key)}" is not a declared property (additionalProperties: false)`,
            )
          }
        }
      }
      return violations
    }
    case 'array': {
      if (!Array.isArray(value)) return [`"${diagnosticPath(path)}" must be an array`]
      const items = Object.hasOwn(schema, 'items') ? schema.items : undefined
      if (items === undefined) return []
      const violations: string[] = []
      for (let index = 0; index < value.length; index++) {
        violations.push(...checkValue(items, value[index], `${path}[${index}]`))
      }
      return violations
    }
    case 'string':
      return typeof value === 'string'
        ? checkScalarValue(schema, value, path)
        : [`"${diagnosticPath(path)}" must be a string`]
    case 'number':
      if (typeof value !== 'number') return [`"${diagnosticPath(path)}" must be a number`]
      if (!isJsonNumber(value)) return [`"${diagnosticPath(path)}" must be a finite JSON number`]
      return checkScalarValue(schema, value, path)
    case 'integer':
      return !isJsonNumber(value) || !Number.isInteger(value)
        ? [`"${diagnosticPath(path)}" must be an integer`]
        : checkScalarValue(schema, value, path)
    case 'boolean':
      return typeof value === 'boolean'
        ? checkScalarValue(schema, value, path)
        : [`"${diagnosticPath(path)}" must be a boolean`]
    case 'null':
      return value === null
        ? checkScalarValue(schema, value, path)
        : [`"${diagnosticPath(path)}" must be null`]
    default:
      if (!(SCHEMA_TYPES as readonly string[]).includes(nodeType)) {
        return [`"${diagnosticPath(path)}" has unsupported type`]
      }
      return []
  }
}

/** Validate a value against a compiled schema; returns path-qualified violations. */
export function validateValue(schema: unknown, value: unknown, path = 'value'): string[] {
  return checkValue(schema as JsonSchemaNode, value, path)
}

type ToolDefLike = {
  name: string
  parameters: unknown
  output: { schema: unknown }
}

/** Compile parameters + output schema the way defineTool would. */
export function assertToolDefinitionCompiles(def: ToolDefLike): void {
  compileParameters(def.parameters)
  compileValueSchema(def.output.schema)
}

/**
 * Snapshot value through JSON.parse(JSON.stringify(...)) then validate against
 * the tool's output schema. Fail with `not lossless JSON` if stringify throws.
 */
export function assertExecuteResultValid(def: ToolDefLike, value: unknown): void {
  let snapshot: unknown
  try {
    snapshot = JSON.parse(JSON.stringify(value))
  } catch {
    throw new Error('not lossless JSON')
  }
  const schema = compileValueSchema(def.output.schema)
  const violations = validateValue(schema, snapshot)
  if (violations.length > 0) {
    throw new Error(`tool "${def.name}" returned invalid output: ${violations.join('; ')}`)
  }
}
