/**
 * Native Sessions tree: mirrors the web sidebar's session list for the pinned
 * workspace, read through the local DSH api-proxy (`session/list` unary RPC).
 */
import * as vscode from 'vscode'

interface SessionSummaryWire {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly cwd?: string
  readonly projections?: { readonly values?: Readonly<Record<string, unknown>> }
}

interface SessionListValue {
  readonly items: readonly SessionSummaryWire[]
}

/** Read the current-session title or the durable title projection. */
function titleOf(item: SessionSummaryWire): string {
  const projected = item.projections?.values?.['title']
  if (typeof projected === 'string' && projected !== '') return projected
  return item.blank ? 'New Session' : item.sessionId
}

/** Compact wall-clock age for the description column. */
function ageOf(updatedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** One row in the native Sessions view. */
export class SessionNode extends vscode.TreeItem {
  constructor(
    readonly sessionId: string,
    label: string,
    description: string,
    tooltip: string,
    icon: 'running' | 'idle' | 'blank',
  ) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.description = description
    this.tooltip = tooltip
    this.iconPath = new vscode.ThemeIcon(icon === 'running' ? 'sync~spin' : icon === 'blank' ? 'add' : 'comment')
    this.contextValue = 'dshSession'
    this.command = {
      command: 'dsh.embed.openSession',
      title: 'Open Session',
      arguments: [this.sessionId],
    }
  }
}

/**
 * Slow cadence keeping the relative age column moving. Everything else — new,
 * removed, renamed, running-to-idle — arrives as a bridge trigger; the timer is
 * only the clock-tick and cross-process safety net.
 */
const AGE_REFRESH_MS = 30_000

/** Native session list provider data source. */
export class SessionsProvider implements vscode.TreeDataProvider<SessionNode> {
  private items: SessionNode[] = []
  private readonly change = new vscode.EventEmitter<SessionNode | undefined>()
  private timer: NodeJS.Timeout | undefined
  /** Workspace membership published by the bridge (web sidebar order). */
  private workspaceIds: ReadonlySet<string> | undefined
  /** Facts of the published rows; equal text means the tree has nothing to repaint. */
  private published: string | null = null
  /** Last reported read failure, so a backend that stays down repaints once. */
  private failure: string | null = null
  /** In-flight read; triggers arriving during it request one trailing read. */
  private inflight: Promise<void> | null = null
  private trailing = false

  /** @inheritdoc */
  readonly onDidChangeTreeData = this.change.event

  /**
   * @param origin - Resolver for the current proxy origin (live).
   * @param log - Optional structured telemetry sink for refresh failures.
   */
  constructor(
    private readonly origin: () => string | undefined,
    private readonly log?: (event: string, data?: Record<string, unknown>) => void,
  ) {}

  /** Read the list now, then keep relative ages moving on the slow cadence. */
  start(): void {
    void this.refresh()
    this.timer = setInterval(() => { void this.refresh() }, AGE_REFRESH_MS)
  }

  /**
   * Read the list and repaint when a visible row fact changed. Concurrent
   * triggers coalesce into the in-flight read plus at most one trailing read,
   * so a burst of bridge signals costs one extra round trip, not one per call.
   * @returns once the rows reflect the latest completed read.
   */
  refresh(): Promise<void> {
    if (this.inflight !== null) {
      this.trailing = true
      return this.inflight
    }
    const run = (async () => {
      do {
        this.trailing = false
        await this.read()
      } while (this.trailing)
    })().finally(() => { this.inflight = null })
    this.inflight = run
    return run
  }

