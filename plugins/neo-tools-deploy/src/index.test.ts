import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ALLOWED_NETWORK,
  assertAllowedNetwork,
  composeProjectName,
  DeployNetworkError,
  deployDown,
  deployUp,
  targetsNetworkName,
  type ExecResult,
  type FsLike,
  type SpawnFn,
} from './client.ts'

function memoryFs(): FsLike & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    async mkdir() {},
    async writeFile(path, data) {
      files.set(path, typeof data === 'string' ? data : data.toString())
    },
    async appendFile(path, data) {
      files.set(path, (files.get(path) ?? '') + data)
    },
    async rm() {},
  }
}

describe('assertAllowedNetwork', () => {
  it('allows targets', () => {
    assert.equal(assertAllowedNetwork('targets'), 'targets')
    assert.equal(assertAllowedNetwork(undefined), ALLOWED_NETWORK)
  })

  it('refuses control', () => {
    assert.throws(() => assertAllowedNetwork('control'), DeployNetworkError)
    assert.throws(() => assertAllowedNetwork('control'), /only 'targets' is allowed/)
  })

  it('refuses bridge', () => {
    assert.throws(() => assertAllowedNetwork('bridge'), DeployNetworkError)
    assert.throws(() => assertAllowedNetwork('bridge'), /refuses network 'bridge'/)
  })

  it('refuses any other network name', () => {
    assert.throws(() => assertAllowedNetwork('host'), /host/)
    assert.throws(() => assertAllowedNetwork(''), /\(empty\)/)
  })
})

describe('composeProjectName', () => {
  it('uses neo-target-<id>', () => {
    assert.equal(composeProjectName('abc12'), 'neo-target-abc12')
  })
})

describe('targetsNetworkName', () => {
  it('defaults to neo_targets', () => {
    assert.equal(targetsNetworkName({}), 'neo_targets')
  })

  it('honors NEO_TARGETS_NETWORK', () => {
    assert.equal(targetsNetworkName({ NEO_TARGETS_NETWORK: 'custom_targets' }), 'custom_targets')
  })
})

describe('deploy_up network gate', () => {
  it('hard-fails before docker when network is control', async () => {
    const calls: string[] = []
    const spawn: SpawnFn = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    await assert.rejects(
      () => deployUp(
        { source: 'image', ref: 'nginx:alpine', network: 'control', id: 'x1' },
        { spawn, fs: memoryFs(), env: { NEO_WORKSPACE: '/workspace' } },
      ),
      (err: unknown) => {
        assert.ok(err instanceof DeployNetworkError)
        assert.equal(err.network, 'control')
        return true
      },
    )
    assert.equal(calls.length, 0)
  })

  it('hard-fails before docker when network is bridge', async () => {
    const calls: string[] = []
    const spawn: SpawnFn = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    await assert.rejects(
      () => deployUp(
        { source: 'compose', ref: '/tmp/c.yml', network: 'bridge', id: 'x2' },
        { spawn, fs: memoryFs(), env: {} },
      ),
      DeployNetworkError,
    )
    assert.equal(calls.length, 0)
  })

  it('allows targets and runs docker compose -p neo-target-<id>', async () => {
    const calls: string[][] = []
    const fs = memoryFs()
    const spawn: SpawnFn = async (cmd, args) => {
      calls.push([cmd, ...args])
      return { stdout: 'ok\n', stderr: '', exitCode: 0 }
    }
    const result = await deployUp(
      { source: 'compose', ref: '/workspace/lab/docker-compose.yml', network: 'targets', id: 'lab1' },
      { spawn, fs, env: { NEO_WORKSPACE: '/workspace', NEO_TARGETS_NETWORK: 'neo_targets' } },
    )
    assert.equal(result.id, 'lab1')
    assert.equal(result.project, 'neo-target-lab1')
    assert.equal(result.network, 'targets')
    assert.equal(result.logPath, '/workspace/deploy/lab1/compose.log')
    assert.match(result.baseUrl, /lab1/)
    const composeCall = calls.find((c) => c[0] === 'docker' && c[1] === 'compose')
    assert.ok(composeCall)
    assert.equal(composeCall![2], '-p')
    assert.equal(composeCall![3], 'neo-target-lab1')
    assert.ok(composeCall!.includes('up'))
    const override = fs.files.get('/workspace/deploy/lab1/network.override.yml') ?? ''
    assert.match(override, /neo_targets/)
    assert.match(override, /external: true/)
  })

  it('image source attaches to neo_targets only', async () => {
    const calls: string[][] = []
    const spawn: SpawnFn = async (cmd, args) => {
      calls.push([cmd, ...args])
      return { stdout: 'cid\n', stderr: '', exitCode: 0 }
    }
    await deployUp(
      { source: 'image', ref: 'ghcr.io/juice-shop/juice-shop:latest', id: 'js1' },
      { spawn, fs: memoryFs(), env: { NEO_WORKSPACE: '/workspace' } },
    )
    const run = calls.find((c) => c[0] === 'docker' && c[1] === 'run')
    assert.ok(run)
    const netIdx = run!.indexOf('--network')
    assert.ok(netIdx >= 0)
    assert.equal(run![netIdx + 1], 'neo_targets')
    assert.ok(run!.includes('neo-target-js1-app'))
  })
})

describe('deploy_down', () => {
  it('runs docker compose -p neo-target-<id> down', async () => {
    const calls: string[][] = []
    const spawn: SpawnFn = async (cmd, args) => {
      calls.push([cmd, ...args])
      return { stdout: '', stderr: '', exitCode: 0 } satisfies ExecResult
    }
    const result = await deployDown(
      { id: 'lab1' },
      { spawn, fs: memoryFs(), env: { NEO_WORKSPACE: '/workspace' } },
    )
    assert.deepEqual(result, { id: 'lab1', project: 'neo-target-lab1', ok: true })
    const down = calls.find((c) => c.includes('down'))
    assert.ok(down)
    assert.equal(down![0], 'docker')
    assert.equal(down![1], 'compose')
    assert.equal(down![3], 'neo-target-lab1')
  })
})
