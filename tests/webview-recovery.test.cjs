'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { readFileSync } = require('node:fs')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const code = buildSync({ stdin: { contents: readFileSync(path.join(root, 'src/extension.ts'), 'utf8') + '\nexport { DshWebviewProvider }', resolveDir: path.join(root, 'src'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text
const flush = () => new Promise(resolve => setImmediate(resolve))
const settle = () => new Promise(resolve => setTimeout(resolve, 25))

function setup() {
  const messages = [], events = []
  let receive, dispose, visibility, starts = 0, forwards = 0, rotations = 0, restarts = 0
  const uri = value => ({ toString: () => value, scheme: new URL(value).protocol.slice(0, -1), authority: new URL(value).host })
  const vscode = { TreeItem: class {}, Uri: { parse: uri, joinPath: (_uri, file) => ({ fsPath: path.join(root, file) }) },
    window: { activeColorTheme: { kind: 2 } }, ColorThemeKind: { Light: 1, HighContrastLight: 4 },
    env: { language: 'en', asExternalUri: input => { forwards++; return Promise.resolve(input) } } }
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(id => id === 'vscode' ? vscode : require(id), mod, mod.exports)
  // The runtime is memoized like the real one: a live origin is returned without
  // launching again, so a page rebuild never boots a second backend.
  const runtime = {
    origin: undefined,
    onDidChange() {},
    // A real launch resolves asynchronously: the origin exists only once the
    // runtime is ready, which is what keeps a booting runtime out of the ladder.
    getWebUrl: async () => { await Promise.resolve(); if (runtime.origin === undefined) { starts++; runtime.origin = 'http://127.0.0.1:1234' } return runtime.origin },
    rotateOrigin: async () => { rotations++; runtime.origin = 'http://127.0.0.1:' + String(1234 + rotations); return runtime.origin },
    restart: async () => { restarts++; runtime.origin = 'http://127.0.0.1:' + String(9000 + restarts); return runtime.origin },
  }
  const provider = new mod.exports.DshWebviewProvider({ extensionUri: { fsPath: root }, subscriptions: [] }, runtime,
    { uri: { fsPath: '/workspace' }, name: 'workspace' }, () => {}, (event, data) => events.push({ event, data }))
  const view = {
    visible: true,
    onDidDispose(fn) { dispose = fn },
    onDidChangeVisibility(fn) { visibility = fn },
    webview: { cspSource: 'vscode-webview:', onDidReceiveMessage(fn) { receive = fn }, postMessage(m) { messages.push(m); return Promise.resolve(true) } },
  }
  provider.resolveWebviewView(view)
  return { provider, view, messages, events, send: m => receive(m), dispose: () => dispose(), show: () => visibility(),
    starts: () => starts, forwards: () => forwards, rotations: () => rotations, restarts: () => restarts,
    pageId: () => JSON.parse(view.webview.html.match(/__DSH_SHELL_CONFIG__ = (.*?);/)[1]).pageId,
    status: () => events.filter(e => e.event === 'webview.status').at(-1)?.data?.status,
    /** A rendered page that never installs its bridge is already past its grace. */
    expire: () => { provider.pageRenderedAt = Date.now() - 60000; provider.lastAliveAt = Date.now(); provider.lastActionAt = 0 } }
}

test('a page that never installs its bridge is rebuilt on a fresh authority', async () => {
  const f = setup(); await flush()
  const first = f.pageId()
  f.expire()
  f.provider.maintain()
  await settle()
  assert.equal(f.rotations(), 1, 'the stale forward is replaced by a new authority')
  assert.notEqual(f.pageId(), first, 'the rebuilt page is a new generation')
  assert.equal(f.forwards(), 2, 'the initial forward plus the rebuilt one')
  assert.equal(f.starts(), 1, 'a page that never loaded must not restart the backend')
  assert.equal(f.status(), 'rebuilding')
})

test('a connected page is left alone', async () => {
  const f = setup(); await flush()
  const page = f.pageId()
  f.provider.markBridgeReady()
  await f.send({ source: 'dsh-vscode-bridge', type: 'connection-status', pageId: page, connection: 'connected' })
  f.expire()
  f.provider.maintain()
  await settle()
  assert.equal(f.rotations(), 0)
  assert.equal(f.pageId(), page)
  assert.ok(!f.events.some(e => e.event === 'webview.status'), 'a healthy page needs no banner')
})

test('a silent client pauses the ladder instead of restarting its agent', async () => {
  const f = setup(); await flush()
  f.expire()
  f.provider.lastAliveAt = Date.now() - 60000
  f.provider.maintain()
  await settle()
  assert.equal(f.rotations(), 0)
  assert.equal(f.starts(), 1)
  assert.equal(f.status(), 'offline')
})

test('showing the view again repairs immediately', async () => {
  const f = setup(); await flush()
  f.expire()
  f.provider.lastAliveAt = Date.now() - 60000
  f.provider.maintain()
  await settle()
  assert.equal(f.rotations(), 0)
  f.show()
  await settle()
  assert.equal(f.rotations(), 1, 'a visible window resets the ladder and repairs now')
})

test('a runtime that is still booting is not rebuilt', async () => {
  const f = setup()
  f.provider.maintain()
  await settle()
  assert.equal(f.starts(), 1)
  assert.equal(f.rotations(), 0)
  assert.equal(f.status(), 'restarting')
})

test('an explicit recover rebuilds a page the host believes connected', async () => {
  const f = setup(); await flush()
  const page = f.pageId()
  f.provider.markBridgeReady()
  await f.send({ source: 'dsh-vscode-bridge', type: 'connection-status', pageId: page, connection: 'connected' })
  f.provider.recoverNow()
  await settle()
  assert.equal(f.rotations(), 1, 'the user asked for a repair, not for a status check')
  assert.notEqual(f.pageId(), page)
  assert.equal(f.starts(), 1, 'the backend is kept')
})

test('a page that never connects escalates to a runtime restart', async () => {
  const f = setup(); await flush()
  f.provider.markBridgeReady()
  await f.send({ source: 'dsh-vscode-bridge', type: 'connection-status', pageId: f.pageId(), connection: 'connecting' })
  for (let pass = 0; pass < 5; pass += 1) { f.expire(); f.provider.maintain(); await settle() }
  assert.equal(f.rotations(), 3, 'rebuilds are bounded before the backend is blamed')
  assert.equal(f.restarts(), 1, 'a backend that never connects is restarted')
  assert.equal(f.status(), 'restarting')
})

test('a rebuilt page reopens the session the host remembers', async () => {
  const f = setup(); await flush()
  f.provider.openSession('last-session')
  f.provider.markBridgeReady()
  assert.equal(f.messages.filter(m => m.type === 'open-session').at(-1).sessionId, 'last-session')
  assert.equal(f.messages.at(-1).pageId, f.pageId())
})

test('a fresh shell receives the current status again', async () => {
  const f = setup(); await flush()
  f.expire()
  f.provider.maintain()
  await settle()
  const before = f.messages.length
  await f.send({ source: 'dsh-vscode-shell', type: 'shell-ready', pageId: f.pageId() })
  await settle()
  assert.ok(f.messages.slice(before).some(m => m.type === 'status'), 'the new shell must learn the state it missed')
})
