# If something goes wrong

Fixes for the common problems, where the logs are, and how to report the rest. Back to the [README](../../README.md). On the website: [troubleshooting](https://wanigan.ai/docs/reference/troubleshooting).

- **`npm install` fails compiling node-pty or better-sqlite3:** install the
  Xcode Command Line Tools, then run `npm run rebuild`.
- **The window never opens, or Electron behaves like Node:** your shell sets
  `ELECTRON_RUN_AS_NODE` (VS Code's terminal can). Run
  `env -u ELECTRON_RUN_AS_NODE npm run dev`.
- **Logs:** `core.log` and `core.out.log` in the data folder. They contain
  project paths, so read one before you attach it to an issue.
- **Anything else:** [open an issue](https://github.com/DanePete/wanigan/issues/new/choose).
  It helps to know your macOS version, `claude --version` and `codex --version`.
