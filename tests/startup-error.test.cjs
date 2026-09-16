const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')
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

function fixture(outcomes, { clipboardFails = false } = {}) {
  const copied = []
  const logs = []
  const warnings = []
  const shown = []
  const events = []
  let starts = 0
  let receive
  const vscode = {
    TreeItem: class {},
    Uri: {
      joinPath: (uri, leaf) => ({ fsPath: path.join(uri.fsPath, leaf) }),
      parse: value => ({ scheme: new URL(value).protocol.slice(0, -1), authority: new URL(value).host, toString: () => value }),
    },
    env: {
      language: 'en',
      clipboard: { writeText: async text => {
        if (clipboardFails) throw new Error('clipboard unavailable')
        copied.push(text)
      } },
      asExternalUri: async uri => uri,
    },
    window: {
      showInformationMessage: async () => {},
      showWarningMessage: async message => { warnings.push(message) },
    },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => name === 'vscode' ? vscode : require(name), module, module.exports)
  const { DshWebviewProvider, summarizeStartupError } = module.exports
  const runtime = {
    onDidChange: () => {},
    getWebUrl: () => {
      const value = outcomes[Math.min(starts++, outcomes.length - 1)]
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value)
    },
  }
  const view = { onDidDispose() {}, webview: {
    cspSource: 'vscode-webview:',
    onDidReceiveMessage: callback => { receive = callback },
    postMessage: async () => {},
  } }
  const output = { appendLine: line => logs.push(line), show: preserveFocus => shown.push(preserveFocus) }
  const provider = new DshWebviewProvider(
    { extensionUri: { fsPath: path.resolve(__dirname, '..') }, subscriptions: [] },
    runtime,
    { uri: { fsPath: '/workspace' }, name: 'workspace' },
    () => {},
    (event, data) => events.push({ event, data }),
    output,
  )
  return {
    provider, view, copied, logs, warnings, shown, events, summarizeStartupError,
    starts: () => starts,
    send: type => receive({ source: 'dsh-vscode-startup-error', type }),
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

test('large missing-bundle errors stay out of HTML but remain fully copyable and logged', async () => {
  const message = 'dsh web exited before ready (code 1, signal null)\nError: client bundles not found\n' + 'nested stack trace\n'.repeat(5000)
  const f = fixture([new Error(message)])
  f.provider.resolveWebviewView(f.view)
  await flush()
  assert.equal(f.view.webview.options.enableScripts, true)
  assert.match(f.view.webview.html, /missing built frontend files/)
  assert.ok(f.view.webview.html.length < 6000)
  assert.ok(!f.view.webview.html.includes('nested stack trace'))
  assert.equal(f.events.find(row => row.event === 'webview.start-failed').data.message, message)
  await f.send('copy-error')
  assert.deepEqual(f.copied, [message])
  await f.send('open-log')
  assert.deepEqual(f.shown, [true])

  const handlers = new Map()
  const posts = []
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(f.view.webview.html)[1]
  runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: message => posts.push(message) }),
    document: { getElementById: id => ({ addEventListener: (event, callback) => handlers.set(id, callback) }) },
  })
  for (const id of ['copy-error', 'open-log', 'retry']) handlers.get(id)()
  assert.deepEqual(posts.map(message => message.type), ['copy-error', 'open-log', 'retry'])
  assert.ok(posts.every(message => message.source === 'dsh-vscode-startup-error'))
})

test('retry can fail again, then recover without stale error actions', async () => {
  const f = fixture([new Error('first failure'), new Error('second failure'), 'http://127.0.0.1:39222/'])
  f.provider.resolveWebviewView(f.view)
  await flush()
  await f.send('retry')
  await flush()
  assert.match(f.view.webview.html, /second failure/)
  await f.send('copy-error')
  assert.deepEqual(f.copied, ['second failure'])
  await f.send('retry')
  await flush()
  assert.match(f.view.webview.html, /<iframe id="frame"/)
  assert.ok(!f.view.webview.html.includes('second failure'))
  await f.send('copy-error')
  await f.send('retry')
  assert.equal(f.starts(), 3)
  assert.equal(f.copied.length, 1)
})

test('clipboard failures open the log and tell the user how to copy', async () => {
  const f = fixture([new Error('startup failure')], { clipboardFails: true })
  f.provider.resolveWebviewView(f.view)
  await flush()
  await f.send('copy-error')
  assert.deepEqual(f.shown, [true])
  assert.match(f.warnings[0], /could not copy/)
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
