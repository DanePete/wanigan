# Audit of 7 September 2026

Inputs behind the report "Wanigan 1.0 Deep Dive"
(https://claude.ai/code/artifact/cbc745e6-f266-4391-a60c-9d90e756af0c).

- `findings/<view>.md` — one file per audited view, most severe first, each item
  with file:line, evidence, failure, fix and size. Views audited: sessions, fleet,
  control, batches, insights, plugins (twice, independently: `plugins.md` and
  `plugins-2.md`), scout, context, runs, git, usage. Not audited (lost to the
  token limit): learning, schedules, settings, skills, the shell, and every
  main-process subsystem.
- `findings/findings-all.json` — the same, machine-readable.
- `findings/spot-checks.json` — the 25 claims re-read on the working tree at
  591d758 by the main session, with verdicts. Everything else is an auditing
  agent's finding, cited but not independently verified.
- `research/*.md` — Devin, competitor UIs, design language (with a proposed
  token set in section 4), benchmarks, leaderboards, routing, and a map of
  Wanigan's own eval machinery. Every claim is labelled primary or second-hand.
- `research/prior-ui-review-2026-09-05.txt` — text of the 5 September review.

Screenshots referenced by the audits were rendered with `npm run shots:browser`
(a stubbed bridge); a visual claim is only a defect once checked against the
main-process code that feeds the field.
