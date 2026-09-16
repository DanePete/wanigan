# Session evidence repair captures

Before and after captures use the built renderer in a disposable Electron profile with a synthetic bridge. No real agent, account, PTY session, provider call or user database is involved. The before bundle was copied before these repairs to `/private/tmp/wanigan-session-evidence-before-20260915`.

The current production shell mounts the usage badge but hides it with `.mission-shell .nav-usage-status { display: none }`. The normal-session screenshots retain that rule. The context and Codex screenshots override only its visibility and are visibly labeled **SYNTHETIC COMPONENT FIXTURE · USAGE BADGE EXPOSED FOR QA**. They verify the dormant component's behavior, not a newly exposed product control. Product shell layout remains unchanged.

| Surface | Before dark / light | After dark / light |
| --- | --- | --- |
| Normal session surface | [Dark](before/sessions-normal-surface-dark.png) / [Light](before/sessions-normal-surface-light.png) | [Dark](after/sessions-normal-surface-dark.png) / [Light](after/sessions-normal-surface-light.png) |
| Unconfirmed context fallback, component fixture | [Dark](before/context-fallback-dark.png) / [Light](before/context-fallback-light.png) | [Dark](after/context-fallback-dark.png) / [Light](after/context-fallback-light.png) |
| Exact context with CLI-reported window, component fixture | [Dark](before/context-reported-dark.png) / [Light](before/context-reported-light.png) | [Dark](after/context-reported-dark.png) / [Light](after/context-reported-light.png) |
| Selected Codex account, component fixture | [Dark](before/codex-account-dark.png) / [Light](before/codex-account-light.png) | [Dark](after/codex-account-dark.png) / [Light](after/codex-account-light.png) |

Run `node scripts/probe-session-evidence.mjs --before` for the saved baseline and `node scripts/probe-session-evidence.mjs` for the current build, using Node 22.23.2. The after probe checks fallback identity disclosure without near-full styling, correct CLI-reported wording and pressure for an exact current reading, and the session id in Codex status requests. Results are in the before/after `verification.json` files.

The terminal ordering repair has separate behavioral coverage: `src/shared/terminal-replay.test.ts` tests the snapshot/stream/parser boundary; `node scripts/probe-terminal-replay.mjs` exercises the same production helper against the real xterm parser, including device-query suppression, new output arriving during parsing, ordinary input after parsing, and local exit text. The screenshot bridge does not verify main-process account resolution or transcript archival.

Main-process focused verification used `/private/tmp/wanigan-session-focused.cjs`: real migrated SQLite and production transcript archival with an isolated-checkout fixture; the current IPC handler extracted with the TypeScript AST and controlled account reads; and the current exit-handler fragment with signal, failure and ordinary-success cases. No provider was called. The durable product smoke includes the worktree archive regression and wiring guards, while the full product suite is coordinated by the parent task.