  private async read(): Promise<void> {
    const origin = this.origin()
    if (origin === undefined || this.workspaceIds === undefined) {
      // No workspace membership yet: the web sidebar itself is empty until the
      // workspace state arrives, so an unbound session must not flash a row.
      this.publish([], [])
      return
    }
    try {
      const value = await dshRpc<SessionListValue>(origin, 'session/list', { _request: {} })
      const now = Date.now()
      // Workspace membership is the authority: the bridge reports the web
      // sidebar's exact per-workspace sessionIds. Do not re-filter by cwd —
      // the backend may store a canonical (symlink-resolved) path while VS
      // Code reports the linked form.
      const byId = new Map(value.items.map(item => [item.sessionId, item]))
      // Keep the workspace's manual order, exactly like the web sidebar list.
      const items: SessionNode[] = []
      const facts: string[] = []
      for (const sessionId of this.workspaceIds) {
        const item = byId.get(sessionId)
        if (item === undefined) continue
        const label = titleOf(item)
        const description = `${item.running ? '● ' : ''}${ageOf(item.updatedAt, now)}`
        items.push(new SessionNode(
          item.sessionId,
          label,
          description,
          `${item.cwd ?? '(no cwd)'}\n${item.sessionId}${item.running ? '\nrunning' : ''}`,
          item.blank ? 'blank' : item.running ? 'running' : 'idle',
        ))
        facts.push(rowFacts(item.sessionId, label, description, item.blank, item.running))
      }
      this.publish(items, facts)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Backend restarting or forwarding not ready: keep the last rows and
      // repaint only when the failure itself changed, so a backend that stays
      // down does not repaint the view on every trigger.
      this.log?.('session-panel.error', { message })
      if (message === this.failure) return
      this.failure = message
      this.change.fire(undefined)
    }
  }

  /**
   * Adopt the workspace membership published by the bridge. The read that
   * follows repaints only if the rows it exposes actually changed.
   */
  updateWorkspaceSessions(ids: readonly string[]): void {
    this.workspaceIds = new Set(ids)
    void this.refresh()
  }

  /** Dispose the polling timer. */
  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.change.dispose()
  }

  /** @inheritdoc */
  getChildren(): SessionNode[] {
    return this.items
  }

  /** @inheritdoc */
  getTreeItem(element: SessionNode): vscode.TreeItem {
    return element
  }

  private publish(items: SessionNode[], facts: readonly string[]): void {
    this.failure = null
    // VS Code re-resolves every row on each `onDidChangeTreeData`, and the row
    // objects are rebuilt per read, so nothing lets it diff: firing for an
    // identical list repaints the whole view for nothing.
    const signature = facts.join('\n')
    if (signature === this.published) return
    this.published = signature
    this.items = items
    this.change.fire(undefined)
  }
}

/** Visible facts of one row; a difference here is what earns a repaint. */
function rowFacts(
  sessionId: string,
  label: string,
  description: string,
  blank: boolean,
  running: boolean,
): string {
  return [sessionId, label, description, blank ? '1' : '0', running ? '1' : '0'].join('\u0000')
}

/**
 * Call one DSH typert unary RPC through the loopback proxy.
 * The payload arg key is endpoint-specific: `session/list` and friends declare
 * `_request` while mutation endpoints (`session/create`, `workspace/*`) declare
 * `request`, so callers pass the exact `{ args }` object.
 */
export async function dshRpc<T>(origin: string, endpoint: string, args: Record<string, unknown>): Promise<T> {
  const rpcId = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const body = {
    type: 'client-request',
    rpcId,
    method: endpoint,
    payload: { args },
  }
  const timeout = new AbortController()
  const timer = setTimeout(() => { timeout.abort() }, 5000)
  try {
    const response = await fetch(`${origin}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeout.signal,
    })
    if (!response.ok) throw new Error(`dsh rpc ${endpoint}: HTTP ${response.status}`)
    const envelope = await response.json() as {
      type: string
      result: { ok: boolean; value?: unknown; error?: { message: string } }
    }
    if (!envelope.result.ok) throw new Error(`dsh rpc ${endpoint}: ${envelope.result.error?.message ?? 'failed'}`)
    return envelope.result.value as T
  } finally {
    clearTimeout(timer)
  }
}
