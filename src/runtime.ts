/**
 * Extension Host lifecycle: attach to this workspace's keeper, publish a
 * window-local bridge proxy, and detach without taking the shared backend away.
 *
 * A window never owns the backend. Several Remote-SSH connections, windows or
 * replaced Extension Hosts of one folder attach to the same keeper, so the
 * backend outlives any single one of them.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { DshBridgeProxy } from './proxy'
import { ensureKeeper, type KeeperClient } from './runtime-client'
import { ATTACH_DEADLINE_MS, type KeeperEvent, type LaunchSpec } from './runtime-protocol'

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
 * what the provider caches: with an OS-assigned port every restart changes that
 * URL, so every restart looks like a new prompt and the whole system prompt is
 * recomputed and re-sent. A stable port keeps the prompt byte-identical across
 * restarts, and is what lets several windows of one folder share one backend.
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

/** One attachment owns a proxy and a control connection until it is replaced. */
interface Generation {
  readonly abort: AbortController
  client?: KeeperClient
  stopObserving?: () => void
  stopWatching?: () => void
  proxy?: DshBridgeProxy
  url?: string
  failure?: Error
}

/** Attaches this window to its workspace backend; callers share one generation. */
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

  /** Concurrent callers join one attachment; a failed attachment is dropped first. */
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

  /**
   * Rebuild the browser-facing proxy on a fresh loopback authority.
   *
   * VS Code caches one client-side forward per remote authority. When the SSH
   * transport drops, that forward can stay dead while `asExternalUri` keeps
   * returning the same local URL, so the page can never load again. A port VS
   * Code has never resolved is the one repair its cache cannot answer.
   * @returns the new proxy origin, or undefined when no backend is ready.
   */
  async rotateOrigin(): Promise<string | undefined> {
    const generation = this.current
    if (generation?.proxy === undefined || generation.url === undefined) return undefined
    const port = await generation.proxy.relisten()
    generation.url = generation.proxy.origin
    this.telemetry('runtime.proxy-rotated', { proxyPort: port, hostPid: process.pid })
    return generation.url
  }

  /**
   * Replace the shared backend through the keeper.
   *
   * Every window of this workspace observes the same replacement: the command
   * is documented as interrupting running tasks, and sharing makes that literal.
   */
  restart(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('DSH runtime is disposed'))
    if (this.restarting !== undefined) return this.restarting
    const pending = (async () => {
      const client = this.current?.client
      if (client === undefined) {
        await this.getWebUrl()
        this.change.fire()
        return
      }
      await client.restart(ATTACH_DEADLINE_MS)
      this.change.fire()
    })().finally(() => { if (this.restarting === pending) this.restarting = undefined })
    this.restarting = pending
    return pending
  }

  /** Detach from the shared backend; every other window keeps using it. */
  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    const generation = this.current
    if (generation === undefined) return Promise.resolve()
    generation.url = undefined
    generation.abort.abort()
    const starting = this.starting
    const pending = (async () => {
      await starting?.catch(() => {}) // The original caller receives the attachment failure.
      await this.cleanup(generation)
      if (this.current === generation) this.current = undefined
    })().finally(() => { if (this.stopping === pending) this.stopping = undefined })
    this.stopping = pending
    return pending
  }

  /** Terminal disposal is awaitable by deactivate; the keeper outlives it. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.change.dispose()
    await this.stop()
  }

  private async cleanup(generation: Generation): Promise<void> {
    generation.stopObserving?.()
    generation.stopWatching?.()
    generation.client?.detach()
    generation.client = undefined
    await generation.proxy?.close()
  }

  private async launch(generation: Generation): Promise<string> {
    const runtimeId = randomUUID()
    const cwd = canonicalPath(this.folder.uri.fsPath)
    const spec: LaunchSpec = {
      ...commandFor(this.folder, stableBackendPort(cwd)),
      cwd,
      env: { ...process.env, DSH_EMBED: '1', NO_COLOR: process.env.NO_COLOR ?? '1' },
    }
    this.telemetry('runtime.starting', { command: spec.command, args: [...spec.args], cwd, hostPid: process.pid, runtimeId })
    const keeperPath = path.join(this.context.extensionUri.fsPath, 'dist', 'runtime-keeper.js')
    const location = await untilAborted(ensureKeeper(cwd, keeperPath, START_TIMEOUT_MS, this.telemetry), generation.abort.signal)
    generation.client = location.client
    generation.stopObserving = location.client.onEvent(event => { this.observe(event) })
    // A keeper that dies takes the shared backend with it: drop readiness so the
    // connection ladder attaches again — and forks a replacement — instead of
    // proxying into a closed port forever.
    generation.stopWatching = location.client.onClose(() => {
      if (generation.abort.signal.aborted || this.disposed) return
      generation.url = undefined
      this.output.appendLine('[runtime] the workspace keeper exited; reconnecting')
      this.change.fire()
    })
    const ready = await untilAborted(location.client.attach(spec, ATTACH_DEADLINE_MS), generation.abort.signal)
    generation.abort.signal.throwIfAborted()
    const backend = new URL(ready.url)
    const proxy = new DshBridgeProxy(backend.origin,
      readFileSync(path.join(this.context.extensionUri.fsPath, 'dist', 'bridge.js'), 'utf8'), {
        cwd: this.folder.uri.fsPath, canonicalCwd: cwd, title: this.folder.name,
        theme: this.getTheme(), locale: vscode.env.language, runtimeId,
      }, ready.cookie)
    generation.proxy = proxy
    const port = await proxy.listen(EMBED_PROXY_PORT)
    generation.abort.signal.throwIfAborted()
    if (generation.failure !== undefined) throw generation.failure
    generation.url = proxy.origin
    this.telemetry('runtime.ready', {
      backendPort: Number(backend.port), proxyPort: port, cwd, hostPid: process.pid,
      keeperPid: location.record.pid, shared: !location.started,
    })
    this.output.appendLine(`[runtime] ${location.started ? 'started' : 'attached to'} ${ready.url} (keeper ${String(location.record.pid)}), ready: ${proxy.origin}`)
    return proxy.origin
  }

  private observe(event: KeeperEvent): void {
    if (event.type === 'log') { this.output.append(event.text); return }
    if (event.type === 'failure') { this.output.appendLine(`[runtime] ${event.message}`); return }
    if (event.type === 'state') this.telemetry('runtime.keeper-state', { state: event.state, clients: event.clients })
  }
}

/** Reject a pending startup when the caller cancels, without leaking a listener. */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancelled = (): void => { reject(new Error('Runtime startup cancelled')) }
    signal.addEventListener('abort', cancelled, { once: true })
    void pending.then(
      value => { signal.removeEventListener('abort', cancelled); resolve(value) },
      error => { signal.removeEventListener('abort', cancelled); reject(error) },
    )
  })
}
