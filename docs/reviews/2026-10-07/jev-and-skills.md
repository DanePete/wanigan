# Wanigan 2 — claims/matrix/Jev/skills reviewer handoff

Reviewed the original 192 rows in docs/features.md. The complete matrix is [feature-proof.md](feature-proof.md); it preserves original row numbers including the legacy row intentionally removed on the owner's instruction. All named test files exist; tests generally assert real DB/file/PTY/git results, with 33 partial proofs and 16 manual/unverified original rows called out rather than blanket-approved. Three claims directly contradicted source (Jev payload, call accounting, every skill); others have important scope qualifiers.

## Fixed findings

All seven code fixes below shipped in [`bd3e03c`](https://github.com/DanePete/wanigan-2/commit/bd3e03c9ccbb39a7b84f9c10c889fee2febc6575).

1. **P1 — Jev transmitted queued cards after the owner selected Off.** `src/core/jev.ts:102`, `:224`, `:242`. Repro: local HTTP server holds two card reads; enqueue a third; switch project Off; answer the first two. Before fix third request arrived (3 !=2). Fix rechecks consent at dequeue and before every HTTP retry. Requests already sent cannot be recalled. Project-scoped cancellation leaves other projects' queues intact. Tests: `core/jev-races.test.ts` "turning Jev off while two reads are in flight prevents queued cards being sent", "turning Jev off prevents a busy response from being retried", "turning Jev off in one project leaves another project’s queued reads intact".

2. **P1 — SKILL.md metadata listing read outside the skill folder before the full reader refused it.** `src/core/skills.ts:223`. Repro: fake-home skill's SKILL.md symlink points to a sibling fixture containing `not yours to read`; listing exposed that text as description although opening the skill refused. Before fix new test failed against returned JSON. Fix resolves/checks containment before opening metadata; an unreadable placeholder remains listed/removable. Test: `core/skills.test.ts:155` "listing a skill whose SKILL.md links outside its folder reveals none of the target text". This is an unintended filesystem read, not a claim of an OS sandbox bypass.

3. **P2 — Jev auto-accepted a card whose criteria disappeared in flight.** `src/core/jev.ts:247`. Repro: request confident Accept with one criterion; remove it before local HTTP response. Before fix status Ready despite zero criteria; now stays Inbox/advice. Checks current text/type/body/priority/criteria against assessed card before acceptance. Test: `core/jev-races.test.ts` "Jev never accepts a card whose criteria were removed while its answer was in flight" (red ready!=inbox).

4. **P2 — Jev call counts omitted retries.** `src/core/jev.ts:120`, `:128`. Repro: stand-in returns429,529,200; before fix counted1 rather than3 and omitted failed attempts. Each attempt now records success/failure; test asserts ordered stored outcomes, exact calls/errors and reported-success-token cost. Test: "every HTTP attempt is recorded, including busy replies before a successful retry" (red1!=3).

5. **P2 — Jev all-time counters/spend fell when detailed records were pruned.** `src/core/jev.ts:267`, `:272`, `:162`. Repro: seed5000 reported calls, perform another. Before fix counter remained5000 and earlier cost vanished. Transaction now preserves bounded cumulative metadata before deleting detailed rows. Regression asserts5001 total/today and210.042 configured-price estimate, then day rollover totals5002/today1. No migration edits or schema replacement. Test: "Jev totals survive pruning old calls, and still include calls pruned earlier today" (red5000!=5001). Already-pruned records from old builds cannot be reconstructed.

6. **P2 — Latest Jev failure could show online.** `src/core/jev.ts:145`, `:154`. Repro: same injected millisecond for success then401; old comparison used timestamp>= and reported online. Uses monotonic DB ids now. Test: "a failed Jev call is offline even when its successful predecessor has the same timestamp" (redtrue!=false).

7. **P2 — Pending Jev key lookup was invisible to idle-core replacement.** `src/core/jev.ts:170`, `:199`. Repro: invoke read() and inspect busy synchronously while async key lookup is pending; previouslyfalse. Reserve the card before first await, expose queued reservations as busy, and release no-key/error reservations. Also prevents duplicate enqueue while looking up key. Test: "a Jev read is busy while its key is being checked, and clears when no key exists" (redfalse!=true). Integrates with trust reviewer's stopIfIdle work.

## Documentation changes

`docs/features.md` has 204 rows: original 192 minus one legacy discovery row plus 13 git-workbench rows. Clarifies:

- payload includes project name and candidate metadata;
- Jev latency is not guaranteed, and historical real-service timing was not remeasured here; cost is a configured-price estimate from successful-response input-token reports, not confirmed billing;
- skills excludes built-ins and Codex plugins, with bounded reads;
- automatic account/history discovery is bounded;
- keep-awake is app-main lifetime/setting scoped, not detached-core lifetime;
- the original UI sweep/crawl did not prove every label's semantics, board mouse-drag, comprehensive Tab/focus-visible traversal, or both-theme 960px coverage; subsequent targeted checks and fixes are recorded in [the consolidated report](README.md);
- current migration tests rebuild old schema from current migration strings and do not freeze shipped bytes;
- secret scan coverage limits and known external/manual proof limits.

README/design corrections and legacy removal are included in the coordinated review. No agent changes to owner video files were discarded.

## Verification performed

Node22.23.2 via nvm; Electron commands always `env -u ELECTRON_RUN_AS_NODE`.

- New tests were observed failing before source fixes: first four failures above in one14-test run (10pass/4fail), then retention/status in6-test run (4pass/2fail). Tool output records exact assertions; these initial two runs were not redirected to disk.
- `/private/tmp/wanigan2-jev-cancellation-red.log`: deterministic cancellation follow-up failure before fixing project-scoped cancellation.
- `/private/tmp/wanigan2-jev-busy-red.log`: deterministic pending-key busy failure before fix.
- `/private/tmp/wanigan2-jev-skills-green.log`: final29/29 passing in `jev-races.test.ts`, `jev.test.ts`, `jev-offline.test.ts`, `skills.test.ts`.
- `/private/tmp/wanigan2-claims-typecheck.log`: typecheck exit0.
- `git diff --check`: exit0.
- Full npm test, app smoke, fresh install/package, release artifact hashes/signatures/mount/demo and gitleaks are owned/reported by root, not inferred from these targeted checks.

No real Wanigan data, keys, accounts or model turns were accessed. HTTP traffic was127.0.0.1 stand-ins. No commits/push/PR performed by this sub-agent.

## Changed files

- `src/core/jev.ts`
- `src/core/jev-races.test.ts` (new)
- `src/core/jev.test.ts` (honest renamed payload test + explicit fields assertion)
- `src/core/skills.ts`
- `src/core/skills.test.ts`
- `docs/features.md`

## Remaining limitations

- Cost is not service billing reconciliation; failed attempts with no reported usage cannot prove zero billable usage. Previously discarded usage cannot be recovered.
- No live-model quality/remote-control/real-account/native-notification proof was attempted; owner forbids model spend and real-data access.
- UI coverage gaps are now explicit. Crawler's generic oracle accepts any core call/focus/DOM mutation, so it is smoke coverage. This source-audit phase did not establish a specific keyboard/focus failure; the later interactive review did reproduce modal-focus defects and added targeted regressions. See [the consolidated report](README.md). No comprehensive accessibility certification is claimed.
- Git reviewer separately reports unbounded checkpoint-object retention and secret-scanner coverage limits; no destructive pruning policy was invented.
