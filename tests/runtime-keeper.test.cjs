'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { connect } = require('node:net')
const { setTimeout: delay } = require('node:timers/promises')

const root = path.resolve(__dirname, '..')
const keeperPath = path.join(root, 'dist', 'runtime-keeper.js')
const fixture = path.join(__dirname, 'fixtures/runtime-backend.cjs')
fs.chmodSync(fixture, 0o755)

/** Minimal client: the keeper protocol is newline-delimited JSON. */
function client(record) {
  const socket = connect(record.port, '127.0.0.1')
  const events = []
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', chunk => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() !== '') events.push(JSON.parse(line))
    }
  })
  const request = body => socket.write(JSON.stringify({ token: record.token, ...body }) + '\n')
  const until = async (predicate, ms = 20000) => {
    const deadline = Date.now() + ms
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('condition timed out: ' + JSON.stringify(events))
      await delay(20)
    }
  }
  return {
    socket, events, request,
    ready: async () => { await until(() => events.some(e => e.type === 'ready' || e.type === 'failure')); return events.find(e => e.type === 'ready' || e.type === 'failure') },
    until,
  }
}

async function startKeeper(t, { cwd, graceMs = 1500, env = {} }) {
  const share = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-share-'))
  const keeper = spawn(process.execPath, [keeperPath, '--cwd', cwd, '--grace', String(graceMs)], {
    detached: true, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, DSH_EMBED_SHARE_DIR: share, ...env },
  })
  keeper.unref()
  const recordPath = async () => {
    const deadline = Date.now() + 10000
    for (;;) {
      const found = fs.existsSync(share) ? fs.readdirSync(share).filter(name => name.endsWith('.json')) : []
      if (found.length === 1) return path.join(share, found[0])
      if (Date.now() > deadline) throw new Error('keeper never published a record')
      await delay(20)
    }
  }
  const record = JSON.parse(fs.readFileSync(await recordPath(), 'utf8'))
  t.after(() => {
    try { process.kill(record.pid, 'SIGKILL') } catch {}
    fs.rmSync(share, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  })
  return { keeper, share, record, shareDir: share }
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

test('two clients share one backend; only the last detach reaps it', { timeout: 60000 }, async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-'))
  const pidPath = path.join(cwd, 'pids')
  const { record, shareDir } = await startKeeper(t, { cwd, env: { FIXTURE_PID_PATH: pidPath } })
  const spec = { command: fixture, args: [], cwd, env: { ...process.env, FIXTURE_PID_PATH: pidPath } }

  const first = client(record)
  first.request({ type: 'attach', spec })
  const firstReady = await first.ready()
  assert.equal(firstReady.type, 'ready')

  const second = client(record)
  second.request({ type: 'status' })
  await second.until(() => second.events.some(e => e.type === 'state'))
  assert.equal(second.events.find(e => e.type === 'state').clients, 1, 'a status probe must not register a client')
  second.request({ type: 'attach', spec })
  const secondReady = await second.ready()
  assert.equal(secondReady.url, firstReady.url, 'both clients reach the same backend')
  const pids = fs.readFileSync(pidPath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(pids.length, 1, 'one backend for both clients')

  second.request({ type: 'status' })
  await second.until(() => second.events.filter(e => e.type === 'state').at(-1).clients === 2)
  first.socket.end()
  await second.until(() => second.events.filter(e => e.type === 'state').at(-1).clients === 1)
  await delay(1800)
  assert.ok(alive(pids[0].pid), 'the backend survives the first client leaving')
  assert.ok(fs.existsSync(path.join(shareDir, record.key + '.json')), 'the keeper stays while a client is attached')

  second.socket.end()
  const deadline = Date.now() + 15000
  while (alive(pids[0].pid) && Date.now() < deadline) await delay(50)
  assert.ok(!alive(pids[0].pid), 'the last client leaving reaps the backend after the idle grace')
  assert.ok(!fs.existsSync(path.join(shareDir, record.key + '.json')), 'the record is removed with the keeper')
})

test('a second workspace keeps its own keeper and backend', { timeout: 60000 }, async t => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-a-'))
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-b-'))
  const a = await startKeeper(t, { cwd: first })
  const b = await startKeeper(t, { cwd: second })
  assert.notEqual(a.record.port, b.record.port, 'workspaces never share a control port')
  assert.notEqual(a.record.key, b.record.key, 'workspaces keep distinct identities')
})
