'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const path = require('node:path')

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
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a,b) => a[1].at - b[1].at)[0]
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
function recovery(t, status = 'connected') {
  const time = clock(), messages = [], requests = [], reconnects = []
  const state = store(status), a = store({ openState: 'open' }), b = store({ openState: 'open' })
  const list = store({ current: 'a' })
  const network = { proxy: true, backend: true, identity: 'runtime-a' }
  const sandbox = { ...time, AbortController, URL, location: { origin: 'http://localhost:1234' },
    fetch: async (url, options) => {
      requests.push(url)
      if (!network.proxy) throw new Error('forwarding down')
      if (url.includes('health')) return { ok: true, json: async () => ({ protocol: 'dsh-sidebar-health-v1', runtimeId: network.identity }) }
      if (!network.backend) throw new Error('backend down')
      assert.equal(JSON.parse(options.body).method, 'session/list', 'only a read-only RPC is allowed')
      return { ok: true, json: async () => ({ result: { ok: true } }) }
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(path.join(__dirname, '../src/connection-recovery.js'), 'utf8'), sandbox)
  const owner = sandbox.__DSH_INSTALL_RECOVERY__({ connection: { state, reconnect() { reconnects.push(time.Date.now()) } },
    sessions: { list, binding(id) { return { session: id === 'a' ? a : b } } } }, m => messages.push(m), { runtimeId: 'runtime-a' })
  t.after(() => owner.dispose())
  return { time, state, a, b, list, network, messages, reconnects, requests, owner,
    latest: () => messages.filter(m => m.type === 'connection-status').at(-1) }
}

test('healthy idle pages do not restart connections or poll session lists', async t => {
  const f = recovery(t)
  await f.time.advance(60000)
  assert.equal(f.reconnects.length, 0)
  assert.ok(f.requests.every(url => url.includes('health')))
  assert.equal(f.latest().history, 'open')
  f.owner.dispose()
  assert.equal(f.time.size(), 0)
  assert.equal(f.state.size() + f.list.size() + f.a.size(), 0)
})

test('history stalled on a nominally connected transport triggers bounded recovery, then records completion', async t => {
  const f = recovery(t)
  f.a.set({ openState: 'loading' })
  await f.time.advance(16000)
  assert.equal(f.latest().stalled, true)
  await f.time.advance(18000)
  assert.equal(f.reconnects.length, 1)
  const request = f.messages.find(m => m.type === 'repair-forwarding')
  assert.ok(request)
  f.owner.handle({ type: 'forwarding-result', requestId: request.requestId, url: 'http://localhost:1234/' })
  assert.equal(f.reconnects.length, 2)
  await f.time.advance(60000)
  assert.equal(f.reconnects.length, 2, 'no infinite automatic reconnect loop')
  assert.equal(f.latest().exhausted, true)
  f.a.set({ openState: 'open' })
  await f.time.advance(3000)
  assert.equal(f.latest().stalled, false)
  assert.equal(f.latest().attempts, 0)
  const completed = f.messages.filter(m => m.type === 'history-state').at(-1)
  assert.equal(completed.history, 'open')
  assert.ok(completed.elapsedMs >= 94000)
})

test('switching sessions detaches old history observations', async t => {
  const f = recovery(t)
  f.a.set({ openState: 'loading' })
  await f.time.advance(12000)
  f.list.set({ current: 'b' })
  f.a.set({ openState: 'error' })
  await f.time.advance(12000)
  assert.equal(f.latest().sessionId, 'b')
  assert.equal(f.latest().history, 'open')
  assert.equal(f.reconnects.length, 0)
  assert.equal(f.a.size(), 0)
})

test('a stale forward to a different backend fails the proxy identity check', async t => {
  const f = recovery(t)
  f.network.identity = 'different-runtime'
  await f.time.advance(16000)
  assert.equal(f.latest().proxy, 'unavailable')
  f.network.identity = 'runtime-a'
  await f.time.advance(16000)
  assert.equal(f.latest().proxy, 'ready')
})

test('forwarding repair never silently navigates a page to a new origin', async t => {
  const f = recovery(t, 'disconnected')
  await f.time.advance(19000)
  const request = f.messages.find(m => m.type === 'repair-forwarding')
  assert.ok(request)
  f.owner.handle({ type: 'forwarding-result', requestId: request.requestId, url: 'http://localhost:5678/' })
  assert.equal(f.latest().reloadRequired, true)
  assert.equal(f.reconnects.length, 1)
})

function shell() {
  const time = clock(), sent = [], relayed = [], listeners = {}
  const node = () => ({ hidden: false, textContent: '', disabled: false, addEventListener(type, fn) { this[type] = fn } })
  const frame = { ...node(), src: 'http://localhost:1234/', contentWindow: { postMessage(m) { relayed.push(m) } } }
  const nodes = { frame, 'connection-status': node(), 'connection-label': node(), 'connection-retry': node(), 'connection-reload': node() }
  const sandbox = { ...time, URL, __DSH_SHELL_CONFIG__: { pageId: 'page-a', locale: 'zh-cn' },
    acquireVsCodeApi: () => ({ postMessage(m) { sent.push(m) } }), document: { getElementById: id => nodes[id] },
    window: { addEventListener(type, fn) { listeners[type] = fn } },
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(path.join(__dirname, '../src/recovery-shell.js'), 'utf8'), sandbox)
  const host = m => listeners.message({ source: {}, data: { __dshHost: true, ...m } })
  const bridge = m => listeners.message({ source: frame.contentWindow, data: { source: 'dsh-vscode-bridge', ...m } })
  return { time, sent, relayed, nodes, host, bridge,
    pong: () => host({ type: 'host-pong', pageId: 'page-a', sentAt: time.Date.now() }) }
}

test('a delayed EH pong cannot declare recovery; a fresh pong requests forwarding repair', async () => {
  const f = shell()
  await f.time.advance(12000)
  assert.match(f.nodes['connection-label'].textContent, /远端扩展/)
  assert.equal(f.nodes['connection-reload'].disabled, true)
  f.host({ type: 'host-pong', sentAt: 100000 })
  assert.equal(f.nodes['connection-reload'].disabled, true)
  f.pong()
  assert.equal(f.nodes['connection-reload'].disabled, false)
  assert.ok(f.sent.some(m => m.type === 'repair-forwarding'))
  assert.ok(f.relayed.some(m => m.type === 'reconnect-page'))
})

test('buffered session clicks coalesce and old page responses are ignored', async () => {
  const f = shell()
  for (const sessionId of ['a', 'b', 'c']) f.host({ type: 'open-session', sessionId })
  f.host({ type: 'forwarding-result', pageId: 'old-page', url: 'http://localhost:9999/' })
  await f.time.advance(100)
  assert.deepEqual(f.relayed.map(m => m.sessionId), ['c'])
  assert.equal(f.nodes['connection-status'].hidden, true)
})

test('history timeout is visible despite a healthy EH and bridge, with page-only recovery actions', () => {
  const f = shell()
  f.pong()
  f.bridge({ type: 'bridge-loaded' })
  f.bridge({ type: 'connection-status', connection: 'connected', proxy: 'ready', backend: 'ready', history: 'loading', stalled: true })
  assert.match(f.nodes['connection-label'].textContent, /历史加载超时/)
  f.nodes['connection-retry'].click()
  f.nodes['connection-reload'].click()
  assert.ok(f.sent.some(m => m.type === 'reload-page'))
  assert.ok(f.relayed.some(m => m.type === 'reconnect-page'))
  assert.ok(!f.sent.some(m => /restart|prompt/.test(m.type)))
})


test('changed forwarding remains visible when the old page keeps sending healthy heartbeats', () => {
  const f = shell()
  f.bridge({ type: 'bridge-loaded' })
  f.host({ type: 'forwarding-result', pageId: 'page-a', url: 'http://localhost:5678/' })
  f.bridge({ type: 'connection-status', connection: 'connected', proxy: 'ready', backend: 'ready', history: 'open' })
  assert.match(f.nodes['connection-label'].textContent, /端口转发地址已变化/)
})
