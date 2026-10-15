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
 * Minimal DataTransfer. `types` is what the paste bridge discriminates on: a
 * frame that may read the clipboard reports at least one type, while the
 * embedded frame reports none.
 */
class FakeDataTransfer {
  constructor() { this.entries = new Map() }

  get types() { return [...this.entries.keys()] }

  setData(type, value) { this.entries.set(String(type), String(value)) }

  getData(type) { return this.entries.has(String(type)) ? this.entries.get(String(type)) : '' }
}

/** Minimal ClipboardEvent carrying the clipboardData the bridge supplies. */
class FakeClipboardEvent {
  constructor(type, init = {}) {
    this.type = type
    this.clipboardData = init.clipboardData ?? null
    this.bubbles = Boolean(init.bubbles)
    this.cancelable = Boolean(init.cancelable)
  }
}

/** Let the bridge's own microtask work settle. */
function settle() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** Wait past the paste fallback window, so a pending bridge would have run. */
function pastFallbackWindow() {
  return new Promise(resolve => setTimeout(resolve, 220))
}

/** A paste event as the page would see it. */
function pasteEvent(clipboardData, target) {
  return { type: 'paste', clipboardData, target }
}

/** A paste target that records what the bridge re-delivers to it. */
function pasteTarget() {
  return {
    nodeType: 1,
    delivered: [],
    dispatchEvent(event) { this.delivered.push(event); return true },
  }
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
    DataTransfer: FakeDataTransfer,
    ClipboardEvent: FakeClipboardEvent,
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
    /** Fire a document-level event, as the page itself would. */
    fireDocument(type, event) {
      for (const listener of [...(documentListeners.get(type) ?? [])]) listener(event)
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

// --- paste ----------------------------------------------------------------
// The page owns no clipboard, so a real cmd+V/ctrl+V lands with an empty
// clipboardData and the app's Lexical composer (which inserts from
// clipboardData only) drops it. The bridge asks the host instead and re-delivers
// the text as a paste the page's own editor accepts. A paste the page could
// already read is never touched, which is what keeps this additive.

test('a paste the page cannot read is answered from the host and re-delivered once', async () => {
  const page = loadBridge({ navigator: {} })
  const target = pasteTarget()

  page.fireDocument('paste', pasteEvent(new FakeDataTransfer(), target))

  const request = page.lastRequest('readClipboard')
  assert.equal(request.source, 'dsh-vscode-bridge')
  assert.equal(typeof request.requestId, 'string')
  assert.deepEqual(target.delivered, [], 'nothing is re-delivered before the host answers')

  page.hostMessage({
    source: 'dsh-vscode-host',
    type: 'response',
    requestId: request.requestId,
    value: { ok: true, text: 'pasted from the host' },
  })
  await settle()

  assert.equal(target.delivered.length, 1, 'the paste is re-delivered exactly once')
  const delivered = target.delivered[0]
  assert.equal(delivered.type, 'paste')
  assert.equal(delivered.bubbles, true, 'the paste must reach the editor, not just the target')
  assert.equal(delivered.clipboardData.getData('text/plain'), 'pasted from the host')
})

test('a paste the page could read itself is left untouched', () => {
  const page = loadBridge({ navigator: {} })
  const target = pasteTarget()
  const native = new FakeDataTransfer()
  native.setData('text/plain', 'native paste')

  page.fireDocument('paste', pasteEvent(native, target))

  assert.deepEqual(page.requests('readClipboard'), [], 'a readable paste must not reach the host')
  assert.deepEqual(target.delivered, [], 'a readable paste must not be re-delivered')
})

test('a rich-text paste with no plain text is left untouched too', () => {
  // A copy from a web page carries text/html and may carry no text/plain at
  // all. Bridging that would append a second, plain-text copy of the same
  // content, so a readable text/html has to count as readable data.
  const page = loadBridge({ navigator: {} })
  const target = pasteTarget()
  const rich = new FakeDataTransfer()
  rich.setData('text/html', '<b>rich</b>')

  page.fireDocument('paste', pasteEvent(rich, target))

  assert.deepEqual(page.requests('readClipboard'), [], 'text/html counts as readable clipboard data')
  assert.deepEqual(target.delivered, [])
})

test('a paste that advertises types but withholds every payload is bridged', async () => {
  // A frame can list `types` while every getData() returns ''. Trusting the
  // advertised types would leave the paste to a native path that has nothing to
  // insert, which is the failure this bridge exists to fix.
  const page = loadBridge({ navigator: {} })
  const target = pasteTarget()
  const advertised = { types: ['text/plain'], getData: () => '' }

  page.fireDocument('paste', pasteEvent(advertised, target))
  const request = page.lastRequest('readClipboard')
  page.hostMessage({
    source: 'dsh-vscode-host',
    type: 'response',
    requestId: request.requestId,
    value: { ok: true, text: 'recovered' },
  })
  await settle()

  assert.equal(target.delivered.length, 1, 'an unreadable payload must be bridged')
  assert.equal(target.delivered[0].clipboardData.getData('text/plain'), 'recovered')
})

test('an empty or failed host clipboard re-delivers nothing', async () => {
  for (const value of [{ ok: true, text: '' }, { ok: false, message: 'clipboard unavailable' }, null]) {
    const page = loadBridge({ navigator: {} })
    const target = pasteTarget()

    page.fireDocument('paste', pasteEvent(new FakeDataTransfer(), target))
    const request = page.lastRequest('readClipboard')
    page.hostMessage({ source: 'dsh-vscode-host', type: 'response', requestId: request.requestId, value })
    await settle()

    assert.deepEqual(target.delivered, [], 'nothing to paste must deliver nothing: ' + JSON.stringify(value))
  }
})

test('a paste event with no clipboardData at all is bridged', async () => {
  const page = loadBridge({ navigator: {} })
  const target = pasteTarget()

  page.fireDocument('paste', pasteEvent(undefined, target))
  const request = page.lastRequest('readClipboard')
  page.hostMessage({
    source: 'dsh-vscode-host',
    type: 'response',
    requestId: request.requestId,
    value: { ok: true, text: 'still pasted' },
  })
  await settle()

  assert.equal(target.delivered.length, 1)
  assert.equal(target.delivered[0].clipboardData.getData('text/plain'), 'still pasted')
})

test('a page without DataTransfer or ClipboardEvent loads cleanly and pastes nothing', async () => {
  const page = loadBridge({ navigator: {} })
  const target = pasteTarget()
  delete page.sandbox.DataTransfer
  delete page.sandbox.ClipboardEvent

  page.fireDocument('paste', pasteEvent(undefined, target))
  const request = page.lastRequest('readClipboard')
  page.hostMessage({
    source: 'dsh-vscode-host',
    type: 'response',
    requestId: request.requestId,
    value: { ok: true, text: 'cannot be delivered' },
  })
  await settle()

  assert.deepEqual(target.delivered, [], 'a missing constructor must not throw or deliver')
})

// --- paste shortcut fallback ----------------------------------------------
// A host webview can deliver the shortcut's key without delivering the
// browser's own paste. The key path must cover that, and must never add a
// second copy when a real paste does arrive.

/** One paste shortcut keydown, as the page would see it. */
function pasteKeydown(target) {
  return { key: 'v', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, target }
}

test('a paste shortcut with no paste event falls back to the host clipboard', async () => {
  const page = loadBridge({ navigator: {} })
  const target = pasteTarget()

  page.fireDocument('keydown', pasteKeydown(target))
  assert.deepEqual(page.requests('readClipboard'), [], 'the fallback must wait for the paste that may follow')

  await pastFallbackWindow()
  const request = page.lastRequest('readClipboard')
  page.hostMessage({
    source: 'dsh-vscode-host',
    type: 'response',
    requestId: request.requestId,
    value: { ok: true, text: 'from the key' },
  })
  await settle()

  assert.equal(target.delivered.length, 1)
  assert.equal(target.delivered[0].clipboardData.getData('text/plain'), 'from the key')
})

test('a real paste cancels the key fallback, so nothing is inserted twice', async () => {
  const page = loadBridge({ navigator: {} })
  const target = pasteTarget()

  page.fireDocument('keydown', pasteKeydown(target))
  const native = new FakeDataTransfer()
  native.setData('text/plain', 'native paste')
  page.fireDocument('paste', pasteEvent(native, target))

  await pastFallbackWindow()
  assert.deepEqual(page.requests('readClipboard'), [], 'the fallback must stand down after a real paste')
  assert.deepEqual(target.delivered, [], 'the native paste is left completely alone')
})

test('another accelerator is not treated as the paste shortcut', async () => {
  const page = loadBridge({ navigator: {} })
  const target = pasteTarget()

  page.fireDocument('keydown', { key: 'c', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, target })
  await pastFallbackWindow()

  assert.deepEqual(page.requests('readClipboard'), [])
  assert.deepEqual(target.delivered, [])
})

/** Deliver the fallback's answer for the pending timer and settle it. */
async function settleFallback(page, target, text) {
  page.fireDocument('keydown', pasteKeydown(target))
  await pastFallbackWindow()
  const request = page.lastRequest('readClipboard')
  page.hostMessage({
    source: 'dsh-vscode-host',
    type: 'response',
    requestId: request.requestId,
    value: { ok: true, text },
  })
  await settle()
}

test('the host\'s own late paste is swallowed instead of inserting the text twice', async () => {
  // This host delivers the shortcut's paste after the fallback already inserted
  // from the same clipboard, so the real event must not insert a second copy.
  const page = loadBridge({ navigator: {} })
  const target = pasteTarget()
  await settleFallback(page, target, 'pasted once')
  assert.equal(target.delivered.length, 1)

  const late = new FakeDataTransfer()
  late.setData('text/plain', 'pasted once')
  const lateEvent = pasteEvent(late, target)
  let prevented = false
  let stopped = false
  lateEvent.preventDefault = () => { prevented = true }
  lateEvent.stopPropagation = () => { stopped = true }

  page.fireDocument('paste', lateEvent)
  await settle()

  assert.equal(prevented, true, 'the late duplicate must be cancelled')
  assert.equal(stopped, true, 'the late duplicate must not reach the editor')
  assert.equal(target.delivered.length, 1, 'nothing may be inserted a second time')
})

test('the bridge\'s own re-delivery is never mistaken for that duplicate', async () => {
  // Pressing the shortcut twice on the same clipboard re-delivers the same text.
  // If the bridge swallowed its own re-delivery the way it swallows the host's
  // late paste, the second press would reach the editor as nothing at all.
  const page = loadBridge({ navigator: {} })
  const target = pasteTarget()
  await settleFallback(page, target, 'pasted twice')

  const bridged = new FakeDataTransfer()
  bridged.setData('text/plain', 'pasted twice')
  const event = pasteEvent(bridged, target)
  event.__dshBridgedPaste = true
  let prevented = false
  let stopped = false
  event.preventDefault = () => { prevented = true }
  event.stopPropagation = () => { stopped = true }

  page.fireDocument('paste', event)

  assert.equal(prevented, false, 'the bridge must not cancel its own re-delivery')
  assert.equal(stopped, false, 'the editor has to receive it')
})

test('a later paste of different text is not mistaken for the duplicate', async () => {
  const page = loadBridge({ navigator: {} })
  const target = pasteTarget()
  await settleFallback(page, target, 'first text')

  const second = new FakeDataTransfer()
  second.setData('text/plain', 'second text')
  const event = pasteEvent(second, target)
  let prevented = false
  event.preventDefault = () => { prevented = true }
  event.stopPropagation = () => {}

  page.fireDocument('paste', event)
  await settle()

  assert.equal(prevented, false, 'a different paste belongs to the native path')
  assert.equal(target.delivered.length, 1, 'the bridge adds nothing to a readable paste')
})

// --- copy and cut shortcuts -----------------------------------------------
// The page's own copy helpers write through the host, but the user's shortcuts
// never reach them: the embed performs no clipboard default action of its own,
// so every selection is written from here -- the composer's draft and the
// transcript's output alike.

/** Load the bridge with focus in a composer-like field holding one selection. */
function composerWith(text) {
  const page = loadBridge({ navigator: {} })
  page.sandbox.document.activeElement = { tagName: 'DIV', isContentEditable: true }
  page.select(text)
  return page
}

/** The text of the last copy-text message, or null when none was posted. */
function copiedText(page) {
  const copies = page.posted.filter(message => message.type === 'copy-text')
  return copies.length === 0 ? null : copies[copies.length - 1].text
}

/** Fire one modifier+letter keydown; returns whether the bridge claimed it. */
function pressAccelerator(page, letter, options = {}) {
  const ctrl = options.ctrl === true
  const event = {
    key: letter,
    metaKey: !ctrl,
    ctrlKey: ctrl,
    altKey: options.alt === true,
    shiftKey: options.shift === true,
  }
  let prevented = false
  event.preventDefault = () => { prevented = true }
  page.fireDocument('keydown', event)
  return prevented
}

test('cmd+C in the composer writes the selection through the host', () => {
  const page = composerWith('selected composer text')

  assert.equal(pressAccelerator(page, 'c'), false, 'copy leaves the embed\'s own copy alone')
  assert.equal(copiedText(page), 'selected composer text')
  assert.deepEqual(page.execCommands, [], 'copy must not delete anything')
})

test('cmd+X writes the selection and falls back to the editing command', () => {
  // The composer's own cut verb is not reachable from this harness (it needs a
  // live session input), so this pins the fallback a plain field takes. The real
  // composer path is covered by the browser contract smoke.
  const page = composerWith('cut this')

  assert.equal(pressAccelerator(page, 'x'), true, 'the key is claimed so the embed cannot delete twice')
  assert.equal(copiedText(page), 'cut this', 'cut must put the selection on the clipboard')
  assert.deepEqual(page.execCommands, ['delete'], 'a plain field is emptied by its own editing command')
})

test('ctrl+C is treated the same as cmd+C', () => {
  const page = composerWith('linux selection')

  pressAccelerator(page, 'c', { ctrl: true })

  assert.equal(copiedText(page), 'linux selection')
})

test('an empty selection copies nothing', () => {
  const page = composerWith('')

  pressAccelerator(page, 'c')

  assert.equal(copiedText(page), null)
})

test('a selection in the transcript is copied too', () => {
  // The embed copies no selection on its own, so the output area needs the same
  // host write the composer gets.
  const page = loadBridge({ navigator: {} })
  page.sandbox.document.activeElement = { tagName: 'BODY' }
  page.select('transcript output text')

  pressAccelerator(page, 'c')

  assert.equal(copiedText(page), 'transcript output text')
})

test('a cut in the transcript copies but removes nothing', () => {
  // The transcript is read-only: there is no draft to splice.
  const page = loadBridge({ navigator: {} })
  page.sandbox.document.activeElement = { tagName: 'BODY' }
  page.select('read only output')

  assert.equal(pressAccelerator(page, 'x'), false, 'nothing is claimed when there is nothing to remove')
  assert.equal(copiedText(page), 'read only output')
  assert.deepEqual(page.execCommands, [], 'no editing command may touch a read-only area')
})

test('another shortcut is not a clipboard shortcut', () => {
  const page = composerWith('some selection')

  pressAccelerator(page, 'b')
  pressAccelerator(page, 'c', { alt: true })

  assert.equal(copiedText(page), null)
})
