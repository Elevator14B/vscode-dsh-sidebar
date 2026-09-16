/**
 * Regression: drag-to-reference inside the embedded page.
 *
 * Frozen behaviour (v2): a drop that the
 * host resolves must end in a real chip insertion through
 * conversation.input.for(scope).insertReference, and every outcome — inserted,
 * text-fallback, pending, failed — must be reported back to the host as a
 * 'reference-result' message. The defect this file pins down is the silent
 * failure: the old bridge queued a ref, found no input (or had the chip
 * rejected), and reported nothing, so the drag looked like a no-op.
 *
 * These tests read dist/bridge.js and drive real drop events into the loaded
 * plugin, exactly like bridge-links.test.cjs and bridge-pin.test.cjs.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const PIN = '/ws/pinned'
const MENTION = '@src/a.ts#L12-L20'
const DROPPED_TEXT = 'const x = 1\nconst y = 2'
/** Raw vscode-editor-data payload a VS Code editor text drag carries. */
const EDITOR_DATA = JSON.stringify({
  version: 1,
  resource: { fsPath: PIN + '/src/a.ts' },
  selections: [{ startLineNumber: 12, startColumn: 1, endLineNumber: 20, endColumn: 5 }],
  mode: 'typescript',
})

// --- fake page ------------------------------------------------------------

const posted = []
const documentListeners = new Map()
const windowListeners = new Map()

/** Minimal element: enough of the DOM for the bridge's overlay construction. */
class FakeElement {
  constructor(tag) {
    this.tag = tag
    this.children = []
    this.parent = null
    this.attrs = {}
    this.listeners = new Map()
    this.textContent = ''
    this.type = ''
    this.style = { cssText: '' }
    this.offsetWidth = 200
    this.offsetHeight = 100
  }

  setAttribute(name, value) { this.attrs[name] = String(value) }
  getAttribute(name) { return this.attrs[name] === undefined ? null : this.attrs[name] }
  removeAttribute(name) { delete this.attrs[name] }
  hasAttribute(name) { return this.attrs[name] !== undefined }
  toggleAttribute(name, force) {
    const next = force === undefined ? this.attrs[name] === undefined : Boolean(force)
    if (next) this.attrs[name] = ''
    else delete this.attrs[name]
    return next
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child }
  remove() {
    if (this.parent !== null) this.parent.children = this.parent.children.filter(child => child !== this)
    this.parent = null
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ preventDefault() {}, stopPropagation() {}, ...event })
    }
  }

  contains(node) {
    return node === this || this.children.some(child => child.contains(node))
  }

  closest(selector) {
    let node = this
    while (node !== null) {
      if (selector === 'a[href]' && node.tag === 'a' && node.getAttribute('href') !== null) return node
      node = node.parent
    }
    return null
  }
}

const documentElement = new FakeElement('html')

globalThis.__DSH_VSCODE__ = { cwd: PIN, canonicalCwd: PIN, title: 'pinned', theme: 'dark', locale: 'zh-cn' }
globalThis.parent = { postMessage: (message) => { posted.push(message) } }
globalThis.location = { href: 'http://127.0.0.1:1234/', origin: 'http://127.0.0.1:1234' }
if (globalThis.navigator === undefined) globalThis.navigator = { platform: 'linux' }
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0)
globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle)
globalThis.window = {
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener(type, listener) {
    windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener])
  },
  removeEventListener(type, listener) {
    windowListeners.set(type, (windowListeners.get(type) ?? []).filter(entry => entry !== listener))
  },
}
globalThis.document = {
  addEventListener(type, listener) {
    documentListeners.set(type, [...(documentListeners.get(type) ?? []), { listener, capture: true }])
  },
  removeEventListener(type, listener) {
    documentListeners.set(type, (documentListeners.get(type) ?? []).filter(entry => entry.listener !== listener))
  },
  createElement(tag) { return new FakeElement(tag) },
  getElementById() { return null },
  documentElement,
  head: new FakeElement('head'),
  body: { toggleAttribute() {}, innerText: '', style: {} },
}
const loadedRows = []
globalThis.__ModuleLoader__ = { load: (row) => { loadedRows.push(row) } }
globalThis.__DSH_BOOT__ = { entries: [], batches: [{ phase: 'application', entries: [] }] }

new Function(readFileSync(join(__dirname, '..', 'dist', 'bridge.js'), 'utf8'))()

const pluginRow = loadedRows.find(entry => entry.id === '@dsh/vscode-embed-bridge')
assert.ok(pluginRow, 'the bridge registered its plugin row')

// --- fake boot graph ------------------------------------------------------

