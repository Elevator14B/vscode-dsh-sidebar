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

The extension starts a DSH web runtime (`dsh web`) with the first VS Code workspace folder as its working
directory, proxies the authenticated page into a sidebar webview, and bridges the two sides: the page's own
sidebar is replaced by the VS Code folder, and file/diff navigation, reference chips, the sessions tree and
the theme all live in VS Code natively.

## Features

- **Workspace = VS Code folder.** No workspace picker: the DSH workspace is pinned to the folder you have
  open, and session switching happens in a native VS Code tree.
- **Native Sessions tree.** Lists the sessions of the pinned workspace in the same order and with the same
  titles as the web sidebar, with New Session and refresh actions. Drag a row onto another to move it, or use
  *Move Session Up* / *Move Session Down* / *Archive Session* from its context menu; both go through the web
  sidebar's own Workspace RPCs, so order and archive state stay shared between the two surfaces.
- **Native file and diff navigation.** `read` / `write` tool paths in the conversation open the file in
  VS Code; `edit` tool paths open a **tool-change diff** (`old_string` → `new_string`, independent of git).
  The closing turn's produced-file chips and delivery cards open in the editor too, and the card's chevron
  offers *Open in Editor*, *Open to the Side* and *Reveal in Explorer* — the host's desktop application is
  never the target, which is what makes the cards usable over Remote-SSH.
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
  and held in the extension host and never reaches the client browser.

## Requirements

- VS Code 1.96+
- Node.js 22+ on the `PATH` of the machine that hosts the folder (Remote-SSH and containers are
  supported): `dsh` is a Node CLI and runs under whichever `node` it finds there, not VS Code's bundled Node.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) on the extension host's `PATH`:

  ```sh
  npm install -g @deepseek-ai/dsh
  ```

The extension launches the configured command directly — there is no pre-flight version check. A CLI that
cannot serve `dsh web` fails with its own message on the Agent view's startup page and in the
**DSH Sidebar** output channel. See [Compatibility](#compatibility).

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

- `src/runtime.ts` — owns one cancellable backend generation and window proxy, exchanges the one-time
  launch token for the browser-session cookie inside the Extension Host, and rebinds the proxy to a fresh
  loopback authority on demand (`rotateOrigin`).
- `src/runtime-guardian.ts` — launches and supervises the configured command in a separate process, with
  no `dsh --version` probe, watches the owning Host's IPC connection, and reaps DSH when that Host exits,
  including abrupt termination.
- `src/runtime-ownership.ts` / `src/process-tree.ts` — reserve the workspace until cleanup completes and
  terminate private process groups plus observed Linux descendants.
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

SSH disconnection keeps DSH running while its **Extension Host** survives. Reconnecting to that Host reuses
the backend. Replacing or exiting the Host stops its DSH; a new Host starts a new backend and can resume
persisted conversations, but does not inherit in-flight execution. The longer-lived VS Code Server is
not the owner. Hiding the sidebar has no effect on the backend.

Only one Sidebar runtime per OS user may own a canonical workspace in the same network namespace at a time.
A replacement waits for old-process cleanup; another live window on that workspace receives an ownership
error instead of starting a competing writer. Use the owning window, or close it before retrying.

On first upgrade from 0.3.12, finish or cancel work and stop the old runtime before reloading. Existing
unguarded processes cannot be adopted automatically. An occupied backend port is reported instead of
silently choosing a random port. Do not remove `session.lock` files to resolve ownership.

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
  running agent is restarted only after several rebuilds fail to connect, so check history before resending
  an unconfirmed submission.
- **Diagnostics** — each window writes a JSONL trace to `~/.dsh/vscode-embed/telemetry.jsonl` and publishes
  `current.json` next to it (the most recently activated window); trace rows include Host PID, workspace and runtime identity, while page events carry their page identity. The port in that file answers `/status`, `/logs`, `/ping` and `/restart` on loopback.

The `/status` response also includes the latest shell heartbeat and the most recent traced event. Periodic
heartbeats stay in memory; only status changes enter the trace. See
[page recovery](docs/runtime-lifecycle.md#page-connection-recovery) for timings and verification.

## Privacy

The extension uploads nothing. It writes its own JSONL trace under `~/.dsh/vscode-embed/`, binds its proxy
and its diagnostic server to `127.0.0.1` only, and never sends a request of its own to any other host: the
only network peer it talks to is the DSH process it started. Following a link in the conversation opens
VS Code's Simple Browser, which then loads that URL the way any browser would. The only external processes
it runs are the `dsh` CLI you installed and `git`, the latter to read a file's HEAD content when the
conversation asks for a diff against HEAD.

## License

[MIT](LICENSE) © 2026 Huanqi Cao. A community extension for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), which is maintained by DeepSeek AI.
