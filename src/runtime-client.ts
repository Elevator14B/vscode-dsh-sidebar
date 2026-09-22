/**
 * Extension Host side of the keeper protocol.
 *
 * Attaching is the whole lifecycle: a Host never owns the backend, so disposing
 * one only detaches it. The rendezvous guarantees one keeper per workspace even
 * when several windows start at the same moment.
 */
import { spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import {
  ATTACH_DEADLINE_MS, HANDSHAKE_DEADLINE_MS, MESSAGE_LIMIT, type KeeperEvent, type KeeperRequest, type LaunchSpec,
} from './runtime-protocol'
import { acquireLock, alive, lockPath, readShareRecord, workspaceKey, type ShareRecord } from './runtime-workspace'

/** Structured sink for keeper decisions (usually Telemetry.log). */
export type KeeperTelemetry = (event: string, data?: Record<string, unknown>) => void

/** One attached control connection to a workspace keeper. */
export class KeeperClient {
  private readonly listeners = new Set<(event: KeeperEvent) => void>()
  private readonly closeListeners = new Set<() => void>()
  private closed = false

  private constructor(private readonly socket: Socket, private readonly token: string) {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MESSAGE_LIMIT * 4) { socket.destroy(); return }
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim() === '') continue
        let event: KeeperEvent
        try { event = JSON.parse(line) as KeeperEvent } catch (_error) { continue }
        for (const listener of [...this.listeners]) listener(event)
      }
    })
    socket.on('error', () => { /* a keeper that dies is reported by the close listener */ })
    socket.on('close', () => {
      if (this.closed) return
      this.closed = true
      for (const listener of [...this.closeListeners]) listener()
    })
  }

  /** @param listener - called once when the keeper connection ends. @returns unsubscribe. */
  onClose(listener: () => void): () => void {
    if (this.closed) { listener(); return () => {} }
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  /** @param port - control port. @param token - keeper token. @param deadlineMs - connect deadline. */
  static connect(port: number, token: string, deadlineMs = HANDSHAKE_DEADLINE_MS): Promise<KeeperClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1')
      const timer = setTimeout(() => { socket.destroy(); reject(new Error(`keeper on port ${port} did not answer`)) }, deadlineMs)
      const failed = (error: Error): void => { clearTimeout(timer); socket.destroy(); reject(error) }
      socket.once('error', failed)
      socket.once('connect', () => { clearTimeout(timer); socket.off('error', failed); resolve(new KeeperClient(socket, token)) })
    })
  }

  private wait(match: (event: KeeperEvent) => boolean, deadlineMs: number, description: string): Promise<KeeperEvent> {
    return new Promise((resolve, reject) => {
      const listener = (event: KeeperEvent): void => {
        if (!match(event)) return
        clearTimeout(timer)
        this.listeners.delete(listener)
        resolve(event)
      }
      const timer = setTimeout(() => {
        this.listeners.delete(listener)
        reject(new Error(description))
      }, deadlineMs)
      this.listeners.add(listener)
    })
  }

  /** Observe state and failures for as long as this connection lives. */
  onEvent(listener: (event: KeeperEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private write(request: KeeperRequest): void {
    if (!this.closed && !this.socket.destroyed) this.socket.write(JSON.stringify(request) + '\n')
  }

  /** Prove the port speaks this protocol before it is trusted as a keeper. */
  async handshake(deadlineMs = HANDSHAKE_DEADLINE_MS): Promise<void> {
    const state = this.wait(event => event.type === 'state' || event.type === 'failure', deadlineMs, 'the workspace control port is not a keeper')
    this.write({ type: 'status', token: this.token })
    const event = await state
    if (event.type === 'failure') throw new Error(event.message)
    if (event.type !== 'state') throw new Error('the workspace control port is not a keeper')
  }

  /** Attach this Host and wait until the shared backend is ready. */
  async attach(spec: LaunchSpec, deadlineMs = ATTACH_DEADLINE_MS): Promise<{ url: string; cookie: string; pid: number }> {
    const settled = this.wait(event => event.type === 'ready' || event.type === 'failure', deadlineMs,
      'the DSH backend for this workspace did not become ready')
    this.write({ type: 'attach', token: this.token, spec })
    const event = await settled
    if (event.type !== 'ready') throw new Error(event.type === 'failure' ? event.message : 'the keeper did not report a ready backend')
    return { url: event.url, cookie: event.cookie, pid: event.pid }
  }

  /** Replace the shared backend; every attached Host observes the same restart. */
  async restart(deadlineMs = ATTACH_DEADLINE_MS): Promise<void> {
    const settled = this.wait(event => event.type === 'ready' || event.type === 'failure', deadlineMs,
      'the restarted DSH backend did not become ready')
    this.write({ type: 'restart', token: this.token })
    const event = await settled
    if (event.type !== 'ready') throw new Error(event.type === 'failure' ? event.message : 'the keeper did not report a ready backend')
  }

  /** Leave the backend running for every other attached Host. */
  detach(): void {
    if (this.closed) return
    this.write({ type: 'detach', token: this.token })
    this.closed = true
    this.socket.end()
    this.socket.destroy()
    this.listeners.clear()
    this.closeListeners.clear()
  }
}

/** One attached keeper plus how it was obtained. */
export interface KeeperLocation {
  readonly client: KeeperClient
  readonly record: ShareRecord
  readonly started: boolean
}

/**
 * Attach to this workspace's keeper, forking exactly one when there is none.
 *
 * Concurrent window starts must not fork two keepers for one folder: the Host
 * that wins the bootstrap lock forks, every other Host waits for the published
 * record. A record whose keeper is gone, or a port that does not answer the
 * protocol, is replaced instead of trusted.
 * @param canonicalCwd - realpath of the pinned workspace folder.
 * @param keeperPath - absolute path of the packaged keeper script.
 * @param deadlineMs - how long to wait for a keeper to become available.
 * @param telemetry - structured decision sink.
 * @returns the attached client, its record and whether this Host forked it.
 */
export async function ensureKeeper(
  canonicalCwd: string,
  keeperPath: string,
  deadlineMs: number,
  telemetry: KeeperTelemetry,
): Promise<KeeperLocation> {
  const key = workspaceKey(canonicalCwd)
  const deadline = Date.now() + deadlineMs
  const lock = lockPath(key)
  let locked = false
  let forked = false
  try {
    for (;;) {
      const record = readShareRecord(key)
      if (record !== undefined) {
        try {
          const client = await KeeperClient.connect(record.port, record.token)
          await client.handshake()
          telemetry('runtime.keeper-attached', { keeperPid: record.pid, controlPort: record.port, started: forked })
          return { client, record, started: forked }
        } catch (_error) {
          // A keeper that was replaced while we tried must not make us fork a
          // second one; a record whose keeper is still alive is merely starting.
          const current = readShareRecord(key)
          if (current !== undefined && current.token !== record.token) continue
        }
      }
      // A stale record is left in place: the replacement keeper reads it to reap
      // the backend its dead predecessor orphaned, then overwrites it.
      const stale = record === undefined || !alive(record.pid)
      if (!forked && stale && acquireLock(key, process.pid)) {
        locked = true
        forked = true
        // spawn, not fork: a keeper must hold no IPC channel to any window.
        spawn(process.execPath, [keeperPath, '--cwd', canonicalCwd], {
          detached: true, stdio: 'ignore', windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        }).unref()
        telemetry('runtime.keeper-started', { cwd: canonicalCwd })
        continue
      }
      if (Date.now() >= deadline) throw new Error('the DSH workspace keeper did not become available; close other DSH Sidebar windows for this folder or retry')
      await delay(100)
    }
  } finally {
    if (locked) rmSync(lock, { force: true })
  }
}
