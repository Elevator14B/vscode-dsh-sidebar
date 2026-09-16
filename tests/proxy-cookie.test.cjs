/**
 * Regression: the loopback proxy keeps DSH auth state out of the browser.
 *
 * The extension host mints the browser-session cookie from the launch URL and
 * injects it on every upstream request. A cookie the backend sets on a response
 * would therefore only ever be a second, client-visible copy of a credential
 * the page must not hold, so the proxy strips response cookies while still
 * forwarding the injected one upstream.
 */
'use strict'
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const path = require('node:path')
const { test } = require('node:test')
const { buildSync } = require('esbuild')

const code = buildSync({
  entryPoints: [path.resolve(__dirname, '../src/proxy.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
}).outputFiles[0].text

const loaded = { exports: {} }
new Function('require', 'module', 'exports', code)(require, loaded, loaded.exports)
const { DshBridgeProxy } = loaded.exports

const COOKIE = 'dsh-auth=extension-host-only'
const CONFIG = { cwd: '/ws', canonicalCwd: '/ws', title: 'ws', theme: 'dark', locale: 'en' }

/** Start a backend that echoes the cookie it saw and always sets one of its own. */
function startBackend() {
  const server = createServer((req, res) => {
    res.setHeader('set-cookie', 'dsh-auth=backend-issued; Path=/; HttpOnly')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ cookie: req.headers.cookie ?? null, host: req.headers.host ?? null }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

test('a backend-issued cookie never reaches the client, the injected one does reach the backend', async () => {
  const backend = await startBackend()
  const proxy = new DshBridgeProxy('http://127.0.0.1:' + String(backend.port), '/* bridge */', CONFIG, COOKIE)
  try {
    const port = await proxy.listen(0)
    const response = await fetch('http://127.0.0.1:' + String(port) + '/api/session/list')
    assert.equal(response.status, 200)
    assert.deepEqual(response.headers.getSetCookie(), [], 'the proxy leaked a set-cookie to the client')
    const body = await response.json()
    assert.equal(body.cookie, COOKIE, 'the injected cookie did not reach the backend')
  } finally {
    await proxy.close()
    await new Promise((resolve) => { backend.server.close(resolve) })
  }
})

test('the injected cookie is what upstream sees for a page request too', async () => {
  const backend = await startBackend()
  const proxy = new DshBridgeProxy('http://127.0.0.1:' + String(backend.port), '/* bridge */', CONFIG, undefined)
  try {
    const port = await proxy.listen(0)
    const response = await fetch('http://127.0.0.1:' + String(port) + '/api/session/list')
    assert.deepEqual(response.headers.getSetCookie(), [])
    const body = await response.json()
    assert.equal(body.cookie, null, 'no cookie should be injected when the launch exchange produced none')
  } finally {
    await proxy.close()
    await new Promise((resolve) => { backend.server.close(resolve) })
  }
})


test('proxy health identifies the runtime without exposing its authentication cookie', async () => {
  const proxy = new DshBridgeProxy('http://127.0.0.1:1', '', { ...CONFIG, runtimeId: 'runtime-test' }, COOKIE)
  try {
    const port = await proxy.listen(0)
    const response = await fetch('http://127.0.0.1:' + port + '/__dsh_vscode_health')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { protocol: 'dsh-sidebar-health-v1', runtimeId: 'runtime-test' })
    assert.deepEqual(response.headers.getSetCookie(), [])
  } finally { await proxy.close() }
})
