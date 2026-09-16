# Changelog

All notable changes to this project. The version numbers continue the sequence this extension used before
its first public release; `0.3.11` is the first version published on GitHub.

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
