# Workspace keeper runtime lifecycle

One canonical workspace is served by one detached **workspace keeper** process, not by an Extension Host.
The keeper owns the DSH backend for that folder, and every window or Remote-SSH connection of the folder
attaches to it. SSH transport loss, a hidden webview and a replaced or exited Extension Host do not stop the
backend; the last window leaving does, after the idle grace. Different folders keep separate keepers,
separate control ports and separate backends.

## Process and connection ownership

The Extension Host side — `ensureKeeper` in `src/runtime-client.ts`, driven by `DshRuntime` — spawns the
packaged `dist/runtime-keeper.js` with `spawn(process.execPath, [keeperPath, '--cwd', realpath])`: detached,
`stdio: 'ignore'`, `ELECTRON_RUN_AS_NODE=1`, and no IPC channel to any window. The keeper is therefore
independent of the Extension Host that forked it: it survives that Host, the window and the SSH connection.

The keeper launches the configured command directly — there is no `dsh --version` probe — with the
environment the first attaching Host passed. It reads the launch URL from stdout with a 90-second deadline
and accepts the one-time token only after a delimiter, so a token split across chunks is not consumed early.
A CLI that cannot serve `dsh web` fails with its own exit output. The keeper then exchanges the launch URL
for the browser-session cookie (10-second deadline) and publishes `ready` to every attached Host.

The control protocol is newline-delimited JSON on a workspace-derived loopback port. Requests are `status`,
`attach` (carrying the launch spec), `restart` and `detach`; events are `ready`, `state`, `log` and
`failure`. Every request must carry the keeper token published in the share record: possession of that token
is the only authority the socket accepts, a wrong token closes the connection, and an over-long line or a
line that is not valid JSON drops the socket. `status` proves the port speaks the protocol
without registering a client. `state` carries the backend state (`idle`, `starting`, `ready`, `failed`) and
the number of attached Hosts.

Each attached Host opens its own control socket and its own window proxy; it never owns the backend. The
keeper broadcasts to all of them, so they observe one backend's life: the same launch, cookie, restart and
failure. A Host that detaches closes only its own socket.

Cleanup is separate from the window. The keeper gives the CLI its own process group and tracks the process
tree: Linux snapshots record PID and kernel start time for descendants, including observed descendants that
subsequently detach. Shutdown requests DSH's graceful termination first, allows eight seconds (DSH itself
allows five), then escalates and waits for processes to leave. Zombies are no longer writers and do not
retain file locks. Cleanup never kills the Extension Host's process group or unlinks `session.lock`.

A keeper that dies is detected by its clients as a closed control socket. Each Host drops readiness
(`runtime.origin` becomes undefined) and the connection ladder attaches again. The next `ensureKeeper`
re-reads the record: a changed token means the keeper was replaced under it and it retries; a missing record
or a dead keeper PID means it takes the bootstrap lock and forks a replacement. A record whose PID is still
alive is never replaced by a fork — a keeper that has not published a new record yet must not be duplicated,
so the Host keeps retrying it until the attach deadline. The replacement reads the dead keeper's record
before overwriting it and reaps the orphaned backend only when the recorded PID still has the recorded
kernel start time, so PID reuse can never kill a stranger; a record that names no backend, or whose identity
no longer matches, kills nothing. If the CLI dies while its keeper lives, the keeper has no state change for
it: the attached windows keep a URL that no longer answers until the bounded rebuild sequence runs a restart
through the keeper, which is what starts the CLI again.

## Workspace sharing and rendezvous

Workspace identity is `sha256(username + canonical realpath of the folder)` — the same key the earlier
exclusive reservation used, so a workspace keeps its identity. The keeper publishes one share record per
workspace at `~/.dsh/vscode-embed/workspaces/<key>.json`, mode `0600`, holding
`{protocol, key, port, token, pid, startedAt, backend?}`; `protocol` is `dsh-sidebar-keeper-v1`, and
`backend` is the running CLI's PID plus kernel start time once it is ready. Tests and the contract smoke
override the record directory (`DSH_EMBED_SHARE_DIR`, a test-only override) so they never touch a real
window's records.

The control port is chosen from eight candidates derived from the key in 44000–59999; the keeper binds the
first free one, so a stale or foreign listener on one candidate cannot block the workspace. A replacement
keeper may land on a different candidate than its predecessor.

Concurrent window starts must not fork two keepers for one folder. The first process to create `<key>.lock`
with `O_EXCL` wins; a lock whose recorded holder is gone is stale and is replaced, and two racers both
trying that still end with exactly one winner because creation is exclusive. The winner spawns the keeper
and holds the lock until it has attached; every other Host waits for the published record. A client never deletes a record — a
stale one is left in place for the replacement keeper to read. An attach connects to the recorded port and
proves it with a 5-second handshake; if that fails, the Host re-reads the record, retries when the token
changed (the keeper was replaced under it), and otherwise treats the record as stale. The whole attach has a
150-second deadline.

