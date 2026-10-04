#!/usr/bin/env node
/**
 * Import host CLI OAuth tokens into $DSH_HOME/.credentials.yaml.
 *
 * Host file wins. An existing llm-pi-ai/<route> grant is kept when the host
 * file is missing. Startup fails closed when an oauth alias is selected and
 * neither source has a usable grant. PKCE localhost callbacks are out of v1.
 *
 * Record shape matches dsh-credentials-local at
 * 5badb15009ae1756c3afe0ae0cef1faafc290ccc: version 1, records keyed
 * llm-pi-ai/<route>, kind grant, payload the pi-ai oauth credential.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Document, parse, parseDocument } from 'yaml'
import { resolveLlmProfile } from './render-llm-settings.mjs'

const CREDENTIALS_FILENAME = '.credentials.yaml'
const RECORD_SCOPE = 'llm-pi-ai'
const JWT_AUTH_CLAIM = 'https://api.openai.com/auth'

export class LlmOAuthImportError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LlmOAuthImportError'
  }
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function decodeJwt(token) {
  const parts = String(token).split('.')
  if (parts.length < 2) return null
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function accountIdFromJwt(access) {
  const accountId = decodeJwt(access)?.[JWT_AUTH_CLAIM]?.chatgpt_account_id
  return typeof accountId === 'string' && accountId !== '' ? accountId : null
}

function expiresFromJwt(access) {
  const exp = decodeJwt(access)?.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
}

function expiresFromValue(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value !== '') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 1e12 ? numeric * 1000 : numeric
    }
  }
  return null
}

function requireOauthPair(access, refresh, label) {
  if (typeof access !== 'string' || access === '' || typeof refresh !== 'string' || refresh === '') {
    throw new LlmOAuthImportError(label)
  }
}

function asPiGrant(json) {
  if (
    json
    && json.type === 'oauth'
    && typeof json.access === 'string'
    && json.access !== ''
    && typeof json.refresh === 'string'
    && json.refresh !== ''
  ) {
    return json
  }
  return null
}

export function parseCodexAuth(json) {
  const existing = asPiGrant(json)
  const tokens = json?.tokens
  const access = existing?.access || tokens?.access_token
  const refresh = existing?.refresh || tokens?.refresh_token
  requireOauthPair(
    access,
    refresh,
    'Codex auth.json is missing tokens.access_token or tokens.refresh_token',
  )
  const accountId =
    (typeof existing?.accountId === 'string' && existing.accountId)
    || (typeof tokens?.account_id === 'string' && tokens.account_id)
    || accountIdFromJwt(access)
  if (!accountId) {
    throw new LlmOAuthImportError('Codex token is missing accountId')
  }
  const expires =
    (typeof existing?.expires === 'number' && existing.expires)
    || expiresFromValue(tokens?.expires_at)
    || expiresFromJwt(access)
    || Date.now() + 60 * 60 * 1000
  return {
    type: 'oauth',
    access,
    refresh,
    expires,
    accountId,
  }
}

export function parseClaudeAuth(json) {
  const existing = asPiGrant(json)
  if (existing) {
    return {
      type: 'oauth',
      access: existing.access,
      refresh: existing.refresh,
      expires: existing.expires || Date.now() + 60 * 60 * 1000,
    }
  }
  const oauth = json?.claudeAiOauth
  const access = oauth?.accessToken
  const refresh = oauth?.refreshToken
  requireOauthPair(
    access,
    refresh,
    'Claude credentials file is missing claudeAiOauth access/refresh tokens',
  )
  return {
    type: 'oauth',
    access,
    refresh,
    expires: expiresFromValue(oauth.expiresAt) || Date.now() + 60 * 60 * 1000,
  }
}

function grokSessionGrant(cred) {
  if (!cred || typeof cred !== 'object') return null
  if (cred.auth_mode === 'api_key' || cred.auth_mode === 'web_login') return null
  const access = cred.key || cred.access_token
  const refresh = cred.refresh_token
  if (typeof access !== 'string' || access === '' || typeof refresh !== 'string' || refresh === '') {
    return null
  }
  return {
    type: 'oauth',
    access,
    refresh,
    expires: expiresFromValue(cred.expires_at || cred.expires) || Date.now() + 60 * 60 * 1000,
  }
}

export function parseGrokAuth(json) {
  const existing = asPiGrant(json)
  if (existing) {
    return {
      type: 'oauth',
      access: existing.access,
      refresh: existing.refresh,
      expires: existing.expires || Date.now() + 60 * 60 * 1000,
    }
  }
  const top = grokSessionGrant(json)
  if (top) return top
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    for (const [scope, cred] of Object.entries(json)) {
      if (scope === 'xai::api_key') continue
      const grant = grokSessionGrant(cred)
      if (grant) return grant
    }
  }
  throw new LlmOAuthImportError(
    'Grok auth.json has no OIDC session with a refresh token',
  )
}

const OAUTH_ALIASES = {
  chatgpt: {
    route: 'openai-codex',
    fileEnv: 'NEO_LLM_OAUTH_CHATGPT_FILE',
    defaultFile: '/host-auth/codex/auth.json',
    parse: parseCodexAuth,
    label: 'ChatGPT',
  },
  claude: {
    route: 'anthropic',
    fileEnv: 'NEO_LLM_OAUTH_CLAUDE_FILE',
    defaultFile: '/host-auth/claude/.credentials.json',
    parse: parseClaudeAuth,
    label: 'Claude',
  },
  grok: {
    route: 'xai',
    fileEnv: 'NEO_LLM_OAUTH_GROK_FILE',
    defaultFile: '/host-auth/grok/auth.json',
    parse: parseGrokAuth,
    label: 'Grok',
  },
}

function recordKey(route) {
  return `${RECORD_SCOPE}/${route}`
}

function isUsableGrant(record) {
  const payload = record?.payload
  return (
    record?.kind === 'grant'
    && payload?.type === 'oauth'
    && typeof payload.access === 'string'
    && payload.access !== ''
    && typeof payload.refresh === 'string'
    && payload.refresh !== ''
  )
}

function loadRecords(text) {
  if (trim(text) === '') return {}
  let data
  try {
    data = parse(text)
  } catch (error) {
    throw new LlmOAuthImportError(
      `invalid .credentials.yaml: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    throw new LlmOAuthImportError('invalid .credentials.yaml: root must be a mapping')
  }
  if (data.records == null) return {}
  if (typeof data.records !== 'object' || Array.isArray(data.records)) {
    throw new LlmOAuthImportError('invalid .credentials.yaml: records must be a mapping')
  }
  return data.records
}

function applyGrants(existingText, updates) {
  const doc =
    trim(existingText) === ''
      ? new Document({ version: 1, records: {} })
      : parseDocument(existingText, {
          version: '1.2',
          uniqueKeys: true,
          strict: true,
        })
  if (doc.errors && doc.errors.length > 0) {
    throw new LlmOAuthImportError(`invalid .credentials.yaml: ${doc.errors[0].message}`)
  }
  if (doc.get('version') == null) doc.set('version', 1)
  if (doc.get('records') == null) doc.set('records', {})
  const records = doc.get('records')
  for (const { spec, grant } of updates) {
    records.set(recordKey(spec.route), {
      kind: 'grant',
      payload: JSON.parse(JSON.stringify(grant)),
    })
  }
  return String(doc)
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

function neededAliases(env) {
  const profile = resolveLlmProfile(env)
  const needed = []
  const seen = new Set()
  for (const sel of [profile.base, profile.orchestrator, profile.workhorse]) {
    if (!sel || sel.kind !== 'oauth') continue
    if (seen.has(sel.route)) continue
    seen.add(sel.route)
    const spec = OAUTH_ALIASES[sel.providerInput]
    if (spec === undefined) {
      throw new LlmOAuthImportError(
        `oauth alias ${JSON.stringify(sel.providerInput)} has no CLI import mapping`,
      )
    }
    needed.push(spec)
  }
  return needed
}

function parseHostGrant(spec, text) {
  let json
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new LlmOAuthImportError(
      `${spec.label} credentials at ${spec.fileEnv} are not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  return spec.parse(json)
}

/**
 * Import CLI OAuth grants for every oauth alias in the resolved profile.
 * @param {{ env: NodeJS.ProcessEnv, dshHome: string }} input
 */
