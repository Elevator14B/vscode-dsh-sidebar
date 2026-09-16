'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { readFileSync } = require('node:fs')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const code = buildSync({ stdin: { contents: readFileSync(path.join(root, 'src/extension.ts'), 'utf8') + '\nexport { DshWebviewProvider }', resolveDir: path.join(root, 'src'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text
const flush = () => new Promise(resolve => setImmediate(resolve))
function setup() {
  const messages = [], events = []
  let receive, dispose, starts = 0, forwards = 0, resolveForward
  let held = false
  const uri = value => ({ toString: () => value, scheme: new URL(value).protocol.slice(0,-1), authority: new URL(value).host })
  const vscode = { TreeItem: class {}, Uri: { parse: uri, joinPath: (_uri, file) => ({ fsPath: path.join(root, file) }) },
    window: { activeColorTheme: { kind: 2 } }, ColorThemeKind: { Light: 1, HighContrastLight: 4 },
    env: { language: 'en', asExternalUri: input => {
      forwards++
      return held ? new Promise(resolve => { resolveForward = resolve }) : Promise.resolve(input)
    } } }
  const mod = { exports: {} }
  new Function('require','module','exports',code)(id => id === 'vscode' ? vscode : require(id),mod,mod.exports)
  const runtime = { origin: 'http://127.0.0.1:1234', onDidChange() {}, getWebUrl: async () => { starts++; return runtime.origin }, restart: () => { throw new Error('page recovery must not restart the backend') } }
  const provider = new mod.exports.DshWebviewProvider({ extensionUri: { fsPath: root }, subscriptions: [] }, runtime,
    { uri: { fsPath: '/workspace' }, name: 'workspace' }, () => {}, (event,data) => events.push({ event,data }), { appendLine() {} })
  const view = { onDidDispose(fn) { dispose = fn }, webview: { cspSource: 'vscode-webview:', onDidReceiveMessage(fn) { receive = fn }, postMessage(m) { messages.push(m); return Promise.resolve(true) } } }
  provider.resolveWebviewView(view)
  return { provider, view, messages, events, send: m => receive(m), dispose: () => dispose(), starts: () => starts, forwards: () => forwards,
    hold: () => { held = true }, release: url => resolveForward(uri(url)), pageId: () => JSON.parse(view.webview.html.match(/__DSH_SHELL_CONFIG__ = (.*?);/)[1]).pageId }
}

test('page refresh keeps the backend and scopes responses to the new page', async () => {
  const f = setup(); await flush()
  const old = f.pageId()
  f.provider.refreshPage(); await flush()
  assert.notEqual(f.pageId(),old)
  await f.send({ source: 'dsh-vscode-shell', type: 'host-ping', sentAt: 123, pageId: old })
  assert.ok(!f.messages.some(m => m.type === 'host-pong'))
  await f.send({ source: 'dsh-vscode-shell', type: 'host-ping', sentAt: 456, pageId: f.pageId() })
  assert.equal(f.messages.at(-1).sentAt,456)
  assert.match(f.view.webview.html,/connection-reload/)
})

test('concurrent forwarding requests coalesce; disposing a page discards delayed results', async () => {
  const f = setup(); await flush()
  f.hold()
  const pageId = f.pageId()
  const first = f.send({ source: 'dsh-vscode-shell', type: 'repair-forwarding', pageId, requestId: 'one' })
  const second = f.send({ source: 'dsh-vscode-bridge', type: 'repair-forwarding', pageId, requestId: 'two' })
  assert.equal(f.forwards(),2, 'initial forwarding plus one shared repair')
  f.dispose()
  f.release('http://127.0.0.1:2345')
  await Promise.all([first,second])
  assert.ok(!f.messages.some(m => m.type === 'forwarding-result'))
  assert.equal(f.starts(),1)
})

test('history readiness and connection telemetry stay scoped to their page', async () => {
  const f = setup(); await flush()
  const pageId = f.pageId()
  const health = { source: 'dsh-vscode-bridge', type: 'connection-status', pageId, history: 'loading', connection: 'connected', proxy: 'ready', backend: 'ready', stalled: true }
  await f.send(health)
  await f.send({ ...health, elapsedMs: 18000 })
  assert.equal(f.events.filter(e => e.event === 'webview.connection-changed').length,1)
  await f.send({ ...health, pageId: 'old', history: 'open' })
  assert.equal(f.events.filter(e => e.event === 'bridge.connection-status').length,2)
})


test('a page refresh restores the last observed selection after the new bridge is ready', async () => {
  const f = setup(); await flush()
  await f.send({ source: 'dsh-vscode-bridge', type: 'history-state', pageId: f.pageId(), sessionId: 'last-session', history: 'open' })
  f.provider.refreshPage(); await flush()
  f.provider.markBridgeReady()
  assert.equal(f.messages.filter(m => m.type === 'open-session').at(-1).sessionId, 'last-session')
  assert.equal(f.messages.at(-1).pageId, f.pageId())
})
