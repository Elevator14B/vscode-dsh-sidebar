#!/usr/bin/env node
/**
 * Contract smoke test: proves the assumptions this extension makes about the
 * installed DeepSeek Harness CLI still hold, using a real 'dsh' process
 * instead of a mock. Run it after 'dsh' is on PATH:
 *
 *   npm run smoke
 *
 * Checked contracts (all of them are consumed by src/runtime.ts and
 * src/session-panel.ts):
 *   1. 'dsh web --port <n> --no-open' prints an authenticated launch URL;
 *   2. that URL exchanges for a browser-session cookie;
 *   3. 'session/list' answers the client-request envelope the tree uses.
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

/** Probe the three contracts; returns undefined on success, a message on failure. */
async function probe() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'dsh-sidebar-smoke-'))
  const state = { stdout: '' }
  const child = spawn('dsh', ['web', '--port', '0', '--no-open'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  try {
    const launch = await waitForLaunch(child, state)
    console.log('ok 1/3 launch URL: ' + launch.replace(/\?token=.*$/u, '?token=<redacted>'))

    const authResponse = await fetch(launch, { redirect: 'manual' })
    const cookies = authResponse.headers.getSetCookie()
    const cookie = cookies.length === 0 ? '' : cookies[0].split(';')[0]
    if (cookie === '') return 'launch URL did not return a browser-session cookie'
    console.log('ok 2/3 browser-session cookie exchanged (HTTP ' + String(authResponse.status) + ')')

    const origin = new URL(launch).origin
    const rpc = await fetch(origin + '/api/session/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin, host: new URL(origin).host },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'smoke-1',
        method: 'session/list',
        payload: { args: { _request: {} } },
      }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
    if (!rpc.ok) return 'session/list answered HTTP ' + String(rpc.status)
    const envelope = await rpc.json()
    if (envelope?.result?.ok !== true) return 'session/list envelope was not an ok result'
    const items = envelope.result.value?.items
    if (!Array.isArray(items)) return 'session/list value.items is not an array'
    console.log('ok 3/3 session/list returned ' + String(items.length) + ' session(s)')
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message + (stderr === '' ? '' : '; stderr: ' + stderr.slice(-400))
  } finally {
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
