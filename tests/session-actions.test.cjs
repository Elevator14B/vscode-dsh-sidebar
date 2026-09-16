/**
 * Regression: the Sessions-tree action layer.
 *
 * The native tree shares the web sidebar's list, so reorder and archive must
 * speak the backend's own Workspace RPCs with exactly the envelope the loopback
 * proxy expects, and the planning helpers must keep the row the user aimed at
 * where the gesture put it — and write nothing when the order would not change.
 */
'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const { buildSync } = require('esbuild')

// In-memory bundle, the loader tests/dsh-version.test.cjs uses: the real module,
// no build step, nothing written next to the sources.
const code = buildSync({
  entryPoints: [path.resolve(__dirname, '../src/session-actions.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
}).outputFiles[0].text

const loaded = { exports: {} }
new Function('require', 'module', 'exports', code)(require, loaded, loaded.exports)
const { archiveSession, moveSessionBefore, planMove, planStep } = loaded.exports

const ORIGIN = 'http://127.0.0.1:39222'

/** The envelope the proxy returns for a successful unary RPC. */
function ok(value) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ type: 'client-response', result: { ok: true, value } }),
  }
}

/**
 * Run 'body' with the network stubbed; 'handler' answers each call in order and
 * 'body' receives the recorded { url, init, request } rows.
 */
async function withFetch(handler, body) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, request: JSON.parse(init.body) })
    return handler(calls.length)
  }
  try {
    return await body(calls)
  } finally {
    globalThis.fetch = original
  }
}

/** Apply one plan the way the backend will: insert before the anchor, or append. */
function applyMove(ids, sessionId, plan) {
  const remaining = ids.filter(id => id !== sessionId)
  const at = plan.beforeSessionId === undefined ? remaining.length : remaining.indexOf(plan.beforeSessionId)
  return [...remaining.slice(0, at), sessionId, ...remaining.slice(at)]
}

test('archiveSession posts the archive RPC with the exact envelope', async () => {
  await withFetch(() => ok({ archivedSessionIds: ['session-1'] }), async calls => {
    assert.equal(await archiveSession(ORIGIN, 'session-1'), undefined)
    assert.equal(calls.length, 1)
    const { url, init, request } = calls[0]
    assert.equal(url, ORIGIN + '/api/workspace/archiveSession')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers['content-type'], 'application/json')
    assert.ok(init.signal instanceof AbortSignal)
    assert.deepEqual(Object.keys(request).sort(), ['method', 'payload', 'rpcId', 'type'])
    assert.equal(request.type, 'client-request')
    assert.equal(typeof request.rpcId, 'string')
    assert.ok(request.rpcId.length > 0)
    assert.equal(request.method, 'workspace/archiveSession')
    assert.deepEqual(request.payload, { args: { request: { sessionId: 'session-1' } } })
  })
})

test('moveSessionBefore posts the insert RPC with its anchor', async () => {
  await withFetch(() => ok({ workspace: { workspaceId: 'ws-1' } }), async calls => {
    await moveSessionBefore(ORIGIN, 'ws-1', 'session-2', 'session-3')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, ORIGIN + '/api/workspace/insertSessionBefore')
    assert.equal(calls[0].request.method, 'workspace/insertSessionBefore')
    assert.deepEqual(calls[0].request.payload, {
      args: { request: { workspaceId: 'ws-1', sessionId: 'session-2', beforeSessionId: 'session-3' } },
    })
  })
})

test('moveSessionBefore omits an undefined anchor instead of sending null', async () => {
  await withFetch(() => ok({ workspace: { workspaceId: 'ws-1' } }), async calls => {
    await moveSessionBefore(ORIGIN, 'ws-1', 'session-2')
    const request = calls[0].request.payload.args.request
    assert.deepEqual(request, { workspaceId: 'ws-1', sessionId: 'session-2' })
    assert.equal(Object.prototype.hasOwnProperty.call(request, 'beforeSessionId'), false)
  })
})

test('a non-2xx response throws with the endpoint and status', async () => {
  await withFetch(() => ({ ok: false, status: 503, json: async () => ({}) }), async () => {
    await assert.rejects(archiveSession(ORIGIN, 'session-1'), {
      message: 'dsh rpc workspace/archiveSession: HTTP 503',
    })
  })
})

