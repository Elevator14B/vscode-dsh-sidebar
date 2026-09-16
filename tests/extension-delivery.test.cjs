/**
 * Regression: the host side of the delivery-card contract and the Sessions
 * tree's own actions.
 *
 * The injected bridge routes every open gesture on a delivered file into VS
 * Code — a plain click opens the file, the card's chevron can ask for the side
 * group or the Explorer — and the drag-and-drop controller turns one drop into
 * one Workspace move. Both halves are pinned here through the real activate()
 * wiring and the real controller: the bridge already proves it posts these
 * messages, this file proves the host acts on them.
 */
'use strict'
const assert = require('node:assert/strict')
const { mkdtempSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { buildSync } = require('esbuild')

const PIN = '/ws/pinned'
const DELIVERED = PIN + '/out/report.html'

// --- fake vscode module ---------------------------------------------------

class Uri {
  constructor(scheme, fsPath, fragment = '', query = '') {
    this.scheme = scheme
    this.fsPath = fsPath
    this.fragment = fragment
    this.query = query
  }

  static file(fsPath) { return new Uri('file', fsPath) }

  static parse(value) {
    const url = new URL(value)
    const scheme = url.protocol.replace(/:\$/u, '')
    const host = url.hostname === '' ? '' : '//' + url.hostname
    return new Uri(scheme, host + decodeURIComponent(url.pathname), url.hash.replace(/^#/u, ''), url.search.replace(/^\?/u, ''))
  }

  static joinPath(uri, ...segments) { return new Uri(uri.scheme, path.posix.join(uri.fsPath, ...segments)) }

  get path() { return this.fsPath }

  with(change) {
    return new Uri(change.scheme ?? this.scheme, change.path ?? change.fsPath ?? this.fsPath, change.fragment ?? this.fragment, change.query ?? this.query)
  }

  toString() {
    const query = this.query === '' ? '' : '?' + this.query
    return this.scheme + '://' + this.fsPath + query + (this.fragment === '' ? '' : '#' + this.fragment)
  }
}

class EventEmitter {
  constructor() { this.listeners = [] }
  get event() {
    return (listener) => {
      this.listeners.push(listener)
      return { dispose() { this.listeners = this.listeners.filter(entry => entry !== listener) } }
    }
  }
  fire(value) { for (const listener of [...this.listeners]) listener(value) }
  dispose() { this.listeners = [] }
}

class TreeItem {
  constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState }
}
class ThemeIcon { constructor(id) { this.id = id } }
class DataTransferItem { constructor(value) { this.value = value } }

const commands = new Map()
const commandCalls = []
const warnings = []
const outputLines = []
const opened = []
const treeViews = []
let registeredProvider

const fakeVscode = {
  Uri, EventEmitter, TreeItem, ThemeIcon, DataTransferItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  Range: class Range { constructor(start, end) { this.start = start; this.end = end } },
  Selection: class Selection { constructor(anchor, active) { this.anchor = anchor; this.active = active } },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  UIKind: { Web: 1, Desktop: 2 },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_key, fallback) => fallback ?? '' }),
    asRelativePath: (uriOrPath) => (typeof uriOrPath === 'string' ? uriOrPath : uriOrPath.fsPath),
    getWorkspaceFolder: () => undefined,
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    openTextDocument: async (uri) => ({ uri, lineCount: 10 }),
  },
  window: {
    activeTextEditor: undefined,
    activeColorTheme: { kind: 2 },
    createOutputChannel: () => ({
      appendLine(line) { outputLines.push(String(line)) },
      show() {},
      dispose() {},
    }),
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    createTreeView: (id, options) => {
      treeViews.push({ id, options })
      return { dispose() {} }
    },
    registerWebviewViewProvider: (_id, provider) => { registeredProvider = provider; return { dispose() {} } },
    onDidChangeActiveColorTheme: () => ({ dispose() {} }),
    onDidChangeWindowState: () => ({ dispose() {} }),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    showWarningMessage: async (message) => { warnings.push(String(message)); return undefined },
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showTextDocument: async (document, options) => { opened.push({ document, options }) },
  },
  commands: {
    registerCommand(id, handler) { commands.set(id, handler); return { dispose() { commands.delete(id) } } },
    executeCommand: async (id, ...args) => { commandCalls.push({ id, args }); return undefined },
  },
  env: {
    clipboard: { writeText: async () => undefined },
    asExternalUri: async (uri) => uri,
    openExternal: async () => true,
    remoteName: undefined,
    uiKind: 2,
    appName: 'test-host',
    uriScheme: 'vscode',
  },
}

