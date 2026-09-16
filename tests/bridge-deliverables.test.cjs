/**
 * Regression: delivered-file cards open inside VS Code.
 *
 * The DSH web GUI renders every explicitly delivered file as a card whose three
 * open gestures — the whole-card preview button, the visible 打开 button, and
 * the chevron menu — all end in the *serving host's* own desktop opener. On a
 * headless remote host there is no desktop at all: the app renders the chevron
 * disabled, prints 此主机没有可用的桌面… inside the card, and disables the
 * whole feature. The embed answers those gestures with host messages instead
 * (`open-file`, `open-file` with `column:'beside'`, `reveal-file`), keeps the
 * chevron live across re-renders, and hides the host-desktop rows, because in a
 * VS Code webview the editor is the only opener that exists.
 *
 * The `workspace-state` publish carries the archive set as well, since an
 * archived session leaves the native Sessions tree without reordering the rest.
 *
 * These tests drive real clicks into the loaded script against a hand-rolled
 * fake page, like bridge-links.test.cjs and bridge-pin.test.cjs. They read
 * src/bridge.js — the source, which needs no build step — where those older
 * files drive the copy esbuild leaves in dist/bridge.js.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const BRIDGE = readFileSync(join(__dirname, '..', 'src', 'bridge.js'), 'utf8')

const PIN = '/ws/pinned'
const PIN_WS = 'ws-pinned'
const ROOT = 'session-root'
const CARD_PATH = PIN + '/out/report.md'
const CARD_RELATIVE = 'out/report.md'
const ARCHIVED_OLD = 'session-archived-old'
const ARCHIVED_NEW = 'session-archived-new'
const STYLE_ID = 'dsh-vscode-bridge-style'

// --- fake DOM -------------------------------------------------------------

/**
 * The selectors the bridge reads, and nothing else: an unmodelled selector is
 * a test failure rather than a silent non-match, so the fake cannot drift away
 * from the markup the bridge actually queries.
 */
function matchesSelector(node, selector) {
  if (selector === '[data-presented-file]') return node.hasAttribute('data-presented-file')
  if (selector === 'a[href]') return node.tag === 'a' && node.hasAttribute('href')
  // A tool card's produced-files row, which this page never renders.
  if (selector === '[data-produced-files-row] button') return false
  const attribute = /^(button)?\[class\*="([^"]+)"\]$/.exec(selector)
  if (attribute !== null) {
    if (attribute[1] === 'button' && node.tag !== 'button') return false
    return String(node.getAttribute('class') || '').includes(attribute[2])
  }
  if (/^[a-z]+$/.test(selector)) return node.tag === selector
  throw new Error('unmodelled selector: ' + selector)
}

/** Minimal element: enough of the DOM for the bridge's card and menu code. */
class FakeElement {
  constructor(tag) {
    this.tag = tag
    this.children = []
    this.parent = null
    this.attrs = {}
    this.listeners = new Map()
    this.textContent = ''
    this.type = ''
    this.disabled = false
    this.style = { cssText: '', left: '', top: '', background: '' }
    this.offsetWidth = 200
    this.offsetHeight = 100
  }

  setAttribute(name, value) { this.attrs[name] = String(value) }
  getAttribute(name) { return this.attrs[name] === undefined ? null : this.attrs[name] }
  hasAttribute(name) { return this.attrs[name] !== undefined }
  removeAttribute(name) { delete this.attrs[name] }
  toggleAttribute(name, force) {
    const next = force === undefined ? this.attrs[name] === undefined : Boolean(force)
    if (next) this.attrs[name] = ''
    else delete this.attrs[name]
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child }
  remove() {
    if (this.parent !== null) this.parent.children = this.parent.children.filter(child => child !== this)
    this.parent = null
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(entry => entry !== listener))
  }
  dispatch(type, event = {}) {
    // A browser sends no click to a disabled button: that is exactly why the
    // bridge has to re-enable the chevron before its own menu can be reached.
    if (type === 'click' && this.disabled) return false
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ preventDefault() {}, stopPropagation() {}, ...event })
    }
    return true
  }

  contains(node) {
    return node === this || this.children.some(child => child.contains(node))
  }
  closest(selector) {
    let node = this
    while (node !== null) {
      if (matchesSelector(node, selector)) return node
      node = node.parent
    }
    return null
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  querySelectorAll(selector) {
    const found = []
    const walk = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }
  getBoundingClientRect() {
    return { left: 300, top: 40, right: 324, bottom: 64, width: 24, height: 24 }
  }
}

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

