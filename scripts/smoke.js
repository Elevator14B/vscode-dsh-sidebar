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
 *   5. 'workspace/archiveSession' adds one session to the archive set.
 *
 * Checks 4 and 5 register a throwaway workspace over the temporary directory
 * and delete that registration again, so no user workspace is touched.
 */
'use strict'
const { spawn } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const LAUNCH_PATTERN = /(https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/u
const START_TIMEOUT_MS = 60_000
const RPC_TIMEOUT_MS = 15_000

/** Wait for the launch URL printed by the spawned CLI. */
function waitForLaunch(child, state) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('no launch URL within ' + String(START_TIMEOUT_MS / 1000) + 's; output: ' + state.stdout.slice(-400)))
    }, START_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      state.stdout += chunk
      const match = LAUNCH_PATTERN.exec(state.stdout)
      if (match !== null) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error('dsh exited before printing a URL (code ' + String(code) + ')'))
    })
  })
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
  const state = { stdout: '' }
  const child = spawn('dsh', ['web', '--port', '0', '--no-open'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  let registered
  try {
    const launch = await waitForLaunch(child, state)
    console.log('ok 1/5 launch URL: ' + launch.replace(/\?token=.*$/u, '?token=<redacted>'))

    const authResponse = await fetch(launch, { redirect: 'manual' })
    const cookies = authResponse.headers.getSetCookie()
    const cookie = cookies.length === 0 ? '' : cookies[0].split(';')[0]
    if (cookie === '') return 'launch URL did not return a browser-session cookie'
    console.log('ok 2/5 browser-session cookie exchanged (HTTP ' + String(authResponse.status) + ')')

    const origin = new URL(launch).origin
    const list = await rpc(origin, cookie, 'session/list', { _request: {} })
    const items = list?.items
    if (!Array.isArray(items)) return 'session/list value.items is not an array'
    console.log('ok 3/5 session/list returned ' + String(items.length) + ' session(s)')

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
    console.log('ok 4/5 workspace/insertSessionBefore moved a session to the front of ' + String(order.length))

    const archived = await rpc(origin, cookie, 'workspace/archiveSession', { request: { sessionId: second?.sessionId } })
    if (!Array.isArray(archived?.archivedSessionIds) || !archived.archivedSessionIds.includes(second?.sessionId)) {
      return 'workspace/archiveSession did not report the archived session'
    }
    console.log('ok 5/5 workspace/archiveSession archived ' + String(second?.sessionId))
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message + (stderr === '' ? '' : '; stderr: ' + stderr.slice(-400))
  } finally {
    if (registered !== undefined && state.stdout !== '') {
      const match = LAUNCH_PATTERN.exec(state.stdout)
      if (match !== null) {
        try {
          const origin = new URL(match[1]).origin
          const authResponse = await fetch(match[1], { redirect: 'manual' })
          const cookie = (authResponse.headers.getSetCookie()[0] ?? '').split(';')[0]
          if (cookie !== '') await rpc(origin, cookie, 'workspace/delete', { request: { workspaceId: registered } })
        } catch (error) {
          console.error('smoke: cleanup failed - ' + String(error))
        }
      }
    }
    child.kill('SIGKILL')
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

void main()
