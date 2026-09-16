/** Page recovery uses public DSH services; it never restarts a backend or resends a prompt. */
globalThis.__DSH_INSTALL_RECOVERY__ = function (services, post, config) {
  'use strict'
  var connection = services.connection
  var sessions = services.sessions
  var disposed = false
  var currentId
  var currentSession
  var offSession = function () {}
  var loadingAt = null
  var history = 'idle'
  var proxy = 'checking'
  var backend = 'unknown'
  var unhealthyAt = null
  var attempt = 0
  var lastAttemptAt = 0
  var lastProbeAt = -Infinity
  var probeController = null
  var lastHistoryKey = ''
  var forwardingId = null
  var forwardingAt = 0
  var reloadRequired = false
  var lastConnected = connection.state.getSnapshot()

  function readSession() {
    var id = sessions.list.getSnapshot().current
    var binding = id === undefined ? undefined : sessions.binding(id)
    var session = binding && binding.session
    if (session !== currentSession || id !== currentId) {
      offSession()
      currentId = id
      currentSession = session
      loadingAt = null
      offSession = session ? session.subscribe(readSession) : function () {}
    }
    var snapshot = currentSession && currentSession.getSnapshot()
    history = snapshot ? snapshot.openState : 'idle'
    var elapsed = loadingAt === null ? 0 : Date.now() - loadingAt
    if (history === 'loading') {
      if (loadingAt === null) loadingAt = Date.now()
    } else loadingAt = null
    var key = String(id) + ':' + history
    if (key !== lastHistoryKey) {
      lastHistoryKey = key
      post({ type: 'history-state', sessionId: id, history: history, elapsedMs: elapsed })
    }
  }

  function publish() {
    if (disposed) return
    var elapsed = loadingAt === null ? 0 : Date.now() - loadingAt
    post({
      type: 'connection-status', connection: connection.state.getSnapshot() || 'connecting',
      proxy: proxy, backend: backend, history: history, sessionId: currentId,
      elapsedMs: elapsed, attempts: attempt, reloadRequired: reloadRequired,
      stalled: elapsed >= 15000, exhausted: attempt >= 2 && Date.now() - lastAttemptAt >= 10000,
      runtimeId: config.runtimeId,
    })
  }

  async function probe() {
    if (probeController !== null || disposed) return
    lastProbeAt = Date.now()
    var controller = new AbortController()
    probeController = controller
    var reachedProxy = false
    var timer = setTimeout(function () { controller.abort() }, 4000)
    try {
      var response = await fetch('/__dsh_vscode_health', { cache: 'no-store', signal: controller.signal })
      var health = await response.json()
      if (!response.ok || health.protocol !== 'dsh-sidebar-health-v1' || health.runtimeId !== config.runtimeId) {
        throw new Error('unexpected proxy identity')
      }
      reachedProxy = true
      proxy = 'ready'
      // Read the backend only during recovery. The normal data connection is
      // its own readiness signal; avoid polling the entire session list when idle.
      if (unhealthyAt !== null) {
        var result = await fetch('/api/session/list', {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ type: 'client-request', rpcId: 'sidebar-health', method: 'session/list', payload: { args: { _request: {} } } }),
        })
        var body = await result.json()
        backend = result.ok && body.result && body.result.ok === true ? 'ready' : 'unavailable'
      }
    } catch (_error) {
      if (!reachedProxy) proxy = 'unavailable'
      else backend = 'unavailable'
    } finally {
      clearTimeout(timer)
      probeController = null
      publish()
    }
  }

  function reconnect(reason) {
    post({ type: 'connection-reconnect', reason: reason, attempts: attempt, sessionId: currentId })
    connection.reconnect()
  }

  function tick() {
    if (disposed) return
    readSession()
    var now = Date.now()
    var connected = connection.state.getSnapshot() === 'connected'
    var stalled = loadingAt !== null && now - loadingAt >= 15000
    var unhealthy = !connected || stalled || proxy === 'unavailable' || backend === 'unavailable' || reloadRequired
    if (!unhealthy) {
      unhealthyAt = null
      attempt = 0
      backend = 'ready'
    } else {
      if (unhealthyAt === null) unhealthyAt = now
      if (now - unhealthyAt >= 6000 && now - lastAttemptAt >= 10000 && attempt < 2 && !reloadRequired) {
        attempt++
        lastAttemptAt = now
        if (attempt === 1) reconnect(stalled ? 'history-timeout' : 'connection-lost')
        else {
          forwardingId = 'repair-' + String(now)
          forwardingAt = now
          post({ type: 'repair-forwarding', requestId: forwardingId })
        }
      }
    }
    if (forwardingId !== null && now - forwardingAt >= 6000) {
      forwardingId = null
      reconnect('forwarding-response-timeout')
    }
    if (now - lastProbeAt >= 10000) void probe()
    publish()
  }

  function handle(message) {
    if (message.type === 'reconnect-page') {
      attempt = 0
      unhealthyAt = Date.now()
      lastAttemptAt = 0
      reloadRequired = false
      reconnect('manual')
      void probe()
    } else if (message.type === 'forwarding-result' && message.requestId === forwardingId) {
      forwardingId = null
      if (typeof message.url === 'string' && new URL(message.url).origin !== location.origin) reloadRequired = true
      else reconnect('forwarding-repaired')
      publish()
    }
  }

  var offList = sessions.list.subscribe(readSession)
  var offConnection = connection.state.subscribe(function () {
    var next = connection.state.getSnapshot()
    if (next !== lastConnected) {
      lastConnected = next
      post({ type: 'data-connection-state', connection: next || 'connecting' })
    }
    publish()
  })
  readSession()
  tick()
  var timer = setInterval(tick, 3000)
  return {
    handle: handle,
    connected: function () { return connection.state.getSnapshot() === 'connected' },
    dispose: function () {
      disposed = true
      clearInterval(timer)
      offList()
      offSession()
      offConnection()
      if (probeController !== null) probeController.abort()
    },
  }
};
