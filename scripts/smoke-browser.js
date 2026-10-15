/** Browser contracts that HTTP health checks cannot prove. Uses only the smoke workspace. */
'use strict'
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createServer } = require('node:http')
const path = require('node:path')
const { chromium } = require('playwright')

/** Exercise the actual injected bridge and DSH client, inside the shipped recovery shell. */
/** Answer the newest readClipboard request with one text, as the real host does. */
async function answerReadClipboard(page, text, ordinal) {
  await page.waitForFunction(count =>
    __messages.filter(message => message.type === 'request' && message.requestType === 'readClipboard').length >= count,
  ordinal)
  const { requestId } = await page.evaluate(() =>
    __messages.filter(message => message.type === 'request' && message.requestType === 'readClipboard').pop())
  assert.equal(typeof requestId, 'string', 'the bridge must await an answered readClipboard request')
  await page.evaluate(({ requestId, text }) => window.postMessage({ __dshHost: true, source: 'dsh-vscode-host', pageId: 'smoke',
    type: 'response', requestId, value: { ok: true, text } }, '*'), { requestId, text })
}

/**
 * Select one element's contents in the frame, press one accelerator, and return
 * the selection. `blurFirst` reproduces reading the output area, where nothing
 * is focused.
 */
async function selectAndPress(frame, selector, key, blurFirst = false) {
  return frame.evaluate(({ selector, key, blurFirst }) => {
    if (blurFirst) {
      const active = document.activeElement
      if (active && typeof active.blur === 'function') active.blur()
    }
    const element = document.querySelector(selector)
    if (element === null) return null
    element.focus()
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    const text = String(selection.toString())
    element.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true }))
    return text
  }, { selector, key, blurFirst })
}

/** Expect the newest copy-text message to carry exactly this text. */
function waitForCopy(page, text) {
  return page.waitForFunction(expected =>
    __messages.some(message => message.type === 'copy-text' && message.text === expected), text)
}

