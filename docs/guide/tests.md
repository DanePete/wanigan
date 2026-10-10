# Tests

The test suites, what each runs against, and where the proof of each feature is kept. Back to the [README](../../README.md).

```sh
npm test            # typecheck, unit + integration tests, UI and phone sweeps
npm run test:release  # npm test, then the control crawl (before a release)
npm run smoke:app   # the real Electron app: core, window, a terminal, the CLI, outliving a quit
node scripts/app-smoke.mjs --app "release/mac-arm64/Wanigan 2.app"   # the same against a packaged build
npm run scenario    # the whole workflow in the real app on a throwaway shop site; no model is called
npm run scenario -- --spend   # the same with real Claude Code and Codex turns: spends from your plans
```

The unit tests run under Electron's own Node against a real core: real SQLite,
real PTYs, the real CLI through its shim, the real hook relay. The UI sweep
serves the built interface to Chromium against a real, seeded core and checks
seeded routes in both themes at 1440×900, plus selected narrow routes in dark.
Screenshots land in `.artifacts/ui/`. The control crawl checks reachable demo
controls for errors and observable responses. Targeted dialog tests check
initial focus, Tab containment and Escape restoration in both themes. Full
keyboard traversal, control semantics and minimum-window coverage still need
manual review; the independent review records its additional 960px checks.
Its first run downloads Playwright's headless Chromium (about 200 MB, into
Playwright's own cache); later runs reuse it.

Before you open a pull request, read [CONTRIBUTING.md](../../CONTRIBUTING.md).

Every feature and rule the README, these guides and the design claim, and the test that
proves it (or why it can only be checked by hand), is in
[docs/features.md](../features.md). The
[independent review](../reviews/2026-10-07/README.md) records findings, fixes,
verification results and the behavior that remains unverified.
