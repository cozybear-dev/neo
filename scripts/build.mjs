import { readdirSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
const compiler = resolve('node_modules/typescript/bin/tsc')
if (!existsSync(compiler)) throw new Error('Run npm ci before building')
const packages = [
  'control',
  ...readdirSync('plugins')
    .filter((name) => !name.startsWith('.'))
    .map((name) => `plugins/${name}`),
].filter((path) => existsSync(`${path}/tsconfig.json`))
for (const dir of packages) {
  // dist is generated-only; remove stale exports and legacy root-owned files.
  if (!process.argv.includes('--check'))
    rmSync(`${dir}/dist`, { recursive: true, force: true })
  const args = [
    compiler,
    '-p',
    `${dir}/tsconfig.json`,
    ...(process.argv.includes('--check') ? ['--noEmit'] : []),
  ]
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}
console.log(
  `${process.argv.includes('--check') ? 'Checked' : 'Built'} ${packages.length} packages`,
)