test('a result envelope that is not ok throws the upstream message', async () => {
  const failed = {
    ok: true,
    status: 200,
    json: async () => ({ type: 'client-response', result: { ok: false, error: { message: 'session is pinned' } } }),
  }
  await withFetch(() => failed, async () => {
    await assert.rejects(moveSessionBefore(ORIGIN, 'ws-1', 'session-2', 'session-3'), {
      message: 'dsh rpc workspace/insertSessionBefore: session is pinned',
    })
  })
})

test('a failure without a message still names the endpoint', async () => {
  const failed = { ok: true, status: 200, json: async () => ({ result: { ok: false } }) }
  await withFetch(() => failed, async () => {
    await assert.rejects(archiveSession(ORIGIN, 'session-1'), {
      message: 'dsh rpc workspace/archiveSession: failed',
    })
  })
})

test('planMove anchors the row at the index the drop aimed at', () => {
  const ids = ['a', 'b', 'c', 'd']
  assert.deepEqual(planMove(ids, 'd', 0), { beforeSessionId: 'a' })
  assert.deepEqual(planMove(ids, 'b', 2), { beforeSessionId: 'd' })
  assert.deepEqual(planMove(ids, 'c', 0), { beforeSessionId: 'a' })
})

test('planMove sends a bare move for the end of the list', () => {
  const plan = planMove(['a', 'b', 'c', 'd'], 'a', 3)
  assert.deepEqual(plan, {})
  assert.equal(Object.prototype.hasOwnProperty.call(plan, 'beforeSessionId'), false)
})

test('planMove reports a no-op instead of rewriting an unchanged order', () => {
  const ids = ['a', 'b', 'c']
  assert.equal(planMove(ids, 'a', 0), undefined)
  assert.equal(planMove(ids, 'b', 1), undefined)
  assert.equal(planMove(ids, 'c', 2), undefined)
})

test('planMove clamps an index outside the list to its nearest end', () => {
  const ids = ['a', 'b', 'c']
  assert.deepEqual(planMove(ids, 'c', -5), { beforeSessionId: 'a' })
  assert.deepEqual(planMove(ids, 'a', 99), {})
  assert.deepEqual(planMove(ids, 'b', 99), {})
})

test('planMove ignores ids the tree is not showing', () => {
  assert.equal(planMove(['a', 'b'], 'session-x', 0), undefined)
  assert.equal(planMove([], 'a', 0), undefined)
})

test('planStep moves a row one place towards either end', () => {
  const ids = ['a', 'b', 'c']
  assert.deepEqual(planStep(ids, 'c', -1), { beforeSessionId: 'b' })
  assert.deepEqual(planStep(ids, 'a', 1), { beforeSessionId: 'c' })
  assert.deepEqual(planStep(ids, 'b', -1), { beforeSessionId: 'a' })
  assert.deepEqual(planStep(ids, 'b', 1), {})
})

test('planStep refuses a row that is already at that end', () => {
  assert.equal(planStep(['a', 'b'], 'a', -1), undefined)
  assert.equal(planStep(['a', 'b'], 'b', 1), undefined)
  assert.equal(planStep(['only'], 'only', -1), undefined)
  assert.equal(planStep(['only'], 'only', 1), undefined)
  assert.equal(planStep([], 'a', -1), undefined)
  assert.equal(planStep(['a', 'b'], 'session-x', 1), undefined)
})

test('a single row has no other place to be', () => {
  assert.equal(planMove(['only'], 'only', 0), undefined)
  assert.equal(planMove(['only'], 'only', 1), undefined)
})

test('the planned anchor rebuilds the order the gesture meant', () => {
  const ids = ['a', 'b', 'c', 'd']
  assert.deepEqual(applyMove(ids, 'd', planMove(ids, 'd', 0)), ['d', 'a', 'b', 'c'])
  assert.deepEqual(applyMove(ids, 'a', planMove(ids, 'a', 3)), ['b', 'c', 'd', 'a'])
  assert.deepEqual(applyMove(ids, 'b', planStep(ids, 'b', 1)), ['a', 'c', 'b', 'd'])
  assert.deepEqual(applyMove(ids, 'c', planStep(ids, 'c', -1)), ['a', 'c', 'b', 'd'])
})
