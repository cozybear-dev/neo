import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

describe('DSH permission mode in the compose stack', () => {
  it('defaults DSH_PERMISSION_MODE to danger-full-access (no same-world sandbox backend in Docker/WSL2)', () => {
    const compose = read('docker-compose.yml')
    const entrypoint = read('docker/dsh/entrypoint.sh')
    const patch = read('plugins/neo-profile/cordis.patch.yml')

    assert.match(
      compose,
      /DSH_PERMISSION_MODE:\s*\$\{DSH_PERMISSION_MODE:-danger-full-access\}/,
    )
    assert.match(
      entrypoint,
      /DSH_PERMISSION_MODE="\$\{DSH_PERMISSION_MODE:-danger-full-access\}"/,
    )
    assert.match(patch, /id:\s*sandbox-policy/)
    assert.match(
      patch,
      /process\.env\.DSH_PERMISSION_MODE \?\? 'danger-full-access'/,
    )
  })

  it('uses task directories and never grants world access', () => {
    const entrypoint = read('docker/dsh/entrypoint.sh')
    assert.match(entrypoint, /NEO_WORKSPACE_BASE.*tasks/)
    assert.match(entrypoint, /chmod 750/)
    assert.doesNotMatch(entrypoint, /chmod (1777|a\+r)/)
    assert.match(entrypoint, /mktemp/)
    assert.match(entrypoint, /chmod 600/)
  })

  it('runs DSH and workers as unprivileged users without sudo', () => {
    assert.match(read('docker/dsh/Dockerfile'), /^USER node$/m)
    assert.match(read('docker/sandbox/Dockerfile'), /^USER neo$/m)
    assert.doesNotMatch(
      read('docker/sandbox/Dockerfile'),
      /NOPASSWD|^\s+sudo\s/m,
    )
  })
})
