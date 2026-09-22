'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const path = require('node:path')

/** Deterministic clock: these modules own no wall-clock dependency of their own. */
function clock() {
  let now = 100000, id = 0
  const timers = new Map()
  const add = (fn, delay, repeat) => { const key = ++id; timers.set(key, { fn, at: now + delay, repeat }); return key }
  return {
    Date: class extends Date { static now() { return now } },
    setTimeout: (fn, ms) => add(fn, ms, 0), clearTimeout: key => timers.delete(key),
    setInterval: (fn, ms) => add(fn, ms, ms), clearInterval: key => timers.delete(key),
    async advance(ms) {
      const end = now + ms
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [key, t] = next; now = t.at
        if (t.repeat) t.at += t.repeat; else timers.delete(key)
        t.fn()
        await new Promise(resolve => setImmediate(resolve))
      }
      now = end
      await new Promise(resolve => setImmediate(resolve))
    },
    size: () => timers.size,
  }
}

function store(value) {
  const listeners = new Set()
  return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) { value = next; for (const fn of [...listeners]) fn() }, size: () => listeners.size }
}

/** The injected page module: it reports state and reconnects only when asked. */
function page(t, status = 'connected') {
  const time = clock(), messages = [], reconnects = []
  const state = store(status)
  const sandbox = { ...time, URL }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(path.join(__dirname, '../src/connection-recovery.js'), 'utf8'), sandbox)
  const owner = sandbox.__DSH_INSTALL_RECOVERY__({ connection: { state, reconnect() { reconnects.push(time.Date.now()) } } },
    message => messages.push(message), {})
  t.after(() => owner.dispose())
  return { time, state, messages, reconnects, owner,
    latest: () => messages.filter(m => m.type === 'connection-status').at(-1) }
}

test('the page reports DSH state and reconnects only when the host asks', async t => {
  const f = page(t)
  assert.equal(f.latest().connection, 'connected')
  assert.equal(f.owner.connected(), true)
  await f.time.advance(60000)
  assert.equal(f.reconnects.length, 0, 'the page owns no retry ladder')
  assert.equal(f.messages.length, 1, 'an unchanged state is not republished')
  f.state.set('connecting')
  assert.equal(f.latest().connection, 'connecting')
  assert.equal(f.owner.connected(), false)
  f.owner.handle({ type: 'reconnect-page' })
  assert.equal(f.reconnects.length, 1)
  f.owner.dispose()
  assert.equal(f.time.size(), 0, 'no timer survives disposal')
  assert.equal(f.state.size(), 0, 'no subscription survives disposal')
})

/** The injected shell: liveness reporting, relay and status rendering only. */
function shell() {
  const time = clock(), sent = [], relayed = [], listeners = {}
  const node = () => ({ hidden: false, textContent: '' })
  const frameListeners = {}
  const frame = { src: 'http://localhost:1234/', addEventListener(type, fn) { frameListeners[type] = fn },
    contentWindow: { postMessage(m) { relayed.push(m) } } }
  const nodes = { frame, 'connection-status': node(), 'connection-label': node() }
  const sandbox = { ...time, URL, __DSH_SHELL_CONFIG__: { pageId: 'page-a', locale: 'zh-cn' },
    acquireVsCodeApi: () => ({ postMessage(m) { sent.push(m) } }), document: { getElementById: id => nodes[id] },
    window: { addEventListener(type, fn) { listeners[type] = fn } },
  }
  sandbox.addEventListener = (type, fn) => { listeners[type] = fn }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(path.join(__dirname, '../src/recovery-shell.js'), 'utf8'), sandbox)
  const host = m => listeners.message({ source: {}, data: { __dshHost: true, ...m } })
  const bridge = m => listeners.message({ source: frame.contentWindow, data: { source: 'dsh-vscode-bridge', ...m } })
  return { time, sent, relayed, nodes, host, bridge, label: () => nodes['connection-label'].textContent }
}

test('the shell renders the host status and relays both directions', () => {
  const f = shell()
  f.host({ type: 'status', status: 'offline' })
  assert.equal(f.nodes['connection-status'].hidden, false)
  assert.match(f.label(), /远端连接/)
  f.host({ type: 'status', status: 'rebuilding' })
  assert.match(f.label(), /正在重建/)
  f.host({ type: 'status' })
  assert.equal(f.nodes['connection-status'].hidden, true)
  f.bridge({ type: 'connection-status', connection: 'connected' })
  assert.equal(f.sent.filter(m => m.type === 'connection-status').at(-1).pageId, 'page-a')
  f.host({ type: 'configure', theme: 'dark' })
  assert.equal(f.relayed.at(-1).type, 'configure')
  f.host({ pageId: 'old-page', type: 'status', status: 'rebuilding' })
  assert.equal(f.nodes['connection-status'].hidden, true, 'another page cannot drive this shell')
})

test('the shell proves client liveness on every tick', async () => {
  const f = shell()
  assert.equal(f.sent.filter(m => m.type === 'shell-ready').length, 1)
  await f.time.advance(9000)
  assert.equal(f.sent.filter(m => m.type === 'shell-alive').length, 3)
  assert.equal(f.sent.filter(m => m.type === 'host-ping').length, 0, 'the host no longer needs a round trip')
})
