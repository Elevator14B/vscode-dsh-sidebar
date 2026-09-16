# Security

## Reporting a vulnerability

Use GitHub's private [security advisory](https://github.com/Elevator14B/vscode-dsh-sidebar/security/advisories/new)
form rather than a public issue. Please include the version, the VS Code version, what you observed and, if
you can, a minimal reproduction. Expect an initial reply within a week; this is a personal project without a
bounty program.

Only the latest released version is supported.

## What this extension does

Understanding the design makes reports much easier to triage:

- It spawns the DeepSeek Harness CLI you installed (`dsh web --port <n> --no-open`) as a child process of
  the extension host, with the open workspace folder as its working directory.
- It starts a loopback HTTP/WebSocket reverse proxy on `127.0.0.1` that injects the browser-session cookie
  the CLI printed at launch. The cookie is minted and held in the extension host; the sidebar webview never
  receives it.
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
