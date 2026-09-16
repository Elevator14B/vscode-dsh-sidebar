/**
 * Extension Host lifecycle: own a guardian, authenticate its DSH backend, and
 * publish a window-local bridge proxy only after the complete generation is ready.
 */
import { randomUUID } from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { Server } from 'node:net'
import { readFileSync, realpathSync } from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { DshBridgeProxy } from './proxy'
import type { GuardianCommand, GuardianEvent, LaunchSpec } from './runtime-protocol'
import { ProcessTree } from './process-tree'

const START_TIMEOUT_MS = 150_000
/** Stable proxy port: VSCode auto-forwarding reuses it across restarts. */
const EMBED_PROXY_PORT = 39177
/**
 * First candidate backend port. The range stays clear of `EMBED_PROXY_PORT`,
 * so a workspace can never claim the port the proxy binds.
 */
const BACKEND_PORT_BASE = 39200
/** Ports one workspace hash may pick from. */
const BACKEND_PORT_SPAN = 800

/** Structured runtime event sink (usually Telemetry.log). */
export type RuntimeTelemetry = (event: string, data?: Record<string, unknown>) => void

interface CommandSpec {
  readonly command: string
  readonly args: readonly string[]
}

/**
 * Deterministic backend port for one workspace.
 *
 * The Web surface prompt names this backend's URL, and the system prompt is
 * what the provider caches: with an OS-assigned port every window restart
 * changes that URL, so every restart looks like a new prompt and the whole
 * system prompt is recomputed and re-sent. A stable port keeps the prompt
 * byte-identical across restarts.
 * @param canonicalCwd - resolved workspace folder the backend is pinned to.
 * @returns the preferred port for that folder.
 */
export function stableBackendPort(canonicalCwd: string): number {
  let hash = 2166136261
  for (let index = 0; index < canonicalCwd.length; index += 1) {
    hash ^= canonicalCwd.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return BACKEND_PORT_BASE + (hash % BACKEND_PORT_SPAN)
}

function commandFor(folder: vscode.WorkspaceFolder, port: number): CommandSpec {
  const config = vscode.workspace.getConfiguration('dsh.embed', folder.uri)
  const overrideCommand = config.get<string>('command', '').trim()
  const overrideArgs = config.get<string[]>('args', [])
  if (overrideCommand !== '' && overrideArgs.length > 0) {
    return { command: overrideCommand, args: overrideArgs }
  }
  return {
    command: overrideCommand === '' ? 'dsh' : overrideCommand,
    args: ['web', '--port', String(port), '--no-open'],
  }
}

/** Resolve symlinks the same way the spawned DSH backend will. */
function canonicalPath(value: string): string {
  try {
    return realpathSync(value)
  } catch (_error) {
    return value
  }
}

/**
 * Exchange the process launch token for the browser-session cookie on behalf
 * of the webview. The token never leaves the extension host and the cookie
 * never reaches the client browser: the proxy injects it on every upstream
 * request, so `Host`-authority and cookie-store differences across tunnels
 * cannot break authentication.
 * @param launchUrl - `http://127.0.0.1:<port>/?token=...` printed by dsh web.
 * @returns the cookie payload (`name=value`) or undefined when the exchange failed.
 */
function exchangeAuthCookie(launchUrl: string, signal: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(launchUrl, { method: 'GET', agent: false, signal }, (res) => {
      const setCookie = res.headers['set-cookie']
      res.resume()
      res.on('error', reject)
      res.on('end', () => { resolve(setCookie?.[0]?.split(';', 1)[0]) })
    })
    const timer = setTimeout(() => { req.destroy(new Error('dsh web auth exchange timed out')) }, 10_000)
    req.on('close', () => { clearTimeout(timer) })
    req.on('error', reject)
    req.end()
  })
}

/** One attempt owns every resource until its guardian confirms process exit. */
interface Generation {
  readonly abort: AbortController
  guardian?: ChildProcess
  ownership?: Server
  done?: Promise<void>
  proxy?: DshBridgeProxy
  url?: string
  failure?: Error
}

