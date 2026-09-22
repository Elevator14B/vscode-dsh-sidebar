# Security

## Reporting a vulnerability

Use GitHub's private [security advisory](https://github.com/Elevator14B/vscode-dsh-sidebar/security/advisories/new)
form rather than a public issue. Please include the version, the VS Code version, what you observed and, if
you can, a minimal reproduction. Expect an initial reply within a week; this is a personal project without a
bounty program.

Only the latest released version is supported.

## What this extension does

Understanding the design makes reports much easier to triage:

- It starts one detached Node **workspace keeper** per canonical folder. The keeper spawns the DeepSeek
  Harness CLI you installed (`dsh web --port <n> --no-open`) with that folder as its working directory and
  serves every Extension Host that attaches to it, so closing, replacing or losing one window or SSH
  connection never stops another window's agent. It holds no IPC channel to any window and reaps the CLI
  only after the last attached Host has detached and an idle grace has expired.
- The keeper publishes a rendezvous record at `~/.dsh/vscode-embed/workspaces/<workspace-hash>.json`
  (owner-only, mode 0600) with its loopback control port, a random token and its PID. A Host attaches only
  by presenting that token over the loopback socket. A Host that finds a stale record forks a replacement
  under an exclusive bootstrap lock, and a replacement keeper reaps the previous backend only when the
  recorded PID still matches the kernel start time recorded with it. Different canonical folders get
  different keys, control ports and backends.
- It starts a loopback HTTP/WebSocket reverse proxy on `127.0.0.1` that injects the browser-session cookie
  the CLI printed at launch. The keeper mints and holds that cookie and hands it to each attached Host over
  the loopback control socket after the token check; the sidebar webview never receives it. Any process
  running as your own OS user can read the 0600 record and attach to your workspace backend — the same
  trust boundary the extension host itself has.
- It injects `dist/bridge.js` into the page served through that proxy, which is what makes references, the
  native sessions tree, file links and the theme bridge work.
- It runs `git` to read a file's HEAD content when the conversation asks for a diff against HEAD.
- It writes a JSONL trace and a `current.json` to `~/.dsh/vscode-embed/`, and exposes `/status`,
  `/logs`, `/ping` and `/restart` on a loopback port published in `current.json`.
- It uploads nothing: no telemetry, no crash reporting, no update check.

## Known limitations

- The loopback diagnostic server is bound to `127.0.0.1` but is not authenticated. Any local process can
  reach it and trigger a runtime restart or a window reload. It never exposes conversation content, but do
  not run untrusted local software with access to the loopback interface. Hardening it (a per-session token)
  is tracked as a follow-up.
- The webview loads the DSH web app from the local proxy. Everything in that page is trusted with the
  privileges of the extension host: the bridge relays clipboard writes, opens files and opens URLs on request.
  Only run DSH plugins you trust.
- The extension is only as safe as the `dsh` CLI it starts, and that CLI runs the agent with your user's
  permissions. Read the DeepSeek Harness
  [safety notice](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md) before giving an
  agent write access to a repository.
- The keeper is not a kernel process container. Simultaneously killing both a Host and the keeper, or a
  custom launcher daemonizing before its descendant is observed, can escape portable process cleanup. A
  keeper killed outright leaves its backend running until the next keeper reaps it, which is why the record
  carries the backend PID and its kernel start time. Linux process death and flock release are tested;
  macOS and Windows need editor lifecycle validation.