export async function importLlmOAuth({ env, dshHome }) {
  const needed = neededAliases(env)
  if (needed.length === 0) return { imported: [] }

  const credPath = join(dshHome.replace(/[/\\]+$/, ''), CREDENTIALS_FILENAME)
  const existingText = (await readOptional(credPath)) || ''
  const records = loadRecords(existingText)
  const updates = []

  for (const spec of needed) {
    const hostPath = trim(env[spec.fileEnv]) || spec.defaultFile
    const hostText = await readOptional(hostPath)
    if (hostText !== null) {
      updates.push({ spec, grant: parseHostGrant(spec, hostText) })
      continue
    }
    if (isUsableGrant(records[recordKey(spec.route)])) continue
    throw new LlmOAuthImportError(
      `no ${spec.label} subscription token for ${spec.route}. ` +
        `Mount the CLI credential at ${spec.defaultFile} (or set ${spec.fileEnv}), ` +
        'or complete device-code sign-in from docker compose logs dsh.',
    )
  }

  if (updates.length === 0) return { imported: [] }

  const next = applyGrants(existingText, updates)
  await mkdir(dshHome, { recursive: true })
  await writeFile(credPath, next, { encoding: 'utf8', mode: 0o600 })
  await chmod(credPath, 0o600)
  return { imported: updates.map((item) => item.spec.route) }
}

function parseArgs(argv) {
  const flags = { dshHome: undefined, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dsh-home') {
      flags.dshHome = argv[i + 1]
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true
    } else {
      throw new LlmOAuthImportError(`unknown argument: ${arg}`)
    }
  }
  return flags
}

async function main(argv, env, io) {
  const flags = parseArgs(argv)
  if (flags.help) {
    io.stdout.write('import-llm-oauth.mjs [--dsh-home DIR]\n')
    return 0
  }
  const dshHome = flags.dshHome || trim(env.DSH_HOME)
  if (dshHome === '') {
    throw new LlmOAuthImportError('set DSH_HOME or pass --dsh-home')
  }
  await importLlmOAuth({ env, dshHome })
  return 0
}

const { pathToFileURL } = await import('node:url')
if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const code = await main(process.argv.slice(2), process.env, {
      stdout: process.stdout,
      stderr: process.stderr,
    })
    process.exitCode = code
  } catch (error) {
    const message =
      error instanceof LlmOAuthImportError
        ? error.message
        : String(error?.stack ?? error)
    process.stderr.write(`neo-llm-oauth: ${message}\n`)
    process.exitCode = 1
  }
}
