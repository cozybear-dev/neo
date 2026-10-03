#!/usr/bin/env node
/**
 * Render $DSH_HOME/neo-llm.patch.yml from NEO_LLM_* env.
 *
 * NEO_LLM_* is the fallback for every agent. Optional NEO_LLM_ORCHESTRATOR_*
 * selects the parent chat model. Optional NEO_LLM_WORKHORSE_* is exported as
 * NEO_RESOLVED_WORKHORSE_* for delegate(); it is not the parent default.
 *
 * Field names copied from deepseek-ai/deepseek-harness
 * 5badb15009ae1756c3afe0ae0cef1faafc290ccc (dsh@0.2.1-alpha.1):
 *   agent-default-model.{provider,model,reasoningEffort}
 *   llm-pi-ai.providers.<route>.{apiKeyEnv,api,baseURL,models:[{id}]}
 *
 * At this SHA, settings.yaml is a one-shot legacy import. Live provider and
 * model selection is a Cordis patch. llm-pi-ai stays dormant until a
 * providers dict is supplied. Catalog routes (openai, anthropic, openrouter)
 * need only apiKeyEnv; omitting api, baseURL, and models keeps the installed
 * catalog. A custom route must set api, baseURL, and a non-empty models list.
 * Native DeepSeek is the llm-deepseek route `deepseek-official`, not a pi-ai
 * provider — emitting it on llm-pi-ai is DUPLICATE_ADAPTER.
 *
 * A patch replaces the targeted row's whole config. This file is applied with
 * `dsh --patch` so env wins over a Models-page save for the session. Secrets
 * stay in the process environment (`--export`); they are not written here.
 */

const NATIVE_DEEPSEEK_ROUTE = 'deepseek-official'
const PATCH_FILENAME = 'neo-llm.patch.yml'

/** NEO_LLM_PROVIDER → DSH route + credential env (catalog ids verbatim). */
const PROVIDERS = {
  deepseek: { kind: 'native', route: NATIVE_DEEPSEEK_ROUTE, keyEnv: 'DEEPSEEK_API_KEY' },
  openai: { kind: 'catalog', route: 'openai', keyEnv: 'OPENAI_API_KEY' },
  anthropic: { kind: 'catalog', route: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY' },
  openrouter: { kind: 'catalog', route: 'openrouter', keyEnv: 'OPENROUTER_API_KEY' },
  custom: { kind: 'custom', route: 'custom', keyEnv: 'NEO_LLM_API_KEY' },
}

const API_KEY_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export class LlmSettingsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LlmSettingsError'
  }
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function yamlScalar(value) {
  return JSON.stringify(String(value))
}

/**
 * Resolve provider/model/key from env. Throws LlmSettingsError on invalid config.
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveLlmSelection(env) {
  const providerInput = trim(env.NEO_LLM_PROVIDER) || 'deepseek'
  const spec = PROVIDERS[providerInput]
  if (spec === undefined) {
    throw new LlmSettingsError(
      `NEO_LLM_PROVIDER=${JSON.stringify(providerInput)} is not supported `
        + `(expected deepseek, openai, anthropic, openrouter, or custom)`,
    )
  }

  const model = trim(env.NEO_LLM_MODEL)
  if (model === '') {
    throw new LlmSettingsError('NEO_LLM_MODEL is required')
  }

  const keyEnvName = spec.kind === 'custom'
    ? (trim(env.NEO_LLM_API_KEY_ENV) || 'NEO_LLM_API_KEY')
    : spec.keyEnv
  if (!API_KEY_ENV_PATTERN.test(keyEnvName)) {
    throw new LlmSettingsError(
      `credential env name ${JSON.stringify(keyEnvName)} must match ${String(API_KEY_ENV_PATTERN)}`,
    )
  }

  const neoKey = trim(env.NEO_LLM_API_KEY)
  const nativeKey = spec.kind === 'custom' ? neoKey : trim(env[spec.keyEnv])
  const apiKey = neoKey !== '' ? neoKey : nativeKey

  if (spec.kind !== 'custom' && apiKey === '') {
    throw new LlmSettingsError(
      `cloud provider ${providerInput} needs ${spec.keyEnv} or NEO_LLM_API_KEY`,
    )
  }

  if (spec.kind === 'custom') {
    const baseURL = trim(env.NEO_LLM_BASE_URL)
    if (baseURL === '') {
      throw new LlmSettingsError('NEO_LLM_PROVIDER=custom requires NEO_LLM_BASE_URL')
    }
    const api = trim(env.NEO_LLM_API) || 'openai-completions'
    return {
      providerInput,
      kind: spec.kind,
      route: spec.route,
      model,
      keyEnvName,
      apiKey,
      baseURL,
      api,
      reasoningEffort: trim(env.NEO_LLM_REASONING_EFFORT) || undefined,
    }
  }

  return {
    providerInput,
    kind: spec.kind,
    route: spec.route,
    model,
    keyEnvName,
    apiKey,
    reasoningEffort: trim(env.NEO_LLM_REASONING_EFFORT) || undefined,
  }
}

/**
 * Env assignments DSH adapters read (NEO_LLM_API_KEY copied onto the catalog name).
 * @param {ReturnType<typeof resolveLlmSelection>} selection
 */
