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

  it('makes /workspace sticky-world-writable for sandbox user neo', () => {
    const entrypoint = read('docker/dsh/entrypoint.sh')
    assert.match(entrypoint, /chmod 1777 \/workspace/)
    assert.match(
      entrypoint,
      /for d in agents explore recon research sandbox browser verification/,
    )
    assert.match(entrypoint, /chmod 1777 "\/workspace\/\$\{d\}"/)
  })

  it('sandbox entrypoint chmods /workspace as root then drops to neo', () => {
    const entrypoint = read('docker/sandbox/entrypoint.sh')
    const dockerfile = read('docker/sandbox/Dockerfile')
    assert.match(entrypoint, /chmod 1777 \/workspace/)
    assert.match(entrypoint, /runuser -u neo --/)
    assert.match(dockerfile, /COPY\s+entrypoint\.sh/)
    assert.match(dockerfile, /ENTRYPOINT\s+\["\/entrypoint\.sh"\]/)
    assert.doesNotMatch(dockerfile, /^USER neo$/m)
  })
})
