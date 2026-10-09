# Independent review of Wanigan 2 — 7 October 2026

**Continuing audit:** [later findings, fixes, release verification and remaining work](continued-audit.md). [The feature-proof addendum](current-feature-proof.md) checks all 213 rows at the batch-5 baseline, including 39 changed or added claims. This document retains the initial alpha.3 review boundary; the continuation covers subsequent releases.

Reviewed alpha.1 (`0ec5ac3ad48c3ca0e723f2b2dafe6707eea50437`) and its public artifacts, then fixed the findings on `codex-review`. The owner subsequently authorized removing all legacy integration, publishing alpha.2 from the review branch, and updating wanigan.ai with the download and release history. After the owner explicitly approved merging, the four reviewed commits were fast-forwarded into `main` at `6fdb57c`. The alpha.3 corrections were then fast-forwarded to both branches at `e21d97a`. No pull request was opened.

**Initial fix commit:** [`bd3e03c`](https://github.com/DanePete/wanigan-2/commit/bd3e03c9ccbb39a7b84f9c10c889fee2febc6575) (initial alpha.2 code fixes), with documentation corrections in `d0db71d` / `6fdb57c` and a later test-only readiness correction in `fccc63b`. Each fixed finding below has a regression observed failing before its fix, then passing. Documentation corrections and the requested legacy removal are listed separately. A passing test is evidence for its assertions, not a claim that the app has no remaining defects.

**Reviewed release boundary:** the verified application is alpha.3 at `e21d97a`; this report and later marker-coverage qualifications change documentation only. Concurrent update-check work subsequently added to `main` for alpha.4 is outside this audit and its release evidence. Source locations and feature counts below refer to the reviewed alpha.3 snapshot.

## Findings, ranked

The index below orders the code findings by severity: **30 fixed** (12 P1, 17 P2, one P3) and **two open P2 findings**. The initial 29 fixes refer to `bd3e03c`; the staging regression introduced by that patch is corrected in `e21d97a`. Test-harness and documentation corrections are recorded separately below. Locations name the relevant implementation; linked appendices contain the reproduction, named regression and evidence limits. The advisory-run finding proves a missing/corrected launch contract; a model-powered exploit and the real CLI's enforcement were not exercised.

| Severity | Finding | Source location | Disposition and test/evidence |
|---|---|---|---|
| P1 | Concurrent stash drops deleted another stash | `src/core/git-lock.ts:11` | Fixed — `workbench.test.ts`, [git appendix](git-and-checkpoints.md) |
| P1 | Stale conflict resolution overwrote hand edits | `src/core/git-client.ts:696` | Fixed — `conflicts.test.ts`, [git appendix](git-and-checkpoints.md) |
| P1 | Card PR publishing bypassed secret scanning | `src/core/pulls.ts:82` | Fixed — `pull-request.test.ts`, [git appendix](git-and-checkpoints.md) |
| P1 | Push scan omitted merge-resolution secrets | `src/core/git-secrets.ts:114` | Fixed — `workbench.test.ts`, [git appendix](git-and-checkpoints.md) |
| P1 | Alternate push destinations skipped newly published history | `src/core/git-secrets.ts:103` | Fixed — `workbench.test.ts`, [git appendix](git-and-checkpoints.md) |
| P1 | Untracked diff followed directory links outside the project | `src/core/git-client.ts:204` | Fixed — `workbench.test.ts`, [git appendix](git-and-checkpoints.md) |
| P1 | Another project/subfolder hid an agent in the affected checkout | `src/core/git-handlers.ts:51`; `src/core/checkpoints.ts:324` | Fixed — workbench/checkpoint tests, [git appendix](git-and-checkpoints.md) |
| P1 | Duplicate cores recovered the same store and replaced its socket | `src/core/core.ts:108` | Fixed — `single-core.test.ts`, [trust appendix](trust-and-sessions.md) |
| P1 | Advisory launches left custom hooks/settings/skills enabled | `src/core/headless.ts:10` | Fixed launch contract; real exploit unverified — headless/chat argv tests, [trust appendix](trust-and-sessions.md) |
| P1 | Session launch raced an admitted git mutation | `src/core/sessions.ts:275` | Fixed — `session-git-race.test.ts`, including pause/close/archive, [trust appendix](trust-and-sessions.md) |
| P1 | Queued/retried Jev requests ignored Off | `src/core/jev.ts:102`; `:224` | Fixed — `jev-races.test.ts`, [Jev appendix](jev-and-skills.md) |
| P1 | Skill metadata listing read an outside symlink target | `src/core/skills.ts:223` | Fixed — `skills.test.ts`, [skills appendix](jev-and-skills.md) |
| P2 | Cumulative checkpoint/history/attachment storage has no total budget | `src/core/checkpoints.ts:280`; `:494` | **Open** — inspected; no exhaustion soak or deletion policy, [git appendix](git-and-checkpoints.md#remaining-limits--not-verified) |
| P2 | Future migrations run before store ownership admission | `src/core/core.ts:107` | **Open** — inspected; no migration added here, [trust appendix](trust-and-sessions.md#unverified-and-residual-limits) |
| P2 | Alpha.2 staging displayed a stale untracked-diff error | `src/core/git-client.ts:210` | Fixed — `e21d97a`, whole/partial staging regression plus controlled browser refresh, [reproduction](staging-refresh.md) |
| P2 | Mark-as-edited deleted dangling symlinks | `src/core/git-client.ts:714` | Fixed — `conflicts.test.ts`, [git appendix](git-and-checkpoints.md) |
| P2 | Push confirmations showed fetch URLs instead of push destinations | `src/core/git-client.ts:873`; `src/core/pulls.ts:54` | Fixed — `workbench.test.ts`, [git appendix](git-and-checkpoints.md) |
| P2 | Automatic replacement interrupted admitted/background work | `src/core/core.ts:143`; `src/main/core-process.ts:143` | Fixed — restart/core-process tests and warning UI, [trust appendix](trust-and-sessions.md) |
| P2 | Codex composer could answer a startup/trust question | `src/core/sessions.ts:687` | Fixed — `codex-first-message.test.ts`, [trust appendix](trust-and-sessions.md) |
| P2 | Sensitive and orphaned sign-in terminals persisted output | `src/core/sessions.ts:151`; `:216`; `:436` | Fixed — `ephemeral-search.test.ts`, [trust appendix](trust-and-sessions.md) |
| P2 | Quote verification blocked the core on FIFOs | `src/core/review.ts:200` | Fixed — `review-quotes.test.ts`, [trust appendix](trust-and-sessions.md) |
| P2 | Literal-string TOML parsing was quadratic | `src/shared/toml.ts:210` | Fixed — `toml.test.ts` timed subprocess, [trust appendix](trust-and-sessions.md) |
| P2 | Stale Jev criteria could still auto-accept a card | `src/core/jev.ts:247` | Fixed — `jev-races.test.ts`, [Jev appendix](jev-and-skills.md) |
| P2 | Jev accounting omitted retry attempts | `src/core/jev.ts:120`; `:128` | Fixed — `jev-races.test.ts`, [Jev appendix](jev-and-skills.md) |
| P2 | Jev cumulative totals shrank when history was pruned | `src/core/jev.ts:272` | Fixed — `jev-races.test.ts`, [Jev appendix](jev-and-skills.md) |
| P2 | Same-time Jev failures appeared healthy | `src/core/jev.ts:154` | Fixed — `jev-races.test.ts`, [Jev appendix](jev-and-skills.md) |
| P2 | Pending Jev key lookup was invisible to idle replacement | `src/core/jev.ts:174`; `:199` | Fixed — `jev-races.test.ts`, [Jev appendix](jev-and-skills.md) |
| P2 | Git 2.55 corrupted stash paths; CI omitted the full review gate | `src/core/git-client.ts:29`; `.github/workflows/ci.yml:21` | Fixed — stash-prefix/CI workflow tests, [CI appendix](startup-and-ci.md) |
| P2 | App smoke inherited real-home and credential-bearing environment | `src/main/smoke-environment.ts:6` | Fixed — `smoke-environment.test.ts`, [startup appendix](startup-and-ci.md) |
| P2 | README development launch returned 403 for bundled fonts | `electron.vite.config.ts:27` | Fixed — `dev-assets.test.ts`, [startup appendix](startup-and-ci.md) |
| P2 | Text-only/disabled-preferred dialogs left focus behind the modal | `src/renderer/src/components/ui.tsx:190` | Fixed — both-theme sweep assertions, [UI appendix](ui-accessibility.md) |
| P3 | One oversized terminal chunk bypassed the memory-tail cap | `src/core/scrollback.ts:25` | Fixed — `scrollback.test.ts`, [trust appendix](trust-and-sessions.md) |

The detailed reports include file:line locations from the reviewed source snapshot, concrete reproductions, regression names, observed failures, corrections and limits:

- [Git and checkpoints](git-and-checkpoints.md): nine findings. P1: concurrent stash deletion could remove another stash; stale conflict resolution overwrote hand edits; card PR publishing bypassed the secret gate; merge-resolution secrets were omitted; alternate push destinations skipped history; untracked diff could read outside the project; another project could hide an agent working in the same checkout. P2: resolving as edited deleted dangling symlinks; confirmations displayed fetch URLs instead of actual push destinations.
- [Trust and sessions](trust-and-sessions.md): nine findings. P1: duplicate cores could recover the same store and replace its socket; advisory runs did not disable project hooks/skills/settings; session launch raced git mutation. P2: automatic build replacement could interrupt newly admitted work and background answers; Codex composer could answer startup questions; sensitive terminals wrote disk logs; quote verification blocked on FIFOs; Codex TOML parsing was quadratic. P3: one oversized terminal chunk bypassed its memory-tail cap.
- [Jev and skills](jev-and-skills.md): seven findings. P1: queued/retried Jev requests ignored Off; skill metadata listing read a symlink target outside its folder. P2: stale advice could accept a card after its criteria changed; retries were omitted from counts; totals shrank after pruning; same-time failures appeared healthy; pending key lookup was invisible to idle replacement and duplicate enqueue.

Additional findings coordinated in this review:

| Severity | Location | Reproduction and fix | Regression |
|---|---|---|---|
| P2 | `src/core/git-client.ts:29`, `.github/workflows/ci.yml:21` | GitHub CI on alpha.1 used Git 2.55. Its `stash show` custom prefix handling corrupted paths. The local regression also reproduced `ADME.md` instead of `README.md`. Replaced custom prefix arguments with `--default-prefix`; the final GitHub macOS runner reports Git 2.55.0 and its full gate passes. The earlier local suite did not record the resolved core Git binary. CI also omitted the crawler and did not run on this review branch; it now runs the complete npm gate on both authorized branches. | `src/core/stash-prefix.test.ts`; `src/main/ci-workflow.test.ts`; both red → green. |
| P2 | `scripts/app-smoke.mjs:22`, `src/main/smoke-environment.ts:6` | The real-app smoke isolated the database but inherited the caller's home, CLI accounts and key-bearing environment. A synthetic inherited environment demonstrated the leak before any smoke was run. Child environment now uses a temporary home, minimal PATH and neutral git configuration. | `src/main/smoke-environment.test.ts`: polluted environment and actual Electron child homedir. |
| P2 | `electron.vite.config.ts:27` | Following README `npm run dev` launched the app but returned 403 for bundled IBM Plex fonts, because Vite inferred its allowed root below node_modules. Explicitly allow the source and font directories. | `src/main/dev-assets.test.ts`: actual Vite HTTP request changes 403 → 200 with WOFF2 bytes; `/etc/hosts` remains 403. |
| P2 | `src/renderer/src/components/ui.tsx:190` | Text-only confirmations and New Session in a paused project (disabled preferred Start button) left keyboard focus behind the modal. Tabs escaped in both themes. The shared trap now chooses a visible, enabled candidate or another dialog control. | `scripts/ui-sweep.mjs:485` and `:1138`: initial focus, Tab/Shift+Tab containment and Escape restoration; [extra UI evidence](ui-accessibility.md). |

The core restart warning now explains background answers and the older core's unknown idle state even when zero PTYs are reported. Its both-theme UI assertion failed on the old “0 live sessions” warning and passes after the change.

GitHub failure evidence: [failed alpha.1 run](https://github.com/DanePete/wanigan-2/actions/runs/37670196649), [upstream Git fix](https://github.com/git/git/commit/66f4856110a7577c12f97ae905c95a6f38adba9d). This was an actual Git defect, not an assumed Actions version problem; Actions v7 resolved successfully.

The new GitHub run then exposed a separate UI assertion race: it combined a tooltip captured before sessions loaded with a disabled state read after loading. All 522 units, including the stash regression, had passed. The delayed-response reproduction failed under the old assertion and passed in both themes with the corrected wait/snapshot. `fccc63b` changes only the sweep; its full UI-sweep rerun passed without rebuilding the app. [CI readiness evidence](ci-readiness.md).

## Feature and documentation claims

[The complete 192-row proof audit](feature-proof.md) accounts for every original row and checks the named assertions, not just test-file existence. All named files exist. Original assessment: 140 supported within fixture scope, 33 partial, 16 manual/unverified, three contradicted by source. The removed legacy row remains in that historical audit so none disappears silently.

The reviewed alpha.3 feature matrix has 205 rows: remove one legacy-discovery row and add 14 git-workbench rows, including the alpha.3 staging-refresh regression. README and the matrix at that snapshot described bounded discovery (the later History-wide scan claim was disproved and corrected in the continuation), supported skill sources, Jev's actual metadata payload and estimated cost, the lifetime of keep-awake, and limits of UI coverage. Universal discovery, sub-second latency and “every call's cost” claims were narrowed to what is observed.

The crawler's broad success oracle can accept any RPC, focus move or DOM change. A control performing the wrong operation can pass it. Outcome assertions in the unit and targeted UI tests are stronger evidence. The old matrix also assigned board mouse-drag and comprehensive keyboard/focus proof to tests that did not establish them. Migration tests reconstruct old schema from current migration strings; they do not freeze shipped SQL bytes. No shipped migration was changed in this review.

The alpha.1 notes' 480 unit tests were reproduced. Their 2,097-control count is not a durable behavior guarantee: this fresh crawl visited 2,096 controls, with dynamic/guarded/disappearing controls recorded separately. Git workbench, source license and architecture claims were checked against code. SECURITY.md correctly describes Unix sockets, token roles, mode checks, unsandboxed same-user agents and lack of notarization; the identified input-validation gaps above were fixed.

## Requested legacy removal and preserved work

Removed project discovery/import, old database options and default paths, history name/note imports, protocol/model types, demo fixtures and renderer badges/suggestions. Regression fixtures prove the retired RPC is refused and the retired database option cannot override CLI history. No legacy database is opened. Historical code-provenance comments and the original design's history remain historical references.

The original recording isolation change was superseded by removing the integration itself. The recorder no longer needs `WANIGAN_NO_WANIGAN1`. The owner's three video pipeline files remain uncommitted and intact. Their app-facing changes drive the actual workbench, confirmations and a temporary local bare remote; the timing/caption changes do not enter the shipped app. No real-mode recording or model run was attempted. An exact initial five-file diff was preserved in the temporary audit folder.

## Corrections found during final verification

Alpha.2 was published before the full crawler finished. That final crawl found 19 failures: the newly added untracked-file containment guard rejected a stale `area: untracked` request after successful staging, so overlapping status/diff refreshes displayed an error. This was introduced by the review's fix and was missed by its initial unit coverage. Alpha.3 corrects the transition without reading unlisted files or weakening containment. Its regression covers whole-file and partial staging, and a controlled UI check holds status until the stale diff answers. The correction is committed and pushed in [`e21d97a`](https://github.com/DanePete/wanigan-2/commit/e21d97ad8bc181aeab63ca707f196c42b0c56475). The focused workbench/conflict suites passed 29 tests and the browser Checks surface passed 29 checks; the complete local gate subsequently passed with zero failures. [Reproduction and scope](staging-refresh.md).

The first main CI run after merging (`37692272337`) failed before UI tests: 521 of 522 unit tests passed. The no-project-writes snapshot captured `.git/objects/maintenance.lock` left by its own setup commit; Git 2.55 detached maintenance and removed that lock after the baseline. Setup now disables automatic maintenance only in its child shell, and a Trace2 assertion proves no maintenance child starts. The original project/`.git` snapshot remains intact, including its pre-existing `.git/index` exclusion; checkpoint tests separately cover index bytes. The regression failed on Git 2.55 before the correction and the five session-life tests passed afterward on Git 2.55 and 2.50.1. This test-only correction is also in `e21d97a`; [maintenance evidence](ci-maintenance.md).

README now explicitly separates historical development reports of real model turns from this review’s stand-in verification. Those earlier provider claims were not independently reproduced under the no-model-spend rule.

README also overstated the source packaging command: `dist:mac` creates an app and zip, while the release DMG is assembled separately. The claim now matches `electron-builder.yml`'s targets; the original feature matrix packaging row promised only the app, so its assessment is unchanged.

## Verification results

| Check | Result and scope |
|---|---|
| Fresh public alpha.1 clone: README installation, test and package path | `npm install` passed; 480 unit tests, full UI sweep and crawler passed (2,096 controls, zero failures); packaged app and smoke passed. The development font failure found separately was fixed and retested. |
| Alpha.2 final local gate | 522 units and full UI sweep passed; crawler failed 19 times on the introduced staging-refresh error. This failure is retained rather than replaced by the later green evidence. |
| Alpha.3 `env -u ELECTRON_RUN_AS_NODE npm test` | Passed, exit 0: typecheck; 523 unit tests; full UI sweep; complete crawl (79 surfaces, 2,099 controls, 51 shortcut keys, 29 checks; 2,129 passed, zero failed, 18 allowed, one guarded, 31 gone before their turn). |
| GitHub CI | Release commit `e21d97a`: [main CI 37693322070](https://github.com/DanePete/wanigan-2/actions/runs/37693322070) passed (523 units, full UI sweep, 2,131 crawler passes, zero failures; secret scan passed). |
| Targeted staging and CI regressions | Core staging regression observed red then green; workbench/conflicts 29/29 and controlled browser Checks 29/29 pass. Maintenance regression observed red on Git 2.55; session-life 5/5 with each fixture Git version pass. |
| Additional Git-version validation | Original targeted suites: 30 tests passed locally; the core Git binary was not recorded, so the earlier Git 2.55 parity label is withdrawn. Alpha.3 full units: 523/523 with fixture Git 2.55 and core Git 2.50.1; the exact scope and missing-template first run are recorded in the maintenance appendix. |
| `npm run smoke:app` and released-app smoke | Source, packaged app and extracted alpha.3 zip app pass with actual windows, PTYs, CLI calls, menus, core survival and recovery. No headless-only escape was used. |
| Release DMGs | Alpha.1 and alpha.3 mount read-only; checksums, signatures, app contents and isolated Help-menu demo path verified. Alpha.2 historical artifact checks are retained below. |
| Additional UI review | 24 surfaces at 960×700 in both themes: 132 rendered input checks and 686 Tab observations, zero reported failures, overflow or page errors. Counts include repeated controls; this is not complete accessibility certification. Before/after dialog screenshots are included. |
| Full-history secret scan | `gitleaks git . --log-opts=--all` passed at `e21d97a` (169 commits). The new report directory separately passed `gitleaks dir`; the report commit `27f4ea4` also passed the full-history scan (171 commits). |
| Website | 19 tests, typecheck, lint, build and browser checks pass; publication evidence is below. The existing video-worker lint warning remains. |
| Documentation | Local report links resolve and `git diff --check` passes. All 192 original feature rows have an explicit proof assessment. |

All npm/build/Electron commands used Node 22.23.2 and the requested Electron environment handling. Detailed temporary logs are under `/private/tmp/wanigan2-review/`; code, regression tests, this report and screenshots provide the durable evidence.

The fresh-clone installation caused only npm's `hasInstallScript: true` metadata normalization for better-sqlite3 in its temporary package-lock; no dependency version changed. Fresh README development launch exposed the font issue above; the corrected development launch was separately confirmed in an isolated home.

## Release artifact verification

Alpha.1 downloaded DMG and zip match both published SHA-256 values:

- DMG: `9e43c3f7c71952f7987c60f6f45836639076305cd1f72b30378af98a73a1ec1e`
- Zip: `3fa111f45bdd59e06ab7c43ddb09e89a24d9132bc5b09cb1f2d714e29f2f49cd`

The DMG mounted read-only. Both extracted apps passed `codesign --verify --deep --strict`; both contain the identical app.asar (`3992c888223cc2fa70a009c33710e8d4bc75bb9f3a62a0a52f32457d2f03dd43`). Signature is ad hoc, hardened runtime, Apple silicon, bundle id `io.deadnorth.wanigan2`, no TeamIdentifier, no notarization.

The actual Help › Open the Demo menu action launched a second app with three temporary projects and stand-in sessions; the parent's project list remained empty. The audit redirected the demo child's destination into a temporary directory and enabled local CDP inspection. This deliberately tested the real menu/action/seed path without using either real application-data directory. Released-app and fresh packaged-app smoke checks also passed.

Alpha.2 is [published](https://github.com/DanePete/wanigan-2/releases/tag/v2.0.0-alpha.2) from the fix commit. Its final app passed the source and packaged smoke checks, strict/deep signature verification and the same isolated Help-menu demo test. The mounted DMG's main/core/CLI/preload/renderer bytes match the tested build; the zip and DMG have identical app.asar (`84a541a8050a4fd06762486e3a2f2d75024c616fbd9bb0bb2be3e60dfc6ae19b`). GitHub's asset digests match local hashes, and a separate download of the public DMG produced the same hash.

| Asset | Bytes | SHA-256 |
|---|---:|---|
| DMG | 161157680 | `5d520be440751d805f6e78af23f308468efc835638fc6731c0218dbdf858c894` |
| Zip | 142889598 | `6bbcd1b0aa03587a9180f7864c916ea66e20a2ffef15b2eb5e1626a71dbbb106` |

The app declares macOS 13 minimum; that minimum was inspected in Info.plist, not runtime-tested on macOS 13. Ad-hoc signing and lack of notarization remain unchanged.

Alpha.3 is [published](https://github.com/DanePete/wanigan-2/releases/tag/v2.0.0-alpha.3) from `e21d97a`, after its complete local gate and main GitHub CI passed. Source, packaged-app and extracted-zip smoke tests passed. Its DMG mounts read-only and its actual Help → Open the Demo action opens an isolated second app with three sample projects while the parent stays empty. Both DMG and zip apps pass strict/deep signature verification and contain identical app.asar (`9f69626375455aa11bbbc4b26826e36e45e07419ebb563dceb0d22f551635d30`). GitHub’s uploaded asset digests and an independent public DMG download match the hashes below. All 97 files under the mounted app's `out/` match the full-gate build byte-for-byte. [Mounted demo screenshot](screenshots/alpha3-demo.png).

| Alpha.3 asset | Bytes | SHA-256 |
|---|---:|---|
| DMG | 159735704 | `50f8097e5fefe4e831fbac17af5d3544534aad970b0df23cf04db0f2cf762ef4` |
| Zip | 142889613 | `e8cc2ba2488d133290db9289a2a24e4b85f9fb6c8fdd4a1c7f1fd083b57a6446` |

## Website publication

The first [wanigan.ai](https://wanigan.ai) publication linked the alpha.2 DMG, its checksum and release notes, with a dated “What’s new & bug fixes” section and alpha.1 history. The existing website uses Cloudflare Workers Static Assets; stale Sites metadata was not used for deployment. Website commits on `codex-review-site`: `da970803765adc89d71689c059f51348204cc73f` , `7230c82914926a4c5d02d43f0144fb0438b8a473`, and `59d821e9d7cfb2d21eb399e72a1c55259f034ef8`. There is no website git remote configured, so these commits are local. Alpha.2’s final Cloudflare deployment: `9e4a8d32-cf4b-46c0-b3f6-157703bc87a5`. Source-install commands and source/matrix links now pin the download’s published tag; their regression failed before the correction, and the final 19 website unit tests and live checks passed.

Typecheck, lint, unit tests (18 initially, 19 after the source-link regression), build, companion GPU test and browser checks passed. A pre-existing anonymous-export lint warning remains. Two existing/new narrow-width overflows were reproduced and fixed; checks cover 320/390/560/768/1440px in both themes. Existing scrollable-code keyboard access was preserved with narrow explained lint exceptions; untracked `.claude` worktrees were excluded from lint discovery without modifying them. The page-height budget increased by 600px to accommodate the measured 546px new section, with independent overflow checks retained.

Deployed HTML matches the built file byte-for-byte. Public DMG returns HTTP 200 with the measured size. Fresh live browser checks passed desktop/phone in both themes, release/download/checksum links, and no page errors or overflow. One initial phone-light navigation timed out; the complete retry passed, with no unsupported cause assigned. [Website verification record](website.md).

At this review’s publication, alpha.3 was the live website download. Website commit `61bf38f8dfce509a590d8d272d9ed1d59e3c3f5f` deployed as `fe000fd7-a1b6-43af-88c1-6ad2ddfdeda9`. Its 19 tests, typecheck, lint, build, complete live browser checks and both-theme exact download/source-link checks passed. The live HTML matches the tested build byte-for-byte; the public DMG’s size and independently downloaded SHA-256 match the verified artifact. Alpha.1/alpha.2 remain in the dated history. [Alpha.3 website evidence and screenshots](website-alpha3.md).

## What was verified correct

- Server-side ACCESS enumeration rejects owner methods from session tokens, session methods from the owner, unknown methods, cross-project mutations and writes by ended sessions. Renderer isolation and typed preload remain intact; text is not interpreted as owner RPC.
- Hooks use session authority, exact Codex trust hashes and real relay framing. Claude first delivery waits for prompt evidence; bracketed paste is sanitized. Resume, lost sessions, window disconnect, SIGKILL recovery and duplicate-start reservations were tested with stand-ins and real processes.
- No routine session launch writes harness settings/hooks/memory into a project's files. Explicit owner copy/setup/git actions retain their documented effects.
- Git validates refs/paths, never requests a force push, refuses non-fast-forward races and destructive actions beside agents. Staging, stale hunks, stash outcomes, binary/rename conflicts, manual edits and inline/incomplete literal markers are outcome-tested. Complete whole-line literal marker blocks have the ambiguity described below; explicit preservation was separately verified through the actual core.
- Checkpoints preserve index, refs, stash and repository objects during capture; undo/redo preserve unrelated work and refuse stale/unsafe states. Snapshot objects live in the app's store.
- Builds, native addon loading, signatures, menu/PTY/CLI behavior and core survival were exercised with actual Electron and temporary state. Native app tests used no `--allow-no-window` escape.

## Remaining findings and limits

1. **P2 — cumulative disk retention remains unbounded.** `src/core/checkpoints.ts:280` and `:494` retain checkpoint objects without a total budget; SQLite history, attachments and many bounded per-session logs also accumulate. Repeated tracked-binary edits add objects indefinitely. This is a code-inspection finding; no disk-exhaustion soak was performed. Automatic deletion was not introduced because it would remove undo/evidence without a retention and user-visible expiry contract. A future fix should bound new capture or implement explicit retention while preserving honest unavailable states.
2. **P2 — future mixed-version migration admission.** `src/core/core.ts:107` opens/migrates the DB before claiming its new ownership lease. No migrations were added here, so the current duplicate-core regression is fixed; a future schema release must serialize migration admission too. No shipped SQL was edited to retrofit it.
3. **Secret scans are heuristic.** Short/plain passwords, unprefixed tokens without recognized assignments, binary diffs, PEM-body-only changes and certain very long lines can be missed. Commit/byte caps require acknowledgment of incomplete coverage. No real key was used. The report does not promise secret-free publication.
4. **No real model behavior was purchased.** Safe-mode flags were verified against local CLI help and captured launch argv, not a live model-powered exploit. Supporting Claude versions are required; older versions fail rather than silently omit the boundary. Real account sign-in, provider billing, Remote Control, model quality and actual provider resume were not exercised. Jev spend is a configured-price estimate from returned usage, not billing reconciliation; older discarded totals cannot be recovered.
5. **UI coverage is finite.** Extra 960px both-theme checks supplement the existing suite; they do not certify every control's semantic effect, full mouse board-drag, all assistive technologies or every native notification/GPU surface. See screenshots and the feature audit for the precise proof scope.
6. **No global resource/adversarial soak.** Slow-reader socket backpressure, sustained connection floods and multi-day memory/disk growth were not certified. Same-UID agents and repository-controlled Git hooks/filters/helpers execute with user permissions by design; this app is not an OS sandbox.
7. **Toolchain dependency advisory.** Fresh `npm audit` reported eight moderate transitive development-toolchain entries rooted in [sprintf-js advisory GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). No dependency replacement was made without a supported upstream resolution. This is not a statement that all runtime dependencies are vulnerability-free.
8. **Complete literal conflict-marker blocks are ambiguous.** `src/shared/conflict.ts` is language-agnostic: a complete, column-zero marker block inside a template string appears as a hunk in an already-unmerged file. Git index status prevents literal text alone from opening the resolver. In a real conflict, hand-edit the file and explicitly acknowledge keeping markers; four additional actual-core checks verified refusal without acknowledgment and exact working/index bytes with it. The former “markers inside strings remain text” claim was too broad and is now qualified. [Reproduction and coverage](git-and-checkpoints.md#literal-marker-coverage).
9. **Platform limits.** Executed on this Apple-silicon macOS host. Minimum macOS version, Intel/Windows/Linux, notarization and a clean machine's Gatekeeper flow were not runtime-certified. Checksum and ad-hoc signature validation do not replace notarization.

Neither real Wanigan application-data directory was accessed, and no real model turn ran. Temporary logs and expanded evidence remain under `/private/tmp/wanigan2-review`; repository screenshots and reports below are the durable handoff.