/** Snapshot store stand-in with a settable value and listener fan-out. */
function snapshot(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next) {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Fake composer input face: the chip API under test. */
function createInput() {
  let draft = ''
  let draftRev = 7
  let accept = true
  const calls = []
  return {
    state: { getSnapshot: () => ({ draft, draftRev, occurrences: [] }) },
    insertReference(ref, span) {
      calls.push({ kind: 'insertReference', ref, span })
      if (!accept) return false
      draft = (draft === '' ? '' : draft.replace(/\s+$/u, ' ') + ' ') + ref.ref + ' '
      draftRev += 1
      return true
    },
    setDraft(next) {
      calls.push({ kind: 'setDraft', text: next })
      draft = next
      draftRev += 1
    },
    calls,
    draft: () => draft,
    resetDraft() { draft = ''; draftRev = 7 },
    setAccept(next) { accept = next },
  }
}

const sessionRow = { id: 'session-1', cwd: PIN, title: 'root', blank: false, running: false, updatedAt: 1 }
const sessionsList = snapshot({ phase: 'ready', ids: ['session-1'], current: 'session-1', byId: { 'session-1': sessionRow } })
const workspacesList = snapshot({
  phase: 'ready',
  items: [{ workspaceId: 'ws-pinned', path: PIN, sessionIds: ['session-1'] }],
})
const input = createInput()

const services = {
  sessions: {
    list: sessionsList,
    scope: (sessionId) => ({ sessionId }),
    open() {},
    openSubagent() {},
    async create() { return 'session-created' },
    async fork() { return 'session-forked' },
    binding() { return { session: { async rename() { return { ok: true, value: {} } } } } },
    clear() {},
  },
  workspaces: { list: workspacesList },
  uiWorkspace: { async connectWorkspace() { return 'session-1' }, async archiveSession() {} },
  conversation: { input: { for: () => input } },
  theme: {},
  sidebarRight: { openResource() {} },
  'remote.session': { async openWorkspacePath() { return { ok: true, value: { opened: true } } } },
}
const ctx = {
  get: (name) => services[name],
  on: () => () => {},
  effect(effect) { return effect() },
  inject(_dependencies, callback) { return callback(ctx) },
}

pluginRow.factory(require).apply(ctx)

// --- helpers --------------------------------------------------------------

const settle = () => new Promise((resolve) => { setTimeout(resolve, 10) })

function dispatchDocument(type, event) {
  for (const entry of [...(documentListeners.get(type) ?? [])]) {
    if (!(documentListeners.get(type) ?? []).includes(entry)) continue
    entry.listener(event)
  }
}

function hostMessage(data) {
  for (const listener of [...(windowListeners.get('message') ?? [])]) listener({ data })
}

/** One synthetic DataTransfer carrying the given type → string map. */
function makeDataTransfer(typeValues) {
  return {
    types: Object.keys(typeValues),
    getData: (type) => typeValues[type] ?? '',
    setData() {},
    dropEffect: 'none',
    files: [],
  }
}

function drop(typeValues) {
  dispatchDocument('drop', {
    target: documentElement,
    clientX: 10,
    clientY: 10,
    dataTransfer: makeDataTransfer(typeValues),
    preventDefault() {},
    stopPropagation() {},
  })
}

const requests = (requestType) => posted.filter(message => message.type === 'request' && message.requestType === requestType)
const lastRequest = (requestType) => requests(requestType).at(-1)
const referenceResults = () => posted.filter(message => message.type === 'reference-result')
const lastResult = () => referenceResults().at(-1)
const hostRef = (mention) => ({ path: PIN + '/src/a.ts', mention, label: 'src/a.ts:12-20', appearance: 'file' })

/** Answer the newest resolveReferences request with one host response value. */
async function resolveWith(refs, extra = {}) {
  const request = lastRequest('resolveReferences')
  assert.ok(request, 'a resolveReferences request must reach the host')
  hostMessage({
    source: 'dsh-vscode-host',
    type: 'response',
    requestId: request.requestId,
    value: { refs, cwd: PIN, ...extra },
  })
  await settle()
  return request
}

function reset() {
  posted.length = 0
  input.calls.length = 0
  input.setAccept(true)
  input.resetDraft()
}

// --- checks ---------------------------------------------------------------

test('an editor text drag forwards the dropped text plus the raw editor data', () => {
  reset()
  drop({ 'text/plain': DROPPED_TEXT, 'vscode-editor-data': EDITOR_DATA })

  const request = lastRequest('resolveReferences')
  assert.ok(request, 'the drop must ask the host to resolve references')
  assert.equal(request.payload.useActiveEditor, true, 'an editor drag may use the active editor')
  const entries = request.payload.entries ?? []
  assert.ok(
    entries.some(entry => entry.text === DROPPED_TEXT),
    'the dragged text must be forwarded so the host can recover the range: ' + JSON.stringify(entries),
  )
  assert.ok(
    entries.some(entry => entry.editorData === EDITOR_DATA),
    'the raw vscode-editor-data must be forwarded verbatim: ' + JSON.stringify(entries),
  )
})

test('an editor text drag ends in the exact @path#Lx-Ly chip', async () => {
  reset()
  drop({ 'text/plain': DROPPED_TEXT, 'vscode-editor-data': EDITOR_DATA })
  await resolveWith([hostRef(MENTION)])

  const inserts = input.calls.filter(call => call.kind === 'insertReference')
  assert.equal(inserts.length, 1, 'the resolved ref must go in once: ' + JSON.stringify(input.calls))
  assert.equal(inserts[0].ref.ref, MENTION, 'the chip carries the exact mention')
  assert.equal(inserts[0].ref.clipboardText, MENTION)
  assert.equal(inserts[0].ref.appearance, 'file')

  const result = lastResult()
  assert.ok(result, 'the bridge must report the outcome as reference-result')
  assert.equal(result.outcome, 'inserted')
  assert.equal(result.count, 1)
  assert.deepEqual(result.mentions, [MENTION])
})

test('a file drag from the explorer or a tab box keeps its old exact ref', async () => {
  reset()
  drop({
    resourceurls: '',
    codeeditors: '',
    'application/vnd.code.uri-list': 'file://' + PIN + '/src/a.ts#L12-L20',
  })

  const request = lastRequest('resolveReferences')
  assert.ok(request, 'the file drag must ask the host to resolve references')
  const entries = request.payload.entries ?? []
  assert.ok(
    entries.some(entry => entry.uri === 'file://' + PIN + '/src/a.ts#L12-L20'),
    'the uri list line must be forwarded verbatim: ' + JSON.stringify(entries),
  )

  await resolveWith([hostRef(MENTION)])
  const inserts = input.calls.filter(call => call.kind === 'insertReference')
  assert.equal(inserts.length, 1, JSON.stringify(input.calls))
  assert.equal(inserts[0].ref.ref, MENTION)
  assert.equal(lastResult().outcome, 'inserted')
})

test('every documented drag type counts as a reference drag', () => {
  const sets = [
    ['text/plain'],
    ['text/uri-list'],
    ['application/vnd.code.uri-list'],
    ['application/vnd.code.internalUriList'],
    ['application/vnd.code.resources'],
    ['resourceurls'],
    ['codeeditors'],
    ['vscode-editor-data'],
    ['Files'],
  ]
  for (const types of sets) {
    reset()
    drop(Object.fromEntries(types.map(type => [type, ''])))
    const diagnostic = posted.find(message => message.type === 'drag-drop')
    assert.ok(diagnostic, 'the drop must always be diagnosed: ' + JSON.stringify(posted))
    assert.equal(diagnostic.mayReference, true, 'types [' + types.join(',') + '] must be accepted')
  }
})

test('a rejected chip appends the mention to the draft and reports text-fallback', async () => {
  reset()
  input.setAccept(false)
  drop({ 'text/plain': DROPPED_TEXT, 'vscode-editor-data': EDITOR_DATA })
  await resolveWith([hostRef(MENTION)])

  const result = lastResult()
  assert.ok(result, 'a rejected chip must not fail silently')
  assert.equal(result.outcome, 'text-fallback')
  assert.deepEqual(result.mentions, [MENTION])
  assert.equal(result.count, 1)
  assert.ok(
    input.draft().includes(MENTION),
    'the mention must be visible in the draft: ' + JSON.stringify(input.draft()),
  )
})

test('with no current session the refs stay queued and a list change inserts them', async () => {
  reset()
  sessionsList.set({ ...sessionsList.getSnapshot(), current: undefined })
  drop({ 'text/plain': DROPPED_TEXT, 'vscode-editor-data': EDITOR_DATA })
  await resolveWith([hostRef(MENTION)])

  const pending = lastResult()
  assert.ok(pending, 'a queued ref must be reported as pending, not dropped')
  assert.equal(pending.outcome, 'pending')
  assert.equal(pending.reason, 'no-session')
  assert.deepEqual(pending.mentions, [MENTION])
  assert.equal(
    input.calls.filter(call => call.kind === 'insertReference').length,
    0,
    'nothing can be inserted without an input',
  )

  // Opening a session re-publishes the sessions list; the awaited ref flushes.
  sessionsList.set({ ...sessionsList.getSnapshot(), current: 'session-1' })
  await settle()

  assert.equal(lastResult().outcome, 'inserted', 'the retry must report the real insertion')
  const inserts = input.calls.filter(call => call.kind === 'insertReference')
  assert.equal(inserts.length, 1, JSON.stringify(input.calls))
  assert.equal(inserts[0].ref.ref, MENTION)
})

test('a drop the host cannot resolve still lands in the draft, visibly', async () => {
  reset()
  drop({ 'text/plain': 'hello world' })
  await resolveWith([], { reason: 'unresolved-text' })

  assert.ok(
    input.draft().includes('hello world'),
    'an unresolved drop must never be a no-op: ' + JSON.stringify(input.draft()),
  )
  const result = lastResult()
  assert.ok(result, 'the outcome must be reported as reference-result')
  assert.ok(
    result.outcome === 'text-fallback' || result.outcome === 'failed',
    'expected a visible fallback outcome, got ' + JSON.stringify(result),
  )
})
