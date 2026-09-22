#!/usr/bin/env node
/**
 * Contract smoke test: proves the assumptions this extension makes about the
 * installed DeepSeek Harness CLI still hold, using a real 'dsh' process
 * instead of a mock. Run it after 'dsh' is on PATH:
 *
 *   npm run smoke
 *
 * Checked contracts (all of them are consumed by src/runtime.ts,
 * src/runtime-client.ts, src/session-panel.ts and src/session-actions.ts):
 *   1. the keeper launches 'dsh web --port <n> --no-open' and reports a URL;
 *   2. that URL exchanges for a browser-session cookie;
 *   3. 'session/list' answers the client-request envelope the tree uses;
 *   4. 'workspace/insertSessionBefore' moves one accounted session in the
 *      workspace's manual order and echoes the resulting order;
 *   5. 'workspace/archiveSession' adds one session to the archive set;
 *   6. a second window of the same folder attaches to that same backend;
 *   7. detaching one window leaves the other one working;
 *   8. the last window detaching lets the keeper reap the backend.
 *
 * Checks 4 and 5 register a throwaway workspace over the temporary directory
 * and delete that registration again, so no user workspace is touched. The
 * keeper records live in a temporary share directory for the same reason.
 */
'use strict'
const { mkdtempSync, rmSync } = require('node:fs')
const { buildSync } = require('esbuild')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const RPC_TIMEOUT_MS = 15_000

/** Load the real lifecycle with only the VS Code UI surface replaced. */
function runtimeFor(cwd, events) {
  const root = path.resolve(__dirname, '..')
  const code = buildSync({ entryPoints: [path.join(root, 'src/runtime.ts')], bundle: true,
    platform: 'node', format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text
  const vscode = {
    env: { language: 'en' },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'command' ? 'dsh'
      : key === 'args' ? ['web', '--port', '0', '--no-open'] : fallback }) },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {}; dispose() {} },
  }
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', code)(id => id === 'vscode' ? vscode : require(id), loaded, loaded.exports)
  return new loaded.exports.DshRuntime({ extensionUri: { fsPath: root } },
    { uri: { fsPath: cwd }, name: 'smoke' }, { append() {}, appendLine() {} },
    (event, data) => events.push({ event, ...data }))
}

/** Post one typert unary RPC through the authenticated loopback route. */
async function rpc(origin, cookie, method, args) {
  const response = await fetch(origin + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin, host: new URL(origin).host },
    body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-' + method, method, payload: { args } }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(method + ' answered HTTP ' + String(response.status))
  const envelope = await response.json()
  if (envelope?.result?.ok !== true) {
    const detail = envelope?.result?.error?.message
    throw new Error(method + ' failed: ' + String(detail === undefined ? 'no result' : detail))
  }
  return envelope.result.value
}

