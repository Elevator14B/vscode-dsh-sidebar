/**
 * Regression: the embed's auto-pin gate decides membership by folder, not by
 * the Workspace ownership account.
 *
 * Every `subagent` tool run and every Agent Teams teammate is created through
 * the agent factory and is never attached to a Workspace record, so its id is
 * absent from every `sessionIds` list. Testing ownership alone read "the user
 * opened a subagent" as "the wrong workspace is pinned", and the re-pin that
 * followed opened — or created — a blank session: clicking a subagent jumped to
 * an empty new session.
 *
 * The throwaway driver that found this lives outside the repository; this file
 * keeps the two predicates (pin gate and scope guard) under `npm test`.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const PIN = '/ws/pinned'
const PIN_WS = 'ws-pinned'
const FOREIGN_WS = 'ws-foreign'
const ROOT = 'session-root'
const CHILD = 'session-child'
const GRANDCHILD = 'session-grandchild'
const CHILDLESS = 'session-childless'
const FOREIGN = 'session-foreign'
const FOREIGN_CHILD = 'session-foreign-child'
const TWIN_A = 'session-twin-a'
const TWIN_B = 'session-twin-b'

// --- fake page ------------------------------------------------------------

const posted = []
const calls = []

globalThis.__DSH_VSCODE__ = { cwd: PIN, canonicalCwd: PIN, title: 'pinned', theme: 'dark' }
globalThis.parent = { postMessage: (message) => { posted.push(message) } }
globalThis.location = { href: 'http://127.0.0.1:1/' }
const clickListeners = []
globalThis.document = {
  addEventListener(type, listener) { if (type === 'click') clickListeners.push(listener) },
  getElementById() { return null },
  createElement() { return { appendChild() {}, setAttribute() {}, remove() {}, style: {} } },
  documentElement: { style: {}, appendChild() {} },
  head: { appendChild() {} },
  body: { toggleAttribute() {}, innerText: '' },
}
const messageListeners = []
globalThis.window = { addEventListener(type, fn) { if (type === 'message') messageListeners.push(fn) } }
const loadedRows = []
globalThis.__ModuleLoader__ = { load: (row) => { loadedRows.push(row) } }
globalThis.__DSH_BOOT__ = { entries: [], batches: [{ phase: 'application', entries: [] }] }

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

/** One client-shaped list row: `id`/`parentId`, never `sessionId`. */
function row(id, cwd, parentId, overrides = {}) {
  return { id, displayTitle: id, cwd, ...(parentId === undefined ? {} : { parentId }), blank: false, running: false, updatedAt: 1, ...overrides }
}

const rows = {
  [ROOT]: row(ROOT, PIN),
  [CHILD]: row(CHILD, PIN, ROOT),
  [GRANDCHILD]: row(GRANDCHILD, PIN, CHILD),
  [CHILDLESS]: row(CHILDLESS, undefined, ROOT),
  [FOREIGN]: row(FOREIGN, '/ws/other'),
  [FOREIGN_CHILD]: row(FOREIGN_CHILD, undefined, FOREIGN),
  [TWIN_A]: row(TWIN_A, PIN, undefined, { title: 'twin' }),
  [TWIN_B]: row(TWIN_B, PIN, undefined, { title: 'twin' }),
}

const sessionsList = snapshot({ phase: 'ready', ids: Object.keys(rows), current: undefined, byId: rows })
const workspacesList = snapshot({
  phase: 'ready',
  items: [
    { workspaceId: PIN_WS, path: PIN, sessionIds: [ROOT] },
    { workspaceId: FOREIGN_WS, path: '/ws/other', sessionIds: [FOREIGN] },
  ],
})

const sessions = {
  list: sessionsList,
  /** Agent-scope face read by the reference-insert path; this mount has none. */
  scope() { return undefined },
  open(id) { calls.push(['open', id]) },
  openSubagent(address) { calls.push(['openSubagent', address.childSessionId]) },
  async create(options = {}) { calls.push(['create', options]); return 'session-created' },
  async fork(options) { calls.push(['fork', options.sessionId]); return 'session-child' },
  binding(id) {
    return { sessionId: id, session: { async rename(title) { return { ok: true, value: { title, seq: 0 } } } } }
  },
  clear() { calls.push(['clear']) },
}

let connectDelay
const uiWorkspace = {
  async connectWorkspace(workspaceId) {
    calls.push(['connectWorkspace', workspaceId])
    // Reality: the app reuses/creates a blank session in that workspace and
    // opens it, which moves `current` back inside the pinned folder.
    sessionsList.set({ ...sessionsList.getSnapshot(), current: ROOT })
    if (connectDelay) await connectDelay
    return ROOT
  },
  async archiveSession(sessionId) { calls.push(['archiveSession', sessionId]) },
}

// The real `remote` face is a traceable proxy: reading an undeclared namespace
// through it throws, which is what broke the shipped 0.3.8 bundle at load.
const remote = new Proxy({}, {
  get(_target, property) { throw new Error(`cannot get property "remote.${String(property)}" without inject`) },
})

const services = {
  sessions,
  workspaces: { list: workspacesList },
  uiWorkspace,
  conversation: {},
  theme: {},
  sidebarRight: { openResource(address) { calls.push(['openResource', address]) } },
  remote,
  'remote.session': { async openWorkspacePath(request) { calls.push(['openWorkspacePath', request.path]); return { ok: true, value: { opened: true } } } },
}
const ctx = {
  get: (name) => services[name],
  on: () => () => {},
  effect(effect) { return effect() },
  inject(_dependencies, callback) { return callback(ctx) },
}

