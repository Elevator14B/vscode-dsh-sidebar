/**
 * Session list actions for the native Sessions tree.
 *
 * The native tree shows the same workspace list as the web sidebar, so the two
 * mutations it offers — archive a Session and move it in the manual order — go
 * through the backend's own Workspace RPCs instead of a native-only shadow
 * order. The planning helpers below are pure so a drop target or a step gesture
 * can be resolved without touching the network.
 */

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

/**
 * Archive one Session for the whole registry. Archiving hides the row without
 * deleting the Session, so `session/list` keeps returning it and the caller
 * must drop the id from the displayed order itself.
 * @param origin - Current proxy origin.
 * @param sessionId - Session to archive.
 */
export async function archiveSession(origin: string, sessionId: string): Promise<void> {
  await dshRpc<unknown>(origin, 'workspace/archiveSession', { request: { sessionId } })
}

/**
 * Move one Session within the workspace's manual order so that it sits
 * immediately before `beforeSessionId`. Without an anchor the Session moves to
 * the end of the list, which is what a plain "move to bottom" sends.
 * @param origin - Current proxy origin.
 * @param workspaceId - Workspace whose manual order changes.
 * @param sessionId - Session to move.
 * @param beforeSessionId - Row the Session lands in front of; omit for the end.
 */
export async function moveSessionBefore(
  origin: string,
  workspaceId: string,
  sessionId: string,
  beforeSessionId?: string,
): Promise<void> {
  await dshRpc<unknown>(origin, 'workspace/insertSessionBefore', {
    request: {
      workspaceId,
      sessionId,
      ...(beforeSessionId === undefined ? {} : { beforeSessionId }),
    },
  })
}

/**
 * Plan a move of `sessionId` to `toIndex` in the displayed order, which is the
 * order with archived rows already removed. The plan is the argument the order
 * RPC takes: an omitted `beforeSessionId` means the end of the list, and
 * `undefined` means there is nothing to write — the id is not displayed, or the
 * move would leave the order exactly as it is.
 * @param ids - Displayed session ids, in order.
 * @param sessionId - Session to move.
 * @param toIndex - Index the Session should occupy afterwards; clamped.
 */
export function planMove(
  ids: readonly string[],
  sessionId: string,
  toIndex: number,
): { beforeSessionId?: string } | undefined {
  const from = ids.indexOf(sessionId)
  if (from === -1) return undefined
  const remaining = [...ids.slice(0, from), ...ids.slice(from + 1)]
  const target = Math.min(Math.max(Math.trunc(toIndex), 0), remaining.length)
  if (target === from) return undefined
  const anchor = remaining[target]
  return anchor === undefined ? {} : { beforeSessionId: anchor }
}

/**
 * Plan a one-row move of `sessionId` towards the top (`-1`) or the bottom
 * (`1`).
 * @param ids - Displayed session ids, in order.
 * @param sessionId - Session to move.
 * @param delta - Direction of the step.
 * @returns the move to write, or undefined when the row is not displayed or is
 * already at that end of the list.
 */
export function planStep(
  ids: readonly string[],
  sessionId: string,
  delta: -1 | 1,
): { beforeSessionId?: string } | undefined {
  const from = ids.indexOf(sessionId)
  if (from === -1) return undefined
  const toIndex = from + delta
  if (toIndex < 0 || toIndex >= ids.length) return undefined
  return planMove(ids, sessionId, toIndex)
}
