/**
 * Regression: host-side drag resolution and the code-block reference command.
 *
 * Frozen behaviour (v2). These tests
 * bundle src/extension.ts through esbuild with a fake 'vscode' module (the
 * harness pattern of startup-error.test.cjs), then drive the exported host
 * functions and the real activate() wiring:
 *   - resolveDropTargets priority: editorData, uri #Lx-Ly, remembered
 *     selection, active-document text, whole-file uri, path-looking text;
 *   - rememberSelection recovers a range from text/plain alone;
 *   - codeBlockRangeFor / indentBlockRange pick the innermost enclosing block;
 *   - the resolveReferences round trip answers the bridge with exact mentions,
 *     and a pending/failed reference-result warns the user once.
 */
'use strict'
const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { buildSync } = require('esbuild')

const PIN = '/ws/pinned'
const A = PIN + '/src/a.ts'
const B = PIN + '/src/b.ts'
const C = PIN + '/src/c.ts'
const BLOCK = PIN + '/src/block.ts'

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
    const scheme = url.protocol.replace(/:$/u, '')
    const host = url.hostname === '' ? '' : '//' + url.hostname
    return new Uri(scheme, host + decodeURIComponent(url.pathname), url.hash.replace(/^#/u, ''), url.search.replace(/^\?/u, ''))
  }

  static joinPath(uri, ...segments) {
    return new Uri(uri.scheme, path.posix.join(uri.fsPath, ...segments))
  }

  static from(value) {
    return new Uri(value.scheme ?? 'file', value.path ?? '', value.fragment ?? '', value.query ?? '')
  }

  get path() { return this.fsPath }

  with(change) {
    return new Uri(
      change.scheme ?? this.scheme,
      change.path ?? change.fsPath ?? this.fsPath,
      change.fragment ?? this.fragment,
      change.query ?? this.query,
    )
  }

  toString() {
    const query = this.query === '' ? '' : '?' + this.query
    return this.scheme + '://' + this.fsPath + query + (this.fragment === '' ? '' : '#' + this.fragment)
  }
}

class Position {
  constructor(line, character) { this.line = line; this.character = character }
  isEqual(other) { return this.line === other.line && this.character === other.character }
}

class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') {
      this.start = new Position(a, b)
      this.end = new Position(c, d)
    } else {
      this.start = a
      this.end = b
    }
  }

  get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character }
}

