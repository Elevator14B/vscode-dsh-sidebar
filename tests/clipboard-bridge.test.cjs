/**
 * Regression: clipboard bridging in the embedded page.
 *
 * Frozen contract (task-14/15): the app frame has no clipboard permission of
 * its own, so the extension host is the writer that actually reaches the user's
 * clipboard. dist/bridge.js patches navigator.clipboard.writeText into a
 * 'writeClipboard' host request (resolving on { ok:true }, falling back to the
 * page's native writer on { ok:false } or when no host answer arrives) and
 * routes document.execCommand('copy') through a 'copy-text' message without
 * changing the original command's result.
 *
 * Each test loads dist/bridge.js in its own vm context so the patch (applied
 * once, at load, from the navigator the page had at that moment) can be probed
 * with and without a clipboard.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

const BRIDGE = readFileSync(join(__dirname, '..', 'dist', 'bridge.js'), 'utf8')

/** Minimal element: enough of the DOM for the bridge's overlay construction. */
class FakeElement {
  constructor(tag) {
    this.tag = tag
    this.children = []
    this.parent = null
    this.attrs = {}
    this.style = { cssText: '' }
    this.textContent = ''
    this.className = ''
    this.innerHTML = ''
    this.offsetWidth = 200
    this.offsetHeight = 100
  }

  setAttribute(name, value) { this.attrs[name] = String(value) }
  getAttribute(name) { return this.attrs[name] === undefined ? null : this.attrs[name] }
  appendChild(child) { child.parent = this; this.children.push(child); return child }
  remove() {}
  addEventListener() {}
  removeEventListener() {}
  toggleAttribute() { return false }
}

/**
 * Load dist/bridge.js in a fresh vm context with a fake page.
 * @param options.navigator - navigator exposed to the page (clipboard or not).
 * @param options.execCommand - original document.execCommand result factory.
 */
function loadBridge(options = {}) {
  const posted = []
  const windowListeners = new Map()
  const execCommands = []
  const selection = { text: '' }
  const documentElement = new FakeElement('html')
  const originalExecCommand = options.execCommand ?? ((command) => 'original:' + String(command))
  const documentListeners = new Map()

  const document = {
    addEventListener(type, listener) {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener])
    },
    removeEventListener() {},
    createElement: (tag) => new FakeElement(tag),
    getElementById: () => null,
    getSelection: () => ({ toString: () => selection.text }),
    documentElement,
    head: new FakeElement('head'),
    body: { toggleAttribute() {}, innerText: '', style: {} },
    activeElement: null,
    execCommand(command) {
      execCommands.push(String(command))
      return originalExecCommand(String(command))
    },
  }

  const sandbox = {
    console,
    __DSH_VSCODE__: { cwd: '/ws/pinned', canonicalCwd: '/ws/pinned', title: 'pinned', theme: 'dark' },
    parent: { postMessage: (message) => { posted.push(message) } },
    location: { href: 'http://127.0.0.1:1234/', origin: 'http://127.0.0.1:1234' },
    navigator: options.navigator ?? {},
    document,
    window: {
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener(type, listener) {
        windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener])
      },
      removeEventListener() {},
    },
    __ModuleLoader__: { load() {} },
    __DSH_BOOT__: { entries: [], batches: [{ phase: 'application', entries: [] }] },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
  }
  vm.createContext(sandbox)
  vm.runInContext(BRIDGE, sandbox)

  return {
    sandbox,
    posted,
    execCommands,
    select(text) { selection.text = text },
    requests: (requestType) =>
      posted.filter(message => message.type === 'request' && message.requestType === requestType),
    lastRequest(requestType) {
      const found = posted.filter(message => message.type === 'request' && message.requestType === requestType)
      assert.ok(found.length > 0, 'no ' + requestType + ' request was posted: ' + JSON.stringify(posted.map(m => m.type)))
      return found[found.length - 1]
    },
    hostMessage(data) {
      for (const listener of [...(windowListeners.get('message') ?? [])]) listener({ data })
    },
  }
}

// --- navigator.clipboard.writeText ----------------------------------------

