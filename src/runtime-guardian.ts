/** Standalone guardian: IPC EOF means Extension Host death, never SSH disconnect. */
import { spawn, type ChildProcess } from 'node:child_process'
import type { Server } from 'node:net'
import { evaluateDshVersion } from './dsh-version'
import { claimWorkspace } from './runtime-ownership'
import { ProcessTree } from './process-tree'
import { OUTPUT_LIMIT, type GuardianCommand, type GuardianEvent, type LaunchSpec } from './runtime-protocol'

const abort = new AbortController()
let ownership: Server | undefined
let child: ChildProcess | undefined
let tree: ProcessTree | undefined
let childDone: Promise<void> | undefined
let active: Promise<void> | undefined
let stopping: Promise<void> | undefined
let pendingLogs = 0
let droppedLogs = false

function report(event: GuardianEvent): void {
  if (!process.connected) return
  // Output must never keep growing in the IPC queue if the Host is busy.
  if (event.type === 'log' && pendingLogs >= OUTPUT_LIMIT) { droppedLogs = true; return }
  const size = event.type === 'log' ? event.text.length : 0
  pendingLogs += size
  process.send?.(event, error => {
    pendingLogs -= size
    if (error !== null) { void stop(); return }
    if (droppedLogs && pendingLogs === 0) {
      droppedLogs = false
      report({ type: 'log', text: '[runtime] output truncated while Extension Host was busy\n' })
    }
  })
}

async function stopChild(): Promise<void> {
  await tree?.stop()
  await childDone
  if (child?.pid !== undefined) report({ type: 'process-reaped', pid: child.pid })
  tree = undefined
  child = undefined
}

function stop(): Promise<void> {
  if (stopping !== undefined) return stopping
  abort.abort(new Error('Extension Host stopped the runtime'))
  stopping = (async () => {
    await active?.catch(() => {}) // The launch error is reported by its single owner below.
    await stopChild()
    if (ownership !== undefined) await new Promise<void>(resolve => { ownership!.close(() => { resolve() }) })
    clearInterval(sampler)
    report({ type: 'stopped' })
    if (process.connected) process.disconnect()
  })().catch(error => {
    report({ type: 'failure', message: `Runtime cleanup failed: ${String(error)}` })
    // Retain ownership rather than permit a replacement writer after failed cleanup.
  })
  return stopping
}

async function run(spec: LaunchSpec, probe: boolean): Promise<string> {
  abort.signal.throwIfAborted()
  const spawned = spawn(spec.command, probe ? ['--version'] : [...spec.args], {
    cwd: spec.cwd, env: spec.env, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  child = spawned
  tree = spawned.pid === undefined ? undefined : new ProcessTree(spawned.pid)
  if (spawned.pid !== undefined) report({ type: 'process-started', pid: spawned.pid })
  childDone = new Promise(resolve => { spawned.once('close', () => { resolve() }) })
  let output = ''
  let stdout = ''
  return await new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      abort.signal.removeEventListener('abort', cancelled)
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const cancelled = (): void => { finish(new Error('Runtime startup cancelled')) }
    abort.signal.addEventListener('abort', cancelled, { once: true })
    const timer = setTimeout(() => { finish(new Error(`dsh ${probe ? 'version probe' : 'startup'} timed out\n${output}`)) }, probe ? 15_000 : 90_000)
    spawned.stdout.setEncoding('utf8')
    spawned.stderr.setEncoding('utf8')
    const record = (text: string): void => {
      output = (output + text).slice(-OUTPUT_LIMIT)
      if (!probe) report({ type: 'log', text })
    }
    spawned.stdout.on('data', (text: string) => {
      record(text)
      if (settled || probe) return
      stdout = (stdout + text).slice(-OUTPUT_LIMIT)
      // Wait for a delimiter: accepting a partial token at a chunk boundary
      // consumes the one-time authentication token with the wrong value.
      const match = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+(?=\s)/u.exec(stdout)
      if (match !== null) finish(undefined, match[0])
    })
    spawned.stderr.on('data', record)
    spawned.once('error', error => { finish(error) })
    spawned.once('exit', (code, signal) => {
      if (probe) { finish(undefined, output); return }
      const error = new Error(`dsh web exited code=${String(code)} signal=${String(signal)}\n${output}`)
      if (!settled) finish(error)
      else if (!abort.signal.aborted) {
        report({ type: 'failure', message: error.message })
        void stop()
      }
    })
  })
}

async function start(spec: LaunchSpec): Promise<void> {
  const claim = await claimWorkspace(spec.cwd, abort.signal)
  ownership = claim.server
  if (process.connected) {
    await new Promise<void>((resolve, reject) => {
      // Both processes retain the kernel listener. Either surviving owner holds
      // workspace exclusion until it has reaped the backend.
      process.send!({ type: 'ownership', identity: claim.identity } satisfies GuardianEvent, ownership, error => {
        if (error !== null) reject(error)
        else resolve()
      })
    })
  }
  abort.signal.throwIfAborted()
  let versionOutput: string
  try { versionOutput = await run(spec, true) } catch (error) {
    abort.signal.throwIfAborted()
    // A custom executable may not support --version, but it still needs to be
    // reaped before launching the real command.
    report({ type: 'log', text: `[runtime] version probe failed: ${String(error)}\n` })
    versionOutput = ''
  }
  await stopChild()
  abort.signal.throwIfAborted()
  const gate = evaluateDshVersion(versionOutput)
  report({ type: 'version', ...gate })
  if (!gate.ok) throw new Error(gate.message)
  const url = await run(spec, false)
  abort.signal.throwIfAborted()
  report({ type: 'url', url, pid: child!.pid! })
}

const sampler = setInterval(() => {
  if (process.platform === 'linux') tree?.sample()
}, 500)

process.on('message', (message: GuardianCommand) => {
  if (message.type === 'stop') { void stop(); return }
  if (message.type !== 'start' || active !== undefined || abort.signal.aborted) return
  active = start(message.spec)
  void active.catch(error => {
    if (!abort.signal.aborted) report({ type: 'failure', message: String(error) })
    void stop()
  })
})
process.once('disconnect', () => { void stop() })
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
if (!process.connected) void stop()
