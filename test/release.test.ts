import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  auditEntries, digests, packageName, readArchive, registryState, releaseAssetState,
  repository, validateManifest, validateRelease, packageDirectory, preparePackageDirectory, writeNewArchive,
} from '../scripts/release.mjs'

const require = createRequire(import.meta.url)
const { load } = require('js-yaml')
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const sha = 'a'.repeat(40)
const event = () => ({ action: 'published', repository: { full_name: repository }, release: {
  tag_name: `v${manifest.version}`, draft: false, prerelease: false,
} })
const context = () => ({ eventName: 'release', repository, sha, head: sha, tagSha: sha })
const hashes = digests(Buffer.from('tested release archive'))
const metadata = () => ({ name: packageName, 'dist-tags': { latest: manifest.version }, versions: {
  [manifest.version]: { name: packageName, version: manifest.version, dist: { shasum: hashes.sha1, integrity: hashes.integrity } },
} })
const entries = () => new Map([
  ['package/package.json', Buffer.from(JSON.stringify(manifest))],
  ['package/README.md', Buffer.from('Usage')],
  ['package/LICENSE', Buffer.from('MIT')],
  ['package/lib/index.js', Buffer.from('exports.name = "codex-resets"')],
  ['package/lib/index.d.ts', Buffer.from('export declare const name: string')],
])

function archive(name: string, content: string, type = '0') {
  const header = Buffer.alloc(512)
  header.write(name)
  header.write(Buffer.byteLength(content).toString(8).padStart(11, '0') + '\0', 124)
  header.fill(32, 148, 156)
  header.write(type, 156)
  const checksum = header.reduce((sum, value) => sum + value, 0)
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148)
  const data = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512)
  data.write(content)
  return gzipSync(Buffer.concat([header, data, Buffer.alloc(1024)]))
}

