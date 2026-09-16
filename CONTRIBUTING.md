# Contributing

Issues and pull requests are welcome. This is a personal project, so please open an issue before a large
change so we can agree on the shape first.

## Development

```sh
git clone https://github.com/Elevator14B/vscode-dsh-sidebar.git
cd dsh-sidebar
npm ci
npm install -g @deepseek-ai/dsh   # the runtime the extension drives
npm run typecheck
npm test
npm run smoke                     # spawns a real dsh and probes the contracts
```

Open the folder in VS Code and press <kbd>F5</kbd> for an Extension Development Host.

## What a change needs

- `npm run typecheck` and `npm test` green. New behaviour needs a test; the suites in `tests/` bundle the
  sources through esbuild with a fake `vscode` module, so host-side logic can be exercised without an
  extension host.
- Keep the runtime dependency surface at zero: the extension bundles with esbuild and ships
  `--no-dependencies`. Prefer the Node standard library over a new package.
- If you touch the DSH protocol (launch URL, RPC envelope, boot graph, bridge injection), update
  `scripts/smoke.js` so CI keeps proving it.
- Match the surrounding style: two-space indent, no semicolons, single quotes, JSDoc on exported functions.

## CI

`ci.yml` typechecks, runs the unit tests, packages the VSIX and runs the contract smoke test against a
real `dsh`. `release.yml` repeats those checks on a tag and attaches the VSIX to the GitHub release.

Packaging hygiene is a local gate rather than a CI step — run it before you upload an artifact:

```sh
npm run package
npm run check:package   # allow-list, no dotfile, no absolute path, no credential shape
```

## Releases

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit, then `git tag v<version> && git push origin v<version>`.
3. The `release` workflow typechecks, tests, packages the VSIX and attaches it to the GitHub release.
4. Update the compatibility table in `README.md` if the tested `dsh` version moved (and keep
   `TESTED_DSH_VERSION` in `src/dsh-version.ts` in step with the CI contract job).
