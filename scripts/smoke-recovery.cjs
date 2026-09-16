#!/usr/bin/env node
/** Real DSH + Chromium recovery smoke. Set DSH_PLAYWRIGHT_MODULE to an installed playwright package. */
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const { createServer } = require('node:http')
const path = require('node:path')
const { buildSync } = require('esbuild')
const { chromium } = require(process.env.DSH_PLAYWRIGHT_MODULE || 'playwright')
const root = path.resolve(__dirname, '..')
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recovery-smoke-'))
const moduleObject = { exports: {} }
const events = []
const vscode = {
  env: { language: 'zh-cn' },
  workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'command' ? 'dsh' : key === 'args' ? ['web', '--port', '0', '--no-open'] : fallback }) },
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {}; dispose() {} },
}
const code = buildSync({ entryPoints: [path.join(root, 'src/runtime.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text
new Function('require', 'module', 'exports', code)(id => id === 'vscode' ? vscode : require(id), moduleObject, moduleObject.exports)
const runtime = new moduleObject.exports.DshRuntime({ extensionUri: { fsPath: root } }, { uri: { fsPath: cwd }, name: 'recovery-smoke' }, { append() {}, appendLine() {} }, (event, data) => events.push({ event, data }))
let browser, origin, workspaceId, page, shellServer
async function rpc(method, request) {
  const response = await fetch(origin + '/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method, payload: { args: { request } } }), signal: AbortSignal.timeout(10000) })
  const envelope = await response.json()
  assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result.error))
  return envelope.result.value
}
async function main() {
  try {
    origin = await runtime.getWebUrl()
    workspaceId = (await rpc('workspace/create', { path: cwd })).workspace.workspaceId
    const first = (await rpc('session/create', { workspaceId })).sessionId
    const second = (await rpc('session/create', { workspaceId })).sessionId
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.DSH_CHROMIUM_PATH ? { executablePath: process.env.DSH_CHROMIUM_PATH } : {}) })
    page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => { errors.push(String(error)); console.error('page error', String(error)) })
    page.on('console', message => { if (message.type() === 'error') console.error('browser', message.text().slice(0,400)) })
    let blocked = false, holdHistory = false
    const sockets = new Set()
    await page.routeWebSocket(/\/api\/remote.mux/, client => {
      if (blocked) { client.close(); return }
      const server = client.connectToServer()
      const pair = { client, server }
      sockets.add(pair)
      client.onClose(() => { sockets.delete(pair); server.close() })
      server.onClose(() => { sockets.delete(pair); client.close() })
      client.onMessage(message => {
        const data = JSON.parse(message.toString())
        if (holdHistory && data.type === 'open' && data.endpoint === 'session/follow') return
        server.send(message)
      })
    })
    const shell = fs.readFileSync(path.join(root, 'dist/recovery-shell.js'), 'utf8')
    const shellHtml = `<div id="connection-status" hidden><span id="connection-label"></span><button id="connection-retry"></button><button id="connection-reload"></button></div><iframe id="frame" src="${origin}"></iframe><script>
      window.events = []; window.hostOnline = true;
      window.__DSH_SHELL_CONFIG__ = {pageId:'smoke',locale:'zh-cn'};
      window.acquireVsCodeApi = () => ({ postMessage: m => {
        window.events.push(m);
        if(m.type === 'host-ping' && window.hostOnline) window.postMessage({__dshHost:true,type:'host-pong',pageId:'smoke',sentAt:m.sentAt}, '*');
        if(m.type === 'repair-forwarding' && window.hostOnline) window.postMessage({__dshHost:true,type:'forwarding-result',pageId:'smoke',requestId:m.requestId,url:'${origin}'}, '*');
      }});
      ${shell}
    </script>`
    shellServer = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(shellHtml) })
    await new Promise(resolve => shellServer.listen(0, '127.0.0.1', resolve))
    await page.goto('http://127.0.0.1:' + shellServer.address().port)
    const open = id => page.evaluate(sessionId => window.postMessage({ __dshHost: true, type: 'open-session', sessionId }, '*'), id)
    const waitOpen = id => page.waitForFunction(sessionId => window.events.some(m => m.type === 'connection-status' && m.sessionId === sessionId && m.history === 'open'), id, { timeout: 60000 })
    await page.waitForFunction(() => window.events.some(m => m.type === 'connection-status' && m.connection === 'connected' && m.history === 'open'), undefined, { timeout: 60000 })
    await open(first); await waitOpen(first)
    console.log('ok real bridge subscribed to connection and history services')

    blocked = true
    for (const { client, server } of [...sockets]) { server.close(); client.close() }
    await page.evaluate(() => { window.hostOnline = false })
    await page.waitForFunction(() => document.getElementById('connection-label').textContent.includes('远端扩展'), undefined, { timeout: 16000 })
    await open(first); await open(second)
    blocked = false
    await page.evaluate(() => { window.hostOnline = true })
    await waitOpen(second)
    console.log('ok EH and data reconnection restored the final requested session without a backend restart')

    holdHistory = true
    const third = (await rpc('session/create', { workspaceId })).sessionId
    await page.waitForFunction(id => window.events.some(m => m.type === 'workspace-state' && m.sessionIds.includes(id)), third)
    await open(third)
    await page.waitForFunction(() => document.getElementById('connection-label').textContent.includes('历史加载超时'), undefined, { timeout: 25000 })
    holdHistory = false
    await page.getByRole('button', { name: '重新连接', exact: true }).click()
    await waitOpen(third)
    console.log('ok stalled history displayed a timeout and recovered through the public reconnect API')
    assert.equal(events.filter(e => e.event === 'runtime.spawned').length, 1)
    assert.deepEqual(errors, [])
    console.log('PASS: one backend generation; no uncaught page errors')
  } catch (error) {
    if (page) {
      console.error('events', JSON.stringify(await page.evaluate(() => window.events?.filter(m => !['connection-status','host-ping','shell-heartbeat'].includes(m.type)).slice(-16))))
      for (const frame of page.frames()) console.error('frame', frame.url(), (await frame.locator('body').innerText().catch(() => '')).slice(0,1000))
    }
    throw error
  } finally {
    await browser?.close()
    if (shellServer) { shellServer.closeAllConnections(); await new Promise(resolve => shellServer.close(resolve)) }
    if (workspaceId) await rpc('workspace/delete', { workspaceId }).catch(error => console.error('workspace cleanup', error.message))
    await runtime.dispose()
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