describe('explicit release publishing', () => {
  it('accepts the matching published stable release and unchanged lockfile', () => {
    expect(() => validateRelease(event(), context(), manifest, lock)).not.toThrow()
  })

  it.each(['push', 'pull_request', 'workflow_dispatch'])('rejects a %s event', eventName => {
    expect(() => validateRelease(event(), { ...context(), eventName }, manifest, lock)).toThrow('Only a Release')
  })

  it.each(['draft', 'prerelease'] as const)('rejects a %s release', flag => {
    const input = event()
    input.release[flag] = true
    expect(() => validateRelease(input, context(), manifest, lock)).toThrow()
  })

  it('rejects edited releases, foreign repositories, wrong tags and mismatched commits', () => {
    for (const input of [
      { ...event(), action: 'edited' },
      { ...event(), repository: { full_name: 'someone/another-repo' } },
      { ...event(), release: { ...event().release, tag_name: 'v9.9.9' } },
    ]) expect(() => validateRelease(input, context(), manifest, lock)).toThrow()
    for (const key of ['head', 'tagSha', 'sha', 'repository']) {
      expect(() => validateRelease(event(), { ...context(), [key]: 'different' }, manifest, lock)).toThrow()
    }
  })

  it('rejects an implicit/prerelease version, mismatched lockfile or destination', () => {
    for (const version of ['0.5.2-beta.1', 'v0.5.2', '01.5.2', '0.5', '0.5.2\n']) {
      expect(() => validateManifest({ ...manifest, version }, lock)).toThrow()
    }
    expect(() => validateManifest(manifest, { ...lock, version: '0.0.0' })).toThrow()
    expect(() => validateManifest(manifest, { ...lock, packages: { '': { version: '0.0.0' } } })).toThrow()
    expect(() => validateManifest({ ...manifest, repository: { url: 'https://example.invalid/' } }, lock)).toThrow()
    expect(() => validateManifest({ ...manifest, publishConfig: { ...manifest.publishConfig, access: 'restricted' } }, lock)).toThrow()
  })

  it('audits the real allowed layout and fails for extra files, missing entry points or a different manifest', () => {
    expect(() => auditEntries(entries(), manifest)).not.toThrow()
    for (const file of ['package/.npmrc', 'package/.git/config', 'package/src/index.ts', 'package/test/spec.ts', 'package/../secret', 'package/lib/index.js.map']) {
      const input = entries()
      input.set(file, Buffer.from('unexpected'))
      expect(() => auditEntries(input, manifest)).toThrow('Unexpected package file')
    }
    const missing = entries()
    missing.delete('package/lib/index.js')
    expect(() => auditEntries(missing, manifest)).toThrow('Missing package file')
    const changed = entries()
    changed.set('package/package.json', Buffer.from(JSON.stringify({ ...manifest, version: '9.9.9' })))
    expect(() => auditEntries(changed, manifest)).toThrow('Packed manifest differs')
  })

  it('rejects paths and credentials without logging their values', () => {
    const samples = [
      String.fromCharCode(67, 58, 92) + 'Users' + String.fromCharCode(92) + 'example',
      '/' + ['home', 'example', 'secret'].join('/'),
      'npm_' + 'a'.repeat(36),
      'person' + '@' + 'example.invalid',
      'https://' + 'user:password' + '@' + 'example.invalid',
      '-----BEGIN ' + 'PRIVATE KEY-----',
    ]
    for (const value of samples) {
      const input = entries()
      input.set('package/README.md', Buffer.from(value))
      expect(() => auditEntries(input, manifest)).toThrow('Potential private data in package/README.md')
    }
  })

  it('reads archive contents without extracting links or special tar records', () => {
    expect(readArchive(archive('package/README.md', 'contents')).get('package/README.md')?.toString()).toBe('contents')
    for (const type of ['1', '2', 'x', 'g']) expect(() => readArchive(archive('package/file', 'target', type))).toThrow('Only regular files')
    expect(() => readArchive(gzipSync(Buffer.alloc(1)))).toThrow('Missing tar end marker')
  })

  it('allows a new version, skips a matching published version and waits for latest propagation', () => {
    expect(registryState(null, manifest, hashes)).toBe('missing')
    expect(registryState({ ...metadata(), versions: {}, 'dist-tags': { latest: '0.0.0-stage' } }, manifest, hashes)).toBe('missing')
    expect(registryState(metadata(), manifest, hashes)).toBe('ready')
    expect(registryState({ ...metadata(), 'dist-tags': {} }, manifest, hashes)).toBe('pending-tag')
  })

  it('never republishes changed bytes or moves latest backwards', () => {
    const changed = metadata()
    changed.versions[manifest.version].dist.integrity = 'different'
    expect(() => registryState(changed, manifest, hashes)).toThrow('integrity differs')
    const newer = { ...metadata(), 'dist-tags': { latest: '99.0.0' } }
    expect(() => registryState(newer, manifest, hashes)).toThrow('latest backwards')
    expect(() => registryState({ ...metadata(), name: 'another-package' }, manifest, hashes)).toThrow('Unexpected registry package')
  })

  it('reuses a matching Release asset but refuses to overwrite an existing different asset', () => {
    const filename = `${packageName}-${manifest.version}.tgz`
    const release = { ...event().release, assets: [] as object[] }
    expect(releaseAssetState(release, event().release.tag_name, filename, hashes, 123)).toBe('missing')
    release.assets.push({ name: filename, size: 123, state: 'uploaded', digest: `sha256:${hashes.sha256}` })
    expect(releaseAssetState(release, event().release.tag_name, filename, hashes, 123)).toBe('ready')
    expect(() => releaseAssetState(release, event().release.tag_name, filename, hashes, 124)).toThrow('different size')
    expect(() => releaseAssetState(release, event().release.tag_name, filename, { ...hashes, sha256: 'different' }, 123)).toThrow('never replace')
  })

  it('keeps CI archives under the project directory, outside job-level expressions', () => {
    const workflow = load(readFileSync('.github/workflows/publish.yml', 'utf8'))
    for (const job of Object.values(workflow.jobs) as { env: object; steps: { run?: string }[] }[]) {
      expect(JSON.stringify(job.env)).not.toContain('runner.')
      expect(job.steps[0].run).toContain('$GITHUB_WORKSPACE/packages/ci')
      expect(job.steps[0].run).toContain('>> "$GITHUB_ENV"')
    }
  })

  it('runs only for published Releases, with a strictly dependent publishing job and no npm token', () => {
    const source = readFileSync('.github/workflows/publish.yml', 'utf8')
    const workflow = load(source)
    expect(workflow.on).toEqual({ release: { types: ['published'] } })
    expect(workflow.concurrency['cancel-in-progress']).toBe(false)
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs.build.if).toContain('!github.event.release.prerelease')
    expect(workflow.jobs.publish.needs).toBe('build')
    expect(workflow.jobs.publish.permissions['id-token']).toBe('write')
    const upload = workflow.jobs.build.steps.find((step: { id?: string }) => step.id === 'archive')
    expect(upload.with.name).toContain('${{ github.run_attempt }}')
    expect(workflow.jobs.build.outputs['artifact-id']).toBe('${{ steps.archive.outputs.artifact-id }}')
    const download = workflow.jobs.publish.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/download-artifact@'))
    expect(download.with['artifact-ids']).toBe('${{ needs.build.outputs.artifact-id }}')
    expect(download.with['merge-multiple']).toBe(true)
    const publish = workflow.jobs.publish.steps.find((step: { run?: string }) => step.run?.startsWith('npm publish '))
    expect(publish.if).toBe("steps.preflight.outputs.exists == 'false'")
    expect(publish.run).toContain('--ignore-scripts')
    expect(source).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/)
    for (const job of Object.values(workflow.jobs) as { steps: { uses?: string; run?: string }[] }[]) {
      for (const step of job.steps) {
        if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/)
        if (step.run) expect(step.run).not.toMatch(/npm version|git tag|gh release create/)
      }
    }
  })
})

