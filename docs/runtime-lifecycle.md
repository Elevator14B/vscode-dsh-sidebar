# Extension Host runtime ownership

DSH belongs to one Extension Host, not the longer-lived VS Code Server. SSH transport loss and hidden
webviews do not stop DSH. Replacing the Extension Host stops its backend; a replacement starts a new
backend and resumes persisted sessions. In-flight execution is not transferred across Hosts.

## Process and connection ownership

`DshRuntime` starts the packaged `runtime-guardian.js` with a private Node IPC channel. The guardian
runs the version probe and DSH, consumes their output, and watches IPC EOF. It does not use a browser
heartbeat, SSH state, a PID-file timeout or an inactivity timer to decide when the owner has exited.
Normal `deactivate()` awaits shutdown; abrupt Host death closes IPC and invokes the same guardian path.

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

The reservation is taken before version probing. A new Host waits up to 15 seconds for an existing
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

The version probe has a 15-second deadline, URL discovery 90 seconds, authentication 10 seconds, and
the overall guardian handshake 150 seconds. Launch tokens are assembled across stdout chunks and
accepted only after a delimiter. Diagnostic tails and pending IPC log output are bounded at 64 KiB.
The guardian keeps consuming output when the Host is busy and drops excess log delivery, not backend work.

The proxy tracks incoming and outgoing sockets and pending HTTP requests. Close rejects new use and
destroys both sides of upgraded WebSockets; repeated closes join the same promise. Authentication and
upstream header waits have deadlines. Streaming responses remain open until completion or cancellation.
Window theme, authentication cookies and bridge state remain private to that Host.

The UI's cleanup wait is bounded at 12 seconds. A process stuck in uninterruptible kernel I/O can outlive
that wait; its guardian and workspace reservation remain, so a retry cannot start a competing writer.

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
exercises the actual packaged guardian through `DshRuntime`, including authentication failure, cancellation,
concurrent restart and guardian crash. `proxy-lifecycle.test.cjs` holds real WebSocket and HTTP connections
open during teardown. `npm run smoke` exercises the installed DSH CLI through the guardian and proxy.

Actual Remote SSH disconnect/reconnect and Extension Host replacement remain editor acceptance checks;
the process tests do not claim to reproduce VS Code's transport implementation.