// --- bundles --------------------------------------------------------------

const sourceDir = path.resolve(__dirname, '../src')

/** Bundle one source file against the fake vscode, exporting the named symbols. */
function bundle(entry, names) {
  const source = require('node:fs').readFileSync(path.join(sourceDir, entry), 'utf8')
  const declared = (name) =>
    new RegExp('(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?(?:function|class|const|let|var)\\s+' + name + '\\b', 'u').test(source)
  const already = new Set([...source.matchAll(/(?:^|\n)\s*export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/gu)].map(match => match[1]))
  const appended = names.filter(name => declared(name) && !already.has(name))
  const code = buildSync({
    stdin: {
      contents: source + (appended.length === 0 ? '' : '\nexport { ' + appended.join(', ') + ' }\n'),
      resolveDir: sourceDir,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    write: false,
  }).outputFiles[0].text
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    (name) => (name === 'vscode' ? fakeVscode : require(name)),
    loaded,
    loaded.exports,
  )
  return loaded.exports
}

const host = bundle('extension.ts', ['SessionOrderController'])
const panel = bundle('session-panel.ts', ['SessionsProvider'])

// --- activate the real extension wiring -----------------------------------

process.env.HOME = mkdtempSync(path.join(os.tmpdir(), 'dsh-ext-delivery-'))
const context = {
  extensionUri: Uri.file('/extension'),
  extension: { packageJSON: { version: '0.0.0-test' } },
  subscriptions: [],
}
host.activate(context)

let receive
registeredProvider.resolveWebviewView({
  webview: {
    cspSource: 'vscode-webview:',
    onDidReceiveMessage(callback) { receive = callback },
    postMessage: async () => undefined,
    options: {},
  },
})

test.after(() => {
  for (const disposable of context.subscriptions) disposable?.dispose?.()
})

/** Deliver one bridge message and let the host's async work finish. */
async function post(message) {
  receive({ source: 'dsh-vscode-bridge', ...message })
  await new Promise((resolve) => { setImmediate(resolve) })
}

// --- delivery cards -------------------------------------------------------

test('a delivery-card click opens the file in the active editor group', async () => {
  opened.length = 0
  await post({ type: 'open-file', path: DELIVERED })
  assert.equal(opened.length, 1)
  assert.equal(opened[0].document.uri.fsPath, DELIVERED)
  assert.equal(opened[0].options.preview, true)
  assert.equal(opened[0].options.viewColumn, undefined)
})

test('the delivery-card chevron can ask for the side group', async () => {
  opened.length = 0
  await post({ type: 'open-file', path: DELIVERED, column: 'beside' })
  assert.equal(opened.length, 1)
  assert.equal(opened[0].options.viewColumn, fakeVscode.ViewColumn.Beside)
})

test('reveal-file selects the delivered file in the Explorer', async () => {
  commandCalls.length = 0
  await post({ type: 'reveal-file', path: DELIVERED })
  const reveal = commandCalls.find(call => call.id === 'revealInExplorer')
  assert.ok(reveal, 'reveal-file must reach revealInExplorer')
  assert.equal(reveal.args[0].fsPath, DELIVERED)
})

test('an unresolvable path warns instead of throwing', async () => {
  opened.length = 0
  warnings.length = 0
  await post({ type: 'open-file', path: '' })
  assert.equal(opened.length, 0)
  assert.ok(warnings.some(message => message.includes('cannot resolve path')), 'expected a warning, got ' + JSON.stringify(warnings))
})

test('the delivery messages are handled, not logged as unknown', async () => {
  outputLines.length = 0
  await post({ type: 'workspace-state', workspaceId: 'ws-1', sessionIds: ['s1'], archivedSessionIds: ['s2'] })
  await post({ type: 'reveal-file', path: DELIVERED })
  const unhandled = outputLines.filter(line => line.includes('unhandled message'))
  assert.deepEqual(unhandled, [])
})

// --- sessions tree: drag and drop -----------------------------------------

/** A DataTransfer stub holding exactly what the controller sets. */
function dataTransfer() {
  return {
    item: undefined,
    set(_mime, item) { this.item = item },
    get() { return this.item },
  }
}

