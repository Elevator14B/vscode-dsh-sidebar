#!/usr/bin/env node
/**
 * Pre-publish check for the packaged VSIX.
 *
 *   npm run package && npm run check:package
 *
 * Asserts that the artifact carries only what the package.json "files"
 * allow-list permits (no dotfile, no source, no lockfile) and that neither an
 * absolute developer path nor a credential-looking string reached it. Run this
 * locally before uploading a release; it is deliberately not a CI step.
 */
'use strict'
const { execFileSync } = require('node:child_process')
const { readdirSync, statSync } = require('node:fs')

/** Entries that must never be packaged. */
const FORBIDDEN_ENTRY = /(^|\/)\.[^/]+$|(^|\/)[.]github\/|^extension\/(src|tests|scripts)\//u
/** Absolute paths of a developer machine. */
const FORBIDDEN_PATH = /\/(home|Users)\/[A-Za-z0-9._-]+/u
/** Credential shapes worth refusing to publish. */
const FORBIDDEN_SECRET = /(@deepseek[.]com|glpat-|ghp_[A-Za-z0-9]{20,}|github_pat_|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY)/u

/**
 * Run unzip and return its stdout.
 * @param args - unzip arguments.
 * @returns stdout as a latin1 string so byte patterns survive.
 */
function unzip(args) {
  return execFileSync('unzip', args, { maxBuffer: 64 * 1024 * 1024 }).toString('latin1')
}

/** Newest VSIX in the working directory, or undefined. */
function newestVsix() {
  const candidates = readdirSync('.').filter(name => name.endsWith('.vsix'))
  if (candidates.length === 0) return undefined
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

/** Report one failed rule and remember that the check failed. */
const failures = []
function check(rule, value, what) {
  const match = rule.exec(value)
  if (match !== null) failures.push(what + ': ' + match[0])
}

const vsix = newestVsix()
if (vsix === undefined) {
  console.error('check-package: no .vsix in the working directory; run npm run package first')
  process.exit(1)
}

let entries
let content
try {
  entries = unzip(['-Z1', vsix]).split('\n').filter(line => line !== '')
  content = unzip(['-p', vsix])
} catch (error) {
  console.error('check-package: unzip failed (' + (error instanceof Error ? error.message : String(error)) + ')')
  console.error('install unzip, or inspect ' + vsix + ' by hand')
  process.exit(1)
}

for (const entry of entries) check(FORBIDDEN_ENTRY, entry, 'forbidden entry')
check(FORBIDDEN_PATH, content, 'absolute developer path')
check(FORBIDDEN_SECRET, content, 'credential-looking string')

console.log(vsix + ' (' + String(entries.length) + ' entries)')
for (const entry of entries) console.log('  ' + entry)
if (failures.length > 0) {
  for (const failure of failures) console.error('check-package: FAIL - ' + failure)
  process.exit(1)
}
console.log('check-package: PASS')