export function mappedCredentialEnv(selection) {
  const mapped = {}
  if (selection.apiKey !== '') {
    mapped[selection.keyEnvName] = selection.apiKey
    mapped.NEO_LLM_API_KEY = selection.apiKey
  }
  return mapped
}

function renderAgentDefaultModel(selection) {
  const lines = [
    'agent-default-model:',
    `  provider: ${yamlScalar(selection.route)}`,
    `  model: ${yamlScalar(selection.model)}`,
  ]
  if (selection.reasoningEffort !== undefined) {
    lines.push(`  reasoningEffort: ${yamlScalar(selection.reasoningEffort)}`)
  }
  return `${lines.join('\n')}\n`
}

function renderCustomProviderBlock(selection) {
  const models = Array.isArray(selection.models) && selection.models.length > 0
    ? selection.models
    : [selection.model]
  return [
    `    ${selection.route}:`,
    `      apiKeyEnv: ${yamlScalar(selection.keyEnvName)}`,
    `      api: ${yamlScalar(selection.api)}`,
    `      baseURL: ${yamlScalar(selection.baseURL)}`,
    '      models:',
    ...models.map((id) => `        - id: ${yamlScalar(id)}`),
  ].join('\n')
}

function renderCatalogProviderBlock(selection) {
  return [
    `    ${selection.route}:`,
    `      apiKeyEnv: ${yamlScalar(selection.keyEnvName)}`,
  ].join('\n')
}

function splitTopLevel(yaml) {
  const lines = String(yaml).replace(/\r\n/g, '\n').split('\n')
  const sections = []
  let current = null
  for (const line of lines) {
    const top = /^([A-Za-z0-9_-]+)\s*:/.exec(line)
    if (top && !/^\s/.test(line)) {
      if (current) sections.push(current)
      current = { key: top[1], lines: [line] }
    } else if (current) {
      current.lines.push(line)
    } else if (line.trim() !== '') {
      sections.push({ key: null, lines: [line] })
    }
  }
  if (current) sections.push(current)
  return sections
}

function joinSections(sections) {
  return sections
    .map((section) => section.lines.join('\n').replace(/\n+$/, ''))
    .filter((block) => block.length > 0)
    .join('\n\n')
}

function splitProviderBlocks(tail) {
  const blocks = []
  let current = null
  const afterProviders = []
  for (const line of tail) {
    const providerKey = /^    ([A-Za-z0-9_-]+)\s*:/.exec(line)
    if (providerKey) {
      if (current) blocks.push(current)
      current = { key: providerKey[1], lines: [line] }
      continue
    }
    if (current && (line.trim() === '' || /^\s{5,}/.test(line))) {
      current.lines.push(line)
      continue
    }
    if (current) {
      blocks.push(current)
      current = null
    }
    afterProviders.push(line)
  }
  if (current) blocks.push(current)
  return { blocks, afterProviders }
}

