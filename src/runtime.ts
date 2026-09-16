/**
 * Per-workspace DSH runtime lifecycle: spawn the source web CLI with the
 * workspace folder as cwd, capture its authenticated URL, and wrap it in the
 * loopback bridge proxy.
 */
import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import type { Readable } from 'node:stream'
import { readFileSync, realpathSync } from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { DshBridgeProxy } from './proxy'
import { evaluateDshVersion } from './dsh-version'

const START_TIMEOUT_MS = 90_000
/** How long 'dsh --version' may take before the probe gives up. */
const VERSION_PROBE_TIMEOUT_MS = 15_000
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

/** Whether one launch failure means the preferred port is already taken. */
function isAddressInUse(message: string): boolean {
  return /EADDRINUSE|address already in use/iu.test(message)
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

/** Resolve symlinks/bind mounts the same way the spawned DSH backend will. */
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
function exchangeAuthCookie(launchUrl: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(launchUrl, { method: 'GET', agent: false }, (res) => {
      const setCookie = res.headers['set-cookie']
      res.resume()
      res.on('end', () => { resolve(setCookie?.[0]?.split(';', 1)[0]) })
    })
    req.on('error', reject)
    req.end()
  })
}

/** Owns one backend and one proxy for one workspace folder. */
export class DshRuntime implements vscode.Disposable {
  private child: ChildProcessByStdio<null, Readable, Readable> | undefined
  private proxy: DshBridgeProxy | undefined
  private webUrl: string | undefined
  private starting: Promise<string> | undefined
  private readonly change = new vscode.EventEmitter<void>()
  /** Re-emitted after every successful (re)start. */
  readonly onDidChange = this.change.event

  /**
   * @param context - Extension context locating packaged bridge/proxy resources.
   * @param folder - Workspace folder pinned as the DSH working directory.
   * @param output - Shared extension output channel.
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly folder: vscode.WorkspaceFolder,
    private readonly output: vscode.OutputChannel,
    private readonly telemetry: RuntimeTelemetry = () => {},
    private readonly getTheme: () => 'light' | 'dark' = () => 'light',
  ) {}

  /** Current proxy origin for in-process API calls; undefined before ready. */
  get origin(): string | undefined {
    return this.proxy?.origin ?? (this.webUrl === undefined ? undefined : new URL(this.webUrl).origin)
  }

  /** Current bridge-proxy URL, starting the runtime on first use. */
  getWebUrl(): Promise<string> {
    if (this.webUrl !== undefined && this.child !== undefined && this.child.exitCode === null) {
      return Promise.resolve(this.webUrl)
    }
    if (this.starting === undefined) {
      this.starting = this.launch().finally(() => { this.starting = undefined })
    }
    return this.starting
  }

  /** Kill and relaunch both backend and proxy. */
  async restart(): Promise<void> {
    await this.stop()
    await this.getWebUrl()
    this.change.fire()
  }

