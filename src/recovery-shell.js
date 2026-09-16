/** Local webview shell: EH round trips remain independent of iframe data health. */
(function () {
  'use strict'
  var config = globalThis.__DSH_SHELL_CONFIG__
  var vscode = acquireVsCodeApi()
  var frame = document.getElementById('frame')
  var banner = document.getElementById('connection-status')
  var label = document.getElementById('connection-label')
  var retry = document.getElementById('connection-retry')
  var reload = document.getElementById('connection-reload')
  var zh = config.locale.toLowerCase().startsWith('zh')
  var born = Date.now()
  var lastPong = born
  var lastBridge = born
  var bridgeSeen = false
  var hostLost = false
  var state = null
  var forwardingChanged = false
  var lastSummary = ''
  var forwardedOnce = false
  var lastOpen = null
  var openTimer = null

  function post(message) {
    vscode.postMessage(Object.assign({ source: 'dsh-vscode-shell', pageId: config.pageId }, message))
  }
  function send(message) {
    frame.contentWindow.postMessage(Object.assign({ __dshHost: true, source: 'dsh-vscode-host' }, message), '*')
  }
  function words(en, cn) { return zh ? cn : en }
  retry.textContent = words('Reconnect', '重新连接')
  reload.textContent = words('Reload page', '重新加载页面')
  reload.title = words('Reloads this page; unsent drafts may be lost. The agent keeps running.', '重新加载此页面，未发送草稿可能丢失。后台任务继续运行。')

  function render() {
    var now = Date.now()
    var lost = now - lastPong > 10000
    if (hostLost && !lost) {
      post({ type: 'repair-forwarding', requestId: 'host-returned-' + String(now) })
      send({ type: 'reconnect-page' })
    }
    hostLost = lost
    var message = ''
    if (lost) message = words('Waiting for the remote extension connection…', '等待远端扩展连接恢复…')
    else if (!bridgeSeen || now - lastBridge > 12000) {
      if (now - born > 10000) message = words('The DSH page is not responding. Reconnect or reload the page.', 'DSH 页面没有响应，请重新连接或重新加载页面。')
    } else if (forwardingChanged) message = words('Port forwarding changed. Reload the page to reconnect.', '端口转发地址已变化，请重新加载页面。')
    else if (state) {
      if (state.reloadRequired) message = words('Port forwarding changed. Reload the page to reconnect.', '端口转发地址已变化，请重新加载页面。')
      else if (state.proxy === 'unavailable') message = words('Cannot reach the forwarded DSH page. Reconnecting…', '无法连接转发后的 DSH 页面，正在重连…')
      else if (state.backend === 'unavailable') message = words('The DSH backend did not answer the health check. Retry or check the output log.', 'DSH 后端未通过健康检查，请重试或查看输出日志。')
      else if (state.stalled) message = words('History loading timed out. Reconnecting; you can retry or reload the page.', '历史加载超时。正在尝试重连，也可重试或重新加载页面。')
      else if (state.connection !== 'connected') message = words('Reconnecting to DSH… Message delivery may be unconfirmed; check history before resending.', '正在重连 DSH… 消息可能尚未确认，请查看历史后再决定是否重发。')
      if (message && state.exhausted) message += words(' Automatic recovery did not finish.', ' 自动恢复尚未成功。')
    }
    banner.hidden = message === ''
    label.textContent = message
    retry.disabled = lost
    reload.disabled = lost
    // Log transitions, never each heartbeat or the conversation contents.
    var summary = JSON.stringify({ host: lost ? 'disconnected' : 'connected', bridge: bridgeSeen && now - lastBridge <= 12000,
      connection: state && state.connection, proxy: state && state.proxy, backend: state && state.backend,
      history: state && state.history, stalled: state && state.stalled, exhausted: state && state.exhausted })
    if (summary !== lastSummary) {
      lastSummary = summary
      post({ type: 'recovery-status', health: JSON.parse(summary) })
    }
    if (message && (!bridgeSeen || now - lastBridge > 12000) && !lost && !forwardedOnce && now - born > 15000) {
      forwardedOnce = true
      post({ type: 'repair-forwarding', requestId: 'shell-repair-' + String(now) })
    }
    if (!message) forwardedOnce = false
  }

  retry.addEventListener('click', function () {
    post({ type: 'repair-forwarding', requestId: 'manual-' + String(Date.now()) })
    send({ type: 'reconnect-page' })
  })
  reload.addEventListener('click', function () { post({ type: 'reload-page' }) })
  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data) return
    if (event.source === frame.contentWindow && data.source === 'dsh-vscode-bridge') {
      if (data.type === 'bridge-loaded') {
        bridgeSeen = true
        lastBridge = Date.now()
        post({ type: 'shell-bridge-seen' })
      }
      if (data.type === 'connection-status') { state = data; lastBridge = Date.now(); render() }
      vscode.postMessage(Object.assign({}, data, { pageId: config.pageId }))
      return
    }
    if (event.source === frame.contentWindow) return
    if (data.__dshHost !== true || (data.pageId !== undefined && data.pageId !== config.pageId)) return
    if (data.type === 'host-pong') {
      if (typeof data.sentAt === 'number' && Date.now() - data.sentAt < 6000) lastPong = Date.now()
      render()
      return
    }
    if (data.type === 'forwarding-result') {
      if (typeof data.url === 'string' && new URL(data.url).origin !== new URL(frame.src).origin) {
        forwardingChanged = true
      } else if (typeof data.url === 'string' && !String(data.requestId || '').startsWith('repair-')) {
        send({ type: 'reconnect-page' })
      }
      render()
    }
    if (data.type === 'open-session') {
      // Buffered VS Code commands arrive in a burst after reconnect. Only the
      // final selection should open a history stream.
      lastOpen = data
      if (openTimer !== null) clearTimeout(openTimer)
      openTimer = setTimeout(function () { send(lastOpen); lastOpen = null; openTimer = null }, 100)
      return
    }
    send(data)
  })
  frame.addEventListener('load', function () { post({ type: 'iframe-load' }) })
  frame.addEventListener('error', function () { post({ type: 'iframe-error' }) })
  window.addEventListener('error', function (event) { post({ type: 'shell-error', message: String(event.message || 'unknown') }) })
  window.addEventListener('unhandledrejection', function (event) { post({ type: 'shell-rejection', message: String(event.reason || 'unknown') }) })
  post({ type: 'shell-ready' })
  function tick() {
    post({ type: 'host-ping', sentAt: Date.now() })
    post({ type: 'shell-heartbeat' })
    render()
  }
  tick()
  var timer = setInterval(tick, 3000)
  window.addEventListener('pagehide', function () { clearInterval(timer); if (openTimer !== null) clearTimeout(openTimer) })
})()
