import { spawnSync } from 'node:child_process'
const image = process.env.NEO_HARNESS_IMAGE || 'neo-dsh:local'
if (process.env.NEO_HARNESS_SKIP_BUILD !== '1') {
  const build = spawnSync(
    'docker',
    ['build', '-f', 'docker/dsh/Dockerfile', '-t', image, '.'],
    { stdio: 'inherit' },
  )
  if (build.status !== 0) process.exit(build.status || 1)
}
// No host credentials, Docker socket, or persistent data is passed into this test.
const result = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--network',
    'none',
    '-e',
    'NEO_LLM_API_KEY=fixture',
    '-e',
    'NEO_LLM_MODEL=deepseek-v4-flash',
    image,
    'node',
    '/opt/neo/tests/harness/run.mjs',
  ],
  { stdio: 'inherit', timeout: 180000 },
)
process.exitCode = result.status || (result.error ? 1 : 0)
