/**
 * DeepSeek Harness CLI version gate.
 *
 * The extension drives 'dsh web' and speaks the Web client's own RPC protocol,
 * which is not a frozen public API: DeepSeek Harness is a developer preview and
 * ships compatibility-breaking changes. This module holds the pure comparison
 * and decision logic for the startup gate, with no import from 'vscode', so it
 * can be unit-tested without an extension host.
 */

/** Version this build is developed and verified against. */
export const TESTED_DSH_VERSION = '0.1.5-rc.2'

/** Oldest DeepSeek Harness CLI that still speaks the protocol this build expects. */
export const MINIMUM_DSH_VERSION = '0.1.5-rc.1'

/** Upgrade hint shown when the installed CLI is too old. */
export const UPGRADE_HINT = 'npm install -g @deepseek-ai/dsh'

/** One parsed semantic version, keeping the prerelease identifiers. */
export interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly string[]
}

/** Matches a version token inside larger command output. */
const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u

/** Drop trailing separators so 'rc.' and 'rc-' do not become an identifier. */
function trimSeparators(raw: string): string {
  return raw.replace(/[.-]+$/u, '')
}

/** Split a prerelease suffix into identifiers, dropping empty parts. */
function prereleaseOf(raw: string | undefined): string[] {
  if (raw === undefined) return []
  return trimSeparators(raw).split('.').filter(part => part !== '')
}

/**
 * Parse a bare x.y.z string, optionally with a -prerelease suffix.
 * @param raw - candidate version text.
 * @returns the parsed version, or undefined when the text is not one.
 */
export function parseVersion(raw: string): ParsedVersion | undefined {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\s*$/u.exec(raw)
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: prereleaseOf(match[4]),
  }
}

/**
 * Extract the first version from arbitrary command output.
 * @param output - combined stdout/stderr of 'dsh --version'.
 * @returns the version text, or undefined when none is present.
 */
export function parseVersionOutput(output: string): string | undefined {
  const match = VERSION_PATTERN.exec(output)
  if (match === null) return undefined
  const core = match[1] + '.' + match[2] + '.' + match[3]
  const prerelease = match[4] === undefined ? '' : '-' + trimSeparators(match[4])
  return core + prerelease
}

/**
 * Compare two versions using semantic-version precedence: a prerelease sorts
 * before its release, numeric identifiers sort numerically and before
 * alphanumeric ones, and a shorter identifier list sorts first when equal.
 * @param a - left version.
 * @param b - right version.
 * @returns -1, 0, or 1 when a is older, equal, or newer than b.
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index]
    const right = b.prerelease[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNumber = /^\d+$/u.test(left) ? Number(left) : undefined
    const rightNumber = /^\d+$/u.test(right) ? Number(right) : undefined
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber < rightNumber ? -1 : 1
    if (leftNumber !== undefined) return -1
    if (rightNumber !== undefined) return 1
    return left < right ? -1 : 1
  }
  return 0
}

/** Outcome of the startup gate. */
export interface VersionGate {
  /** False blocks startup; true only reports what was found. */
  readonly ok: boolean
  /** Detected version, when the output could be parsed. */
  readonly version?: string
  /** One-line diagnosis, safe to show to the user. */
  readonly message: string
}

/**
 * Decide whether the detected CLI may start the embedded runtime.
 * Unparsable output never blocks startup: a custom launcher may have no
 * '--version' output, and the real failure is reported by the spawn itself.
 * @param output - combined stdout/stderr of 'dsh --version'.
 * @returns the gate verdict plus a user-facing message.
 */
export function evaluateDshVersion(output: string): VersionGate {
  const raw = parseVersionOutput(output)
  const detected = raw === undefined ? undefined : parseVersion(raw)
  const minimum = parseVersion(MINIMUM_DSH_VERSION)
  const tested = parseVersion(TESTED_DSH_VERSION)
  if (detected === undefined || raw === undefined || minimum === undefined || tested === undefined) {
    return {
      ok: true,
      message: 'could not read the dsh version from the CLI; continuing (this build is tested with dsh '
        + TESTED_DSH_VERSION + ')',
    }
  }
  if (compareVersions(detected, minimum) < 0) {
    return {
      ok: false,
      version: raw,
      message: 'dsh ' + raw + ' is older than the minimum supported dsh ' + MINIMUM_DSH_VERSION
        + '. Upgrade with: ' + UPGRADE_HINT,
    }
  }
  if (compareVersions(detected, tested) > 0) {
    return {
      ok: true,
      version: raw,
      message: 'dsh ' + raw + ' is newer than the version this build is tested with ('
        + TESTED_DSH_VERSION + '); continuing',
    }
  }
  return {
    ok: true,
    version: raw,
    message: 'dsh ' + raw + ' (minimum ' + MINIMUM_DSH_VERSION + ', tested ' + TESTED_DSH_VERSION + ')',
  }
}
