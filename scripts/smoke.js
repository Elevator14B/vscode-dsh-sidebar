#!/usr/bin/env node
/**
 * Contract smoke test: proves the assumptions this extension makes about the
 * installed DeepSeek Harness CLI still hold, using a real 'dsh' process
 * instead of a mock. Run it after 'dsh' is on PATH:
 *
 *   npm run smoke
 *
 * Checked contracts (all of them are consumed by src/runtime.ts,
 * src/session-panel.ts and src/session-actions.ts):
 *   1. 'dsh web --port <n> --no-open' prints an authenticated launch URL;
 *   2. that URL exchanges for a browser-session cookie;
 *   3. 'session/list' answers the client-request envelope the tree uses;
 *   4. 'workspace/insertSessionBefore' moves one accounted session in the
 *      workspace's manual order and echoes the resulting order;
 *   5. 'workspace/archiveSession' adds one session to the archive set;
 *   6. actual guardian shutdown reaps the backend and closes the proxy.
 *
 * Checks 4 and 5 register a throwaway workspace over the temporary directory
 * and delete that registration again, so no user workspace is touched.
 */
'use strict'
const { mkdtempSync, rmSync } = require('node:fs')
const { buildSync } = require('esbuild')
const os = require('node:os')
const path = require('node:path')

const RPC_TIMEOUT_MS = 15_000

/** Load the real lifecycle with only the VS Code UI surface replaced. */
function runtimeFor(cwd) {
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
    { uri: { fsPath: cwd }, name: 'smoke' }, { append() {}, appendLine() {} })
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

/** Probe the five contracts; returns undefined on success, a message on failure. */
async function probe() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'dsh-sidebar-smoke-'))
  const runtime = runtimeFor(cwd)
  let registered
  let origin
  // Auth stays inside the actual runtime and proxy, as it does in the extension.
  const cookie = ''
  try {
    origin = await runtime.getWebUrl()
    console.log('ok 1/6 guardian launched the installed CLI: ' + origin)
    const page = await fetch(origin, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
    if (!page.ok) return 'authenticated proxy answered HTTP ' + String(page.status)
    await page.arrayBuffer()
    console.log('ok 2/6 launch cookie exchanged and authenticated proxy ready')

    const list = await rpc(origin, cookie, 'session/list', { _request: {} })
    const items = list?.items
    if (!Array.isArray(items)) return 'session/list value.items is not an array'
    console.log('ok 3/6 session/list returned ' + String(items.length) + ' session(s)')

    const created = await rpc(origin, cookie, 'workspace/create', { request: { path: cwd } })
    const workspaceId = created?.workspace?.workspaceId
    if (typeof workspaceId !== 'string') return 'workspace/create did not return a workspaceId'
    registered = workspaceId
    // The host refuses a request that names both a workspace and a cwd.
    const first = await rpc(origin, cookie, 'session/create', { request: { workspaceId } })
    const second = await rpc(origin, cookie, 'session/create', { request: { workspaceId } })
    const moved = await rpc(origin, cookie, 'workspace/insertSessionBefore', {
      request: { workspaceId, sessionId: second?.sessionId, beforeSessionId: first?.sessionId },
    })
    const order = Array.isArray(moved?.workspace?.sessionIds) ? moved.workspace.sessionIds : []
    if (order.indexOf(second?.sessionId) !== order.indexOf(first?.sessionId) - 1) {
      return 'workspace/insertSessionBefore did not move the second session in front of the first'
    }
    console.log('ok 4/6 workspace/insertSessionBefore moved a session to the front of ' + String(order.length))

    const archived = await rpc(origin, cookie, 'workspace/archiveSession', { request: { sessionId: second?.sessionId } })
    if (!Array.isArray(archived?.archivedSessionIds) || !archived.archivedSessionIds.includes(second?.sessionId)) {
      return 'workspace/archiveSession did not report the archived session'
    }
    console.log('ok 5/6 workspace/archiveSession archived ' + String(second?.sessionId))
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message
  } finally {
    if (registered !== undefined && origin !== undefined) {
      await rpc(origin, cookie, 'workspace/delete', { request: { workspaceId: registered } })
        .catch(error => { console.error('smoke: workspace cleanup failed - ' + String(error)) })
    }
    await runtime.dispose()
    if (origin !== undefined) {
      const reachable = await fetch(origin, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)
      if (reachable) throw new Error('proxy still accepts requests after runtime disposal')
      console.log('ok 6/6 guardian reaped the backend and proxy closed')
    }
    rmSync(cwd, { recursive: true, force: true })
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
