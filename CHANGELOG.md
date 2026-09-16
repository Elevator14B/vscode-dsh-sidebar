# Changelog

All notable changes to this project. The version numbers continue the sequence this extension used before
its first public release; `0.3.11` is the first version published on GitHub.

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
