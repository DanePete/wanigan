# Mobile gate freshness repair

The offline fixture uses the served mobile shell with synthetic repository state: file contents changed while paths/status stayed the same. Before uses the prior Git section; after uses the repaired section and persisted-evidence freshness state. No live app, account or provider data was used. `capture.json` records provenance and renderer errors.

| Theme | Before | After |
| --- | --- | --- |
| Dark | [Before](before-dark.png) | [After](after-dark.png) |
| Light | [Before](before-light.png) | [After](after-light.png) |

These captures verify the displayed stale state. `src/main/smoke-audit-integrations.ts` separately checks real temporary Git content/index/HEAD changes, unavailable evidence and persisted project-gate scope. No actual phone commit was performed.