async function browserProbe(origin, cwd, workspaceId, sessionId) {
  const shell = readFileSync(path.resolve(__dirname, '../dist/recovery-shell.js'), 'utf8')
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:*; connect-src http://127.0.0.1:*; script-src 'nonce-smoke'; style-src 'unsafe-inline'">
<div id="connection-status"><div id="connection-label"></div></div><iframe id="frame" src="${origin}"></iframe>
<script nonce="smoke">
globalThis.__messages = []
globalThis.__DSH_SHELL_CONFIG__ = { pageId: 'smoke', locale: 'en' }
globalThis.acquireVsCodeApi = () => ({ postMessage(message) {
  __messages.push(message)
  if (message.type === 'bridge-loaded') window.postMessage({ __dshHost: true, source: 'dsh-vscode-host', pageId: 'smoke',
    type: 'configure', cwd: ${JSON.stringify(cwd)}, title: 'smoke', theme: 'dark' }, '*')
} });
${shell}</script>`)
  })
  let browser
  let page
  let phase = 'browser launch'
  try {
    await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
    browser = await chromium.launch({ headless: true,
      ...(process.env.DSH_SMOKE_CHROMIUM ? { executablePath: process.env.DSH_SMOKE_CHROMIUM } : {}) })
    page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => { errors.push(error.message) })
    // Keep inspection hooks in the test, out of the shipped bridge. Cordis
    // records activation failures internally instead of emitting pageerror.
    await page.route('**/__dsh_vscode_bridge.js', async route => {
      const response = await route.fetch()
      const source = (await response.text())
        .replace('apply: function (ctx) {', 'apply: function (ctx) { globalThis.__smokeContext = ctx;')
        .replace("var modules = modulesCtx.get('modules')", "var modules = modulesCtx.get('modules'); globalThis.__smokeModules = modules")
      await route.fulfill({ response, body: 'globalThis.__smokeHostGraph = structuredClone(globalThis.__DSH_BOOT__);\n' + source })
    })
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    phase = 'connection and workspace publication'
    await page.waitForFunction(id => __messages.some(m => m.type === 'connection-status' && m.connection === 'connected')
      && __messages.some(m => m.type === 'workspace-state' && m.workspaceId === id), workspaceId)
    const frame = page.frames().find(candidate => candidate.url().startsWith(origin))
    assert.ok(frame, 'the DSH iframe loaded')
    // A repeated full Host snapshot used to silently remove the injected
    // entry. Preserve it while still reconciling ordinary Host plugins.
    phase = 'live graph reconciliation'
    await frame.evaluate(async () => {
      await __smokeModules.entries.sync(__smokeHostGraph)
      await __smokeModules.entries.sync(__smokeHostGraph)
    })
    phase = 'session selection acknowledgement'
    await page.evaluate(id => window.postMessage({ __dshHost: true, source: 'dsh-vscode-host', pageId: 'smoke',
      type: 'open-session', sessionId: id }, '*'), sessionId)
    await page.waitForFunction(id => __messages.some(m => m.type === 'open-session-received' && m.sessionId === id), sessionId)
    phase = 'selected session composer'
    await frame.waitForFunction(id => __DSH_VSCODE_DEBUG__.current === id && __DSH_VSCODE_DEBUG__.lastInputFailure === '', sessionId)
    // A real cmd+V/ctrl+V reaches the embedded frame with no clipboard data of
    // its own, so the composer's paste path inserts nothing. The bridge has to
    // notice that, ask the host, and hand the text back as a paste the page's own
    // editor accepts.
    phase = 'clipboard paste bridging'
    const pasted = 'smoke pasted text 4711'
    const claim = await frame.evaluate(() => {
      const editable = document.querySelector('[contenteditable="true"]')
      if (!editable) return 'no contenteditable composer'
      editable.focus()
      editable.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: new DataTransfer(),
        bubbles: true,
        cancelable: true,
      }))
      return 'dispatched'
    })
    assert.equal(claim, 'dispatched', 'the composer accepted an empty paste: ' + String(claim))
    await answerReadClipboard(page, pasted, 1)
    await frame.waitForFunction(text => document.body.innerText.includes(text), pasted)
    // The shortcut key is what actually fixes paste here: this host delivers its
    // own paste event late -- carrying readable data -- and the composer stays
    // empty anyway, so the key path has to land the text.
    phase = 'clipboard paste from the shortcut key'
    const keyed = 'smoke keyed text 5712'
    await frame.evaluate(() => {
      const editable = document.querySelector('[contenteditable="true"]')
      editable.focus()
      editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', metaKey: true, bubbles: true, cancelable: true }))
    })
    await answerReadClipboard(page, keyed, 2)
    await frame.waitForFunction(text => document.body.innerText.includes(text), keyed)
    // Pressing the shortcut again pastes again -- for the same clipboard content
    // too, and even though the host's own paste for the previous gesture arrives
    // late. That late event must not consume the next gesture.
    phase = 'clipboard paste twice from the same clipboard'
    await frame.evaluate(text => {
      const editable = document.querySelector('[contenteditable="true"]')
      editable.focus()
      const data = new DataTransfer()
      data.setData('text/plain', text)
      editable.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', metaKey: true, bubbles: true, cancelable: true }))
    }, keyed)
    await answerReadClipboard(page, keyed, 3)
    await frame.waitForFunction(text => {
      const editable = document.querySelector('[contenteditable="true"]')
      const content = String(editable === null ? '' : editable.textContent || '')
      return content.split(text).length - 1 >= 2
    }, keyed)
    // Copy and cut reach the host the same way, because the embed performs no
    // clipboard default action of its own. Copy takes any selection, the output
    // area included; cut is additionally the only gesture that removes anything,
    // and its removal has to leave the editor's own model consistent, so it
    // asserts the composer really empties.
    phase = 'clipboard copy shortcut'
    const selected = await selectAndPress(frame, '[contenteditable="true"]', 'c')
    assert.ok(selected && selected.length > 0, 'the composer had a selection to copy: ' + String(selected))
    await waitForCopy(page, selected)
    phase = 'clipboard cut shortcut'
    const cutText = await selectAndPress(frame, '[contenteditable="true"]', 'x')
    assert.ok(cutText && cutText.length > 0, 'the composer had a selection to cut: ' + String(cutText))
    await waitForCopy(page, cutText)
    await frame.waitForFunction(() => {
      const editable = document.querySelector('[contenteditable="true"]')
      return editable !== null && String(editable.textContent || '').trim() === ''
    })
    // The output area is not a field: its selection must reach the host just the
    // same, with nothing focused, which is the case the composer alone missed.
    phase = 'clipboard copy from the output area'
    const outputText = await selectAndPress(frame, 'body', 'c', true)
    assert.ok(outputText && outputText.length > 0, 'the page had output text to select: ' + String(outputText))
    await waitForCopy(page, outputText)
    const state = await frame.evaluate(() => ({
      active: __smokeContext.fiber.state === 2,
      entries: [...__smokeContext.root.get('loader').entries()].map(entry => entry.options.name),
      errors: __DSH_VSCODE_DEBUG__.errors,
      activationErrors: __smokeContext.root.logger.buffer.filter(row => row.type === 'error').map(row => row.args.map(String)),
    }))
    assert.equal(state.active, true, 'the bridge remains active after graph reconciliation')
    assert.ok(state.entries.includes('@dsh/vscode-embed-bridge'))
    assert.ok(!state.entries.includes('@deepseek-ai/dsh-client-ui-sidebar'))
    assert.deepEqual(state.errors, [])
    assert.deepEqual(state.activationErrors, [])
    assert.deepEqual(errors, [])
  } catch (error) {
    const diagnostics = await Promise.all((page?.frames() ?? []).map(frame => frame.evaluate(() => ({
      debug: globalThis.__DSH_VSCODE_DEBUG__, messages: globalThis.__messages?.slice(-10),
      text: document.body.innerText.slice(0, 800),
    })).catch(() => ({}))))
    throw new Error(`browser ${phase}: ${String(error)}; ${JSON.stringify(diagnostics)}`)
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise(resolve => { server.close(resolve) })
  }
}

module.exports = { browserProbe }
