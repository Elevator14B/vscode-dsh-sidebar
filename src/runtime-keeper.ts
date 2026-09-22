/**
 * Workspace keeper: it owns one DSH backend for one canonical workspace and
 * serves every Extension Host that attaches to it.
 *
 * It is forked detached, keeps no IPC channel to any window, and therefore
 * survives every individual window, SSH connection or Extension Host
 * replacement. It reaps the CLI only when the last client has detached and the
 * idle grace expired, so one connection leaving never stops another's agent.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { createServer, type Server, type Socket } from 'node:net'
import { ProcessTree, processStart } from './process-tree'
import {
  IDLE_GRACE_MS, MESSAGE_LIMIT, OUTPUT_LIMIT, type KeeperEvent, type KeeperRequest,
  type KeeperState, type LaunchSpec,
} from './runtime-protocol'
import { KEEPER_PROTOCOL, candidatePorts, keeperToken, readShareRecord, removeShareRecord, workspaceKey, writeShareRecord, type ShareRecord } from './runtime-workspace'

interface Options { cwd: string; graceMs: number }

function parseOptions(argv: readonly string[]): Options {
  let cwd = ''
  const fromEnv = Number(process.env.DSH_EMBED_IDLE_GRACE_MS ?? '')
  let graceMs = Number.isSafeInteger(fromEnv) && fromEnv >= 0 ? fromEnv : IDLE_GRACE_MS
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--cwd' && argv[index + 1] !== undefined) cwd = argv[index + 1]!
    if (argv[index] === '--grace' && argv[index + 1] !== undefined) graceMs = Number(argv[index + 1])
  }
  if (cwd === '') throw new Error('runtime-keeper: --cwd is required')
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) graceMs = IDLE_GRACE_MS
  return { cwd, graceMs }
}

const options = parseOptions(process.argv.slice(2))
const key = workspaceKey(options.cwd)
const token = keeperToken()
const clients = new Set<Socket>()
let controlPort = 0
let backendIdentity: { pid: number; start: string } | undefined

let listener: Server | undefined
let tree: ProcessTree | undefined
let childDone: Promise<void> | undefined
let spec: LaunchSpec | undefined
let running: { url: string; cookie: string; pid: number } | undefined
let state: KeeperState = 'idle'
let starting: Promise<void> | undefined
let logs = ''
let idleTimer: ReturnType<typeof setTimeout> | undefined
let stopping: Promise<void> | undefined

/** One control reply; a closed client is dropped rather than awaited. */
function send(socket: Socket, event: KeeperEvent): void {
  if (socket.destroyed) return
  socket.write(JSON.stringify(event) + '\n')
}

/** Broadcast to every attached Host; they all observe one backend's life. */
function broadcast(event: KeeperEvent): void {
  for (const socket of clients) send(socket, event)
}

/** Buffer the CLI output for late attach, and stream it to everyone attached. */
function record(text: string): void {
  logs = (logs + text).slice(-OUTPUT_LIMIT)
  broadcast({ type: 'log', text })
}

/** Every client sees the backend state and how many Hosts share it. */
function publishState(): void {
  broadcast({
    type: 'state', state, clients: clients.size,
    ...(running === undefined ? {} : { url: running.url, pid: running.pid }),
  })
}

function setState(next: KeeperState): void {
  state = next
  publishState()
}

function clearIdle(): void {
  if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined }
}

/** Republish the record: control facts never change, the backend identity does. */
function publishRecord(): void {
  writeShareRecord({
    protocol: KEEPER_PROTOCOL, key, port: controlPort, token, pid: process.pid,
    startedAt: new Date().toISOString(),
    ...(backendIdentity === undefined ? {} : { backend: backendIdentity }),
  })
}

/** With no client left, the backend stays for a reconnect and is then reaped. */
function armIdle(): void {
  clearIdle()
  if (stopping !== undefined) return
  if (options.graceMs === 0) { void shutdown(); return }
  idleTimer = setTimeout(() => { if (clients.size === 0) void shutdown() }, options.graceMs)
}

async function reap(): Promise<void> {
  const current = tree
  const ended = childDone
  tree = undefined
  running = undefined
  backendIdentity = undefined
  await current?.stop()
  await ended
}

/**
 * Reap a backend orphaned by a keeper that was killed outright.
 *
 * The control port was free, so the previous keeper is gone; its recorded
 * backend keeps holding the workspace's backend port. Only a process whose start
 * time still matches the record is killed, so PID reuse can never hit a stranger.
 */
async function reapOrphan(stale: ShareRecord | undefined): Promise<void> {
  const backend = stale?.backend
  if (backend === undefined) return
  if (processStart(backend.pid) !== backend.start) return
  await new ProcessTree(backend.pid).stop()
}

function readLaunchUrl(spawned: ChildProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    let output = ''
    let stdout = ''
    const finish = (error?: Error, url = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolve(url)
      else reject(error)
    }
    const timer = setTimeout(() => { finish(new Error(`dsh startup timed out\n${output}`)) }, 90_000)
    const capture = (text: string): void => {
      output = (output + text).slice(-OUTPUT_LIMIT)
      record(text)
    }
    spawned.stdout?.setEncoding('utf8')
    spawned.stderr?.setEncoding('utf8')
    spawned.stdout?.on('data', (text: string) => {
      capture(text)
      if (settled) return
      stdout = (stdout + text).slice(-OUTPUT_LIMIT)
      // Wait for a delimiter: a token split across chunks must not be consumed early.
      const match = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+(?=\s)/u.exec(stdout)
      if (match !== null) finish(undefined, match[0])
    })
    spawned.stderr?.on('data', capture)
    spawned.once('error', error => { finish(error) })
    spawned.once('exit', (code, signal) => {
      finish(new Error(`dsh web exited code=${String(code)} signal=${String(signal)}\n${output}`))
    })
  })
}