The backend keeps a stable port derived from the canonical cwd (39200–39999) so the Web surface prompt stays
byte-identical across restarts, which is what keeps the provider's prompt cache warm. An occupied backend
port is a CLI failure reported through the keeper, not permission to start another backend on a random port.
An unrelated collision needs an explicit command/args port override; such an override still goes through the
same keeper.

With no client attached, the keeper arms the idle timer and stops the CLI when it expires (`IDLE_GRACE_MS`,
120 seconds; a test may shorten it with `--grace`), then closes its control listener, removes its record and
exits. Any attach cancels the timer, and a zero grace reaps immediately. That is what makes one connection
leaving harmless to the others while still reclaiming the backend after everybody left.

Session flock remains the final cross-process writer exclusion. A manual CLI, another workspace or another
machine may own a session; the keeper does not steal that session or replace its lock.

Different workspaces stay isolated because every rendezvous value is derived from the canonical path and the
OS user: distinct key, record file, candidate control ports and keeper process, each with its own backend.
A failure in one workspace — a dead keeper, a wedged backend — is invisible to the others.

## Startup and teardown

Concurrent starts share a promise; concurrent restarts in one window share one operation. Stop immediately aborts
the current generation. Every later await checks cancellation before publishing ready. Failures close the
window proxy and detach the control socket before a generation can be replaced. Disposal is terminal for
that runtime object, and it never stops the backend: it detaches, and every other window of the folder keeps
using the shared keeper.

URL discovery has a 90-second deadline, authentication 10 seconds, the attach 150 seconds and the keeper
handshake 5 seconds. Launch tokens are assembled across stdout chunks and accepted only after a delimiter.
The keeper keeps the last 64 KiB of CLI output and replays it to a late attach, then streams later output to
every attached Host; a Host that has gone away is dropped rather than awaited.

The proxy tracks incoming and outgoing sockets and pending HTTP requests. Close rejects new use and destroys
both sides of upgraded WebSockets; repeated closes join the same promise. Authentication and upstream header
waits have deadlines. Streaming responses remain open until completion or cancellation. Window theme and
bridge state remain private to each Host; the browser-session cookie is shared by every Host attached to
that workspace, delivered over the keeper's loopback control socket and injected upstream by each window's
proxy.

Tearing down a window does not wait for the CLI: `dispose()` detaches the control socket and closes the
proxy, and process cleanup remains the keeper's job. A CLI process stuck in uninterruptible kernel I/O can
outlive the keeper's eight-second escalation and keeps the keeper in shutdown until it leaves; a window that
starts meanwhile goes through the same keeper instead of forking a second one.

## Page connection recovery

One host-side ladder owns every repair decision. The injected `connection-recovery.js` only reports DSH's own `connection.state` and answers a host `reconnect-page` request with `connection.reconnect()`; it keeps no timer and no threshold. The local `recovery-shell.js` posts `shell-alive` every three seconds, relays messages, and renders the status text the host sends; the banner has no buttons and its wording is localised in the shell.

`DshWebviewProvider` runs the ladder every three seconds (`MAINTAIN_INTERVAL_MS`) while the Agent view is resolved. When the runtime has no origin, or its origin is no longer the one the page was rendered against, the ladder loads the page again — starting the runtime when it is absent — at most once per fifteen seconds (`RESTART_BACKOFF_MS`); a runtime that is still starting is left to finish. Nothing is running in that state, so a silent client does not pause it: a failed start is retried until it succeeds. With a live runtime at the rendered origin, a webview that has not sent `shell-alive` for twelve seconds (`CLIENT_STALE_MS`) is asleep or disconnected: the ladder publishes "waiting for the remote connection" and takes no other action, so a silent client never restarts an agent that may still be working. Otherwise it gives the page twelve seconds (`PAGE_BOOT_MS`) to install its bridge, asks the page to reconnect once, and then rebuilds the webview on a fresh loopback authority, at most once per fifteen seconds (`REBUILD_INTERVAL_MS`). After three rebuilds that still never report DSH `connected`, the backend is restarted instead (`MAX_REBUILDS`, `MAX_AUTO_RESTARTS`), because a page that cannot connect is then the wrong suspect. A bridge that reports DSH `connected` clears the counters and hides the banner. **DSH Sidebar: Restart Agent Runtime (Interrupts Running Tasks)** remains the separate, explicit restart command. Either restart goes through the keeper, so it replaces the backend shared by every window of that folder and interrupts tasks wherever they run in that workspace.

