# Audit of 11 September 2026

Inputs behind the report "Wanigan · Settings & Learning"
(https://claude.ai/code/artifact/70c09cd5-d6dd-4f43-bf04-f1fd0d6f4f08).

The two views the 7 September pass never reached, plus what a completeness
critic pulled in behind them.

`.claude/audit-2026-09-07/README.md` records what that pass could not cover:
"learning, schedules, settings, skills, the shell, and every main-process
subsystem", lost to a token limit. `Settings.tsx` (5,686 lines) and
`Learning.tsx` (2,962) are the two largest renderer files in the repository and
were both on that list. This audit is those two.

## Method

Eight finders, one per lens, over the two views and their main-process backing:
settings-logic, learning-logic, learning-invariants (checked against the
compound-learning rules in `AGENTS.md`), honest-state, error-paths,
trust-boundary, dead-state, a11y-style. 51 raw findings.

Every finding was then put to **three independent verifiers, each instructed to
refute it and to default to refuted when uncertain**:

- `reproduce` — open the file, trace the path, does the outcome follow?
- `deliberate` — is this an intentional, commented design, or pinned by a
  `smoke*.ts` assertion? This repo documents its decisions at length, and
  reporting one as a defect is the dominant false-positive mode here.
- `correctness` — is the underlying technical claim right on its own terms?

A finding survives on 2 of 3. **CONFIRMED** is 3/3; **PLAUSIBLE** is 2/3, and
those carry the dissenting verifier's reasoning in the per-file reports.

A completeness critic then named four angles no lens had covered —
`settings-key-handlers`, `pack-consent`, `estimate-vs-causal`,
`cross-view-settings-seam` — and those ran as a second round. They are why this
audit reaches `index.ts`, `egress.ts`, `store.ts`, `checkpoints.ts`,
`learning-service.ts` and `bits.tsx` at all.

242 agents, 0 errors, 101 minutes.

## Result

51 round-one findings + 15 gap-round survivors. **56 survived: 47 CONFIRMED,
9 PLAUSIBLE. 18 were refuted and are not here.** 13 high, 33 medium, 10 low.

| File | Findings |
|---|---|
| `Learning.tsx` | 24 |
| `Settings.tsx` | 23 |
| `index.ts` | 3 |
| `egress.ts` | 2 |
| `learning-service.ts`, `checkpoints.ts`, `bits.tsx`, `store.ts` | 1 each |

Learning.tsx yielded more than Settings.tsx despite being half the size.

## Files

- `synthesis.md` — the fix order, with the reasoning for the ranking. Its author
  re-opened 14 claims against the source and **corrected two of them downward**;
  those corrections are in the text and are the reason to read it before the
  per-file reports.
- `<file>.md` — one per audited file, most severe first, each with claim,
  quoted evidence, a concrete failure scenario, and the smallest correct fix.
- `findings-all.json` — the same, machine-readable.

## What is verified and what is not

Every finding here survived 2-of-3 adversarial verification. That is not the
same as being independently confirmed by a person.

Spot-checked by hand against the source during the run, and holding:
`Settings.tsx:1040` (one `msgState` renders in two panels), `Settings.tsx:4902`
(the retention field re-seeds on empty), `Settings.tsx:5121` + `setPref`
(699-710 catches and resolves, so a rejected save renders green),
`worktrees.ts:466` → `Settings.tsx:4797` (the force-delete path), and
`index.ts:929` → `hooks.ts:324` (the hook bus mark).

One severity was found overstated on inspection: `Settings.tsx:5121` is medium,
not high — `prefsErr` does render, as a critical Callout at `Settings.tsx:754`,
so the operator sees a contradiction rather than silence. Read the others with
the same suspicion.