new Function(readFileSync(join(__dirname, '..', 'dist', 'bridge.js'), 'utf8'))()
const pluginRow = loadedRows.find(entry => entry.id === '@dsh/vscode-embed-bridge')
assert.ok(pluginRow, 'the bridge registered its plugin row')
// The app's loader calls the factory; the plugin's effects (pin gate, list
// publishers, scope guard) start from `apply`.
pluginRow.factory(require).apply(ctx)

const settle = () => new Promise((resolve) => { setImmediate(resolve) })
const setCurrent = (id) => { sessionsList.set({ ...sessionsList.getSnapshot(), current: id }) }
const reset = () => { calls.length = 0; posted.length = 0 }
const touchedPin = () => calls.some(([kind]) => kind === 'connectWorkspace' || kind === 'create')

test('a pinned root keeps the pin satisfied', async () => {
  reset()
  setCurrent(ROOT)
  await settle()
  assert.equal(touchedPin(), false, JSON.stringify(calls))
})

test('a subagent child keeps the pin satisfied', async () => {
  reset()
  setCurrent(CHILD)
  await settle()
  assert.equal(touchedPin(), false, JSON.stringify(calls))
})

test('a grandchild keeps the pin satisfied', async () => {
  reset()
  setCurrent(GRANDCHILD)
  await settle()
  assert.equal(touchedPin(), false, JSON.stringify(calls))
})

test('a child whose row carries no cwd resolves through its lineage', async () => {
  reset()
  setCurrent(CHILDLESS)
  await settle()
  assert.equal(touchedPin(), false, JSON.stringify(calls))
})

test('a foreign root still re-pins the pinned workspace', async () => {
  reset()
  setCurrent(FOREIGN)
  await settle()
  assert.deepEqual(calls.filter(([kind]) => kind === 'connectWorkspace'), [['connectWorkspace', PIN_WS]])
})

test('the scope guard lets a cwd-less child through and still refuses a foreign root', async () => {
  reset()
  sessions.open(CHILDLESS)
  assert.deepEqual(calls, [['open', CHILDLESS]], JSON.stringify({ calls, posted }))
  reset()
  sessions.open(FOREIGN)
  assert.equal(calls.some(([kind]) => kind === 'open'), false, JSON.stringify(calls))
  assert.equal(posted.some(message => message.type === 'scope-blocked' && message.sessionId === FOREIGN), true, JSON.stringify(posted))
})

test('row facts keep row identity, so membership changes still repaint', async () => {
  const workspace = workspacesList.getSnapshot()
  workspacesList.set({ ...workspace, items: [{ ...workspace.items[0], sessionIds: [TWIN_A] }, workspace.items[1]] })
  await new Promise((resolve) => { setTimeout(resolve, 250) })
  reset()
  workspacesList.set({ ...workspace, items: [{ ...workspace.items[0], sessionIds: [TWIN_B] }, workspace.items[1]] })
  await new Promise((resolve) => { setTimeout(resolve, 250) })
  assert.equal(posted.some(message => message.type === 'sessions-dirty'), true, JSON.stringify(posted))
  workspacesList.set(workspace)
})


test('session clicks wait for catalog readiness and keep only the last selection', async () => {
  reset()
  sessionsList.set({ ...sessionsList.getSnapshot(), phase: 'loading', current: ROOT })
  for (const sessionId of [ROOT, CHILD, GRANDCHILD]) {
    for (const listener of messageListeners) listener({ data: { source: 'dsh-vscode-host', type: 'open-session', sessionId } })
  }
  assert.equal(calls.filter(([kind]) => kind === 'open').length, 0)
  sessionsList.set({ ...sessionsList.getSnapshot(), phase: 'ready' })
  await settle()
  assert.deepEqual(calls.filter(([kind]) => kind === 'open'), [['open', GRANDCHILD]])
  assert.equal(posted.filter(m => m.type === 'open-session-received').length, 1)
})

test('a workspace row arriving before its session catalog entry waits instead of failing scope checks', async () => {
  reset()
  const id = 'session-new-after-reconnect'
  for (const listener of messageListeners) listener({ data: { source: 'dsh-vscode-host', type: 'open-session', sessionId: id } })
  assert.equal(calls.filter(([kind]) => kind === 'open').length, 0)
  assert.equal(posted.filter(m => m.type === 'scope-blocked' || m.type === 'open-session-error').length, 0)
  const previous = sessionsList.getSnapshot()
  sessionsList.set({ ...previous, ids: [...previous.ids, id], byId: { ...previous.byId, [id]: row(id, PIN) } })
  await settle()
  assert.deepEqual(calls.filter(([kind]) => kind === 'open'), [['open', id]])
})


test('a restored selection waits for workspace pinning to finish', async () => {
  reset()
  let release
  connectDelay = new Promise(resolve => { release = resolve })
  setCurrent(FOREIGN)
  for (const listener of messageListeners) listener({ data: { source: 'dsh-vscode-host', type: 'open-session', sessionId: CHILD } })
  assert.equal(calls.filter(([kind]) => kind === 'open').length, 0)
  release()
  connectDelay = undefined
  await settle()
  assert.deepEqual(calls.filter(([kind]) => kind === 'open').at(-1), ['open', CHILD])
})