test('a drop plans the move that takes the target row place', async () => {
  const moves = []
  const controller = new host.SessionOrderController(
    { displayedIds: ['a', 'b', 'c'] },
    async (sessionId, beforeSessionId) => { moves.push([sessionId, beforeSessionId]) },
  )
  const transfer = dataTransfer()
  controller.handleDrag([{ sessionId: 'c' }], transfer)
  await controller.handleDrop({ sessionId: 'a' }, transfer)
  assert.deepEqual(moves, [['c', 'a']])
})

test('a drop onto the last row appends instead of carrying a stale anchor', async () => {
  const moves = []
  const controller = new host.SessionOrderController(
    { displayedIds: ['a', 'b', 'c'] },
    async (sessionId, beforeSessionId) => { moves.push([sessionId, beforeSessionId]) },
  )
  const transfer = dataTransfer()
  controller.handleDrag([{ sessionId: 'a' }], transfer)
  await controller.handleDrop({ sessionId: 'c' }, transfer)
  assert.deepEqual(moves, [['a', undefined]])
})

test('a drop onto a row the list no longer holds writes nothing', async () => {
  const moves = []
  const controller = new host.SessionOrderController(
    { displayedIds: ['a', 'b'] },
    async (sessionId, beforeSessionId) => { moves.push([sessionId, beforeSessionId]) },
  )
  const transfer = dataTransfer()
  controller.handleDrag([{ sessionId: 'b' }], transfer)
  await controller.handleDrop({ sessionId: 'gone' }, transfer)
  assert.deepEqual(moves, [])
})

test('a drag with no row and a drop with no drag are both inert', async () => {
  const moves = []
  const controller = new host.SessionOrderController(
    { displayedIds: ['a'] },
    async (sessionId, beforeSessionId) => { moves.push([sessionId, beforeSessionId]) },
  )
  controller.handleDrag([], dataTransfer())
  await controller.handleDrop({ sessionId: 'a' }, dataTransfer())
  assert.deepEqual(moves, [])
})

test('the Sessions tree owns the three row commands the menus declare', async () => {
  for (const id of ['dsh.embed.moveSessionUp', 'dsh.embed.moveSessionDown', 'dsh.embed.archiveSession']) {
    assert.ok(commands.has(id), 'activate must register ' + id)
  }
  // Without a rendered row the step commands resolve nothing and must not
  // reach for the runtime.
  warnings.length = 0
  await commands.get('dsh.embed.moveSessionUp')()
  await commands.get('dsh.embed.archiveSession')()
  assert.deepEqual(warnings, [])
})

// --- sessions tree: the archive-aware list --------------------------------

/** Answer the next session/list read with the given rows. */
function stubSessions(rows) {
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({
      type: 'client-response',
      result: { ok: true, value: { items: rows.map(row => ({ running: false, blank: false, updatedAt: Date.now(), ...row })) } },
    }),
    url,
  })
}

test('archived sessions leave the tree and the published order survives', async () => {
  const provider = new panel.SessionsProvider(() => 'http://127.0.0.1:1')
  stubSessions([
    { sessionId: 's1', cwd: PIN, projections: { values: { title: 'one' } } },
    { sessionId: 's2', cwd: PIN, projections: { values: { title: 'two' } } },
    { sessionId: 's3', cwd: PIN, projections: { values: { title: 'three' } } },
  ])
  provider.updateWorkspaceState({ workspaceId: 'ws-1', sessionIds: ['s3', 's2', 's1'], archivedSessionIds: ['s2'] })
  await provider.refresh()
  assert.deepEqual(provider.getChildren().map(node => node.sessionId), ['s3', 's1'])
  assert.deepEqual(provider.displayedIds, ['s3', 's1'])
  assert.equal(provider.workspaceId, 'ws-1')
  provider.dispose()
})

test('a state without an archive set keeps every published row', async () => {
  const provider = new panel.SessionsProvider(() => 'http://127.0.0.1:1')
  stubSessions([
    { sessionId: 's1', cwd: PIN },
    { sessionId: 's2', cwd: PIN },
  ])
  provider.updateWorkspaceState({ workspaceId: 'ws-1', sessionIds: ['s1', 's2'] })
  await provider.refresh()
  assert.deepEqual(provider.displayedIds, ['s1', 's2'])
  assert.equal(provider.workspaceId, 'ws-1')
  provider.dispose()
})