class Selection extends Range {
  constructor(a, b, c, d) {
    super(a, b, c, d)
    if (typeof a === 'number') {
      this.anchor = this.start
      this.active = this.end
    } else {
      this.anchor = a
      this.active = b
    }
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

const folders = []
const commands = new Map()
const selectionListeners = []
const windowWarnings = []
const outputChannels = []
const clipboardWrites = []
let clipboardError = null
let activeEditor
let registeredProvider
let commandResults = () => undefined

const fakeVscode = {
  Uri, Position, Range, Selection, EventEmitter, TreeItem, ThemeIcon,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  UIKind: { Web: 1, Desktop: 2 },
  workspace: {
    get workspaceFolders() { return folders.length === 0 ? undefined : folders },
    getConfiguration: () => ({ get: (_key, fallback) => fallback ?? '' }),
    asRelativePath(uriOrPath) {
      const fsPath = typeof uriOrPath === 'string' ? uriOrPath : uriOrPath.fsPath
      for (const folder of folders) {
        const root = folder.uri.fsPath
        if (fsPath === root) return ''
        if (fsPath.startsWith(root + '/')) return fsPath.slice(root.length + 1)
      }
      return fsPath
    },
    getWorkspaceFolder: (uri) => folders.find(folder => uri.fsPath.startsWith(folder.uri.fsPath + '/')),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    openTextDocument: async (uri) => ({ uri }),
  },
  window: {
    get activeTextEditor() { return activeEditor },
    set activeTextEditor(value) { activeEditor = value },
    visibleTextEditors: [],
    activeColorTheme: { kind: 2 },
    createOutputChannel(name) {
      const channel = { name, lines: [], appendLine(line) { this.lines.push(line) }, show() {}, dispose() {} }
      outputChannels.push(channel)
      return channel
    },
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    createTreeView: () => ({ dispose() {} }),
    registerWebviewViewProvider: (_id, provider) => { registeredProvider = provider; return { dispose() {} } },
    onDidChangeActiveColorTheme: () => ({ dispose() {} }),
    onDidChangeWindowState: () => ({ dispose() {} }),
    onDidChangeTextEditorSelection(listener) { selectionListeners.push(listener); return { dispose() {} } },
    showWarningMessage: async (message) => { windowWarnings.push(String(message)); return undefined },
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showTextDocument: async () => undefined,
  },
  commands: {
    registerCommand(id, handler) { commands.set(id, handler); return { dispose() { commands.delete(id) } } },
    executeCommand: async (id, ...args) => commandResults(id, ...args),
  },
  env: {
    clipboard: {
      writeText: async (text) => {
        if (clipboardError !== null) throw clipboardError
        clipboardWrites.push(String(text))
      },
    },
    asExternalUri: async (uri) => uri,
    remoteName: undefined,
    uiKind: 2,
    appName: 'test-host',
    uriScheme: 'vscode',
  },
}

// --- bundle src/extension.ts ----------------------------------------------

const sourceDir = path.resolve(__dirname, '../src')
const source = readFileSync(path.join(sourceDir, 'extension.ts'), 'utf8')
const WANTED = [
  'DshWebviewProvider',
  'handleBridgeMessage',
  'resolveDropTargets',
  'resolveDropTargetsDetailed',
  'targetsFromPayload',
  'rememberSelection',
  'codeBlockRangeFor',
  'indentBlockRange',
]
/** Only export names the source actually declares: a missing helper must fail
 *  its own test, not the esbuild bundle that every test in this file shares. */
const declared = (name) =>
  new RegExp('(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?(?:function|class|const|let|var)\\s+' + name + '\\b', 'u').test(source)
const alreadyExported = new Set([...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/gu)].map(match => match[1]))
const appended = WANTED.filter(name => declared(name) && !alreadyExported.has(name))
const code = buildSync({
  stdin: {
    contents: source + '\nexport { ' + appended.join(', ') + ' }\n',
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
const host = loaded.exports

function required(name) {
  const value = host[name]
  if (typeof value !== 'function') {
    throw new Error('src/extension.ts does not export ' + name + ' yet (pending implementation)')
  }
  return value
}

// --- activate the real extension wiring -----------------------------------

process.env.HOME = mkdtempSync(path.join(os.tmpdir(), 'dsh-ext-refs-'))
const context = {
  extensionUri: Uri.file('/extension'),
  extension: { packageJSON: { version: '0.0.0-test' } },
  subscriptions: [],
}
// Activated before a folder exists: the bundle must not spawn the DSH runtime
// in a unit test. The folder is added right after for path resolution.
host.activate(context)
folders.push({ uri: Uri.file(PIN), name: 'pinned' })
const provider = registeredProvider
assert.ok(provider, 'activate registered the webview provider')

const posts = []
let receive
const view = {
  onDidDispose() {},
  webview: {
    cspSource: 'vscode-webview:',
    onDidReceiveMessage(callback) { receive = callback },
    postMessage: async (message) => { posts.push(message) },
  },
}
provider.resolveWebviewView(view)
provider.markBridgeReady()

test.after(() => {
  for (const disposable of context.subscriptions) disposable?.dispose?.()
})

// --- fixtures -------------------------------------------------------------

function makeDocument(fsPath, lines) {
  const text = lines.join('\n')
  const uri = Uri.file(fsPath)
  return {
    uri,
    fileName: fsPath,
    isDirty: false,
    isUntitled: false,
    version: 1,
    eol: 1,
    lineCount: lines.length,
    getText(range) {
      if (range === undefined) return text
      const start = range.start
      const end = range.end
      if (start.line === end.line) return lines[start.line].slice(start.character, end.character)
      const parts = [lines[start.line].slice(start.character)]
      for (let index = start.line + 1; index < end.line; index += 1) parts.push(lines[index])
      parts.push(lines[end.line].slice(0, end.character))
      return parts.join('\n')
    },
    lineAt(lineOrPosition) {
      const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line
      const value = lines[line] ?? ''
      return {
        lineNumber: line,
        text: value,
        range: new Range(line, 0, line, value.length),
        firstNonWhitespaceCharacterIndex: (/^[ \t]*/u.exec(value) ?? [''])[0].length,
        isEmptyOrWhitespace: value.trim() === '',
      }
    },
    positionAt(offset) {
      let remaining = offset
      for (let index = 0; index < lines.length; index += 1) {
        if (remaining <= lines[index].length) return new Position(index, remaining)
        remaining -= lines[index].length + 1
      }
      return new Position(Math.max(0, lines.length - 1), (lines[lines.length - 1] ?? '').length)
    },
    offsetAt(position) {
      let offset = 0
      for (let index = 0; index < position.line; index += 1) offset += lines[index].length + 1
      return offset + position.character
    },
    validateRange(range) { return range },
    validatePosition(position) { return position },
  }
}

function makeEditor(fsPath, lines, cursor = { line: 0, character: 0 }) {
  const document = makeDocument(fsPath, lines)
  const position = new Position(cursor.line, cursor.character)
  const selection = new Selection(position, position)
  return { document, selection, selections: [selection], visibleRanges: [], viewColumn: 1, options: {} }
}

const mentions = (refs) => refs.map(ref => ref.mention)

const flush = () => new Promise(resolve => setImmediate(resolve))

let requestSeq = 0
/** Send one resolveReferences request through the webview and read the answer. */
async function resolveOverBridge(payload) {
  posts.length = 0
  const requestId = 'req-' + String(++requestSeq)
  receive({ source: 'dsh-vscode-bridge', type: 'request', requestType: 'resolveReferences', requestId, payload })
  await flush()
  const response = posts.find(message => message.type === 'response' && message.requestId === requestId)
  assert.ok(response, 'the host must answer resolveReferences: ' + JSON.stringify(posts))
  return response.value
}

const lastInsertRefs = () => posts.filter(message => message.type === 'insert-refs').at(-1)

function resetWindow() {
  activeEditor = undefined
}

// --- resolveDropTargets priority ------------------------------------------

test('editorData beats a uri entry and carries the exact range', () => {
  resetWindow()
  const editorData = JSON.stringify({
    version: 1,
    resource: { fsPath: A },
    selections: [{ startLineNumber: 12, startColumn: 1, endLineNumber: 20, endColumn: 5 }],
  })
  const refs = required('resolveDropTargets')({
    entries: [{ uri: 'file://' + A + '#L1-L2' }, { editorData }],
  })
  assert.deepEqual(mentions(refs), ['@src/a.ts#L12-L20', '@src/a.ts#L1-L2'])
  assert.equal(refs[0].path, A)
  assert.equal(refs[0].label, 'src/a.ts:12-20')
  assert.equal(refs[0].appearance, 'file')
})

test('editorData accepts the alternate keys and unions multi-selections', () => {
  resetWindow()
  const resolve = required('resolveDropTargets')
  const cases = [
    {
      data: { resource: { path: A }, selections: [{ startLine: 5, endLine: 6 }] },
      mention: '@src/a.ts#L5-L6',
    },
    {
      data: { resource: A, selections: [{ startLineNumber: 5, endLineNumber: 6 }] },
      mention: '@src/a.ts#L5-L6',
    },
    {
      data: {
        resource: { fsPath: A },
        selections: [{ startLineNumber: 5, endLineNumber: 6 }, { startLineNumber: 12, endLineNumber: 20 }],
      },
      mention: '@src/a.ts#L5-L20',
    },
    { data: { resource: { fsPath: A } }, mention: '@src/a.ts' },
  ]
  for (const entry of cases) {
    const refs = resolve({ entries: [{ editorData: JSON.stringify(entry.data) }] })
    assert.deepEqual(mentions(refs), [entry.mention], JSON.stringify(entry.data))
  }
})

test('a uri line resolves its fragment, and a bare uri is the whole file', () => {
  resetWindow()
  const resolve = required('resolveDropTargets')
  assert.deepEqual(mentions(resolve({ entries: [{ uri: 'file://' + A + '#L5-L6' }] })), ['@src/a.ts#L5-L6'])
  assert.deepEqual(mentions(resolve({ entries: [{ uri: 'file://' + A }] })), ['@src/a.ts'])
})

test('a bare uri takes the active editor live selection when it owns that file', () => {
  resetWindow()
  const resolve = required('resolveDropTargets')
  const lines = ['one', 'two', 'three', 'four', 'five', 'six']

  // end.character !== 0: the selection ends inside line 5.
  const inside = makeEditor(A, lines)
  inside.selection = new Selection(new Position(2, 0), new Position(4, 3))
  inside.selections = [inside.selection]
  activeEditor = inside
  const selected = resolve({ entries: [{ uri: 'file://' + A }] })
  assert.deepEqual(mentions(selected), ['@src/a.ts#L3-L5'])
  assert.equal(selected[0].path, A)
  assert.equal(selected[0].label, 'src/a.ts:3-5')

  // end.character === 0 boundary: the selection ends at the start of line 6, so
  // line 6 is not part of it and the range stops at line 5.
  const boundary = makeEditor(A, lines)
  boundary.selection = new Selection(new Position(2, 0), new Position(5, 0))
  boundary.selections = [boundary.selection]
  activeEditor = boundary
  assert.deepEqual(mentions(resolve({ entries: [{ uri: 'file://' + A }] })), ['@src/a.ts#L3-L5'])
})

test('a bare uri stays whole-file when there is no live selection', () => {
  resetWindow()
  const resolve = required('resolveDropTargets')
  const lines = ['one', 'two', 'three', 'four', 'five', 'six']

  assert.deepEqual(mentions(resolve({ entries: [{ uri: 'file://' + A }] })), ['@src/a.ts'], 'no active editor')

  activeEditor = makeEditor(A, lines, { line: 2, character: 0 })
  assert.deepEqual(mentions(resolve({ entries: [{ uri: 'file://' + A }] })), ['@src/a.ts'], 'empty selection')
})

test('a live selection in another file does not change a bare uri', () => {
  resetWindow()
  const resolve = required('resolveDropTargets')
  const other = makeEditor(C, ['one', 'two', 'three', 'four'])
  other.selection = new Selection(new Position(1, 0), new Position(3, 2))
  other.selections = [other.selection]
  activeEditor = other
  assert.deepEqual(mentions(resolve({ entries: [{ uri: 'file://' + A }] })), ['@src/a.ts'])
})

test('a remembered selection recovers the range from text alone, ahead of the active document', () => {
  resetWindow()
  const resolve = required('resolveDropTargets')
  const remember = required('rememberSelection')
  const marker = 'const remembered_marker = 42'
  // The active editor also contains the marker, at line 10: only the priority
  // rule (remembered selection before document search) yields line 3.
  activeEditor = makeEditor(C, [
    'export function other() {',
    '  const first = 1',
    '  const second = 2',
    '  const third = 3',
    '  const fourth = 4',
    '  const fifth = 5',
    '  const sixth = 6',
    '  const seventh = 7',
    '  const eighth = 8',
    marker,
    '}',
  ])
  remember('file://' + B, 3, 3, marker)
  assert.deepEqual(mentions(resolve({ entries: [{ text: marker }] })), ['@src/b.ts#L3'])
})

test('remembered selections match after CRLF normalization and trimming, most recent wins', () => {
  resetWindow()
  const resolve = required('resolveDropTargets')
  const remember = required('rememberSelection')
  const marker = 'const crlf_marker = 7'
  remember('file://' + B, 3, 4, '\r\n  ' + marker + '  \r\n')
  assert.deepEqual(mentions(resolve({ entries: [{ text: marker }] })), ['@src/b.ts#L3-L4'])

  const later = 'const newest_marker = 9'
  remember('file://' + B, 8, 8, later)
  remember('file://' + C, 11, 11, later)
  assert.deepEqual(mentions(resolve({ entries: [{ text: later }] })), ['@src/c.ts#L11'])
})

test('dropped text found verbatim in the active document resolves to the match line', () => {
  resetWindow()
  const resolve = required('resolveDropTargets')
  const needle = 'return needle_from_drop()'
  activeEditor = makeEditor(C, [
    'export function find() {',
    '  const first = 1',
    '  const second = 2',
    '  const third = 3',
    '  const fourth = 4',
    '  const fifth = 5',
    '  const sixth = 6',
    '  const seventh = 7',
    '  const eighth = 8',
    needle,
    '}',
  ])
  assert.deepEqual(mentions(resolve({ entries: [{ text: needle }] })), ['@src/c.ts#L10'])
})

test('path-looking text resolves, and an unresolvable drop explains itself', () => {
  resetWindow()
  const resolveDetailed = required('resolveDropTargetsDetailed')
  const resolve = required('resolveDropTargets')
  assert.deepEqual(mentions(resolve({ entries: [{ text: A }] })), ['@src/a.ts'])
  assert.deepEqual(mentions(resolve({ entries: [{ text: 'src/util.ts' }] })), ['@src/util.ts'])

  const unresolved = resolveDetailed({ entries: [{ text: 'just some words' }] })
  assert.deepEqual(unresolved.refs, [])
  assert.equal(unresolved.reason, 'unresolved-text')
  assert.equal(resolveDetailed(undefined).reason, 'empty-payload')
  assert.equal(resolveDetailed({ entries: [{}] }).reason, 'unresolved-drop')
})

test('a resource-label text entry adds no spurious ref next to its own uri', () => {
  resetWindow()
  const resolve = required('resolveDropTargets')
  const remember = required('rememberSelection')
  const labeledPath = PIN + '/src/labeled.ts'
  // Explorer and editor-tab drags put the dragged file's label on text/plain.
  // Each form below is what VS Code may send, and each is also present in the
  // open editor (an import line) and as a remembered selection, so without the
  // resource-label guard the text stages would add a second, range-carrying
  // reference for a drag that names exactly one file.
  const forms = ['src/labeled.ts', 'labeled.ts', labeledPath, 'file://' + labeledPath]
  for (const form of forms) {
    resetWindow()
    activeEditor = makeEditor(C, ['// ' + form, 'const unrelated = 1'])
    remember('file://' + B, 5, 5, form)
    const refs = resolve({ entries: [{ uri: 'file://' + labeledPath }, { text: form }] })
    assert.deepEqual(mentions(refs), ['@src/labeled.ts'], 'label form ' + JSON.stringify(form))
    assert.equal(refs.length, 1, 'exactly one whole-file ref for ' + JSON.stringify(form))
    assert.equal(refs[0].path, labeledPath)
    assert.equal(refs[0].label, 'src/labeled.ts')
  }
})

test('a label-like text entry without its own uri entry is still resolved as text', () => {
  resetWindow()
  const resolve = required('resolveDropTargets')
  const remember = required('rememberSelection')
  // The guard compares the text against the drag's own uri entries; a payload
  // with no uri has no label to match, so the text keeps its normal meaning.
  remember('file://' + B, 5, 5, 'src/lonely.ts')
  assert.deepEqual(mentions(resolve({ entries: [{ text: 'src/lonely.ts' }] })), ['@src/b.ts#L5'])
})

test('genuine code text next to its own uri still recovers the remembered range', () => {
  resetWindow()
  const resolve = required('resolveDropTargets')
  const remember = required('rememberSelection')
  const code = 'const genuine = compute(41)'
  // Only the remembered selection carries this text: code text is not a label,
  // so stage 3 must still recover its exact range beside the uri's whole file.
  activeEditor = makeEditor(C, ['export function unrelated() {', '  return 1', '}'])
  remember('file://' + B, 7, 7, code)
  const refs = resolve({ entries: [{ uri: 'file://' + A }, { text: code }] })
  assert.deepEqual(mentions(refs), ['@src/b.ts#L7', '@src/a.ts'])
})

test('genuine code text still resolves through the active-document search', () => {
  resetWindow()
  const resolve = required('resolveDropTargets')
  const code = 'return document_search_hit(3)'
  activeEditor = makeEditor(C, [
    'export function searchable() {',
    '  const first = 1',
    '  const second = 2',
    '  const third = 3',
    code,
    '}',
  ])
  assert.deepEqual(mentions(resolve({ entries: [{ text: code }] })), ['@src/c.ts#L5'])
})

// --- block ranges ---------------------------------------------------------

test('codeBlockRangeFor keeps the innermost fold and breaks span ties by the later start', () => {
  const codeBlockRangeFor = required('codeBlockRangeFor')
  assert.deepEqual(
    codeBlockRangeFor([{ start: 0, end: 5 }, { start: 2, end: 3 }, { start: 2, end: 4 }], 2),
    { startLine: 3, endLine: 4 },
  )
  assert.deepEqual(
    codeBlockRangeFor([{ start: 1, end: 4 }, { start: 2, end: 5 }], 2),
    { startLine: 3, endLine: 6 },
  )
  assert.equal(codeBlockRangeFor([{ start: 0, end: 1 }], 5), undefined, 'a line outside every fold has no block')
  assert.equal(codeBlockRangeFor([{ start: 0, end: 3 }], Number.NaN), undefined)
})

test('indentBlockRange picks the innermost enclosing block, closing brace included', () => {
  const indentBlockRange = required('indentBlockRange')
  const lines = [
    'function outer() {',
    '  if (ok) {',
    '    doWork()',
    '  }',
    '}',
  ]
  assert.deepEqual(indentBlockRange(lines, 2), { startLine: 2, endLine: 4 }, 'cursor inside the nested block')
  assert.deepEqual(indentBlockRange(lines, 3), { startLine: 2, endLine: 4 }, 'cursor on the inner closing brace')
  assert.deepEqual(indentBlockRange(lines, 0), { startLine: 1, endLine: 5 }, 'on the header the whole block is it')
  assert.deepEqual(
    indentBlockRange(['const a = 1', '  doWork()', 'const b = 2'], 1),
    { startLine: 2, endLine: 2 },
    'a non-header previous line is not climbed',
  )
  assert.equal(indentBlockRange([], 0), undefined)
  assert.equal(indentBlockRange(lines, 9), undefined)
})

// --- activation wiring ----------------------------------------------------

test('the resolveReferences round trip answers with the exact mention and no reason', async () => {
  resetWindow()
  const editorData = JSON.stringify({
    resource: { fsPath: A },
    selections: [{ startLineNumber: 12, endLineNumber: 20 }],
  })
  const value = await resolveOverBridge({ entries: [{ editorData }], useActiveEditor: true })
  assert.deepEqual(mentions(value.refs), ['@src/a.ts#L12-L20'])
  assert.equal(typeof value.cwd, 'string')
  assert.equal('reason' in value, false, 'a resolved drop carries no reason: ' + JSON.stringify(value))
})

test('a selection change lets a later text-only drop resolve to the exact range', async () => {
  resetWindow()
  const marker = 'wire_marker_remembered = 7'
  const lines = [
    'export function wired() {',
    '  const first = 1',
    '  const second = 2',
    '  ' + marker,
    '}',
  ]
  const editor = makeEditor(B, lines, { line: 3, character: 2 })
  editor.selection = new Selection(new Position(3, 2), new Position(3, 2 + marker.length))
  editor.selections = [editor.selection]
  for (const listener of selectionListeners) {
    listener({ textEditor: editor, selections: editor.selections, kind: 1 })
  }
  resetWindow()

  const value = await resolveOverBridge({ entries: [{ text: marker }], useActiveEditor: true })
  assert.deepEqual(mentions(value.refs), ['@src/b.ts#L4'])
})

test('an unresolvable text drop answers with empty refs and the unresolved-text reason', async () => {
  resetWindow()
  const value = await resolveOverBridge({ entries: [{ text: 'nothing matches this string 4711' }], useActiveEditor: false })
  assert.deepEqual(value.refs, [])
  assert.equal(value.reason, 'unresolved-text')
})

test('the referenceBlock command posts the folding range when the provider answers', async () => {
  resetWindow()
  posts.length = 0
  activeEditor = makeEditor(BLOCK, [
    'function outer() {',
    '  if (ok) {',
    '    doWork()',
    '  }',
    '}',
  ], { line: 2, character: 4 })
  commandResults = (id) => (id === 'vscode.executeFoldingRangeProvider' ? [{ start: 0, end: 4 }] : undefined)
  const command = commands.get('dsh.embed.referenceBlock')
  assert.ok(command, 'the Reference Code Block command must be registered')
  await command()
  await flush()
  const posted = lastInsertRefs()
  assert.ok(posted, 'the command must push a reference into the bridge: ' + JSON.stringify(posts))
  assert.deepEqual(mentions(posted.refs), ['@src/block.ts#L1-L5'])
  commandResults = () => undefined
})

test('the referenceBlock command falls back to the indentation block', async () => {
  resetWindow()
  posts.length = 0
  activeEditor = makeEditor(BLOCK, [
    'function outer() {',
    '  if (ok) {',
    '    doWork()',
    '  }',
    '}',
  ], { line: 2, character: 4 })
  commandResults = () => undefined
  await commands.get('dsh.embed.referenceBlock')()
  await flush()
  const posted = lastInsertRefs()
  assert.ok(posted, 'the command must push a reference into the bridge: ' + JSON.stringify(posts))
  assert.deepEqual(mentions(posted.refs), ['@src/block.ts#L2-L4'])
})

test('a pending or failed reference-result warns once, an inserted one never warns', async () => {
  resetWindow()
  windowWarnings.length = 0
  const output = outputChannels[0]
  const result = { source: 'dsh-vscode-bridge', type: 'reference-result', count: 1, mentions: ['@src/a.ts#L12-L20'], attempts: 1 }
  receive({ ...result, outcome: 'pending', reason: 'no-session' })
  await flush()
  assert.equal(windowWarnings.length, 1, JSON.stringify(windowWarnings))
  assert.match(windowWarnings[0], /waiting to be inserted/u)
  assert.match(windowWarnings[0], /no session is open/u)
  assert.ok(output.lines.some(line => line.includes('reference pending: no session is open')), JSON.stringify(output.lines))

  receive({ ...result, outcome: 'pending', reason: 'no-session' })
  await flush()
  assert.equal(windowWarnings.length, 1, 'the same warning must not repeat: ' + JSON.stringify(windowWarnings))

  receive({ ...result, outcome: 'inserted' })
  await flush()
  assert.equal(windowWarnings.length, 1, 'an inserted chip is not a warning')
})

test('pending reasons no-scope and no-service warn once, junk reasons never warn', async () => {
  resetWindow()
  windowWarnings.length = 0
  const output = outputChannels[0]
  const result = {
    source: 'dsh-vscode-bridge',
    type: 'reference-result',
    outcome: 'pending',
    count: 1,
    mentions: ['@src/a.ts#L12-L20'],
    attempts: 1,
  }

  receive({ ...result, reason: 'no-scope: session-42' })
  await flush()
  assert.equal(windowWarnings.length, 1, JSON.stringify(windowWarnings))
  assert.match(windowWarnings[0], /waiting to be inserted \(no-scope: session-42\)/u)

  receive({ ...result, reason: 'no-scope: session-42' })
  await flush()
  assert.equal(windowWarnings.length, 1, 'the same no-scope warning must not repeat: ' + JSON.stringify(windowWarnings))

  receive({ ...result, reason: 'no-service' })
  await flush()
  assert.equal(windowWarnings.length, 2, JSON.stringify(windowWarnings))
  assert.match(windowWarnings[1], /waiting to be inserted \(no-service\)/u)

  // A drop that was never a reference stays telemetry/output-only.
  const before = output.lines.length
  for (const reason of ['empty-payload', 'unresolved-drop']) {
    receive({ ...result, reason })
    await flush()
    assert.equal(windowWarnings.length, 2, reason + ' must stay telemetry-only: ' + JSON.stringify(windowWarnings))
  }
  const added = output.lines.slice(before)
  assert.ok(added.includes('[bridge] reference pending: empty-payload'), JSON.stringify(added))
  assert.ok(added.includes('[bridge] reference pending: unresolved-drop'), JSON.stringify(added))
})

test('a drag-handled message is counted and logged, never unhandled', async () => {
  resetWindow()
  windowWarnings.length = 0
  const output = outputChannels[0]
  const before = output.lines.length
  receive({ source: 'dsh-vscode-bridge', type: 'drag-handled', count: 3 })
  await flush()
  const added = output.lines.slice(before)
  assert.ok(added.includes('[bridge] drag-handled count 3'), JSON.stringify(added))
  assert.equal(added.some(line => line.includes('unhandled message')), false, JSON.stringify(added))
  assert.ok(added.some(line => line.startsWith('[telemetry] bridge.drag-handled')), JSON.stringify(added))
  assert.equal(windowWarnings.length, 0)
})

test('package.json binds the block reference to the no-selection key context', () => {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  const keybindings = manifest.contributes?.keybindings ?? []
  const byCommand = (command) => keybindings.filter(entry => entry.command === command)

  const block = byCommand('dsh.embed.referenceBlock')
  assert.equal(block.length, 1, JSON.stringify(keybindings))
  assert.equal(block[0].key, 'ctrl+alt+d')
  assert.equal(block[0].mac, 'cmd+alt+d')
  assert.equal(block[0].when, 'editorTextFocus && !editorHasSelection')

  const selection = byCommand('dsh.embed.referenceSelection')
  assert.equal(selection.length, 1, JSON.stringify(keybindings))
  assert.equal(selection[0].key, 'ctrl+alt+d')
  assert.equal(selection[0].mac, 'cmd+alt+d')
  assert.equal(selection[0].when, 'editorHasSelection')

  const commandIds = (manifest.contributes?.commands ?? []).map(entry => entry.command)
  assert.ok(commandIds.includes('dsh.embed.referenceBlock'), JSON.stringify(commandIds))
  assert.ok(commandIds.includes('dsh.embed.referenceSelection'), JSON.stringify(commandIds))
})

test('a writeClipboard request is answered and writes the host clipboard', async () => {
  resetWindow()
  posts.length = 0
  clipboardWrites.length = 0
  clipboardError = null
  receive({
    source: 'dsh-vscode-bridge',
    type: 'request',
    requestType: 'writeClipboard',
    requestId: 'wc-1',
    payload: { text: 'copied through the host' },
  })
  await flush()
  const response = posts.find(message => message.type === 'response' && message.requestId === 'wc-1')
  assert.ok(response, 'the awaited request must be answered: ' + JSON.stringify(posts))
  assert.deepEqual(response.value, { ok: true })
  assert.deepEqual(clipboardWrites, ['copied through the host'])

  // A failing host clipboard answers ok:false instead of leaving the page pending.
  clipboardError = new Error('clipboard unavailable')
  posts.length = 0
  receive({
    source: 'dsh-vscode-bridge',
    type: 'request',
    requestType: 'writeClipboard',
    requestId: 'wc-2',
    payload: { text: 'cannot write' },
  })
  await flush()
  const failed = posts.find(message => message.type === 'response' && message.requestId === 'wc-2')
  assert.ok(failed, JSON.stringify(posts))
  assert.deepEqual(failed.value, { ok: false, message: 'clipboard unavailable' })
  clipboardError = null
})

test('clipboard telemetry records the length, never the copied content', async () => {
  resetWindow()
  const output = outputChannels[0]
  const secret = 'secret-copied-content-4711'
  const before = output.lines.length
  receive({ source: 'dsh-vscode-bridge', type: 'copy-text', text: secret })
  receive({
    source: 'dsh-vscode-bridge',
    type: 'request',
    requestType: 'writeClipboard',
    requestId: 'wc-tel',
    payload: { text: secret },
  })
  await flush()

  const added = output.lines.slice(before)
  const copyLine = added.find(line => line.startsWith('[telemetry] bridge.copy-text'))
  assert.ok(copyLine, JSON.stringify(added))
  assert.equal(copyLine.includes(secret), false, copyLine)
  const copyData = JSON.parse(copyLine.slice('[telemetry] bridge.copy-text '.length))
  assert.equal(copyData.textLength, Buffer.byteLength(secret, 'utf8'))

  const requestLine = added.find(line => line.startsWith('[telemetry] bridge.request') && line.includes('writeClipboard'))
  assert.ok(requestLine, JSON.stringify(added))
  assert.equal(requestLine.includes(secret), false, requestLine)
  const requestData = JSON.parse(requestLine.slice('[telemetry] bridge.request '.length))
  assert.equal(requestData.textLength, Buffer.byteLength(secret, 'utf8'))
  assert.equal(requestData.requestType, 'writeClipboard')

  // Non-clipboard messages keep their short preview: only the two clipboard
  // messages are redacted to a length.
  receive({ source: 'dsh-vscode-bridge', type: 'probe', text: 'visible preview' })
  await flush()
  const probeLine = output.lines.slice(before).find(line => line.startsWith('[telemetry] bridge.probe'))
  assert.ok(probeLine, JSON.stringify(output.lines.slice(before)))
  assert.match(probeLine, /"text":"visible preview"/u)
})