A rebuild rotates only the browser-facing proxy: `rotateOrigin` calls `relisten`, which drops the current listener and its sockets and binds a port VS Code has never resolved, then the webview is re-rendered with a new page identity. That is what repairs a forward whose tunnel died while `asExternalUri` kept answering with the same local URL; the backend process and its port stay untouched. The host reopens the session it last opened through the tree; state that lived only in the replaced document is not preserved, and a session selected inside the page itself is restored by DSH's own boot state. Each render resolves its forwarded authority with `asExternalUri` under a fifteen-second deadline, and the ladder retries later when that fails. The transport itself is outside the extension's control: a rebuild repairs the forward VS Code is caching, not an unhealthy SSH connection.

Showing the view and focusing the window call `wake()`, which clears the backoff and runs the ladder immediately. **DSH Sidebar: Recover Connection** rebuilds the page unconditionally — it is the user saying the page is wrong, so it does not wait for a health signal a frozen page can no longer send. Startup failures render a short diagnosis with no buttons; the ladder starts the runtime again without waiting for a user wake. Page identity scopes every message: handlers reject messages and status for any other page.

The ladder never resends a prompt. It replaces the backend only after the bounded rebuild sequence above, and that replacement goes through the keeper. The bridge refuses a new-session request while DSH reports itself disconnected, and queued session opens coalesce to the latest request until the connection returns. `webview.status` and `webview.connection-changed` enter the trace; shell liveness updates `lastHeartbeatAt` in memory only. Trace rows carry Host PID, workspace and runtime identity, and page messages carry page identity. These are UI health signals, never backend ownership signals.

## Scope and migration

The real process/lock regression suite targets Linux Remote SSH. macOS uses POSIX group cleanup; Windows
uses `taskkill /T /F`. These platforms still need real editor lifecycle validation. The keeper is not an OS
process container: an arbitrary double-forked daemon that escapes before observation is outside its hard
cleanup guarantee, and a recorded backend whose kernel start time no longer matches is deliberately left
alone instead of killed. Custom launchers must remain attached to their launched command and keep the normal
stdout URL protocol.

Runtimes from 0.3.12–0.4.0 have no keeper and cannot be retroactively adopted. Finish or cancel their work
and stop the old runtime before first use of this version. A share record left behind by a killed keeper is
handled automatically on the next attach: the replacement reads it, reaps the orphan it names and overwrites
it. Do not delete session lock files. Reloading the extension creates the new lifecycle; it does not transfer
live execution.

## Verification

`tests/runtime-keeper.test.cjs` starts the packaged keeper against the backend fixture and checks that two
clients share one backend URL, that a `status` probe does not register a client, that the backend survives
the first detach past the idle grace and is reaped after the last one (the record removed with the keeper),
and that a second workspace gets a distinct key and control port. The fixture deliberately splits
its launch URL across stdout chunks, so token framing is exercised too.

`tests/runtime-lifecycle.test.cjs` builds `src/runtime.ts` and drives the real `DshRuntime` against that
fixture: concurrent `getWebUrl()` calls share one backend; a second runtime on the same folder attaches to
the same keeper and backend port and keeps working after the first one disposes; the backend is reaped after
the last detach; different folders keep different keepers and backends; `restart()` replaces the shared
backend without changing the window's proxy authority; and a SIGKILLed keeper is replaced on the next attach
while its orphaned backend is reaped.

`tests/proxy-lifecycle.test.cjs` holds real WebSocket and HTTP connections open during teardown and verifies
that `relisten` binds a fresh port and drops the old listener. `npm run smoke` (scripts/smoke.js) exercises
the installed DSH CLI through `DshRuntime` and the keeper: keeper launch, the cookie-authenticated proxy
page, `session/list`, `workspace/insertSessionBefore`, `workspace/archiveSession`, a second window attaching
to the same backend port, one window detaching while the other keeps working, and the last detach letting
the keeper reap the backend. The smoke and the lifecycle test point the keeper at a temporary share
directory with a shortened idle grace (`DSH_EMBED_SHARE_DIR`, `DSH_EMBED_IDLE_GRACE_MS`; test overrides, not
settings), so they never touch a real window's records.

`connection-recovery.test.cjs` checks, with a controlled clock, that the injected page module only reports
DSH state and reconnects when asked, that the shell renders host status and relays both directions, and
that it reports liveness on every tick. `webview-recovery.test.cjs` drives the host ladder: rebuild on a
fresh authority, a connected page left alone, a silent client pausing recovery, immediate repair when the
view is shown again, a booting runtime left to start, session restore after a rebuild and status replay to
a fresh shell. The end-to-end recovery smoke was retired with the button-driven shell it drove; the ladder
above is covered by the two unit suites, and browser acceptance of the transport remains an editor check.

Actual Remote SSH disconnect/reconnect and Extension Host replacement remain editor acceptance checks;
the process tests do not claim to reproduce VS Code's transport implementation.
