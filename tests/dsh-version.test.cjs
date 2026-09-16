/**
 * Regression: the DeepSeek Harness version gate.
 *
 * The gate exists because dsh is a developer preview whose protocol this build
 * targets at a specific version range: an older CLI must be refused with an
 * upgrade hint, a newer one must start with a warning, and output that carries
 * no version at all (custom launcher) must not block startup.
 */
'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const { buildSync } = require('esbuild')

const code = buildSync({
  entryPoints: [path.resolve(__dirname, '../src/dsh-version.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
}).outputFiles[0].text

const loaded = { exports: {} }
new Function('require', 'module', 'exports', code)(require, loaded, loaded.exports)
const {
  MINIMUM_DSH_VERSION,
  TESTED_DSH_VERSION,
  UPGRADE_HINT,
  compareVersions,
  evaluateDshVersion,
  parseVersion,
  parseVersionOutput,
} = loaded.exports

test('parseVersion accepts release and prerelease forms and rejects noise', () => {
  assert.deepEqual(parseVersion('0.1.5'), { major: 0, minor: 1, patch: 5, prerelease: [] })
  assert.deepEqual(parseVersion('v0.1.5-rc.2'), { major: 0, minor: 1, patch: 5, prerelease: ['rc', '2'] })
  assert.equal(parseVersion('dsh 0.1.5'), undefined)
  assert.equal(parseVersion(''), undefined)
})

test('compareVersions orders prereleases before their release', () => {
  const v = (raw) => parseVersion(raw)
  assert.equal(compareVersions(v('0.1.5-rc.1'), v('0.1.5-rc.2')), -1)
  assert.equal(compareVersions(v('0.1.5-rc.2'), v('0.1.5')), -1)
  assert.equal(compareVersions(v('0.1.5'), v('0.1.5')), 0)
  assert.equal(compareVersions(v('0.1.9'), v('0.1.10')), -1)
  assert.equal(compareVersions(v('0.2.0'), v('0.1.5-rc.2')), 1)
})

test('parseVersionOutput survives real command output', () => {
  assert.equal(parseVersionOutput('0.1.5-rc.2\n'), '0.1.5-rc.2')
  assert.equal(parseVersionOutput('dsh version 0.1.5-rc.2 (linux x64)'), '0.1.5-rc.2')
  assert.equal(parseVersionOutput('command not found'), undefined)
})

test('an older CLI is refused with an upgrade hint', () => {
  const gate = evaluateDshVersion('0.1.4\n')
  assert.equal(gate.ok, false)
  assert.equal(gate.version, '0.1.4')
  assert.match(gate.message, /older than the minimum supported dsh/u)
  assert.ok(gate.message.includes(UPGRADE_HINT))
})

test('the tested version and anything newer are allowed', () => {
  const exact = evaluateDshVersion(TESTED_DSH_VERSION + '\n')
  assert.equal(exact.ok, true)
  assert.equal(exact.version, TESTED_DSH_VERSION)
  const newer = evaluateDshVersion('0.2.0\n')
  assert.equal(newer.ok, true)
  assert.match(newer.message, /newer than the version this build is tested with/u)
})

test('unparsable output never blocks startup', () => {
  const gate = evaluateDshVersion('some launcher without --version support')
  assert.equal(gate.ok, true)
  assert.equal(gate.version, undefined)
  assert.match(gate.message, /could not read the dsh version/u)
})

test('the minimum stays below the tested version', () => {
  assert.equal(compareVersions(parseVersion(MINIMUM_DSH_VERSION), parseVersion(TESTED_DSH_VERSION)), -1)
})
