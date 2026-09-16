'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createServer } = require('node:http')
const { connect } = require('node:net')
const { once } = require('node:events')
const path = require('node:path')
const { buildSync } = require('esbuild')
const mod = { exports: {} }
const code = buildSync({ entryPoints: [path.resolve(__dirname, '../src/proxy.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
new Function('require', 'module', 'exports', code)(require, mod, mod.exports)

test('closing the proxy terminates both sides of a live WebSocket and pending HTTP response', { timeout: 5000 }, async t => {
  const connections = new Set()
  const backend = createServer(() => {})
  backend.on('connection', socket => { connections.add(socket); socket.on('close', () => { connections.delete(socket) }) })
  backend.on('upgrade', (req, socket) => {
    // An upgraded server owns its half-close policy, just like a WebSocket library.
    socket.on('end', () => { socket.end() })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  })
  backend.listen(0, '127.0.0.1')
  await once(backend, 'listening')
  const proxy = new mod.exports.DshBridgeProxy(`http://127.0.0.1:${backend.address().port}`, '', { cwd: '/fixture', canonicalCwd: '/fixture', title: 'test', theme: 'light', locale: 'en' })
  const port = await proxy.listen(0)
  const websocket = connect(port, '127.0.0.1')
  const pending = connect(port, '127.0.0.1')
  websocket.on('error', () => {}) // Forced shutdown may reset a socket with unread bytes.
  pending.on('error', () => {})
  t.after(async () => {
    websocket.destroy(); pending.destroy()
    for (const socket of connections) socket.destroy()
    await proxy.close()
    await new Promise(resolve => { backend.close(resolve) })
  })
  await once(websocket, 'connect')
  websocket.write('GET /api/remote.mux HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  await once(websocket, 'data')
  pending.write('GET /waiting HTTP/1.1\r\nHost: localhost\r\n\r\n')
  pending.resume()
  const closed = [websocket, pending].map(socket => new Promise(resolve => { socket.once('close', resolve) }))
  await Promise.all([proxy.close(), proxy.close()])
  await Promise.all(closed)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(connections.size, 0, 'upstream sockets must be closed as well')
  await assert.rejects(proxy.listen(0), /closing/)
})
