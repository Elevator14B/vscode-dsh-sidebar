import type { Owner } from './runtime-ownership'

/** Private IPC protocol between one Extension Host and its process guardian. */
export interface LaunchSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

/** Commands carry no authority beyond the inherited parent IPC channel. */
export type GuardianCommand =
  | { readonly type: 'start'; readonly spec: LaunchSpec }
  | { readonly type: 'stop' }

/** The guardian reports output only while its owning Extension Host is connected. */
export type GuardianEvent =
  | { readonly type: 'ownership'; readonly identity: Owner }
  | { readonly type: 'process-started'; readonly pid: number }
  | { readonly type: 'process-reaped'; readonly pid: number }
  | { readonly type: 'log'; readonly text: string }
  | { readonly type: 'version'; readonly message: string; readonly version?: string; readonly ok: boolean }
  | { readonly type: 'url'; readonly url: string; readonly pid: number }
  | { readonly type: 'failure'; readonly message: string }
  | { readonly type: 'stopped' }

/** Includes the DSH CLI's own five-second graceful disposal budget. */
export const STOP_GRACE_MS = 8_000
/** Maximum wait for the previous Host's guardian to finish shutting down. */
export const OWNER_WAIT_MS = 15_000
/** Bounded startup diagnostic buffer; logs continue streaming after readiness. */
export const OUTPUT_LIMIT = 64 * 1024
