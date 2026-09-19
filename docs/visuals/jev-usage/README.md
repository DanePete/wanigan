# Jev in Usage

Captured September 19, 2026 with `scripts/probe-jev-usage.mjs` against the built
renderer at 1440 × 1000, in dark and light themes.

These are **synthetic renderer fixtures**, not a user's usage records or
evidence of a live TypeSafe request. The probe uses the local renderer harness
and makes no provider calls. Main-process aggregation and persistence need the
separate offline smoke checks.

- `before/usage-{dark,light}.png`: frozen renderer from before the Usage changes,
  with the prior snapshot shape: configured account limits, no service records.
- `after/usage-{dark,light}.png`: TypeSafe selected, with `jev-latest`, two
  requests, 1,200 reported input tokens, and an explicitly estimated cost.
- `after/usage-mixed-{dark,light}.png`: three requests, one without complete
  counters; reported tokens are a lower bound and the coverage note is visible.
- `after/usage-unmetered-{dark,light}.png`: one request with no counters remains
  visible, while tokens and cost are dashes and no activity chart is invented.

The before and after fixtures intentionally differ in service-record inclusion
to illustrate the snapshot change. Feeding the after fixture to the frozen old
renderer also fails the estimate assertion: its cost cell contains a dash.

The probe verifies account navigation, recorded request and token counts,
estimated cost labeling, daily table accessibility, and partial or missing
counter presentation. It also checks that a one-token estimate remains nonzero,
reported zero counters stay zero, a session account also named TypeSafe keeps
its own rows and limits, and selecting TypeSafe does not fetch usage again. Each capture directory has
a `verification.json` recording the checks and renderer errors.

Reproduce after a build with Node 22.23.2:

```sh
nvm use
npm run build
node scripts/probe-jev-usage.mjs
```

For a preserved old build, set `WANIGAN_RENDERER_ROOT` to its renderer directory
and pass `--before`. `--out` overrides the screenshot destination.