/**
 * One fake page: the DOM the bridge is injected into, the boot graph it
 * registers its Cordis plugin in, and every message it posted. `addCard`
 * renders a delivered-file card the way the app does on a desktop-less host.
 */
function createPage(options = {}) {
  const posted = []
  const documentListeners = new Map()
  const windowListeners = new Map()
  const observers = []
  const loadedRows = []

  const documentElement = new FakeElement('html')
  const head = new FakeElement('head')
  const body = new FakeElement('body')
  const chat = new FakeElement('div')
  documentElement.appendChild(head)
  documentElement.appendChild(body)
  body.appendChild(chat)

  const document = {
    addEventListener(type, listener, capture) {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), { listener, capture: capture === true }])
    },
    removeEventListener(type, listener) {
      documentListeners.set(type, (documentListeners.get(type) ?? []).filter(entry => entry.listener !== listener))
    },
    createElement(tag) { return new FakeElement(tag) },
    getElementById(id) {
      let found = null
      const walk = (node) => {
        for (const child of node.children) {
          if (found === null && child.getAttribute('id') === id) found = child
          walk(child)
        }
      }
      walk(documentElement)
      return found
    },
    getSelection: () => ({ toString: () => '' }),
    execCommand: () => true,
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    documentElement,
    head,
    body,
  }

  const window = {
    innerWidth: 1200,
    innerHeight: 800,
    getSelection: () => ({ toString: () => '' }),
    addEventListener(type, listener) {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener])
    },
    removeEventListener(type, listener) {
      windowListeners.set(type, (windowListeners.get(type) ?? []).filter(entry => entry !== listener))
    },
  }

  /** MutationObserver stand-in: records itself, fires only when told to. */
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback
      this.target = null
      this.options = null
      observers.push(this)
    }
    observe(target, options) { this.target = target; this.options = options }
    disconnect() { this.target = null }
    takeRecords() { return [] }
  }

  const sandbox = {
    console,
    __DSH_VSCODE__: {
      cwd: PIN,
      canonicalCwd: PIN,
      title: 'pinned',
      theme: 'dark',
      locale: options.locale ?? 'zh-cn',
    },
    parent: { postMessage: (message) => { posted.push(message) } },
    location: { href: 'http://127.0.0.1:1234/', origin: 'http://127.0.0.1:1234' },
    document,
    window,
    MutationObserver: FakeMutationObserver,
    __ModuleLoader__: { load: (row) => { loadedRows.push(row) } },
    __DSH_BOOT__: { entries: [], batches: [{ phase: 'application', entries: [] }] },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
  }

  // --- workspace state the bridge publishes --------------------------------

  const sessionsList = snapshot({
    phase: 'ready',
    ids: [ROOT],
    current: ROOT,
    byId: { [ROOT]: { id: ROOT, displayTitle: ROOT, cwd: PIN, blank: false, running: false, updatedAt: 1 } },
  })
  const workspacesList = snapshot({
    phase: 'ready',
    items: [{ workspaceId: PIN_WS, path: PIN, sessionIds: [ROOT] }],
    archivedSessionIds: [ARCHIVED_OLD],
  })

  const services = {
    sessions: {
      list: sessionsList,
      scope: () => undefined,
      open() {},
      openSubagent() {},
      async create() { return 'session-created' },
      async fork() { return 'session-forked' },
      binding(id) { return { session: { async rename() { return { ok: true, value: {} } } } } },
      clear() {},
    },
    workspaces: { list: workspacesList },
    uiWorkspace: { async connectWorkspace() { return ROOT }, async archiveSession() {} },
    conversation: {},
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

  // --- helpers --------------------------------------------------------------

  /**
   * One card as the app renders it: a `[data-presented-file]` container, the
   * whole-card preview button whose tooltip holds the path, the visible 打开
   * button, and the chevron the host-desktop metadata disables.
   */
  function addCard(title, text) {
    const card = new FakeElement('div')
    card.setAttribute('data-presented-file', '')
    card.setAttribute('class', '_card_1a2b3_7')
    const preview = new FakeElement('button')
    preview.setAttribute('class', '_cardPreview_1a2b3_9')
    if (title !== null && title !== undefined) preview.setAttribute('title', title)
    preview.textContent = text === undefined ? '' : text
    const open = new FakeElement('button')
    open.setAttribute('class', '_open_1a2b3_11')
    open.textContent = '打开'
    const chevron = new FakeElement('button')
    chevron.setAttribute('class', '_chevron_1a2b3_13')
    chevron.setAttribute('aria-haspopup', 'menu')
    // 此主机没有可用的桌面… — the button ships disabled.
    chevron.disabled = true
    chevron.setAttribute('disabled', '')
    card.appendChild(preview)
    card.appendChild(open)
    card.appendChild(chevron)
    chat.appendChild(card)
    return card
  }

  function dispatchTo(type, capture, event) {
    for (const entry of [...(documentListeners.get(type) ?? [])]) {
      if (entry.capture !== capture) continue
      entry.listener(event)
    }
  }

  /**
   * One document-level click. Capture listeners — the bridge's own — run first,
   * and the bubble phase runs only when none of them stopped propagation, which
   * is what keeps the app's React root out of a click the bridge already served.
   * A disabled button produces no click at all, exactly like the browser.
   */
  function clickOn(target, options = {}) {
    const event = {
      target,
      clientX: options.clientX ?? 10,
      clientY: options.clientY ?? 20,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { event.defaultPrevented = true },
      stopPropagation() { event.propagationStopped = true },
    }
    if (target.disabled) return event
    dispatchTo('click', true, event)
    if (!event.propagationStopped) dispatchTo('click', false, event)
    return event
  }

  function pressEscape() {
    for (const entry of [...(documentListeners.get('keydown') ?? [])]) entry.listener({ key: 'Escape' })
  }

  function notifyMutations(records) {
    for (const observer of [...observers]) {
      if (observer.target === null) continue
      observer.callback(records)
    }
  }

  const menu = () => documentElement.children.find(child => child.getAttribute('data-dsh-card-menu') !== null)
  const menuLabels = () => (menu()?.children ?? []).map(child => child.textContent)
  /** Reproduce the bridge's own gesture: click the card's chevron. */
  const openCardMenu = () => {
    const card = chat.querySelectorAll('[data-presented-file]')[0]
    return clickOn(card.querySelector('button[class*="_chevron"]'))
  }

  return {
    sandbox,
    ctx,
    posted,
    documentElement,
    document,
    window,
    chat,
    loadedRows,
    observers,
    workspacesList,
    sessionsList,
    addCard,
    clickOn,
    pressEscape,
    notifyMutations,
    menu,
    menuLabels,
    openCardMenu,
  }
}

