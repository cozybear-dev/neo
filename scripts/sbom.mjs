import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
await mkdir('dist/sbom', { recursive: true })
for (const [name, dir] of [
  ['runtime', '.'],
  ['control', 'control'],
]) {
  const lock = JSON.parse(await readFile(`${dir}/package-lock.json`, 'utf8'))
  const unique = new Map()
  for (const [path, item] of Object.entries(lock.packages || {})) {
    if (!path || item.dev || item.link || !item.version) continue
    const packageName = item.name || path.split('node_modules/').at(-1)
    const purl = `pkg:npm/${packageName.replace('@', '%40')}@${item.version}`
    const component = {
      type: 'library',
      name: packageName,
      version: item.version,
      purl,
      'bom-ref': purl,
    }
    const match = /^sha(256|384|512)-([^ ]+)/.exec(item.integrity || '')
    if (match)
      component.hashes = [
        {
          alg: `SHA-${match[1]}`,
          content: Buffer.from(match[2], 'base64').toString('hex'),
        },
      ]
    if (item.resolved?.startsWith('https:'))
      component.externalReferences = [
        { type: 'distribution', url: item.resolved },
      ]
    unique.set(purl, component)
  }
  const document = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: 'application',
        name: lock.name || name,
        version: lock.version || '0.0.0',
      },
    },
    components: [...unique.values()],
  }
  await writeFile(
    `dist/sbom/${name}.cdx.json`,
    JSON.stringify(document, null, 2) + '\n',
  )
}
console.log(
  'CycloneDX application dependency inventories: dist/sbom/ (OS and scanner dependencies are separate image inventory)',
)
