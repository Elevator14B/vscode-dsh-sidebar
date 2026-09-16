/**
 * Loopback reverse proxy around the spawned DSH web server.
 *
 * The proxy solves three problems the iframe cannot solve by itself: it gives
 * the page one stable same-origin authority (browser auth cookies bind to the
 * authority), it injects the VS Code bridge before the app boots, and it keeps
 * the random backend port invisible to the webview.
 */
import { request as httpRequest, createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'

/** Bridge injection facts read by the injected classic script. */
export interface BridgeConfig {
  /** Absolute VS Code workspace folder used as the Host working directory. */
  readonly cwd: string
  /** Realpath of `cwd`; the DSH backend stores Workspaces under this form. */
  readonly canonicalCwd: string
  /** Display title for diagnostics. */
  readonly title: string
  /** Initial color scheme: 'light', 'dark', or 'system' (VSCode theme map). */
  readonly theme: 'light' | 'dark'
  /** VS Code display language (`vscode.env.language`), for bridge-owned chrome. */
  readonly locale: string
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Copy request or response headers while dropping hop-by-hop fields. */
function copyHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue
    out[key] = value
  }
  return out
}

/** Response-side fields that must never reach the browser. */
const RESPONSE_STRIP = new Set(['set-cookie', 'set-cookie2'])

/** Copy response headers, dropping hop-by-hop fields and every cookie the backend sets. */
function copyResponseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const out = copyHeaders(headers)
  for (const key of Object.keys(out)) {
    if (RESPONSE_STRIP.has(key.toLowerCase())) delete out[key]
  }
  return out
}

/** One loopback auth/injection proxy for a DSH web origin. */
export class DshBridgeProxy {
  private server: Server | undefined
  private port = 0

  /**
   * @param backendOrigin - Spawned server origin, e.g. `http://127.0.0.1:38709`.
   * @param bridgeSource - Injected classic bridge script bytes.
   * @param config - Workspace facts exposed to the bridge.
   * @param browserAuthCookie - Cookie minted by the extension host's launch-token
   * exchange; injected on every upstream request so the client browser never
   * needs to hold or forward DSH auth state.
   */
  constructor(
    private readonly backendOrigin: string,
    private readonly bridgeSource: string,
    private readonly config: BridgeConfig,
    private readonly browserAuthCookie: string | undefined,
  ) {}

  /** Bind the proxy on a loopback port. */
  listen(requestedPort = 0): Promise<number> {
    if (this.server !== undefined) return Promise.resolve(this.port)
    this.server = createServer((req, res) => { void this.handle(req, res) })
    this.server.on('upgrade', (req, socket, head) => { this.upgrade(req, socket as Duplex, head) })
    return this.listenOn(requestedPort)
  }

  private listenOn(requestedPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        // A stale proxy from a previous extension-host generation may still hold
        // the fixed port right after reload; fall back to a random loopback port.
        if (error.code === 'EADDRINUSE' && requestedPort !== 0) {
          this.server!.off('error', onError)
          void this.listenOn(0).then(resolve, reject)
          return
        }
        this.server!.off('error', onError)
        reject(error)
      }
      this.server!.once('error', onError)
      this.server!.listen(requestedPort, '127.0.0.1', () => {
        this.server!.off('error', onError)
        this.port = (this.server!.address() as AddressInfo).port
        resolve(this.port)
      })
    })
  }

  /** Stable origin for logs and cookie authority. */
  get origin(): string {
    return `http://127.0.0.1:${String(this.port)}`
  }

  /** Close the proxy; pending connections end with the extension. */
  close(): Promise<void> {
    const server = this.server
    this.server = undefined
    return server === undefined ? Promise.resolve() : new Promise((resolve) => { server.close(() => { resolve() }) })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://proxy.invalid').pathname
    if (pathname === '/__dsh_vscode_bridge.js') {
      // Config rides the external script (never inline): the bridge is too large
      // for reliable inline script-data parsing inside the app's HTML tokenizer.
      const config = JSON.stringify(this.config).replace(/</gu, '\\u003c')
      const body = `window.__DSH_VSCODE__ = ${config};\n${this.bridgeSource}`
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
      return
    }
    if (pathname === '/__dsh_vscode_health') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('ok')
      return
    }

    const backend = new URL(this.backendOrigin)
    const headers = copyHeaders(req.headers)
    // Upstream must see the backend's own authority: the client-side tunnel
    // rewrites Host arbitrarily, the browser-session cookie is authority-bound,
    // and the /api trust fence requires Origin to match Host.
    headers.host = backend.host
    headers.origin = backend.origin
    headers['accept-encoding'] = 'identity'
    if (this.browserAuthCookie !== undefined) headers.cookie = this.browserAuthCookie
    const upstream = httpRequest({
      hostname: backend.hostname,
      port: backend.port,
      method: req.method,
      path: req.url,
      headers,
      agent: false,
    }, (upstreamResponse) => { void this.relay(upstreamResponse, res, req.method ?? 'GET') })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh backend unavailable')
    })
    req.on('aborted', () => { upstream.destroy() })
    req.pipe(upstream)
  }

  /** Raw TCP tunnel for WebSocket upgrades (`/api/remote.mux`). */
  private upgrade(req: IncomingMessage, client: Duplex, head: Buffer): void {
    const backend = new URL(this.backendOrigin)
    const upstream = connect(Number(backend.port), backend.hostname, () => {
      const headers = copyHeaders(req.headers)
      headers.host = backend.host
      headers.origin = backend.origin
      headers.connection = 'Upgrade'
      headers.upgrade = 'websocket'
      if (this.browserAuthCookie !== undefined) headers.cookie = this.browserAuthCookie
      const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}`]
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) continue
        lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      lines.push('', '')
      upstream.write(lines.join('\r\n'))
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => { client.destroy() })
    client.on('error', () => { upstream.destroy() })
  }

  private async relay(upstream: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
    // The extension host owns the only DSH credential and injects it on every
    // upstream request, so a backend-issued cookie has no business in the
    // browser: this is what makes that guarantee structural, not incidental.
    const headers = copyResponseHeaders(upstream.headers)
    const mediaType = String(upstream.headers['content-type'] ?? '')
    if (method !== 'HEAD' && mediaType.toLowerCase().includes('text/html')) {
      const chunks: Buffer[] = []
      for await (const chunk of upstream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
      const html = Buffer.concat(chunks).toString('utf8')
      const injected = this.inject(html)
      delete headers['content-length']
      delete headers['content-encoding']
      delete headers['etag']
      headers['cache-control'] = 'no-store'
      res.writeHead(upstream.statusCode ?? 200, upstream.statusMessage, headers)
      res.end(injected)
      return
    }
    res.writeHead(upstream.statusCode ?? 200, upstream.statusMessage, headers)
    upstream.pipe(res)
  }

  private inject(html: string): string {
    // The boot script carries the durable built-in preference; every literal
    // the Host can produce ("light"/"dark"/"system") gets replaced with the
    // VS Code theme so the pre-plugin first paint matches VS Code. The client
    // ThemeRuntime then re-adopts the setting document after activation, so
    // the bridge also drives `theme.setTheme` (see bridge.js configure).
    const base = html.replace(
      /const preference = "(?:light|dark|system)"/u,
      `const preference = ${JSON.stringify(this.config.theme)}`,
    )
    const injection = '<script src="/__dsh_vscode_bridge.js"></script>'
    if (/<\/head>/iu.test(base)) return base.replace(/<\/head>/iu, `${injection}</head>`)
    return `${injection}${base}`
  }
}
