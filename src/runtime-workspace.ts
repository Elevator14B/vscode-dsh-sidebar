/**
 * Workspace identity and the rendezvous between Extension Hosts and the keeper.
 *
 * One keeper serves one canonical workspace for one OS user in one network
 * namespace. The key is the same hash the exclusive reservation used, so a
 * workspace keeps its identity; the share record is what turns exclusion into
 * sharing: the keeper publishes its control port and a per-keeper token, and
 * every Extension Host of that workspace attaches to the same record.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import * as path from 'node:path'

/** Only a keeper that speaks this protocol may own a workspace record. */
export const KEEPER_PROTOCOL = 'dsh-sidebar-keeper-v1'
/** Candidate control ports one workspace may pick from. */
const CONTROL_PORT_BASE = 44_000
const CONTROL_PORT_SPAN = 16_000
/** Candidate slots, so a stale or foreign listener on one port cannot block a workspace. */
const CONTROL_PORT_SLOTS = 8

/** Identity of the backend a keeper owns, verified before a replacement kills it. */
export interface BackendIdentity {
  readonly pid: number
  readonly start: string
}

/** One keeper's published rendezvous record (0600, owner-only). */
export interface ShareRecord {
  readonly protocol: typeof KEEPER_PROTOCOL
  readonly key: string
  readonly port: number
  readonly token: string
  readonly pid: number
  readonly startedAt: string
  /** Present once the backend is running; a dead keeper's orphan is identified by it. */
  readonly backend?: BackendIdentity
}

/**
 * Stable identity of one workspace for one user.
 * @param canonicalCwd - realpath of the pinned workspace folder.
 * @returns the hex key shared by every Extension Host of that folder.
 */
export function workspaceKey(canonicalCwd: string): string {
  return createHash('sha256').update(`${userInfo().username}\0${canonicalCwd}`).digest('hex')
}

/**
 * Deterministic control ports for one workspace.
 * @param key - workspace key.
 * @returns the candidate ports, most preferred first.
 */
export function candidatePorts(key: string): number[] {
  const ports: number[] = []
  for (let slot = 0; slot < CONTROL_PORT_SLOTS; slot += 1) {
    const hash = createHash('sha256').update(`${key}:${slot}`).digest().readUInt32BE(0)
    ports.push(CONTROL_PORT_BASE + hash % CONTROL_PORT_SPAN)
  }
  return ports
}

/** Freshly minted control token; possession is the only authority the socket accepts. */
export function keeperToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Records live under the user's DSH home; a test or the contract smoke overrides
 * the directory so it never touches the records of a real window.
 */
function shareDirectory(): string {
  const override = process.env.DSH_EMBED_SHARE_DIR
  return override !== undefined && override !== '' ? override : path.join(homedir(), '.dsh', 'vscode-embed', 'workspaces')
}

/** @param key - workspace key. @returns the record path for that workspace. */
export function sharePath(key: string): string {
  return path.join(shareDirectory(), `${key}.json`)
}

/** @param key - workspace key. @returns the bootstrap lock path for that workspace. */
export function lockPath(key: string): string {
  return path.join(shareDirectory(), `${key}.lock`)
}

/**
 * Read the published keeper record.
 * @param key - workspace key.
 * @returns the record, or undefined when there is none or it is malformed.
 */
export function readShareRecord(key: string): ShareRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(sharePath(key), 'utf8')) as Partial<ShareRecord>
    if (value.protocol !== KEEPER_PROTOCOL || value.key !== key) return undefined
    if (!Number.isSafeInteger(value.port) || typeof value.token !== 'string' || !Number.isSafeInteger(value.pid)) return undefined
    if (value.backend !== undefined && (!Number.isSafeInteger(value.backend.pid) || typeof value.backend.start !== 'string')) return undefined
    return value as ShareRecord
  } catch (_error) {
    return undefined
  }
}

/**
 * Publish a keeper record, owner-readable only.
 * @param record - the record to publish.
 */
export function writeShareRecord(record: ShareRecord): void {
  mkdirSync(shareDirectory(), { recursive: true })
  writeFileSync(sharePath(record.key), JSON.stringify(record) + '\n', { mode: 0o600 })
}

/** @param key - workspace key. */
export function removeShareRecord(key: string): void {
  rmSync(sharePath(key), { force: true })
}

/**
 * Whether a process is still alive. Signal 0 only probes, and EPERM still means alive.
 * @param pid - process id to probe.
 * @returns true when the pid exists.
 */
export function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Take the bootstrap lock so only one Extension Host forks a keeper.
 *
 * A lock whose holder is gone is stale and is replaced; two racers both trying
 * that still end with exactly one winner because creation is exclusive.
 * @param key - workspace key.
 * @param pid - this process, recorded as the holder.
 * @returns true when this process now holds the lock.
 */
export function acquireLock(key: string, pid: number): boolean {
  mkdirSync(shareDirectory(), { recursive: true })
  try {
    writeFileSync(lockPath(key), String(pid), { flag: 'wx', mode: 0o600 })
    return true
  } catch (_error) {
    /* held, or a stale file from a dead holder */
  }
  try {
    const holder = Number(readFileSync(lockPath(key), 'utf8').trim())
    if (alive(holder)) return false
    rmSync(lockPath(key), { force: true })
    writeFileSync(lockPath(key), String(pid), { flag: 'wx', mode: 0o600 })
    return true
  } catch (_error) {
    return false
  }
}

/** @param key - workspace key. @returns whether this workspace has a keeper record. */
export function hasShareRecord(key: string): boolean {
  return existsSync(sharePath(key))
}