/** Probe the eight contracts; returns undefined on success, a message on failure. */
async function probe() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'dsh-sidebar-smoke-'))
  const share = mkdtempSync(path.join(os.tmpdir(), 'dsh-sidebar-share-'))
  process.env.DSH_EMBED_SHARE_DIR = share
  process.env.DSH_EMBED_IDLE_GRACE_MS = '1500'
  const first = []
  const second = []
  const runtime = runtimeFor(cwd, first)
  const other = runtimeFor(cwd, second)
  let registered
  let origin
  let liveOrigin
  let backendPort
  const cookie = ''
  try {
    origin = await runtime.getWebUrl()
    backendPort = first.find(entry => entry.event === 'runtime.ready')?.backendPort
    console.log('ok 1/8 keeper launched the installed CLI: ' + origin)
    const page = await fetch(origin, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
    if (!page.ok) return 'authenticated proxy answered HTTP ' + String(page.status)
    await page.arrayBuffer()
    console.log('ok 2/8 launch cookie exchanged and authenticated proxy ready')

    const list = await rpc(origin, cookie, 'session/list', { _request: {} })
    const items = list?.items
    if (!Array.isArray(items)) return 'session/list value.items is not an array'
    console.log('ok 3/8 session/list returned ' + String(items.length) + ' session(s)')

    const created = await rpc(origin, cookie, 'workspace/create', { request: { path: cwd } })
    const workspaceId = created?.workspace?.workspaceId
    if (typeof workspaceId !== 'string') return 'workspace/create did not return a workspaceId'
    registered = workspaceId
    // The host refuses a request that names both a workspace and a cwd.
    const sessionFirst = await rpc(origin, cookie, 'session/create', { request: { workspaceId } })
    const sessionSecond = await rpc(origin, cookie, 'session/create', { request: { workspaceId } })
    const moved = await rpc(origin, cookie, 'workspace/insertSessionBefore', {
      request: { workspaceId, sessionId: sessionSecond?.sessionId, beforeSessionId: sessionFirst?.sessionId },
    })
    const order = Array.isArray(moved?.workspace?.sessionIds) ? moved.workspace.sessionIds : []
    if (order.indexOf(sessionSecond?.sessionId) !== order.indexOf(sessionFirst?.sessionId) - 1) {
      return 'workspace/insertSessionBefore did not move the second session in front of the first'
    }
    console.log('ok 4/8 workspace/insertSessionBefore moved a session to the front of ' + String(order.length))

    const archived = await rpc(origin, cookie, 'workspace/archiveSession', { request: { sessionId: sessionSecond?.sessionId } })
    if (!Array.isArray(archived?.archivedSessionIds) || !archived.archivedSessionIds.includes(sessionSecond?.sessionId)) {
      return 'workspace/archiveSession did not report the archived session'
    }
    console.log('ok 5/8 workspace/archiveSession archived ' + String(sessionSecond?.sessionId))

    const otherOrigin = await other.getWebUrl()
    // The first window's proxy is closed in this step, so cleanup must use this one.
    liveOrigin = otherOrigin
    const otherReady = second.find(entry => entry.event === 'runtime.ready')
    if (otherReady?.shared !== true || otherReady.backendPort !== backendPort) {
      return 'the second window did not attach to the same backend (shared=' + String(otherReady?.shared) + ', port=' + String(otherReady?.backendPort) + ')'
    }
    console.log('ok 6/8 a second window attached to backend port ' + String(backendPort))

    await runtime.dispose()
    const stillServed = await fetch(otherOrigin + '/__dsh_vscode_health', { signal: AbortSignal.timeout(5000) })
    const served = await stillServed.json()
    if (!stillServed.ok || served.protocol !== 'dsh-sidebar-health-v1') return 'the remaining window lost its proxy after the first window detached'
    const firstClosed = await fetch(origin, { signal: AbortSignal.timeout(2000) }).then(() => false, () => true)
    if (!firstClosed) return 'the detached window still accepts requests through its proxy'
    console.log('ok 7/8 detaching one window left the other one working')
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message
  } finally {
    const cleanupOrigin = liveOrigin ?? origin
    if (registered !== undefined && cleanupOrigin !== undefined) {
      await rpc(cleanupOrigin, cookie, 'workspace/delete', { request: { workspaceId: registered } })
        .catch(error => { console.error('smoke: workspace cleanup failed - ' + String(error)) })
    }
    await runtime.dispose()
    await other.dispose()
    if (origin !== undefined && backendPort !== undefined) {
      const backend = 'http://127.0.0.1:' + String(backendPort) + '/'
      const deadline = Date.now() + 15_000
      let reachable = true
      while (reachable && Date.now() < deadline) {
        reachable = await fetch(backend, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)
        if (reachable) await delay(200)
      }
      if (reachable) {
        console.error('smoke: the keeper did not reap the backend after the last window detached')
        process.exitCode = 1
      } else {
        console.log('ok 8/8 the last window detaching let the keeper reap the backend')
      }
    }
    rmSync(cwd, { recursive: true, force: true })
    rmSync(share, { recursive: true, force: true })
  }
}

async function main() {
  const failure = await probe()
  if (failure !== undefined) {
    console.error('smoke: FAIL - ' + failure)
    process.exitCode = 1
    return
  }
  console.log('smoke: PASS')
}

void main().catch(error => { console.error('smoke: FAIL - ' + String(error)); process.exitCode = 1 })
