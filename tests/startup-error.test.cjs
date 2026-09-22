const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { buildSync } = require('esbuild')

// Exercise the real provider without starting an extension host or DSH backend.
const sourceDir = path.resolve(__dirname, '../src')
const code = buildSync({
  stdin: {
    contents: readFileSync(path.join(sourceDir, 'extension.ts'), 'utf8') + '\nexport { DshWebviewProvider, summarizeStartupError }\n',
    resolveDir: sourceDir,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  write: false,
}).outputFiles[0].text

/** One provider whose runtime fails, succeeds, or hangs per outcome list. */
function fixture(outcomes) {
  const events = []
  let starts = 0
  let receive
  const vscode = {
    TreeItem: class {},
    Uri: {
      joinPath: (uri, leaf) => ({ fsPath: path.join(uri.fsPath, leaf) }),
      parse: value => ({ scheme: new URL(value).protocol.slice(0, -1), authority: new URL(value).host, toString: () => value }),
    },
    env: { language: 'en', asExternalUri: async uri => uri },
    window: { showInformationMessage: async () => {}, showWarningMessage: async () => {} },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => name === 'vscode' ? vscode : require(name), module, module.exports)
  const { DshWebviewProvider, summarizeStartupError } = module.exports
  const runtime = {
    origin: undefined,
    onDidChange: () => {},
    getWebUrl: async () => {
      const value = outcomes[Math.min(starts++, outcomes.length - 1)]
      if (value instanceof Error) throw value
      runtime.origin = value
      return value
    },
  }
  const view = {
    onDidDispose() {},
    onDidChangeVisibility() {},
    webview: {
      cspSource: 'vscode-webview:',
      onDidReceiveMessage: callback => { receive = callback },
      postMessage: async () => {},
    },
  }
  const provider = new DshWebviewProvider(
    { extensionUri: { fsPath: path.resolve(__dirname, '..') }, subscriptions: [] },
    runtime,
    { uri: { fsPath: '/workspace' }, name: 'workspace' },
    () => {},
    (event, data) => events.push({ event, data }),
  )
  return {
    provider, runtime, view, events, summarizeStartupError,
    starts: () => starts,
    send: message => receive(message),
    /** Run the maintenance pass the way the host timer would. */
    maintain: () => { provider.lastActionAt = 0; provider.maintain() },
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve))
const settle = () => new Promise(resolve => setTimeout(resolve, 25))

test('a startup failure renders one bounded, escaped diagnosis and keeps the full message', async () => {
  const message = 'dsh web exited before ready (code 1, signal null)\nError: client bundles not found\n' + 'nested stack trace\n'.repeat(5000)
  const f = fixture([new Error(message)])
  f.provider.resolveWebviewView(f.view)
  await flush()
  assert.equal(f.view.webview.options.enableScripts, true)
  assert.match(f.view.webview.html, /missing built frontend files/)
  assert.ok(f.view.webview.html.length < 6000)
  assert.ok(!f.view.webview.html.includes('nested stack trace'))
  assert.equal(f.events.find(row => row.event === 'webview.start-failed').data.message, message)
  // No action is offered: the maintenance pass retries on its own.
  assert.ok(!f.view.webview.html.includes('copy-error'))
  assert.ok(!f.view.webview.html.includes('open-log'))
  assert.ok(!f.view.webview.html.includes('acquireVsCodeApi'))
})

test('a failed startup is retried automatically until the runtime starts', async () => {
  const f = fixture([new Error('first failure'), 'http://127.0.0.1:39222/'])
  f.provider.resolveWebviewView(f.view)
  await flush()
  assert.match(f.view.webview.html, /first failure/)
  f.maintain()
  await flush()
  await settle()
  assert.equal(f.starts(), 2)
  assert.match(f.view.webview.html, /<iframe id="frame"/)
  assert.ok(!f.view.webview.html.includes('first failure'))
  assert.ok(String(f.runtime.origin).startsWith('http://127.0.0.1:39222'))
})

test('a failed start is retried even when the client has been silent', async () => {
  const f = fixture([new Error('first failure'), 'http://127.0.0.1:39222/'])
  f.provider.resolveWebviewView(f.view)
  await flush()
  // The error page carries no shell script, so no liveness can arrive from it.
  f.provider.lastAliveAt = Date.now() - 60_000
  f.provider.lastActionAt = Date.now() - 60_000
  f.provider.maintain()
  await flush()
  await settle()
  assert.equal(f.starts(), 2, 'a dead runtime must be started again without a user wake')
  assert.match(f.view.webview.html, /<iframe id="frame"/)
})

test('a repeated failure keeps retrying without any page message', async () => {
  const f = fixture([new Error('boom'), new Error('boom'), new Error('boom')])
  f.provider.resolveWebviewView(f.view)
  await flush()
  for (let pass = 0; pass < 3; pass += 1) { f.maintain(); await flush() }
  assert.equal(f.starts(), 4, 'every maintenance pass after the backoff starts the runtime again')
  await f.send({ source: 'dsh-vscode-startup-error', type: 'retry' })
  await flush()
  assert.equal(f.starts(), 4, 'the removed error page action no longer exists')
})

test('unknown errors have a bounded, escaped diagnosis', async () => {
  const message = 'dsh web exited before ready\n/app/bin.js:1\nTypeError: <script>alert("bad")</script> ' + 'x'.repeat(1000)
  const f = fixture([new Error(message)])
  f.provider.resolveWebviewView(f.view)
  await flush()
  assert.equal(f.summarizeStartupError(message).length, 400)
  assert.match(f.view.webview.html, /TypeError: &lt;script>/)
  assert.ok(!f.view.webview.html.includes('<script>alert'))
  assert.equal(f.summarizeStartupError(''), 'Unknown startup error.')
  assert.equal(f.summarizeStartupError('\u001b[31mError: failed\u001b[0m'), 'Error: failed')
})
