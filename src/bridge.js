/*
 * Boot-injected VS Code bridge for the DeepSeek Harness web GUI.
 *
 * The extension proxy injects this classic script at the end of <head> after
 * the Host has written globalThis.__DSH_BOOT__. It queues one synthetic client
 * module into __ModuleLoader__ (the remote-URI row plus factory), appends that
 * row to an existing application batch, and then contributes one ordinary
 * Cordis plugin. The plugin owns auto-pinning the Host Workspace to the VS
 * Code folder, chip insertion from VS Code drags, and native file/diff opens.
 */
(function () {
  'use strict'

  var FLAG = '__DSH_VSCODE_BRIDGE_INSTALLED__'
  if (globalThis[FLAG] === true) return
  Object.defineProperty(globalThis, FLAG, { value: true })

  var PLUGIN_ID = '@dsh/vscode-embed-bridge'
  var HOST_SOURCE = 'dsh-vscode-host'
  var BRIDGE_SOURCE = 'dsh-vscode-bridge'
  var config = globalThis.__DSH_VSCODE__ || {}
  var workspacePath = typeof config.cwd === 'string' ? config.cwd : ''
  var canonicalWorkspacePath = typeof config.canonicalCwd === 'string' && config.canonicalCwd !== ''
    ? config.canonicalCwd
    : workspacePath
  var debug = { plugin: false, current: null, queued: 0, attempts: [], results: [], lastInputFailure: '', errors: [] }
  try {
    Object.defineProperty(globalThis, '__DSH_VSCODE_DEBUG__', { value: debug, configurable: true })
  } catch (_error) {
    /* diagnostics are optional */
  }

  function post(message) {
    try {
      globalThis.parent.postMessage(Object.assign({ source: BRIDGE_SOURCE }, message), '*')
    } catch (_error) {
      /* parent may be unavailable while the iframe is being created */
    }
  }

  function applyTheme(mode) {
    var dark = mode !== 'light'
    try {
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
      document.body.toggleAttribute('data-ds-dark-theme', dark)
    } catch (_error) {
      /* theme sync is best-effort */
    }
  }

  var lastConfiguredTheme = null
  /**
   * Apply the VS Code theme through the app's own ThemeRuntime when the client
   * tree is up. The embed cannot reach the settings UI, and the theme
   * preference lives in the machine-wide settings document shared by every
   * DSH web window, so ThemeRuntime's persistence scope is made page-local
   * first: `setTheme` still flips the in-memory preference and emits
   * `theme/change` (which drives the real presenter), but writes nothing.
   * Before the tree activates no service exists: write the DOM fields the
   * boot script already used as a first-paint fallback.
   */
  function applyThemeThroughService(mode) {
    var themeService = state && state.services && state.services.theme
    if (themeService && typeof themeService.setTheme === 'function') {
      try {
        var host = themeService.host
        if (host !== undefined && typeof host.set === 'function' && host.__dshVscodePageLocal !== true) {
          host.__dshVscodePageLocal = true
          host.set = function () { return Promise.resolve() }
        }
        themeService.setTheme(mode === 'light' ? 'light' : 'dark')
        return
      } catch (_error) {
        /* invalid id or service error: fall through to direct DOM fields */
      }
    }
    applyTheme(mode)
  }

  let requestSeq = 0
  var pendingRequests = new Map()
  function requestHost(requestType, payload) {
    var requestId = 'dsh-' + String(Date.now()) + '-' + String(++requestSeq)
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        pendingRequests.delete(requestId)
        resolve(null)
      }, 2500)
      pendingRequests.set(requestId, function (value) {
        clearTimeout(timer)
        pendingRequests.delete(requestId)
        resolve(value)
      })
      post({ type: 'request', requestType: requestType, requestId: requestId, payload: payload })
    })
  }

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || data.source !== HOST_SOURCE) return
    if (data.type === 'configure') {
      if (typeof data.theme === 'string') {
        lastConfiguredTheme = data.theme
        applyThemeThroughService(data.theme)
      }
      post({ type: 'configure-ack' })
      return
    }
    if (recovery !== null) recovery.handle(data)
    if (data.type === 'new-session' && recovery !== null && !recovery.connected()) {
      post({ type: 'new-session-error', message: 'DSH is reconnecting. Retry after the connection is restored.' })
      return
    }
    if (data.type === 'new-session') {
      pendingNewSessions += 1
      flushNewSessions()
      return
    }
    if (data.type === 'retry-workspace') {
      resetPinFailure()
      if (triggerPin !== null) triggerPin()
      return
    }
    if (data.type === 'open-session' && typeof data.sessionId === 'string') {
      pendingOpens = [data.sessionId]
      pendingOpenAt = Date.now()
      if (pendingOpenTimer !== null) clearTimeout(pendingOpenTimer)
      pendingOpenTimer = setTimeout(function () { pendingOpenTimer = null; flushOpens() }, 15000)
      flushOpens()
      return
    }
    if (data.type === 'insert-refs' && Array.isArray(data.refs)) {
      post({ type: 'insert-refs-received', count: data.refs.length })
      queueReferences(data.refs)
      post({ type: 'insert-refs-applied', count: data.refs.length })
      return
    }
    if (data.type === 'response' && data.requestId) {
      var settle = pendingRequests.get(String(data.requestId))
      if (settle) settle(data.value === undefined ? null : data.value)
    }
  })

  // ---- synthetic openWorkspacePath interception -----------------------------

  /** The request URL of one `fetch` call: a string, a `URL`, or a `Request`. */
  function fetchUrl(input) {
    if (typeof input === 'string') return input
    if (!input || typeof input !== 'object') return ''
    // The client transport passes a URL instance (`new URL(channel/endpoint, base)`),
    // which carries `href`; a Request carries `url`. String-only detection
    // silently missed every RPC call.
    if (typeof input.href === 'string') return input.href
    return typeof input.url === 'string' ? input.url : ''
  }

  var nativeFetch = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null
  if (nativeFetch !== null) {
    globalThis.fetch = function (input, init) {
      try {
        var url = fetchUrl(input)
        if (url.indexOf('/api/session/openWorkspacePath') !== -1 && init && typeof init.body === 'string') {
          var message = JSON.parse(init.body)
          var path = message && message.payload && message.payload.args
            && message.payload.args.request && message.payload.args.request.path
          if (typeof path === 'string' && path.length > 0) {
            post({ type: 'open-file', path: path })
            return Promise.resolve(new Response(JSON.stringify({
              type: 'server-response',
              rpcId: message.rpcId,
              result: { ok: true, value: { opened: true } },
            }), { status: 200, headers: { 'content-type': 'application/json' } }))
          }
        }
      } catch (_error) {
        /* malformed request bodies fall through to the real transport */
      }
      return nativeFetch(input, init)
    }
  }

  // ---- path and drag helpers ------------------------------------------------

  function toPosix(value) {
    return String(value || '').replace(/\\/g, '/')
  }
  function trimTrailingSlash(value) {
    var out = toPosix(value)
    while (out.length > 1 && out.charAt(out.length - 1) === '/') out = out.slice(0, -1)
    return out
  }
  function normalizeCompare(value) {
    var out = trimTrailingSlash(value)
    return /^win/i.test(navigator.platform || '') ? out.toLowerCase() : out
  }
  /**
   * Match a Host Workspace path against either the VS Code folder path or its
   * canonical realpath. DSH stores Workspaces under the backend's resolved
   * path, while VS Code may report a symlinked/bind-mounted form.
   */
  function workspacePathMatches(candidate) {
    var value = typeof candidate === 'string' ? candidate : ''
    if (workspacePath === '') return false
    if (normalizeCompare(value) === normalizeCompare(workspacePath)) return true
    return canonicalWorkspacePath !== '' && normalizeCompare(value) === normalizeCompare(canonicalWorkspacePath)
  }
  function relativeToWorkspace(absolute) {
    var abs = trimTrailingSlash(absolute)
    var root = trimTrailingSlash(workspacePath)
    if (root === '') return abs
    var compareAbs = normalizeCompare(abs)
    var compareRoot = normalizeCompare(root)
    if (compareAbs === compareRoot) return abs.slice(abs.length - 1) === '/' ? abs : abs
    if (compareAbs.indexOf(compareRoot + '/') === 0) return abs.slice(root.length + 1)
    return abs
  }

  /** The cwd the client records for one listed Session, when it is known. */
  function sessionCwd(sessionId) {
    var services = state.services
    if (services === null || !services.sessions) return undefined
    var summary = services.sessions.list.getSnapshot().byId[sessionId]
    return summary === undefined || typeof summary.cwd !== 'string' ? undefined : summary.cwd
  }

  /**
   * Resolve one `dsh-resource://file/…` address to the absolute path an editor
   * opens. The grammar is the client's `fileAddressFor`: the scope segment is
   * `session` (path relative to that Session's workspace root) or `absolute`
   * (leading `/` dropped, `:` kept for a drive letter), and every segment is
   * component-encoded.
   */
  function filePathOfAddress(address) {
    if (typeof address !== 'string' || address.indexOf('dsh-resource://file/') !== 0) return undefined
    var url
    try {
      url = new URL(address)
    } catch (_error) {
      return undefined
    }
    if (url.protocol !== 'dsh-resource:' || url.host !== 'file') return undefined
    var segments
    try {
      segments = url.pathname.split('/').map(function (segment) { return decodeURIComponent(segment) })
    } catch (_error) {
      return undefined
    }
    var scope = segments[1]
    var rest = segments.slice(2)
    if (scope === 'session') {
      var sessionId = rest[0]
      var relative = rest.slice(1).join('/')
      if (sessionId === undefined || sessionId === '' || relative === '') return undefined
      var base = sessionCwd(sessionId)
      if (base === undefined || base === '') base = workspacePath
      if (base === '') return undefined
      return trimTrailingSlash(base) + '/' + relative
    }
    if (scope === 'absolute') {
      // An empty first segment with more behind it is a UNC path's `//`.
      var unc = rest[0] === '' && rest.length > 1
      var parts = unc ? rest.slice(1) : rest
      if (parts.length === 0 || parts[0] === '') return undefined
      if (unc) return '//' + parts.join('/')
      return /^[A-Za-z]:$/.test(parts[0]) ? parts.join('/') : '/' + parts.join('/')
    }
    return undefined
  }

  function parseSelectionFragment(fragment) {
    var match = /^#?L?(\d+)(?:,(\d+))?(?:-L?(\d+)(?:,(\d+))?)?$/.exec(String(fragment || ''))
    if (!match) return {}
    var start = Number(match[1])
    var end = match[3] ? Number(match[3]) : start
    return { startLine: start, endLine: end }
  }
  function fileUriParts(uriText) {
    try {
      var url = new URL(uriText)
      if (url.protocol !== 'file:' && url.protocol !== 'vscode-remote:') return null
      var pathname = decodeURIComponent(url.pathname)
      if (url.protocol === 'file:' && /^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1)
      if (url.protocol === 'file:' && url.hostname && url.hostname !== 'localhost') pathname = '//' + url.hostname + pathname
      return { path: pathname, fragment: url.hash.slice(1) }
    } catch (_error) {
      return null
    }
  }
  function formatMention(relative, startLine, endLine) {
    var location = startLine
      ? '#L' + String(startLine) + (endLine && endLine > startLine ? '-L' + String(endLine) : '')
      : ''
    var needsQuote = /[\s"#]/.test(relative)
    var base = needsQuote ? '@"' + relative.replace(/"/g, '') + '"' : '@' + relative
    return base + location
  }
  function formatLabel(relative, startLine, endLine) {
    if (!startLine) return relative
    return relative + ':' + String(startLine) + (endLine && endLine > startLine ? '-' + String(endLine) : '')
  }
  function fallbackRefs(entries) {
    var refs = []
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i]
      var uri = entry && typeof entry.uri === 'string' ? entry.uri : null
      if (!uri) continue
      var parts = fileUriParts(uri)
      if (parts === null) continue
      var selection = parseSelectionFragment(parts.fragment)
      var relative = relativeToWorkspace(parts.path)
      refs.push({
        path: parts.path,
        mention: formatMention(relative, selection.startLine, selection.endLine),
        label: formatLabel(relative, selection.startLine, selection.endLine),
        appearance: 'file',
      })
    }
    return refs
  }
  /** Read one drag payload type; synthetic drags may not implement getData. */
  function readDragData(dataTransfer, type) {
    if (!dataTransfer || typeof dataTransfer.getData !== 'function') return ''
    try {
      var value = dataTransfer.getData(type)
      return typeof value === 'string' ? value : ''
    } catch (_error) {
      return ''
    }
  }

  /**
   * The drag payload as ordered entries for the host. URI lines come first
   * (one entry each), then the dragged `text/plain` — kept even when a URI
   * list parsed, because an editor drag carries the exact selection range
   * there — and the raw `vscode-editor-data` JSON. Dropping the text whenever
   * a URI line parsed is what turned a line-range editor drag into a
   * whole-file reference.
   */
  function rawEntries(dataTransfer) {
    var entries = []
    var seen = new Set()
    function addUri(value) {
      if (typeof value !== 'string' || value === '') return
      if (seen.has(value)) return
      seen.add(value)
      entries.push({ uri: value })
    }
    var uriList = ''
    var customs = [
      'application/vnd.code.internalUriList',
      'application/vnd.code.uri-list',
      'text/uri-list',
    ]
    for (var i = 0; i < customs.length; i++) {
      var candidate = readDragData(dataTransfer, customs[i])
      if (candidate) {
        uriList = candidate
        break
      }
    }
    uriList.split(/\r?\n/).forEach(function (line) {
      var trimmed = line.trim()
      if (trimmed !== '' && trimmed.charAt(0) !== '#') addUri(trimmed)
    })
    var resources = readDragData(dataTransfer, 'application/vnd.code.resources')
    if (resources) {
      try {
        var parsed = JSON.parse(resources)
        if (Array.isArray(parsed)) parsed.forEach(addUri)
      } catch (_error) {
        /* resource payload is advisory; text/uri-list remains the fallback */
      }
    }
    var text = readDragData(dataTransfer, 'text/plain')
    if (text.trim() !== '' && text.length <= 20000 && !seen.has(text.trim())) {
      entries.push({ text: text })
    }
    var editorData = readDragData(dataTransfer, 'vscode-editor-data')
    if (editorData !== '') entries.push({ editorData: editorData })
    return entries
  }

  /**
   * The drag payload types that may carry a reference: every MIME type VS Code
   * uses for editor selections, Explorer rows, and editor tabs. `types` is
   * lowercased by the browser, hence the lowercase custom types.
   */
  var REFERENCE_DRAG_TYPES = [
    'text/plain',
    'text/uri-list',
    'application/vnd.code.uri-list',
    'application/vnd.code.internalurilist',
    'application/vnd.code.resources',
    'resourceurls',
    'codeeditors',
    'vscode-editor-data',
    'files',
  ]
  function dragMayReference(dataTransfer) {
    if (!dataTransfer) return false
    var types = Array.prototype.slice.call(dataTransfer.types || [])
    for (var i = 0; i < types.length; i++) {
      if (REFERENCE_DRAG_TYPES.indexOf(String(types[i]).toLowerCase()) !== -1) return true
    }
    return false
  }

  // ---- drop hint ------------------------------------------------------------

  var style = document.createElement('style')
  style.textContent = [
    '.dsh-vscode-drop-hint{position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;background:color-mix(in srgb, var(--dsw-alias-bg-base, #101418) 72%, transparent);pointer-events:none;font:500 13px/1.4 system-ui,sans-serif;color:var(--dsw-alias-label-primary,#e6edf3);backdrop-filter:blur(2px)}',
    '.dsh-vscode-drop-hint[data-active]{display:flex}',
    '.dsh-vscode-drop-hint>span{border:1px dashed var(--dsw-alias-border-l2,#3b4754);border-radius:12px;background:var(--dsw-alias-bg-base,#101418);padding:10px 16px;box-shadow:0 8px 28px rgb(0 0 0/.32)}',
  ].join('')
  document.documentElement.appendChild(style)
  var dropHint = document.createElement('div')
  dropHint.className = 'dsh-vscode-drop-hint'
  dropHint.innerHTML = '<span>Drop to reference in the agent</span>'
  document.documentElement.appendChild(dropHint)
  function showDropHint(active) {
    dropHint.toggleAttribute('data-active', Boolean(active))
  }

  // ---- insertion state (filled by the Cordis bridge plugin) -----------------

  var state = {
    services: null,
    input: null,
    inputSessionId: null,
    pendingRefs: [],
  }

  // ---- workspace pin supervision -------------------------------------------
  // Bounded retries with one explicit error instead of a silent infinite loop.
  var MAX_PIN_ATTEMPTS = 4
  var PIN_RETRY_MS = 800
  var pinAttempts = 0
  var pinInFlight = false
  var pinFailed = false
  var pinRetryTimer = null
  var pinError = ''
  var triggerPin = null

  function resetPinFailure() {
    pinAttempts = 0
    pinFailed = false
    pinError = ''
  }
  function reportPinFailure(message) {
    if (pinFailed) return
    pinFailed = true
    pinError = message
    post({
      type: 'workspace-error',
      path: workspacePath,
      canonicalPath: canonicalWorkspacePath,
      message: message,
    })
  }
  function schedulePinCheck(delay) {
    if (pinFailed || pinRetryTimer !== null) return
    pinRetryTimer = setTimeout(function () {
      pinRetryTimer = null
      if (!pinFailed && triggerPin !== null) triggerPin()
    }, delay || PIN_RETRY_MS)
  }

  var recovery = null
  var pendingOpens = []
  var pendingOpenAt = 0
  var pendingOpenTimer = null
  function flushOpens() {
    if (pinInFlight || state.services === null || !state.services.sessions || (recovery !== null && !recovery.connected())) return
    if (state.services.sessions.list.getSnapshot().phase !== 'ready' || pendingOpens.length === 0) return
    if (state.services.workspaces.list.getSnapshot().phase !== 'ready') return
    var id = pendingOpens[pendingOpens.length - 1]
    if (state.services.sessions.list.getSnapshot().byId[id] === undefined) {
      if (Date.now() - pendingOpenAt < 15000) return
      pendingOpens = []
      post({ type: 'open-session-error', sessionId: id, message: 'Session did not appear in the refreshed catalog. Reconnect and retry.' })
      return
    }
    if (pendingOpenTimer !== null) { clearTimeout(pendingOpenTimer); pendingOpenTimer = null }
    // Opening synchronously publishes a new selection; detach the pending
    // request before subscribers can re-enter this function.
    pendingOpens = []
    try {
      if (!sessionInScope(id)) throw outOfScope('session', id)
      state.services.sessions.open(id)
      post({ type: 'open-session-received', sessionId: id })
    } catch (error) {
      post({ type: 'open-session-error', sessionId: id, message: String(error) })
    }
  }

  var pendingNewSessions = 0
  /**
   * Run the web UI's own New Session flow for the pinned workspace: reuse an
   * existing blank session bound to the workspace, or create one via
   * `sessions.create({ workspaceId })`, then open it. A session created this
   * way is bound to the workspace, so the page keeps its workspace selection.
   */
  function startNewSession(attempt) {
    attempt = attempt || 0
    var services = state.services
    if (services === null || !services.workspaces || !services.uiWorkspace || !services.sessions) {
      post({ type: 'new-session-error', message: 'bridge services not ready' })
      return
    }
    if (workspacePath === '') {
      post({ type: 'new-session-error', message: 'workspace path is empty' })
      return
    }
    if (pinFailed) {
      post({ type: 'new-session-error', message: pinError || 'workspace is not available' })
      return
    }
    var list = services.workspaces.list.getSnapshot()
    var workspace = list.items.find(function (item) {
      return workspacePathMatches(item.path)
    })
    if (workspace === undefined) {
      if (attempt < MAX_PIN_ATTEMPTS) {
        // auto-pin is still creating the workspace; retry briefly, then fail loud.
        setTimeout(function () { startNewSession(attempt + 1) }, PIN_RETRY_MS)
        return
      }
      post({ type: 'new-session-error', message: 'workspace ' + workspacePath + ' was not created' })
      return
    }
    // The bridge's own connect bypasses the scope guard: this workspace is the
    // pinned one by construction, and the guard may not be installed yet.
    var connect = bridgeConnect === null ? services.uiWorkspace.connectWorkspace : bridgeConnect
    connect(workspace.workspaceId).then(function (sessionId) {
      try {
        services.sessions.open(sessionId)
        post({ type: 'new-session-ack', sessionId: sessionId })
      } catch (error) {
        post({ type: 'new-session-error', sessionId: sessionId, message: String(error) })
      }
    }).catch(function (error) {
      post({ type: 'new-session-error', message: String((error && error.message) || error) })
    })
  }
  function flushNewSessions() {
    if (state.services === null || pendingNewSessions === 0) return
    while (pendingNewSessions > 0) {
      pendingNewSessions -= 1
      startNewSession(0)
    }
  }

  var lastWorkspaceStateKey = null
  /**
   * Publish the pinned workspace's session order and archive set to the host
   * when either changes, so the native Sessions tree can mirror the web
   * sidebar's per-workspace list exactly (unbound "cwd-only" sessions stay out
   * of the tree, and an archived session leaves it without reordering the
   * rest). Both sets live on the same list snapshot and both belong in the
   * dedupe key: archiving changes nothing else, so a key built from the order
   * alone would swallow that publish.
   */
  function publishWorkspaceState() {
    var services = state.services
    if (services === null || !services.workspaces) return
    var list = services.workspaces.list.getSnapshot()
    var workspace = list.items.find(function (item) {
      return workspacePathMatches(item.path)
    })
    if (workspace === undefined) return
    var ids = workspace.sessionIds || []
    var archived = list.archivedSessionIds || []
    var key = ids.join(',') + '\u0000' + archived.join(',')
    if (key === lastWorkspaceStateKey) return
    lastWorkspaceStateKey = key
    post({
      type: 'workspace-state',
      workspaceId: workspace.workspaceId,
      sessionIds: ids.slice(),
      archivedSessionIds: archived.slice(),
    })
  }

  /** Coalesce window folding a live turn's frame burst into one repaint. */
  var SESSION_FACTS_DEBOUNCE_MS = 150

  /**
   * Row facts the native Sessions tree renders for the pinned workspace:
   * identity, label, blank/running icons, and the minute bucket of the age
   * column. Equal text means that view has nothing to repaint, so no message
   * crosses the bridge. Relative ages still move on the tree's own slow poll.
   */
  function sessionRowFacts(list) {
    var services = state.services
    if (services === null || !services.workspaces || !list) return ''
    var workspaces = services.workspaces.list.getSnapshot()
    var workspace = workspaces.items.find(function (item) {
      return workspacePathMatches(item.path)
    })
    if (workspace === undefined) return ''
    var rows = []
    var ids = workspace.sessionIds || []
    for (var index = 0; index < ids.length; index += 1) {
      var summary = list.byId[ids[index]]
      if (summary === undefined) continue
      rows.push([
        // The client list row spells its identity `id`; `sessionId` is the host
        // wire name and read as undefined here, which dropped row identity from
        // the signature. The ids are already the scan keys, so fall back to the
        // one being read rather than emitting an empty column.
        typeof summary.id === 'string' ? summary.id : ids[index],
        typeof summary.title === 'string' ? summary.title : '',
        summary.blank ? '1' : '0',
        summary.running ? '1' : '0',
        String(Math.floor((typeof summary.updatedAt === 'number' ? summary.updatedAt : 0) / 60000)),
      ].join('\u0000'))
    }
    return rows.join('\n')
  }

  /** Bridge-owned `uiWorkspace.connectWorkspace`, exempt from the scope guard. */
  var bridgeConnect = null

  /** Resolve the Workspace record the window is pinned to by folder path. */
  function pinnedWorkspace() {
    var services = state.services
    if (services === null || !services.workspaces) return undefined
    return services.workspaces.list.getSnapshot().items.find(function (item) {
      return workspacePathMatches(item.path)
    })
  }

  /**
   * The parent identity a client list row carries. The client projection spells
   * it `parentId` (`SessionSummary`); the host wire shape spells the same fact
   * `parentSessionId`, so accept either and keep the lineage walk working under
   * both — reading only the host name silently truncated every walk at one hop.
   */
  function parentSessionIdOf(summary) {
    if (typeof summary.parentId === 'string') return summary.parentId
    return typeof summary.parentSessionId === 'string' ? summary.parentSessionId : undefined
  }

  /**
   * Whether one Session identity belongs to the pinned folder: its recorded cwd
   * matches, or it descends from a Session that does (subagent children), or the
   * pinned Workspace owns it. An identity the list cannot vouch for is out of
   * scope — the embed only touches what it can prove is local.
   */
  function sessionInScope(sessionId) {
    var services = state.services
    if (services === null || !services.sessions) return true
    var list = services.sessions.list.getSnapshot()
    if (list.phase !== 'ready') return true
    var seen = {}
    var current = sessionId
    for (var depth = 0; depth < 8 && current !== undefined && seen[current] !== true; depth += 1) {
      seen[current] = true
      var summary = list.byId[current]
      if (summary === undefined) return false
      if (typeof summary.cwd === 'string' && workspacePathMatches(summary.cwd)) return true
      current = parentSessionIdOf(summary)
    }
    var workspace = pinnedWorkspace()
    return workspace !== undefined && workspace.sessionIds.indexOf(sessionId) !== -1
  }

  /** Whether one Workspace identity is the folder this window is pinned to. */
  function workspaceInScope(workspaceId) {
    var workspace = pinnedWorkspace()
    return workspace !== undefined && workspace.workspaceId === workspaceId
  }

  /** One caller-visible refusal for a target outside the pinned folder. */
  function outOfScope(what, id) {
    return new Error(what + ' "' + String(id) + '" is outside the folder this window is pinned to ('
      + workspacePath + ')')
  }

  /**
   * Refuse renaming a Session outside the pinned folder. Rename activates the
   * Session's writer, so a foreign row's rename would take its write lease; the
   * row action reads `result.error.message`, so the refusal keeps that face.
   */
  function guardRename(binding, sessionId) {
    var face = binding === undefined || binding === null ? undefined : binding.session
    if (face === undefined || typeof face.rename !== 'function' || face.__dshScopeGuarded === true) return
    try {
      Object.defineProperty(face, '__dshScopeGuarded', { value: true })
    } catch (_error) {
      // A non-extensible face keeps its own rename; the scope guard still
      // covers every other entry point.
      return
    }
    var rename = face.rename
    face.rename = function (title) {
      if (sessionInScope(sessionId)) return rename.call(face, title)
      return Promise.resolve({
        ok: false,
        error: { code: 'session/out-of-scope', message: outOfScope('session', sessionId).message },
      })
    }
  }

  /** Record why the input could not be resolved; '' once it resolves. */
  function noteInputFailure(reason) {
    lastInputReason = reason
    debug.lastInputFailure = reason
  }

  /**
   * The Session input facade insertion must go through, or null. Every refusal
   * records a short, stable `lastInputReason` so the queued refs report
   * exactly why they cannot land: 'no-session', 'no-scope: <sessionId>',
   * 'no-service' (no conversation service), or 'no-binding: <message>' when
   * conversation.input.for(scope) throws because the session shell has no
   * binding.
   */
  function resolveInput() {
    var services = state.services
    if (services === null || !services.sessions) {
      noteInputFailure('no-session')
      return null
    }
    var sessions = services.sessions
    var conversation = services.conversation
    var current = sessions.list.getSnapshot().current
    debug.current = current || null
    if (!current) {
      noteInputFailure('no-session')
      return null
    }
    if (state.input !== null && state.inputSessionId === current) {
      noteInputFailure('')
      return state.input
    }
    var scope = sessions.scope(current)
    if (!scope) {
      noteInputFailure('no-scope: ' + String(current))
      return null
    }
    if (!conversation) {
      noteInputFailure('no-service')
      return null
    }
    try {
      state.input = conversation.input.for(scope)
      state.inputSessionId = current
      noteInputFailure('')
      return state.input
    } catch (error) {
      var detail = error && typeof error.message === 'string' ? error.message : String(error)
      noteInputFailure('no-binding: ' + detail.slice(0, 160))
      return null
    }
  }

  function detectLength(inputState) {
    var length = inputState.draft.length
    var occurrences = inputState.occurrences || []
    for (var i = 0; i < occurrences.length; i++) {
      length = length - occurrences[i].length + 1
    }
    return length
  }

  // ---- reference insertion engine ------------------------------------------
  // A queued reference either lands as a chip, lands as visible draft text, is
  // reported pending and retried, or is reported failed. Silent retention is
  // not an outcome: every path posts one 'reference-result' to the host.

  /** Chips one drain pass inserts before yielding; a big drop must not block. */
  var REFERENCE_DRAIN_CHUNK = 8
  /** Bounded timer retries while no Session input can take the queue. */
  var REFERENCE_RETRY_LIMIT = 12
  var REFERENCE_RETRY_MS = 600

  var referenceRetryTimer = null
  var referenceRetryCount = 0
  var referenceDrainTimer = null
  var lastInputReason = 'no-session'

  /** One batch = the references of a single drop, reported together. */
  function createReferenceBatch(count, mentions) {
    return {
      count: count,
      mentions: mentions,
      inserted: 0,
      fallback: 0,
      remaining: count,
      attempts: 0,
      reason: '',
      pendingReported: false,
      reported: false,
    }
  }

  /** The batch behind one queued ref; every queued ref carries its own. */
  function batchOf(queued) {
    return queued && queued.batch ? queued.batch : null
  }

  /** The distinct batches still waiting in the queue, oldest first. */
  function pendingBatches() {
    var batches = []
    for (var i = 0; i < state.pendingRefs.length; i++) {
      var batch = batchOf(state.pendingRefs[i])
      if (batch !== null && batches.indexOf(batch) === -1) batches.push(batch)
    }
    return batches
  }

  /**
   * Post the batch outcome the host telemetry and the one deduplicated warning
   * read. `reason` is only meaningful for the non-inserted outcomes.
   */
  function reportReferenceResult(batch, outcome, reason) {
    var message = {
      type: 'reference-result',
      outcome: outcome,
      count: batch.count,
      mentions: batch.mentions.slice(0),
      attempts: batch.attempts,
    }
    if (typeof reason === 'string' && reason !== '') message.reason = reason
    debug.results.push({
      outcome: outcome,
      count: batch.count,
      attempts: batch.attempts,
      reason: message.reason || '',
    })
    if (debug.results.length > 20) debug.results.shift()
    post(message)
  }

  /** Count one attempt for every batch still waiting in the queue. */
  function noteReferenceAttempt() {
    var batches = pendingBatches()
    for (var i = 0; i < batches.length; i++) batches[i].attempts += 1
  }

  /** A resolvable input is only usable when the reference verb is present. */
  function inputCanInsert(input) {
    return Boolean(input)
      && typeof input.insertReference === 'function'
      && Boolean(input.state)
      && typeof input.state.getSnapshot === 'function'
  }

  /**
   * insertReference refuses on phase or stale draftRev. The span is built from
   * this same snapshot, so an accepted phase means the revision CAS lost.
   */
  function referenceRejectionReason(snapshot) {
    var phase = snapshot && typeof snapshot.phase === 'string' ? snapshot.phase : ''
    if (phase !== '' && phase !== 'plain' && phase !== 'claimed') return 'phase: ' + phase
    return 'draft-rev'
  }

  function cancelReferenceRetry() {
    if (referenceRetryTimer !== null) {
      clearTimeout(referenceRetryTimer)
      referenceRetryTimer = null
    }
  }

  /** Continue a chunked drain after the current task lets the page paint. */
  function scheduleReferenceDrain() {
    if (referenceDrainTimer !== null) return
    referenceDrainTimer = setTimeout(function () {
      referenceDrainTimer = null
      insertQueuedRefs()
    }, 0)
  }

  function cancelReferenceDrain() {
    if (referenceDrainTimer !== null) {
      clearTimeout(referenceDrainTimer)
      referenceDrainTimer = null
    }
  }

  /**
   * Retry the still-pending queue on a bounded timer. The Session-list change
   * subscription retries too, without spending this budget: a real state
   * change deserves its own attempt.
   */
  function scheduleReferenceRetry() {
    if (referenceRetryTimer !== null) return
    referenceRetryTimer = setTimeout(function () {
      referenceRetryTimer = null
      referenceRetryCount += 1
      if (referenceRetryCount > REFERENCE_RETRY_LIMIT) {
        failQueuedReferences()
        return
      }
      insertQueuedRefs()
    }, REFERENCE_RETRY_MS)
    // A Node harness must not be kept alive by the retry timer; browsers have
    // no unref and keep the timer as it is.
    if (referenceRetryTimer && typeof referenceRetryTimer.unref === 'function') referenceRetryTimer.unref()
  }

  /** The retry budget is spent: report the queue failed and stop holding it. */
  function failQueuedReferences() {
    cancelReferenceRetry()
    var batches = pendingBatches()
    for (var i = 0; i < batches.length; i++) {
      if (batches[i].reported) continue
      batches[i].reported = true
      reportReferenceResult(batches[i], 'failed', 'retries-exhausted')
    }
    state.pendingRefs.length = 0
    referenceRetryCount = 0
  }

  /** Report one finished batch: chips, visible text fallback, or nothing. */
  function reportBatch(batch) {
    if (batch.reported) return
    batch.reported = true
    if (batch.inserted === batch.count) {
      reportReferenceResult(batch, 'inserted', '')
      return
    }
    if (batch.fallback > 0) {
      reportReferenceResult(batch, 'text-fallback', batch.reason || 'phase')
      return
    }
    reportReferenceResult(batch, 'failed', batch.reason || 'retries-exhausted')
  }

  /** Insert one queued reference, falling back to visible draft text. */
  function insertOneReference(input, queued) {
    var batch = batchOf(queued)
    var snapshot = input.state.getSnapshot()
    var at = detectLength(snapshot)
    var applied = false
    try {
      applied = input.insertReference({
        source: 'reference',
        ref: queued.mention,
        label: queued.label,
        appearance: queued.appearance || 'file',
        clipboardText: queued.mention,
      }, { start: at, end: at, draftRev: snapshot.draftRev })
    } catch (_error) {
      debug.errors.push('insertReference threw for ' + queued.mention)
      applied = false
    }
    if (applied) {
      if (batch !== null) batch.inserted += 1
    } else {
      if (batch !== null) {
        batch.fallback += 1
        batch.reason = referenceRejectionReason(snapshot)
      }
      debug.errors.push('insertReference rejected at ' + String(at) + ' rev ' + String(snapshot.draftRev))
      try {
        input.setDraft((snapshot.draft === '' ? '' : snapshot.draft.replace(/\s+$/u, ' ') + ' ') + queued.mention + ' ')
      } catch (_error) {
        debug.errors.push('the text fallback could not be applied for ' + queued.mention)
      }
    }
    debug.attempts.push({ mention: queued.mention, at: at, rev: snapshot.draftRev, applied: applied })
    if (batch !== null) {
      batch.remaining -= 1
      if (batch.remaining <= 0) reportBatch(batch)
    }
  }

  /**
   * Drain the queued references. Never returns without an outcome: it either
   * inserts (and reports), or reports pending and schedules the retry, or
   * fails the queue when the retry budget is spent.
   */
  function insertQueuedRefs() {
    if (state.pendingRefs.length === 0) {
      cancelReferenceRetry()
      cancelReferenceDrain()
      referenceRetryCount = 0
      return
    }
    noteReferenceAttempt()
    var input = resolveInput()
    if (!inputCanInsert(input)) {
      if (input !== null) noteInputFailure('no-input')
      var waiting = pendingBatches()
      for (var i = 0; i < waiting.length; i++) {
        if (waiting[i].pendingReported) continue
        waiting[i].pendingReported = true
        reportReferenceResult(waiting[i], 'pending', lastInputReason || 'no-input')
      }
      scheduleReferenceRetry()
      return
    }
    cancelReferenceRetry()
    referenceRetryCount = 0
    var drained = 0
    while (state.pendingRefs.length > 0 && drained < REFERENCE_DRAIN_CHUNK) {
      insertOneReference(input, state.pendingRefs.shift())
      drained += 1
    }
    if (state.pendingRefs.length > 0) {
      scheduleReferenceDrain()
      return
    }
    cancelReferenceDrain()
  }

  function queueReferences(refs) {
    debug.queued += refs.length
    var queuedRefs = []
    for (var i = 0; i < refs.length; i++) {
      var ref = refs[i]
      if (ref && typeof ref.mention === 'string' && ref.mention !== '') {
        queuedRefs.push({
          mention: ref.mention,
          label: typeof ref.label === 'string' && ref.label !== '' ? ref.label : ref.mention,
          appearance: 'file',
        })
      }
    }
    if (queuedRefs.length === 0) return
    var batch = createReferenceBatch(queuedRefs.length, queuedRefs.map(function (queued) {
      return queued.mention
    }))
    for (var j = 0; j < queuedRefs.length; j++) queuedRefs[j].batch = batch
    state.pendingRefs.push.apply(state.pendingRefs, queuedRefs)
    // A fresh drop gets a fresh retry budget.
    referenceRetryCount = 0
    insertQueuedRefs()
  }

  function localPlainTextFallback(entries) {
    if (!entries || entries.length !== 1) return null
    var text = entries[0] && typeof entries[0].text === 'string' ? entries[0].text : ''
    if (text === '' || /[\r\n]/.test(text)) return null
    if (!/^(~?[./\\]|[A-Za-z]:[\\/])/.test(text) && text.indexOf('/') === -1 && text.indexOf('\\') === -1) return null
    var relative = relativeToWorkspace(text)
    return [{ mention: formatMention(relative), label: relative, appearance: 'file' }]
  }

  var dragDiagnosticSent = false
  document.addEventListener('dragenter', function (event) {
    if (!dragDiagnosticSent) {
      dragDiagnosticSent = true
      var types = Array.prototype.slice.call(event.dataTransfer ? event.dataTransfer.types || [] : [])
      post({ type: 'drag-enter', types: types })
    }
  }, true)

  document.addEventListener('dragover', function (event) {
    if (!dragMayReference(event.dataTransfer)) return
    event.preventDefault()
    try {
      event.dataTransfer.dropEffect = 'copy'
    } catch (_error) {
      /* dropEffect may be read-only in synthetic drags */
    }
    showDropHint(true)
  }, true)

  document.addEventListener('dragleave', function (event) {
    if (event.relatedTarget === null) showDropHint(false)
  }, true)

  /** The dragged text/plain entry, if the drag carried readable text. */
  function textEntryOf(entries) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i] && typeof entries[i].text === 'string') return entries[i]
    }
    return null
  }

  /**
   * Whether the drag may carry an editor selection: a text or editorData
   * entry, or VS Code's `codeeditors` type (an editor-tab drag).
   */
  function dragUsesActiveEditor(entries, types) {
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i]
      if (!entry) continue
      if (typeof entry.text === 'string' && !entry.uri) return true
      if (typeof entry.editorData === 'string') return true
    }
    for (var j = 0; j < types.length; j++) {
      if (String(types[j]).toLowerCase() === 'codeeditors') return true
    }
    return false
  }

  /**
   * Report a handled drag that produced no chip: the raw text went into the
   * draft (text-fallback), or the drop could not be turned into anything
   * (failed, with a short reason the host keeps in telemetry).
   */
  function reportDropOutcome(outcome, reason) {
    var message = { type: 'reference-result', outcome: outcome, count: 0, mentions: [], attempts: 1 }
    if (typeof reason === 'string' && reason !== '') message.reason = reason
    debug.results.push({ outcome: outcome, count: 0, attempts: 1, reason: message.reason || '' })
    if (debug.results.length > 20) debug.results.shift()
    post(message)
  }

  document.addEventListener('drop', function (event) {
    var dataTransfer = event.dataTransfer
    var types = Array.prototype.slice.call(dataTransfer ? dataTransfer.types || [] : [])
    var entries = rawEntries(dataTransfer)
    var mayReference = dragMayReference(dataTransfer)
    var textEntry = textEntryOf(entries)
    post({
      type: 'drag-drop',
      types: types,
      entryCount: entries.length,
      mayReference: mayReference,
      hasText: textEntry !== null,
      hasEditorData: entries.some(function (entry) {
        return entry && typeof entry.editorData === 'string'
      }),
    })
    if (!mayReference && entries.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    showDropHint(false)
    if (entries.length === 0) {
      // A reference drag whose payload is unreadable (Files-only, for example):
      // claim the event, but report the empty payload instead of silence.
      reportDropOutcome('failed', 'empty-payload')
      return
    }
    var useActiveEditor = dragUsesActiveEditor(entries, types)
    var payload = { entries: entries, useActiveEditor: useActiveEditor }
    if (typeof event.clientX === 'number' && typeof event.clientY === 'number') {
      payload.dropPoint = { x: event.clientX, y: event.clientY }
    }
    requestHost('resolveReferences', payload).then(function (result) {
      var refs = result && Array.isArray(result.refs) ? result.refs : null
      if (refs === null || refs.length === 0) refs = fallbackRefs(entries)
      if (refs === null || refs.length === 0) refs = localPlainTextFallback(entries)
      if (refs && refs.length > 0) {
        queueReferences(refs)
        post({ type: 'drag-handled', count: refs.length })
        return
      }
      if (!useActiveEditor) {
        // No refs and no text/editorData to place: report the unresolved drop.
        reportDropOutcome('failed', 'unresolved-drop')
        return
      }
      // No reference resolved: the dragged text itself goes into the composer
      // so the gesture is visible, and the outcome is reported either way.
      var text = textEntry === null ? '' : textEntry.text
      var input = resolveInput()
      if (inputCanInsert(input) && text !== '') {
        try {
          var snapshot = input.state.getSnapshot()
          input.setDraft(snapshot.draft + text)
          reportDropOutcome('text-fallback', '')
          return
        } catch (_error) {
          debug.errors.push('the dropped text could not be placed in the draft')
        }
      }
      reportDropOutcome('failed', inputCanInsert(input) ? 'no-input' : (lastInputReason || 'no-input'))
    })
  }, true)

  // ---- in-page clipboard bridging -------------------------------------------
  // The shipped DSH frontend copy helper writes with
  // `navigator.clipboard.writeText` whenever that method exists and returns
  // false the moment the write rejects; its hidden-textarea execCommand
  // fallback is only reached when writeText is absent, so it is dead code in
  // the embed (the iframe has no clipboard permission of its own). The VS Code
  // extension host is the writer that actually reaches the user's clipboard —
  // VS Code forwards the extension-host clipboard to the client — so both
  // copy paths are served from there.

  var clipboardWriteTextPatched = false
  var execCommandPatched = false

  /** The text a copy command should place on the clipboard, or ''. */
  function selectedText() {
    try {
      var selection = typeof globalThis.getSelection === 'function'
        ? globalThis.getSelection()
        : (typeof document.getSelection === 'function' ? document.getSelection() : null)
      var text = selection ? String(selection.toString()) : ''
      if (text !== '') return text
      var active = document.activeElement
      if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
        var start = active.selectionStart
        var end = active.selectionEnd
        if (typeof start === 'number' && typeof end === 'number' && end > start) {
          return String(active.value === undefined ? '' : active.value).slice(start, end)
        }
      }
    } catch (_error) {
      /* an unreadable selection posts nothing rather than breaking the copy */
    }
    return ''
  }

  /**
   * Write text through the host and keep the async clipboard face: resolve
   * true when the host wrote it, otherwise fall back to the page's own writer
   * and let its promise settle as it always would.
   */
  function writeClipboardThroughHost(text, nativeWriteText, clipboard) {
    function fallBack() {
      if (typeof nativeWriteText !== 'function') {
        return Promise.reject(new Error('clipboard write is unavailable'))
      }
      try {
        var result = nativeWriteText.call(clipboard, text)
        return result && typeof result.then === 'function' ? result : Promise.resolve(result)
      } catch (error) {
        return Promise.reject(error)
      }
    }
    try {
      return requestHost('writeClipboard', { text: text }).then(function (value) {
        if (value && value.ok === true) return true
        return fallBack()
      }, fallBack)
    } catch (_error) {
      return fallBack()
    }
  }

  /**
   * Serve `navigator.clipboard.writeText` from the extension host. The app's
   * copy helper awaits this method and maps resolve/reject onto its copied or
   * failed UI, so the host answer keeps that face. Patched once; a page whose
   * clipboard object or method is missing keeps its own behavior (the
   * execCommand path below covers the fallback textarea).
   */
  function patchClipboardWriteText() {
    if (clipboardWriteTextPatched) return
    var clipboard = null
    try {
      var nav = globalThis.navigator
      clipboard = nav && nav.clipboard ? nav.clipboard : null
    } catch (_error) {
      clipboard = null
    }
    if (!clipboard || typeof clipboard.writeText !== 'function') return
    var nativeWriteText = clipboard.writeText
    var patched = function (text) {
      var value = ''
      try {
        value = String(text)
      } catch (_error) {
        value = ''
      }
      return writeClipboardThroughHost(value, nativeWriteText, clipboard)
    }
    try {
      clipboard.writeText = patched
    } catch (_error) {
      try {
        Object.defineProperty(clipboard, 'writeText', { value: patched, configurable: true, writable: true })
      } catch (_error2) {
        return
      }
    }
    clipboardWriteTextPatched = true
  }

  /**
   * Route the legacy `document.execCommand('copy')` path through the host as
   * well: the frontend's fallback textarea reaches it whenever the async
   * clipboard write is unavailable. The original command still runs and its
   * result is returned unchanged; every other command is untouched. An empty
   * selection posts nothing, because the host write would clear the clipboard.
   */
  function patchExecCommand() {
    if (execCommandPatched || typeof document.execCommand !== 'function') return
    execCommandPatched = true
    var originalExecCommand = document.execCommand
    document.execCommand = function (command) {
      try {
        if (String(command).toLowerCase() === 'copy') {
          var text = selectedText()
          if (text !== '') post({ type: 'copy-text', text: text })
        }
      } catch (_error) {
        /* the original command below still runs */
      }
      return originalExecCommand.apply(document, arguments)
    }
  }

  patchClipboardWriteText()
  patchExecCommand()

  // ---- delivered-file cards -------------------------------------------------

  var DELIVERED_CARD_SELECTOR = '[data-presented-file]'
  var DELIVERED_PREVIEW_SELECTOR = 'button[class*="_cardPreview"]'
  var DELIVERED_OPEN_SELECTOR = 'button[class*="_open"]'
  var DELIVERED_CHEVRON_SELECTOR = 'button[class*="_chevron"]'
  var DELIVERED_MARK_ATTR = 'data-dsh-vscode-card'
  var DELIVERED_STYLE_ID = 'dsh-vscode-bridge-style'

  /**
   * The app prints a host-desktop status row inside every delivered-file card —
   * 此主机没有可用的桌面，无法打开文件或文件夹, or 无法读取主机桌面信息 with a 重试
   * button — because the serving host reports no desktop. VS Code is the opener
   * in the embed, so those rows are noise. One bridge-owned stylesheet hides
   * them and nothing else; the class hash changes between DSH builds, the
   * `_hostStatus` suffix does not.
   */
  function injectDeliveredStyle() {
    if (typeof document.getElementById === 'function' && document.getElementById(DELIVERED_STYLE_ID)) return
    var sheet = document.createElement('style')
    sheet.setAttribute('id', DELIVERED_STYLE_ID)
    sheet.textContent = '[class*="_hostStatus"]{display:none !important}'
    var parent = document.head || document.documentElement
    if (parent && typeof parent.appendChild === 'function') parent.appendChild(sheet)
  }

  /** The chevron of one card, or null while the card has not rendered one. */
  function deliveredChevron(card) {
    return typeof card.querySelector === 'function' ? card.querySelector(DELIVERED_CHEVRON_SELECTOR) : null
  }

  /**
   * The app disables a card's chevron when the host reports no desktop, and a
   * disabled button emits no click at all — the bridge's menu would be
   * unreachable. The card is marked once and the button is left enabled; React
   * re-renders rewrite both, which is what the observer below re-applies.
   */
  function enableDeliveredCard(card) {
    var chevron = deliveredChevron(card)
    if (chevron === null) return
    if (typeof card.getAttribute !== 'function' || card.getAttribute(DELIVERED_MARK_ATTR) === null) {
      card.setAttribute(DELIVERED_MARK_ATTR, '')
    }
    if (chevron.disabled) chevron.disabled = false
    if (typeof chevron.removeAttribute === 'function') chevron.removeAttribute('disabled')
    if (typeof chevron.getAttribute !== 'function' || chevron.getAttribute('aria-disabled') !== 'false') {
      chevron.setAttribute('aria-disabled', 'false')
    }
  }

  /** Re-apply the bridge's ownership to every card inside one subtree. */
  function syncDeliveredCards(root) {
    if (root === null || root === undefined || typeof root.querySelectorAll !== 'function') return
    var cards = root.querySelectorAll(DELIVERED_CARD_SELECTOR)
    for (var index = 0; index < cards.length; index += 1) enableDeliveredCard(cards[index])
  }

  /** Re-apply to one mutated node: the card it belongs to, plus its subtree. */
  function applyDeliveredNode(node) {
    if (node === null || node === undefined || typeof node.closest !== 'function') return
    var card = node.closest(DELIVERED_CARD_SELECTOR)
    if (card !== null && card !== undefined) enableDeliveredCard(card)
    syncDeliveredCards(node)
  }

  /**
   * A card renders — and React rewrites its chevron's `disabled` attribute —
   * long after boot, so enablement follows the mutations that can carry a card
   * instead of polling for one. `disabled` is the only attribute the app
   * toggles on a chevron; a re-render that swaps nodes arrives as childList.
   */
  function observeDeliveredCards() {
    if (typeof MutationObserver !== 'function') return
    var target = document.documentElement
    if (target === null || target === undefined) return
    var observer = new MutationObserver(function (records) {
      for (var index = 0; index < records.length; index += 1) {
        var record = records[index]
        if (record.type === 'attributes') {
          applyDeliveredNode(record.target)
          continue
        }
        var added = record.addedNodes ? record.addedNodes : []
        for (var node = 0; node < added.length; node += 1) applyDeliveredNode(added[node])
      }
    })
    observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] })
  }

  /**
   * The file one delivered-file card opens. The whole-card preview button
   * carries the path as its tooltip — absolute when the session cwd is known,
   * workspace-relative otherwise — while the visible 打开 button carries none,
   * so both read that tooltip first and the preview button's own text last. No
   * path means no interception: the app keeps its own handling.
   */
  function deliveredFilePath(card, trigger) {
    var preview = typeof card.querySelector === 'function' ? card.querySelector(DELIVERED_PREVIEW_SELECTOR) : null
    var sources = [preview, trigger]
    for (var index = 0; index < sources.length; index += 1) {
      var node = sources[index]
      if (node === null || node === undefined) continue
      var title = typeof node.getAttribute === 'function' ? node.getAttribute('title') : null
      if (typeof title === 'string' && title.trim() !== '') return title.trim()
    }
    var visible = preview === null || preview === undefined ? trigger : preview
    var text = typeof visible.textContent === 'string' ? visible.textContent.trim() : ''
    return text === '' ? undefined : text
  }

  injectDeliveredStyle()
  syncDeliveredCards(document)
  observeDeliveredCards()

  // ---- tool path link interception ------------------------------------------

  /**
   * Walk the React fiber chain from the clicked DOM node to the tool row's
   * owner component and take its frozen ToolCallBlock args. Production fiber
   * internals are stable enough for this read-only probe; nothing is mutated.
   */
  function toolArgsFromFiber(el) {
    var key = Object.keys(el).find(function (name) {
      return name.indexOf('__reactFiber$') === 0 || name.indexOf('__reactInternalInstance$') === 0
    })
    var node = key === undefined ? null : el[key]
    while (node !== null) {
      var props = node.memoizedProps || node.pendingProps || null
      if (props !== null && props.block) {
        var raw = props.block.call && props.block.call.argsRaw
        if (typeof raw !== 'string') raw = props.block.argsRaw
        if (typeof raw === 'string') {
          try { return JSON.parse(raw) } catch (_error) { return null }
        }
      }
      node = node.return || null
    }
    return null
  }

  /**
   * The file a produced-files chip opens. Each chip carries the full path as
   * its tooltip, because the visible label is only the basename.
   */
  function producedFilePath(target) {
    var chip = target.closest ? target.closest('[data-produced-files-row] button') : null
    if (chip === null) return undefined
    var path = chip.getAttribute('title')
    return path === null || path === '' ? undefined : path
  }

  document.addEventListener('click', function (event) {
    var clicked = event.target
    if (!clicked || !clicked.closest) return
    // A delivered-file card: its whole-card preview button, its visible 打开
    // button and its chevron all end in the serving host's own desktop opener,
    // which a headless host cannot honour. Every open gesture lands in VS Code.
    var card = clicked.closest(DELIVERED_CARD_SELECTOR)
    if (card !== null && card !== undefined) {
      var chevron = clicked.closest(DELIVERED_CHEVRON_SELECTOR)
      if (chevron !== null) {
        // The app's chevron menu holds nothing but host-desktop actions, so the
        // bridge answers this click with its own menu — and stops this one
        // before the app can open that menu. The app rendered the chevron
        // disabled; enableDeliveredCard keeps it clickable (a disabled button
        // emits no click at all).
        event.preventDefault()
        event.stopPropagation()
        var menuPath = deliveredFilePath(card, chevron)
        if (menuPath !== undefined) openCardMenu(menuPath, chevron, event.clientX, event.clientY)
        return
      }
      var opener = clicked.closest(DELIVERED_PREVIEW_SELECTOR)
      if (opener === null) opener = clicked.closest(DELIVERED_OPEN_SELECTOR)
      if (opener !== null) {
        var cardPath = deliveredFilePath(card, opener)
        if (cardPath !== undefined) {
          event.preventDefault()
          event.stopPropagation()
          post({ type: 'open-file', path: cardPath })
          return
        }
      }
    }
    // A produced-file chip and a tool card's file link both open in the editor.
    // Their markup is what carries the path: the chip's tooltip holds it whole,
    // a file link's text is the path the card advertises.
    var produced = producedFilePath(clicked)
    if (produced !== undefined) {
      event.preventDefault()
      event.stopPropagation()
      post({ type: 'open-file', path: produced })
      return
    }
    var target = clicked.closest('button[class*="fileLink"]')
    if (!target) return
    var row = target.closest('[data-tool]')
    var tool = row ? row.getAttribute('data-tool') || '' : ''
    var path = (target.textContent || '').trim()
    if (path === '') return
    event.preventDefault()
    event.stopPropagation()
    if (tool !== 'edit' && tool !== 'str_replace_editor') {
      post({ type: 'open-file', path: path })
      return
    }
    var args = toolArgsFromFiber(target)
    var filePath = args && (typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : undefined)
    var oldText = args && args.old_string !== undefined && args.old_string !== null ? String(args.old_string) : args && args.old_str !== undefined && args.old_str !== null ? String(args.old_str) : undefined
    var newText = args && args.new_string !== undefined && args.new_string !== null ? String(args.new_string) : args && args.new_str !== undefined && args.new_str !== null ? String(args.new_str) : undefined
    post({
      type: 'open-diff',
      path: typeof filePath === 'string' && filePath !== '' ? filePath : path,
      ...(oldText === undefined ? {} : { oldText: oldText }),
      ...(newText === undefined ? {} : { newText: newText }),
    })
  }, true)

  // ---- external link interception ------------------------------------------

  /**
   * Resolve one anchor to an external http(s) URL when the link leaves the
   * app origin. Internal, relative, fragment, and non-web links are left to
   * the app; inside a VS Code webview iframe external anchors are otherwise
   * dropped silently.
   */
  function externalUrlOf(anchor) {
    var href = anchor.getAttribute('href')
    if (href === null) return null
    var value = href.trim()
    if (value === '' || value.charAt(0) === '#') return null
    try {
      var url = new URL(value, globalThis.location.href)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      if (url.origin === globalThis.location.origin) return null
      return url.href
    } catch (_error) {
      return null
    }
  }

  document.addEventListener('click', function (event) {
    var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null
    if (anchor === null) return
    var url = externalUrlOf(anchor)
    if (url === null) return
    event.preventDefault()
    event.stopPropagation()
    post({ type: 'open-url', url: url })
  }, true)

  // ---- link context menu ----------------------------------------------------

  /**
   * The destination a right click may choose a browser for: the same
   * cross-origin HTTP(S) links the left-click interceptor owns, plus `mailto:`
   * — which no in-page browser can serve, so its only sensible target is the
   * desktop handler. Same-origin and app-internal links keep the page's own
   * menu: they are navigation, not external addresses.
   */
  function menuTargetOf(anchor) {
    var href = anchor.getAttribute('href')
    if (href === null) return null
    var value = href.trim()
    if (value === '' || value.charAt(0) === '#') return null
    try {
      var url = new URL(value, globalThis.location.href)
      if (url.protocol === 'mailto:') return { url: url.href, mail: true }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      if (url.origin === globalThis.location.origin) return null
      return { url: url.href, mail: false }
    } catch (_error) {
      return null
    }
  }

  /** Menu copy in the VS Code display language. */
  var MENU_COPY = {
    zh: {
      internal: '在内部浏览器中打开',
      external: '在外部浏览器中打开',
      mail: '用外部程序打开',
      copy: '复制链接',
      editor: '在编辑器中打开',
      beside: '在右侧打开',
      reveal: '在资源管理器中显示',
    },
    en: {
      internal: 'Open in Internal Browser',
      external: 'Open in External Browser',
      mail: 'Open in External Application',
      copy: 'Copy Link',
      editor: 'Open in Editor',
      beside: 'Open to the Side',
      reveal: 'Reveal in Explorer',
    },
  }

  /** Pick the menu dictionary: the host's display language, then the page's. */
  function menuCopy() {
    var language = typeof config.locale === 'string' && config.locale !== ''
      ? config.locale
      : String(globalThis.navigator && globalThis.navigator.language ? globalThis.navigator.language : 'en')
    return /^zh/i.test(language) ? MENU_COPY.zh : MENU_COPY.en
  }

  /** One menu row: the shared look, plus the click that runs its action. */
  function menuItem(label, run) {
    var button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.setAttribute('role', 'menuitem')
    button.style.cssText = 'display:block;width:100%;padding:6px 14px;border:0;background:transparent;'
      + 'color:inherit;font:inherit;text-align:left;cursor:pointer;white-space:nowrap;'
    button.addEventListener('mouseenter', function () { button.style.background = MENU_SELECTION })
    button.addEventListener('mouseleave', function () { button.style.background = 'transparent' })
    button.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      closeLinkMenu()
      run()
    })
    return button
  }

  var MENU_BACKGROUND = 'var(--vscode-menu-background, #252526)'
  var MENU_FOREGROUND = 'var(--vscode-menu-foreground, #cccccc)'
  var MENU_BORDER = 'var(--vscode-menu-border, rgba(128, 128, 128, 0.35))'
  var MENU_SELECTION = 'var(--vscode-menu-selectionBackground, rgba(90, 93, 94, 0.6))'
  var linkMenu = null

  /** Remove the open menu and its global dismiss listeners. */
  function closeLinkMenu() {
    var menu = linkMenu
    if (menu === null) return
    linkMenu = null
    menu.remove()
    document.removeEventListener('mousedown', menuOutside, true)
    document.removeEventListener('contextmenu', menuOutside, true)
    document.removeEventListener('keydown', menuKey, true)
    window.removeEventListener('blur', closeLinkMenu)
    window.removeEventListener('resize', closeLinkMenu)
    document.removeEventListener('scroll', closeLinkMenu, true)
  }

  function menuOutside(event) {
    if (linkMenu !== null && linkMenu.contains(event.target)) return
    closeLinkMenu()
  }

  function menuKey(event) {
    if (event.key === 'Escape') closeLinkMenu()
  }

  /** The surface every bridge-owned menu shares. */
  var MENU_SURFACE = 'position:fixed;z-index:2147483647;min-width:180px;padding:4px 0;'
    + 'border:1px solid ' + MENU_BORDER + ';border-radius:6px;background:' + MENU_BACKGROUND + ';'
    + 'color:' + MENU_FOREGROUND + ';font-family:var(--vscode-font-family, sans-serif);'
    + 'font-size:12px;box-shadow:0 2px 8px rgba(0, 0, 0, 0.35);'

  /** Mount one prepared menu at a point, clamped, and arm its dismissal. */
  function showMenu(menu, label, x, y) {
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', label)
    menu.style.cssText = MENU_SURFACE
    document.documentElement.appendChild(menu)
    // Clamp after measuring so a menu near the viewport edge still shows whole.
    var width = menu.offsetWidth
    var height = menu.offsetHeight
    var left = Math.max(4, Math.min(x, window.innerWidth - width - 4))
    var top = Math.max(4, Math.min(y, window.innerHeight - height - 4))
    menu.style.left = String(left) + 'px'
    menu.style.top = String(top) + 'px'
    linkMenu = menu
    document.addEventListener('mousedown', menuOutside, true)
    document.addEventListener('contextmenu', menuOutside, true)
    document.addEventListener('keydown', menuKey, true)
    window.addEventListener('blur', closeLinkMenu)
    window.addEventListener('resize', closeLinkMenu)
    document.addEventListener('scroll', closeLinkMenu, true)
  }

  /** Show the target chooser for one link at the pointer. */
  function openLinkMenu(target, x, y) {
    closeLinkMenu()
    var copy = menuCopy()
    var menu = document.createElement('div')
    menu.setAttribute('data-dsh-link-menu', '')
    if (target.mail) {
      menu.appendChild(menuItem(copy.mail, function () {
        post({ type: 'open-url', url: target.url, target: 'external' })
      }))
    } else {
      menu.appendChild(menuItem(copy.internal, function () {
        post({ type: 'open-url', url: target.url, target: 'internal' })
      }))
      menu.appendChild(menuItem(copy.external, function () {
        post({ type: 'open-url', url: target.url, target: 'external' })
      }))
    }
    menu.appendChild(menuItem(copy.copy, function () {
      post({ type: 'copy-text', text: target.url })
    }))
    showMenu(menu, target.url, x, y)
    debug.linkMenu = target.url
  }

  /**
   * The point a card menu hangs from: under its chevron, or at the pointer when
   * the button cannot be measured (a synthetic click carries no coordinates).
   */
  function menuAnchor(chevron, x, y) {
    if (chevron !== null && chevron !== undefined && typeof chevron.getBoundingClientRect === 'function') {
      var rect = chevron.getBoundingClientRect()
      if (rect !== null && typeof rect.left === 'number' && typeof rect.bottom === 'number') {
        return { x: rect.left, y: rect.bottom }
      }
    }
    return { x: x, y: y }
  }

  /**
   * Show the delivered-file card menu. The app's own chevron menu offers only
   * host-desktop actions, which can never work on a headless serving host;
   * every entry here names an opener that can.
   */
  function openCardMenu(path, chevron, x, y) {
    closeLinkMenu()
    var copy = menuCopy()
    var menu = document.createElement('div')
    menu.setAttribute('data-dsh-card-menu', '')
    menu.appendChild(menuItem(copy.editor, function () {
      post({ type: 'open-file', path: path })
    }))
    menu.appendChild(menuItem(copy.beside, function () {
      post({ type: 'open-file', path: path, column: 'beside' })
    }))
    menu.appendChild(menuItem(copy.reveal, function () {
      post({ type: 'reveal-file', path: path })
    }))
    var anchor = menuAnchor(chevron, x, y)
    showMenu(menu, path, anchor.x, anchor.y)
    debug.cardMenu = path
  }

  /**
   * Turn every external link's context menu into the browser chooser. The
   * left-click default stays the internal browser; this is the escape hatch for
   * addresses that need the desktop browser's own session.
   */
  document.addEventListener('contextmenu', function (event) {
    var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null
    if (anchor === null) return
    var target = menuTargetOf(anchor)
    if (target === null) return
    event.preventDefault()
    event.stopPropagation()
    openLinkMenu(target, event.clientX, event.clientY)
  }, true)

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || data.source !== HOST_SOURCE) return
    // A host-driven reset (new session, workspace change) must not leave a
    // detached menu floating over the next view.
    if (data.type === 'configure') closeLinkMenu()
  })

  post({ type: 'bridge-loaded', href: String(globalThis.location.href) })

  // ---- synthetic boot row + Cordis plugin registration ----------------------

  var loader = globalThis.__ModuleLoader__
  var boot = globalThis.__DSH_BOOT__
  if (!loader || !boot || !Array.isArray(boot.entries) || !Array.isArray(boot.batches)) {
    debug.errors.push('boot graph unavailable')
    console.warn('[dsh-vscode] boot graph unavailable; file navigation remains active but the Cordis bridge is disabled')
    return
  }

  var alreadyRegistered = boot.entries.some(function (entry) { return entry && entry.id === PLUGIN_ID })
  if (!alreadyRegistered) {
    boot.entries.push({
      id: PLUGIN_ID,
      url: '/__dsh_vscode_bridge.js',
      rev: 'vscode-bridge-1',
      inject: [],
      immediately: false,
    })
    var batch = null
    for (var i = boot.batches.length - 1; i >= 0; i--) {
      if (boot.batches[i] && boot.batches[i].phase === 'application') {
        batch = boot.batches[i]
        break
      }
    }
    if (batch === null) batch = boot.batches[boot.batches.length - 1]
    if (batch && Array.isArray(batch.entries)) batch.entries.push(PLUGIN_ID)
  }

  // The embedded view replaces the DSH sidebar (workspace/session browser)
  // with the VS Code folder. Remove the sidebar client plugin from the boot
  // graph entirely: no CSS masking, the region never mounts. The workspace
  // controller and uiWorkspace service stay for auto-pinning; only the
  // sidebar presentation plugin is dropped.
  boot.entries = boot.entries.filter(function (entry) {
    return !(entry && entry.id === '@deepseek-ai/dsh-client-ui-sidebar')
  })
  for (var b = 0; b < boot.batches.length; b++) {
    if (boot.batches[b] && Array.isArray(boot.batches[b].entries)) {
      boot.batches[b].entries = boot.batches[b].entries.filter(function (id) {
        return id !== '@deepseek-ai/dsh-client-ui-sidebar'
      })
    }
  }

  // The AppFrame grid still reserves the sidebar/details tracks even with the
  // sidebar plugin removed (a closed sidebar keeps a 56px rail, an untouched
  // preference a full column), so the embedded view zeros BOTH tracks and
  // hides the columns: the conversation absorbs the whole webview width.
  // `!important` is required because AppFrame writes the tracks inline; the
  // selector is structural (AppFrame is the only element with an inline
  // grid-template-columns on the DSH page).
  var layoutStyle = document.createElement('style')
  layoutStyle.textContent = [
    'div[style*="grid-template-columns:"] { grid-template-columns: 0px minmax(0, 1fr) 0px !important; }',
    // display:none removes the hidden columns from grid auto-placement, so the
    // conversation grid item must be pinned to the second (1fr) track explicitly.
    'div[style*="grid-template-columns:"] > div:first-of-type { display: none !important; }',
    'div[style*="grid-template-columns:"] > div:nth-of-type(2) { grid-column: 2; grid-row: 1; }',
    'div[style*="grid-template-columns:"] > div:nth-of-type(3) { display: none !important; }',
  ].join('')
  document.documentElement.appendChild(layoutStyle)
  post({ type: 'embedded-layout', css: true })

  loader.load({
    id: PLUGIN_ID,
    factory: function (_require) {
      /**
       * Auto-pin the VS Code folder once per boot: resolve or create the
       * Host Workspace, then connect and open its session. Gated on BOTH
       * controller lists being ready — the web UI's native navigation waits
       * for the same pair, and connecting earlier makes connectWorkspace's
       * blank-reuse scan read an empty snapshot, creating one extra blank
       * session per boot. Workspace lookup accepts both the VS Code path and
       * its canonical realpath. Failures retry a bounded number of times and
       * then report one explicit `workspace-error` instead of looping silently.
       */
      function reconcileAutoPin(ctx) {
        var sessions = ctx.get('sessions')
        var workspaces = ctx.get('workspaces')
        var uiWorkspace = ctx.get('uiWorkspace')
        if (!sessions || !workspaces || !uiWorkspace) return
        var sessionsList = sessions.list.getSnapshot()
        var workspaceList = workspaces.list.getSnapshot()
        if (sessionsList.phase !== 'ready' || workspaceList.phase !== 'ready') return
        if (workspacePath === '') return
        if (bridgeConnect === null) return
        if (pinFailed) return
        var workspace = workspaceList.items.find(function (item) {
          return workspacePathMatches(item.path)
        })
        // The web app's own navigation watches the profile as a whole and, on
        // boot, auto-picks the most recently used workspace — which may not be
        // the VS Code folder on machines whose DSH profile already carries
        // other workspaces. A current session that belongs to the pinned folder
        // satisfies the embed; anything else is re-pinned below.
        //
        // Ownership is the wrong question on its own: a subagent child (every
        // `subagent` tool run and every Agent Teams teammate) is created
        // through the agent factory and never attached to a Workspace record,
        // so its id is absent from every `sessionIds` account. Testing ownership
        // alone therefore read "the user opened a child" as "the wrong
        // workspace is pinned", and the re-pin below answered by opening — or
        // creating — a blank session, which is what made clicking a subagent
        // jump to an empty new session. Membership is decided by the same
        // lineage-aware predicate the scope guard uses.
        var current = sessionsList.current
        if (current !== undefined && sessionInScope(current)) {
          resetPinFailure()
          return
        }
        if (pinInFlight) return
        if (pinAttempts >= MAX_PIN_ATTEMPTS) {
          reportPinFailure(pinError || ('workspace "' + workspacePath + '" could not be opened after '
            + String(MAX_PIN_ATTEMPTS) + ' attempts'))
          return
        }
        pinInFlight = true
        pinAttempts += 1
        if (workspace === undefined) {
          // The backend canonicalizes the path; use the returned Workspace
          // directly so a symlinked VS Code path still pins in this cycle.
          workspaces.create({ path: workspacePath }).then(function (resolved) {
            if (resolved && resolved.workspaceId) {
              return bridgeConnect(resolved.workspaceId).then(function (sessionId) {
                sessions.open(sessionId)
                resetPinFailure()
              })
            }
            return null
          }).catch(function (error) {
            pinError = String((error && error.message) || error)
            debug.errors.push('workspace create failed: ' + pinError)
            console.warn('[dsh-vscode] workspace create failed:', error)
          }).finally(function () {
            pinInFlight = false
            flushOpens()
            schedulePinCheck()
          })
          return
        }
        bridgeConnect(workspace.workspaceId).then(function (sessionId) {
          sessions.open(sessionId)
          resetPinFailure()
        }).catch(function (error) {
          pinError = String((error && error.message) || error)
          debug.errors.push('workspace auto-pin failed: ' + pinError)
          console.warn('[dsh-vscode] workspace auto-pin failed:', error)
        }).finally(function () {
          pinInFlight = false
          flushOpens()
          schedulePinCheck()
        })
      }

      return {
        name: 'vscode-embed-bridge',
        inject: ['sessions', 'workspaces', 'uiWorkspace', 'conversation', 'theme'],
        apply: function (ctx) {
          debug.plugin = true
          state.services = {
            sessions: ctx.get('sessions'),
            workspaces: ctx.get('workspaces'),
            uiWorkspace: ctx.get('uiWorkspace'),
            conversation: ctx.get('conversation'),
            theme: ctx.get('theme'),
          }
          ctx.inject(['connection'], function (connectedCtx) {
            var connection = connectedCtx.get('connection')
            if (!connection) return
            connectedCtx.effect(function () {
              var installed = globalThis.__DSH_INSTALL_RECOVERY__({
                connection: connection, sessions: state.services.sessions,
              }, post, config)
              recovery = installed
              var off = connection.state.subscribe(flushOpens)
              flushOpens()
              return function () { off(); installed.dispose(); if (recovery === installed) recovery = null }
            }, 'vscode-embed-bridge: connection recovery')
          })
          // The page is a profile-wide client: its own boot navigation picks the
          // most recently used Workspace, the sidebar lists every Workspace, and
          // opening a Session activates its writer (a cross-process write lease).
          // This window owns exactly the folder it was pinned to, so every
          // entry point that could create, select, rename, fork, or archive a
          // Session is refused when the target lies outside that folder. The
          // bridge's own pin keeps the untouched originals.
          ctx.effect(function () {
            var sessions = ctx.get('sessions')
            var uiWorkspace = ctx.get('uiWorkspace')
            if (!sessions || !uiWorkspace || workspacePath === '') return function () {}
            var connect = uiWorkspace.connectWorkspace
            var open = sessions.open
            var openSubagent = sessions.openSubagent
            var create = sessions.create
            var fork = sessions.fork
            var archive = uiWorkspace.archiveSession
            var binding = sessions.binding
            bridgeConnect = function (workspaceId) { return connect.call(uiWorkspace, workspaceId) }
            uiWorkspace.connectWorkspace = function (workspaceId) {
              if (workspaceInScope(workspaceId)) return connect.call(uiWorkspace, workspaceId)
              var pinned = pinnedWorkspace()
              // An embedded window is defined by its folder, so a request for
              // any other Workspace — the page's own boot navigation or a picker
              // — is served this one. That also keeps the boot navigation from
              // retrying forever against a refused target.
              if (pinned !== undefined) return connect.call(uiWorkspace, pinned.workspaceId)
              return Promise.reject(outOfScope('workspace', workspaceId))
            }
            sessions.open = function (sessionId) {
              if (sessionInScope(sessionId)) return open.call(sessions, sessionId)
              post({ type: 'scope-blocked', sessionId: sessionId, message: outOfScope('session', sessionId).message })
            }
            sessions.openSubagent = function (address) {
              if (address !== undefined && sessionInScope(address.childSessionId)) {
                return openSubagent.call(sessions, address)
              }
              var childId = address === undefined ? '' : address.childSessionId
              post({ type: 'scope-blocked', sessionId: childId, message: outOfScope('session', childId).message })
            }
            sessions.create = function (opts) {
              var options = opts === undefined ? {} : opts
              if (options.workspaceId !== undefined && !workspaceInScope(options.workspaceId)) {
                return Promise.reject(outOfScope('workspace', options.workspaceId))
              }
              if (options.cwd !== undefined && !workspacePathMatches(options.cwd)) {
                return Promise.reject(outOfScope('folder', options.cwd))
              }
              return create.call(sessions, options)
            }
            sessions.fork = function (opts) {
              if (opts === undefined || !sessionInScope(opts.sessionId)) {
                return Promise.reject(outOfScope('session', opts === undefined ? '' : opts.sessionId))
              }
              return fork.call(sessions, opts)
            }
            uiWorkspace.archiveSession = function (sessionId) {
              if (sessionInScope(sessionId)) return archive.call(uiWorkspace, sessionId)
              return Promise.reject(outOfScope('session', sessionId))
            }
            sessions.binding = function (sessionId) {
              var result = binding.call(sessions, sessionId)
              if (result !== undefined && !sessionInScope(sessionId)) guardRename(result, sessionId)
              return result
            }
            // A selection restored before this guard installed cannot keep the
            // stage; its writer, if the page already activated one, stays live
            // until this backend restarts.
            var current = sessions.list.getSnapshot().current
            if (current !== undefined && !sessionInScope(current)) sessions.clear()
            return function () {
              uiWorkspace.connectWorkspace = connect
              sessions.open = open
              sessions.openSubagent = openSubagent
              sessions.create = create
              sessions.fork = fork
              uiWorkspace.archiveSession = archive
              sessions.binding = binding
              bridgeConnect = null
            }
          }, 'vscode-embed-bridge: session scope guard')
          // The embedded view hides the right column, so a `dsh-resource://file/`
          // page opened there is invisible. Route file resources to the editor
          // instead; every other resource type keeps the column's own handling.
          ctx.inject(['sidebarRight'], function (sidebarCtx) {
            var sidebarRight = sidebarCtx.get('sidebarRight')
            if (!sidebarRight || typeof sidebarRight.openResource !== 'function') return
            var openResource = sidebarRight.openResource
            sidebarRight.openResource = function (address, options) {
              var path = filePathOfAddress(address)
              if (path === undefined) return openResource.call(sidebarRight, address, options)
              var params = options === undefined ? undefined : options.params
              var line = params === undefined ? undefined : params.line
              post({
                type: 'open-file',
                path: path,
                ...(typeof line === 'number' ? { line: line } : {}),
              })
            }
            sidebarCtx.effect(function () {
              return function () { sidebarRight.openResource = openResource }
            }, 'vscode-embed-bridge: file resource editor routing')
          })
          // Releases before the resource face: the app's own file opener is a
          // host RPC that hands the path to the host's native opener, which has
          // no window here. Serve it as an editor open instead, keeping the
          // success the caller expects. The namespace is its own dotted service,
          // so it is read by that name and waited for; reaching it through the
          // `remote` face needs an injection this plugin does not declare.
          ctx.inject(['remote.session'], function (remoteCtx) {
            var session = remoteCtx.get('remote.session')
            if (!session || typeof session.openWorkspacePath !== 'function') return
            var openWorkspacePath = session.openWorkspacePath
            session.openWorkspacePath = function (request, signal) {
              var path = request !== null && typeof request === 'object' && typeof request.path === 'string'
                ? request.path
                : undefined
              if (path === undefined || path === '') return openWorkspacePath.call(session, request, signal)
              post({ type: 'open-file', path: path })
              return Promise.resolve({ ok: true, value: { opened: true } })
            }
            remoteCtx.effect(function () {
              return function () { session.openWorkspacePath = openWorkspacePath }
            }, 'vscode-embed-bridge: workspace path opens in the editor')
          })
          if (lastConfiguredTheme !== null) applyThemeThroughService(lastConfiguredTheme)
          // Another window (or the settings invalidation feed) may rewrite the
          // preference in this page; re-apply the VS Code theme whenever the
          // published snapshot diverges. The handler re-checks the snapshot,
          // so the publish emitted by its own setTheme cannot loop.
          ctx.on('theme/change', function (snapshot) {
            if (lastConfiguredTheme === null) return
            if (snapshot && snapshot.active && snapshot.active.colorScheme !== lastConfiguredTheme) {
              applyThemeThroughService(lastConfiguredTheme)
            }
          })
          flushOpens()
          flushNewSessions()
          ctx.effect(function () {
            var sessions = ctx.get('sessions')
            var workspaces = ctx.get('workspaces')
            if (!sessions || !workspaces) return function () {}
            triggerPin = function () { reconcileAutoPin(ctx) }
            var listener = function () { reconcileAutoPin(ctx) }
            var offSessions = sessions.list.subscribe(listener)
            var offWorkspaces = workspaces.list.subscribe(listener)
            listener()
            return function () {
              offSessions()
              offWorkspaces()
              if (triggerPin !== null) triggerPin = null
            }
          }, 'vscode-embed-bridge: workspace pin gate')
          ctx.effect(function () {
            var sessions = ctx.get('sessions')
            if (!sessions) return function () {}
            var sync = function () {
              flushOpens()
              resolveInput()
              insertQueuedRefs()
            }
            var unsubscribe = sessions.list.subscribe(sync)
            sync()
            return function () {
              unsubscribe()
              if (pendingOpenTimer !== null) clearTimeout(pendingOpenTimer)
              pendingOpenTimer = null
            }
          }, 'vscode-embed-bridge: session input sync')
          ctx.effect(function () {
            var workspaces = ctx.get('workspaces')
            if (!workspaces) return function () {}
            var sync = function () { flushOpens(); publishWorkspaceState() }
            var unsubscribe = workspaces.list.subscribe(sync)
            sync()
            return function () { unsubscribe() }
          }, 'vscode-embed-bridge: workspace state publish')
          ctx.effect(function () {
            var sessions = ctx.get('sessions')
            var workspaces = ctx.get('workspaces')
            if (!sessions || !workspaces) return function () {}
            var timer = null
            var lastFacts = null
            var publish = function () {
              timer = null
              var facts = sessionRowFacts(sessions.list.getSnapshot())
              if (facts === lastFacts) return
              lastFacts = facts
              post({ type: 'sessions-dirty' })
            }
            var schedule = function () {
              // Membership and title are re-derived from the sessions and
              // workspaces stores, so a workspace change is a row change too.
              if (timer !== null) return
              timer = setTimeout(publish, SESSION_FACTS_DEBOUNCE_MS)
            }
            var offSessions = sessions.list.subscribe(schedule)
            var offWorkspaces = workspaces.list.subscribe(schedule)
            publish()
            return function () {
              offSessions()
              offWorkspaces()
              if (timer !== null) clearTimeout(timer)
            }
          }, 'vscode-embed-bridge: session list publish')
        },
      }
    },
  })
})()