function upsertProviderSection(yaml, route, providerLines, replaceBlock) {
  const sections = trim(yaml) === '' ? [] : splitTopLevel(yaml)
  const idx = sections.findIndex((section) => section.key === 'llm-pi-ai')
  if (idx === -1) {
    sections.push({
      key: 'llm-pi-ai',
      lines: ['llm-pi-ai:', '  providers:', ...providerLines],
    })
    return joinSections(sections)
  }
  const lines = sections[idx].lines
  const providersIdx = lines.findIndex((line) => /^  providers\s*:/.test(line))
  if (providersIdx === -1) {
    sections[idx] = {
      key: 'llm-pi-ai',
      lines: [lines[0], '  providers:', ...providerLines],
    }
    return joinSections(sections)
  }
  const head = lines.slice(0, providersIdx + 1)
  const { blocks, afterProviders } = splitProviderBlocks(lines.slice(providersIdx + 1))
  const kept = []
  let replaced = false
  for (const block of blocks) {
    if (block.key !== route) {
      kept.push(block)
      continue
    }
    replaced = true
    kept.push({ key: route, lines: replaceBlock(block.lines) })
  }
  if (!replaced) kept.push({ key: route, lines: providerLines })
  sections[idx] = {
    key: 'llm-pi-ai',
    lines: [
      ...head,
      ...kept.flatMap((block) => block.lines),
      ...afterProviders,
    ],
  }
  return joinSections(sections)
}

function upsertCustomProvider(yaml, selection) {
  const providerLines = renderCustomProviderBlock(selection).split('\n')
  return upsertProviderSection(yaml, selection.route, providerLines, () => providerLines)
}

function upsertCatalogProvider(yaml, selection) {
  const apiLine = `      apiKeyEnv: ${yamlScalar(selection.keyEnvName)}`
  const providerLines = renderCatalogProviderBlock(selection).split('\n')
  return upsertProviderSection(yaml, selection.route, providerLines, (lines) => {
    const kept = lines.filter((line, index) => index === 0 || !/^\s+apiKeyEnv\s*:/.test(line))
    kept.splice(1, 0, apiLine)
    return kept
  })
}

function isPatchDocument(yaml) {
  return String(yaml).split('\n').some((line) => /^- id:/.test(line))
}

function patchConfigToSection(key, itemLines) {
  const configIdx = itemLines.findIndex((line) => /^  config\s*:\s*$/.test(line))
  if (configIdx === -1) return `${key}:`
  const body = []
  for (const line of itemLines.slice(configIdx + 1)) {
    if (line.trim() === '') {
      body.push('')
      continue
    }
    if (!line.startsWith('    ')) break
    body.push(line.slice(2))
  }
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
  return [`${key}:`, ...body].join('\n')
}

/**
 * Accept a Cordis patch array or a legacy settings.yaml section map.
 * Only llm-pi-ai is returned for merging. Other patch rows are preserved.
 * Legacy sections other than llm-pi-ai are not cordis rows and are dropped.
 * @param {string} yaml
 */
