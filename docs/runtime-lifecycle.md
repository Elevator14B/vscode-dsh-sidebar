# Extension Host runtime ownership

DSH belongs to one Extension Host, not the longer-lived VS Code Server. SSH transport loss and hidden
webviews do not stop DSH. Replacing the Extension Host stops its backend; a replacement starts a new
backend and resumes persisted sessions. In-flight execution is not transferred across Hosts.

## Process and connection ownership

`DshRuntime` starts the packaged `runtime-guardian.js` with a private Node IPC channel. The guardian
launches the configured command directly — there is no `dsh --version` probe — consumes its output, and
watches IPC EOF. A CLI that cannot serve `dsh web` fails with its own exit output. The guardian does not
use a browser heartbeat, SSH state, a PID-file timeout or an inactivity timer to decide when the owner has
exited. Normal `deactivate()` awaits shutdown; abrupt Host death closes IPC and invokes the same guardian
path.

The guardian creates a separate POSIX process group for each command. Linux snapshots record PID and
start time for descendants, including observed descendants that subsequently detach. Shutdown requests
DSH's graceful termination first, allows eight seconds (DSH itself allows five), then escalates and waits
for processes to leave. Zombies are no longer writers and do not retain file locks. Cleanup never kills
the Extension Host's process group or unlinks `session.lock`.

The Host receives command process identities and keeps a copy of the ownership listener. If the guardian
crashes while the Host survives, the Host reaps the known command trees before releasing that listener.
If the Host crashes, the guardian retains its copy until cleanup completes. No DSH changes or native
addon installation are needed for this lifecycle.

## Workspace exclusion

A read-only loopback listener is a kernel-owned reservation for the OS user and canonical workspace path. Its
candidate port is derived from SHA-256, in 44000–59999; up to eight candidates disambiguate collisions
with other verified Sidebar workspace reservations. The listener exposes only a protocol identifier,
workspace hash and owner PID. Control operations are accepted only over the inherited IPC channel.

The reservation is taken before the command is launched. A new Host waits up to 15 seconds for an existing
reservation to close. If the other Host remains alive, startup reports that workspace's owner rather
than creating another writer backend. An unresponsive or unrecognized reservation fails closed. The
kernel releases the listener when its final owner closes or dies; there is no stale lock file on shared
HOME and no PID-file deletion race. Reservations apply within the local network namespace.

The preferred backend port is still derived from cwd for prompt-cache stability. Backend EADDRINUSE
is now an error, not permission to spawn another backend with port 0. This also prevents silently bypassing
an older, unguarded Sidebar runtime. An unrelated backend-port collision needs an explicit command/args
port override. Such an override still goes through workspace ownership.

Session flock remains the final cross-process writer exclusion. A manual CLI, another workspace or
another machine may own a session; this mechanism does not steal that session or replace its lock.

## Startup and teardown

Concurrent starts share a promise; concurrent restarts share one stop/start operation. Stop immediately
aborts the current generation. Every later await checks cancellation before publishing ready. Failures
reap the guardian and close the proxy before a generation can be replaced. Disposal is terminal.

URL discovery has a 90-second deadline, authentication 10 seconds, and the overall guardian handshake
150 seconds. Launch tokens are assembled across stdout chunks and accepted only after a delimiter.
Diagnostic tails and pending IPC log output are bounded at 64 KiB. The guardian keeps consuming output
when the Host is busy and drops excess log delivery, not backend work.

The proxy tracks incoming and outgoing sockets and pending HTTP requests. Close rejects new use and
destroys both sides of upgraded WebSockets; repeated closes join the same promise. Authentication and
upstream header waits have deadlines. Streaming responses remain open until completion or cancellation.
Window theme, authentication cookies and bridge state remain private to that Host.

The UI's cleanup wait is bounded at 12 seconds. A process stuck in uninterruptible kernel I/O can outlive
that wait; its guardian and workspace reservation remain, so a retry cannot start a competing writer.

## Page connection recovery

One host-side ladder owns every repair decision. The injected `connection-recovery.js` only reports DSH's own `connection.state` and answers a host `reconnect-page` request with `connection.reconnect()`; it keeps no timer and no threshold. The local `recovery-shell.js` posts `shell-alive` every three seconds, relays messages, and renders the status text the host sends; the banner has no buttons and its wording is localised in the shell.