/** Install one page's fake DOM as this realm's globals. */
function installOnGlobal(page) {
  globalThis.__DSH_VSCODE__ = page.sandbox.__DSH_VSCODE__
  globalThis.parent = page.sandbox.parent
  globalThis.location = page.sandbox.location
  globalThis.document = page.sandbox.document
  globalThis.window = page.sandbox.window
  globalThis.MutationObserver = page.sandbox.MutationObserver
  globalThis.__ModuleLoader__ = page.sandbox.__ModuleLoader__
  globalThis.__DSH_BOOT__ = page.sandbox.__DSH_BOOT__
  globalThis.requestAnimationFrame = page.sandbox.requestAnimationFrame
  globalThis.cancelAnimationFrame = page.sandbox.cancelAnimationFrame
}

// --- loaded page ----------------------------------------------------------

const page = createPage({ locale: 'zh-cn' })
installOnGlobal(page)
// The card the app had already rendered when the proxy injected the bridge.
const card = page.addCard(CARD_PATH)

new Function(BRIDGE)()

const pluginRow = page.loadedRows.find(entry => entry.id === '@dsh/vscode-embed-bridge')
assert.ok(pluginRow, 'the bridge registered its plugin row')
// The app's loader calls the factory; the plugin's effects (pin gate, scope
// guard, workspace-state publish) start from `apply`.
pluginRow.factory(require).apply(page.ctx)

