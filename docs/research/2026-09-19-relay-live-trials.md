# Relay live trials — 2026-09-19

These are real Codex CLI sessions launched through Relay's typed IPC in a separate
Electron profile. They edited Wanigan in Relay-owned Git worktrees. The installed
Wanigan application and its existing sessions were left running. This is a small
integration exercise, not a controlled comparison of model quality or savings.

## Work performed

| Task | Actual implementation route | Evidence |
| --- | --- | --- |
| Explain model choices in plain language | GPT-5.6-Luna, low effort | Real session changed `RelayComposer.tsx`; targeted checks passed after one wording refinement. |
| Offer a direct human decision at final review | GPT-5.6-Luna, medium effort | Real session changed `Relay.tsx`; targeted checks passed. Independent agent review remains optional. |
| Support this repository's full checkout in the review gate | GPT-5.6-Sol, high effort | Separate required-module conversion followed by the bounded capacity fix and regression checks. |

The first task used Auto with Lower cost. A real JEV call proposed Luna with 0.77
confidence, below the existing 0.80 threshold, so the recorded automatic route
kept the profile's Astra fallback. The operator explicitly selected Luna/low for
implementation. The threshold was not lowered. The other two tasks used Manual
with explicit model/effort choices and did not request JEV inference.

JEV reported 7,092 input and 1,582 output tokens on `jev-1.13.0`. Relay recorded
an estimated $0.000297864 for that suggestion call, using its configured rate.
That is an estimate, not an invoice. Native Codex reported tokens but no dollar
cost; those sessions remain unpriced.

Native cumulative counters at the agents' final handoffs:

| Task | Input tokens | Included cached input | Output tokens |
| --- | ---: | ---: | ---: |
| Plain-language choices | 1,025,467 | 928,256 | 6,501 |
| Direct human review | 502,882 | 465,408 | 3,799 |
| Full-checkout gate | 4,652,651 | 4,395,904 | 18,436 |

These are whole-session counters, including repeated context and tool turns.
They are not prompt lengths or billed dollar amounts. No savings claim can be
made from them. Human final decisions remain explicit; the operator did not
fabricate a human-approved outcome to populate the cost-per-accepted-result data.

## Problems exposed by real execution

1. **An update menu interrupted the second launch.** Codex displayed its welcome
   text and subsequently an update menu. The accumulated terminal buffer still
   contained the welcome marker used by Relay's startup submission logic. The
   menu selected its default update action, upgraded Codex 0.154.0 to 0.155.1,
   and exited before producing a conversation. An offline probe reproduced the
   stale-marker submission behavior. The launch has no usage meter; absence of
   metering is not proof of zero spend. Its attempt ID remains in Relay history.
   A durable startup-dialog fix remains separate work on the session module.
2. **Retry found that the empty failed worktree had been cleaned up.** Relay
   correctly refused the missing path. The operator restored the same unchanged
   branch and retried the same node; the failed and successful attempts were
   retained. Automatic cleanup and resumable-task retention still need to agree.
3. **The full test suite passed, but checkout verification was unavailable.**
   The first real gate ran `npm test` successfully in 131.962 seconds, but the
   checkout contained about 608 MiB of tracked files, exceeding the 512 MiB
   aggregate fingerprint limit. Most bytes were archived screenshots. Relay
   correctly refused to call that a current verification pass. A temporary
   sparse checkout was explored, then fully undone before the proper fix.
4. **Installing into a shared dependency link disturbed the source checkout's
   dependencies.** The locked root dependencies were restored with `npm ci` and
   native rebuild. Subsequent trial dependencies use private APFS clones. This
   was a trial setup recovery, not a product-level worktree-bootstrap fix.

The capacity fix preserves coverage of every tracked and nonignored untracked
file. It keeps the existing streamed reads and freshness checks, and raises the
aggregate budget to 1 GiB while retaining the other resource and path limits.
The required Review module conversion is a separate commit so the ownership move
can be reviewed independently from the behavior change.

## Verification

The Relay agent made `7509b3d` for the required Review module conversion and
`6fa4d4d` for capacity, compatibility and regression coverage. The regression
first failed against the original limit, then passed after the fix. It tracks
600 MiB of sparse fixture files, confirms a changed fingerprint after editing
a file beyond the old boundary, and refuses 1,035 MiB with the explicit 1 GiB
limit. Sparse fixture files still have all their bytes read; they are unrelated
to Git sparse checkout or excluding repository files.

The agent's final `npm test` passed all eight gates, including 2,507 smoke
assertions. The integrated workspace, preserving concurrent prompt-improvement
changes, also passed all eight gates: 549 shared tests, six dispatch test groups,
and 2,538 smoke assertions with zero failures. `git diff --check` passed. The
integrated log is `/private/tmp/wanigan-relay-live-integrated-test.log`.

After restarting only the isolated test app, all three original complete
worktrees passed the saved `npm test` recipe through the updated Relay gate.
Every run recorded matching non-null before/after fingerprints with no
unavailable reason. Relay then revalidated the evidence while completing each
verification stage. All three dockets now report `review`, with their final
review stage `ready`; no final human approval was recorded.

The passed proof IDs are `proof_108ccbbc-7a7` (choices),
`proof_c574c9b3-fb5` (direct review), and `proof_2ceef5ac-d8c`
(full-checkout gate). The earlier successful command run with an unavailable
fingerprint remains in history. See the sanitized
[real execution evidence](2026-09-19-relay-live-evidence.json) for attempts,
effective stage states, command exits, fingerprint comparisons and JEV usage.

## UI evidence

[Before/after captures and verification provenance](../shots/relay-live-2026-09-19/README.md)
cover both themes. Review-state screenshots use explicit synthetic fixtures;
composer screenshots use isolated Electron IPC with mock provider discovery.
They test display and interaction, not live provider execution or savings.
The live execution evidence comes from the separate real Relay database and
native session records described above.

## Trial identities

- Choices: docket `doc_5b1791de-5ad`, session `s_mu8le4sy_2454`.
- Direct review: docket `doc_0ed6398f-2d0`, failed startup
  `s_mu8ln46m_0ebc`, implementation `s_mu8lpous_7ab7`.
- Full-checkout gate: docket `doc_b91e767b-ab3`, implementation
  `s_mu8lx25v_1cf4`.
- Isolated evidence database:
  `/private/tmp/wanigan-relay-live-20260919/user-data/wanigan.db`.

The temporary database is local operational evidence, not a committed fixture or
a portable guarantee. No credentials, raw prompts, or native transcripts are
included in this report.
