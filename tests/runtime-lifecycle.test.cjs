'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { buildSync } = require('esbuild')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const root = path.resolve(__dirname, '..')
const fixture = path.join(__dirname, 'fixtures/runtime-backend.cjs')
fs.chmodSync(fixture, 0o755)
const code = buildSync({ entryPoints: [path.join(root, 'src/runtime.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function until(predicate, ms = 15000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition timed out')
    await delay(25)
  }
}

/**
 * One Extension Host attachment. Passing the same folder and share directory
 * models a second window (or a replaced Host) of the same Remote-SSH folder.
 */
function setup(t, options = {}) {
  const folder = options.folder ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lifecycle-'))
  const share = options.share ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-share-'))
  const pidPath = path.join(folder, 'pids')
  const previous = { share: process.env.DSH_EMBED_SHARE_DIR, grace: process.env.DSH_EMBED_IDLE_GRACE_MS, pids: process.env.FIXTURE_PID_PATH }
  process.env.DSH_EMBED_SHARE_DIR = share
  process.env.DSH_EMBED_IDLE_GRACE_MS = '1000'
  process.env.FIXTURE_PID_PATH = pidPath
  const vscode = {
    env: { language: 'en' },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'command' ? fixture : fallback }) },
    EventEmitter: class {
      event = () => ({ dispose() {} })
      fire() {}
      dispose() {}
    },
  }
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(id => id === 'vscode' ? vscode : require(id), mod, mod.exports)
  const events = []
  const runtime = new mod.exports.DshRuntime({ extensionUri: { fsPath: root } },
    { uri: { fsPath: folder }, name: 'fixture' }, { append() {}, appendLine() {} },
    (event, data) => events.push({ event, ...data }))
  const pids = () => fs.existsSync(pidPath) ? fs.readFileSync(pidPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  t.after(async () => {
    await runtime.dispose()
    const records = fs.existsSync(share) ? fs.readdirSync(share).filter(name => name.endsWith('.json')) : []
    for (const name of records) {
      try { process.kill(JSON.parse(fs.readFileSync(path.join(share, name), 'utf8')).pid, 'SIGKILL') } catch (_error) { /* already gone */ }
    }
    for (const entry of pids()) { try { process.kill(entry.pid, 'SIGKILL') } catch (_error) { /* already gone */ } }
    if (previous.share === undefined) delete process.env.DSH_EMBED_SHARE_DIR
    else process.env.DSH_EMBED_SHARE_DIR = previous.share
    if (previous.grace === undefined) delete process.env.DSH_EMBED_IDLE_GRACE_MS
    else process.env.DSH_EMBED_IDLE_GRACE_MS = previous.grace
    if (previous.pids === undefined) delete process.env.FIXTURE_PID_PATH
    else process.env.FIXTURE_PID_PATH = previous.pids
  })
  return { runtime, events, pids, folder, share }
}

test('concurrent attachments of one window share a single backend', { timeout: 30000 }, async t => {
  const f = setup(t)
  const urls = await Promise.all([f.runtime.getWebUrl(), f.runtime.getWebUrl(), f.runtime.getWebUrl()])
  assert.equal(new Set(urls).size, 1)
  assert.equal(f.pids().length, 1)
  assert.equal(await f.runtime.getWebUrl(), urls[0])
})

test('a second window attaches to the running backend and survives the first detaching', { timeout: 40000 }, async t => {
  const f = setup(t)
  await f.runtime.getWebUrl()
  const second = setup(t, { folder: f.folder, share: f.share })
  const secondUrl = await second.runtime.getWebUrl()
  const firstReady = f.events.find(entry => entry.event === 'runtime.ready')
  const secondReady = second.events.find(entry => entry.event === 'runtime.ready')
  assert.equal(secondReady.shared, true, 'the second window reuses the running backend')
  assert.equal(secondReady.backendPort, firstReady.backendPort)
  assert.equal(secondReady.keeperPid, firstReady.keeperPid)
  assert.equal(f.pids().length, 1, 'no second backend was started')
  await f.runtime.dispose()
  await delay(1500) // longer than the idle grace that follows zero clients
  assert.equal(f.pids().length, 1, 'the backend outlives the window that started it')
  assert.ok(alive(f.pids()[0].pid))
  assert.equal((await fetch(secondUrl + '/__dsh_vscode_health')).status, 200, 'the remaining window keeps working')
})

test('the backend is reaped after the last window detaches', { timeout: 30000 }, async t => {
  const f = setup(t)
  await f.runtime.getWebUrl()
  const backend = f.pids()[0].pid
  await f.runtime.dispose()
  await until(() => !alive(backend), 15000)
})

test('different folders keep their own keeper and backend', { timeout: 40000 }, async t => {
  const first = setup(t)
  await first.runtime.getWebUrl()
  const second = setup(t)
  await second.runtime.getWebUrl()
  assert.equal(first.pids().length, 1)
  assert.equal(second.pids().length, 1)
  assert.notEqual(first.events.find(entry => entry.event === 'runtime.ready').keeperPid,
    second.events.find(entry => entry.event === 'runtime.ready').keeperPid)
})

test('restart replaces the shared backend without replacing the window proxy', { timeout: 40000 }, async t => {
  const f = setup(t)
  const url = await f.runtime.getWebUrl()
  const before = f.pids()[0].pid
  await f.runtime.restart()
  await until(() => f.pids().length === 2, 15000)
  assert.notEqual(f.pids()[1].pid, before)
  assert.equal(await f.runtime.getWebUrl(), url, 'the window keeps its proxy authority')
  assert.equal((await fetch(url + '/__dsh_vscode_health')).status, 200)
})

test('a killed keeper is replaced and its orphaned backend is reaped', { timeout: 60000 }, async t => {
  const f = setup(t)
  await f.runtime.getWebUrl()
  const keeperPid = f.events.find(entry => entry.event === 'runtime.ready').keeperPid
  const orphan = f.pids()[0].pid
  process.kill(keeperPid, 'SIGKILL')
  await until(() => f.runtime.origin === undefined, 15000)
  assert.ok(await f.runtime.getWebUrl(), 'the next attach forks a replacement keeper')
  await until(() => f.pids().length === 2, 20000)
  await until(() => !alive(orphan), 20000)
})