// The plugin's workspace-state effect publishes the boot snapshot right away.
const bootState = page.posted.find(message => message.type === 'workspace-state')

// The app's own React root: a bubble-phase handler that must never see a click
// the bridge already served.
const appClicks = []
page.document.addEventListener('click', (event) => appClicks.push(event.target))

const preview = card.querySelector('button[class*="_cardPreview"]')
const openButton = card.querySelector('button[class*="_open"]')
const chevron = card.querySelector('button[class*="_chevron"]')

const reset = () => { page.posted.length = 0; appClicks.length = 0 }

// --- checks ---------------------------------------------------------------

test('the whole-card preview button opens the file in the editor', () => {
  reset()
  const event = page.clickOn(preview)
  assert.deepEqual(page.posted, [{ source: 'dsh-vscode-bridge', type: 'open-file', path: CARD_PATH }])
  assert.equal(event.defaultPrevented, true, 'the app must not handle the click too')
  assert.equal(event.propagationStopped, true)
  assert.deepEqual(appClicks, [], 'a capture-phase handler stops the click before the app root sees it')
})

test('the 打开 button opens the same file', () => {
  reset()
  const event = page.clickOn(openButton)
  assert.deepEqual(page.posted, [{ source: 'dsh-vscode-bridge', type: 'open-file', path: CARD_PATH }])
  assert.equal(event.propagationStopped, true)
  assert.deepEqual(appClicks, [])
})

test('a card without a tooltip falls back to the text it shows', () => {
  reset()
  const relative = page.addCard(null, CARD_RELATIVE)
  page.clickOn(relative.querySelector('button[class*="_cardPreview"]'))
  assert.deepEqual(page.posted, [{ source: 'dsh-vscode-bridge', type: 'open-file', path: CARD_RELATIVE }])
})

test('a click outside any card is left to the app', () => {
  reset()
  const plain = new FakeElement('div')
  page.chat.appendChild(plain)
  const event = page.clickOn(plain)
  assert.deepEqual(page.posted, [], 'no card, no message')
  assert.equal(event.defaultPrevented, false)
  assert.deepEqual(appClicks, [plain], 'ordinary clicks still reach the app root')
})

test('the chevron ships disabled and the bridge re-enables it', () => {
  assert.equal(card.getAttribute('data-dsh-vscode-card'), '', 'the card is marked bridge-owned')
  assert.equal(chevron.disabled, false, 'a disabled button would emit no click at all')
  assert.equal(chevron.getAttribute('disabled'), null)
  assert.equal(chevron.getAttribute('aria-disabled'), 'false')
})

test('the card chevron opens a three-item menu of VS Code openers', () => {
  reset()
  const event = page.clickOn(chevron)
  assert.deepEqual(page.posted, [], 'the menu itself posts nothing yet')
  assert.equal(event.propagationStopped, true, "the app's host-desktop menu must never open")
  assert.deepEqual(page.menuLabels(), ['在编辑器中打开', '在右侧打开', '在资源管理器中显示'])
  assert.equal(page.menu().style.top, '64px', 'anchored under the chevron')
  page.pressEscape()
  assert.equal(page.menu(), undefined, 'escape closes it, like the link menu')
})

test('the first choice opens the file in the editor', () => {
  reset()
  page.openCardMenu()
  page.menu().children[0].dispatch('click')
  assert.deepEqual(page.posted, [{ source: 'dsh-vscode-bridge', type: 'open-file', path: CARD_PATH }])
  assert.equal(page.menu(), undefined, 'the menu closes with the choice')
})

test('the second choice opens the file to the side', () => {
  reset()
  page.openCardMenu()
  page.menu().children[1].dispatch('click')
  assert.deepEqual(page.posted, [
    { source: 'dsh-vscode-bridge', type: 'open-file', path: CARD_PATH, column: 'beside' },
  ])
})

test('the third choice reveals the file in the explorer', () => {
  reset()
  page.openCardMenu()
  page.menu().children[2].dispatch('click')
  assert.deepEqual(page.posted, [{ source: 'dsh-vscode-bridge', type: 'reveal-file', path: CARD_PATH }])
})