  /** Stop the backend and proxy; safe when already stopped. */
  async stop(): Promise<void> {
    const child = this.child
    const proxy = this.proxy
    this.child = undefined
    this.proxy = undefined
    this.webUrl = undefined
    if (child !== undefined && child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL')
          resolve()
        }, 3000)
        child.once('exit', () => { clearTimeout(timer); resolve() })
      })
    }
    if (proxy !== undefined) await proxy.close()
  }

  /** @inheritdoc */
  dispose(): void {
    void this.stop()
    this.change.dispose()
  }

  private async launch(): Promise<string> {
    const cwd = this.folder.uri.fsPath
    const canonicalCwd = canonicalPath(cwd)
    const env: NodeJS.ProcessEnv = { ...process.env, DSH_EMBED: '1', NO_COLOR: process.env.NO_COLOR ?? '1' }
    const preferred = stableBackendPort(canonicalCwd)
    await this.checkVersion(commandFor(this.folder, preferred).command, cwd, env)
    let startUrl: string
    try {
      startUrl = await this.startProcess(commandFor(this.folder, preferred), cwd, canonicalCwd, env)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A second window on the same folder (or any other holder) takes the
      // stable port first; an ephemeral port still serves this launch, at the
      // cost of a new prompt URL.
      if (!isAddressInUse(message)) throw error
      this.output.appendLine(`[runtime] port ${String(preferred)} is in use; falling back to an ephemeral port`)
      this.telemetry('runtime.port-fallback', { port: preferred })
      startUrl = await this.startProcess(commandFor(this.folder, 0), cwd, canonicalCwd, env)
    }

    const backend = new URL(startUrl)
    const bridgeSource = readFileSync(path.join(this.context.extensionUri.fsPath, 'dist', 'bridge.js'), 'utf8')
    let authCookie: string | undefined
    try {
      authCookie = await exchangeAuthCookie(startUrl)
    } catch (error) {
      throw new Error(`dsh web auth exchange failed: ${String(error)}`)
    }
    if (authCookie === undefined) {
      throw new Error('dsh web auth exchange failed: launch URL did not return a browser-session cookie')
    }
    this.telemetry('runtime.auth-exchanged', { backendPort: backend.port })
    const proxy = new DshBridgeProxy(backend.origin, bridgeSource, {
      cwd,
      canonicalCwd,
      title: this.folder.name,
      theme: this.getTheme(),
      locale: vscode.env.language,
    }, authCookie)
    const port = await proxy.listen(EMBED_PROXY_PORT)
    this.proxy = proxy
    this.webUrl = proxy.origin
    this.telemetry('runtime.ready', { backendPort: Number(backend.port), proxyPort: port, cwd })
    this.output.appendLine(`[runtime] ready: ${proxy.origin} -> ${startUrl.replace(/\?token=.*$/u, '/?token=<redacted>')}`)
    return this.webUrl
  }

  /**
   * Probe the CLI version before starting it. DeepSeek Harness is a developer
   * preview and the extension drives its Web client protocol directly: an older
   * CLI cannot be served by this build, and refusing it here produces a readable
   * diagnosis instead of a boot timeout or a half-rendered page.
   * @param command - executable that would be spawned.
   * @param cwd - workspace folder used for the probe.
   * @param env - child environment.
   */
  private async checkVersion(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
    const output = await new Promise<string>((resolve) => {
      execFile(command, ['--version'], { cwd, env, timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true },
        (error, stdout, stderr) => {
          const text = String(stdout) + String(stderr)
          if (error !== null && text.trim() === '') {
            this.output.appendLine('[runtime] version probe failed: ' + error.message)
            resolve('')
            return
          }
          resolve(text)
        })
    })
    const gate = evaluateDshVersion(output)
    this.telemetry('runtime.version', { command, version: gate.version ?? null, ok: gate.ok })
    this.output.appendLine('[runtime] version check: ' + gate.message)
    if (!gate.ok) throw new Error(gate.message)
  }

  /**
   * Spawn one backend generation and wait for the authenticated URL it prints.
   * @param spec - command and args for this attempt.
   * @param cwd - workspace folder the backend is pinned to.
   * @param canonicalCwd - resolved form of `cwd`, for telemetry.
   * @param env - child environment.
   * @returns the printed launch URL.
   */
  private async startProcess(spec: CommandSpec, cwd: string, canonicalCwd: string, env: NodeJS.ProcessEnv): Promise<string> {
    this.telemetry('runtime.starting', { command: spec.command, args: [...spec.args], cwd, canonicalCwd })
    this.output.appendLine(`[runtime] starting: ${spec.command} ${spec.args.join(' ')} (cwd ${cwd})`)
    const child = spawn(spec.command, [...spec.args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    let settled = false
    return await new Promise<string>((resolve, reject) => {
      let stderr = ''
      let stdout = ''
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`dsh web did not print a URL within ${String(START_TIMEOUT_MS / 1000)}s\n${stdout}\n${stderr}`))
      }, START_TIMEOUT_MS)
      const onData = (chunk: Buffer | string): void => {
        const text = chunk.toString()
        stdout += text
        this.output.append(text)
        const match = /(https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/u.exec(text)
        if (match !== null && !settled) {
          settled = true
          clearTimeout(timer)
          resolve(match[1])
        }
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', onData)
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
        this.output.append(chunk)
      })
      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`failed to start ${spec.command}: ${error.message}`))
      })
      child.once('exit', (code, signal) => {
        this.output.appendLine(`[runtime] exited code=${String(code)} signal=${String(signal)}`)
        this.telemetry('runtime.exited', { code, signal })
        if (settled) {
          this.change.fire()
          return
        }
        settled = true
        clearTimeout(timer)
        reject(new Error(`dsh web exited before ready (code ${String(code)}, signal ${String(signal)})\n${stdout}\n${stderr}`))
      })
    })
  }
}
