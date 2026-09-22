/** Local webview shell: it reports liveness and renders the host's status. */
(function () {
  'use strict'
  var config = globalThis.__DSH_SHELL_CONFIG__
  var vscode = acquireVsCodeApi()
  var frame = document.getElementById('frame')
  var banner = document.getElementById('connection-status')
  var label = document.getElementById('connection-label')
  var zh = config.locale.toLowerCase().startsWith('zh')
  var texts = {
    connecting: ['Reconnecting to DSH…', '正在重连 DSH…'],
    rebuilding: ['Rebuilding the page connection…', '正在重建页面连接…'],
    restarting: ['Starting the DSH runtime…', '正在启动 DSH 运行时…'],
    offline: ['Waiting for the remote connection…', '等待远端连接恢复…'],
  }

  function post(message) {
    vscode.postMessage(Object.assign({ source: 'dsh-vscode-shell', pageId: config.pageId }, message))
  }

  function render(status) {
    var entry = texts[status]
    banner.hidden = entry === undefined
    if (entry !== undefined) label.textContent = zh ? entry[1] : entry[0]
  }

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data) return
    if (event.source === frame.contentWindow) {
      if (data.source === 'dsh-vscode-bridge') vscode.postMessage(Object.assign({}, data, { pageId: config.pageId }))
      return
    }
    if (data.__dshHost !== true) return
    if (data.pageId !== undefined && data.pageId !== config.pageId) return
    // The host owns the recovery state machine; this shell only renders it.
    if (data.type === 'status') { render(data.status); return }
    frame.contentWindow.postMessage(Object.assign({ __dshHost: true, source: 'dsh-vscode-host' }, data), '*')
  })
  frame.addEventListener('load', function () { post({ type: 'iframe-load' }) })
  frame.addEventListener('error', function () { post({ type: 'iframe-error' }) })
  post({ type: 'shell-ready' })
  var timer = setInterval(function () { post({ type: 'shell-alive' }) }, 3000)
  window.addEventListener('pagehide', function () { clearInterval(timer) })
})()