test('the menu follows the display language the host configured', () => {
  const config = globalThis.__DSH_VSCODE__
  const original = config.locale
  // The bridge reads the language when it builds a menu, so the same page can
  // reach both dictionaries.
  config.locale = 'en'
  try {
    page.openCardMenu()
    assert.deepEqual(page.menuLabels(), ['Open in Editor', 'Open to the Side', 'Reveal in Explorer'])
    page.menu().children[1].dispatch('click')
    assert.deepEqual(page.posted.slice(-1), [
      { source: 'dsh-vscode-bridge', type: 'open-file', path: CARD_PATH, column: 'beside' },
    ])
  } finally {
    config.locale = original
  }
})

test('a re-rendered card gets its chevron re-enabled by the observer', () => {
  reset()
  const observer = page.observers.find(entry => entry.target === page.documentElement)
  assert.ok(observer, 'the observer watches the tree the cards render into')
  assert.equal(observer.options.childList, true)
  assert.equal(observer.options.subtree, true, 'a card anywhere in the page is seen')
  assert.deepEqual(observer.options.attributeFilter, ['disabled'])
  // A card rendered long after boot: React re-applies the disabled attribute.
  const rendered = page.addCard(CARD_PATH)
  const button = rendered.querySelector('button[class*="_chevron"]')
  assert.equal(button.disabled, true, 'the app renders it disabled on a desktop-less host')
  page.clickOn(button)
  assert.deepEqual(page.posted, [], 'a disabled button emits no click, so nothing can open yet')
  page.notifyMutations([{ type: 'childList', target: page.chat, addedNodes: [rendered] }])
  assert.equal(button.disabled, false, 'the observer re-enables the chevron of a fresh render')
  assert.equal(button.getAttribute('aria-disabled'), 'false')
  assert.equal(rendered.getAttribute('data-dsh-vscode-card'), '')
  // React rewrites the attribute on its next render; the observer runs again.
  button.disabled = true
  button.setAttribute('disabled', '')
  page.notifyMutations([{ type: 'attributes', target: button, attributeName: 'disabled' }])
  assert.equal(button.disabled, false)
  page.clickOn(button)
  assert.equal(page.menuLabels().length, 3)
  page.pressEscape()
})

test('one bridge stylesheet hides the host-desktop rows and nothing else', () => {
  const sheets = page.documentElement.querySelectorAll('style')
    .filter(sheet => sheet.getAttribute('id') === STYLE_ID)
  assert.equal(sheets.length, 1, 'exactly one bridge-owned stylesheet')
  assert.equal(page.document.getElementById(STYLE_ID), sheets[0])
  const rules = sheets[0].textContent.split('}').map(rule => rule.trim()).filter(rule => rule !== '')
  assert.ok(rules.length > 0, 'the stylesheet has at least one rule')
  for (const rule of rules) {
    assert.match(rule.split('{')[0], /\[class\*="_hostStatus"\]/, 'only host-status rows: ' + rule)
    assert.match(rule, /display:\s*none/, 'hidden: ' + rule)
  }
})

test('workspace-state carries the archive set from the same snapshot', () => {
  assert.deepEqual(bootState, {
    source: 'dsh-vscode-bridge',
    type: 'workspace-state',
    workspaceId: PIN_WS,
    sessionIds: [ROOT],
    archivedSessionIds: [ARCHIVED_OLD],
  })
})

test('an archive-only change republishes once, with copied arrays', () => {
  reset()
  const before = page.workspacesList.getSnapshot()
  const next = { ...before, archivedSessionIds: [ARCHIVED_NEW] }
  page.workspacesList.set(next)
  const published = page.posted.filter(message => message.type === 'workspace-state')
  assert.deepEqual(published, [{
    source: 'dsh-vscode-bridge',
    type: 'workspace-state',
    workspaceId: PIN_WS,
    sessionIds: [ROOT],
    archivedSessionIds: [ARCHIVED_NEW],
  }])
  assert.notEqual(published[0].sessionIds, before.items[0].sessionIds, 'the order is copied out')
  assert.notEqual(published[0].archivedSessionIds, next.archivedSessionIds, 'the archive set is copied out')
  // The same order and the same archive set: the dedupe key swallows the push.
  page.workspacesList.set({ ...next, archivedSessionIds: [ARCHIVED_NEW] })
  assert.equal(page.posted.filter(message => message.type === 'workspace-state').length, 1)
})
