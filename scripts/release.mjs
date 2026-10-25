import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { setTimeout as sleep } from 'node:timers/promises'

export const repository = 'HuangArmagh/koishi-plugin-codex-resets'
export const packageName = 'koishi-plugin-codex-resets'
const registry = 'https://registry.npmjs.org'
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/
const repositoryUrl = `git+https://github.com/${repository}.git`
const jsonFile = file => JSON.parse(readFileSync(file, 'utf8'))

export function validateManifest(manifest, lock) {
  assert.equal(manifest.name, packageName, 'Unexpected package name')
  assert.match(manifest.version, stableVersion, 'A stable, explicitly selected version is required')
  assert.notEqual(manifest.private, true, 'The npm package must be public')
  assert.equal(manifest.repository?.url, repositoryUrl, 'Repository URL must match the trusted publisher')
  assert.equal(manifest.publishConfig?.registry, `${registry}/`, 'Unexpected npm registry')
  assert.equal(manifest.publishConfig?.access, 'public', 'Unexpected npm visibility')
  assert.equal(manifest.publishConfig?.tag, 'latest', 'Unexpected npm dist-tag')
  if (lock) {
    assert.equal(lock.version, manifest.version, 'Lockfile version mismatch')
    assert.equal(lock.packages?.['']?.version, manifest.version, 'Lockfile root version mismatch')
    assert.equal(lock.name, packageName, 'Lockfile package mismatch')
  }
}

export function validateRelease(event, context, manifest, lock) {
  validateManifest(manifest, lock)
  assert.equal(context.eventName, 'release', 'Only a Release event can publish')
  assert.equal(event.action, 'published', 'Only a published Release can publish')
  assert.equal(event.repository?.full_name, repository, 'Unexpected event repository')
  assert.equal(context.repository, repository, 'Unexpected workflow repository')
  assert.equal(event.release?.draft, false, 'Draft releases cannot publish')
  assert.equal(event.release?.prerelease, false, 'Prereleases cannot publish to latest')
  assert.equal(event.release?.tag_name, `v${manifest.version}`, 'Release tag and package version differ')
  assert.match(context.sha ?? '', /^[a-f0-9]{40}$/, 'Missing release commit')
  assert.equal(context.head, context.sha, 'Checkout differs from the release commit')
  assert.equal(context.tagSha, context.sha, 'Tag differs from the release commit')
}

// Read without extracting: links, extended headers and unexpected paths fail closed.
export function readArchive(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 })
  const entries = new Map()
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(value => value === 0)) return entries
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0]
    const octal = (start, length) => {
      const value = field(start, length).trim()
      assert.match(value, /^[0-7]+$/, 'Unsupported tar numeric field')
      return Number.parseInt(value, 8)
    }
    const checksum = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0)
    assert.equal(octal(148, 8), checksum, 'Invalid tar header checksum')
    assert.ok(header[156] === 0 || header[156] === 48, 'Only regular files are allowed in the npm archive')
    const prefix = field(345, 155)
    const name = (prefix ? `${prefix}/` : '') + field(0, 100)
    const size = octal(124, 12)
    const end = offset + 512 + size
    assert.ok(end <= tar.length, 'Truncated npm archive')
    assert.ok(!entries.has(name), 'Duplicate file in npm archive')
    entries.set(name, tar.subarray(offset + 512, end))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('Missing tar end marker')
}

export function auditEntries(entries, manifest) {
  const allowed = /^package\/(?:lib\/[a-z][a-z0-9-]*\.(?:js|d\.ts)|docs\/[a-z][a-z0-9-]*\.md|README\.md|LICENSE|package\.json)$/
  const privacyPatterns = [
    /\b[A-Za-z]:[\\/](?!\/)/,
    /\/(?:Users|home)\/[\w.-]+|\/root\//,
    /\b(?:npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/,
    /https?:\/\/[^/\s:@]+:[^/\s@]+@/,
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ]
  for (const [name, data] of entries) {
    assert.match(name, allowed, `Unexpected package file: ${name}`)
    assert.ok(!privacyPatterns.some(pattern => pattern.test(data.toString('utf8'))), `Potential private data in ${name}`)
  }
  for (const required of ['package.json', 'README.md', 'LICENSE', 'lib/index.js', 'lib/index.d.ts']) {
    assert.ok(entries.has(`package/${required}`), `Missing package file: ${required}`)
  }
  const packed = JSON.parse(entries.get('package/package.json').toString('utf8'))
  validateManifest(packed)
  assert.deepEqual(packed, manifest, 'Packed manifest differs from checkout')
}

export function digests(bytes) {
  return {
    sha1: createHash('sha1').update(bytes).digest('hex'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  }
}

function compareVersions(left, right) {
  assert.match(left, stableVersion, 'Unexpected latest version format')
  const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  return 0
}

export function registryState(metadata, manifest, hashes) {
  if (metadata === null) return 'missing'
  assert.equal(metadata.name, packageName, 'Unexpected registry package')
  const latest = metadata['dist-tags']?.latest
  if (latest && latest !== '0.0.0-stage') assert.ok(compareVersions(latest, manifest.version) <= 0, 'Refusing to move latest backwards')
  const published = metadata.versions?.[manifest.version]
  if (!published) return 'missing'
  assert.equal(published.name, packageName, 'Unexpected published name')
  assert.equal(published.version, manifest.version, 'Unexpected published version')
  assert.equal(published.dist?.shasum, hashes.sha1, 'Published archive SHA-1 differs; never overwrite a version')
  assert.equal(published.dist?.integrity, hashes.integrity, 'Published archive integrity differs; never overwrite a version')
  return latest === manifest.version ? 'ready' : 'pending-tag'
}

export function releaseAssetState(release, tag, filename, hashes, size) {
  assert.equal(release.tag_name, tag, 'Unexpected GitHub release tag')
  assert.equal(release.draft, false, 'Release is now a draft')
  assert.equal(release.prerelease, false, 'Release is now a prerelease')
  const matches = release.assets.filter(asset => asset.name === filename)
  assert.ok(matches.length <= 1, 'Duplicate release assets')
  if (!matches.length) return 'missing'
  assert.equal(matches[0].state, 'uploaded', 'Existing asset upload is incomplete')
  assert.equal(matches[0].size, size, 'Existing release asset has a different size')
  assert.equal(matches[0].digest, `sha256:${hashes.sha256}`, 'Existing release asset differs; never replace it automatically')
  return 'ready'
}

async function readRegistry() {
  const response = await fetch(`${registry}/${packageName}`, { signal: AbortSignal.timeout(30_000) })
  if (response.status === 404) return null
  assert.ok(response.ok, `npm registry returned ${response.status}; stopped. Retry-After: ${response.headers.get('retry-after') ?? 'not supplied'}`)
  return response.json()
}

function output(values) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''))
  }
  console.log(JSON.stringify(values))
}

