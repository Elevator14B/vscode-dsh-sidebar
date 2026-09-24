# DSH Sidebar

[![ci](https://github.com/Elevator14B/vscode-dsh-sidebar/actions/workflows/ci.yml/badge.svg)](https://github.com/Elevator14B/vscode-dsh-sidebar/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/Elevator14B/vscode-dsh-sidebar)](https://github.com/Elevator14B/vscode-dsh-sidebar/releases/latest)
[![license](https://img.shields.io/github/license/Elevator14B/vscode-dsh-sidebar?style=flat)](LICENSE)

Embed the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) web agent in a VS Code
sidebar webview, pinned to the current workspace folder. It drives the open-source `dsh` CLI you install
yourself.

- Maintainer: [@Elevator14B](https://github.com/Elevator14B)
- Environment: VS Code 1.96+, DSH `0.1.5-rc.1` or newer (tested with `0.1.5-rc.2`), Node.js 22+ on the
  host's `PATH`. Those CLI versions are documentation, not a gate: the extension launches the configured
  command directly and reports what it does.
- Runtime: one detached workspace keeper per folder owns the `dsh` backend on the machine that hosts the
  folder. Every window or Remote-SSH connection to that folder attaches to the same backend.

The extension starts a DSH web runtime (`dsh web`) with the first VS Code workspace folder as its working
directory, proxies the authenticated page into a sidebar webview, and bridges the two sides: the page's own
sidebar is replaced by the VS Code folder, and file/diff navigation, reference chips, the sessions tree and
the theme all live in VS Code natively. The runtime belongs to the folder, not to the window: a detached
workspace keeper owns it, and every window or Remote-SSH connection to that folder attaches to the same one.

## Features

- **Workspace = VS Code folder.** No workspace picker: the DSH workspace is pinned to the folder you have
  open, and session switching happens in a native VS Code tree.
- **Native Sessions tree.** Lists the sessions of the pinned workspace in the same order and with the same
  titles as the web sidebar, with New Session and refresh actions. Drag a row onto another to move it, or use
  *Move Session Up* / *Move Session Down* / *Archive Session* from its context menu; both go through the web
  sidebar's own Workspace RPCs, so order and archive state stay shared between the two surfaces.
- **Native file and diff navigation.** `read` / `write` tool paths in the conversation open the file in
  VS Code; `edit` tool paths open a **tool-change diff** (`old_string` → `new_string`, independent of git).
  The closing turn's produced-file chips, its file mentions in the prose (delivered files included), and
  the delivery cards open in the editor too, and the card's chevron offers *Open in Editor*, *Open to the
  Side* and *Reveal in Explorer* — the host's desktop application is never the target, which is what makes
  them usable over Remote-SSH.
- **Links open inside VS Code.** URLs in the conversation open in the built-in Simple Browser webview, with
  an OS-browser fallback.
- **Drag-to-reference.** Drag an editor tab, an Explorer row, or a compatible native drag into the sidebar to
  insert an `@path#Lx-Ly` reference chip. When the dragged file is the active editor with a non-empty
  selection, the chip references that exact range; otherwise it references the whole file. Every drop reports
  what happened: chip inserted, dragged text placed in the composer, or one warning naming why it failed.
- **Reference from the keyboard.** `ctrl+alt+d` / `cmd+alt+d` references the current selection, or the
  enclosing code block at the cursor when nothing is selected.
- **Right-click reference.** *Reference Selection in DSH*, *Reference Code Block in DSH* and
  *Reference File in DSH* from the editor and Explorer context menus.
- **Copy works inside the page.** The page's copy buttons and copy shortcuts write through the extension
  host's clipboard instead of the nested frame's `navigator.clipboard`, which the browser refuses.
- **Theme follows VS Code.** Light/dark follows `workbench.colorScheme`, live, without touching the shared
  DSH settings document.
- **Local-only runtime.** Each window gets its own loopback proxy; the browser-session auth cookie is minted
  and held by the workspace keeper and handed to a window only over the keeper's loopback control socket,
  after the window presents the token from the owner-only (`0600`) share record. The proxy injects it
  upstream, so the cookie never reaches the client browser.

## Requirements

- VS Code 1.96+
- Node.js 22+ on the `PATH` of the machine that hosts the folder (Remote-SSH and containers are
  supported): `dsh` is a Node CLI and runs under whichever `node` it finds there, not VS Code's bundled Node.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) on the extension host's `PATH`:

  ```sh
  npm install -g @deepseek-ai/dsh
  ```

The extension's workspace keeper launches the configured command directly — there is no pre-flight version
check. A CLI that cannot serve `dsh web` fails with its own message on the Agent view's startup page and in
the **DSH Sidebar** output channel. See [Compatibility](#compatibility).

## Install

No Marketplace listing yet — install the VSIX from
[Releases](https://github.com/Elevator14B/vscode-dsh-sidebar/releases/latest):

```sh
code --install-extension dsh-sidebar-<version>.vsix
```

For Remote-SSH, install on the server (the extension runs where the folder is):

```sh
~/.vscode-server/bin/<commit>/bin/code-server \
  --install-extension dsh-sidebar-<version>.vsix \
  --force --extensions-dir "$HOME/.vscode-server/extensions" \
  --server-data-dir "$HOME/.vscode-server/data"
```

Then open the DSH Sidebar icon in the activity bar (or run **DSH Sidebar: Open Agent**).

## Build from source

```sh
npm ci
npm run typecheck  # extension host types
npm test           # unit tests (node --test, no extension host needed)
npm run smoke      # contract test against a real `dsh` on PATH
npm run build      # bundles dist/extension.js and dist/bridge.js with esbuild
npm run package    # builds and produces dsh-sidebar-<version>.vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

## Compatibility

DeepSeek Harness is in developer preview and does ship compatibility-breaking changes. `0.1.5-rc.2` is the
tested CLI and `0.1.5-rc.1` the documented minimum; neither is enforced. The extension no longer probes
`dsh --version` (there is no `src/dsh-version.ts`) and never refuses a CLI before launching it.

| dsh-sidebar | DeepSeek Harness | Notes |
| --- | --- | --- |
| 0.4.0 | `0.1.5-rc.2` tested, `0.1.5-rc.1` documented | Direct CLI launch without a version gate; one Extension Host connection ladder that rebuilds the page on a fresh forwarding authority. |
| 0.3.14 | `0.1.5-rc.2` tested, `0.1.5-rc.1` minimum | Extension Host ownership, page connection recovery and history timeout feedback. |
| 0.3.12 | `0.1.5-rc.2` tested, `0.1.5-rc.1` minimum | Newer CLIs start with a warning in the output channel; older ones are refused. |
| 0.3.11 | `0.1.5-rc.2` tested, `0.1.5-rc.1` minimum | First public release on GitHub. |

The protocol this build speaks — the launch URL and its one-time token, the `session/list` client-request
envelope, the `workspace/*` order and archive mutations, the boot graph and the sidebar plugin identity — is
not a frozen public API. When a DSH release
changes it, `npm run smoke` and the CI contract job are what catch it first.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `dsh.embed.command` | *(empty)* | Override the executable used to start the runtime; empty uses `dsh` from `PATH`. |
| `dsh.embed.args` | `[]` | Override the complete argument list passed to the runtime. |
| `dsh.embed.workspaceFolder` | *(empty)* | Workspace folder path to pin; defaults to the first folder. |

## Commands

- **DSH Sidebar: Open Agent**
- **DSH Sidebar: Recover Connection** (Agent title bar icon; runs the connection ladder immediately)
- **DSH Sidebar: Restart Agent Runtime (Interrupts Running Tasks)** (Command Palette)
- **New Session** / **Refresh Sessions** (Sessions tree title bar)
- **Move Session Up** / **Move Session Down** / **Archive Session** (session row context menu; dragging one row
  onto another reorders directly)
- **Reference Selection in DSH** / **Reference Code Block in DSH** (editor context menu) and
  **Reference File in DSH** (Explorer context menu)

## Architecture

- `src/runtime.ts` — attaches this window to its workspace keeper, publishes the window's own loopback
  bridge proxy, detaches on stop or dispose, and rebinds the proxy to a fresh loopback authority on demand
  (`rotateOrigin`). `restart()` asks the keeper to replace the shared backend.
- `src/runtime-keeper.ts` — the detached per-workspace owner of one DSH backend: it launches the configured
  command, exchanges the one-time launch token for the browser-session cookie, counts attached Hosts, and
  reaps the CLI only after the last one detached and the idle grace expired.
- `src/runtime-client.ts` — the Extension Host side of the control protocol: attaches to the keeper named by
  the share record, or forks exactly one keeper under a bootstrap lock when that record is missing or stale.
- `src/runtime-workspace.ts` / `src/process-tree.ts` — workspace key, candidate control ports, the `0600`
  share record and bootstrap lock; private process groups plus observed Linux descendants for cleanup.
- `src/proxy.ts` — loopback reverse proxy (HTTP + WebSocket) that injects the auth cookie, rewrites the
  boot theme to the VS Code theme, serves the injected bridge script, and binds a fresh port when the page
  must be rebuilt (`relisten`).
- `src/bridge.js` — injected into the page: drains the DSH sidebar from the boot graph, pins the workspace,
  intercepts tool-path links, delivery cards and drag/drop references, drives the theme through the page's own
  ThemeRuntime, and relays the workspace order and archive set for the native tree.
- `src/connection-recovery.js` — injected into the page: reports DSH's own `connection.state` and answers
  the host's `reconnect-page` request; it owns no timers or thresholds.
- `src/recovery-shell.js` — the local webview shell: reports `shell-alive` every three seconds, relays
  messages, and renders the host's localised status banner.
- `src/session-panel.ts` — native `TreeDataProvider` reading `session/list` through the proxy, in the manual
  order the page publishes and without archived rows.
- `src/session-actions.ts` — the Workspace RPCs behind the tree's reorder and archive actions, plus the pure
  order-planning helpers the drag-and-drop controller uses.
- `src/extension.ts` — webview shell, message relay, file/diff providers, the command surface and the
  single connection-maintenance ladder.

### Runtime lifetime

The runtime belongs to a canonical workspace folder, not to a window or an Extension Host. The first window
or Remote-SSH connection of a folder starts a detached **workspace keeper**; every later window of the same
folder attaches to that keeper and reuses its one backend. Closing a window, losing the SSH transport or
replacing the Extension Host therefore does not stop the backend or a running agent — the keeper is
independent of all of them. Only after the last attached window has detached does the keeper wait out its
idle grace (two minutes) and then stop the CLI. Hiding the sidebar has no effect on the backend.

Windows of different folders get separate keepers, control ports and backends. Two live windows on one folder
are no longer a conflict: they share the backend, and a restart replaces that shared backend, interrupting
tasks in every window of the folder.

A keeper that is killed is replaced by the next window that attaches, and the replacement reaps the backend
its predecessor orphaned. Runtimes from 0.3.12–0.4.0 have no keeper and cannot be adopted: finish or cancel
their work and stop the old runtime before reloading. An occupied backend port is still a CLI failure
reported through the keeper, not permission to pick another port. Do not remove session lock files; DSH's
own session flock remains the final cross-process writer exclusion.

See [runtime lifecycle](docs/runtime-lifecycle.md) for shutdown guarantees, platform limits and tests.

## Troubleshooting

If startup fails, the Agent view shows a short, selectable diagnosis. It has no buttons: the extension
retries the start automatically, and the **DSH Sidebar** output channel carries the complete runtime
output, including the CLI's own failure message.

- **The startup page names a CLI failure** — the extension launches the configured command directly, so a
  CLI that cannot serve `dsh web` reports its own message. Use `dsh.embed.command` / `dsh.embed.args` for a
  custom launcher, or upgrade `dsh` with `npm install -g @deepseek-ai/dsh`.
- **"failed to start dsh"** — `dsh` is not on the extension host's `PATH`. Use `dsh.embed.command` for an
  explicit path, or install it globally on the machine that hosts the folder.
- **History stays at “Loading history…” after a connection drop** — the Agent view banner renders the
  Extension Host's status (reconnecting, rebuilding the page, starting the runtime, waiting for the remote
  connection) while the connection ladder repairs the page automatically; the banner has no buttons. Run
  **DSH Sidebar: Recover Connection** to rebuild the page immediately. Repairs never resend a message, and a
  running agent is restarted only after several rebuilds fail to connect; that restart replaces the shared
  backend, so it interrupts tasks in every window of the folder. Check history before resending an
  unconfirmed submission.
- **Diagnostics** — each window writes a JSONL trace to `~/.dsh/vscode-embed/telemetry.jsonl` and publishes
  `current.json` next to it (the most recently activated window); trace rows include Host PID, workspace and runtime identity, while page events carry their page identity. The port in that file answers `/status`, `/logs`, `/ping` and `/restart` on loopback.

The `/status` response also includes the latest shell heartbeat and the most recent traced event. Periodic
heartbeats stay in memory; only status changes enter the trace. See
[page recovery](docs/runtime-lifecycle.md#page-connection-recovery) for timings and verification.

## Privacy

The extension uploads nothing. It writes its own JSONL trace under `~/.dsh/vscode-embed/`, binds its proxy
and its diagnostic server to `127.0.0.1` only, and never sends a request of its own to any other host: the
only network peers it talks to are the DSH process it started and its own workspace keeper on loopback. The
keeper writes the owner-only (`0600`) share record under `~/.dsh/vscode-embed/workspaces/`; the
browser-session cookie lives in the keeper, is handed to an attached window only over that loopback control
socket after the window presents the record's token, and is injected upstream by the window proxy, so the
browser never receives it. Following a link in the conversation opens VS Code's Simple Browser, which then
loads that URL the way any browser would. Besides its own keeper process, the only external processes it
runs are the `dsh` CLI you installed and `git`, the latter to read a file's HEAD content when the
conversation asks for a diff against HEAD.

## License

[MIT](LICENSE) © 2026 Huanqi Cao. A community extension for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), which is maintained by DeepSeek AI.
