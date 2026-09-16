# Changelog

All notable changes to this project. The version numbers continue the sequence this extension used before
its first public release; `0.3.11` is the first version published on GitHub.

## 0.3.14

### Changed

- Agent title-bar refresh now reloads the page without restarting DSH. Reconnect and backend restart are separate commands; the restart title names its effect on running tasks.
- Page recovery observes Extension Host round trips, forwarded proxy identity, DSH connection state and the selected session's history state independently.
- Automatic recovery requests DSH reconnection and rechecks port forwarding, with bounded attempts. History loading over 15 seconds displays recovery actions. Page replacement stays explicit to preserve drafts.
- Session-selection bursts are coalesced; disconnected selection retains only the latest request. Recovery never retries message submissions.
- Telemetry identifies the Host, workspace, runtime and page, and distinguishes selection receipt from completed history loading. Routine health polling does not write trace rows.

### Fixed

- Delayed forwarding and startup responses cannot update a replaced or disposed webview. Forwarding resolution has a deadline and concurrent repair requests share one operation.

## 0.3.13

### Changed

- DSH now belongs to its Extension Host. SSH disconnection keeps the existing backend;
  Extension Host exit closes an inherited IPC channel and an independent guardian reaps DSH.
- A kernel-owned loopback listener reserves each canonical workspace until cleanup finishes.
  A replacement Host waits for the old runtime instead of starting another backend on a random port.
  Two live windows on the same workspace now report ownership contention instead of competing for session locks.
- Shutdown allows eight seconds for graceful disposal before escalation. Linux cleanup also tracks
  observed descendants that create their own process groups. A surviving Host handles guardian failure.
- Shell heartbeats update in-memory status instead of synchronously appending to shared telemetry.

### Fixed

- Startup cancellation, authentication failure, concurrent restart and disposal no longer leave an
  unowned backend or publish a stale generation. Disposed runtimes cannot restart.
- Launch URLs split across stdout chunks are assembled before authentication. Startup buffers and
  IPC log queues are bounded, and authentication has a deadline.
- Proxy teardown explicitly closes WebSocket and upstream connections as well as pending HTTP requests.
- The packaged guardian and real CLI lifecycle are exercised by `npm run smoke`.

## 0.3.12

### Added

- **Sessions tree: manual order and archive.** Drag one session row onto another to move it there, or use
  *Move Session Up*, *Move Session Down* and *Archive Session* from the row's context menu. Both mutations go
  through the Workspace RPCs the web sidebar itself uses (`workspace/insertSessionBefore`,
  `workspace/archiveSession`), so the two surfaces keep one manual order and one archive set: archived rows
  leave the native tree the same way they leave the web list.
- **Delivery cards open in VS Code.** The delivery cards at the end of a turn route every open gesture to the
  editor — click opens the file, the chevron offers *Open in Editor*, *Open to the Side* and *Reveal in
  Explorer* — instead of the serving host's desktop, which a Remote-SSH host does not have.
- `npm run smoke` now also drives `workspace/insertSessionBefore` and `workspace/archiveSession` against a
  real `dsh` (five checks).

### Changed

- The RPC helper and the session order/archive actions moved to `src/session-actions.ts`;
  `src/session-panel.ts` re-exports the helper, keeps the manual order and drops archived sessions.

## 0.3.11

### Added

- Startup gate on the DeepSeek Harness CLI version (`src/dsh-version.ts`): an older `dsh` is refused with
  the upgrade command, a newer one starts with a warning, and output carrying no version never blocks.
- `npm run smoke`: a contract test that spawns a real `dsh`, exchanges the launch token for the
  browser-session cookie and calls `session/list`.
- GitHub Actions: `ci` (typecheck, tests, package, contract smoke against the tested `dsh`, plus an
  informational job against `dsh@latest`) and `release` (VSIX attached to the tag's release).

### Changed

- Renamed the extension to **DSH Sidebar** (`dsh-sidebar`) and pointed repository metadata at GitHub.

### Fixed

- In-page copy now routes through the extension host clipboard instead of the nested frame's
  `navigator.clipboard`.

## 0.3.10

- Reference chips from drags, exact selection ranges, and a command that references the enclosing code block.

## 0.3.9

- Read the session remote by its own service name.

## 0.3.8

- Intercept the path-open RPC through a URL input.
- Route produced-file links and tool file links into the editor.

## 0.3.7

- Choose the browser for links from a right-click menu.
- Open produced-file links in the editor.

## 0.3.6

- Keep subagent sessions on the pinned workspace.
- Scope embedded sessions to the pinned folder.

## 0.3.5

- Start the backend with the window and pin its port.
- Ship embedded runtime startup recovery.

## 0.3.4

- Scope guard and link fixes.

## 0.3.1 – 0.3.3

- Sidebar integration, workspace pinning, theme following and the reference command surface, packaged as
  VSIX iterations before the first public snapshot.
