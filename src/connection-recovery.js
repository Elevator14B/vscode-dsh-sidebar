/**
 * Page-side connection reporter.
 *
 * It reports DSH's own connection state to the host and reconnects when the host
 * asks. Every recovery decision — when to reconnect, when to rebuild the page,
 * when to restart the runtime — lives in the Extension Host, so this module owns
 * no timers, no retry ladder and no thresholds of its own.
 */
globalThis.__DSH_INSTALL_RECOVERY__ = function (services, post) {
  'use strict'
  var connection = services && services.connection
  // A page can boot before the connection service is mounted. Recovery belongs
  // to the host, so an absent service keeps this module inert (and new-session
  // usable) instead of breaking the bundle that carries it.
  if (!connection || !connection.state) {
    return { handle: function () {}, connected: function () { return true }, dispose: function () {} }
  }
  var disposed = false

  function current() {
    return connection.state.getSnapshot() || 'connecting'
  }

  function publish() {
    if (!disposed) post({ type: 'connection-status', connection: current() })
  }

  var off = connection.state.subscribe(publish)
  publish()

  return {
    /** The host asked for a reconnect; DSH itself owns the reconnection. */
    handle: function (message) {
      if (message.type === 'reconnect-page') {
        connection.reconnect()
        publish()
      }
    },
    connected: function () { return current() === 'connected' },
    dispose: function () {
      disposed = true
      off()
    },
  }
};
