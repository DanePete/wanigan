# Companion usage context — September 10, 2026

Mission Room questions now read the same `usage.snapshot({ days: 14 })` service
as the Usage page. The bounded model context carries account labels and harnesses,
reported quota percentages and reset epochs, freshness, and recorded requests,
tokens and cost status. These are account-wide readings across all projects,
even when the conversation is scoped to one project. Missing costs remain null;
partial costs remain labelled subtotals. No account email, organisation identity,
credentials, raw provider diagnostics or transcript-factor prose enters this
projection.

Usage reads happen on an explicit send, with the existing provider cache policy.
Opening or polling Mission Room does not probe account limits. A failed read
becomes an explicit unavailable state alongside the project facts. Cancellation
during a read prevents a late result from sending a model request. A verified
`usage:overview` citation opens Usage without changing the selected project.

The `before/` and `after/` images show the real Electron renderer with synthetic
conversation and usage records in both themes. They do not represent a live model
answer or a real account reading. `scripts/probe-companion-usage.mjs` checks the
disclosure and source navigation; `after/verification.json` records the result.

The offline main-process regression first reproduced the missing usage payload
and rejected usage citation. It now verifies the data, privacy projection,
freshness, missing/partial cost, bounded context, read failure, concurrency and
cancellation. `npm test` passed all five stages with 1531 smoke assertions;
`git diff --check` passed. No paid model calls were made during verification.
