#!/usr/bin/env node
/**
 * Render $DSH_HOME/settings.yaml from NEO_LLM_* env.
 *
 * Field names copied from deepseek-ai/deepseek-harness
 * 141eb6fef83422698aef7a981029e843e8161534:
 *   agent-default-model.{provider,model,reasoningEffort}
 *   llm-pi-ai.providers.<route>.{apiKeyEnv,api,baseURL,models:[{id}]}
 *
 * Catalog adapter ids from that SHA's pi-ai directory
 * (apps/web/tests/snapshots/models-settings/empty.expected.md):
 *   openai, anthropic, openrouter, …
 * Native DeepSeek adapter route is `deepseek-official` (llm-deepseek),
 * not the pi-ai catalog id `deepseek`.
 */

const NATIVE_DEEPSEEK_ROUTE = 'deepseek-official'

/** NEO_LLM_PROVIDER → DSH route + credential env (catalog ids verbatim). */
const PROVIDERS = {
  deepseek: { kind: 'native', route: NATIVE_DEEPSEEK_ROUTE, keyEnv: 'DEEPSEEK_API_KEY' },
  openai: { kind: 'catalog', route: 'openai', keyEnv: 'OPENAI_API_KEY' },
  anthropic: { kind: 'catalog', route: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY' },
  openrouter: { kind: 'catalog', route: 'openrouter', keyEnv: 'OPENROUTER_API_KEY' },
  custom: { kind: 'custom', route: 'custom', keyEnv: 'NEO_LLM_API_KEY' },
}

const API_KEY_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const OWNED_NAMESPACES = new Set(['agent-default-model', 'llm-pi-ai'])

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

/**
 * Render owned settings.yaml namespaces. deepseek → no llm-pi-ai / custom block.
 * @param {ReturnType<typeof resolveLlmSelection>} selection
 */
export function renderOwnedSettings(selection) {
  const defaultModel = [
    'agent-default-model:',
    `  provider: ${yamlScalar(selection.route)}`,
    `  model: ${yamlScalar(selection.model)}`,
  ]
  if (selection.reasoningEffort !== undefined) {
    defaultModel.push(`  reasoningEffort: ${yamlScalar(selection.reasoningEffort)}`)
  }

  if (selection.kind === 'native') {
    return `${defaultModel.join('\n')}\n`
  }

  const profileLines = [
    `      apiKeyEnv: ${yamlScalar(selection.keyEnvName)}`,
  ]
  if (selection.kind === 'custom') {
    profileLines.push(`      api: ${yamlScalar(selection.api)}`)
    profileLines.push(`      baseURL: ${yamlScalar(selection.baseURL)}`)
    profileLines.push('      models:')
    profileLines.push(`        - id: ${yamlScalar(selection.model)}`)
  }

  return [
    ...defaultModel,
    'llm-pi-ai:',
    '  providers:',
    `    ${selection.route}:`,
    ...profileLines,
    '',
  ].join('\n')
}

/**
 * Drop previously written agent-default-model / llm-pi-ai sections so env wins.
 * @param {string} yaml
 */
export function stripOwnedNamespaces(yaml) {
  if (trim(yaml) === '') return ''
  const lines = yaml.split(/\r?\n/)
  const kept = []
  let skipping = false
  for (const line of lines) {
    const top = /^([A-Za-z0-9_-]+)\s*:/.exec(line)
    if (top && !/^\s/.test(line)) {
      skipping = OWNED_NAMESPACES.has(top[1])
    }
    if (!skipping) kept.push(line)
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Merge owned namespaces over an existing settings.yaml body.
 * @param {string} existing
 * @param {ReturnType<typeof resolveLlmSelection>} selection
 */
export function mergeSettingsYaml(existing, selection) {
  const rest = stripOwnedNamespaces(existing)
  const owned = renderOwnedSettings(selection).trimEnd()
  if (rest === '') return `${owned}\n`
  return `${rest}\n\n${owned}\n`
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

async function main(argv, env, io) {
  const flags = parseArgs(argv)
  if (flags.help) {
    io.stdout.write(
      'render-llm-settings.mjs [--print] [--export] [--dsh-home DIR] [--write FILE]\n',
    )
    return 0
  }

  const selection = resolveLlmSelection(env)
  const mapped = mappedCredentialEnv(selection)
  const dshHome = flags.dshHome || trim(env.DSH_HOME)
  const writePath = flags.write || (dshHome !== '' ? `${dshHome.replace(/[/\\]+$/, '')}/settings.yaml` : undefined)

  if (flags.print && writePath === undefined) {
    io.stdout.write(renderOwnedSettings(selection))
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
    const merged = mergeSettingsYaml(existing, selection)
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
