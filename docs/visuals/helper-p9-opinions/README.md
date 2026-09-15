# Helper sweep · P9 · second opinions

Before and after, both themes, from `scripts/probe-helper-p9-opinions.mjs`: the
actual renderer in an isolated Electron window at a 1600 × 1400 viewport, with
synthetic sessions, review and second-opinion services and no real agent
calls. The main-process half — the consent digest and fingerprint, main's own
native confirmation, the read-only call through `headless.ts` with a stand-in
CLI, metering from recorded runs, the same-backend rule and the location checks
— runs against a real repository in `src/main/smoke38.ts`.

`before/` was shot from a build of `e133cf1` (the base of this branch) in a
scratch worktree; `after/` from this branch. Each folder's `verification.json`
lists the assertions that ran, the commit the renderer was built from, and each
screenshot with the body background it was taken on. A `-detail` file is the
code rail (or, in Insights, the card) at full resolution, because the rail is a
few hundred pixels wide in a whole window.

| View | Before | After |
| --- | --- | --- |
| Code rail | `code-rail` — the review verdict and Send review | `code-rail` — under the verdict, "Second opinions · billed, per run" with Get a second review…, Find unrequested decisions… and Results · 0 |
| Consent, second review | — | `consent-review` — reviewer profile (Claude Code · Anthropic), exactly what is sent (4.2 KB of diff, whole, cap 96 KB; the file list with the pre-launch edit left out; the goal's acceptance check; no review rules, because no collector exists), "Nothing else.", the vendor, the dollar cap with `--max-budget-usd`, the scratch folder, "This is billed." and the command it runs |
| Consent, the other vendor | — | `consent-review-codex` — Codex · OpenAI: no spending cap Wanigan can set, a 10-minute timeout, and that its read-only sandbox blocks writes but not reads |
| Findings | — | `findings` — the results panel in the file list's place, the diff below: verdict, three findings with severity, confidence, location and "file not in this diff", each marked Confirmed / Refuted / Not sure; the confirmed one added to the review notes tray |
| Decisions | — | `decisions` — decisions nobody asked for from the session's own backend, with risk, checked locations, "1 cited location not in the diff removed", "2 entries cited code that isn't in the diff and were dropped", one added to the review notes |
| Unreadable reply | — | `unreadable` — "Could not read findings: The reply holds no JSON object." and the reply as it came |
| Consent, decisions | — | `consent-decisions` — same backend only, the operator's 3 messages and 4 plan items counted |
| Insights · Spending | `insights-spending` — no record of second opinions | `insights-spending` — a Second opinions card: kind, session, reviewer, cost or "unpriced", confirmed/refuted/not sure, kept/dropped, and a total of recorded dollars that leaves unpriced runs out |

Run it again with `npm run build && node scripts/probe-helper-p9-opinions.mjs`
(add `--before --out <dir>` from a checkout of the base).
