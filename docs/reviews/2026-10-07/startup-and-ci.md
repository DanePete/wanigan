# Startup and Git 2.55 CI findings

All three findings below were fixed in `bd3e03c`. Tests used temporary folders and stand-ins; no application-data directory or real model was used. The complete release and final-suite results are in [the consolidated report](README.md).

## P2 — Git 2.55 corrupted stash preview paths

- Location: `src/core/git-client.ts:29`; associated CI gate `.github/workflows/ci.yml:21`.
- Reproduction: [alpha.1 GitHub run 37670196649](https://github.com/DanePete/wanigan-2/actions/runs/37670196649) installed successfully and ran 480 tests, with one stash assertion failing. Git 2.55 returned malformed paths instead of `README.md` and `draft.md`. The local regression also reproduced `ADME.md README.md` and `aft.md draft.md` before the Wanigan fix; its saved log did not record the resolved core Git binary.
- Cause: Git's `stash show` freed strings referenced by `--src-prefix` and `--dst-prefix` before printing the diff. The [upstream fix](https://github.com/git/git/commit/66f4856110a7577c12f97ae905c95a6f38adba9d) confirms this use-after-free. Actions checkout/setup-node/upload-artifact v7 all resolved; action versions were not the cause.
- Fix: use `--default-prefix`, preserving the parser's `a/` and `b/` contract even when repository diff-prefix preferences differ. CI now checks `main` and `codex-review` pushes and runs `env -u ELECTRON_RUN_AS_NODE npm test`, including the previously omitted crawler.
- Regressions: `src/core/stash-prefix.test.ts:14`, “a stash preview preserves file paths and changes under every diff-prefix preference”; `src/main/ci-workflow.test.ts:6`, “CI checks the review branch and runs the complete npm test gate”. Both were red before their corresponding corrections and green afterward.
- Broader local result: 30/30 targeted tests passed. The earlier “Git 2.55 compatibility” label was too strong: prepending the built Git to PATH proves fixture selection, but the core replaces PATH with its login-shell path, and the resolved core binary was not saved. This is not recorded as a full core Git 2.55 pass. The final main GitHub run passes on a macOS runner whose checkout reports `/opt/homebrew/bin/git` version 2.55.0. The first temporary-build run had two hook fixtures fail because that uninstalled Git had no templates; supplying the standard Command Line Tools templates made all pass, with no product change for that fixture issue.
- Expanded logs: `/private/tmp/wanigan2-stash-prefix-red.log`, `/private/tmp/wanigan2-stash-prefix-green.log`, `/private/tmp/wanigan2-ci-workflow-red.log`, `/private/tmp/wanigan2-git255-complete-green.log`. Later whole-suite GitHub results are recorded separately; this targeted pass is not a substitute for them.

## P2 — Real-app smoke inherited the caller's home and environment

- Location: `scripts/app-smoke.mjs:22`, `src/main/smoke-environment.ts:6`.
- Reproduction: the old smoke script changed the app data directory while retaining caller HOME, account variables, shell startup settings and credential-bearing variables. A synthetic polluted environment demonstrated the leak before running the smoke against an app.
- Fix: create a temporary home and use a minimal child environment, neutral Git configuration and the test account-home seam. Inherited model keys and account locations are absent.
- Regression: `src/main/smoke-environment.test.ts:9`, “the app smoke uses a fake home and never inherits accounts, keys or shell startup settings”, including an actual Electron child reporting its home. The regression failed before the fix and passed afterward. Source and packaged app smoke results appear in the main report.

## P2 — README development launch could not serve bundled fonts

- Location: `electron.vite.config.ts:27`.
- Reproduction: following README `npm run dev` opened the app, but Vite's inferred filesystem root was `src/`; IBM Plex files imported from `node_modules/@fontsource` returned HTTP 403.
- Fix: explicitly allow the source and font directories in the renderer development server.
- Regression: `src/main/dev-assets.test.ts:7`, “the README dev server serves the bundled fonts without exposing files outside the repository”. It starts a real Vite server, requests the font, checks HTTP 200 and WOFF2 bytes, and retains the HTTP 403 boundary for `/etc/hosts`. The font request was 403 before the fix and 200 afterward.
