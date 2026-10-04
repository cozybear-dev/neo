import { readdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 19) || major === 23)
  throw new Error(
    'Neo requires Node 22.19+ (22.x) or Node >=24; see .node-version',
  )
const roots = [
  'tests/unit',
  'tests/integration',
  ...readdirSync('plugins')
    .filter((name) => !name.startsWith('.'))
    .map((name) => `plugins/${name}`),
]
function find(path) {
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? ['node_modules', 'dist'].includes(entry.name)
        ? []
        : find(`${path}/${entry.name}`)
      : /\.test\.(?:ts|mjs)$/.test(entry.name)
        ? [`${path}/${entry.name}`]
        : [],
  )
}
const result = spawnSync(process.execPath, ['--test', ...roots.flatMap(find)], {
  stdio: 'inherit',
})
process.exitCode = result.status || (result.error ? 1 : 0)
