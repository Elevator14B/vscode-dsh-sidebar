/**
 * Control protocol between Extension Hosts and the workspace keeper.
 *
 * The keeper belongs to a workspace, not to a window: every Host of that folder
 * attaches to the same backend, and one Host leaving never takes it away from
 * the others. Requests carry the keeper token published in the share record.
 */
/** Everything the keeper needs to spawn the CLI for its workspace. */
export interface LaunchSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

/** Requests one attached Host sends; all of them carry the keeper token. */
export type KeeperRequest =
  | { readonly type: 'status'; readonly token: string }
  | { readonly type: 'attach'; readonly token: string; readonly spec: LaunchSpec }
  | { readonly type: 'restart'; readonly token: string }
  | { readonly type: 'detach'; readonly token: string }

/** Events the keeper broadcasts to every attached Host. */
export type KeeperEvent =
  | { readonly type: 'ready'; readonly url: string; readonly cookie: string; readonly pid: number }
  | { readonly type: 'state'; readonly state: KeeperState; readonly clients: number; readonly url?: string; readonly pid?: number }
  | { readonly type: 'log'; readonly text: string }
  | { readonly type: 'failure'; readonly message: string }

/** Backend states a client can observe. */
export type KeeperState = 'idle' | 'starting' | 'ready' | 'failed'

/** Includes the DSH CLI's own five-second graceful disposal budget. */
export const STOP_GRACE_MS = 8_000
/** Bounded diagnostic buffer; logs continue streaming after readiness. */
export const OUTPUT_LIMIT = 64 * 1024
/** A keeper with no attached Host stays for a while so a reconnect reuses it. */
export const IDLE_GRACE_MS = 120_000
/** Upper bound for one attach, including a cold 'dsh web' boot. */
export const ATTACH_DEADLINE_MS = 150_000
/** Shorter bound for the first reply, so a foreign listener is detected quickly. */
export const HANDSHAKE_DEADLINE_MS = 5_000
/** Protocol line limit; anything larger is a foreign speaker, not a keeper. */
export const MESSAGE_LIMIT = 1024 * 1024
