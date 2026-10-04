import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
const image = process.env.NEO_WORKER_TEST_IMAGE || 'neo-sandbox:remediation'
if (process.env.NEO_WORKER_SKIP_BUILD !== '1') {
  const build = spawnSync('docker', ['build', '-t', image, 'docker/sandbox'], {
    stdio: 'inherit',
  })
  if (build.status !== 0) process.exit(build.status || 1)
}
const result = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    image,
    'neo-capabilities',
  ],
  { encoding: 'utf8', timeout: 90000 },
)
if (result.status !== 0)
  throw new Error(
    result.stderr || result.error?.message || 'Worker capability probe failed',
  )
const report = JSON.parse(result.stdout)
const required = [
  'bash',
  'git',
  'gh',
  'python3',
  'node',
  'nuclei',
  'vulnx',
  'subfinder',
  'dnsx',
  'httpx',
  'naabu',
  'katana',
  'tlsx',
  'interactsh-client',
  'nmap',
  'sqlmap',
  'ffuf',
  'semgrep',
  'gitleaks',
  'trufflehog',
  'hydra',
  'adb',
  'ssh',
  'chisel',
  'kerbrute',
  'impacket-smbclient',
]
for (const tool of required) {
  assert.equal(
    report.tools[tool]?.available,
    true,
    `${tool} is missing from the worker`,
  )
  const probe = report.tools[tool]
  // Hydra deliberately exits nonzero after displaying its help text.
  if (tool === 'hydra') {
    assert.equal(probe.probe_status, 'nonzero')
    assert.match(probe.probe, /^Hydra v\d/)
  } else {
    assert.equal(
      probe.probe_status,
      'ok',
      `${tool} failed its version/help probe: ${probe.probe_status}: ${probe.probe}`,
    )
  }
}
assert.equal(report.python_modules.impacket.available, true)
assert.equal(report.network.external_scanners, false)
assert.equal(report.hardware.usb_devices, false)
const identity = spawnSync(
  'docker',
  ['run', '--rm', '--network', 'none', image, 'id', '-u'],
  { encoding: 'utf8' },
)
assert.equal(identity.status, 0)
assert.equal(identity.stdout.trim(), '1000')
console.log(
  `Worker image: ${required.length} required CLI probes, Impacket module and non-root identity verified`,
)