`DshWebviewProvider` runs the ladder every three seconds (`MAINTAIN_INTERVAL_MS`) while the Agent view is resolved. When the runtime has no origin, or its origin is no longer the one the page was rendered against, the ladder loads the page again — starting the runtime when it is absent — at most once per fifteen seconds (`RESTART_BACKOFF_MS`); a runtime that is still starting is left to finish. Nothing is running in that state, so a silent client does not pause it: a failed start is retried until it succeeds. With a live runtime at the rendered origin, a webview that has not sent `shell-alive` for twelve seconds (`CLIENT_STALE_MS`) is asleep or disconnected: the ladder publishes "waiting for the remote connection" and takes no other action, so a silent client never restarts an agent that may still be working. Otherwise it gives the page twelve seconds (`PAGE_BOOT_MS`) to install its bridge, asks the page to reconnect once, and then rebuilds the webview on a fresh loopback authority, at most once per fifteen seconds (`REBUILD_INTERVAL_MS`). After three rebuilds that still never report DSH `connected`, the backend is restarted instead (`MAX_REBUILDS`, `MAX_AUTO_RESTARTS`), because a page that cannot connect is then the wrong suspect. A bridge that reports DSH `connected` clears the counters and hides the banner. Backend restart remains the separate, explicit **DSH Sidebar: Restart Agent Runtime (Interrupts Running Tasks)** command.

A rebuild rotates only the browser-facing proxy: `rotateOrigin` calls `relisten`, which drops the current listener and its sockets and binds a port VS Code has never resolved, then the webview is re-rendered with a new page identity. That is what repairs a forward whose tunnel died while `asExternalUri` kept answering with the same local URL; the backend process and its port stay untouched. The host reopens the session it last opened through the tree; state that lived only in the replaced document is not preserved, and a session selected inside the page itself is restored by DSH's own boot state. Each render resolves its forwarded authority with `asExternalUri` under a fifteen-second deadline, and the ladder retries later when that fails. The transport itself is outside the extension's control: a rebuild repairs the forward VS Code is caching, not an unhealthy SSH connection.

Showing the view and focusing the window call `wake()`, which clears the backoff and runs the ladder immediately. **DSH Sidebar: Recover Connection** rebuilds the page unconditionally — it is the user saying the page is wrong, so it does not wait for a health signal a frozen page can no longer send. Startup failures render a short diagnosis with no buttons; the ladder starts the runtime again without waiting for a user wake. Page identity scopes every message: handlers reject messages and status for any other page.

The ladder never stops a running backend, changes workspace ownership or resends a prompt. The bridge refuses a new-session request while DSH reports itself disconnected, and queued session opens coalesce to the latest request until the connection returns. `webview.status` and `webview.connection-changed` enter the trace; shell liveness updates `lastHeartbeatAt` in memory only. Trace rows carry Host PID, workspace and runtime identity, and page messages carry page identity. These are UI health signals, never backend ownership signals.

## Scope and migration

The real process/lock regression suite targets Linux Remote SSH. macOS uses POSIX group cleanup;
Windows uses `taskkill /T /F`. These platforms still need real editor lifecycle validation. The portable
guardian is not an OS process container: an arbitrary double-forked daemon that escapes before observation,
or simultaneous forcible death of both Host and guardian, is outside its hard cleanup guarantee.
Custom launchers must remain attached to their launched command and keep the normal stdout URL protocol.

Existing 0.3.12 processes have no guardian or reservation and cannot be retroactively adopted. Finish
or cancel their work and stop the old runtime before first use of this version. Do not delete session
lock files. Reloading the extension creates the new lifecycle; it does not transfer live execution.

## Verification

`tests/runtime-guardian.test.cjs` kills real owner processes, exercises delayed SIGKILL escalation,
and verifies release of a real flock held by an observed detached descendant. `runtime-lifecycle.test.cjs`
drives the actual packaged guardian through `DshRuntime`: one child per generation with no version probe,
authentication failure, cancellation during startup, concurrent restart and guardian crash.
`proxy-lifecycle.test.cjs` holds real WebSocket and HTTP connections open during teardown and verifies that
`relisten` binds a fresh port and drops the old listener. `npm run smoke` exercises the installed DSH CLI
through the guardian and proxy.

`connection-recovery.test.cjs` checks, with a controlled clock, that the injected page module only reports
DSH state and reconnects when asked, that the shell renders host status and relays both directions, and
that it reports liveness on every tick. `webview-recovery.test.cjs` drives the host ladder: rebuild on a
fresh authority, a connected page left alone, a silent client pausing recovery, immediate repair when the
view is shown again, a booting runtime left to start, session restore after a rebuild and status replay to
a fresh shell. The end-to-end recovery smoke was retired with the button-driven shell it drove; the ladder
above is covered by the two unit suites, and browser acceptance of the transport remains an editor check.

Actual Remote SSH disconnect/reconnect and Extension Host replacement remain editor acceptance checks;
the process tests do not claim to reproduce VS Code's transport implementation.