describe('project package output and immutable archives', () => {
  const roots: string[] = []
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-resets-release-test-'))
    roots.push(root)
    return root
  }
  afterEach(() => {
    for (const root of roots.splice(0)) {
      // Only remove the disposable directories this test created under the OS temporary directory.
      expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true)
      expect(relative(tmpdir(), root)).toMatch(/^codex-resets-release-test-/)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates unique in-project directories for repeated builds of the same version', () => {
    const root = fixture()
    const first = preparePackageDirectory('0.5.2', undefined, root)
    const second = preparePackageDirectory('0.5.2', undefined, root)
    expect(first).not.toBe(second)
    for (const directory of [first, second]) {
      expect(relative(root, directory).split(sep).slice(0, 2)).toEqual(['packages', 'test'])
      expect(existsSync(directory)).toBe(true)
    }
    expect(preparePackageDirectory('0.5.2', 'packages/ci', root)).toBe(join(root, 'packages', 'ci'))
  })

  it('rejects the project root, packages root and paths outside packages', () => {
    const root = fixture()
    for (const directory of ['.', 'packages', 'packages/..', '../outside', 'other', join(root, 'other')]) {
      expect(() => preparePackageDirectory('0.5.2', directory, root)).toThrow('subdirectory of packages/')
    }
    expect(existsSync(join(root, 'other'))).toBe(false)
  })

  it.each(['packages', 'packages/link'])('rejects a %s symlink or junction that points outside package storage', link => {
    const root = fixture(), outside = fixture()
    const directory = join(root, link)
    if (link !== 'packages') mkdirSync(join(root, 'packages'))
    symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => packageDirectory(join(directory, 'build'), root)).toThrow('symlinks or junctions')
    expect(existsSync(join(outside, 'build'))).toBe(false)
  })

  it('refuses to overwrite a same-version archive, preserving the original bytes', () => {
    const root = fixture()
    const directory = preparePackageDirectory(manifest.version, 'packages/releases', root)
    const file = join(directory, `${packageName}-${manifest.version}.tgz`)
    const original = Buffer.from('published archive')
    writeNewArchive(file, original)
    expect(() => writeNewArchive(file, Buffer.from('different working tree'))).toThrow()
    expect(readFileSync(file)).toEqual(original)
  })
})
