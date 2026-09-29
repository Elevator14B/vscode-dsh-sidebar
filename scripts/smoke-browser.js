/** Browser contracts that HTTP health checks cannot prove. Uses only the smoke workspace. */
'use strict'
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createServer } = require('node:http')
const path = require('node:path')
const { chromium } = require('playwright')

/** Exercise the actual injected bridge and DSH client, inside the shipped recovery shell. */
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
