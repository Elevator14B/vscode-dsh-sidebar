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

function setup(t, mode = '') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-test-'))
  const pidPath = path.join(cwd, 'pids')
  const oldMode = process.env.FIXTURE_MODE
  const oldPids = process.env.FIXTURE_PID_PATH
  process.env.FIXTURE_MODE = mode
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
  const runtime = new mod.exports.DshRuntime({ extensionUri: { fsPath: root } }, { uri: { fsPath: cwd }, name: 'fixture' }, { append() {}, appendLine() {} }, (event, data) => { events.push({ event, ...data }) })
  const pids = () => fs.existsSync(pidPath) ? fs.readFileSync(pidPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  t.after(async () => {
    await runtime.dispose()
    if (oldMode === undefined) delete process.env.FIXTURE_MODE
    else process.env.FIXTURE_MODE = oldMode
    if (oldPids === undefined) delete process.env.FIXTURE_PID_PATH
    else process.env.FIXTURE_PID_PATH = oldPids
    fs.rmSync(cwd, { recursive: true, force: true })
  })
  return { runtime, pids, events }
}

function isGone(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      if (['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0])) return true
    }
    process.kill(pid, 0); return false
  } catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) return true; throw error }
}

test('concurrent starts and restarts each produce one backend generation', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const { runtime, pids } = setup(t)
  const urls = await Promise.all([runtime.getWebUrl(), runtime.getWebUrl(), runtime.getWebUrl()])
  assert.equal(new Set(urls).size, 1)
  assert.equal(pids().filter(p => !p.probe).length, 1)
  assert.equal(await runtime.getWebUrl(), urls[0])
  await Promise.all([runtime.restart(), runtime.restart()])
  const backends = pids().filter(p => !p.probe)
  assert.equal(backends.length, 2)
  assert.ok(isGone(backends[0].pid))
  await runtime.stop()
  assert.equal(runtime.origin, undefined)
  assert.ok(pids().every(p => isGone(p.pid)))
})

test('authentication failure reaps each generation before allowing retry', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const { runtime, pids } = setup(t, 'missing-cookie')
  for (let i = 0; i < 2; i++) {
    await assert.rejects(runtime.getWebUrl(), /browser-session cookie/)
    assert.equal(runtime.origin, undefined)
    assert.ok(pids().every(p => isGone(p.pid)))
  }
  assert.equal(pids().filter(p => !p.probe).length, 2)
})

test('stop during version probe cancels startup and prevents a late backend spawn', { skip: process.platform === 'win32', timeout: 12000 }, async t => {
  const { runtime, pids } = setup(t, 'hang-version')
  const starting = assert.rejects(runtime.getWebUrl(), /cancelled/)
  const deadline = Date.now() + 5000
  while (pids().length === 0) { assert.ok(Date.now() < deadline); await delay(20) }
  await runtime.stop()
  await starting
  assert.ok(pids().every(p => p.probe && isGone(p.pid)))
  assert.equal(runtime.origin, undefined)
})

test('stop cancels a hanging authentication exchange; disposal forbids resurrection', { skip: process.platform === 'win32', timeout: 12000 }, async t => {
  const { runtime, pids } = setup(t, 'auth-hang')
  const starting = assert.rejects(runtime.getWebUrl(), /abort|cancel/iu)
  const deadline = Date.now() + 5000
  while (!pids().some(p => !p.probe)) { assert.ok(Date.now() < deadline); await delay(20) }
  await delay(100)
  await runtime.dispose()
  await starting
  await assert.rejects(runtime.getWebUrl(), /disposed/)
  assert.ok(pids().every(p => isGone(p.pid)))
})

test('surviving Host reaps the backend if its guardian is killed, then permits restart', { skip: process.platform !== 'linux', timeout: 12000 }, async t => {
  const { runtime, pids, events } = setup(t)
  await runtime.getWebUrl()
  const oldBackend = pids().find(p => !p.probe).pid
  process.kill(events.find(e => e.event === 'runtime.spawned').guardianPid, 'SIGKILL')
  const deadline = Date.now() + 5000
  while (!isGone(oldBackend)) { assert.ok(Date.now() < deadline); await delay(25) }
  await runtime.restart()
  assert.equal(pids().filter(p => !p.probe).length, 2)
  assert.ok(runtime.origin)
})