/** Exchange the one-time launch token for the cookie every attached proxy injects. */
function exchangeAuthCookie(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET', agent: false }, (res) => {
      const setCookie = res.headers['set-cookie']
      res.resume()
      res.on('error', reject)
      res.on('end', () => {
        const cookie = setCookie?.[0]?.split(';', 1)[0]
        if (cookie === undefined) reject(new Error('dsh web returned no browser-session cookie'))
        else resolve(cookie)
      })
    })
    const timer = setTimeout(() => { req.destroy(new Error('dsh web auth exchange timed out')) }, 10_000)
    req.on('close', () => { clearTimeout(timer) })
    req.on('error', reject)
    req.end()
  })
}

/** Start the CLI for this workspace; concurrent callers join one start. */
function start(launch: LaunchSpec): Promise<void> {
  if (starting !== undefined) return starting
  spec = launch
  setState('starting')
  starting = (async () => {
    const spawned = spawn(launch.command, [...launch.args], {
      cwd: launch.cwd, env: launch.env, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    tree = spawned.pid === undefined ? undefined : new ProcessTree(spawned.pid)
    childDone = new Promise(resolve => { spawned.once('close', () => { resolve() }) })
    const url = await readLaunchUrl(spawned)
    const cookie = await exchangeAuthCookie(url)
    const pid = spawned.pid
    if (pid === undefined) throw new Error('dsh web did not report a pid')
    const start = processStart(pid)
    if (start !== undefined) {
      backendIdentity = { pid, start }
      publishRecord()
    }
    running = { url, cookie, pid }
    setState('ready')
    broadcast({ type: 'ready', url, cookie, pid })
  })().catch(error => {
    running = undefined
    setState('failed')
    broadcast({ type: 'failure', message: error instanceof Error ? error.message : String(error) })
  }).finally(() => { starting = undefined })
  return starting
}

function shutdown(): Promise<void> {
  if (stopping !== undefined) return stopping
  stopping = (async () => {
    clearIdle()
    for (const socket of clients) socket.destroy()
    clients.clear()
    await reap()
    if (listener !== undefined) await new Promise<void>(resolve => { listener!.close(() => { resolve() }) })
    removeShareRecord(key)
    process.exit(0)
  })()
  return stopping
}

function onConnection(socket: Socket): void {
  socket.setEncoding('utf8')
  let buffer = ''
  let attached = false
  socket.on('error', () => { socket.destroy() })
  socket.on('close', () => {
    if (!attached) return
    attached = false
    clients.delete(socket)
    if (clients.size === 0) armIdle()
    else publishState()
  })
  socket.on('data', (chunk: string) => {
    buffer += chunk
    if (buffer.length > MESSAGE_LIMIT) { socket.destroy(); return }
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() === '') continue
      let request: KeeperRequest
      try {
        request = JSON.parse(line) as KeeperRequest
      } catch (_error) {
        socket.destroy()
        return
      }
      // Possession of the token published in the 0600 record is the only authority.
      if (request.token !== token) {
        send(socket, { type: 'failure', message: 'keeper token rejected' })
        socket.destroy()
        return
      }
      // A probe must not register a client; it only proves the port is a keeper.
      if (request.type === 'status') {
        send(socket, {
          type: 'state', state, clients: clients.size,
          ...(running === undefined ? {} : { url: running.url, pid: running.pid }),
        })
        continue
      }
      if (request.type === 'attach') {
        if (!attached) {
          attached = true
          clients.add(socket)
          clearIdle()
          publishState()
          if (logs !== '') send(socket, { type: 'log', text: logs })
        }
        if (running !== undefined) {
          send(socket, { type: 'ready', url: running.url, cookie: running.cookie, pid: running.pid })
        } else if (starting === undefined) {
          // idle and failed both recover here: attaching is the retry signal.
          void start(request.spec)
        } else if (spec === undefined) {
          spec = request.spec
        }
        continue
      }
      if (!attached) { socket.destroy(); return }
      if (request.type === 'restart') {
        if (spec === undefined) {
          send(socket, { type: 'failure', message: 'keeper has no launch spec to restart' })
          continue
        }
        const launch = spec
        void (async () => { await reap(); await start(launch) })()
        continue
      }
      socket.end()
      return
    }
  })
}

function bind(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ports = candidatePorts(key)
    const attempt = (index: number): void => {
      if (index >= ports.length) { reject(new Error('runtime-keeper: no free workspace control port')); return }
      const server = createServer(onConnection)
      server.once('error', (error: NodeJS.ErrnoException) => {
        server.removeAllListeners()
        if (error.code === 'EADDRINUSE') attempt(index + 1)
        else reject(error)
      })
      server.listen(ports[index]!, '127.0.0.1', () => { listener = server; resolve() })
    }
    attempt(0)
  })
}

async function main(): Promise<void> {
  await bind()
  const address = listener!.address()
  if (address === null || typeof address === 'string') throw new Error('runtime-keeper: control listener has no port')
  controlPort = address.port
  // Read the dead predecessor's record before this keeper overwrites it: only
  // that copy names the backend the killed keeper orphaned.
  const stale = readShareRecord(key)
  publishRecord()
  await reapOrphan(stale)
  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
  process.on('exit', () => {
    try { removeShareRecord(key) } catch (_error) { /* the record is stale at worst; clients verify the pid */ }
  })
  armIdle()
}

void main().catch(error => {
  process.stderr.write(`runtime-keeper: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
