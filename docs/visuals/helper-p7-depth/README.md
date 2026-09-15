# Helper sweep · P7 — review depth and goal budgets

Screenshots of every view this package changed, in both palettes, taken by
`scripts/probe-helper-p7-depth.mjs` against the built renderer in plain Chromium
with the preload bridge stubbed (`scripts/renderer-harness.mjs`). Sessions, git,
goals and the review services are answered by synthetic fixtures, so these prove
layout, wording and both themes. They do not prove IPC, SQLite, git or the CLIs;
`smoke36.ts` covers those.

- `before/`: the base commit (`feat/helper-sweep` at cb66db1), photographed at
  the same navigation state with `--before`. The probe asserts each new element
  is absent there. It has no `code-rail-maintainability` shot, because that
  section did not exist to scroll to.
- `after/`: this branch, including the layout fixes made after the first shots
  (one-column maintainability grid, "by time" leading a weak run-by mark, the
  Timeline divider saying which way "after" is). `verification.json` records
  every check: 163 after and 37 before, with 0 failed.

| View | Shot | What changed |
|---|---|---|
| Sessions › Timeline | `timeline-asks` | Asks in this turn: items split from the operator's message, evidence hints, ticks, "Draft a follow-up for N unticked" |
| Sessions › Timeline | `timeline-files` | Files this session edited, read and referenced |
| Sessions › Timeline | `timeline-rows` | Rows the gate or the classifier denied, labelled Rejected with the rule or reason |
| Settings › transcript reader | `transcript-divider` | Compaction boundary with token counts |
| Code rail | `code-rail-review-sections` | Code review rules scoped to the changed paths, cited by file and heading |
| Code rail | `code-rail-maintainability` | Heuristic drift numbers: code lines, longest function, new duplicate blocks |
| Code rail | `code-rail-scratch` | Scratch files listed apart and left out of counts, with "Count this file" |
| Git › History, Branches | `git-history-runby`, `git-branches-runby` | Commits and branch moves marked "run by <session>", or "≈ by time" for a weak join |
| New session › Launch | `launch-instructions` | Instruction files in the pinned-config digest, labelled "instructions (not executable)" |
| Context › Instructions | `context-instructions` | Same digest, from the Context view |
| Review › goal | `control-loop-budgets`, `control-held-task` | Rounds and changed-lines limits; a task held with `needs-human: attempts` and no Start |
| Board | `board-held` | The held ticket and its reason |
| Settings › Projects & safety | `settings-rewrite-ask` | "Always ask before history-rewriting git commands, even at Trusted" |

Reproduce: `npm run build && node scripts/probe-helper-p7-depth.mjs`. For
`before/`, run the same probe from a checkout of the base commit with
`--before --out <this folder>/before`.