test('writeText is answered by the host and resolves on ok:true', async () => {
  const nativeCalls = []
  const page = loadBridge({
    navigator: { clipboard: { writeText: async (text) => { nativeCalls.push(text) } } },
  })
  const pending = page.sandbox.navigator.clipboard.writeText('copy this code')

  const request = page.lastRequest('writeClipboard')
  assert.equal(request.payload.text, 'copy this code')
  assert.equal(request.source, 'dsh-vscode-bridge')
  assert.equal(typeof request.requestId, 'string')

  page.hostMessage({ source: 'dsh-vscode-host', type: 'response', requestId: request.requestId, value: { ok: true } })
  assert.equal(await pending, true)
  assert.deepEqual(nativeCalls, [], 'a successful host write must not touch the native writer')
})

test('an unanswered write falls back to the native writer and surfaces its rejection', async () => {
  const unhandled = []
  const onUnhandled = (reason) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const nativeCalls = []
    const page = loadBridge({
      navigator: {
        clipboard: {
          writeText: (text) => {
            nativeCalls.push(text)
            return Promise.reject(new Error('clipboard permission denied'))
          },
        },
      },
    })
    const pending = page.sandbox.navigator.clipboard.writeText('never answered')

    // The bridge asks the host first and leaves the native writer alone.
    const request = page.lastRequest('writeClipboard')
    assert.equal(request.payload.text, 'never answered')
    assert.deepEqual(nativeCalls, [], 'the native writer must not run while the host request is pending')

    // The host never answers; after the bridge's bounded wait the native writer
    // takes over and its own rejection is what the caller sees.
    await assert.rejects(pending, /clipboard permission denied/)
    assert.deepEqual(nativeCalls, ['never answered'])
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(unhandled, [], 'the fallback must not leak an unhandled rejection')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('a host answer of ok:false falls back to the native writer', async () => {
  const nativeCalls = []
  const page = loadBridge({
    navigator: { clipboard: { writeText: (text) => { nativeCalls.push(text); return Promise.resolve('native-result') } } },
  })
  const pending = page.sandbox.navigator.clipboard.writeText('fallback text')
  const request = page.lastRequest('writeClipboard')
  assert.deepEqual(nativeCalls, [], 'the native writer must wait for the host answer')
  page.hostMessage({
    source: 'dsh-vscode-host',
    type: 'response',
    requestId: request.requestId,
    value: { ok: false, message: 'host clipboard unavailable' },
  })
  assert.equal(await pending, 'native-result')
  assert.deepEqual(nativeCalls, ['fallback text'])
})

// --- document.execCommand('copy') -----------------------------------------

test('execCommand copy posts copy-text and returns the original result', () => {
  const page = loadBridge({ navigator: {} })
  page.select('selected code block')

  assert.equal(page.sandbox.document.execCommand('copy'), 'original:copy')
  const copies = page.posted.filter(message => message.type === 'copy-text')
  assert.equal(copies.length, 1)
  assert.equal(copies[0].text, 'selected code block')
  assert.equal(copies[0].source, 'dsh-vscode-bridge')

  assert.equal(page.sandbox.document.execCommand('paste'), 'original:paste')
  assert.equal(page.posted.filter(message => message.type === 'copy-text').length, 1, 'other commands stay untouched')

  page.select('')
  assert.equal(page.sandbox.document.execCommand('copy'), 'original:copy')
  assert.equal(
    page.posted.filter(message => message.type === 'copy-text').length,
    1,
    'an empty selection posts nothing (a host write would clear the clipboard)',
  )
  assert.deepEqual(page.execCommands, ['copy', 'paste', 'copy'])
})

test('a missing clipboard or writeText loads cleanly and keeps the execCommand fallback', () => {
  const noClipboard = loadBridge({ navigator: { platform: 'linux' } })
  assert.equal(noClipboard.sandbox.__DSH_VSCODE_BRIDGE_INSTALLED__, true)
  assert.equal(noClipboard.sandbox.navigator.clipboard, undefined, 'the bridge must not invent a clipboard')

  const noWriteText = loadBridge({ navigator: { clipboard: {} } })
  assert.equal(noWriteText.sandbox.__DSH_VSCODE_BRIDGE_INSTALLED__, true)
  assert.equal(noWriteText.sandbox.navigator.clipboard.writeText, undefined, 'the bridge must not invent a writer')

  for (const page of [noClipboard, noWriteText]) {
    page.select('fallback textarea text')
    assert.equal(page.sandbox.document.execCommand('copy'), 'original:copy')
    const copies = page.posted.filter(message => message.type === 'copy-text')
    assert.equal(copies.length, 1, 'the legacy copy path still reaches the host')
    assert.equal(copies[0].text, 'fallback textarea text')
  }
})
