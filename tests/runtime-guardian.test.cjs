'use strict'
const assert = require('node:assert/strict')
const { test, after } = require('node:test')
const { fork, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const fixture = path.resolve(__dirname, 'fixtures/runtime-backend.cjs')
fs.chmodSync(fixture, 0o755)
const directories = []
after(() => { for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true }) })

function live(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0])
    }
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return false
    throw error
  }
}

async function until(predicate, ms = 12000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition timed out')
    await delay(25)
  }
}

function launch(t, cwd, env = {}) {
  const host = fork(path.resolve(__dirname, 'fixtures/runtime-host.cjs'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const events = []
  host.on('message', message => { events.push(message) })
  const pidPath = path.join(cwd, `pids-${host.pid}`)
  const pids = () => fs.existsSync(pidPath) ? fs.readFileSync(pidPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  host.send({ type: 'start', spec: { command: fixture, args: [], cwd, env: { ...process.env, FIXTURE_PID_PATH: pidPath, ...env } } })
  t.after(async () => {
    if (host.connected) host.send({ type: 'stop' })
    await until(() => !live(host.pid)).catch(() => { host.kill('SIGKILL') })
    for (const p of pids()) if (live(p.pid)) process.kill(p.pid, 'SIGKILL')
  })
  return {
    host, events, pids,
    async event(type) { await until(() => events.some(e => e.type === type)); return events.find(e => e.type === type) },
  }
}

function workspace(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-guardian-test-'))
  directories.push(cwd)
  return cwd
}

test('Host SIGKILL reaps backend, observed detached descendant, port and real flock', { skip: process.platform !== 'linux', timeout: 20000 }, async t => {
  const cwd = workspace(t)
  const lock = path.join(cwd, 'session.lock')
  const first = launch(t, cwd, { FIXTURE_LOCK: lock })
  const ready = await first.event('url')
  assert.ok(ready.url.endsWith('fixture-token'), 'a split token must not be accepted early')
  await until(() => first.pids().some(p => p.descendant))
  await delay(750) // allow the guardian to observe the child's detached process identity
  assert.equal(spawnSync('flock', ['-n', lock, 'true']).status, 1)
  first.host.kill('SIGKILL')
  await until(() => first.pids().every(p => !live(p.pid)))
  await until(() => !live(first.events.find(e => e.type === 'guardian').pid))
  assert.equal(spawnSync('flock', ['-n', lock, 'true']).status, 0, 'the real kernel lock must be available')
  await assert.rejects(fetch(ready.url))
  const next = launch(t, cwd)
  assert.notEqual((await next.event('url')).pid, ready.pid)
})

test('a live Host keeps its backend without browser connections or heartbeats', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const owner = launch(t, workspace(t))
  const ready = await owner.event('url')
  await delay(1000)
  assert.ok(live(ready.pid))
  assert.equal((await fetch(ready.url)).status, 200)
  assert.equal(owner.pids().filter(p => !p.probe).length, 1)
  owner.host.send({ type: 'stop' })
  await owner.event('guardian-exit')
  assert.ok(!live(ready.pid))
})

test('Host death during version probe never launches the backend', { skip: process.platform === 'win32', timeout: 12000 }, async t => {
  const owner = launch(t, workspace(t), { FIXTURE_MODE: 'hang-version' })
  await until(() => owner.pids().length > 0)
  owner.host.kill('SIGKILL')
  await until(() => owner.pids().every(p => !live(p.pid)))
  assert.ok(owner.pids().every(p => p.probe))
})

test('replacement waits for the previous guardian and a SIGTERM-resistant backend', { skip: process.platform !== 'linux', timeout: 20000 }, async t => {
  const cwd = workspace(t)
  const first = launch(t, cwd, { FIXTURE_IGNORE_TERM: '1' })
  const before = await first.event('url')
  first.host.kill('SIGKILL')
  const next = launch(t, cwd)
  await delay(250)
  assert.equal(next.pids().length, 0, 'replacement must not even probe while old workspace is reserved')
  const after = await next.event('url')
  assert.ok(!live(before.pid))
  assert.notEqual(before.pid, after.pid)
})

test('cancelling a competing Host leaves the live workspace owner untouched', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const cwd = workspace(t)
  const owner = launch(t, cwd)
  const ready = await owner.event('url')
  const contender = launch(t, cwd)
  await contender.event('guardian')
  await delay(200)
  assert.equal(contender.pids().length, 0)
  contender.host.send({ type: 'stop' })
  await contender.event('guardian-exit')
  assert.ok(live(ready.pid))
  assert.equal((await fetch(ready.url)).status, 200)
})

test('an early backend crash still reaps its private process group', { skip: process.platform !== 'linux', timeout: 10000 }, async t => {
  const cwd = workspace(t)
  const lock = path.join(cwd, 'session.lock')
  const owner = launch(t, cwd, { FIXTURE_MODE: 'crash-with-child', FIXTURE_LOCK: lock })
  await owner.event('guardian-exit')
  assert.ok(owner.pids().some(p => p.descendant))
  assert.ok(owner.pids().every(p => !live(p.pid)))
  assert.equal(spawnSync('flock', ['-n', lock, 'true']).status, 0)
})