function parseExisting(yaml) {
  const text = String(yaml ?? '').replace(/\r\n/g, '\n')
  if (trim(text) === '') return { llm: '', rawItems: [] }
  if (!isPatchDocument(text)) {
    const llm = splitTopLevel(text).find((section) => section.key === 'llm-pi-ai')
    return { llm: llm ? llm.lines.join('\n') : '', rawItems: [] }
  }
  const items = []
  let current = null
  for (const line of text.split('\n')) {
    if (/^- /.test(line)) {
      if (current) items.push(current)
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }
  if (current) items.push(current)
  let llm = ''
  const rawItems = []
  for (const item of items) {
    const id = /^- id:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/.exec(item[0])
    if (!id) {
      rawItems.push(item)
      continue
    }
    if (id[1] === 'agent-default-model') continue
    if (id[1] === 'llm-pi-ai') {
      llm = patchConfigToSection('llm-pi-ai', item)
      continue
    }
    rawItems.push(item)
  }
  return { llm, rawItems }
}

function sectionTextToPatch(key, text) {
  const lines = String(text).replace(/\n+$/, '').split('\n')
  const body = lines.slice(1).filter((line, index, all) => {
    if (line.trim() !== '') return true
    return all.slice(index + 1).some((later) => later.trim() !== '')
  })
  if (body.length === 0) return `- id: ${key}`
  return [`- id: ${key}`, '  config:', ...body.map((line) => (line.trim() === '' ? '' : `  ${line}`))].join('\n')
}

function emitPatch(modelText, llmText, rawItems) {
  const chunks = [sectionTextToPatch('agent-default-model', modelText)]
  if (trim(llmText) !== '') chunks.push(sectionTextToPatch('llm-pi-ai', llmText))
  for (const raw of rawItems) {
    const text = raw.join('\n').replace(/\n+$/, '').trimEnd()
    if (text !== '') chunks.push(text)
  }
  return `${chunks.join('\n')}\n`
}

const ROLE_PREFIX = {
  ORCHESTRATOR: 'NEO_LLM_ORCHESTRATOR',
  WORKHORSE: 'NEO_LLM_WORKHORSE',
}

const ROLE_FIELDS = ['PROVIDER', 'MODEL', 'API_KEY', 'BASE_URL', 'API', 'API_KEY_ENV', 'REASONING_EFFORT']

function roleValue(env, prefix, field) {
  return trim(env[`${prefix}_${field}`])
}

function activeSelections(profile) {
  return [profile.base, profile.orchestrator, profile.workhorse].filter(Boolean)
}

/**
 * A role is active only when its MODEL is set. Any other role field without
 * MODEL is a partial config and fails startup.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} prefix
 */
function roleModel(env, prefix) {
  const model = roleValue(env, prefix, 'MODEL')
  const partial = ROLE_FIELDS.some((field) => field !== 'MODEL' && roleValue(env, prefix, field) !== '')
  if (model === '' && partial) {
    throw new LlmSettingsError(`${prefix}_MODEL is required when other ${prefix}_* settings are set`)
  }
  return model
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {'ORCHESTRATOR' | 'WORKHORSE'} roleKey
 * @param {ReturnType<typeof resolveLlmSelection>} base
 */
function resolveRole(env, roleKey, base) {
  const prefix = ROLE_PREFIX[roleKey]
  const model = roleModel(env, prefix)
  if (model === '') return undefined

  const providerInput = roleValue(env, prefix, 'PROVIDER') || base.providerInput
  const spec = PROVIDERS[providerInput]
  if (spec === undefined) {
    throw new LlmSettingsError(
      `${prefix}_PROVIDER=${JSON.stringify(providerInput)} is not supported `
        + '(expected deepseek, openai, anthropic, openrouter, or custom)',
    )
  }

  const sameProvider = providerInput === base.providerInput
  const explicitKey = roleValue(env, prefix, 'API_KEY')
  const explicitKeyEnv = roleValue(env, prefix, 'API_KEY_ENV')
  const explicitBaseURL = roleValue(env, prefix, 'BASE_URL')
  const explicitApi = roleValue(env, prefix, 'API')
  let apiKey = explicitKey
  if (apiKey === '') {
    if (sameProvider) apiKey = base.apiKey
    else if (spec.kind !== 'custom') apiKey = trim(env[spec.keyEnv])
  }
  if (spec.kind !== 'custom' && apiKey === '') {
    throw new LlmSettingsError(
      `cloud provider ${providerInput} needs ${spec.keyEnv} or ${prefix}_API_KEY`,
    )
  }

  const reasoningEffort = roleValue(env, prefix, 'REASONING_EFFORT') || undefined
  const role = roleKey.toLowerCase()

  if (spec.kind === 'custom') {
    let keyEnvName
    if (explicitKeyEnv !== '') keyEnvName = explicitKeyEnv
    else if (sameProvider && (explicitKey === '' || explicitKey === base.apiKey)) keyEnvName = base.keyEnvName
    else keyEnvName = `${prefix}_API_KEY`
    if (!API_KEY_ENV_PATTERN.test(keyEnvName)) {
      throw new LlmSettingsError(
        `credential env name ${JSON.stringify(keyEnvName)} must match ${String(API_KEY_ENV_PATTERN)}`,
      )
    }
    const baseURL = explicitBaseURL || (sameProvider ? (base.baseURL || '') : '')
    if (baseURL === '') {
      throw new LlmSettingsError(`${prefix}_PROVIDER=custom requires ${prefix}_BASE_URL`)
    }
    const api = explicitApi || (sameProvider && base.api ? base.api : '') || 'openai-completions'
    return {
      providerInput,
      kind: spec.kind,
      route: spec.route,
      model,
      keyEnvName,
      apiKey,
      baseURL,
      api,
      reasoningEffort,
      role,
    }
  }

  return {
    providerInput,
    kind: spec.kind,
    route: spec.route,
    model,
    keyEnvName: spec.keyEnv,
    apiKey,
    reasoningEffort,
    role,
  }
}

function assignRoutes(profile) {
  /** @type {Map<string, { route: string, models: string[], keyEnvName: string, apiKey: string, api: string, baseURL: string }>} */
  const customGroups = new Map()
  for (const sel of activeSelections(profile)) {
    if (sel.kind !== 'custom') continue
    const groupKey = `${sel.api}\n${sel.baseURL}`
    let group = customGroups.get(groupKey)
    if (!group) {
      const route = sel.role === 'base' ? 'custom' : `custom-${sel.role}`
      group = {
        route,
        models: [],
        keyEnvName: sel.keyEnvName,
        apiKey: sel.apiKey,
        api: sel.api,
        baseURL: sel.baseURL,
      }
      customGroups.set(groupKey, group)
    } else if (group.keyEnvName !== sel.keyEnvName || group.apiKey !== sel.apiKey) {
      throw new LlmSettingsError(
        `custom route ${group.route} would be configured with two different keys`,
      )
    }
    if (!group.models.includes(sel.model)) group.models.push(sel.model)
    sel.route = group.route
    sel.models = group.models
  }

  /** @type {Map<string, { keyEnvName: string, apiKey: string }>} */
  const byRoute = new Map()
  for (const sel of activeSelections(profile)) {
    if (sel.kind === 'custom') continue
    const prev = byRoute.get(sel.route)
    if (!prev) {
      byRoute.set(sel.route, sel)
      continue
    }
    if (prev.keyEnvName !== sel.keyEnvName || prev.apiKey !== sel.apiKey) {
      throw new LlmSettingsError(
        `route ${sel.route} would be configured with two different keys`,
      )
    }
  }
}

function assertDistinctCredentials(profile) {
  /** @type {Record<string, string>} */
  const mapped = {}
  for (const sel of activeSelections(profile)) {
    if (sel.apiKey === '') continue
    const prev = mapped[sel.keyEnvName]
    if (prev !== undefined && prev !== sel.apiKey) {
      throw new LlmSettingsError(
        `credential env ${sel.keyEnvName} would be set to two different keys`,
      )
    }
    mapped[sel.keyEnvName] = sel.apiKey
  }
  if (
    profile.base.apiKey !== ''
    && mapped.NEO_LLM_API_KEY !== undefined
    && mapped.NEO_LLM_API_KEY !== profile.base.apiKey
  ) {
    throw new LlmSettingsError(
      'credential env NEO_LLM_API_KEY would be set to two different keys',
    )
  }
}

/**
 * Base selection plus optional orchestrator (parent chat) and workhorse (delegate children).
 * Custom routes are assigned here. Same endpoint shares one route and its model ids.
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveLlmProfile(env) {
  const base = { ...resolveLlmSelection(env), role: 'base' }
  const profile = {
    base,
    orchestrator: resolveRole(env, 'ORCHESTRATOR', base),
    workhorse: resolveRole(env, 'WORKHORSE', base),
  }
  assignRoutes(profile)
  assertDistinctCredentials(profile)
  return profile
}

function parentForPatch(profile) {
  if (!profile.orchestrator) return profile.base
  return {
    ...profile.orchestrator,
    reasoningEffort: profile.orchestrator.reasoningEffort || profile.base.reasoningEffort,
  }
}

/**
 * Env-owned Cordis patch for the whole profile. Parent row is the orchestrator
 * selection when that role is active, otherwise the base selection.
 * @param {string} existing
 * @param {ReturnType<typeof resolveLlmProfile>} profile
 */
export function renderProfileSettings(existing, profile) {
  const parsed = parseExisting(existing)
  let llm = parsed.llm
  const seenCatalog = new Set()
  const seenCustom = new Set()
  for (const sel of activeSelections(profile)) {
    if (sel.kind === 'catalog' && !seenCatalog.has(sel.route)) {
      seenCatalog.add(sel.route)
      llm = upsertCatalogProvider(llm, sel)
    }
    if (sel.kind === 'custom' && !seenCustom.has(sel.route)) {
      seenCustom.add(sel.route)
      llm = upsertCustomProvider(llm, sel)
    }
  }
  return emitPatch(renderAgentDefaultModel(parentForPatch(profile)), llm, parsed.rawItems)
}

/**
 * Adapter credentials plus internal NEO_RESOLVED_WORKHORSE_* exports.
 * NEO_LLM_API_KEY stays the base key.
 * @param {ReturnType<typeof resolveLlmProfile>} profile
 */
export function mappedProfileEnv(profile) {
  const mapped = mappedCredentialEnv(profile.base)
  for (const sel of [profile.orchestrator, profile.workhorse]) {
    if (!sel || sel.apiKey === '') continue
    if (mapped[sel.keyEnvName] !== undefined && mapped[sel.keyEnvName] !== sel.apiKey) {
      throw new LlmSettingsError(
        `credential env ${sel.keyEnvName} would be set to two different keys`,
      )
    }
    mapped[sel.keyEnvName] = sel.apiKey
  }
  if (profile.workhorse) {
    mapped.NEO_RESOLVED_WORKHORSE_PROVIDER = profile.workhorse.route
    mapped.NEO_RESOLVED_WORKHORSE_MODEL = profile.workhorse.model
    if (profile.workhorse.reasoningEffort) {
      mapped.NEO_RESOLVED_WORKHORSE_REASONING_EFFORT = profile.workhorse.reasoningEffort
    }
  }
  return mapped
}

/**
 * Render the env-owned Cordis patch for one selection. Native DeepSeek sets
 * agent-default-model only. Catalog routes also set apiKeyEnv and omit api,
 * baseURL, and models. Custom upserts a full provider object.
 * @param {ReturnType<typeof resolveLlmSelection>} selection
 */
export function renderOwnedSettings(selection) {
  return mergeSettingsYaml('', selection)
}

/**
 * Env wins for agent-default-model on every boot.
 * Catalog updates apiKeyEnv and keeps api / models / baseURL plus siblings.
 * Custom upserts only the custom route. Native leaves an existing llm-pi-ai row.
 * @param {string} existing
 * @param {ReturnType<typeof resolveLlmSelection>} selection
 */
export function mergeSettingsYaml(existing, selection) {
  const parsed = parseExisting(existing)
  let llm = parsed.llm
  if (selection.kind === 'custom') llm = upsertCustomProvider(llm, selection)
  else if (selection.kind === 'catalog') llm = upsertCatalogProvider(llm, selection)
  return emitPatch(renderAgentDefaultModel(selection), llm, parsed.rawItems)
}

function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function printExports(mapped) {
  let out = ''
  for (const [key, value] of Object.entries(mapped)) {
    out += `export ${key}=${shSingleQuote(value)}\n`
  }
  return out
}

function parseArgs(argv) {
  const flags = { print: false, exportEnv: false, dshHome: undefined, write: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--print') flags.print = true
    else if (arg === '--export') flags.exportEnv = true
    else if (arg === '--dsh-home') {
      flags.dshHome = argv[i + 1]
      i += 1
    } else if (arg === '--write') {
      flags.write = argv[i + 1]
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true
    } else {
      throw new LlmSettingsError(`unknown argument: ${arg}`)
    }
  }
  return flags
}

function patchPath(dshHome) {
  return `${dshHome.replace(/[/\\]+$/, '')}/${PATCH_FILENAME}`
}

async function main(argv, env, io) {
  const flags = parseArgs(argv)
  if (flags.help) {
    io.stdout.write(
      'render-llm-settings.mjs [--print] [--export] [--dsh-home DIR] [--write FILE]\n',
    )
    return 0
  }

  const profile = resolveLlmProfile(env)
  const mapped = mappedProfileEnv(profile)
  const dshHome = flags.dshHome || trim(env.DSH_HOME)
  const writePath = flags.write || (dshHome !== '' ? patchPath(dshHome) : undefined)

  if (flags.print && writePath === undefined) {
    io.stdout.write(renderProfileSettings('', profile))
    if (flags.exportEnv) io.stdout.write(printExports(mapped))
    return 0
  }

  if (writePath === undefined && !flags.print) {
    throw new LlmSettingsError('set DSH_HOME or pass --dsh-home / --write / --print')
  }

  if (writePath !== undefined) {
    const { mkdir, readFile, writeFile } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(writePath), { recursive: true })
    let existing = ''
    try {
      existing = await readFile(writePath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const merged = renderProfileSettings(existing, profile)
    await writeFile(writePath, merged, { encoding: 'utf8', mode: 0o600 })
    if (flags.print) io.stdout.write(merged)
  }

  if (flags.exportEnv) io.stdout.write(printExports(mapped))
  return 0
}

const { pathToFileURL } = await import('node:url')
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const code = await main(process.argv.slice(2), process.env, {
      stdout: process.stdout,
      stderr: process.stderr,
    })
    process.exitCode = code
  } catch (error) {
    const message = error instanceof LlmSettingsError ? error.message : String(error?.stack ?? error)
    process.stderr.write(`neo-llm: ${message}\n`)
    process.exitCode = 1
  }
}