/** Owns a backend for this Extension Host; callers only share its current generation. */
export class DshRuntime implements vscode.Disposable {
  private current: Generation | undefined
  private starting: Promise<string> | undefined
  private stopping: Promise<void> | undefined
  private restarting: Promise<void> | undefined
  private disposed = false
  private readonly change = new vscode.EventEmitter<void>()
  readonly onDidChange = this.change.event

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly folder: vscode.WorkspaceFolder,
    private readonly output: vscode.OutputChannel,
    private readonly telemetry: RuntimeTelemetry = () => {},
    private readonly getTheme: () => 'light' | 'dark' = () => 'light',
  ) {}

  /** Undefined as soon as stopping or backend failure begins. */
  get origin(): string | undefined { return this.current?.url }

  /** Concurrent callers join one startup; a failed generation is reaped before replacement. */
  getWebUrl(): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('DSH runtime is disposed'))
    if (this.stopping !== undefined) return this.stopping.then(() => this.getWebUrl())
    if (this.current?.url !== undefined) return Promise.resolve(this.current.url)
    if (this.starting !== undefined) return this.starting
    if (this.current !== undefined) return this.stop().then(() => this.getWebUrl())
    const generation: Generation = { abort: new AbortController() }
    this.current = generation
    const starting = this.launch(generation).catch(async (error: unknown) => {
      generation.abort.abort()
      await this.cleanup(generation)
      if (this.current === generation) this.current = undefined
      throw error
    }).finally(() => { if (this.starting === starting) this.starting = undefined })
    this.starting = starting
    return starting
  }

  /** Concurrent restart requests produce one replacement backend. */
  restart(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('DSH runtime is disposed'))
    if (this.restarting !== undefined) return this.restarting
    const pending = this.stop().then(async () => {
      await this.getWebUrl()
      this.change.fire()
    }).finally(() => { if (this.restarting === pending) this.restarting = undefined })
    this.restarting = pending
    return pending
  }

  /** Cancel startup immediately, then wait for sockets and the guardian's process tree. */
  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    const generation = this.current
    if (generation === undefined) return Promise.resolve()
    generation.url = undefined
    generation.abort.abort()
    const starting = this.starting
    const pending = (async () => {
      await starting?.catch(() => {}) // The original caller receives the launch failure.
      await this.cleanup(generation)
      if (this.current === generation) this.current = undefined
    })().finally(() => { if (this.stopping === pending) this.stopping = undefined })
    this.stopping = pending
    return pending
  }

  /** Terminal disposal is awaitable by deactivate; the guardian also handles Host death. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.change.dispose()
    await this.stop()
  }

  private async cleanup(generation: Generation): Promise<void> {
    const guardian = generation.guardian
    if (guardian?.connected) guardian.send({ type: 'stop' } satisfies GuardianCommand, () => {})
    await Promise.all([
      generation.proxy?.close(),
      generation.done === undefined ? undefined : withDeadline(generation.done, 12_000,
        'DSH is still stopping; its workspace remains reserved until its processes exit.'),
    ])
    if (generation.ownership !== undefined) {
      await new Promise<void>(resolve => { generation.ownership!.close(() => { resolve() }) })
      generation.ownership = undefined
    }
  }

  private async launch(generation: Generation): Promise<string> {
    const runtimeId = randomUUID()
    const cwd = canonicalPath(this.folder.uri.fsPath)
    const spec = commandFor(this.folder, stableBackendPort(cwd))
    const env = { ...process.env, DSH_EMBED: '1', NO_COLOR: process.env.NO_COLOR ?? '1' }
    this.telemetry('runtime.starting', { command: spec.command, args: [...spec.args], cwd, hostPid: process.pid, runtimeId })
    const startUrl = await this.startGuardian(generation, { ...spec, cwd, env })
    generation.abort.signal.throwIfAborted()
    const authCookie = await exchangeAuthCookie(startUrl, generation.abort.signal)
    if (authCookie === undefined) throw new Error('dsh web auth exchange failed: launch URL did not return a browser-session cookie')
    generation.abort.signal.throwIfAborted()
    const backend = new URL(startUrl)
    const proxy = new DshBridgeProxy(backend.origin,
      readFileSync(path.join(this.context.extensionUri.fsPath, 'dist', 'bridge.js'), 'utf8'), {
        cwd: this.folder.uri.fsPath, canonicalCwd: cwd, title: this.folder.name,
        theme: this.getTheme(), locale: vscode.env.language, runtimeId,
      }, authCookie)
    generation.proxy = proxy
    const port = await proxy.listen(EMBED_PROXY_PORT)
    generation.abort.signal.throwIfAborted()
    if (generation.failure !== undefined) throw generation.failure
    generation.url = proxy.origin
    this.telemetry('runtime.ready', { backendPort: Number(backend.port), proxyPort: port, cwd, hostPid: process.pid })
    this.output.appendLine(`[runtime] ready: ${proxy.origin}`)
    return proxy.origin
  }

  private startGuardian(generation: Generation, spec: LaunchSpec): Promise<string> {
    const guardian = fork(path.join(this.context.extensionUri.fsPath, 'dist', 'runtime-guardian.js'), [], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    generation.guardian = guardian
    guardian.unref()
    guardian.channel?.unref()
    const processes = new Map<number, ProcessTree>()
    generation.done = new Promise<void>((resolve, reject) => {
      guardian.once('error', error => { reject(error) })
      guardian.once('exit', () => {
        // A surviving Host is the fallback owner if the guardian itself crashes.
        void Promise.all([...processes.values()].map(tree => tree.stop())).then(() => { resolve() }, reject)
      })
    })
    // The startup listener reports spawn errors; keep the completion rejection observed too.
    void generation.done.catch(() => {})
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error, url = ''): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        generation.abort.signal.removeEventListener('abort', cancelled)
        if (error !== undefined) reject(error)
        else resolve(url)
      }
      const cancelled = (): void => { finish(new Error('Runtime startup cancelled')) }
      const timer = setTimeout(() => { finish(new Error('DSH guardian startup timed out')) }, START_TIMEOUT_MS)
      generation.abort.signal.addEventListener('abort', cancelled, { once: true })
      guardian.on('message', (event: GuardianEvent, handle) => {
        switch (event.type) {
          case 'ownership':
            if (!(handle instanceof Server)) { finish(new Error('DSH guardian did not transfer workspace ownership')); break }
            generation.ownership = handle
            handle.unref()
            handle.on('connection', socket => {
              socket.on('error', () => { socket.destroy() })
              socket.end(JSON.stringify(event.identity) + '\n')
              socket.setTimeout(1000, () => { socket.destroy() })
            })
            break
          case 'process-started': processes.set(event.pid, new ProcessTree(event.pid)); break
          case 'process-reaped': processes.delete(event.pid); break
          case 'log': this.output.append(event.text); break
          case 'version':
            this.output.appendLine(`[runtime] ${event.message}`)
            this.telemetry('runtime.version', { version: event.version ?? null, ok: event.ok })
            break
          case 'url':
            this.telemetry('runtime.spawned', { hostPid: process.pid, guardianPid: guardian.pid, backendPid: event.pid })
            finish(undefined, event.url)
            break
          case 'failure':
            generation.failure = new Error(event.message)
            generation.url = undefined
            this.output.appendLine(`[runtime] ${event.message}`)
            finish(generation.failure)
            break
          case 'stopped': break
        }
      })
      guardian.once('error', error => { finish(error) })
      guardian.once('exit', (code, signal) => {
        generation.url = undefined
        generation.failure ??= new Error(`DSH guardian exited code=${String(code)} signal=${String(signal)}`)
        finish(generation.failure)
        this.telemetry('runtime.exited', { code, signal })
        if (this.current === generation && !generation.abort.signal.aborted && !this.disposed) this.change.fire()
      })
      guardian.send({ type: 'start', spec } satisfies GuardianCommand, error => {
        if (error !== null) finish(error)
      })
    })
  }
}

function withDeadline<T>(pending: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(message)) }, milliseconds)
    void pending.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
