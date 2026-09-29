# Changelog

All notable changes to this project. The version numbers continue the sequence this extension used before
its first public release; `0.3.11` is the first version published on GitHub.

## Unreleased

### Changed

- The tested DeepSeek Harness CLI is now `0.2.0-rc.1`: the README compatibility notes and the CI contract
  job pin that version, and `npm run smoke` passes against it.

## 0.5.0

### Fixed

- The workspace keeper now uses its 120-second idle grace when the override is unset. Previously an
  unset value parsed as zero, so the keeper exited before the Extension Host could attach and the
  sidebar timed out during startup.
- A file mention in the closing message opened nothing when the file was **delivered** through the `present`
  tool. The web app sends those gestures to the serving Host's own desktop opener (`/api/present.open`),
  which answers `409 Host desktop unavailable` on a headless Remote-SSH host, and the failure stays on the
  delivery card rather than the prose tile. The bridge now serves every prose file mention — produced and
  delivered alike — from the tile's own tooltip path and opens it in the editor, the way it already served
  the delivery cards and produced-file chips.

### Changed

- DSH now belongs to a per-workspace keeper instead of an Extension Host. The keeper is one detached process
  per canonical workspace with no IPC channel to any window; several Remote-SSH connections or windows of
  the same folder attach to the same backend through it. `src/runtime-guardian.ts` and
  `src/runtime-ownership.ts` are removed and replaced by `src/runtime-keeper.ts`, `src/runtime-client.ts`
  and `src/runtime-workspace.ts`.
- Disposing a runtime only detaches: the window closes its proxy and its control socket, and every other
  window of that folder keeps using the same backend. The keeper reference-counts attached Hosts and reaps
  the CLI only after the last client detached and the idle grace expired (`IDLE_GRACE_MS`, 120 seconds).
- `restart()` replaces the shared backend through the keeper, so it interrupts running tasks in every window
  of that folder rather than only the window that asked. `rotateOrigin()` still rotates the window's
  browser-facing proxy and leaves the backend untouched.
- The browser-session cookie is minted and held by the keeper and shared by every attached Host; a window
  receives it over the loopback control socket after presenting the token from the `0600` share record, and
  its proxy injects it upstream. The browser still never receives it.

### Added

- `src/runtime-workspace.ts` publishes one owner-only share record per workspace
  (`~/.dsh/vscode-embed/workspaces/<key>.json`) and takes a bootstrap lock, so concurrent windows of one
  folder fork exactly one keeper.
- A replacement keeper reads its dead predecessor's record before overwriting it and reaps the orphaned
  backend only when the recorded PID still has the recorded kernel start time.
- A dead keeper is detected by the control socket closing; readiness drops, and the next attach forks a
  replacement. Different workspaces keep separate keys, control ports, keepers and backends.
- `npm run smoke` now checks eight contracts: keeper launch, the cookie-authenticated proxy page,
  `session/list`, `workspace/insertSessionBefore`, `workspace/archiveSession`, a second window attaching to
  the same backend port, one window detaching while the other keeps working, and the last detach letting the
  keeper reap the backend.

## 0.4.0

### Changed

- The runtime launches the configured command directly (`dsh web --port N --no-open`). The `dsh --version`
  probe, `src/dsh-version.ts` and the minimum-version gate are gone; a CLI that cannot serve `dsh web`
  fails with its own message on the Agent view's startup page and in the **DSH Sidebar** output channel.
- Connection maintenance is one ladder in the Extension Host, driven by `MAINTAIN_INTERVAL_MS` (three
  seconds). A live runtime is repaired by rebuilding the page on a fresh loopback authority
  (`rotateOrigin` → `relisten`); a runtime that is gone is started again, at most once per
  `RESTART_BACKOFF_MS` (fifteen seconds).
- A webview that stops sending `shell-alive` for `CLIENT_STALE_MS` (twelve seconds) pauses the page
  ladder once a page is rendered, so a sleeping window cannot make the extension restart an agent that is
  still working; a runtime that is absent or unrendered is still started again without a user wake. Showing
  the view and focusing the window clear the backoff and repair immediately, and **DSH Sidebar: Recover
  Connection** always rebuilds the page.
- A page that reports DSH `connected` clears the ladder. Three rebuilds that still never connect restart
  the backend instead (`MAX_REBUILDS`, `MAX_AUTO_RESTARTS`), so a wedged-but-listening backend cannot leave
  the view rebuilding forever.
- The connection banner has no buttons: it renders host-supplied status text, localised in
  `src/recovery-shell.js` (reconnecting, rebuilding the page, starting the runtime, waiting for the remote
  connection). The startup error page keeps a selectable diagnosis and retries automatically.
- The injected page module (`src/connection-recovery.js`) only reports DSH's own `connection.state` and
  answers `reconnect-page`; its health probe, history observation, forwarding repair and retry ladder are
  gone.

### Added

- **DSH Sidebar: Recover Connection** (`dsh.embed.recover`), also the Agent view title-bar icon, runs the
  connection ladder immediately. It replaces **DSH Sidebar: Reload Agent Page** (`dsh.embed.refreshPage`)
  and **DSH Sidebar: Reconnect Agent** (`dsh.embed.reconnect`), which are removed.

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
