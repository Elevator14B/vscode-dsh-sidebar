/**
 * Regression: the embed's link context menu.
 *
 * Every external link keeps the internal Simple Browser on a plain left click,
 * but its context menu must offer the desktop browser — the only target that
 * carries the user's own sign-in state — and a copy action. Each choice posts
 * the message the extension host acts on (`open-url` with a target,
 * `copy-text`), so the vocabulary is pinned here rather than only in the web
 * page.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const PIN = '/ws/pinned'
const EXTERNAL = 'https://example.com/docs?q=1'
const MAIL = 'mailto:x@y.z'

// --- fake page ------------------------------------------------------------

const posted = []

/** Minimal element: enough of the DOM for the bridge's menu construction. */
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

  /** The bridge only ever climbs to `a[href]` or `button[class*="fileLink"]`. */
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
const documentListeners = new Map()
const windowListeners = new Map()

globalThis.__DSH_VSCODE__ = { cwd: PIN, canonicalCwd: PIN, title: 'pinned', theme: 'dark', locale: 'zh-cn' }
globalThis.parent = { postMessage: (message) => { posted.push(message) } }
globalThis.location = { href: 'http://127.0.0.1:1234/', origin: 'http://127.0.0.1:1234' }
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

// --- helpers --------------------------------------------------------------

const menu = () => documentElement.children.find(child => child.getAttribute('data-dsh-link-menu') !== null)
const menuLabels = () => (menu()?.children ?? []).map(child => child.textContent)
const dispatchDocument = (type, event) => {
  // A real dispatch snapshots the listener list, then skips any listener
  // removed while the event was being handled — the bridge relies on both
  // halves when it replaces its own dismiss listeners mid-dispatch.
  for (const entry of [...(documentListeners.get(type) ?? [])]) {
    if (!(documentListeners.get(type) ?? []).includes(entry)) continue
    entry.listener(event)
  }
}
const rightClick = (element, x = 100, y = 100) => {
  dispatchDocument('contextmenu', {
    target: element, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {},
  })
}
const anchor = (href) => {
  const node = new FakeElement('a')
  node.setAttribute('href', href)
  return node
}
const reset = () => { posted.length = 0 }

// --- checks ---------------------------------------------------------------

test('an external link menu offers both browsers plus copy', () => {
  reset()
  rightClick(anchor(EXTERNAL))
  assert.deepEqual(menuLabels(), ['在内部浏览器中打开', '在外部浏览器中打开', '复制链接'])
})

test('the external choice posts open-url with target=external', () => {
  reset()
  rightClick(anchor(EXTERNAL))
  menu().children[1].dispatch('click')
  assert.deepEqual(posted, [{ source: 'dsh-vscode-bridge', type: 'open-url', url: EXTERNAL, target: 'external' }])
  assert.equal(menu(), undefined, 'the menu closes with the choice')
})

test('the internal choice posts open-url with target=internal', () => {
  reset()
  rightClick(anchor(EXTERNAL))
  menu().children[0].dispatch('click')
  assert.deepEqual(posted, [{ source: 'dsh-vscode-bridge', type: 'open-url', url: EXTERNAL, target: 'internal' }])
})

test('the copy choice posts copy-text', () => {
  reset()
  rightClick(anchor(EXTERNAL))
  menu().children[2].dispatch('click')
  assert.deepEqual(posted, [{ source: 'dsh-vscode-bridge', type: 'copy-text', text: EXTERNAL }])
})

test('escape and outside clicks dismiss the menu', () => {
  reset()
  rightClick(anchor(EXTERNAL))
  assert.ok(menu() !== undefined)
  for (const entry of documentListeners.get('keydown') ?? []) entry.listener({ key: 'Escape' })
  assert.equal(menu(), undefined, 'escape closes the menu')
  rightClick(anchor(EXTERNAL))
  assert.ok(menu() !== undefined)
  dispatchDocument('mousedown', { target: new FakeElement('div') })
  assert.equal(menu(), undefined, 'an outside press closes the menu')
})

test('a mail link offers the desktop handler and copy only', () => {
  reset()
  rightClick(anchor(MAIL))
  assert.deepEqual(menuLabels(), ['用外部程序打开', '复制链接'])
  menu().children[0].dispatch('click')
  assert.deepEqual(posted, [{ source: 'dsh-vscode-bridge', type: 'open-url', url: MAIL, target: 'external' }])
})

test('same-origin, fragment, and local paths keep the page menu', () => {
  reset()
  for (const href of ['http://127.0.0.1:1234/', '#section', 'src/a.ts', '/ws/pinned/a.ts', 'file:///tmp/a.md']) {
    rightClick(anchor(href))
    assert.equal(menu(), undefined, `${href} must not open the browser chooser`)
  }
})

test('the openWorkspacePath RPC is intercepted through a URL input', async () => {
  reset()
  const envelope = {
    type: 'client-request',
    rpcId: 'r1',
    method: 'session/openWorkspacePath',
    payload: { args: { request: { path: '/ws/pinned/src/a.ts' } } },
  }
  // The client transport passes `new URL(...)`, not a string: string-only
  // detection missed every call and let the host open the path itself.
  const response = await globalThis.fetch(
    new URL('/api/session/openWorkspacePath', 'http://127.0.0.1:1234/'),
    { method: 'POST', body: JSON.stringify(envelope) },
  )
  assert.deepEqual(posted, [{ source: 'dsh-vscode-bridge', type: 'open-file', path: '/ws/pinned/src/a.ts' }])
  assert.deepEqual(await response.json(), {
    type: 'server-response',
    rpcId: 'r1',
    result: { ok: true, value: { opened: true } },
  })
})

test('a left click keeps the internal default (targetless open-url)', () => {
  reset()
  const clicked = anchor(EXTERNAL)
  for (const entry of documentListeners.get('click') ?? []) {
    entry.listener({ target: clicked, preventDefault() {}, stopPropagation() {} })
  }
  assert.deepEqual(posted, [{ source: 'dsh-vscode-bridge', type: 'open-url', url: EXTERNAL }])
})