async function main(command) {
  const manifest = jsonFile('package.json')
  validateManifest(manifest, jsonFile('package-lock.json'))
  if (command === 'validate') {
    const event = jsonFile(process.env.GITHUB_EVENT_PATH)
    const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim()
    // Validate the tag before passing it to git, and use argv rather than a shell.
    assert.equal(event.release?.tag_name, `v${manifest.version}`, 'Release tag and package version differ')
    validateRelease(event, {
      eventName: process.env.GITHUB_EVENT_NAME, repository: process.env.GITHUB_REPOSITORY,
      sha: process.env.GITHUB_SHA, head: git(['rev-parse', 'HEAD']),
      tagSha: git(['rev-parse', `refs/tags/v${manifest.version}^{commit}`]),
    }, manifest, jsonFile('package-lock.json'))
    console.log('Release identity and version validated.')
    return
  }
  assert.ok(['pack', 'preflight', 'verify', 'attach'].includes(command), 'Unknown release command')
  assert.ok(process.env.RELEASE_DIR, 'RELEASE_DIR is required; never overwrite the local published archive')
  const directory = resolve(process.env.RELEASE_DIR)
  assert.notEqual(directory, process.cwd(), 'Use a separate directory for release checks')
  const filename = `${packageName}-${manifest.version}.tgz`
  const archive = join(directory, filename)
  if (command === 'pack') {
    mkdirSync(directory, { recursive: true })
    assert.ok(process.env.npm_execpath, 'Use npm run release:pack so the same npm CLI can be called without a shell')
    execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--pack-destination', directory], { stdio: 'inherit' })
  }
  const bytes = readFileSync(archive), hashes = digests(bytes), entries = readArchive(bytes)
  auditEntries(entries, manifest)
  if (command === 'pack') {
    for (const [name, content] of entries) assert.ok(content.equals(readFileSync(name.slice('package/'.length))), `Packed file mismatch: ${name}`)
    output({ version: manifest.version, sha256: hashes.sha256 })
    return
  }
  assert.match(process.env.EXPECTED_SHA256 ?? '', /^[a-f0-9]{64}$/, 'Missing tested artifact digest')
  assert.equal(hashes.sha256, process.env.EXPECTED_SHA256, 'Artifact differs from the tested build')
  if (command === 'preflight') {
    const state = registryState(await readRegistry(), manifest, hashes)
    // Existing versions must never be submitted again, even while tags propagate.
    output({ exists: state !== 'missing' })
    return
  }
  if (command === 'verify') {
    await sleep(5000)
    for (let attempt = 0; attempt < 21; attempt++) {
      if (attempt) await sleep(30_000)
      if (registryState(await readRegistry(), manifest, hashes) === 'ready') {
        console.log(`Verified npm ${manifest.version}, latest, SHA-1 and SHA-512.`)
        return
      }
      console.log('npm is still processing the release; checking again after 30 seconds.')
    }
    throw new Error('npm processing has not completed after 10 minutes; inspect before rerunning, never bump or republish automatically')
  }
  const tag = `v${manifest.version}`
  const release = () => JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases/tags/${tag}`], { encoding: 'utf8' }))
  if (releaseAssetState(release(), tag, filename, hashes, bytes.length) === 'missing') {
    execFileSync('gh', ['release', 'upload', tag, archive, '--repo', repository], { stdio: 'inherit' })
    await sleep(5000)
    assert.equal(releaseAssetState(release(), tag, filename, hashes, bytes.length), 'ready', 'Release asset was not uploaded')
  }
  console.log(`Verified GitHub asset ${basename(archive)} matches npm.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1 })
}
