# Continuing independent audit

This is a continuation of the alpha.3 report, including the alpha.4 update-check changes. The audit is ongoing; the findings below describe verified batches, not a claim that every part of the application is defect-free. The owner authorized publishing tested changes to `codex-review`, merging into `main`, and updating the release download and website.

## Batch 1 — store admission, input validation, update checks

Baseline: `8733940ea2b1d664c8dd195750ff1242ae464d21`. Fixes are in `eb3d69e8614ec400bb45117934adc9a980037c40`. Each code regression was observed failing against the old implementation before passing with its fix. Shipped migration SQL was unchanged.

| Severity | Location | Reproduction and correction | Regression |
|---|---|---|---|
| P1 | `src/core/db.ts`, `src/core/core.ts` | Open a second core with an additional migration while the first owns the store. The old code migrated before refusing it. Admission now holds the same write transaction as migration and happens first. | `single-core.test.ts`: a refused second core cannot apply a newer schema before ownership admission |
| P2 | `src/core/db.ts` | Put an invalid schema marker in a disposable database, or point the loader at a foreign database. Invalid markers were accepted and refusal could change the foreign store. Schema validation is strict and refusal rolls back metadata creation without changing journal mode. | `db-upgrade.test.ts`: invalid schema markers and foreign-store preservation |
| P2 | `src/core/handlers.ts`, `src/core/parameter-booleans.ts` | Send string-valued booleans through an owner request: false could tick a criterion; malformed preview could reach a filesystem writer. Every boolean field in the protocol now requires a runtime boolean. | `input-validation.test.ts`: malformed booleans and invalid preview flag |
| P2 | `src/core/board.ts` | Update a project with one valid field followed by an invalid field. The request failed after partially changing the project and activity. The entire update now runs in a transaction. | `input-validation.test.ts`: project update refuses atomically |
| P2 | `src/main/updates.ts` | Stream a release response beyond the limit without Content-Length. The old text reader buffered the entire response before checking it. The new reader cancels when the aggregate byte budget is exceeded. | `updates.test.ts`: oversized chunked release response |
| P2 | `src/main/updates.ts` | Place the newest stable release beyond the first 20 results. The old checker incorrectly reported current. Pagination now follows only trusted repository URLs, within shared time, byte and page limits; incomplete results fail explicitly. | `updates.test.ts`: later pages and incomplete/untrusted pagination |
| P2 | `src/shared/updates.ts` | Reopen a cached prerelease offer on a stable installation, or load corrupt/interrupted cache state. Cached advice now obeys the installed channel, and invalid state cannot report current. | `updates.test.ts`: cached update advice and corrupt/interrupted cache |
| P3 | `src/main/update-menu.ts`, `src/main/index.ts` | Activate Check for Updates repeatedly while its dialog is open. Multiple dialogs could stack. The entire check-and-dialog operation now shares one in-flight promise. | `update-menu.test.ts`: repeated menu activation |

Verification for this exact batch: `npm test` passed typechecking, 549 unit tests, the UI sweep, and the complete crawler (79 surfaces, 2,073 controls, 51 shortcut keys, 29 checks; 2,104 passed, zero failed, 18 allowed, one guarded, 30 gone before their turn). `npm run smoke:app` passed with a disposable home and stand-ins. `gitleaks git . --log-opts=--all --redact --no-banner` scanned 173 commits and found no leaks. `git diff --check` passed. No real model turn was run and neither protected application-data directory was accessed.

Further reproductions and fixes are being verified in an isolated worktree. They are not covered by this batch's full-suite result. Cumulative storage limits, remaining error-state and race checks, module splits, packaging and the next release remain in progress.

## Batch 2 — alpha.5

Baseline: `eb3d69e8614ec400bb45117934adc9a980037c40`. These fixes are separate from the further module cleanup and follow-up fixes being tested in another checkout.

| Severity | Location at alpha.5 | Reproduction and correction | Regression observed failing before the fix |
|---|---|---|---|
| P1 | `src/core/checkpoints.ts:467` | Hide a pre-existing file from Git, expose it during a turn, then fail the deletion-safety diff. Undo previously interpreted failure as no deletions. It now refuses and keeps the file and current work unchanged. | `checkpoints.test.ts`: an unreadable deletion safety check refuses undo and preserves pre-existing data |
| P2 | `src/core/board.ts:405` | Supply an oversized note to claim, heartbeat, release, submit or approve. The old code changed state before rejecting its comment. Notes are now validated before any transition. | Five cases in `input-validation.test.ts`, comparing complete card and activity before/after |
| P2 | `src/core/git-client.ts:716` | Make a conflicted working file larger than the text preview limit, with unresolved markers, then mark it resolved as edited. The missing text check previously staged it. It now refuses unless the owner explicitly acknowledges keeping unchecked markers. | `conflicts.test.ts`: marking a large hand-edited conflict resolved refuses an unreadable marker check; existing binary, rename, symlink, hand-edit and literal-marker tests retained |
| P2 | `src/shared/markdown.ts:60` | Render 10,000 nested quote markers. The old parser overflowed the stack. Nesting now stops at 32 and the remaining text stays visible. | `markdown.test.ts`: deeply nested quotes |
| P2 | `src/shared/markdown.ts:160` | Parse 400 KB of unmatched inline backticks or 60,000 wrapped list lines. Repeated scans/copies were quadratic. Backtick positions are indexed once; list spans are appended. The old all-backtick performance test entered the fenced-code path and did not prove inline performance. | Two bounded subprocess cases in `markdown.test.ts`, each observed failing against its old implementation |
| P2 | `src/client/client.ts:32` | A socket peer replies with JSON null, malformed ready metadata, or closes before handshaking. Null escaped as an uncaught exception; closure waited for the timeout. Protocol objects and ready roles are validated and early closure rejects promptly. | Three `client.test.ts` regressions, including an isolated subprocess for the former crash |
| P2 | `src/renderer/src/components/ui.tsx:95` | Submit another comment after its RPC completes but before React commits the cleared draft. This reproduced the duplicate-comment failure in main CI. The single-flight guard now stays held through that commit. | `scripts/ui-regressions.mjs`: comment-completion-race, both themes |
| P2 | `src/renderer/src/views/CardDrawer.tsx:337` | Type a new comment while the previous send is pending. The completion used to erase the new draft. It clears only the text that was sent. | Browser regression comment-next-draft, both themes |
| P2 | `src/renderer/src/lib/settings.ts:14` | Deliver a newer settings event, then resolve the initial snapshot with stale data. A revision check now prevents the old answer from replacing the new state. | Browser regression settings-late-response, both themes |
| P2 | `src/renderer/src/views/CardDrawer.tsx:418` | Reject a branch's changes query. The old UI displayed zero files changed. It now shows the error and Retry. | Browser regression branch-read-error, both themes; before/after screenshots inspected |
| P2 | `src/core/core.ts:109` | Fail construction after store admission by making the temporary owner-token path unreadable. The old live-process lease prevented retry. Construction now releases its own lease and closes the database on failure. | `single-core.test.ts`: constructor failure releases its store so the same process can retry |
| P3 | `src/shared/markdown.ts:160` | An inline code span closed against a longer backtick run. Exact run lengths now match. | `markdown.test.ts`: backtick closing runs |
| P3 | `src/core/safe-fs.ts:14` | A legitimate descendant named `..notes` was mistaken for parent traversal. The check now rejects the parent segment, while permitting ordinary dot-prefixed names. | `safe-fs.test.ts` |
| P3 | `src/core/core.ts:36` | Query core.hello or read a temporary core discovery file: even alpha.4 reported alpha.1. Both now use the packaged application version. | `single-core.test.ts`: the core handshake and discovery file report the packaged application version |

CI now retains crawler reports and browser-regression screenshots as well as the sweep images. The deterministic UI regressions run as part of `npm test`; `ci-workflow.test.ts` checks that wiring. The test suite still does not prove every generic crawler action's semantics.

Verification: typecheck and all 567 unit tests passed, followed by the sweep and eight browser race/error checks. The complete crawler passed: 79 surfaces, 2,095 controls, 51 shortcut keys, 29 checks and 2,036 actions; 2,126 passed, zero failed, 18 allowed, one guarded and 30 gone before their turn. The real packaged app smoke passed; the zip extracted and its app passed the same smoke. Strict deep code-signature validation passed. The DMG mounted read-only, and Help › Open the Demo launched a second app with sample projects rooted under a disposable directory while its parent test store stayed empty. The latest history scan covered 174 commits with no leaks. All checks used stand-ins and fake homes. A fresh public clone plus this candidate diff installed and packaged successfully. `npm audit --omit=dev` reported zero vulnerabilities; the full dependency audit reported eight moderate development dependency entries, all arising from the `sprintf-js` precision denial-of-service advisory through electron-builder’s dependency graph. That development dependency issue remains open; it is not included in the packaged runtime dependencies.

The DMG is 161,169,474 bytes, SHA-256 `b219c462f44ae815a3486b1e75cfad6378b91cce5078b932fa7d9611535de8c1`. The zip is 142,899,497 bytes, SHA-256 `4e77892485f709d01c39e7e30ea1cc33e7784d38b956daf1d2bad9682f343948`. The app is ad-hoc signed and not notarized.

## Review of batch 1

The code-review skill reviewed pinned `8733940...eb3d69e` on separate Standards and Spec axes. The findings below remain separate; both have reproductions and fixes in the subsequent batch under verification, outside alpha.5.

### Standards

No newly introduced documented-standard breach was demonstrated. Shipped migrations remain unchanged; ownership admission precedes migration in one transaction; boolean validation runs inside core dispatch; project-update refusal preserves database/activity state. The streaming regression measures consumption and cancellation, satisfying CONTRIBUTING.md's “Prove the outcome.”

One pre-existing P2 remains in the touched update-cache area: `src/main/updates.ts:48–53,151–157` persists current without identifying the installed version that was checked. Check 2.1.0, then open 2.0.0 against the same cache: it still reports current, indefinitely with daily checks off. An explicit check finds 2.1.0. This violates the design's “No false greens. Unknown is shown as unknown.” The reproduction used a temporary cache and synthetic network responses. The next correction persists the checked version and rejects incompatible or unidentified current results.

Total: zero demonstrated new Standards violations; one reproduced pre-existing false-health finding.

### Spec

One residual P2: `src/main/updates.ts:196–197` recognized only the literal Link relation `rel="next"`. Valid unquoted or multi-relation values (`rel=next`, `rel="next last"`) were ignored, allowing an incomplete first page to report current. This contradicts the feature's newest-release claim and the continuing report's promise that incomplete results fail explicitly. A two-page synthetic response reproduced one request and a false current result; the next correction handles both relation forms while retaining URL and budget checks.

The batch otherwise addresses the earlier cached-prerelease, malformed-cache, response-bound and duplicate-dialog defects. No scope creep was found.

Total: one Spec finding, incomplete pagination.

## Alpha.5 publication

Published commit `b35329a18d6e6eee2847cc0eecf8de4db3e065f4` to both `codex-review` and `main`, and released the DMG and zip at `v2.0.0-alpha.5`. A fresh download of the public DMG matched the published SHA-256 above. The website download, checksum, source tag and release history were updated together in marketing commit `0c6970e`; the deployed website passed its browser checks in both themes, desktop and phone layouts, including keyboard expansion of older release notes. The build is still ad-hoc signed and not notarized.

## Batch 3 — bounded reads, lifecycle cleanup and module boundaries

Baseline: `b35329a18d6e6eee2847cc0eecf8de4db3e065f4`. Fixes are in the commit introducing this section. The full gate ran against a frozen copy of this batch before it was brought onto `codex-review` with hash checks; original video work and newer reports were preserved.

| Severity | Location | Reproduction and correction | Regression observed failing before correction |
|---|---|---|---|
| P2 | `src/core/bounded-file.ts:6`, `attachments.ts:101`, `chat.ts:94`, `git.ts:283`, `src/main/picked.ts:21` | Grow an attachment after it was recorded, or grow an owner-picked/untracked file between metadata inspection and reading. The previous readers could allocate beyond their claimed limit. Reads now use one regular-file descriptor, bounded reads, and a final identity/size/time check; special files and unapproved symlinks refuse. | `bounded-reading.test.ts`: preview, chat, picked-file and untracked-file growth; `bounded-file.test.ts`: exact boundary, oversized files, directories, symlinks, FIFO and descriptor growth |
| P2 | `src/core/core.ts:193` | Fail startup while writing discovery metadata. The store and sockets previously remained held. Startup now runs cleanup on failure, so the same process can retry. | `single-core.test.ts`: failed startup closes its store and can be retried |
| P2 | `src/core/accounts.ts:164`, `src/core/core.ts:224` | Resolve a delayed account probe after core shutdown. It previously wrote into a closed database. Shutdown stops account work, and late results are discarded before mutation. | `single-core.test.ts`: an account probe completing after shutdown does not write to a closed store |
| P2 | `src/main/updates.ts:196` | A valid Link header with unquoted or multiple relations hid the next page. Relation lists now recognize `next` while keeping repository and budget restrictions. | `updates.test.ts`: next-page relation forms |
| P2 | `src/main/updates.ts:156`, `src/shared/updates.ts:179` | Check a newer installed version, then reopen its current-result cache from an older version. The old result incorrectly stayed current. Cache results now identify the checked installed version; incompatible/legacy current results become unknown. | `updates.test.ts`: current cache belongs to the installed version that was checked |
| P2 | `src/renderer/src/views/CardDrawer.tsx:300`, `SessionView.tsx:166`, `components/Chat.tsx:165` | Type the next criterion, queued session message or chat prompt while its predecessor is sending. Completion previously erased the next draft. Only the submitted draft is cleared. | `ui-regressions.mjs`: criterion/session/chat-next-draft, both themes |
| P2 | `src/renderer/src/lib/api.ts` | Deliver a new connection-status event, then resolve an older initial status response. The old answer previously replaced the new status. The initial read now respects event revisions. | Browser core-status-late-response, both themes |
| P2 | `src/renderer/src/views/CardGit.tsx:12` | Reject the project's changes query while viewing a working/review card. The changes section previously disappeared. It now reports the error with Retry. | Browser project-changes-error, both themes |
| P2 | `src/renderer/src/views/CardGit.tsx:113` | Click Remove branch on a card. It previously called the destructive core method immediately. A dialog now names the branch and path; Cancel makes no call, confirmation makes one. Core refusal rules remain in force. | Browser remove-branch-confirmation, both themes |
| P3 | `src/renderer/src/components/ui.tsx:194` | Tab through a dialog containing a link, hidden button and negative-tabindex input. Links were omitted and ineligible controls could enter the focus loop. The trap now follows visible, enabled, eligible controls including links. | Browser modal-focusable-links, both themes |

The existing git-client file was divided by responsibility into `git-commands.ts`, `git-history.ts`, `git-branches.ts` and `git-conflicts.ts`, preserving its public facade. The facade fell from about 900 lines to 404. CardDrawer's branch/project-change and AI-review sections moved into `CardGit.tsx` and `CardReview.tsx`; CardDrawer is now 397 lines. Existing git/workbench/conflict/checkpoint tests covered the moves. Confirmed unused `useBusy` and three unused imports were removed. TypeScript now rejects unused locals and parameters; no baseline suppression was added.

Verification: `npm test` passed typechecking, all 577 unit tests, the UI sweep, 22 browser regressions, and the complete crawler: 79 surfaces, 2,097 controls, 51 shortcut keys, 29 checks, 2,038 actions; 2,132 passed, zero failed, 14 allowed, one guarded, 30 gone before their turn. Before/after screenshots for visible changes were inspected in both themes, including the project-read error and removal confirmation. This is a batch result, not a claim of a finished whole-app audit.

## Review of batch 2

The code-review skill reviewed pinned `eb3d69e...b35329a` on separate axes. These findings have follow-up corrections under verification, outside alpha.5 and batch 3.

### Standards

Two proof gaps: `checkpoints.test.ts:445` asserted a listing's refusal without actually attempting undo, and its fault shim also failed a later read that could mask the danger. The stronger regression must fail only the safety read, invoke undo, and compare working-file bytes, index bytes and checkpoint rows. `scripts/ui-regressions.mjs:88` asserted that Retry existed, while permanently failing its query; it did not prove clicking Retry recovers. Both violate CONTRIBUTING's “Prove the outcome.” No new runtime defect or additional justified smell was demonstrated by this axis.

Total: two Standards test-coverage findings.

### Spec

Two residual P2 defects: malformed nested protocol error messages (`{message:{toString:0}}`) escape the socket callback while constructing CoreError and crash the client; and a whitespace-heavy malformed Markdown table divider takes quadratic time. Isolated subprocesses reproduced both. The other inspected fixes fit the requested audit scope and no scope creep was found.

Total: two Spec findings, client robustness and agent-controlled parser work.

## Remaining verification and open work

GitHub run `37703577880` passed batch 1; its sibling `37703579514` failed on a three-second crawler click timeout at Pick added line 3. This was not the duplicate-comment failure. Both alpha.5 CI runs (`37705731443` and `37705731524`) subsequently passed. The crawler diagnostics currently truncate the click log; the intermittent failures are not yet explained and have not been hidden with allowlists or larger timeouts.

Cumulative checkpoint/history/attachment retention, socket resource budgets, further error-state and draft races, remaining large modules, and the complete updated feature-to-test proof matrix remain under investigation. Real-model behavior remains unverified by design: tests and smoke use fake homes and stand-ins, and no real model turn has been purchased.

Batch 3 app smoke: the first run missed the in-window failure alert while visible Chrome website checks were running concurrently. An isolated repeat passed every smoke assertion, including that alert, startup refusal/retry, live PTY and CLI, owner-consented update checking and the detached core surviving window quit. Focus interference is consistent with the notification routing code, but the first failure is retained as a test-environment limitation rather than erased.


## Review of batch 3

The pinned `b35329a...ab39a30` delta was independently reviewed on both axes. Standards found no new documented-standard breach or justified smell; an AST comparison confirmed the 28 extracted Git function bodies were unchanged, and bounded-file tests were independently rerun. Spec reproduced one residual P2: editing a sending draft away and back to the same text still lets completion erase that newly authored draft in comments, criteria, session messages and chat. Equality with the submitted text is insufficient; a draft revision is needed. This correction is under test in the next batch and is not included in alpha.6. Totals: zero Standards findings; one Spec finding.

## Batch 4 — malformed protocol input and stronger proofs

Baseline: `ab39a30516de5dbf3f79c6e8f8927fd58c100178`. The commit introducing this section is alpha.6, including the already verified batch 3.

| Severity | Location | Reproduction and correction | Regression observed failing before correction |
|---|---|---|---|
| P2 | `src/core/server.ts:132` | Send a request with a method object containing `toString: 0`, as either owner or session. Error handling previously coerced it again and escaped as an unhandled rejection, taking down the core. Request envelopes now require a positive safe-integer ID and a bounded string method before dispatch or logging. | `server.test.ts`: malformed wire requests from either role refuse without taking down the core; subprocess stays alive and answers a subsequent valid request |
| P2 | `src/client/client.ts:10` | Reply during handshake or RPC with an error whose message is an object containing `toString: 0`. Constructing CoreError previously escaped the socket callback and crashed the client. Both paths now validate the error code and string message first. | Two isolated `client.test.ts` malformed-error regressions |
| P2 | `src/shared/markdown.ts:37` | Parse a malformed table divider with 160,000 spaces. A repeated regular-expression search took quadratic time. Splitting cells and checking each with an anchored expression makes the work linear in the divider length. | `markdown.test.ts`: malformed table divider bounded subprocess; old code exceeded three seconds |

The checkpoint safety regression now fails only the relevant deletion-safety read, invokes actual undo, and verifies current file bytes, index bytes and checkpoint rows are unchanged. Removing the refusal makes that test fail. The branch error regression now succeeds on the next real query, clicks Retry, and asserts the alert disappears and a positive changed-file count appears; disconnecting Retry fails in both themes. These repair the two proof gaps identified in the batch 2 Standards review.

Verification: full `npm test` exited zero: typecheck, 581 unit tests, UI sweep, 22 browser regressions, and complete crawler. The crawl covered 79 surfaces, 2,095 controls, 51 shortcuts, 29 checks and 2,034 actions: 2,127 passed, zero failed, 15 allowed, one guarded, 32 gone before their turn. A fresh public clone plus the candidate source installed and packaged successfully. Strict deep signature checks passed for the packaged and extracted zip apps; both passed the real-app smoke. The DMG mounted read-only, and the actual Help › Open the Demo command opened three sample projects under disposable storage while the parent test store remained empty. All used fake homes and stand-ins.

Alpha.6 assets: DMG 161,169,654 bytes, SHA-256 `bf71e3c1e6a55ce0c33ea628da250f00c8f3387575ec326273b36da9a3048719`; zip 142,900,333 bytes, SHA-256 `043fb5d5a4977ce4d4ea4498ce9f60978b4b70d8f1a289b49706a63bd7c5de93`. Ad-hoc signed, not notarized. The full audit remains ongoing; the resource, retention, coverage and CI limits above remain open.


## Alpha.6 publication and delta review

Commit `71aef2d5db96b553e015e4e07b28b6921265685e` was pushed to `codex-review` and `main`, and the tested assets were published at `v2.0.0-alpha.6`. A fresh public DMG download matched the SHA-256 above. Gitleaks scanned all 177 commits without finding a leak. Website commit `07ab6eb` deployed the alpha.6 download, checksum and fixes together; 21 unit checks, typecheck, build, both-theme desktop/phone browser checks and 320/560/768px navigation checks passed. Earlier releases now fold together behind a native keyboard-accessible disclosure, preventing release history from growing the initial page indefinitely. Before/after screenshots were inspected. Public HTML verified the new download, checksum and notes after deployment. Historical release copy was also corrected to disclose normal GitHub connection metadata.

### Standards

The independent pinned `ab39a30...71aef2d` review demonstrated zero new documented-standard or justified smell findings. The actual-undo and successful-Retry regressions resolve the earlier proof gaps and satisfy CONTRIBUTING's “Prove the outcome.” No migration edits or privilege changes were introduced.

### Spec

The independent reviewer demonstrated zero additional findings in that delta and reran the changed client/server and Markdown files: 16 tests passed, including the formerly quadratic divider in about 83 ms. This covers that delta only; resource and retention work continues.

### P3 — stale README release links

`README.md:15,34` still selected alpha.4 after alpha.6 publication, so following Try it installed an older version than the website. The commit adding this subsection updates both links and adds `main/release-links.test.ts`, observed failing against the old download URL and passing after correction. Source and download must match the package version. The already published alpha.6 tag remains immutable; its README retains the old links, while current main and subsequent releases carry this correction.


## Batch 5 — draft revisions and bounded socket lines

Baseline: `14ad5fc198ab36545cbd6777f61a35e02d99af43`. Fixes are in the commit adding this section; the next packaged release is still under verification.

| Severity | Location | Reproduction and correction | Failing regression and outcome |
|---|---|---|---|
| P2 | `src/renderer/src/lib/draft.ts:4`, `views/CardDrawer.tsx`, `views/SessionView.tsx`, `components/Chat.tsx` | Submit a draft, edit it away and back to its original text while the send waits, then complete the send. The equality check erased newly authored text. A shared draft hook now clears only the unchanged revision that was submitted. | `ui-regressions.mjs`: comment/criterion/session/chat-retyped-draft, each observed failing before correction in both themes. Existing different-text draft and duplicate-comment cases also pass. |
| P2 | `src/client/client.ts:40`, `src/core/server.ts:96`, `src/shared/line-reader.ts:3` | Send an oversized unfinished authentication line. The client had no line bound; the core allowed its full authenticated-message limit before knowing a caller. Both now reject above 4,096 characters before authentication. Subsequent core lines retain session/owner limits of 4/32 Mi characters, and client replies are capped at 32 Mi characters. Fragmented input is scanned once as it arrives and joined only at a newline. | `client.test.ts` and `server.test.ts` unfinished-handshake regressions reject promptly; `line-reader.test.ts` verifies fragments, multiple lines, limit changes, early stop and 100,000 single-character fragments. These are character limits, not byte limits. |
| P2 | `src/core/server.ts:132` | Keep handlers pending and submit 256 calls on one connection. All previously entered at once. The core now admits at most 128 active requests per connection and explicitly refuses the rest. | `server.test.ts`: one connection cannot queue an unbounded number of active core requests; old implementation admitted 256, correction admits 128, refuses 128, and accepts a later request after completion. |
| P3 | `scripts/ui-crawl-target.mjs:5` | Discover and mark a control, then replace its DOM node before the crawler clicks. The old marker locator timed out despite an equivalent visible control remaining. The crawler now resolves the current control by its observed signature on each Playwright retry. | `ui-regressions.mjs`: crawl-target-survives-replacement, both themes; old marker lookup timed out, replacement receives exactly one click. This reproduces a lost-target mechanism, not the proven cause of every prior CI timeout. |

The crawler's page helpers moved unchanged into `scripts/ui-crawl-page.mjs`; the crawler fell to about 1,100 lines. Failed clicks now retain the full bounded action log, current target count and screenshot filename. Timeouts and allowlists were not broadened.

Verification on the frozen batch: typecheck and all 587 unit tests passed; the UI sweep and 32 browser regressions passed. The complete crawl covered 79 surfaces, 2,094 controls, 51 shortcuts, 29 checks and 2,036 actions: 2,128 passed, zero failed, 15 allowed, one guarded and 30 gone before their turn. Real-app smoke passed. The separately added README-link regression had already passed on main. Original video edits were preserved by hash-checked transfer. Both batch 3 GitHub runs (`37707125322`, `37707125384`) passed; newer CI remains pending at this recording.

Global request/connection budgets, authentication deadlines and stalled-reader output limits have separate reproduced corrections under verification in the next batch. Cumulative data retention, further hook-parser/resource cases and the complete updated feature matrix remain open.

## Batch 6 — alpha.7: sessions, resource limits and truthful failures

Baseline: `3208321dc5cce8359301d692c302a783705b10c6`. The fixes below are in the commit introducing this section and the alpha.7 tag. The production candidate was frozen before verification; subsequent History/Jev work remains separate. No shipped migration was changed.

| Severity | Location in this batch | Reproduction and correction | Failing-before/passing-after evidence |
|---|---|---|---|
| P2 | `src/core/git-commands.ts:74,83`, `src/core/git-client.ts:264` | Fail a commit-count, published-history or stash-list read. The old helpers treated failure as zero or an empty list, allowing misleading or unsafe subsequent decisions. Failures and malformed counts now refuse; actual refs, index and working bytes are preserved. | Five cases in `git-read-failures.test.ts`; successful retry sees the real incoming commit/published ref/stash. |
| P2 | `src/core/server.ts:20,81,90,155` | Open many sockets, distribute held RPCs over them, or stop consuming streamed events. Per-connection input limits did not limit total work or outgoing queues. There are now 256 connections, 512 active requests globally, and a 64-MiB outgoing queue limit per socket, with recovery after clients leave. | `server-limits.test.ts`: idle connections, shared request budget, stalled output reader; original connection-local 128-request case retained. |
| P2 | `src/core/server.ts:101,214` | Keep an unauthenticated main/hook socket alive by slowly dripping bytes. Activity-based timeouts can retain every connection slot. Both handshakes now have an absolute five-second deadline. | Main authentication and dripping-hook tests in `server-limits.test.ts`; the follow-up hook reproduction held all 256 slots past six seconds before the fix. |
| P2 | `src/core/sessions.ts:315` | Resume a conversation after its old card worktree disappeared and cannot be reconstructed for the same card. It previously fell back to the main checkout. It now refuses rather than moving the conversation to a different folder. | `session-safety.test.ts`: removed worktree; asserts no replacement session and no redirected checkout. |
| P2 | `src/core/sessions.ts:290,861` | Hold asynchronous preparation, begin core shutdown, then release it. A late child could appear after the shutdown snapshot. Admission and asynchronous continuations now refuse once shutdown starts. | `session-safety.test.ts`: shutdown during preparation; asserts persisted state and no late child. |
| P2 | `src/core/sessions.ts:439` | Fail scrollback construction or the session PID database write. The former happened after PTY spawn, and the latter escaped cleanup. Scrollback is prepared before spawning; subsequent failure terminates the child and records a failed session. | Two cases in `session-safety.test.ts`, including actual PID liveness after a one-shot write failure. |
| P2 | `src/renderer/src/components/Terminal.tsx:187` | Delay the first terminal replay, focus the composer and type. Replay previously stole focus and subsequent typing reached the PTY. It now takes initial focus only while the document body is active. | Both-theme `terminal-late-replay-keeps-composer-focus` checks exact draft text and zero PTY input; `terminal-late-replay-initial-focus` preserves initial focus. |
| P2 | `src/renderer/src/views/SessionView.tsx:39,137` | Reject checkpoint history after data was cached. Stale undo state remained usable or failure looked empty. The timeline now reports the read error and Retry; stale checkpoint actions are hidden. | Both-theme `checkpoint-read-error` clicks Retry and verifies actual recovery. |
| P2 | `src/renderer/src/styles/base.css:40` | Tab to primary buttons or selected radios. Their own box shadows overrode the shared focus shadow. A separate two-pixel outline now remains visible in both themes. | Both-theme `keyboard-focus-visible`; six screenshots independently inspected. A transparent-outline mutation is rejected in all six cases. |
| P3 | `src/renderer/src/components/ui.tsx:73` | Focus a segmented radio and press an arrow/Home/End. Selection did not move. Roving tab focus and standard wraparound selection now work. | Both-theme `segmented-keyboard`; independently rebuilt 960×700 proof also passed. |
| P3 | `src/renderer/src/components/Jev.tsx`, `ViewBoundary.tsx`, `views/SettingsView.tsx`, `shell/Rail.tsx`, `README.md` | Read the Jev payload/cost, crash and update explanations. They overstated measured latency, cost, core health, network privacy or automatic installation. Copy now describes estimated reported usage, actual payload, unknown core state and manual installation with ordinary connection metadata. | Both-theme `jev-estimated-cost`, `crash-does-not-claim-core-health`, `update-disclosure`; README truth regression. |
| P2 (test reliability) | `scripts/ui-crawl-page.mjs`, `scripts/ui-crawl-target.mjs`, `scripts/ui-crawl.mjs` | Replace a React subtree or delete an earlier identical neighbor between discovery, marking and clicking. The crawler could keep a dead node or click a different live control. It now retains exact identity plus observation, accepts only an unambiguous replacement, and refuses an old sibling or ambiguous target. | Both-theme replacement, removed-neighbor/target, pre-mark shift, old-sibling, ambiguity and reload cases. Two independent review reproductions drove the follow-up corrections. |
| P3 (test reliability) | `scripts/ui-harness.mjs:27`, `src/shared/line-reader.test.ts`, `src/core/attachments.test.ts:139` | A readiness fragment without a newline could be accepted; failed startup leaked a timer/process; the parser performance test did not measure scanning; the image test relied on a narrow timing window. Readiness now waits for a complete line and cleans up every failure; scan work is counted; explicit first/second-image gates prove ordering. | Five `ui-harness.test.ts` cases; old line-scanning mutant fails; bypassing image waiting fails the strengthened attachment test. Separate image fallback-timeout coverage remains. |

The same release includes the already committed batch 5 draft-revision and line-framing fixes. Crawler success remains broad smoke evidence, not proof of the semantics of every label.

### Independent review of this batch

Standards independently reran the Git/resource regressions and observed nine old-code failures and nine corrected passes. Later session/README checks passed six cases. It identified the focus oracle's transparent-outline loophole; the strengthened assertion now passes six real cases and rejects six invisible variants.

Spec reproduced the slow-hook connection leak and both crawler identity mistakes before their follow-up fixes. Its final session/resume/Git-admission selection passed 13 tests. A separate rebuild verified both-theme keyboard focus and radio arrow behavior at 960×700. An earlier browser artifact predated the radio edit, so that stale result was discarded and the rebuilt proof retained. Neither review called the whole audit complete.

### Verification record

The initial sixth run was interrupted, the seventh was deliberately stopped when a new crawler proof flaw was found, and the eighth failed a real terminal-focus race. The ninth run passed 607/608 units but exposed the timing-dependent attachment fixture. The tenth passed all 608 units and then failed the stale sweep assertion requiring an unimplemented updater promise. The twelfth's first run timed out starting the null-protocol subprocess during a simultaneous native demo check. Its next repeat passed all 608 units, the full sweep and all targeted browser checks, then timed out starting a later crawler gateway. These are retained failures, not counted as complete passes. No timeout was increased or failure added to an allowlist. The final complete repeat exited successfully: typecheck, 608/608 units, the full UI sweep, 60 targeted browser checks and crawler. The crawl visited 79 surfaces, 1,725 controls, 51 shortcut keys and 29 checks; it took 1,366 actions, with 1,425 passes, zero failures, 11 allowed, one guarded and 368 unreached controls. The higher unreached count reflects the stricter identity rule: a missing or ambiguous control is no longer credited with a neighboring control’s action. Those 368 are a coverage gap, not successful clicks. Both GitHub runs for the batch-5 baseline (`37711013095`, `37711013017`) also passed.

The final `npm run smoke:app` source-app check also passed. The packaged app and independently extracted zip passed strict deep signature validation and the full real-app smoke: bridge, real shell/CLI, menus, native keep-awake, update consent/menu/download, quit confirmation, surviving core, startup refusal and Retry. The final DMG mounted read-only. Its actual Help › Open the Demo command opened Fieldnotes, Northstar Storefront and Orbit API under temporary storage, while its parent test store stayed empty. The first simultaneous demo check timed out; the isolated repeat passed. These runs never opened either protected Wanigan data store.

Final alpha.7 artifacts: DMG **161,174,400 bytes**, SHA-256 `129fd0a04f19100af2ad7a4ab42231068f5098f9b8a547233c7f431c68f1fe66`; zip **142,901,209 bytes**, SHA-256 `463143f5d75bc61f98938e965e6901d5ab6c77d0e009ee2ace66374285c46720`. Ad-hoc signed, not notarized. Minimum declared macOS is 13; testing here was on macOS 26.5, Apple silicon.

### Fresh public source installation

A new public clone of `v2.0.0-alpha.6` used its own dependencies, `nvm install`, `npm install`, and the README workflow. Full `npm test` passed: 581 units, sweep, regressions, and crawler (2,129 passed, zero failed, 15 allowed, one guarded, 32 gone). The actual `npm run dev` rendered its real Electron window, served the font assets and answered through the bridge with an empty temporary store. Forced cleanup of the development process group logged a disposed-render-frame shutdown error after these assertions; it is retained as cleanup evidence. The README packaging command also completed, creating its app and zip, and the fresh packaged app passed strict deep signature validation. The immutable alpha.6 README still named alpha.4, so the selected clone tag followed corrected main; alpha.7's README and source-tag regression name alpha.7.

### Open findings discovered during follow-up

The [213-row feature proof addendum](current-feature-proof.md) accounts for all 39 changed/added rows relative to the original 192-row audit, rather than treating matching test names as evidence. Twenty delta rows are supported within their fixtures, 14 are partial, four manual and one contradicted. The unbounded History scan claim is corrected in this release's README/matrix, with these separately reproduced issues still open in alpha.7:

- P2, `src/core/history.ts:242–255,306–314`: requesting one result summarizes/caches all 600 fabricated transcripts; Codex rows and retained caches are unbounded.
- P2, `src/core/history.ts:229–237`: two projects with the same conversation UUID cause read/resume from the first to select the newer copy in the second.
- P2, `src/core/history.ts:302–314`: an existing corrupt Codex index returns an empty list; the UI says no conversation has run.
- P2, `src/core/history.ts:286`: lexical rollout containment accepts `../` and symlink escapes; both return an outside-account fixture's text.
- P2, `src/core/history.ts:448–454`: a single 2,000-block line returns one million characters despite the intended 300,000-character preview budget.
- P2, `src/renderer/src/views/HistoryView.tsx:17,26`: local filtering searches only the loaded 500 conversations; a matching 501st item is found by core search but unreachable through UI search.
- P2, `src/core/git-secrets.ts:128–132`: an incomplete scan acknowledgement is not bound to the staged tree or pushed HEAD. Actual 16-MiB staged and 201-commit local-remote fixtures accepted an old approval after the content changed. The next batch binds approvals to the checked state.
- P2, `src/core/jev.ts:111,117`: successful and error HTTP bodies buffer in full before parsing/clipping. Oversized chunked and Content-Length fixtures reproduce this without contacting a model.

The History/Jev corrections are being tested in a separate next batch and are not falsely attributed to alpha.7. Other outstanding proof gaps include unstaged sentinels in commit/draft fixtures, secret-scan cutoff fixtures, stronger undo refusal cases and remaining Jev edits/queue/candidate fixtures. Cumulative retention and further module splits remain under review. The development dependency advisory, real-provider behavior, clean-machine Gatekeeper, other architectures/operating systems and minimum macOS remain unverified as previously stated.

### Mobile website download correction

The website detected non-Mac user agents and removed its actual download anchor after hydration, leaving only a Copy link control on phones. The new `scripts/check-mobile-download.mjs` failed against the old public site with zero download buttons. Website commit `2fc9ce0` removes that platform gate and its unused code/styles; the platform requirements remain beside the direct DMG link. The current verified alpha.6 download was kept while alpha.7 continued testing.

All 21 website units, typecheck and production build passed. Local and deployed browser checks each passed four cases: iPhone and Android emulation, light and dark, after hydration, visible anchor, exact asset URL, no page overflow and an actual click with fixture download bytes. These are Chromium emulations, not physical-device Safari tests. Cloudflare version `15ef2627-612c-4fe5-bc96-823bd6da36da` is deployed at wanigan.ai. The website has no configured Git remote; its commit is local. The remaining unsupported notarization-roadmap copy is recorded for follow-up.

## Alpha.7 publication, observed during continuation

The release is public at [v2.0.0-alpha.7](https://github.com/DanePete/wanigan-2/releases/tag/v2.0.0-alpha.7), with the tag resolving to `bad59a14806ce6cf82d0af856a004071746ebae9`. Both exact-commit GitHub runs passed: [37718048120](https://github.com/DanePete/wanigan-2/actions/runs/37718048120) and [37718048333](https://github.com/DanePete/wanigan-2/actions/runs/37718048333). Fresh public downloads of both assets matched the final3 files: DMG 161,174,400 bytes / `129fd0a04f19100af2ad7a4ab42231068f5098f9b8a547233c7f431c68f1fe66`; zip 142,901,209 bytes / `463143f5d75bc61f98938e965e6901d5ab6c77d0e009ee2ace66374285c46720`. These are observed publication results, recorded in `/private/tmp/wanigan2-review/alpha7-publication-verified.json`, rather than the handoff's earlier draft state.

Website commit `d914fe3` deployed the alpha.7 download, checksum, source tag and dated fixes together as Cloudflare version `c2d6df63-9983-4159-9260-7a029ddd3b59`; local verification record commit `aa44234` follows it. Twenty-two website units, typecheck, lint (one existing video-worker warning) and build passed. Full local and live site checks and both-theme iPhone/Android download checks passed. Public HTML matches the tested build byte for byte (SHA-256 `3e54cbdcb3d2fd5b30c3d175cffbb010f3f7237feefbec623076753c8b83a5f0`). The website has no Git remote.

Visual inspection caught the newly added Apple Support link displayed as literal Markdown despite a green general browser suite. A rendered-link regression was observed failing; routing the copy through the existing Rich component made it pass in all four mobile cases. Before/after screenshots in both themes were preserved and reviewed. Unsupported notarization/Windows roadmap promises and the guaranteed one-time Gatekeeper wording were removed; [Apple's opening instructions](https://support.apple.com/en-us/102445) are linked without claiming clean-machine verification. Initial sandbox loopback and old preview-runtime compatibility errors remain in the logs; production configuration was not changed for the local override.

## Batch 7 — alpha.8 candidate: History, HTTP bounds and Git consent

Baseline: `bad59a14806ce6cf82d0af856a004071746ebae9`. This section initially assesses the 23-file source manifest `/private/tmp/wanigan2-review/alpha8-code-files.json` in frozen `/private/tmp/wanigan2-review/continued-fourteenth`. **This record accompanies the verified alpha.8 source; remote CI and publication are subsequent gates.** The subsequent implicit-tag/submodule findings below have focused corrections in `/private/tmp/wanigan2-review/alpha8-push-review-candidate`; that candidate adds `src/core/pulls.ts` and `src/core/git-push-scope.test.ts` to the original manifest and changes `git-client.ts`. The corrected full gate subsequently passed in the independent clone `alpha8-source`; all local source/native gates passed as recorded below. Source locations in the main table refer to frozen14; the corrective subsection names its later locations. No shipped migration was changed. The owner's three pre-existing video-file edits remain outside this batch.

| Severity | Location in frozen14 | Reproduction and correction | Test and observed evidence |
|---|---|---|---|
| P2 | `src/shared/http-body.ts:7,14,21`, `src/core/jev.ts:114`, `src/main/updates.ts:136` | Supply an oversized chunked 200, 401 or 429 Jev reply, or a declared length over the cap. The old reader buffered success/error bodies in full. The common reader reserves one bounded buffer, checks each incoming chunk, cancels over-limit streams and refuses oversized declared lengths before pulling. Jev uses 1 MiB; the updater retains its shared 2-MiB pagination budget. | Four `jev-response.test.ts` regressions were observed red, then the 30 Jev/updater tests passed. Stream assertions check cancellation, consumed bytes, failed health and each attempted call; declared-length fixture checks zero pulls. Independent review additionally checked empty/exact-cap bodies and one-byte fragments. This bounds the application's body buffer, not all allocations made by an HTTP transport. |
| P2 | `src/core/history.ts:182` | Two project folders contain the same Claude UUID; the newer copy used to redirect read/resume away from the selected project. Locate now refuses multiple candidates instead of picking one. | `history-safety.test.ts` › "ambiguous conversation copies cannot redirect a History read or resume": selected listing has the original cwd, both operations reject, and no session starts. This fixture covers duplicate folders; the same source guard covers accounts/Codex but those ambiguity variants do not have dedicated assertions. |
| P2 | `src/core/history.ts:251,299` | Corrupt an existing fake Codex SQLite index, or remove access to its account directory. The old path returned empty history. Existing unreadable indexes now report failure; only ENOENT denotes absence, and unsupported required schema also refuses. | Corrupt and inaccessible index regressions reject; restoring access returns the actual empty list. The unsupported-schema branch is source-reviewed but lacks a separate regression fixture. |
| P2 | `src/core/history.ts:240,324` | A Codex thread names `../outside.jsonl` or an in-account symlink to outside-account text. Lexical prefix checks previously accepted both. Resolve requires both lexical and canonical containment before returning the rollout path. | `history-safety.test.ts` creates two temporary escape paths, lists both records and asserts both reads refuse. This correction is specific to Codex; the separately reproduced Claude-link problem remains outside frozen14. |
| P2 | `src/core/history-transcript.ts:163` | One assistant line with 2,000 text blocks returned about one million characters; many tiny blocks also exceeded the intended turn cap. Collection now applies the remaining character budget per block and keeps at most 2,000 newest turns. | The multi-block test asserts a positive result of at most 300,000 characters plus `truncated`; the 8,000-block test asserts exactly turns 6,000–7,999 and `truncated`. Disabling the turn cap fails the mutation check. Parsing/transient allocations and special-file access are separate limits below. |
| P2 | `src/renderer/src/views/HistoryView.tsx:18,22,60` | A matching conversation older than the first 500 appeared in core search but could never be found through the view's local filter. The view now sends the debounced query to core before its result limit, keeps the input mounted, and distinguishes searching, error and empty states. | Both-theme `history-search-beyond-loaded-results` was red then green: the bridge receives the query, an older fixture is rendered, input focus survives, empty results keep the input, and clearing restores 500 rows. The full sweep separately searches seeded real-core data and asserts exactly the coupon row. Error rendering is source-reviewed; this new browser test does not inject an error/retry. |
| P2 | `src/core/git-secrets.ts:133,140,168` | A >16-MiB staged patch or 201-commit push keeps the same incomplete warning while unseen staged work or HEAD changes. The previous digest accepted the old approval. Acknowledgements now include full index object identities/modes/paths and HEAD, or push plan/destination/tracking identities, checked before and after the scan. | Two real-Git `git-secret-limits.test.ts` regressions were red then green: missing/stale approvals refuse, HEAD/index/working sentinel or bare remote remains unchanged, and a fresh approval commits/pushes the exact new work. Review probes additionally cover fingerprint read failure, index mutation during scan and destination-only acknowledgement invalidation. They are supplemental evidence, not yet durable suite coverage. |
| P2 | `src/core/git-client.ts:367,405`, `src/shared/protocol.ts:180`, `src/renderer/src/views/git/Remote.tsx:106` | Show a clean push plan, then change its push URL, remote branch or fetched tracking history without changing HEAD. Previously HEAD-only consent could publish somewhere else. The displayed plan now carries a digest; core re-plans and requires it, including a consistent before/after tracking-ref snapshot. | Three `git-push-destination.test.ts` fixtures assert stale-plan refusal, exact preservation of both bare remotes/no new branch, then successful publication of the exact head after obtaining a fresh plan. Missing/wrong digest is source-enforced; no dedicated malformed-digest fixture was added. Configured implicit tags and submodule recursion receive the separate correction below. |

History parsing moved into `history-transcript.ts` (272 lines), leaving discovery/resume in `history.ts` (342 lines). The removed renderer `matchesHistory` import and unused empty-state CSS no longer duplicate the core filter. This is a coherent boundary between transcript decoding and account/project discovery; it does not claim that History's aggregate work is bounded.

### Verification record and final-release gates

The thirteenth full run failed because the History sweep read rows before its new debounce/core response completed. The assertion now waits for the exact expected real-core coupon row and still compares the exact result; no sleep or deadline was increased. Its failure remains in `continued-full-test-13.log`.

The completed frozen14 log records typecheck, **623/623 units**, the full UI sweep and **62 targeted browser checks**, followed by the complete crawl: **79 surfaces, 1,726 controls, 51 shortcut keys, 29 checks and 1,367 actions; 1,426 passed, zero failed, 11 allowed, one guarded and 368 unreached**. The prior process session no longer exposes its numeric exit status; no exit code is invented here. The last log lines are the successful crawler summary, and the coordinator checked that no process still held the log. These results apply to frozen14, not a later source correction. The 368 unreached controls remain a coverage gap.

Focused proof logs retained under `/private/tmp/wanigan2-review/`: `jev-response-red.log` / `jev-response-green.log`; `history-safety-red.log`, `history-safety-extra-red.log`, `history-safety-extra-green.log` (13 cases), `history-turn-cap-mutant.log`; `history-ui-red.log` / `history-ui-green.log`; `secret-limits-red.log`, `secret-push-limit-red.log`, `secret-limits-both-green.log`; `push-destination-red.log`, `push-tracking-red.log`, `push-tracking-green.log` (five consent cases). `alpha8-review-probes-final.log` records six supporting probes and the successful reproduction of the implicit-tag defect; its seven passing tests are **not** seven fixes. Two later probes verify configured mirror publication refuses without changing refs and explicit refspecs override configured matching/extra-ref defaults.

Before/after History screenshots at 960×700 were copied into this report and visually reviewed in both themes: [dark before](screenshots/alpha8-history-before-dark.png), [dark after](screenshots/alpha8-history-after-dark.png), [light before](screenshots/alpha8-history-before-light.png), [light after](screenshots/alpha8-history-after-light.png). They show the older matching conversation becoming reachable while the search input remains present.

| Required final alpha.8 evidence | State |
|---|---|
| Corrected source snapshot and exact commit | Independent public clone `alpha8-source` holds the corrected 25-file manifest, with all hashes unchanged after the full gate and packaging. The commit enclosing this record is transferred only after original baseline and owner-edit hash checks. |
| Full gate against that corrected source | **Passed, exit 0**: typecheck, 627/627 units, full UI sweep, 62 targeted browser checks; crawler: 79 surfaces, 1,729 controls, 51 shortcut keys, 29 checks, 1,366 actions, 1,425 passes, zero failures, 11 allowed, one guarded and 372 unreached. `alpha8-corrected-full-test.log` and its numeric exit sentinel record this corrected-source run. The unreached controls remain a coverage gap. |
| Independent dependencies/source install and source app smoke | Public alpha.7 clone plus the hash-verified corrected candidate installed with its own dependencies via README `nvm install` and `npm install`; the literal README `npm run dev` launch and real Electron source smoke both passed, exit 0. The development screenshot was visually reviewed. npm normalized only better-sqlite3 hasInstallScript metadata, which was restored to the reviewed lock bytes; dependency versions did not change. |
| App and extracted-zip strict signatures/smokes; read-only DMG mount and actual isolated Help Demo | **Passed, exit 0.** Actual `npm run dist:mac -- --out …` completed, including its final native rebuild. App and independently extracted zip passed strict deep signature verification and real Electron smokes. The read-only mounted DMG passed provenance/signature checks; its shipped Help → Open the Demo action opened a second isolated app, created three temporary demo projects and a stand-in session, and left the parent store empty. Its screenshot was visually reviewed and the known mount detached. Signatures are ad-hoc, not notarization. |
| Artifact byte identity, sizes/SHA-256 | All three packaged copies match the complete 99-file production output and version. Their ASAR SHA-256 is `7e81035dc3f2f03a030ddb6df8810967188c20478451fcc8d192899435a2322d`. DMG: 161,174,420 bytes, SHA-256 `cb3fbeb4262b9cb01c63c7c62ddecbba31d0b594ce7390ddba82ac66ff6fa3bd`. Zip: 142,900,341 bytes, SHA-256 `5d71dcc2242ae54ce03935d033f62efa7ad849a3024af3829a37d80c0320b4f4`. Transfer/diff/commit scan records are recorded outside the commit before push. |
| Exact-commit CI on both branches; public tag/download hash verification; website | **Pending** for alpha.8 |

The final staged diff check found one extra blank line at the end of the newly added transcript reader. Exactly one trailing newline byte was removed after the full gate. A fresh production rebuild matched all 99 packaged output files byte for byte (`alpha8-eof-cleanup-provenance.json`); the original tested source hashes and whitespace diagnostic remain recorded. This cleanup does not change an executable statement.

### Publication blocker found and corrected during the alpha.8 review

**P1 — configured submodule recursion publishes outside the approved repository.** Frozen14 `src/core/git-client.ts:412` and `src/core/pulls.ts:83` inherit `push.recurseSubmodules=on-demand`. A parent branch can point at an unpublished dependency commit; approving the parent push then also sends that private dependency work to the dependency's separate remote. The four-case regression below reproduces the actual extra publication through both push paths. No external remote or real secret was used.

**P2 — repository configuration publishes unreviewed annotated tags.** At frozen14 `src/core/git-client.ts:412`, `git push` still inherits `push.followTags=true`. In an isolated repository, obtain a clean plan, enable follow-tags, add an annotated tag and request that unchanged plan. Its digest remains unchanged, its secret scan is clean, and the remote receives the annotation although the plan listed only a branch. `/private/tmp/wanigan2-review/alpha8-review-probes.test.ts` asserts the remote tag's actual contents. The direct card-PR push path shared the behavior. The four actual-Git regressions cover both implicit tags and `push.recurseSubmodules=on-demand` sending a private dependency commit to a second bare remote, through either publisher. These were observed failing on the old code in `alpha8-push-scope-red-unsandboxed.log`.

The corrected candidate explicitly passes `--no-follow-tags --recurse-submodules=no` at `src/core/git-client.ts:413` and `src/core/pulls.ts:84`. `src/core/git-push-scope.test.ts` covers workbench/card-PR × annotated-tag/submodule-commit cases. Each asserts the approved branch reaches the exact head, a pre-existing remote tag remains unchanged, a new tag remains local, and the dependency remote stays at its prior head while local dependency work remains intact. Card-PR cases use a temporary stand-in `gh`; they exercise that direct push function, not a new real-GitHub/approval proof. The four scope cases and seven existing destination/secret/PR cases passed together (11/11, `alpha8-push-scope-green.log`). Typecheck and the separately rerun no-force-push regression also passed in the recorded focused checks. No arbitrary hook sandbox is claimed. The corrected full gate passed as recorded above; native artifact checks passed as recorded above; exact-commit CI and publication remain subsequent gates.

### Remaining audit work and limits

- **P2, total History work/storage:** `history.ts:195,213,251` still enumerates matching Claude files, retains summaries without eviction, and reads/caches all Codex user-thread rows before filtering. The earlier 600-files/limit-one proof still applies. Response text caps do not solve total discovery, metadata size or retained-cache growth.
- **P2, next-batch History corrections:** frozen14 `history.ts:204` still follows outside-account Claude file/ancestor links. At `history-transcript.ts:202`, synchronous opens can block on an in-account FIFO; at `:210`, newline-free input repeatedly copies the growing carry. These are now confirmed, with corrections only in `continued-fifteenth`, outside alpha.8. FIFO regressions failed three cases before correction; the 21-case focused History run then passed, including an actual `history.read` refusal followed by responsive `core.hello`. The reverse-reader probe copied 45,088,812 bytes for 8,388,652 bytes of input; the fragment-list correction passed its focused 24-case run and four boundary cases. Independent review and the next batch's full gate remain pending. Per-read output caps must not be described as a total I/O/time bound.
- **P2, next-batch hook parsing:** frozen14 `server.ts:212` repeatedly copies/decodes/parses the growing body. A 16,497-byte real-socket input in 258 fragments caused 2,138,289 copied bytes and 258 parse attempts. The separate incremental reader delivered the same input/reply with 45,189 copied bytes, exactly 16,497 scanned bytes and one parse. Seven helper/socket cases and two existing delayed-body/deadline cases pass; the actual unchanged relay receives its reply without sender EOF. Legacy malformed-body fallback, scalar/array behavior and the full connection byte cap are preserved. This focused correction still needs the next batch's full verification.
- **P2, server output accounting:** the configured 64-MiB queued-output threshold uses Node socket `writableLength` while writing strings. On Node 22, queued strings are counted in UTF-16 code units rather than UTF-8 bytes, so multibyte output can exceed the claimed byte budget. The paused-reader ASCII fixture does not prove a strict UTF-8 byte cap. Client admission work is separate; this server issue remains open.
- **P2, next-batch client cleanup:** `client.ts:97–98` registers requests before serialization, retaining rejected closures; write failures and blocked-output close/EOF can leave transport or requests alive. Five actual-socket regressions failed before the separate fix and 11 new/existing cases pass afterward. A serialization refusal still permits a later valid RPC. Pending requests and outgoing data have no admission budget while the connection remains open; cleanup fixes do not resolve that limit.
- **P2, next-batch Jev accounting:** `jev.ts:120` accepts coerced, negative or extreme usage and maps absent usage to zero. Separate correction accepts only numeric nonnegative safe integers, preserves unknown totals alongside a reported subtotal, and adds migration 19 without changing the 18 shipped migration strings. Legacy rows/aggregates are preserved without claiming their usage was validated. Sixteen failing cases preceded the final 49-case focused pass; renderer checks, screenshots and the next full gate remain pending. None of this usage correction is included in alpha.8.
- **P2, next-batch commit-message reads:** `stagedDiff` ignores failed/partial Git reads, allowing a draft call with incomplete input or a false “Nothing staged” result. The separately reproduced correction is in the following working batch; alpha.8 retains this issue. Focused evidence does not yet establish the next batch’s full verification.
- **Git external-writer race:** app queues do not exclude an external Git command or a hook changing the mutable index/ref/config after the final check. The final operation still uses a named remote and branch. Plan/fingerprint checks shrink stale-consent windows; they do not establish an OS lock or immutable publication. Repeated push-plan/ref reads also remain bounded but inefficient.
- **Proof qualifications:** [the alpha.8 addendum](alpha8-feature-proof.md) reviews the eight alpha.7 additions and this candidate's delta by assertion. Alpha.7's checkpoint error test proves first-read failure and successful Retry, not cached-success-then-error or disappearance of stale Undo/Redo actions. Historical claims remain preserved, with this qualification taking precedence. Separate next-batch staged-only commit/draft sentinel tests and actual Undo-refusal state comparisons now pass; two scope mutants and two of three action-guard bypass mutants are rejected (missing-object refusal is unaffected). These later proofs do not retroactively expand alpha.8's fixture coverage.
- **Other ongoing work:** cumulative evidence/attachment/checkpoint retention, long modules, remaining Jev mutation/queue/candidate fixtures, alternate account forms and oversized skill text remain open. No automatic deletion policy was introduced. The eight moderate development advisories remain open. Real model/sign-in/billing/provider resume, clean-machine Gatekeeper, macOS 13 and other platforms remain unverified. Jev's latency measurement still ends at headers, not full body consumption.

The next-batch observations above are focused evidence, not full-gate or publication claims. Logs and reproduction reports remain under `/private/tmp/wanigan2-review/`, including `history-fifo-red.log`, `history-fifo-green.log`, `history-linear-red.log`, `history-linear-green.log`, `history-linear-boundaries.log`, `hook-framing-audit.md`, `client-send-failure-review.md` and `jev-usage-focused-green-final.log`.

All work in this continuation uses source, fake homes, temporary repositories and stand-ins. Neither protected Wanigan application-data directory, the owner's live app/session processes, nor a real model was accessed. This is another audit batch, not the end of the audit.

## Batch 8 — alpha.10 integration: bounded retention, transport and decision evidence

**Integrated candidate, not a release-readiness or completed-audit claim.** This section preserves the published alpha.9 report prefix exactly: 66,662 bytes from commit `24645d226703f0665c77e90c7fd06f494b62a733`. That public release includes Phone, Gemini and local models and descends from audit alpha.8 `4967fbefe3c27d42b3c0596811cf83c5ab9c6f50`. The earlier locally tested directory called `alpha9-source` was a separate unpublished audit candidate; it is not the public alpha.9 release.

The independent `alpha10-integration` combines the 35-path audit candidate with seven later History paths (41 unique selected paths), three narrowly reviewed test-isolation/smoke paths, four reviewed Phone request/lifecycle paths, three Phone input paths and one corrected crawler assertion. The current source manifest selects **52 paths: 28 modified public files and 24 new files**; all **497 unselected public files** remain byte-identical. This documentation is prepared separately and does not edit the running source. The [alpha.10 proof delta](alpha10-feature-proof.md) assesses 21 changed/added keys: 19 changed rows and two new rows, **252 total with 231 unchanged**. All 27 public Models/Gemini/Phone rows are retained: 22 exact and five Phone rows updated for account/revocation wording and request/disable/notification/input behavior.

### Observed alpha.8 publication and website continuation

The historical alpha.8 CI/publication placeholder above is now superseded: [main CI](https://github.com/DanePete/wanigan-2/actions/runs/37726154081) and [review CI](https://github.com/DanePete/wanigan-2/actions/runs/37726154123) both completed successfully for the exact commit, followed by observed publication: the prerelease tag points exactly to `4967fbefe3c27d42b3c0596811cf83c5ab9c6f50`, was not made latest, and both fresh public assets match the recorded verified DMG/zip sizes and hashes. Root's `alpha8-publication-verified.json` records publication at `2026-10-08T05:08:33Z`. The newer public alpha.9 release remains current; its [main CI](https://github.com/DanePete/wanigan-2/actions/runs/37730190829) also completed successfully at exact `24645d226703f0665c77e90c7fd06f494b62a733`. This is not alpha.10 CI.

The website archive update was based on its current alpha.9 commit, not the superseded older alpha.8 website candidate. Commit `b0c66ca711af84510b86457d36a17949b250e53d` deployed as Cloudflare `ac9a085c-38d0-4e1e-93e0-574298e49485`; the public HTML exactly matched the tested 212,990-byte artifact. Production verification passed **373 website checks, four mobile download-route checks, four archive checks, and both exact video hash/range checks**, with numeric zero exits. Both-theme live screenshots were inspected. Alpha.8 appears under Earlier releases before alpha.7; alpha.9's download URL, checksum, size and newer feature content are unchanged. The later website documentation-only commit `7be5331` records that observed live proof. The mobile clicks used fixture DMG bytes; real public alpha.8 artifact hashes were verified separately. These website checks do not independently verify Phone/Gemini/local-model application behavior.

### Component corrections and their actual evidence

The table records earlier focused component outcomes, not fresh alpha.10 passes. The integrated source carries those corrections, but its dependency tree, new public features, migration positions, fixtures and environment differ. Counts overlap and must not be added together as a synthetic full-suite result. Before-state failures and mutants are retained with their original scope.

| Severity | Location | Reproduction and bounded correction | Observed proof |
|---|---|---|---|
| P2 | `src/core/history.ts:337`, `src/core/history-transcript.ts:58,202` | An outside-account Claude file or ancestor link exposed text; an in-account Codex FIFO or transcript replaced by a FIFO could block synchronous reading. Discovery now requires canonical account containment. Readers open nonblocking without following the final link, then require a regular-file descriptor. | Two Claude-link cases and three special-file cases failed before correction. The 21-case History run passed afterward, including actual `history.read` refusal followed by responsive `core.hello` and no session creation. This is not a guarantee against all concurrent ancestor-path replacement. |
| P2 | `src/core/history-transcript.ts:202,272` | Reading an 8,388,652-byte newline-free JSON line copied 45,088,812 bytes and repeatedly searched the growing suffix. Reverse reading now retains fragments, scans only each new chunk and joins a complete line once. | The copy-count regression failed before correction; 24 focused History cases and all four final streaming boundary cases passed. Exact text, split UTF-8, empty/final lines and byte-budget behavior are asserted. Independent comparison passed 843 deterministic budget/callback cases across 25 fixtures. Parser expansion, aggregate discovery and caches remain separate limits. |
| P2 | `src/client/client.ts:102` | Cyclic/throwing serialization retained pending entries; synchronous/callback writes and EOF/close with blocked output could leave requests or transport alive. Serialization now precedes registration; write failures and EOF reject/clear shared pending work and destroy the socket. | Five actual-socket cases were red, then all 11 new/existing client cases passed. Assertions cover zero retained entries, explicit later disconnection, one close notification, actually blocked output and successful valid RPC after a local serialization refusal. The integrated source also includes the separate admission correction below. |
| P2 | `src/client/client.ts:104–121` | An actual nonreplying peer retained 4,096 pending calls; a paused peer also revealed UTF-16 units counted as queued bytes. The client now refuses unsent requests above 128 pending calls, role-specific body limits (32 Mi UTF-16 units for owners / 4 Mi for sessions), or a 64-MiB UTF-8 queue. Checks before/after serialization cover reentry; Buffer writes keep byte accounting consistent. | Seven of nine new admission tests failed before correction; the 20-case admission/cleanup/protocol run passes. Real sockets prove preserved accepted IDs/results, no partial/refused frames or retries, exact role boundaries, actual multibyte counting and later recovery. The exact 64-MiB edge overrides `writableLength` on a real paused socket; maximum-attachment fit is size arithmetic, not a 64-MiB soak or new attachment end-to-end proof. |
| P2 | `src/core/server.ts:91–98` | The output guard added candidate UTF-8 bytes to a backlog measured as string code units. A broadcast queue reported 1,048,646 units for 3,145,798 encoded bytes; terminal and RPC replies shared the mismatch. The common main-protocol writer now writes UTF-8 Buffers, preserving the nominal 64-MiB limit and disconnect-only-the-stalled-socket policy. | Three measured-byte cases failed before correction. Five new output cases plus the 20 client neighbors pass (25/25), and five existing server admission/authentication neighbors pass separately. Exact cap and one-byte excess use an injected queue edge on real paused sockets; callbacks, drain, other-owner responsiveness and replacement connections are asserted. Hook reply output, transient serialization and total process memory remain outside this bound. |
| P2 | `src/shared/hook-reader.ts:83`, `src/core/server.ts:210` | A 16,497-byte hook frame arriving in 258 fragments caused 2,138,289 copied bytes and 258 JSON parses. Incremental completion scanning with a capped geometric buffer reduces this to 45,189 copied bytes, exactly 16,497 scanned bytes and one parse. | The old performance assertion failed; seven helper/socket tests and two existing relay/deadline cases pass. Actual unchanged `relay.sh` receives a reply before sender EOF. Exact total connection cap, including post-reply bytes, is retained; removing that counter fails its regression. Legacy malformed-EOF fallback, scalar/array acceptance and per-chunk numeric completion remain unchanged. |
| P2 | `src/core/jev.ts:156,293`, `src/core/db.ts:348`, `src/shared/jev.ts`, `src/renderer/src/components/Jev.tsx` | Coerced, negative, fractional, extreme or absent token usage became misleading cost, including false zero. Only numeric nonnegative safe integers now count as reported usage. Unknown successful calls keep the total unknown while retaining an estimated known subtotal. | Sixteen pre-fix failures preceded 49 focused passes. Tests cover explicit known zero, no extra HTTP attempt for bad usage, 5,000-row pruning/reopen/day rollover, large sums and legacy upgrade preservation. The historical component fixture appended its then-unshipped migration 19. In alpha.10 the same SQL is migration 21, after the exact 20 shipped public strings; the strengthened 20→21 fixture and new full gate must be read separately. Legacy successful rows/pruned aggregates remain unknown, without relabeling old estimates as measured usage. Both-theme unknown/partial-cost browser checks now pass in Settings and the board; the four before-state cases failed. The UI uses controlled status replies, not real provider billing. |
| P2 | `src/shared/jev.ts:99–146` | Finite confidence 1.01 or 2 could auto-accept an actual Inbox card; negative action/duplicate probabilities were retained and an invalid high duplicate score could mask a valid candidate. All probability fields now require finite numeric values in inclusive [0, 1], with independent accept/duplicate guards for legacy values. Severity keeps its separate 0–3 clamp. | Final pre-fix run: 11 failures / 16 passes, including real Ready outcomes for 1.01 and 2. The corrected 56-case run passes: 27 new probability/card cases, 16 usage cases, six shared Jev cases and seven owner-change/candidate/queue neighbors. Nine local-HTTP cases compare actual card/activity outcomes, exactly one request, one known usage row, unchanged estimated accounting and zero errors. No retries, probability renormalization, sum-to-one contract or historical-card rewrite was added. |
| P2 | `src/core/git-client.ts:250`, `src/core/git.ts` | Failed/partial staged patch or name reads could start a paid draft with incomplete input or falsely report nothing staged. Drafting now refuses unsuccessful reads, except an explicitly identified stdout-buffer prefix with the existing cut notice. Stderr overflow cannot authorize that exception. | Six failures and one valid-large-diff pass before correction; final eight cases pass on Node 22.23.2 and Electron Node. No stand-in model call occurs on failure; exact HEAD/refs/index/working bytes survive and a valid staged-only retry succeeds. Actual stdout overflow still drafts. A short real Git deadline verifies classification; the draft outcome exercises termination rather than waiting the default 30 seconds. |
| P2 | `src/renderer/src/views/TurnChanges.tsx:164` | After an actual checkpoint diff was cached, a failed read triggered by a reconnect notification showed an error while the Undo confirmation remained enabled. The button now also refuses while that read has an error. | The dialog case failed in both themes before correction and now passes: exact cached files are seeded, failure disables confirmation, a direct button click sends no Undo/Redo RPC, and a successful re-read restores the same diff and enabled action. The reconnect notification is controlled through the bridge subscription; no native transport reconnection is claimed. |


| Severity | Location | Reproduction and bounded correction | Observed component proof |
|---|---|---|---|
| P2 | `src/core/readonly-db.ts:15,48` | A main Codex index or its WAL replaced by a FIFO blocked synchronous copying. Sources now open read-only/nonblocking, must be regular by descriptor, and copy from that held descriptor through a 64-KiB buffer into exclusive 0600 scratch files. Initial size bounds each copy; partial I/O advances, errors/early EOF/zero writes refuse, descriptors close and scratch cleanup remains. | Twentieth: 11 focused cases plus one neighbor pass, including actual-core FIFO refusal followed by a responsive owner call, live WAL data, source preservation and successful retries. Only two FIFO watchdog cases reproduce the old blocking defect; other descriptor/I/O seam failures establish sensitivity. A separate path-reopen mutant fails both swap cases. No atomic DB/WAL snapshot, total I/O/disk bound or APFS clone is claimed. |
| P2 | `src/core/history.ts:75,76`, `src/core/history-cache.ts:8` | Repeated discovery retained every summary and index row. Retention now uses LRU budgets: 512 summaries / 2 MiB accounted payload; eight Codex indexes / 4,096 aggregate rows / 8 MiB. Oversized or unknown values bypass caching without truncating the fresh result. | Twentyfirst: 40 focused cases pass, including 12 cache outcomes, five helpers, eight account/schema cases and 15 neighbors. On the old code the final 12 cache fixtures have seven retention failures/five semantic passes. Independent review passed 100,000 helper operations and six payload cases. The combined seven-path History source later passed 51/51 under Electron Node and both typechecks; this remains a focused earlier-source result. |
| P2 | `src/core/phone/gateway.ts:95–108` | URL parsing outside the catch left malformed `//[` requests unanswered and logged an unhandled `ERR_INVALID_URL`; owner/HTTP neighbors remained responsive under the production rejection policy. Parsing now occurs within controlled error handling. | One genuine request red becomes a controlled HTTP 400/invalid without an unhandled event; mounted authentication, Host/pathname and owner neighbors still work. This is not a production-crash or every-parser-form claim. |
| P2 | `src/core/phone/phone.ts:110–117` | Off deleted enabled intent but waited for external unmount while paired HTTP/SSE could still create and announce a card. Local connections now close and the owner hears the local state before that wait. | Two genuine delayed/nonzero/rejected-unmount reds become green: no new card/session, SSE ends, pairing stays and token use recovers after settled re-enable. Ordinary CLI failures resolve nonzero; injected promise rejection is a separate exception boundary. |
| P2 | `src/core/phone/phone.ts:80–85` | Stop canceled the needs timer without clearing its handle, preventing later notification scheduling. Resetting the handle lets a new debounce run after settled re-enable. | A genuine 2.5-second recovery failure becomes green: an actual owned shell failure creates a need and reaches the injected push service, with its subscription preserved. Final Phone-focused run: four new plus sixteen neighboring tests, 20/20, Node typecheck exit 0. No installed Tailscale, real push or phone was used. |
| Documentation correction | `SECURITY.md`; `src/core/phone/gateway.ts:74`, `src/core/handlers.ts:398`, `src/shared/protocol.ts:460`; `src/core/hooks.ts:101` | Published security prose said nothing listens on the network and only the owner can approve, despite optional Phone access and controlled paired-device actions. The Phone row also said all account access was refused although `accounts.list` is explicitly allowed. | Source review confirms loopback bind, owner-enabled persistent Phone setting, Tailscale `/wanigan` mount, device tokens, role allowlist and Can act checks. The existing pure Phone allowlist test explicitly exempts account listing from its account restriction. Gemini setup copies selected auth-method/trusted-folder settings into its own home, not credential files or the owner's MCP settings. Documentation is corrected without claiming real Tailscale, phone, Keychain or provider verification. |

Nineteenth strengthens existing History guards without production changes: four Claude/Codex duplicate-account read/resume cases and four valid unsupported-schema/repair cases pass. Ambiguity-guard and empty-on-schema-error mutants fail their four corresponding cases. Tests preserve source trees and assert actual no-session outcomes and same-core supported empty/populated recovery. Cache tests retain late-duplicate refusal after eviction/oversized bypass and refuse a damaged later account despite an earlier cached match and limit one. These tests do not establish every account/schema form or real-provider resume.

Additional earlier proof strengthens staged-only commit and initial draft prompts with independent unstaged/untracked sentinels and preserved files/index/refs; two scope mutants fail. Actual Undo refusal calls compare complete state including symbolic HEAD; two action-guard mutants fail while an unrelated missing-object case remains green. Skill-preview ASCII boundaries at 512 KiB−1/exact/+1 and an alternate-account discovery fixture pass with their stated mutations/sentinels. Jev candidate ranking, owner-edit races and queue refusal/retry have seven recorded cases and seven rejected mutants. These prove their concrete outcomes, not real model behavior or blanket semantic coverage.

Cached checkpoint fixtures show real initial data/actions, trigger a later read error through a real rename event, remove stale timeline/panel/open-confirmation actions and restore actual data on Retry. Four timeline/last-action mutant cases each fail; two cached-diff button-guard mutants fail. The prior 14-case UI run and four strengthened recovery reruns passed on fifteenth, and four unknown/partial Jev before-state cases failed as expected. Redo uses a display-state override; reconnect is an injected subscription notification. The pre-Phone 44-path suite passed 72/72 targeted checks. Fresh exact-public-alpha.9 capture completed with six known defects reproduced and six passing neighbors, not twelve passing behaviors. All 34 before images were reviewed and 14 were selected byte-for-byte for the [proof addendum](alpha10-feature-proof.md#affected-ui-evidence). The corrected-source after comparison now passes with fresh images, as described in the addendum; older images are not substituted for it.

### Additive migration and test safety

Public migrations 1–20 remain exact, including shipped local-model preference at 19 and paired phones at 20. The unchanged audit usage-provenance SQL is appended at **21** (`db.ts:348`), never inserted ahead of a shipped migration. The strengthened upgrade fixture seeds a real public-schema project preference and all selected Phone fields, then checks them through upgrade and later accounting/pruning. Its source/static SQL identity is reviewed, and the named preservation fixture passed in the new 799-unit run; that full 44-path gate subsequently exited 0. The later 48-path gate failed in the Phone sweep; the subsequent 52-path full gate below passed, including the upgrade fixture. The earlier unpublished audit schema 19 is not treated as a public database version.

Source review found a test fixture that could reach default installed Codex model discovery. `test-support.ts` now supplies an empty stand-in when no reader is provided, including explicit undefined, and retains explicit overrides. The omitted-reader and explicit-undefined cases were genuine failures before correction; the supplied-reader case was a passing neighbor. The final focused run passes all three, and Node typecheck passes. The smoke now observes only its owned Electron `powerSaveBlocker` identifiers/state, replacing system-wide `pmset` inspection. Its execution passed in the historical 48-path source smoke; old global-power observations are not carried forward as proof. The later input-order correction and final package require their own verification.

The old 35-path candidate's 724-unit/full-UI/crawl result is historical evidence under its inherited launch environment. Its wrapper did not itself replace HOME, shell configuration or credentials, so that run must not be described retrospectively as sealed. The new external alpha.10 launcher constructs an explicit environment, strips inherited credentials/proxies, sets fresh HOME/ZDOTDIR/XDG and npm/Git configuration, and uses fake services/launchers. It is not an OS sandbox and does not authorize real `local:check`, Gemini or Phone probes.

The first fresh alpha.10 attempt (`alpha10-test-run-JPk8gJ`) exited 1 after **798 passes and one failure out of 799 unit cases**; UI/crawl did not run. Its wrapper's four Git author/committer environment keys overrode the fixture deliberately testing missing identity. Those four entries were removed from the external launcher; application source stayed unchanged. The actual commit/identity case then passed 1/1 in the corrected environment. The first log/result and preserved old launcher remain evidence; they are not an application regression or a successful full gate.

### Fresh alpha.10 verification state

| Gate | Observed state |
|---|---|
| Public baseline, selected source and unselected-file preservation | Exact public baseline and 52 selected hashes reviewed; 497 other public files unchanged. Documentation remains separate and preserves the 66,662-byte report prefix. |
| Shipped schema preservation | Static raw-SQL proof: exact public 20-entry prefix and unchanged appended audit SQL at 21. The actual 20→21 preservation fixture passed in the historical 799-unit full gate. The later 48-path gate failed in the Phone sweep; the subsequent 52-path full gate below passed, including the upgrade fixture. |
| Independent physical dependencies | README `nvm install` and `npm install` passed with independent physical dependencies. The physical dependency tree is retained; all 52 selected source hashes are now pinned. |
| New fixture safety | Three focused interception cases and Node typecheck passed; corrected external launcher syntax/environment preflights and single identity case passed. |
| Historical 44-path full gate | `alpha10-test-run-xsAoL0` exited **0**: typecheck, **799/799 units with zero skips**, desktop/Phone sweeps and **72/72 targeted regressions**. Crawl: 79 surfaces, 1,728 controls, 51 keys, 29 checks, 1,369 actions; 1,428 passed, zero failed, 11 allowed, one guarded, 368 gone before their turn. Root retained 337 artifacts/105,862,465 bytes. This precedes Phone integration. |
| First combined 48-path full gate | `alpha10-test-run-CAuj91` exited **1** after **803/803 units, zero skips** and a passing desktop sweep. Phone light-theme typing replay was `from-phnoe` instead of `from-phone`; targeted UI/crawl were not reached. |
| Historical51 full gate | **Exit 1**, `alpha10-test-run-WfZuOY`: 814 units, desktop/Phone sweeps and 72 targeted checks passed; crawl 1,427 passed/one failed on the stale terminal-error prefix expectation. All 338 artifacts preserved before another browser run. |
| Current 52-path full gate | **Exit 0**, `alpha10-test-run-FFoayl`: typecheck, 814/814 units with zero failures/skips/cancellations, desktop/Phone sweeps and 72/72 targeted checks. Crawl: 79 surfaces/1,727 controls/51 shortcuts/29 checks/1,368 actions: 1,427 passed, 0 failed, 11 allowed, 1 guarded, 368 gone. Exact details and archives follow below. |
| Fresh both-theme affected UI proof/screenshots | Exact public-alpha.9 before capture exit 0: six known defects reproduced, six passing neighbors, 34 reviewed PNGs, all 525 source hashes matched. Separate Phone error before capture also exited 0: two known defects, two reviewed PNGs, actual Q delivered before lost reply. Candidate desktop after run passes 12/12 with 34 reviewed PNGs; Phone after passes 2/2 with 2 reviewed PNGs. Sixteen matching before/after pairs are retained; no visual blocker found. |
| Historical 48-path native source smoke | **Exit 0** in `alpha10-source-smoke-run-CwyZ7I`, including owned Electron power-save blocker start/stop. Outer environment removed; this does not certify the next input-order correction. |
| Literal README development workflow and final52 native source smoke | Both **exit 0**, `alpha10-readme-dev-run-cW7GFN` and `alpha10-source-smoke-run-GhtGlH`; owned environments removed. Source provenance before packaging matches 549 files. |
| Native package/zip/DMG, signatures, actual isolated shipped Help Demo | **Passed locally**: package ESsL00, packaged smoke VzlY5J, ZIP smoke IAoij0 and mounted-DMG Help Demo tLh2P7 all exit 0. Signatures and exact ASAR/109-output provenance match. Native inventory correction and inactive-fallback limits are disclosed below. |
| Post-package source/native smoke | **Exit 0**, `alpha10-source-smoke-run-WLOqVy`, with environment removed. Required independently of `dist:mac` exit status because that wrapper still ignores restoration failure. |
| Final source/artifact identity | **Passed locally** for all 549 source files, three matching ASARs and 109 output files; exact asset sizes/hashes below. |
| Commit identity, secret scan, both exact-commit CIs, public downloads and website | **Pending**; alpha.8/website publication above is separate observed work. |

The subsequent 48-path run (`alpha10-test-run-CAuj91`) exited **1** after **803/803 unit cases passed with zero skips** and the desktop UI sweep passed. The light Phone sweep typed `from-phone`, but the actual Mac terminal replay contained `from-phnoe`; the expected output check failed. Targeted regressions and crawl were not reached. Artifacts left in shared output directories include earlier-run files and cannot establish that a later stage ran. The exact log and result are retained in `alpha10-combined48-failed-verification.json`. A separate controlled transport fixture now reproduces later key requests overtaking the first, changing the shell command. The input correction and later integrated results are recorded below; the later local artifact outcomes are recorded below and publication remains pending. The 48-path source and failure are preserved historically; the reviewed input correction entered source51, followed by the crawler-only source52 correction and passing full rerun below. The frozen 48-path source later passed the isolated native source smoke (`alpha10-source-smoke-run-CwyZ7I`, exit 0): an owned real PTY/CLI, menus, title, alerts, controlled update request, quit/core recovery, and the owned Electron power-save blocker starting and stopping were observed. Its outer environment was removed. This is historical source-smoke evidence; it does not certify the subsequent input-order correction or packaged artifacts.

The full final51 run (`alpha10-test-run-WfZuOY`) completed with **exit 1** after **814/814 units, zero failures/skips/cancellations**, the desktop and unchanged per-key Phone sweeps, and **72/72 targeted checks** passed. Its crawler covered 79 surfaces, 1,728 controls, 51 shortcuts, 29 checks and 1,369 actions: **1,427 passed, one failed, 11 allowed, one guarded and 368 gone**. The sole failure was the terminal-error check, which still expected `Keys did not reach the session` after the intentional neutral `Session input` prefix. That test expectation is corrected in the separately reviewed 52-path candidate; the actual complete rerun is recorded below. Before any new browser work, all 338 current artifact files (105,978,987 bytes) were copied and individually hash-verified, together with the completed log/result/plan and exact source manifest. The failed run’s environment is retained. `alpha10-combined51-failed-verification.json` records the exact outcome; directory contents may include earlier retained artifacts, so coverage comes from the log.

The reviewed 52-path candidate changes only `scripts/ui-crawl.mjs` from that frozen 51-path source; all other 548 files remain exact. The focused old assertion failed while showing the intended `[Session input: Wanigan’s core did not answer.]`; the corrected assertion passed with exactly one input call and the exact injected rejection, positive visible-error matching and absence of the false old prefix. Watch/reconnect checks are unchanged (`alpha10-crawl-terminal-oaV6kJ`, exit 1; `alpha10-crawl-terminal-rU15Qq`, exit 0). The complete 52-path run `alpha10-test-run-FFoayl` then exited **0** with its owned environment removed: typecheck, **814/814 units with zero failures/skips/cancellations**, desktop and unchanged per-key Phone sweeps, and **72/72 targeted checks** passed. Crawl: **79 surfaces, 1,727 controls, 51 shortcuts, 29 checks and 1,368 actions; 1,427 passed, zero failed, 11 allowed, one guarded and 368 gone before their turn**. Post-gate provenance matched all 52 selected paths and 497 unchanged public files (549 total). All 338 artifact files (105,882,706 bytes), exact log/result/plan, manifests/provenance and selected source were copied and hash-verified into read-only archives; `alpha10-final52-full-verification.json` pins the outcome. The 368 unreached controls and limits of generic crawler assertions remain explicit.

The final 52-path source subsequently passed literal README `npm run dev` in `alpha10-readme-dev-run-cW7GFN` and native source smoke in `alpha10-source-smoke-run-GhtGlH`, both exit 0 with owned environments removed. The development workflow rendered the isolated empty app and answered its bridge; root reviewed its Open project screenshot without visiting real accounts or providers. The source smoke observed its owned PTY/CLI, menus, title, alerts, controlled update fixture, quit/core-recovery behavior and only its own Electron power-save blocker starting and stopping. Fresh source provenance before packaging matched all 549 files.

Native packaging (`alpha10-package-run-ESsL00`), independent post-package source smoke (`alpha10-source-smoke-run-WLOqVy`), actual packaged-app smoke (`alpha10-packaged-smoke-run-VzlY5J`) and extracted-ZIP smoke (`alpha10-zip-smoke-run-IAoij0`) each exited **0**, with owned environments removed. Packaging ended with `Rebuild Complete`; the separate post-package smoke is the actual evidence that source native dependencies remained usable. Both app copies exercised an owned real PTY/CLI, menus, title, alerts, controlled update requests, quit/core recovery and their own native power-save blocker. No provider/model session was started.

The read-only mounted DMG check (`alpha10-dmg-run-tLh2P7`) also exited **0**. Its actual Help → Open the Demo menu opened a second app under the temporary root with three projects and one session while the parent stayed empty; root visually inspected `alpha10-demo.png`. The mount was ejected and its environment removed. App, extracted ZIP and mounted DMG passed strict deep signature verification; all three contain the same ASAR SHA-256 `a586122bd1f0aa544b1ee716b7eeb7d9bb67a548e58ef6eb192a21d166613bb3` and match all **109 built output files**. Their provenance records also match the exact 52 selected and 497 preserved source files. The build is **Apple silicon, ad-hoc signed and not notarized**; these tests on macOS 26.5 do not establish clean-machine Gatekeeper behavior or the declared macOS 13 minimum.

The first external inventory incorrectly required every bundled fallback spawn helper to be executable and failed on inactive arm64/x64 prebuild helpers with mode 0644. A sealed probe of the actual packaged Electron instead observed node-pty selecting `../build/Release/`; its selected native module and executable helper were mode 0755 and remained hash-identical before/after loading. The corrected inventory binds that selection to the exact ASAR and selected inputs, and independently matches all 21 unpacked native inputs between app and ZIP. The inactive fallback helpers remain non-executable: their ability to work as fallbacks is **not verified**. No artifact or application source was changed to pass the inventory. The source-only independent review is `alpha10-artifact-inventory-final-review.md`; runtime PTY proof comes from the separate smoke runs, not the inventory.

| Locally verified asset | Bytes | SHA-256 |
|---|---:|---|
| `Wanigan-2-2.0.0-alpha.10-mac-arm64.dmg` | 161,029,759 | `a6c3238eac3e887c35472a7947b629525861fe610c3dbc0934e800e1609c850d` |
| `Wanigan-2-2.0.0-alpha.10-mac-arm64.zip` | 143,200,193 | `a79ac8065bd3f1a67779257f1cf413a8a54e9f0ed2d162be64b78a9bcf8b38a8` |

These are local artifact checks. Final committed identity/secret scan, exact-commit CI, publication, fresh public-download comparisons and the alpha.10 website update remain pending.

### P1 — Phone terminal input can overtake earlier keys

**Confirmed P1 defect; the reviewed three-path correction is integrated in the current 52-path candidate, whose complete gate has passed.** At `src/renderer/src/phone/bridge.ts:47`, each `sessions.input` call started an independent HTTP request. The terminal's per-key callback (`components/Terminal.tsx:199`) and the Phone extra-key buttons (`phone/SessionScreen.tsx:40`) shared no ordered transport. In the actual 48-path Phone sweep, typing `from-phone` reached the owned Mac terminal as `from-phnoe` and failed the expected command-output assertion. A separate deterministic fixture delays the first input request while allowing later ones, including Enter, to reach an owned shell: the old bridge executes `rintf ...`, reports `command not found`, and leaves the redirected file empty instead of the expected `phone-ordered` bytes (`phone-input-final-order-red.log`, one failure). This establishes changed command bytes and execution order. It does not claim a destructive command was executed or an authorization bypass; the caller is an already paired phone with Can act.

The integrated three-path correction serializes only `sessions.input`, retaining callback order for keyboard, paste and extra keys. Other RPCs remain independent. On a refused, lost or undecodable reply, pairing change or admission overflow, it rejects the waiting suffix, including a queued Enter, aborts the active request and permanently pauses input on that bridge. It never automatically retries: earlier bytes may already have reached the terminal. The user must review the terminal on the Mac and reload the phone page before typing again. The shared terminal error prefix becomes neutral `Session input: …`, because a transport failure cannot establish that keys were unapplied.

The queue admits at most **128 calls and 256 KiB of serialized UTF-8 request bodies**, counting active and waiting requests together. These are accounted payload limits, not a browser-heap or transient serialization bound. No new RPC deadline is introduced: a stalled active response can wait until failure, unpairing or a later admission refusal. Aborting does not undo bytes already applied; concurrent writers outside this PhoneLink are not globally ordered by this queue.

Focused tests inspect actual shell-created file bytes, an applied command prefix with a deliberately lost response, absence of the queued Enter's file effect, independent successful reads, and deliberate fresh-bridge recovery. Additional fixtures cover exact call/byte boundaries, multibyte input, immutable queued data, suffix cancellation, unpairing and capacity recovery. The frozen three-path manifest is `phone-input-files.json`: bridge `f398d35a…`, its new test `025c348d…`, and Terminal wording `09a82766…`. The inspected final focused log records **24/24 passes, zero skips/cancellations**: eleven new bridge cases and thirteen Phone/gateway/disable neighbors. The same final ordering fixture is genuinely red on the old bridge. Both normal project typechecks passed; an additional mixed DOM/core test compile failed at an unchanged push.ts Buffer/BodyInit type boundary and is not claimed as a passing gate. Independent Spec and standards source reviews found no remaining blocker. The historical51 manifest and selected source hashes were verified and are preserved in its archive. Its complete gate (`alpha10-test-run-WfZuOY`) subsequently exited 1 after 814 units, both sweeps and 72 targeted checks passed; the sole crawler failure was a stale terminal-error prefix expectation. The reviewed crawler-only correction is integrated as source52; its complete run FFoayl subsequently passed. Fresh public9 error captures reproduced the false prefix in both themes after an actual Q reached the owned terminal and its browser reply was lost; the new candidate error captures now pass in both themes, showing actual Q and the neutral paused-input/review/reload warning. No earlier screenshot or gate certifies this correction.

### Remaining work and precise limits

**Further Git guard proof, outside this release.** A separate tests-only future candidate adds two actual-owner cases for failed fingerprints with partial output and index changes after the patch read. Both refuse commit, preserve exact HEAD/symbolic HEAD/refs/index/working bytes and permit a later staged-only retry; seven focused cases pass, and each removed guard fails its corresponding commit-refusal assertion. These tests are not included in source52. A separate controlled writer inserted immediately after final checking put a marker into the actual commit despite its absence from both scan patches (`git-late-writer-observation.log`). This confirms the post-check commit timing window without claiming natural incidence, push/hook behavior, a secret leak or any real-repository event. The external-writer limit remains unresolved.

**Open P2 — duplicate local-model downloads can lose cancellation tracking.** At `src/core/local-models.ts:219–220,232–246`, admission is checked before awaiting status, and a child close deletes the module entry without checking which child it represents. Two concurrent same-module owner RPCs both fulfilled and spawned separate `/bin/cat` stand-ins with identical `get` arguments. Closing the first erased tracking while the second remained alive; a subsequent cancel did not stop it (`local-download-race-observation.log`, owned environment removed). This proves the lifecycle race in an isolated actual core, not real model downloads, network traffic or disk impact. Its correction is a separate future candidate and is not included in alpha.10.

**Open P2 — failed local-model resource checks still admit work.** At `src/core/local-models.ts:224`, a failed free-space read becomes infinity and allows `get`; at `305–311`, an estimate command exiting 17 without the recognized refusal phrase still allows `load --yes`. Six isolated owned-core observations include failed/low/ample disk results and failed/explicit-refusal/allowed estimates: the low-disk and explicit-memory-refusal neighbors correctly refused, while the two failed checks admitted work (`local-admission-observation.log`). The download path uses real owner RPCs and the preparation path calls the core service; LM Studio/disk results are injected and only owned `/bin/cat` children run. No actual model, download, disk pressure, network or memory exhaustion was exercised. These corrections remain outside alpha.10.

**Open packaging-status defect — following batch.** `scripts/dist-mac.mjs:28` ignores the native-restoration process result. A byte-identical script in two tiny owned fixtures ran fake build/builder/rebuild commands: statuses 0/0/17 still produced overall exit 0, while 0/0/0 was a healthy neighbor. Exact package.json bytes were restored before the rebuild attempt and afterward, and all three stage calls/arguments were observed (`dist-mac-restore-proof.md`). No real native build failure was simulated or inferred. The frozen alpha.10 script is unchanged. A **post-package source/native smoke is required independently of packaging exit status**, in addition to packaged/zip/DMG checks; the independent post-package source smoke now passed (`alpha10-source-smoke-run-WLOqVy`, exit 0). This mitigates the current release workflow; the source defect remains unresolved in alpha.10. The narrow future fix must propagate restoration failure while preserving a prior build/package failure and the existing cleanup order.

**Open Phone revocation race — following batch, not corrected in alpha.10.** At `core/phone/gateway.ts:120–125`, the device is authenticated before the awaited request body completes. An isolated authenticated POST held before its final byte still returned HTTP 200 and persisted a card after the owner either revoked Can act or forgot the device. Fresh requests correctly returned 403 or 401, and owner calls remained responsive (`phone-auth-delay-observation.log`). This is a stale authority snapshot before dispatch, not merely core work already running. It requires a previously valid paired token and an admitted body; no public unauthenticated access or real-phone exploit is claimed. The separate next-batch correction will re-read the token/device after body completion; no such source change is included in the current 52-path candidate.

Cache budgets count retained entries/rows and logical payload: two bytes per UTF-16 code unit for keys/stamps/strings; binary views charge their whole backing store, possibly repeatedly. They do not bound exact VM heap, object overhead, string backing storage, full enumeration, SQLite `.all()` allocation, parsing/grouping/sorting, reply metadata or transient arrays. A 600-file sequential scan produces 600 misses/zero hits with the 512-entry cache versus zero misses/600 hits with old maps; this is a retention fix, not a speedup. Same-size/mtime replacement and chmod-only access changes can reuse cached content. Copies pin descriptors but remain synchronous, can copy large files to disk, and cannot make concurrent inode writes or the DB/WAL pair atomic. Forced APFS clone probes returned `ENOSYS`; no actual CoW support is established.

Client body limits count UTF-16 units while queues count UTF-8 bytes; serialization/transient memory is separate. Main socket output limits do not cover hook replies or total process memory. Hook framing deliberately preserves prior scalar/array/malformed fallback behavior. Git consent checks still cannot lock out external writers or arbitrary hooks between final checks and publication. Jev totals are estimates from reported usage; legacy values stay unknown, probability validation does not rewrite past accepted cards, and timing still ends at headers. Cumulative evidence/checkpoint/attachment retention, large modules, broad semantic crawler coverage, dedicated History UI error/recovery and some skill/account edges remain open.

The fresh alpha.10 npm audit reports eight moderate findings, no high/critical findings, and zero in omit-dev output. The earlier dependency investigation of the same advisory reported four tiny RangeError reproductions, and only literal inspected global-agent format strings; no affected packages were found in the verified alpha.8 ASAR. The current alpha.10 app and extracted-ZIP inventories also found none of the eight named affected package directories in their exact matching ASAR. That is directory-absence evidence, not universal reachability proof or absence of all vulnerabilities. The [maintainer issue](https://github.com/alexei/sprintf.js/issues/237) and [advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) remain the recorded primary references; no forced builder downgrade or dependency mutation is part of this batch.

The corrected Phone request/disable/timer paths remain in the current 52-path candidate, alongside the input-order correction. Their four new actual-core fixtures and sixteen neighbors pass in the separate focused run, but the complete 48-path gate later failed on Phone input ordering; the subsequent corrected 52-path full gate passed. Malformed `//[` previously caused an unanswered request and `ERR_INVALID_URL` under the production-style rejection logger; following HTTP/owner calls still answered, so no production crash is claimed. Held external cleanup previously allowed a new paired card mutation and its SSE event after Off; local shutdown now precedes that wait. A separately reproduced canceled-timer handle prevented notification recovery and now resets to null. Routine CLI failures resolve nonzero; the rejected-promise fixture is an injected dependency boundary, not a claim about ordinary CLI failure.

Phone still does not cancel already-admitted core work or serialize overlapping enable/disable; recovery tests wait until disable settles. External nonzero-unmount reporting is unchanged. SSE admission and backlog remain a source-supported audit lead: four watched IDs are allowed per stream, but total streams and buffered `res.write` output have no application cap. Opening a stream requires owner-enabled Phone access, an allowed Host and a valid paired bearer token; Can act is not required for this read endpoint. No actual memory exhaustion, authentication bypass, public-Internet exposure or real Tailscale path was reproduced. These limits are separate from the tested corrections.

Real model turns, billing, provider sign-in/resume, actual local-model/Gemini operation, real Tailscale/iPhone/lock-screen delivery, clean-machine macOS 13 Gatekeeper and other platforms remain unverified here. No publication date or completed-audit claim follows. Current documentation work is source-only; new verification uses explicitly isolated fixtures and stand-ins, and older environment limitations remain disclosed.

### Post-commit alpha.10 CI checkpoint — release remains a draft

Both exact-commit GitHub runs for `2075ebd1d9cc6e4ed24a115697b01fa81ac7d407` completed with **failure**: [main CI](https://github.com/DanePete/wanigan-2/actions/runs/37744856135) and [review CI](https://github.com/DanePete/wanigan-2/actions/runs/37744855805). Each records **814 unit cases: 807 passed, seven failed, zero skipped/canceled**. All seven failures are in `src/core/commit-message-read-failure.test.ts`: six healthy retries after injected failures and the valid large staged-diff case returned Git usage errors. Desktop/Phone sweeps, targeted browser checks and crawl were **not reached** on those CI runs. `alpha10-ci-failure-record.json` pins both logs and conclusions. The earlier local full/native/artifact results above remain historical observed outcomes; they do not supersede the failed CI runs.

The fixture hardcoded `/usr/bin/git` for setup and healthy delegation while the runner's PATH Git was reported as 2.55. The exact failed runner system-Git version was not logged. The reviewed one-file correction now resolves the selected Git before installing the fault wrapper and reports its exact path/version. Setup, snapshots and quoted healthy delegation use that captured binary. Production source, all assertions in the eight tests and deterministic `PLAIN` options are unchanged. A local selection-sensitive red retained eight functional passes on capable Apple Git 2.50.1 but recorded **zero calls to the deliberately selected Git wrapper**. This proves the binary-selection defect; it does not reproduce the exact older-runner failure. Corrected final bytes pass **8/8** through Git 2.55, with **97 selected calls, eight repository initializations and nine `--default-prefix` diffs**, a path containing spaces and the owned environment removed. Node TypeScript and independent source review also pass (`alpha10-ci-fixture-proof.md`, `alpha10-ci-fixture-files.json`).

The integrated correction still has **52 selected source paths**; only the existing fixture hash changes to `d45ef00ca2e68916dcd6f4a75461d0c60851671294135b0609e69f0619da14f9`. The new source manifest is `alpha10-ci-source-manifest.json` (SHA-256 `7779361f0b094976207058a820c55f8e74525bdeb76a430440cb6faaded2970f`). Before the rerun, independent verification matched all 582 committed paths except that intended correction, all 109 existing built outputs and the actual packaged ASAR to the earlier artifact proof. **The corrected-source full gate `alpha10-test-run-RWLAmP` completed with exit 0 and its owned environment removed:** typechecking, **814/814 unit cases** with zero failures/skips/cancellations, desktop and Phone sweeps, **72/72 targeted browser checks**, and **1,428 passed / zero failed** crawler checks. The crawler recorded 79 surfaces, 1,728 controls, 51 shortcuts, 29 checks and 1,369 actions, with 11 allowed, one guarded and 368 unreached controls. This is a fresh corrected-source gate; its counts are not copied from the earlier 1,427-pass run. The source manifest matched before and after, and 338 artifact files (106,047,733 bytes), logs, plan and result were archived (`alpha10-ci-full-verification-RWLAmP.json`). **Post-gate provenance also passed:** 52 selected code hashes, 494 other public files and 582 total source/document paths, with all 109 built outputs and the packaged ASAR `a586122bd1f0aa544b1ee716b7eeb7d9bb67a548e58ef6eb192a21d166613bb3` unchanged (`alpha10-ci-after-full-provenance.json`). The native/app/ZIP/DMG checks above are retained for those identical runtime/artifact bytes; no second native execution is claimed. **A new commit and exact-commit CI remain pending.** The release targeting `2075ebd` is still a draft; no alpha.10 publication, fresh public asset verification or website deployment is claimed here.

**Separate compatibility limit.** Current production diff arguments use `--default-prefix`. Git's primary v2.40.0 parser/documentation lack this option; v2.41.0 includes it. Older Git may therefore refuse these operations. That is source-supported compatibility risk, not a reproduced production run on Git 2.40 or proof of the failed runner's exact system version. Selecting the intended test Git does not add old-Git support. The existing deterministic `PLAIN` options and their Git 2.55 prefix/stash failure context remain intact; dropping them is not this correction. Primary references: [Git v2.40 parser](https://raw.githubusercontent.com/git/git/v2.40.0/diff.c), [Git v2.41 option documentation](https://raw.githubusercontent.com/git/git/v2.41.0/Documentation/diff-options.txt).

#### Additional confirmed remaining work — outside this release correction

**P2: a stale Phone enable can overwrite a later Off.** `src/core/phone/phone.ts:103` awaits listener/status work before writing `phone_enabled=1`; `disable()` can complete during that await. An owned actual-core/owner-RPC fixture held the injected Tailscale status, completed Off and observed the listener closed and database flag absent. Releasing the older enable then restored the flag to 1 with no listener. A newly constructed core on that same owned database reopened a loopback listener without another enable call. A healthy final Off cleared it. Owner calls stayed responsive and no sessions or paired devices existed. This proves an unexpected persisted intent/listener restart in a controlled ordering, not an authentication bypass, a natural incident or actual Tailscale exposure (`phone-enable-disable-observation-proof.md`, manifest and log). No correction is included in alpha.10.

**P2: late push cleanup removes a replacement subscription.** At `src/core/phone/push.ts:77`, a delayed 410 for an old target clears subscription state by device ID (`devices.ts:98`). An actual owner `phone.testPush` call, an injected push service and the owned core database showed both a replacement endpoint and replacement keys at the same endpoint erased when the old result completed. The unchanged-target 410 neighbor correctly cleared its current subscription. All three calls returned `{ sent: 0 }`; no real push request, device delivery or session occurred. This is controlled stale cleanup, not a measured production notification loss (`phone-push-replacement-observation-proof.md` and manifest). Its future correction remains separate.

**Remaining Jev copy defect.** `src/renderer/src/components/Jev.tsx:115` still says it reads card text “never its code,” and the historical marketing illustration contains that wording. Card fields may contain code supplied by the user; the Jev card reader does not open project files or transcripts. The alpha.10 app and illustration are unchanged. Website prose can state the accurate boundary, but does not make that old illustrated/app wording correct. A UI copy correction and fresh illustration belong to the following batch. Unknown usage/cost behavior and the separately verified alpha.10 fixes are unchanged.

The earlier held-body revocation, stream resource, local-model admission, packaging status, external Git writer and real-service limits remain open as recorded above. These new observations do not imply that their separate future candidates are included. The audit continues.

## Batch 9 — alpha.11 candidate: Phone boundaries, local admission and packaging evidence

This is a **draft verification checkpoint**, based on published alpha.10 commit `92e081ee840239fd8fc7f243695e0f53962a2c2d`. The complete preceding 119,215 bytes are preserved exactly. The audit continues. The local full and native gates have passed; exact-commit CI and alpha.11 publication/site verification remain pending.

### Observed alpha.10 publication and website

At 09:14 UTC on 8 October 2026, the existing alpha.10 draft was published as a prerelease at exact `92e081e`; its remote tag resolves to that commit. Both exact-commit workflows completed successfully: [main 37750166113](https://github.com/DanePete/wanigan-2/actions/runs/37750166113) and [review 37750166170](https://github.com/DanePete/wanigan-2/actions/runs/37750166170). Each log records 814 passing unit tests, desktop and Phone sweeps, 72 targeted browser checks and eight staged-read diagnostics identifying Git 2.55.0.

Keep the crawler observations distinct. Main recorded 79 surfaces, 1,741 controls, 51 shortcuts, 29 checks and 1,374 actions: 1,433 passed/zero failed, 11 allowed, 1 guarded and 376 gone before their turn. Review recorded 79 surfaces, 1,740 controls, 51 shortcuts, 29 checks and 1,376 actions: 1,435 passed/zero failed, 11 allowed, 1 guarded and 373 gone. The earlier local run remains 1,428 passed/zero failed and 368 gone. These are separate dynamic runs. `alpha10-publication-preflight.json` and `alpha10-published-release.json` preserve actual status/tag/body evidence.

Fresh unauthenticated public downloads returned HTTP 200 and matched the independently verified local assets (`alpha10-publication-verified.json`): DMG 161,029,759 bytes, SHA-256 `a6c3238eac3e887c35472a7947b629525861fe610c3dbc0934e800e1609c850d`; ZIP 143,200,193 bytes, SHA-256 `a79ac8065bd3f1a67779257f1cf413a8a54e9f0ed2d162be64b78a9bcf8b38a8`.

The website deployed as `6fe395be-08b7-424a-9e0f-183b3aec62b7`. All eight sealed live stages completed with exit 0 and removed their owned environment (`alpha10-site-live-run-bevijj/result.json`): 401 full-site assertions, four mobile and four archive cases, affected captures, exact HTTP/header/redirect checks, and two actual video full/range checks. The public HTML matched SHA-256 `072589f452696b57518db0d7ad9325d0514278c880e6057529b5a64898232e0a`. All 32 assigned affected screenshots were visually reviewed and hash-checked in both themes at 1440px/390px; no new material visual blocker was found. This is website proof, not real provider/device verification. The historical Jev illustration still contains “never its code”; the corrected adjacent note explicitly says entered fields may contain code. An authentic replacement belongs to the future alpha.11 website batch.

At 09:52 UTC, alpha.10’s public release notes were updated to disclose the subsequently reproduced shutdown-admission gap. A fresh API read verified body SHA-256 `09d75bec51af85ac08a6f5418e349c59734804701d944b77046c2c4b0e167ef8`; the exact tag and both asset IDs, sizes and digests stayed unchanged (`alpha10-shutdown-notes-verified.json`). The published alpha.10 binaries were not changed.

### Initial alpha.11 integration and retained failure

Root guarded 21 paths into a clean independent final-alpha.10 clone: 18 reviewed source/test paths and three version-only edits. The initial source set contained 590 files with 569 unchanged; its selected manifest was `87ba506fa48bb4aebb6752bb48ac62be7590ecf1d3af3637d541ea6d1b805d71`. It combined held-body Phone authorization, SSE admission/output limits, Phone lifecycle ordering and push-subscription identity, local download reservation/preflight refusal, native-restoration exit status, Git state-preservation proof and truthful Jev explanatory copy. The [proof addendum](alpha11-feature-proof.md) separates component results from merged evidence.

The first merged 15-file focused run **failed**: 90 tests, 89 passed and one failed, exit 1. The retained SSE fixture called terminal `Phone.stop()` and then expected the same instance to enable again; the new lifecycle contract refuses with “The core is shutting down; phone access cannot change.” The complete first run, source manifests and fixture are retained in `alpha11-first-merged-focused-failure`. Its failed environment was retained, not reported removed.

The independently reviewed test-only reconciliation uses real disable/enable for reversible Off/On, with native response-close observers proving charged slots remain until close. A separate terminal-stop case checks saved On, same-instance refusal, and an actual replacement Core using the same owned database and persisted device token. Root transferred only that test; all other 589 files were preserved. At that reconciled 21-path checkpoint, the selected manifest was `0dd524dcabb434b4d3a52f192a90410def45230ce3c3f8b59251f24654210e18`; the complete 590-file manifest is `7c283f0b17c15f53d02a06d563e5f89247ed851e669be0bd6ff17c7823101a1c`. Counts remain 21 selected and 569 preserved relative to final alpha.10. No production correction is attributed to this test reconciliation.

The corrected merged focused run passed **91/91**, with zero failures/skips/cancellations and exit 0 (`alpha11-focused-run-u8mBRr`). Node and web typechecks both exited 0 (`alpha11-types-run-se1Ge8`). Both records bind the reconciled complete source manifest, retain stage-log hashes and report owned-environment removal. This is affected-suite proof, not the complete repository gate. The unchanged `src/core/db.ts` bytes preserve migration SQL 1–21; no new migration or migration runtime proof is claimed.

### Remaining gates and limits

All 252 feature rows are accounted for: 11 existing rows record this batch’s source-backed changes/proof, two MCP rows qualify confirmed open read-state/masking failures, and 239 other rows remain exact. These row updates preserve unrelated Gemini, Phone and Models content and do not imply real-provider verification. Jev before/after capture helpers bind the reconciled source and a separate exact-alpha.10 baseline. Both builds and corrected captures exited 0: eight known-false baseline observations and eight corrected candidate cases, 16 PNGs per stage, at 1440×900 and the supported minimum 960×700, in both themes and read/accept modes. All 32 images were visually reviewed and hash-checked; no material affected-copy layout blocker was found. The mode is explicitly a read-only presentation fixture. Demo seeding uses 19 free injected answers; actual card and Jev status remain unchanged during capture, and no real TypeSafe request is made. Every successful command reports removed owned environments and source verification. The selected eight complete viewport images are linked in the [proof addendum](alpha11-feature-proof.md#selected-jev-before-and-after-images). Their actual after-capture source is the historical 21-path checkpoint, not the later 24-path integration. A separate source/output rebind now verifies all 591 current source hashes, only the three admission changes since capture, and all 95 rebuilt renderer files byte-identical (`alpha11-jev-renderer-rebind.json`). This is not a recapture or full-gate pass. The authentic future marketing illustration has a separately reviewed seven-path preparation with 26 unit checks passing, but site build/browser/deployment remain pending.

The first before capture stopped with zero completed cases because its explicit read-only allowlist omitted the actual drawer’s automatic `chat.list` query. Source review traced that query to database/account reads; only that method was added. The failed capture and environment remain retained, and no app code changed. The corrected rerun is the observed pass above (`alpha11-jev-ui-proof.md` and its image/result index).

Fresh physical `npm ci` completed with exit 0 and removed its owned environment (`alpha11-install-run-H8suMD`). The first unfiltered alpha.11 full gate then **failed**, exit 1 (`alpha11-full-run-M9xEQB`): 873 unit tests, 872 passed/one failed, zero skipped/cancelled. The failing unchanged `session-safety.test.ts` case expected shutdown to refuse a launch awaiting preparation, but received no error. Browser stages were not reached, and the failed environment is retained.

#### Confirmed P1: session admission stayed open during shutdown

Affected source is `src/core/core.ts:249` (awaited Phone close) and `src/core/sessions.ts:918` (the admission barrier). Priority reflects commands starting after shutdown was requested. The cause is confirmed: `Core.shutdown()` awaited Phone’s native close before `Sessions.stopAll()` set its stopping flag. The same new owned-core regression genuinely failed on both the unchanged alpha.11 candidate and exact published alpha.10 `92e081e`. With the actual Phone close completion held, both an already-preparing fake Codex start and a fresh fake Claude owner request succeeded: three persisted session rows and three PTYs. These are two baseline reproductions of one admission defect, using owned stand-ins, not real providers.

The minimal correction invokes synchronous `Sessions.beginStop()` first in `Core.shutdown()` and reuses it in `stopAll()`. Existing cleanup/drain order and rejection semantics remain intact. The new regression proves explicit refusal of both starts, responsive owner RPC, exact preserved rows and one original live child while close is held, then actual child drain, stopped-session persistence and lease removal after release. The final component run passed **34/34**, zero skips/cancellations, including the unchanged original failing test; Node typecheck exited 0. Independent spec and standards/safety reviews found no source blocker (`session-shutdown-independent-review.md`, `session-shutdown-standards-review.md`). These are focused observations, not a full application pass.

Root transferred only those three reviewed paths. The frozen candidate is now **24 selected paths, 567 preserved baseline files, 591 total**. Selected manifest SHA-256 `aa47385510408b23a339c65a7de2fa6c7e056ff9f786b3a728227ebed51e5afc`; all-source SHA-256 `b5128e647f46daf61d4c69b822314710c54a6e1eee186c427289f9abfebc8d95`. Transfer and post-transfer provenance passed (`alpha11-shutdown-admission-transferred.json`, `alpha11-post-admission-provenance.json`). The earlier 21-path full failure remains historical; the final 17-file merged run passed **96/96**, zero failures/skips/cancellations, exit 0 (`alpha11-focused-run-ZSGTYA`); Node and web typechecks both exited 0 (`alpha11-types-run-ZzCw5I`). Their source guards matched all 591 files and owned environments were removed. The new unfiltered full gate (`alpha11-full-run-jzTQEW`) subsequently completed with actual exit 0, as recorded below. This correction does not include the separate Core startup/native-bind candidate or add general shutdown-error recovery.

The current production-only dependency audit reports zero vulnerabilities (`alpha11-production-npm-audit.json`). A fresh full dependency audit still reports eight moderate advisories, all in the same development dependency chain, zero high/critical, with npm exit 1 and owned-environment removal (`alpha11-npm-audit-result.json`). No dependency bytes changed. A clean production audit is not a universal reachability or security proof.

README development launch, source/post-package smoke and actual app/ZIP/DMG checks subsequently passed; their new artifact identities are recorded below. Final commit/CI and alpha.11 release/site verification remain required. Prior alpha.10 native executions cannot certify changed alpha.11 runtime bytes.

The Phone correction does not fix the enclosing Core class lifecycle: isolated observations on final alpha.10 and the Phone candidate let held `Core.start()` continue after completed stop, write stale info and register an interval. That interval was cleared before firing. Production daemon exit behavior limits reachability; no daemon crash or long-lived production timer was observed. Keep this separate from Phone generation/ordering claims. Older-Git compatibility also remains separate; no support change is included here. Already-dispatched Phone operations, external mount/notification work, native bind/close waits, byte-identical push subscription identity, external Git writers, unfamiliar zero-exit memory estimates, cumulative disk/discovery work and real provider/model/device behavior retain their stated limits. No audit-completion claim follows.

### Latest observed intermediate gate and Git compatibility

The retained intermediate record (`alpha11-intermediate-verification.json`) observes **874 passing units, both desktop and Phone sweeps, and 72 targeted browser checks** on the frozen 24-path source. That was an intermediate observation, not the final result. The later successful final exit is recorded below. The earlier 873/872/1 failed run remains unchanged. Native/package/CI/publication checks were pending at that intermediate observation; later local native results are recorded below.

Actual Git 2.40.0 on unchanged exact-alpha.10 source returned unavailable staged counts and refused diff, commit-history, message-draft and tracked/untracked stash reads; the stand-in draft model was not called and repository state stayed exact. The identical portable fixture passed on actual Git 2.55.0. These three Git production files are byte-identical in frozen alpha.11, so the measured compatibility limitation remains relevant; the separate compatibility correction is not included. This does not identify the failed CI runner’s unlogged system-Git version or prove behavior for every older Git.

### Open following-batch MCP read failures

An isolated owner-RPC fixture confirmed a P2 false-empty/false-success gap in unchanged `src/core/mcp.ts`: `readToml` at line 516 maps an actual EACCES read to absence; `has` at line 417 discards unreadable state; `remove` at line 178 accepts that apparent absence after CLI exit zero or null. A discovered owned Codex account first lists its invented server correctly. With the same config made unreadable, `mcp.list` reports empty without a note. A stand-in CLI that only changes that file’s permissions, then exits zero or terminates itself, makes removal return `done: true` even though exact config bytes/server remain. Restoring readability reveals the same server; exact application rows remain unchanged. The readable no-op refuses and actual stand-in removal succeeds.

The retained initial run has three genuine failures and one healthy neighbor (`mcp-failed-read-observation.json`, `mcp-read-red-dpSaXM`), with actual OS EACCES and owned environment cleanup. MCP production bytes match alpha.10 and frozen alpha.11. This is not real Codex behavior, credential access, incident-frequency or external disclosure evidence. The two existing MCP matrix rows are qualified accordingly; the read-state correction is a separate future candidate, not part of alpha.11. Descriptor/FIFO races, aggregation limits and further masking investigations are not established by this observation.

### Open following-batch MCP literal fallback masking

A separate three-case observation confirms a P2 masking failure in `src/shared/mcp.ts:274–345`: the reference exemption treats `${NAME:-literal}` as only a variable reference and returns its invented fallback literal. Pure classification/redaction assertions fail, and actual owner `mcp.list` responses expose the invented values in target arguments, environment pairs and header pairs for both owned Claude JSON and Codex TOML configurations. Plain variable-reference and ordinary-literal masking controls pass. Exact config bytes stay unchanged, the configured stand-in CLI is not called, and no session starts. The retained run exits 1 with three genuine failures, no interruption/signal, source guards passed and owned environment removed (`mcp-fallback-observation-evidence.json`).

This is an intended-redaction failure in the authorized owner’s result, not an authentication bypass, real credential read or evidence of disclosure outside the owned fixture. No environment reference was resolved. An expanded identical fixture also failed all 13 cases on the unchanged implementation. Actual owner responses exposed raw and percent-encoded invented fallback literals in configured Claude HTTP targets and in a diagnostic printed by an owned CLI stand-in. Listing made no HTTP request; the diagnostic fixture invoked only the owned stand-in, with unchanged configs and no sessions. The final observation and source guards are pinned by `mcp-fallback-proof.md` and `mcp-fallback-evidence.json`. The separately corrected candidate is outside alpha.11. These cases do not establish arbitrary encoding coverage, a universal secret detector or disclosure outside the owned fixture.

### Final local full gate passed

The exact frozen 24-path candidate completed unfiltered `npm test` with **exit 0** (`alpha11-full-run-jzTQEW`). It passed typechecks, **874/874 units** with zero failures/skips/cancellations, desktop and Phone sweeps, and **72/72 targeted browser checks**. The final crawler reports **79 surfaces, 1,728 controls, 51 shortcuts, 29 checks and 1,369 actions: 1,428 passed/zero failed**, 11 allowed, one guarded and 368 gone before their turn. Gone controls remain unexercised; this is not universal interface coverage.

All 591 source paths/hashes matched before and after, and the owned environment was removed. The final full log SHA-256 is `19bb2bf1eb0a26fbc1db79874d04d950608d0ce1246b6e69bb2155728ff54b2a`. The complete archive contains 337 files/105,903,528 bytes, with manifest SHA-256 `d0de0d57e5e3c7bddba03563f905ed608e20e0c92beb1c32eb9d69f1b397f12b`; it contains all regular artifact files present after the completed gate, not a claim every historical image was newly generated. `alpha11-full-verification-jzTQEW.json` and post-full provenance preserve the actual result and source identity.

This completed the local full-gate stage. Subsequent README/source/post-package and app/ZIP/DMG checks passed as recorded below; commit, both CIs and publication/site verification remain pending. The separate Core startup/native-bind, Git compatibility and MCP corrections are outside this frozen source.

### README and first native source checks

The README development launch (`alpha11-readme-dev-run-9LFVAk`) and first native source smoke (`alpha11-source-smoke-run-J5INZd`) both completed with actual exit 0, no interruption/signal and removed owned environments. The source smoke observed the owned real PTY and CLI, menus/title/shortcuts, this app’s native power-blocker start/stop, alert and update fixtures, quit behavior and core-failure recovery. The update endpoint was an owned fixture; no real provider or device was exercised. `alpha11-initial-native-verification.json` pins the actual logs/plans/results. Root visually reviewed the README first-launch orb and Open project dialog without a material layout blocker.

The README helper reload emitted one WebGPU device-mismatch diagnostic before its PASS. The rendered screenshot and bridge/assets/font checks passed, but the cause and GPU recovery behavior remain an audit lead; no GPU fix or universal rendering guarantee is claimed. Later GPU/network termination diagnostics occurred during owned teardown. Packaged app, ZIP and DMG execution and final native/asset identity subsequently passed as recorded below.

### Final local native and artifact checks passed

All seven local release stages completed with actual exit 0, no interruption/signal and removed owned environments on **macOS 26.5.2**: README development launch, source smoke, packaging, post-package source smoke, packaged-app smoke, extracted-ZIP smoke and the read-only mounted-DMG check. The package log ends with native dependency rebuild completion; the independent post-package source smoke also passed. App and ZIP runs exercised the owned real PTY/CLI, menus/title, this app’s native power blocker, alert/update fixtures, quit confirmation and core recovery. The mounted DMG’s actual Help › Demo opened a second app with three example projects and one sample session while the parent remained empty; root visually reviewed the screenshot and the mounted disk was detached.

The app, extracted ZIP and mounted DMG match **109 built output files**, the same ASAR SHA-256 `755e48a7ded80eb308ea3083514f97dacba4856c5ceb1d6d63faad3037c933e7`, and **21 native input files** including their modes. Strict signature checks passed. An actual packaged Electron load selected `node-pty/build/Release` on darwin/arm64 (Electron 44.3.0, Node 24.20.0); both selected inputs are executable. Two bundled fallback spawn helpers remain mode 0644 and were not selected or executed. This proves the observed selection, not that every fallback works. The eight recorded development-advisory package folders are absent from the actual ASAR; that is not universal vulnerability absence.

Verified local release files:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `Wanigan-2-2.0.0-alpha.11-mac-arm64.dmg` | 160,798,972 | `d338c46138ea6037f132a3aa39e47e923e99c8ed81f4fbb02694078aa9c6c006` |
| `Wanigan-2-2.0.0-alpha.11-mac-arm64.zip` | 143,202,597 | `fdb7daeaf5b5e23f41ab492df76ca03e3b6ad286d76d9b830e283461d76bb387` |

`alpha11-native-release-verification.json` pins all seven runs, signatures, native inventories, asset bytes and demo/detach records. The renderer rebind additionally matches the 95 historical captured renderer outputs to current built, packaged-app and extracted-ZIP bytes; this remains identity evidence, not a second Jev visual execution. The declared minimum is macOS 13; actual native testing was on 26.5.2. Ad-hoc signature integrity is not notarization or a clean-machine/macOS-13 Gatekeeper check. Real providers, models and phones were not exercised.

The local full and native gates are now complete for this frozen source. Final documentation transfer, exact commit and both CIs, public release/download verification and website deployment remain pending. The audit continues.

The security wording also distinguishes account discovery/sign-in from MCP configuration reads: account discovery checks filenames and sign-in uses CLI reports, while MCP reads configured values for owner display. Its heuristic masking is explicitly qualified by the observed fallback failures above. This is a documentation correction, not a new credential-handling or masking implementation.


### Alpha.11 exact-commit CI failure checkpoint — release held

The locally verified source and 12 documentation files were committed as `f1d9a86469c45511506c6eff78e4fede319393c0` and pushed to main and codex-review. Both exact-commit CI runs completed with failure before browser stages:

| Branch/run | Unit results | Observed failures |
| --- | --- | --- |
| [codex-review / 37764815918](https://github.com/DanePete/wanigan-2/actions/runs/37764815918) | 874 total, 865 passed, 9 failed; zero skipped/cancelled | All nine packaging fixtures stop at the working-directory equality assertion in `src/main/dist-mac.test.ts:56`. |
| [main / 37764816059](https://github.com/DanePete/wanigan-2/actions/runs/37764816059) | 874 total, 864 passed, 10 failed; zero skipped/cancelled | The same nine packaging assertions plus `core/chat.test.ts`’s stopped-answer fixture: reading its owned `calls/call-5.stdin` fails with ENOENT at helper line 58 (test lines 189/205). |

Both secret-scan jobs passed; neither failed test job reached desktop/Phone sweeps, targeted browser checks or the crawler. The complete logs and completed run states are pinned in `alpha11-ci-failure-observation.json`. These are two distinct failed CI results; the additional main-branch Chat failure must not be hidden by the common packaging failure.

At this checkpoint the working-directory path-alias explanation is a hypothesis under separate investigation, not an established production packaging defect or corrected fixture. The missing Chat fixture file likewise requires an isolated reproduction. No source correction, replacement local gate, replacement CI result or release publication is claimed here. The earlier 874-unit local pass, native app/ZIP/DMG executions and verified local asset identities remain historical evidence for the prior exact source; they do not turn failed CI green. Any correction must be reviewed, run through its required exact-source checks and rebind runtime/artifact identity before those native results can be retained. The alpha.11 release remains held; the audit continues.


### Isolated CI fixture corrections — focused proof passed

The common packaging failure was reproduced with an owned temporary-directory alias: the unchanged nine tests fail when `TMPDIR` spells `/tmp`, while the same fixture with canonical `/private/tmp` temporary paths passes all nine. Actual stand-in diagnostics show the alias fixture root versus the physical child cwd. The correction canonicalizes the newly created root and adds an owned-symlink regression; it preserves every original outcome block and the exact strict cwd assertion. The identical added regression fails before the one-line canonicalization (nine passed/one failed) and passes after it. Final Node alias/canonical and ordinary Electron-runner checks each pass 10/10; Node typecheck exits 0. Remote CI did not record exact cwd/root strings, so the controlled mechanism is not an invented trace of its precise spelling.

The separate Chat reproduction uses unchanged production and assertions with an owned FIFO before the fifth stand-in's stdin capture. It waits for the barrier's entered condition, observes `envExists: true` and `stdinExists: false`, then performs the same owner cancellation. The stopped/error assertions pass; the later recorded-call read fails with the same ENOENT. Ten healthy neighbors pass (11 total, 10 passed/one failed). The test correction writes a ready marker after stdin capture and waits for that marker before cancellation. Every original assertion line stays exact, including late-output absence, stopped state and null answer. The ordinary corrected Chat suite passes 11/11 and Node typecheck exits 0. No delay was increased and no production cancellation behavior changed.

A supplementary audit-only copy makes the delayed-input success explicit. It selects the existing cancellation case, seeds its owned call counter only to retain the call-5 identifiers, enters the same FIFO barrier, and observes env present with stdin/ready absent while the owner turn is running. The parent explicitly releases the FIFO; the corrected ready wait then observes complete stdin before the same cancellation assertions run. This selected case passes 1/1 with actual exit 0 and owned-environment removal; every original assertion and duration remains unchanged. It is additional controlled schedule evidence, not another full-suite pass or a source change. `alpha11-chat-ci-delayed-proof.md` and its JSON pin the exact copy, runner, outcomes and unchanged correction.

Both isolated candidates preserve their other 599 of 600 source files and use owned stand-ins/sealed temporary environments. Final runs completed without interruption/signal and removed those environments. Packaging's initial supplemental command with an unavailable `tsx` import and Chat's initial sandbox Unix-socket EPERM remain separately retained pre-collection failures, not counted as red/green proof. Independent source/spec and safety reviews found no material blocker in either correction. Exact files and observed records are pinned by `alpha11-dist-fixture-files.json` and `alpha11-chat-ci-files.json`, with their respective proof and independent-review files.

The reviewed two test files were subsequently integrated under the exact 600-file union manifest `5baeb7a5b0e482f150182b81eee936c6e6113c72d48b6da67efc7a706b322eac`; the other 598 files remain unchanged. The ordinary Electron-runner combined check passed **21/21**, zero skipped/cancelled, actual exit 0 (`alpha11-ci-focused-run-kodho4`), with source guards before/after and owned-environment removal. The pre-gate provenance check also matches all 600 source files and all 109 existing built outputs to the verified packaged ASAR `755e48a7ded80eb308ea3083514f97dacba4856c5ceb1d6d63faad3037c933e7`. This is identity evidence, not a repeat native execution.

The corrected complete run `alpha11-ci-full-run-uaRg93` is still pending at this checkpoint. Its final exit, post-gate runtime identity, replacement commit/remote CI and public assets remain required; no alpha.11 publication is claimed. Existing full/native records and both failed CI logs stay historical and unchanged.


### Corrected complete gate — local pass, publication pending

The unfiltered replacement `npm test` completed with **actual exit 0** in `alpha11-ci-full-run-uaRg93`. It passed typechecking, **875/875 unit tests** (zero failed/skipped/cancelled), the desktop and Phone sweeps, all **72 targeted browser checks**, and the crawler: **79 surfaces, 1,728 controls, 51 shortcut keys, 29 checks, 1,369 actions; 1,428 passed, zero failed, 11 allowed, one guarded and 368 gone before their turn**. All 600 source hashes matched before/after and the owned environment was removed. The prior f1 CI failures and earlier local gates remain distinct historical results.

`alpha11-ci-full-verification-uaRg93.json` pins the actual result/log and the 338-file artifact archive. That archive includes `app-window.png` retained from prior native work; it is not evidence that every archived image was newly captured by this gate. Fresh post-gate package and extracted-ZIP provenance each pass all 600 source hashes and all 109 built output identities against the verified ASAR `755e48a7ded80eb308ea3083514f97dacba4856c5ceb1d6d63faad3037c933e7`. Those are identity checks, not new native smoke executions. The corrected native identity check then completed with actual exit 0 (`alpha11-ci-native-rebind.json`): all 600 source files match with only the two reviewed test changes; 44 historical evidence/asset files are rehashed; the present app and ZIP each retain all 109 output files and all 21 packaged native files/modes. The ASAR and complete DMG/ZIP artifact identities remain exact. This reuses seven completed native observations without a new launch or DMG remount. The corrected commit, both exact-commit CIs and public release/download verification are still pending.

The first native-rebind helper attempt exited 1 because it wrongly equated source dependency binaries with signed packaged binaries. That audit-helper failure is retained in `alpha11-ci-native-rebind-source-assumption/failure.json`; no source or artifact changed. Two inspected source/package pairs have different signing metadata. The corrected helper compares each signed app/ZIP copy with its own historical packaged inventory. No equality between source native-dependency bytes and packaged native bytes is claimed.

### Additional open Claude MCP user-scope read failures

A separate owned owner-RPC probe now confirms the analogous **P2** Claude user-scope gap on unchanged release production: **five genuine failures and one healthy case**, actual exit 1, zero skipped/cancelled (`claude-mcp-read-red-e6Xgvv`). Actual OS EACCES and tiny malformed JSON each make the account appear empty without a note. Stand-ins that only make the same config unreadable, then exit zero or self-SIGTERM, make removal return `done: true`; permission repair proves its exact original bytes and server remain. An already-unreadable config also allows the explicit add stand-in to start before eventual refusal. The stand-in only records the real argv and exits; it never runs npx or a configured MCP server.

The cause is `claude-files.ts:25–33` collapsing unknown JSON reads to null, consumed as absence by `mcp.ts:267–298` and Claude presence checks at lines 422–430; the common removal verifier at line 178 accepts that apparent absence. Actual rows and repaired server identities are checked before the intended red assertions. Readable no-op refusal and actual empty removal pass, all 600 inherited/current source files stay exact, and the owned environment is removed. `claude-mcp-read-observation-proof.md` and its JSON pin the source, six outcomes and cleanup. This demonstrates owner inventory/verification failures in invented user-scope fixtures; it does not show real Claude CLI permission behavior, natural incidence, credential disclosure, authentication bypass or other scopes. No correction is included in alpha.11. Local/project/plugin scopes and legacy-file selection remain unverified. The two existing MCP feature rows are refined; the other 250 committed rows remain exact. The audit continues.


### Second alpha.11 CI result and stopped-session resize attribution

At exact commit `f63b20f371be231d8e83733fad3a68f3393c6b26`, both replacement CI runs passed **875/875 units**, both desktop/Phone sweeps and all **72 targeted browser checks**. Main [37771242135](https://github.com/DanePete/wanigan-2/actions/runs/37771242135) passed its complete gate: **79 surfaces, 1,740 controls, 51 shortcut keys, 29 checks, 1,374 actions; 1,433 passed, zero failed, 11 allowed, one guarded and 375 gone**. Review [37771241778](https://github.com/DanePete/wanigan-2/actions/runs/37771241778) failed its crawler: **79 surfaces, 1,740 controls, 51 shortcut keys, 29 checks, 1,379 actions; 1,437 passed, one failed, 11 allowed, one guarded and 370 gone**. Both secret scans passed. Their completed states/full logs and the review artifacts remain pinned in `alpha11-ci-second-result-de6omtmf`; the successful main run does not replace the failed review result.

The sole failed action was **Stop it**: the recorded effects include `sessions.stop` followed by `sessions.resize`, whose refusal was “This session has ended.” The surface name “Checkout button has no accessible name” is an invented session title, not the failure diagnosis. The prior crawler lacked session IDs, call-order attribution and a confirmed ended-state read for this refusal, so its historical failure is retained, not retroactively reclassified.

The four-path test-only correction records successful stop IDs/order and raw refusals. It qualifies only a `Stop it` button action’s later `sessions.resize` refusal with exact code/text for that same successfully stopped session, after an authoritative `sessions.get` confirms its ID, `ended` state and finite end timestamp. Missing/mismatched evidence, other RPCs/errors/actions, failed reads and still-live/failed sessions remain failures. The report retains the raw refusal, qualification and explicit counts; production application behavior, target identity and existing allowlists are unchanged.

A real owned Core/PTY case confirms successful live resize, owner stop and the unchanged ended-session refusal, preserved history, no remaining terminal and responsive owner. A controlled adapter preserving the prior crawler’s unconditional classification yields **two expected attribution failures and 21 passing cases**; the corrected module passes **23/23**. The overlapping session-safety/admission/harness neighbor run passes **33/33**, and Node typechecking exits 0. These final runs report zero skips/cancellations, actual exit 0, no signal/interruption and removed owned environments. The initial sandbox attempt hit Unix-socket EPERM in the Core case and is retained separately; it is not counted as the controlled Core reproduction. `alpha11-resize-attribution-files.json` and `alpha11-resize-attribution-evidence.json` pin the exact source and observed outcomes.

The replacement complete gate, runtime/artifact identity rebind, new commit and both exact-commit CIs remain pending at this checkpoint. The alpha.11 draft and its existing assets remain held. No alpha.12 correction or real provider execution is included here; the audit continues.


### Second corrected complete gate and native identity — local pass

The unfiltered `npm test` run `alpha11-resize-full-run-RCSMO7` completed with **actual exit 0**: typechecking, **898/898 units** (zero failures/skips/cancellations), desktop and Phone sweeps, and all **72 unique targeted browser checks** passed. Its crawler recorded **79 surfaces, 1,729 controls, 51 shortcut keys, 29 checks, 1,370 actions; 1,429 passed, zero failed, 11 allowed, one guarded and 368 gone before their turn**. The report preserves **six raw RPC refusals and zero stopped-session resize qualifications**. This complete run did not exercise the rare qualifying schedule; its behavior is separately established by the dedicated 23-case test. Gone controls remain unexercised. All 602 source hashes matched before/after, and the owned environment was removed without signal/interruption.

`alpha11-resize-full-verification-RCSMO7.json` pins the actual result, log and 338-file artifact archive. The retained `app-window.png` does not claim a new native capture. Fresh package and extracted-ZIP provenance each match all 109 built outputs and the unchanged ASAR `755e48a7ded80eb308ea3083514f97dacba4856c5ceb1d6d63faad3037c933e7`. The completed `alpha11-resize-native-rebind.json` rehashes 44 prior evidence/asset records, verifies each app/ZIP copy’s own 21 packaged native files/modes, and binds the unchanged DMG/ZIP assets to the 602-file source whose only four changes from f63 are test-only. This retains seven historical native observations; **no new native launch or DMG remount occurred**. The original platform/signing, real-provider, inactive-helper and unexplained README WebGPU limits remain.

The prior f1 and f63 failures remain separate historical results. This local full pass and identity rebind permit preparation of the next tested commit; the new commit, both exact-commit CIs, public release/download checks and website deployment are still pending. The source feature matrix remains all 252 rows unchanged by this correction. The audit continues.


## Alpha.12 candidate — Core startup, Git compatibility and MCP read state

This separate candidate draft is rebased onto alpha.11 commit `8833b319a2eaf10e10257a1ed51bac58f3221fe7`. Its complete **157,284-byte historical audit prefix** above is preserved exactly (SHA-256 `0204eae8131fc6bb6fea60f6027abff67637dcd2ab1ed54218f207ccfee21053`), including both previous CI outcomes, the stopped-session resize attribution correction and the successful 898-unit local gate/native identity checkpoint. Those are alpha.11 results and do not replace alpha.12 verification. The separate `alpha11-feature-proof.md` remains the exact committed baseline. No successful alpha.11 or alpha.12 publication is inferred.

The guarded alpha.12 fast-forward completed with the 17 selected path bytes and existing physical dependencies preserved. The new frozen source has **608 files**, based on 602 alpha.11 files with 11 replacements and six new tests; all 591 unselected baseline files remain exact. `alpha12-all-source-manifest-ci.json` pins SHA-256 `ffbefa07c36449cd5d5996a44fa09350207fc5b80e95ebd6c883b094b42947e4`. Version is `2.0.0-alpha.12`; no final release commit or publication is claimed.

The earlier 606-file source manifest `c5573306e01be860ddc641ed0a7d5b0069fd3ae31934c103a1e6e3aee771f8ae` remains the exact execution binding for the focused/type/install/dev/source-smoke, Git matrix and MCP UI results below. The rebase changes only the four alpha.11 crawler test/support paths and two documentation paths; it adds two files. All 17 alpha.12 selected files and all production application source bytes remain unchanged. These earlier outcomes retain their original binding. The read-only history rebind `alpha12-native-history-rebind-8833b319.json` (SHA-256 `bf066e69a0c93fce181ce84a3e334b698898008f6754e032016e5f9a7f307cfd`) rehashed all 608 source files, the identical 109 output paths/bytes and 97 evidence files, including all 76 MCP after-run files. It establishes applicability to the unchanged production code and outputs, not a new execution. The new full gate and five native stages below passed on 608. Exact-commit CI and publication remain pending.

The `core/mcp.ts` overlap remains alpha.11 `3ee90f87…` → Codex reader `3f49e6e1…` → incremental Claude reader `2127aa25…`. Both read-state test files and the one-word “found” headline remain included. Old union 12/13, the 606-file integration and all component records are preserved.

The [feature-proof addendum](alpha12-feature-proof.md) keeps all 252 feature rows and their limits. The component evidence below is useful red/green proof; overlapping neighbor counts must not be summed. Actual combined verification is recorded separately after the table.

| Finding and priority | Reproduction, source and reviewed correction | Observed proof and boundary |
| --- | --- | --- |
| P2: cancelled Core startup resumes after stop | Hold owned Phone startup or a native socket bind, stop, then release it. Baseline `core/core.ts` startup can publish stale info/timers; native bind completion can outlive released ownership. Future `core.ts:217–249` checks stop state around awaits; `server.ts:69–88, 114–125` retains bind ownership until actual close. Existing `sessions.beginStop()` remains first in shutdown. | Four genuine red cases on the corrected alpha.11 production baseline → four green; 43 selected cases and Node types pass. Replacement Core owner/socket/RPC outcomes and cleanup are asserted. No daemon crash, natural frequency, late 30-second callback failure or new bind deadline is claimed. |
| P2: older Git refuses protected diff reads | Actual Git 2.40 rejects production `--default-prefix`; staged counts become null and diff/history/draft/stash reads refuse. Future `core/git-commands.ts:13–15`, git-client/history call sites use command-scoped a/b prefix settings with the other safe read options. | The identical portable fixture fails on unchanged 2.40, passes corrected 2.40, and passes both unchanged/corrected 2.55. A 12-configuration command matrix passes. Actual paths/content, tracked/untracked stash, staged-only stand-in draft, hostile preferences, hook/secret refusals and exact state are checked. No support below 2.40 or all Git shapes is claimed; the prior 2.55 string-prefix stash failure stays historical. |
| P2: Codex unknown MCP reads look empty or falsely confirm removal | Actual owned EACCES, special/nonregular or failed post-command reads collapse to absence; a chmod-only exit 0/self-SIGTERM stand-in can falsely return done while the original server remains. Future MCP `has()` and `readToml()` retain unknown state via the bounded regular-descriptor reader and refuse verification. | Identical 16 cases: nine red/seven controls → 16 green; 29 with neighbors and Node types pass. Missing/empty/symlink/exact 4 MiB and genuine-removal neighbors remain. Parser-value disclosure is replaced by a neutral line number. No real Codex behavior or writer lock is implied. |
| P2: Claude user/local/project MCP read failures collapse to absence | User EACCES/malformed JSON reproduces false inventory/removal and premature add dispatch. Additional owned local/project cases establish the same unknown-state boundary. Future `core/mcp.ts:270, 303, 419–435, 523–544` adds an MCP-owned JSON reader, preserves error groups and refuses unknown pre/postconditions. | Identical 23 cases on unchanged Codex parent: 19 failures/four controls; 52 with neighbors and Node types pass with both audit evidence variables absent. Exact rows/config, named-account selection, repaired IDs, disabled plugin/project neighbors and terminal refusal are asserted. Shared Claude readers, plugin metadata and legacy-file selection are unchanged. |
| P2: literal defaults bypass owner-display masking | Invented `${NAME:-literal}` values appear in Claude/Codex arguments/env/headers, raw/encoded HTTP targets and an owned CLI error. Future `shared/mcp.ts` hides the whole containing value, recognizing one layer of ASCII percent bytes without evaluating variables. | Identical 13 regressions red → 29 new/neighbor passes and Node types pass. Plain references, ordinary values and prior literal-secret masks survive; configs stay exact and no listing CLI/session starts. This conservative masking can hide useful diagnostics and is neither shell parsing nor a universal secret detector. |

The independent source clone followed the README's literal `nvm install` and `npm install` in an owned fake environment (`alpha12-install-run-urfszR`, actual exit 0). NVM used the already installed fixed Node 22.23.2 tool through an owned version link; this is not a fresh Node download claim. Project dependencies were a new physical installation, not linked from alpha.11. Package/lock bytes and all other frozen source remained unchanged; the owned environment was removed.

The normal project runner, with both MCP audit-evidence variables absent, passed **150 focused tests: 33 Core/lifecycle, 70 MCP/shared/bounded-file, and 47 Git/workbench/shared cases**, with no failures, skips or cancellations. Node and web typechecks both exited zero. `alpha12-initial-verification.json` (`68c58570…`) binds these actual results. The separate actual Git 2.40.0 and 2.55.0 runs each passed the existing one-test owner fixture, with 121 observed Git invocations and 14 command-scoped prefix calls per run. `alpha12-git-matrix-proof.json` (`50bd7076…`) pins the binaries, outputs and unchanged 606 source files. Staged-only commit/draft behavior, secret and normal-hook refusal, readable diff/history/stash content, and unstaged/untracked preservation were asserted. A deliberate commit may normalize the index TREE cache; the exact staged entries remain preserved. The first 2.40 matrix launch failed at owned Unix-socket listen with sandbox EPERM; that failure is retained, and the unchanged helper passed after execution escalation. No unmeasured Git version or external-writer exclusion is claimed.

README `npm run dev` (`alpha12-readme-dev-run-KAQQIJ`) and `npm run smoke:app` (`alpha12-source-smoke-run-wX77wT`) each exited zero without interruption and removed their owned environment. Dev rendered its assets and answered through the isolated bridge. Source smoke built the actual 109 outputs and exercised the real owned terminal/CLI, native menus and power blocker, fixture updater consent/download, quit-with-live-session confirmation, detached Core persistence and unavailable-Core recovery. These two observations retain their historical 606 source-native binding; they are separate from the five new native stages below. Historical alpha.11 native results do not certify alpha.12 artifacts. Dev teardown GPU/network-service diagnostics do not establish successful WebGPU behavior.

The fresh production dependency audit exited zero with no reported vulnerabilities. The full dependency audit exited one with eight moderate entries in the existing build/development chain (`sprintf-js` and dependents), no high/critical entries. Both actual JSON results and command outcomes are pinned. No blind dependency upgrade was applied. The new package/ZIP/DMG inventories separately establish absence of those eight dependency directories from the ASAR tree; neither result proves absence of every vulnerability or every reachable advisory.

Actual before UI remains exact f63/109-output run `future-mcp-ui-before-r2w0Xl`: 24 known-before outcomes and 48 images. The first authorized after run `future-mcp-ui-after-zmsnAJ` then passed **24/24 cases and produced 48 hash-verified PNGs** against the exact 606-file alpha.12 source and actual 109 built outputs. Root changed only its own ordering to allow this capture after focused/types/dev/source-smoke and before the full gate. The new full gate below subsequently passed before packaging; the earlier UI capture does not replace it. All 24 owned core/gateway cleanups exited zero; the outer environment was removed. No interruption, timeout, blocked request, unexpected request or session launch was recorded. Ten exact argv-checked stand-in calls (two diagnostics, eight removals) ran. No installed provider, configured MCP server or remote target ran.

Both themes show masked invented fallback arguments/env/headers and raw/encoded HTTP targets/CLI diagnostics, neutral Codex parser errors, scoped unreadable/invalid Claude and Codex notes beside healthy rows, and a retained removal dialog when verification becomes unreadable. Repair restores the same server ID. The initial headline says **3, 5 or 2 servers found**, matching the initial actual owner listing. Under an open removal-refusal dialog the cached three rows remain, while a fresh owner inspection sees two readable rows plus a failure note; both states are recorded separately and no forced reload removes the dialog. Healthy neighbors mean no zero-row headline case was executed. Broader Claude local/project outcomes are core-fixture evidence, not extra UI cases.

All 24 after viewports and 24 after affected crops were individually inspected. A second reviewer compared all 24 affected before/after pairs. No new material visual issue was observed. The [durable selection](#alpha12-durable-mcp-ui-selection) below retains eight before and eight after viewport PNGs; full capture manifests remain in audit evidence. Static images are not separate keyboard-only, screen-reader, real-provider or universal masking proof.

### Alpha.12 full and native verification

The unfiltered `npm test` run `alpha12-full-run-QqPYdB` closed with **actual exit 0**, no signal or interruption, both 608-file source guards passing and the owned environment removed. `alpha12-full-verification-QqPYdB.json` pins SHA-256 `fcd80274825e420ee9c3ac0652c22e2b676774bd42b027a14620983bf9070e26`. Typechecks and **955/955 unit tests** passed with zero failures, skips or cancellations. Desktop and Phone sweeps and **72 unique targeted browser cases** passed. The crawler recorded **79 surfaces, 1,728 controls, 51 shortcut keys, 29 checks and 1,369 actions: 1,428 passed, zero failed, 11 allowed, one guarded and 368 gone before their turn**. Its six raw RPC refusals needed zero stopped-session resize qualifications. The 338-file artifact archive is retained; any inherited `app-window.png` is not represented as recaptured by this full gate.

The native verification comprises **seven observations with two different execution bindings**. The first two are the historical 606-file runs, retained through the byte-identity rebind above. The remaining five ran freshly on frozen 608-file source after the full gate. Every listed run exited zero, recorded no signal/interruption and removed its owned environment.

| Observation | Actual run | Execution binding |
| --- | --- | --- |
| README dev | `alpha12-readme-dev-run-KAQQIJ` | Historical 606/c557; unchanged production/109-output identity rebound to 608 |
| Initial source smoke | `alpha12-source-smoke-run-wX77wT` | Historical 606/c557; unchanged production/109-output identity rebound to 608 |
| Package | `alpha12-package-run-Bgf9Ej` | New 608/ffbefa execution |
| Required source smoke after packaging | `alpha12-source-smoke-run-P3DZe9` | New 608/ffbefa execution; source native restoration exercised |
| Packaged-app smoke | `alpha12-packaged-smoke-run-4Z1yd2` | New 608/ffbefa execution |
| Freshly extracted ZIP smoke | `alpha12-zip-smoke-run-vu0dPg` | New 608/ffbefa execution |
| Read-only mounted DMG / Help Demo | `alpha12-dmg-run-IWemmE` | New 608/ffbefa execution |

`alpha12-native-verification.json` (SHA-256 `4ab91943b7319c25d6c0eb4f22297cd752694fa37c704269939565883ebeacaf`) pins the five new runs, 40 evidence files and assets. All 608 source files, the 17 selected dirty paths and empty Git index remained exact; no final docs were transferred during native verification. The actual package, freshly extracted ZIP and read-only mounted DMG each match **109 source build outputs** and ASAR SHA-256 `54d21d43fd61e2a097cb778ed0664abd849608992a16068ba24b3bd4d4707674`. Their **21 native-file records** match one another in path, size, mode and hash. The bounded native-selection probe actually selected `node-pty/build/Release/pty.node` and `spawn-helper`, both mode 755, under packaged Electron 44.3.0/Node24.20.0 on arm64. Two inactive non-executable fallback helpers are inventoried without claiming they can execute. Signed packaged native bytes are not required to match restored source-native dependencies.

All three strict/deep signature checks passed. The native host was **macOS 26.5.2, build25F84, arm64**. Signatures are ad-hoc and notarization was explicitly skipped; this is not clean-machine Gatekeeper or macOS13 compatibility evidence. Source/packaged/ZIP smoke exercised owned terminal/CLI, menu and power-blocker behavior, fixture updater consent/download, quit-with-live-session confirmation, detached Core persistence and unavailable-Core recovery. Fixture network assertions do not imply live provider or public updater service success.

The mounted app's actual **Help → Open the Demo** action opened a second app with three sample projects and one session in owned temporary demo data; the parent project list stayed empty. The new 2880×1800 screenshot `alpha12-demo.png` (SHA-256 `482d1d44b960e1b0e11df54d3df7af0d8aaf4aa3ffd7b7c14269310881b83649`) was visually reviewed by the executing agent and root: clear demo banner, sample projects/session and no material clipping. It is separate from historical full-gate images. The helper detached only its owned disk5; the detach log says ejected and the mount path is no longer mounted and is empty.

| Prepared alpha.12 asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `Wanigan-2-2.0.0-alpha.12-mac-arm64.dmg` | 161,039,763 | `335e6f93976e3696ae4041085e5efd9013d219ba82fdf9f94d91f0c3ff1ecbc9` |
| `Wanigan-2-2.0.0-alpha.12-mac-arm64.zip` | 143,202,912 | `73db76d292932377fb23063eae6a5b0e8d03f65f7b86251f5063069e0731dc3f` |

The ZIP asset is byte-identical to the package output used for the fresh extraction. These are verified local assets; public upload/download identity and a published release are still pending.

The credential-free Gitleaks scan of the **exact 17 selected source files** exited zero with no findings; source and copied bytes matched afterward. Its result `alpha12-selected-gitleaks-84a8z8sd/result.json` has SHA-256 `bbfa5ba1983db29887acd1f9e0de3523df033908c15c471d60f6c6073069c993`. Default rules, no baseline/ignore file and ignored inline allow comments were used. This directory scan covers neither Git history nor these final docs. The full-history scan after the final commit remains pending and no secret-free guarantee is claimed.

### Alpha.12 durable MCP UI selection

Each row links both themes of the same before/after scenario. These are original, unedited capture bytes. The before removal viewport contains the false Removed toast; the after viewport contains the retained verification-refusal dialog.

| Scenario | Before dark / light | After dark / light |
| --- | --- | --- |
| Fallback masking, 960px | [dark](alpha12/mcp-before-960-dark-fallback-list.png) / [light](alpha12/mcp-before-960-light-fallback-list.png) | [dark](alpha12/mcp-after-960-dark-fallback-list.png) / [light](alpha12/mcp-after-960-light-fallback-list.png) |
| Codex malformed read, 1440px | [dark](alpha12/mcp-before-1440-dark-codex-malformed.png) / [light](alpha12/mcp-before-1440-light-codex-malformed.png) | [dark](alpha12/mcp-after-1440-dark-codex-malformed.png) / [light](alpha12/mcp-after-1440-light-codex-malformed.png) |
| Claude permissions, 960px | [dark](alpha12/mcp-before-960-dark-claude-unreadable.png) / [light](alpha12/mcp-before-960-light-claude-unreadable.png) | [dark](alpha12/mcp-after-960-dark-claude-unreadable.png) / [light](alpha12/mcp-after-960-light-claude-unreadable.png) |
| Claude removal refusal, 960px | [dark](alpha12/mcp-before-960-dark-claude-remove-unreadable.png) / [light](alpha12/mcp-before-960-light-claude-remove-unreadable.png) | [dark](alpha12/mcp-after-960-dark-claude-remove-unreadable.png) / [light](alpha12/mcp-after-960-light-claude-remove-unreadable.png) |

Baseline/source reconciliation, the 608-file full gate, five new native stages and isolated documentation reconciliation are complete. Required next work is the final commit and full-history secret scan, exact-commit CI, public asset verification and tested alpha.12 website update. The selected-file scan, focused pass and historical/UI observations do not substitute for those remaining gates.

Remaining limits include process-exit versus in-process startup reachability, repeated startup/native-bind deadlines, external Git/config writers, versions outside the two measured binaries, aggregate config enumeration/parsing memory, plugin and legacy-selection reads, malformed nested schemas, unsupported/recursive encodings and other heuristic redaction gaps. Real provider/MCP/Phone integration, clean macOS13 Gatekeeper, other OS/architectures and WebGPU lifecycle remain unverified. The audit continues.


### Alpha.12 CI Phone replay assertion correction

The first alpha.12 commit `6c59b38e95b215d574d0ccad8170d4cdd40dc7fc` was pushed to both branches. Main CI [37796320765](https://github.com/DanePete/wanigan-2/actions/runs/37796320765) failed with **954/955 unit tests passing, one failure and zero skips/cancellations**; its secrets job passed. Review CI [37796321071](https://github.com/DanePete/wanigan-2/actions/runs/37796321071) was still running at this checkpoint. The failed main unit stage supplies no new full-gate or crawler pass.

The failure was the immediate `replay.includes('must-not-run')` assertion at `src/renderer/src/phone/bridge.test.ts:125`, in the lost-input-response test. The preceding cancelled-Enter, no-suffix/no-retry and absent command-file assertions passed. `core/handlers.ts:296` acknowledges the synchronous PTY write in `core/sessions.ts:543–546`; echo arrives later through `child.onData`/`output` at lines 489 and 1080–1091. `replay()` at 573–577 drains already-delivered data. A successful HTTP acknowledgement therefore does not establish that a subsequent immediate replay already contains the echo. No production regression is established by this failure.

The single test-only correction replaces that one-shot read with the existing `waitFor` helper, the same `must-not-run` predicate and the existing **2,000 ms** fixture bound. It preserves every other assertion and changes no production behavior. In two isolated controlled copies, the same adapter held the selected shell's actual PTY chunks, obtained the first real owner replay containing only the existing prompt, then delivered the captured chunks through the original callback. No echo or reply was fabricated. The original assertion failed (**0/1, exit 1**); the condition wait passed (**1/1, exit 0**) including deliberate-reload recovery. This establishes the missing ordering barrier; it does not reconstruct GitHub's exact native scheduling.

The uninstrumented bridge test file then passed **11/11**, zero failures/skips/cancellations; Node and web typechecks each exited zero. All five runs retained before/after guards for 625 frozen files, removed their owned environment and recorded no signal/interruption. The 625-file test candidate changes only `bridge.test.ts`; the other 624 files remain exact. `alpha12-phone-echo/verification.json` pins these actual outcomes at SHA-256 `edae671bbef7cf154fe28acef86a3e41650c3f53add9f0d4a4a06ed5d0684619`; the one-file patch is `03cd2eeb07b1fcee6c63e99d5aa0e46f31b226f68c51f30c844c43d36ae19851`. The controlled adapter is separate evidence and is not shipped.

The original failed CI and the earlier 608-file full/native execution bindings remain historical evidence. **A corrected full local gate, final correction commit and new exact-commit CI are pending** at this checkpoint. Production outputs/native assets require a byte-identity rebind before reuse; these focused checks are not new packaging or native execution. Alpha.12 publication and its website deployment remain pending. The audit remains open.

### Open P2: skill-copy approval does not bind source content

A separate owned-fixture observation on `6c59b38e…` found that `core/skills.ts:119–121` hashes source/destination, relative paths, byte sizes and rounded modification times, but not source contents (`walkForCopy`, line 457). After previewing an 11-byte `notes.txt`, changing it to different 11-byte contents and restoring the rounded mtime leaves the plan ID unchanged. Applying the earlier approval returns `done: true` and `copyFileSync` at line 145 writes the changed bytes. The unchanged control passed; the stale-approval refusal assertion failed: **one pass/one failure, actual exit 1**. Both observations used owned fake projects; all 625 source files remained unchanged and the environment was removed.

`skills-copy-consent-observation.json` (`76d6cbb234e69bbef9fd148c85dde3911c566dadc5beb745050bba212c10c0b5`) and independent source/log review `skills-copy-consent-peer-review.json` (`51c95f4667bd3dabbb6b96786b5f8f1f850a380e5edf2487316dad4472904b98`) confirm this P2 consent gap. The edit precedes re-preview and apply; no after-final-check race is needed. No path escape, remote compromise or arbitrary execution is established. A fix remains outside this alpha.12 production batch. The feature matrix's Copy and remove row is qualified as partial while preserving its overwrite-refusal and trash evidence; no other feature row changes.

## Alpha.12 corrected verification, release and website completed

This continuation preserves every byte of the **180,838-byte audit prefix** committed at `feaf446664e5bd341e58f5d82f1e8a276fad108d` (SHA-256 `52ef69630d8b317db15cff3e8742fe5f611c758859c78e84cb2732db5df103d4`). Earlier pending statements remain historical checkpoints. The original alpha.12 main failure and all prior native/full-gate observations are retained; none is relabelled as a new run.

The Phone test correction was committed at `feaf446664e5bd341e58f5d82f1e8a276fad108d` and pushed without force to both branches. The corrected local full gate and both new remote CI runs ran in parallel. The new unfiltered local `npm test` passed **955/955 unit tests**, desktop and Phone sweeps and **72 unique targeted browser cases**. Its crawler recorded **79 surfaces, 1,730 controls, 51 shortcut keys, 29 checks and 1,371 actions: 1,430 passed, zero failed, 11 allowed, one guarded and 368 gone before their turn**. Six raw RPC refusals required zero stopped-session resize qualifications. The 338-file archive, unchanged 625-file source guards and owned cleanup are pinned by `alpha12-ci-full-verification-2OEw5n.json` (`071f881100cb2bb459527a4c94eda553eb095698f1de2eb6cc288016ad8def07`).

The original tool wrapper disconnected while its owned test process continued. The actual npm exit **zero** was recorded by a macOS process-exit observer for that known PID, followed by source/output and cleanup verification. The original wrapper's exit status remains unobserved. No stage was rerun or assigned a successful exit from log text alone. The observer's child-exit/signal encoding controls and original pending receipt are preserved.

Both exact-commit CI runs completed successfully, including their secrets jobs. Each independently passed 955/955 units, both sweeps, 72 unique targeted cases and a zero-failure crawler:

| Branch and actual CI | Crawler passes / failed / gone | RPC refusals / qualified resize refusals |
| --- | --- | --- |
| [main 37804270659](https://github.com/DanePete/wanigan-2/actions/runs/37804270659) | 1,434 / 0 / 375 | 6 / 0 |
| [codex-review 37804270675](https://github.com/DanePete/wanigan-2/actions/runs/37804270675) | 1,431 / 0 / 375 | 6 / 0 |

The seven native observations remain historical executions on their 606/608-file bindings. Fresh verification on corrected 625-file source matched all **109 rebuilt production outputs**, the existing package/ZIP ASAR (`54d21d43…`), and 21 native-file hashes/modes per copy. Complete DMG/ZIP identity binds the earlier mounted-DMG observation. `alpha12-ci-native-rebind.json` (`2187457d4be60e35e9f530ecb3c059c7d7124b091c166226ab56db453f855fac`) records this evidence rebind, **not new native execution**. The full-history Gitleaks scan covered 203 commits and exited zero with no findings. The previously recorded production dependency audit remains zero reports; eight moderate development/build entries remain, with those package directories absent from the packaged inventories. Ad-hoc signatures are not notarization or clean macOS13/Gatekeeper proof.

The existing alpha.12 draft and its two uploaded assets were updated and published, without creating a duplicate release. The actual public tag [v2.0.0-alpha.12](https://github.com/DanePete/wanigan-2/releases/tag/v2.0.0-alpha.12) resolves to `feaf4466…`. Fresh **unauthenticated** full downloads each returned HTTP200 and the exact tested size and SHA-256:

| Published asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `Wanigan-2-2.0.0-alpha.12-mac-arm64.dmg` | 161,039,763 | `335e6f93976e3696ae4041085e5efd9013d219ba82fdf9f94d91f0c3ff1ecbc9` |
| `Wanigan-2-2.0.0-alpha.12-mac-arm64.zip` | 143,202,912 | `73db76d292932377fb23063eae6a5b0e8d03f65f7b86251f5063069e0731dc3f` |

`alpha12-publication-verified.json` (`ae6699bc46cb0fcbea55463f8bcae718db3494f4351511df89ac0e45021d35d2`) records those observations. The public release notes explicitly retain the unfixed Skills copy-consent and nested MCP issues; this publication does not claim their later corrections are shipped.

The tested website update was committed at `8c4cd2ed1f04a48c9be297c3a02249b09288b596` and deployed to [wanigan.ai](https://wanigan.ai) as Cloudflare version `2f90b054-6cab-4466-85a2-a0c93c1b8cc7`. The one-file change preserved the owner's Phone additions, other tracked source and videos. The production deployment used the tested build and production configuration; no local compatibility override was deployed. All **eight live stages exited zero**, including **459 functional checks**, mobile/archive checks, HTTP resources/redirects, and two full public video downloads plus HTTP206 range responses. All **36 fresh live images** were individually reviewed, alongside the 72 local before/after images; the before images were explicitly reused historical local alpha.11 after captures. Four fresh release/download images were additionally inspected by root. Mobile link clicks use fixture responses; the app asset hashes above came from separate real public downloads. Screenshots alone do not establish video playback, provider behavior or real Phone/Tailscale operation.

`alpha12-site-phone-live-final.json` (`f74e784c6d8a578e86202b52ac6737322f579f4573dba98a314b45bc6e0c962b`) binds the successful durable live-runner exit, all eight stages, visual review and owned cleanup. `alpha12-publication-and-site-deployment.json` preserves the earlier deployment checkpoint while that live verification was still pending. **Alpha.12 release and website publication are complete; the broader audit remains open.**

## Alpha.13 focused candidate — Skills consent and nested MCP read state

This next batch is prepared separately from published alpha.12. Combined focused/typechecks and its actual production build have now passed; its 12-case corrected MCP capture and visual review have also passed. The combined full gate, native/package checks, exact-commit CI and publication remain pending. Its [feature-proof checkpoint](alpha13-feature-proof.md) distinguishes component evidence from those pending release gates. The separate root integration includes the version/README update; this documentation preparation does not write those files or the original checkout.

### Skills copy: bind the approved output and retain the captured bytes

The confirmed same-size/restored-mtime issue above is addressed in an isolated two-path candidate: `core/skills.ts` and `core/skills-copy-consent.test.ts`. The real owner `skills.copy` seam now captures bounded regular-file bytes, fingerprints their SHA-256 plus effective modes, copied directory paths and skipped entries, and copies the same retained buffers after approval. Read/listing errors refuse instead of fabricating an incomplete tree. The copy walk enforces **1,000 files, 25 MiB, 4,000 entries and the existing depth rule** while reading. Selected top-level linked skills remain supported; internal links remain skipped.

Initial incremental content, metadata and traversal regressions failed before their corresponding corrections and passed afterward. The final original-source comparison ran the first ten tests against unchanged `feaf4466…`: **two controls passed and eight assertions failed**, actual exit1. That comparison ran after the initial green slices and is not represented as their earlier red run. The final revised candidate passed **27/27 new and neighboring tests**, zero failures/skips/cancellations, plus Node typechecking. Thirteen tests are new; neighbor counts overlap older proof and are not added to a release-suite total.

Independent review identified an introduced permission window in the first candidate: the new path-based write created mode0644 under the fixture umask before chmod. A real filesystem-boundary regression observed that mode and failed; the correction opens an exclusive mode0600 descriptor, writes the captured bytes, applies the approved mode with `fchmod` on that same descriptor and closes it in `finally`. The regression then passed, preserving actual bytes and the final mode0640. The earlier sandbox-only Core-socket EPERM is retained separately and is not counted as a behavioral red.

Two further owned directory-swap assertions failed before canonical-path and dev/inode checks were added around enumeration and bounded file capture, then passed. One replaces a traversed directory with a link and checks refusal before any outside-file open; the other changes a directory identity during file capture and checks refusal. These checks detect the exercised changes; pathname checks cannot exclude an external writer swapping and restoring an ancestor between syscalls. They do not provide a general atomic source-tree snapshot. Existing destination replacement fingerprints, overwrite races and restoration/rollback semantics remain unchanged. Preceding skill discovery/measurement is not made globally bounded by the copy-walk cap.

`skills-copy-fix-revision2-evidence/verification.json` (`f9226c40fe161bc06c91ad677fd9ad15124049fc9762873738ea4ba499b72d67`) pins the actual red/green/type results and qualifications. The two selected source hashes are `337a5014…` and `8e12e446…`; all 625 frozen alpha.12 files and 624 unselected candidate files remained exact. The first candidate's source preimages, patch and results remain preserved. Independent review (`skills-copy-fix-revision2-peer-review.json`, `ba0935d58eca9cd2c29eb2bef0062f65bc1798d4e9dbcd8af233d2953609c12f`) found no blocking issue in this revised scope. No full/UI/native/CI result is inferred from these focused passes.

### MCP nested schema correction — scoped unknown state and safe row formatting

The separate two-path MCP candidate changes `core/mcp.ts` and adds `core/mcp-schema.test.ts`. Missing collections and actual empty mappings remain known absence. Explicit arrays, nulls and scalars instead retain unknown-state notes. Claude user/local/project and Codex user/project fixtures verify scoped groups beside independent healthy rows. Invalid server rows and non-string argument values are omitted with fixed notes, preserving healthy rows from the same file without coercing malformed objects through `String`. The tested invented invalid values do not appear in owner replies; this is not a general secret-redaction proof.

Add preflight and add/remove postchecks validate the relevant raw collection and target row, rather than using a filtered list as evidence of absence. Owned assertions show unknown preconditions start no CLI; a zero-exit stand-in that writes an invalid added row cannot certify success; malformed collections or retained invalid target rows after removal refuse; actual empty-map removal still succeeds. Claude local checks inspect both configured path aliases before deciding, so a known row cannot hide an unknown other alias. The stand-in's actual file changes remain visible when postcheck refuses: refusal is not rollback.

The original **16-case owner-RPC comparison** on unchanged `feaf4466…` yielded **two healthy passes and 14 failures**, actual exit1. Its first corrected **50/50** result and exact source preimages remain historical. The final revision adds one plugin compatibility fixture, for **17 new tests**, and expands the neighbor selection to include existing Claude-read and shared-fallback cases. That final component run passed **85/85**, zero failures/skips/cancellations; Node and web typechecks each exited zero. These are component counts, not a combined alpha.13 total. Before/after source guards passed and owned environments were removed. No real provider, configured MCP server, credential, model or remote target ran.

Review raised a possible duplicate-pair concern in the candidate's plugin map roundtrip. Source inspection established that the current plugin selector returns **one mapping**, so that proposed duplicate-pair case is not reachable; no confirmed duplication bug or new red test is claimed. The unnecessary roundtrip was removed to preserve direct original pair iteration. A healthy-neighbor fixture verifies declared-source selection, two installed plugins with the same displayed name but distinct server IDs, valid siblings and invalid-argument notes with zero CLI calls. Plugin path/manifest/legacy selection and containment remain unverified beyond that explicit fixture.

`alpha13-mcp-schema-xw78ruo7/verification-v2.json` (`f609a8eda045b63c802f200609c3fd0f49366fa3ca2eb791e3ecd702b46e43b1`) pins the final source and actual results. The selected source hashes are `f3bc1abc…` and `03fe5893…`. Independent review (`alpha13-mcp-schema-revision2-peer-review.json`, `646a40cac4ee1c4bb89368cef24dfddd7bd3eb1eb34918cf0abac4c8d5364f20`) found no blocking issue in this scope. All 625 published source files remained unchanged; the isolated component changes only the named production file and new test. Other MCP field coercions, unsupported schema shapes, broad masking/encodings and aggregate work/transient allocation remain open. No full/native, CI or publication result is claimed.

### Alpha.13 integrated focused checks and production build

The root's isolated integration binds **627 files and seven selected paths** on `feaf4466…`: four Skills/MCP production/test paths plus README/package/package-lock version metadata. All 620 unselected baseline files remain exact. `alpha13-code-source-manifest.json` has SHA-256 `01fd1197ff29f2dbeddcdc4ed4980cb509679bb71a1fbc7cabda2d983ac83c07`. Dependencies are an independent physical copy of previously tested dependencies; no fresh installation or dependency audit is claimed for this step.

The actual combined run `alpha13-integration-focused-KmOmTf` passed Node and web typechecks followed by **112/112 tests**, zero failures/skips/cancellations. Its result is `a2b8525bdbe9d0226603f3acf0326c367f0f57a84cfa9a06b162490161a4855a`. The literal production build `alpha13-integration-build-Uh86Ab` then exited zero and inventoried all **109 actual outputs**, result `a8d95562ab9376945c49fabae294895110be3a384bbf866c0dcb7fadd9d14006`. Both runs retained source/helper guards, recorded no signal/interruption/deadline and removed their owned environments. This build and focused union are distinct from the unfiltered full gate and native packaging that remain pending.

### Alpha.13 actual MCP before/after presentation proof

The exact published-alpha.12 before capture `alpha13-mcp-ui-before-Ns6w6T` exited zero for **12 known-before cases and 24 fresh PNGs**. Its source/output identity is pinned to feaf625/109; no new before build is claimed. An earlier unprivileged attempt stopped before any gateway/Core case because Chromium's macOS MachPortRendezvous registration was denied. That zero-case/zero-image failure and its owned state remain retained; the same helper passed after scoped execution escalation. It is not counted as a behavioral red.

The corrected after capture `alpha13-mcp-ui-after-7jVHza` then passed **12/12 cases with 24 fresh PNGs**, bound to the actual **627-file integration and 109 newly built production outputs** above. The wrapper and durable supervisor each observed actual exit zero; source/output guards and owned cleanup passed. These are three actual Core scenarios × dark/light × 1440/960 widths. The bridge forwarded real owner replies and errors unchanged; only owned input files, the explicitly inert CLI and native app-state metadata were fixtures. No DOM or MCP result was substituted.

Before, an array-valued server collection appeared empty; an invalid argument object rejected the whole listing and hid a healthy row; and a zero-exit stand-in that wrote an invalid collection caused false removal success. After, the collection displays a scoped unknown-state note, the valid same-file row survives invalid arguments beside a fixed note, and the removal dialog retains the actual verification refusal with no false-success toast. Each stage ran exactly four selected stand-in removal calls, zero sessions and no provider/model/real-MCP operation. DB rows, owned config bytes and cleanup were checked. There were no unexpected or blocked browser requests in either successful capture.

The headline was recorded rather than treated as exhaustive inventory: the after invalid mapping says **0 servers found** beside the unknown note; the invalid-arguments case says **1 server found**. After removal refuses, the dialog backdrop retains the initial **two cached rows/count**, while a fresh owner read reports the malformed collection with a note. The CLI's owned file write was not undone, and no forced reload was used to erase the dialog.

All **48 original before/after PNGs** were individually inspected, with no new material visual blocker observed. Root additionally viewed six representative images, including the narrow dark full before-removal viewport containing the false toast. The before review is `alpha13-mcp-ui-before-visual-review.json` (`b82c4bea7474affc5b5b4ac280e7c4910b0a6bb8e536439ee7961b3585909091`); the final after/comparison review is `alpha13-mcp-ui-after-visual-review.json` (`50eea7def43528ccd3c64dcfb1b532c7d5343144238868fb13de5607f05c466b`). Static images do not establish keyboard-only, screen-reader, real-provider or broader schema behavior.

### Alpha.13 durable MCP UI selection

These **12 narrow affected-area crops** retain the exact original bytes in both themes. The selected before-removal crop shows the resulting empty state but **omits the false success toast**; the full viewport and actual owner-RPC evidence remain pinned externally. Do not cite that crop alone as toast evidence. The after-removal backdrop is cached data, not rollback proof.

| Scenario at 960px | Before dark / light | After dark / light |
| --- | --- | --- |
| Nested collection unknown state | [dark](alpha13/before-960-dark-nested-mapping-affected.png) / [light](alpha13/before-960-light-nested-mapping-affected.png) | [dark](alpha13/after-960-dark-nested-mapping-affected.png) / [light](alpha13/after-960-light-nested-mapping-affected.png) |
| Invalid arguments preserve a healthy row | [dark](alpha13/before-960-dark-invalid-arguments-affected.png) / [light](alpha13/before-960-light-invalid-arguments-affected.png) | [dark](alpha13/after-960-dark-invalid-arguments-affected.png) / [light](alpha13/after-960-light-invalid-arguments-affected.png) |
| Removal refuses an unverifiable result | [dark](alpha13/before-960-dark-remove-nested-mapping-affected.png) / [light](alpha13/before-960-light-remove-nested-mapping-affected.png) | [dark](alpha13/after-960-dark-remove-nested-mapping-affected.png) / [light](alpha13/after-960-light-remove-nested-mapping-affected.png) |

### Remaining audit work and release gates

The component corrections remain candidates until combined verification and publication. Remaining audit work includes aggregate History/config enumeration and memory bounds, plugin/legacy selection and containment, unsupported schemas and heuristic redaction encodings, cumulative evidence/attachment/checkpoint storage, external Git/config/filesystem writers, real provider/MCP/Phone/device behavior, clean minimum-macOS Gatekeeper and other OS/architectures, and WebGPU lifecycle. No automatic deletion of evidence is proposed. The audit is not finished.

## Alpha.13 CI fixture correction and controlled proof

This is an appended checkpoint; all preceding audit evidence and qualifications
remain unchanged. Original alpha.13 commit
`a06d11ab1d342534a40643ac943d27f02525a8fe` completed the unfiltered local full
gate with actual npm and durable supervisor exit zero. It passed **985/985
units**, desktop and Phone sweeps and all **72 targeted cases**. The crawler
recorded **1,428 passed, zero failed, 11 allowed, one guarded and 368 gone before
their turn** across 79 surfaces, 1,728 controls, 51 shortcut keys, 29 checks and
1,369 actions. Gone controls remain a coverage gap. Six raw RPC refusals were
recorded; none qualified as resize refusals. All 640 source-file guards and
owned cleanup passed. The 337-file, 105,899,401-byte artifact archive was
preserved, including the qualification that a retained `app-window.png` is not
proved freshly captured. Dependencies were an independent physical copy; no
fresh install is claimed. This is a historical pass of the original source,
not a pass of the correction below.

### CI failure and evidence boundary

The original codex-review CI run `37816570156` at that same commit passed 985
units, then failed at `scripts/ui-sweep.mjs:550` because the
`.drawer .merge-conflict` element was absent. Earlier prerequisite failures
were caught into an array; a later bare `$eval` obscured them before that array
was reported. The archived 37 CI images precede the fatal failure and do not
show its final DOM, bridge state or accumulated prerequisite failures. The
original CI's exact event ordering remains unknown. A successful local run
does not override this failed CI gate.

The source exposes a fixture-ordering assumption: after replacing the session
list response with a filtered fixture, the sweep performs hash-only close and
reopen navigation without observing drawer detachment. The router reads the
current hash when the native event runs. If both queued events see the final
route, the existing drawer and unchanged session-query key can survive;
replacing the bridge response alone does not refetch that query.

### Controlled proof and narrow correction

A bounded probe used the actual renderer, seeded Core and unchanged explicit
merge-reply fixture. Two native hash writes in one task controlled the timing;
no synthetic DOM or custom hash event was used. In **both dark and light
themes**, the old drawer identity remained, there were **zero fresh filtered
session queries and zero merge calls**, and the original **five-second action
timed out** because Merge remained disabled. This expected timeout is an
assertion inside an overall successful diagnostic run, not a failed Node
test-suite exit. It demonstrates a mechanism consistent with the CI failure;
it does not reconstruct that run's unrecorded scheduling.

After the probe observed actual drawer detachment, reopening produced a new
drawer and one fresh filtered session query per theme. All original conflict
text and action-label assertions passed, followed by resolution RPC arguments
`false` then `true` and the expected Changes route. The wrapper, probe and owned
gateway each exited zero, source guards covered **640 baseline files, 640
candidate files and 109 built outputs**, and owned cleanup passed. No browser
errors or unexpected requests were observed. All four 1440×900 screenshots
were individually inspected, showing the stale disabled action and fresh
conflict actions in both themes with no material visual blocker. The replies
are the sweep's existing explicit fixture; these observations do not prove a
real Git merge or a production merge defect.

The selected `scripts/ui-sweep.mjs` correction awaits actual drawer detachment
before reopening. It also records prerequisite diagnostics and rethrows the
original failure. Existing five-second action waits, conflict assertions and
merge-reply fixtures remain intact. The other 639 source paths and all renderer
outputs were unchanged in the diagnostic candidate. No real provider, model,
credential or MCP operation was used.

| Evidence record, retained under `/private/tmp/wanigan2-review` | SHA-256 |
| --- | --- |
| `alpha13-full-verification-DW01J8.json` | `614ef30be5f075395bc54e0fc8fc1d8edf1cf39155274f7a81a57d95913e779c` |
| `alpha13-full-artifacts-DW01J8-manifest.json` | `d6df4d144fe25e32d8f02927c8b606218524e49182a2f54c1768742f6cf9a3f7` |
| `alpha13-ci-review-failure.json` | `3eaf55f44526be0e3aef029d8976bb09249c973bdece85a625e71b4907b8b17e` |
| `alpha13-ci-review-failure.log` | `3d14abcd4bec1e38ce4e78a283482c88e8d35ddfcc14c1dfefd64e3e4a4d0569` |
| `alpha13-ci-review-artifacts-inventory.json` | `97b3416d426288d7a1de6d0b87117c9244534c162082317aad658fe0e11abd39` |
| `alpha13-ci-merge-diagnosis-j2803qoi/verification.json` | `49c6dce163afc8e85f620436266d44d7c7ee24dbb1b1a150be91c052329433bb` |
| `alpha13-ci-merge-diagnosis-j2803qoi/run-TPECcZ/proof.json` | `359482739147829e18d931cfd3dd4aaca8f3e5561fd3e79fcdf692ec66e1c2e7` |
| `alpha13-ci-merge-diagnosis-j2803qoi/run-TPECcZ/result.json` | `d3bbb5401350fc394d6bc8fb746e43efa8a5c2eb377e975a32247748bb1f2b6c` |
| `alpha13-ci-merge-source-helper-peer-review.json` | `97a4ea53a044b473cccc123bebf69c294159e1ca7274f85a6db2054e12c5934b` |
| `alpha13-ci-merge-actual-peer-review.json` | `515ab21348610fae834ed5d43a08a35e9abc9cea5f93468f71aa1705ad0d476d` |

The final diagnostic receipt pins the four original PNGs, the source binding,
probe, runner, static checks and exact correction patch. Static syntax checks
and a read-only patch check passed. The corrected full gate and new
exact-commit CI on both branches remain pending. Fresh alpha.13 native/package
verification, release publication and website update remain pending as well.
This checkpoint changes no feature-matrix row or production code. The broader
audit is not finished.


## Alpha.14 plugin-file, legacy-selection and Skills-directory component checkpoint

This appended checkpoint preserves the complete corrected-alpha.13 audit
prefix. The isolated alpha.14 code integration on `830caa6e…` binds **642 files
and eight selected paths**. Its manifest is `alpha14-combined-code-source-manifest.json`
(`1b3ce51fbd93f3729eb9a26fa7f5d4f5a74d0ac08b167416b33a7afbf34135f1`).
At this component-only checkpoint no combined gate/build, UI capture,
native/package result, new CI or alpha.14 publication was claimed. Later actual
combined checks and the completed alpha.13 closure are recorded below.

The MCP component now bounds selected plugin JSON and manifest reads within the
installed plugin root, preserves unknown selected sources and healthy peers,
and falls back from preferred legacy configuration only on genuine absence.
Dangling/inaccessible/nonregular selected paths and dangling/outside ancestors
cannot manufacture absence. Unknown preview/fresh apply refuses before the
owned CLI stand-in. Valid personal links and contained plugin links remain;
generic `readJson` and the RPC protocol do not change. Invalid declared-source
fallback behavior changes deliberately and is not a real-provider compatibility
claim. Final exact pristine 32 tests yielded **7 passes/25 failures** (exit1),
then **32/32**, **100/100 selected neighbors**, and both typechecks exited zero.
The later ancestor slice first exposed three failures among 32 before correction.

A separate owned Skills probe demonstrated outside directory metadata/full text
in owner listing/read and allowed copy preview for declared and default-child
plugin aliases. Contained/personal controls worked and outside leaf reads
refused. The correction now checks the installed-plugin anchor and each
canonical directory before enumeration/frontmatter, carries that canonical path
into reads/measurement/copy capture, and rescans cached actions. Unsafe paths
are omitted with one fixed note; healthy rows and contained aliases remain.
An absent optional default directory produces no misleading warning. Deliberate
personal/project links and the alpha.13 captured-byte/mode/approval contract are
preserved.

Final exact Skills tests on pristine alpha.14 MCP source yielded **9 passes/10
failures** (exit1), then **19/19**, **75/75 selected neighbors**, and both types
exited zero. The 75 includes MCP 32 and is not disjoint from the MCP 100 selection.
The earlier 11-failure report included a wording-only stale-apply assertion;
old apply already refused through its source fingerprint. That evidence remains
preserved, and the corrected assertion treats old safe refusal as a control.
There is no old copy-apply bypass claim. A contained alias retarget with identical
bytes still requires fresh approval under the existing source identity contract.

The [alpha.14 component proof](alpha14-feature-proof.md) records exact source,
red/green and independent review pins. Tests used only fake homes, invented
owned files and inert stand-ins; no real credentials, model/provider/MCP endpoint
or paid operation ran. Canonical checks are not atomic exclusion of arbitrary
concurrent writers or swap-and-restore behavior. Destination overwrite/rollback,
unsupported schema/provider behavior, aggregate storage/work/memory and broader
masking encodings remain qualified. The audit is not finished.


## Alpha.13 corrected release and website completed

Corrected commit `830caa6e1e971a407dd019fd5996cad8b263b7ab` passed its own
unfiltered local gate with actual npm and durable supervisor exit 0: **985/985
units**, desktop and Phone sweeps, **72/72 targeted cases**, and a crawler result
of **1,427 passed, zero failed, 11 allowed, one guarded and 368 gone before their
turn** across 79 surfaces. The 337-file archive retains 105,694,367 bytes; gone
controls remain a coverage gap and a retained historical app-window image is
not credited as a fresh capture. All 640 source guards and owned cleanup passed.
This correct-source gate is separate from the earlier a06d historical pass.

Both fresh exact-commit GitHub runs passed: [codex-review 37820866231](https://github.com/DanePete/wanigan-2/actions/runs/37820866231)
and [main 37820866175](https://github.com/DanePete/wanigan-2/actions/runs/37820866175).
Each passed 985 units, desktop/Phone sweeps and 72 targeted cases. Their crawlers
recorded 1,434 and 1,437 passes respectively, zero failures; 374 and 371 controls
were gone before their turn. The earlier failed CI and original unrecorded event
ordering remain preserved. No retroactive pass is assigned to that failure.

Seven fresh native stages passed on the same corrected source, with actual
signed package/ZIP/mounted-DMG checks and owned cleanup. The failed host
`sw_vers -plist` metadata attempt is retained; a fresh four-command host
observation replaces that metadata step without repeating native stages.
The assembled native evidence passed its verifier. Ad hoc signature integrity
does not establish notarization, Gatekeeper, a clean machine or minimum-macOS
compatibility. Tests used owned fake data and stand-ins only.

The existing [alpha.13 release](https://github.com/DanePete/wanigan-2/releases/tag/v2.0.0-alpha.13)
was updated and published as a prerelease. Fresh unauthenticated HTTP 200 downloads
matched the tested **DMG 161,049,515 bytes** and **ZIP 143,203,924 bytes**. Their full
SHA-256 values are `34f451dd8d7257ca08d04091c44679b6b9c58bac65534024e8f640c24cf5dae7`
and `547714db6e6990e03478173871339d101c3a36a5cc057a8b737874d28650b6ac`.
Owner app changes remained preserved through the authorized non-force push.

The [website](https://wanigan.ai) update completed at website commit
`38964149fc6bbceb6f36f19b58571c87336336dd`, deployment
`156847f9-cf22-4ff4-9a9e-9f780f59d5d3`. All **eight live stages** exited zero with
**487 functional assertions** and owned cleanup. All **36 fresh live images**
were individually inspected, and root viewed four representative release/download
images across desktop/phone widths and both themes. An additional 19 automated
screenshots are pinned but are outside that visual-review count. Mobile download
clicks used intercepted fixtures; actual public DMG/ZIP downloads are separately
verified above. Phone layout comparison retains its historical baseline
qualification; no real Phone/Tailscale, provider/model, minimum-OS installation
or video-playback claim is made. Owner website changes and evidence were preserved.
The audit remains open.

| Closure evidence under `/private/tmp/wanigan2-review` | SHA-256 |
| --- | --- |
| `alpha13-full-verification-ogynvt.json` | `e28948ce4d5ced375d5159a9587e13c612c15e1d3cfd66307f96ccbc090deac7` |
| `alpha13-native-finalized-bjt27d_g/native-verification.json` | `55bf8dad2111e3ea58f0d4620905d3726fa2154783bb4a88ff407ab61271ad5e` |
| `alpha13-native-finalized-bjt27d_g/assembly-result.json` | `901246cdeac05dd2d587442b21ee8238784d79419b7569973fd517dbbfab8951` |
| `alpha13-publication-preflight.json` | `068cf4323537d1841b22ca7699b41cbeef60740a8c4255a1bd2354d048f2f480` |
| `alpha13-ci-37820866231-success.log` | `50c07b2f0a2bdb6b476e2db97cd5853a42425bf069393a5bade05b84e3f6bb00` |
| `alpha13-ci-37820866175-success.log` | `c57dc8b83e0c24e1c7a60873e04b67cc4e5d56a545394f4723a756c8213adce9` |
| `alpha13-publication-verified.json` | `1adcb41a00a83cda7db2f538b5c035fc95aad2fc09cdb02ddba483f37a1a33f4` |
| `alpha13-site-phone-live-final.json` | `7f30bfabf1d73263fd458e1c984b0b4bb661ad339a2ad7ae57b152e7ad046201` |
| `alpha13-site-phone-live-root-review.json` | `6243de7ca3ee3c82aa84cad47b616878deda2fa03e82d0bc5d7200b30f94dcdd` |


## Alpha.14 actual combined focused/type checks and production build

The exact 642-file/eight-path integration completed both Node and web typechecks
and then **163/163 focused tests**, zero failure, skip or cancellation, in
`alpha14-integration-focused-RL6QL4`. Both the fixed runner and durable supervisor
observed exit 0. The separate literal production build
`alpha14-integration-build-JTysaA` exited 0 and inventoried **109 actual outputs**.
Source/helper guards and owned environment removal passed for both. Dependencies
are an independent physical copy; no fresh installation is claimed.

The root verification is `alpha14-integrated-focused-build-verification.json`
(`36779e4bc554b10e0dd33b1ac1bc32bbe683fe7770a0b65778735d4fbf7f4ead`). Focused
result SHA-256 is `ba4c2207cdf3fc0a025717a72672873892b787fc7147a2a025dbf2059000a3b7`;
build result is `937dc05f721568827c1e1fb67eb5254fda0addc8db6bc775853df8cfffd66c26`.
These are actual combined checks, distinct from the overlapping component counts.
At this combined-build checkpoint UI was still pending. Its subsequently
observed proof is recorded below; full local gate, native/package verification,
exact-commit CI and publication remain pending. The full gate will bind final docs/captures/source bytes; the
current source base identifies 830c plus the exact manifest delta, not a final
alpha.14 release commit.


## Alpha.14 observed before/after UI

Four serial stages completed with actual capture and durable supervisor exit 0:
MCP before/after each covered 12 cases and 24 images; Skills before/after each
covered four cases and eight images. All **32 cases and 64 fresh PNGs** used both
themes at 1440 and 960 pixels. Every image was individually reviewed; root also
viewed all 16 selected narrow affected crops. No material clipping, overlap or
horizontal overflow was observed in these states. Source/output guards and
owned gateway/environment cleanup passed. This is focused evidence, not an
exhaustive accessibility or device audit.

The actual corrected alpha.13 build at `830caa6e…` supplies the before renderer;
the after renderer is the exact 642-file alpha.14 integration and its 109 actual
build outputs. A before-stage pass means the known defect was observed. The
MCP outside-plugin marker row becomes an omission with a scoped note while
healthy rows remain. Unreadable preferred configuration now shows its permission
diagnostic and omits the fallback row. Store Add preview changes from a command
with enabled Add to a refusal with no command and disabled Add. Add was not
committed. The Skills outside-directory row/body is omitted after the fix while
healthy plugin/personal rows and the fixed safety note remain readable.

All results come from the real built renderer and owner testCore over invented
owned files and stand-ins, without synthesized MCP/Skills replies. Skills read
and copy preview were exercised, then canceled; its screenshots show the library
after Cancel, not the preview dialog. No copy apply, CLI apply, real credential,
provider/model call or paid operation ran. Header counts describe listed rows,
not a complete inventory of unknown or omitted data.

The first MCP-before helper attempt exited 1 because Store is a radio rather
than a button. Its eight completed cases, 16 images and unexpected screenshot
remain preserved and are excluded from the 64 above. A reviewed one-line scoped
radio selector correction preceded all four successful stages; the failed
owned outer state was subsequently removed with a separate cleanup receipt.

The 16 linked crops below are byte-identical copies selected from those 64 PNGs;
all full viewport images remain pinned in the external visual receipt.

| View and theme | Before | After |
| --- | --- | --- |
| MCP plugin file, dark | [Before](alpha14/mcp-plugin-file-before-960-dark.png) | [After](alpha14/mcp-plugin-file-after-960-dark.png) |
| MCP plugin file, light | [Before](alpha14/mcp-plugin-file-before-960-light.png) | [After](alpha14/mcp-plugin-file-after-960-light.png) |
| MCP preferred configuration, dark | [Before](alpha14/mcp-legacy-list-before-960-dark.png) | [After](alpha14/mcp-legacy-list-after-960-dark.png) |
| MCP preferred configuration, light | [Before](alpha14/mcp-legacy-list-before-960-light.png) | [After](alpha14/mcp-legacy-list-after-960-light.png) |
| MCP Add preview, dark | [Before](alpha14/mcp-legacy-preview-before-960-dark.png) | [After](alpha14/mcp-legacy-preview-after-960-dark.png) |
| MCP Add preview, light | [Before](alpha14/mcp-legacy-preview-before-960-light.png) | [After](alpha14/mcp-legacy-preview-after-960-light.png) |
| Skills plugin directory, dark | [Before](alpha14/skills-directory-before-960-dark.png) | [After](alpha14/skills-directory-after-960-dark.png) |
| Skills plugin directory, light | [Before](alpha14/skills-directory-before-960-light.png) | [After](alpha14/skills-directory-after-960-light.png) |

Full local gate, native/package proof, exact-final-commit CI, alpha.14 release
and website publication remain pending. These focused captures do not complete
the audit.

| UI record under `/private/tmp/wanigan2-review` | SHA-256 |
| --- | --- |
| `alpha14-ui-final.json` | `e9053c776006122ba93b50c82efd75ac3d5ac9f99d16ce556ddf8434af0d234f` |
| `alpha14-ui-visual-review.json` | `f412503749de943558f3ffa9edb4a90536557bf9d2bbb6fa3288537a26898546` |
| `alpha14-ui-durable-selection.json` | `8cb4d3f94556ffd32796e448c033d721b9a2089c794a83ca970e694839a23634` |
| `alpha14-ui-evidence.json` | `3279c23a379ba548e1cb75a87fec6e3086ba859ac2ad8e74ceccc23a422736c9` |
| `alpha14-ui-affected-root-visual-review.json` | `69f1b3d5bfbf2f6743307ef52b9a42a8afe370044fa8ac6b47e1e3e8946deb12` |
| `alpha14-ui-store-selector-failed-state-cleanup.json` | `95eb20ba73c47702566531d0f15a3b9e70d7c0fd604480e2f435e20c678bed6f` |


## Alpha.14 fresh dependency query

A fresh read-only registry audit used the isolated candidate's actual package
and lock bytes with sealed empty home/config/cache. Full `npm audit --json`
returned actual exit 1 with **eight moderate development/build reports**, zero
high or critical reports. `npm audit --json --omit=dev` returned actual exit 0
with **zero reports**. Source inputs stayed unchanged and the owned environment
was removed; no installation ran. An initial helper-only duplicate `/dev/null`
configuration error is preserved separately, followed by the corrected query
using distinct empty configuration files.

This is registry-query evidence, not a claim that advisory folders are absent
from future artifacts. Fresh package, ZIP and mounted-DMG inventory checks and
the final release commit remain pending. Records are
`alpha14-dependency-audit-query-summary.json` (`8332d576631c842d7c8bc8dca69932b73edadb97d932bb402f09c77619d14f79`),
`alpha14-npm-audit.json` (`48dab4e52c843efc59fcd5fb4e06b2ebbcbc9dc96d0333ff49b82c0a6d12c788`) and
`alpha14-npm-audit-production.json` (`da89b48eb6202d6788528471a03ec3bd1ec4813e41edb88bcf6da646c70bd635`).


# Alpha.15 combined checkpoint and alpha.14 publication closure

2026-10-08. This append preserves the complete preceding audit record.

## Alpha.14 release and website completed

The final alpha.14 app commit is
`5f967ffc9b13af6c535efb9a78cd349530efc0d1` (659 source files, 28 selected paths).
The literal unfiltered local gate and durable supervisor both exited **0**:
**1,036/1,036** unit tests, desktop and phone sweeps, **72** targeted browser
checks and **1,430** crawler passes with zero failures. Six raw RPC refusals
were recorded, with zero stopped-session resize qualifications. Source guards,
owned cleanup and a 337-artifact archive passed. Earlier component/capture
counts above remain historical checkpoints rather than substitute full gates.

Fresh native verification completed seven stages and eleven read-only evidence
roles with actual exit **0**, 109 build outputs, three matching 21-file native
inventories and package/ZIP/mounted-DMG ASAR parity. The first README attempt
failed on sandbox loopback `EPERM` before app launch; its unchanged unsandboxed
retry passed. The README and immediate Demo screenshots were actually reviewed.
The Demo image proved launch/isolation but showed an Asking permission heading
without a visible card; its readiness condition did not await complete seeding
or settled card rendering. Neither complete Demo rendering nor a persistent
missing-card defect is established. Owned mounts/processes were cleaned up.

Fresh registry evidence reported eight moderate development/build advisories,
zero high/critical and zero production reports. Actual package, extracted ZIP
and mounted-DMG inventories contained none of the listed advisory folders.
This is bounded inventory evidence, not a universal dependency-security claim.

Exact-commit review CI **37833437299** passed. Main CI **37833437510** first
failed one three-second click while replaying Pick/Unpick line 6, before the
reported final Leave a note action. The exact replay step and actionability
cause were not retained. A separately instrumented local diagnostic was manually
interrupted after 5,308 observed wall-clock seconds following a clock jump; it
produced no report or reproduction verdict. Its runner exited 130, supervisor
1; source/output guards passed, owned processes were absent and its state was
retained. Host suspension/timer effects are plausible, not established.
Unchanged main attempt **2** then passed the complete gate at the same commit:
1,036 tests, 72 targeted checks and 1,434 crawler passes, zero failures. This
successful retry does not identify or correct the original failure. Failed and
interrupted evidence remains preserved and is disclosed in the public notes.

The existing [alpha.14 prerelease](https://github.com/DanePete/wanigan-2/releases/tag/v2.0.0-alpha.14)
was published without duplicating its draft or assets. Both whole unauthenticated
public downloads returned HTTP 200 and matched the verified native bytes:
DMG **161,024,787** bytes, SHA-256
`7d3cb61b6365935e6334cae44d5fbadd89c6d9bbaacf3bd981a34bf742d1fa0f`;
ZIP **143,205,779** bytes, SHA-256
`e7953a31399777d744470649b28f391144806ec061cee5ed2fea79a3b90c48e1`.

The website update is published at [wanigan.ai](https://wanigan.ai), site commit
`3391cd8073d8c6386e31092944bf9b37f7067145`, Cloudflare deployment
`2b4b497c-d6a0-4617-9742-a753df14b23b`. All **eight** live stages exited **0**,
with **515** assertions and **36** freshly captured, individually reviewed
images. Source/cleanup guards passed; owner files/videos and existing Phone
content were preserved. Mobile click checks used intercepted fixture bytes;
the separate whole-download proof above establishes public asset delivery.
Static screenshots do not establish video playback, physical-phone/Tailscale
or real provider/model behavior. Historical alpha.13 before images remain
historical; 19 additional automated PNGs are excluded from the 36 reviewed count.
Alpha.14 publication is complete within this scope; the wider audit remains open.

## Checkpoint availability object storage

Five owner availability reads on one stopped stand-in card worktree confirmed
that three distinct 16 KiB edits added six loose objects and 49,382 logical
compressed bytes to Wanigan's persistent object store without adding checkpoint
rows. Those objects were unreachable from the captured commits and repository
refs checked by the probe. The unchanged and restored-byte controls added none.
Repository files/modes, ledger rows and existing objects stayed unchanged. This
was an owned fixture, not a disk-exhaustion or data-loss experiment.

The correction gives `assess(false)` a distinct temporary object root and removes
it in `finally`. Captures and committed undo/redo assessments keep persistent
objects. The exported `snapshot(false)` contract remains unchanged; callers that
inspect its returned tree can still do so. No old object is pruned, and no new
retention policy or arbitrary external-writer exclusion is claimed.

The exact four-case suite on pristine `5f967ffc…` produced one passing undo/redo
control and three storage/path failures. Its repeated-edit case stopped on its
first failing storage assertion. Corrected source passed **4/4** cases and
**20/20** selected neighbors, including existing snapshot and undo/redo behavior.
Both typechecker children exited **0**, while their original wrappers exited
**1** because TypeScript left one owned compile-cache file in each state. Exact
cache bytes and state manifests were preserved before a separately reviewed
cleanup removed only those two states. Neither result was rewritten and neither
successful checker was rerun. Failure cleanup, concurrent distinct assessment
stores and inspectable actual undo/redo objects have explicit regressions.

## Attachment removal after filesystem failure

An owner-RPC probe saved only invented text under its fake-home data directory.
A real permission-refused removal deleted its database row while retaining the
file. After restoring permissions, the original ID returned `not_found`; a
same-name save reused the sequence and returned `EEXIST`. An untouched pending
sibling retained its bytes and mode. The original probe's database, files and
observations remain retained; no protected owner data was inspected.

The correction unlinks before deleting a row. `dropUnsent` now deletes each row
only after that file's removal succeeds, so a later failure retains the failed
and unvisited rows. Sent-file refusal and missing-file `force` behavior remain.
The four new cases use actual owner RPCs plus direct `dropUnsent` on owned data.
Real permission canaries must fail before product assertions. A separate partial
progress case safely moves a normal owner-created middle file aside and places
an owned empty directory at its path, causing a real nonrecursive-removal
refusal. Exact modes and moved bytes are restored in `finally`.

The **final exact test bytes** on pristine `5f967ffc…` produced one passing
missing/sent control and three intended row-retention failures. Corrected source
passed **4/4** cases and **17/17** selected neighbors; both Node and web
typecheckers and their wrappers exited **0**. Guards, owned process-group absence
and successful-state cleanup passed. An earlier test revision's Node checker
exit **2** and wrapper exit **1** are preserved: `claudeBinary: null` violated
an optional-string type. Omitting that property preserves Core's existing
`options.claudeBinary ?? null` behavior without executable discovery. The final
test bytes received a fresh pristine red before the final successful sequence.

This does not establish session-exit/recovery/crash behavior; those error-policy
paths are unchanged. Filesystem and SQLite operations are not one atomic
transaction: a database failure or crash after unlink can leave a row for a
missing file. No old orphan pruning, automatic evidence deletion, quota or
general retention policy was added.

## Gemini SessionStart briefing envelope

The Gemini branch wrapped `briefing(sessionId)` in another JSON hook envelope,
although that helper already returns the complete serialized envelope. The
existing `/wanigan/i` assertion accepted the nested form. The correction returns
that existing envelope directly, as the Claude branch already does, without
changing briefing text, state transitions, other events or renderer APIs.

The strengthened existing test starts the same fake Gemini stand-in and uses
the real hook relay. After one JSON parse, `additionalContext` must begin with
the actual project's human briefing and contain a real newline before board
guidance. On pristine `5f967ffc…`, **three of four** existing cases passed and
that prefix assertion failed; the later newline assertion was not reached.
Corrected source passed **4/4**, **53/53** selected neighbors, and both
typecheckers and wrappers exited **0**. Source guards, owned process-group absence
and cleanup passed. No real Gemini executable, model context/quality effect or
installed-provider-version compatibility was tested.

## Combined types, focused cases and production build

The combined 661-file code checkpoint passed both Node and web typechecks,
then **90/90** cases across twelve distinct selected test files, with zero
failures, skips or cancellations. These are the actual combined outcomes,
separate from the earlier component observations. The focused runner and durable
supervisor each exited **0**. A subsequent production build and its supervisor
also exited **0**, producing **109** outputs whose paths, sizes and hashes were
rechecked. Both stages retained the exact `05717bd6…` source-manifest binding,
passed their before/after source guards and removed their owned successful
fake-home states.

The four recorded runner/supervisor PIDs were absent at the root's final check;
this is not independent enumeration of every possible descendant. The runs used owned fake homes and stand-ins, with no real provider or model
call. This proof is for
the combined code checkpoint, before final documentation/commit binding; it
does not replace the final unfiltered full gate, native verification or CI.

## Candidate status and limits

These are three separately guarded components based on published alpha.14
`5f967ffc9b13af6c535efb9a78cd349530efc0d1`, using owned fake homes, invented
fixtures and frozen alpha.12 dependencies. Their separate component observations remain preserved alongside the combined result above. Historical working labels `next16` and `next17`
identify evidence directories, not promised releases.

At the combined code checkpoint, the isolated alpha.15 integration contained
661 files and nine selected paths. Final commit/source binding,
the unfiltered local gate, fresh
native/package verification, exact-final-commit CI, alpha.15 publication and its
website update remain pending. No renderer change or new screenshot proof is
claimed for these main-process corrections. Existing UI checks remain part of
the required full gate. The broader audit continues.

## Evidence index

The following retained local receipts are under `/private/tmp/wanigan2-review/`.
Their manifests pin source, actual logs, lifecycle checks and preserved failures.
These local paths are evidence identifiers, not public download links.

| Receipt | SHA-256 |
|---|---|
| `alpha15-code-source-manifest.json` | `05717bd6224d25efdc9ab02d405279df99d23d056aa80fc7924f8c35a4e4e1ef` |
| `alpha15-combined-root-verification.json` | `595f7759a736ba72bfa2a31ad444a17ae89c8007cccbf8a3b3de9e785e6c4885` |
| `alpha15-integration-focused-Hp75uA/result.json` | `11bf93de98b65add2308878654430e12520c193d24f05d39f67c610e508cfa45` |
| `alpha15-stage-supervisor-2p19p01n/exit.json` | `09ff9d0de07a6db5562269979cb54b34a85e59c469bb4dd2bd7c851c0a71e0ea` |
| `alpha15-integration-build-5VU4sm/result.json` | `0229c44e6b8767288065a1f02ba53302f8b512d7048a530cb3b1cbe54a3af583` |
| `alpha15-stage-supervisor-iwt4z6ze/exit.json` | `28a31eb7bd6fe8428a67f64d72c93823025db7bd21e5e89563d57df718ae5470` |
| `next-checkpoint-probe-revision2-_w4ulro8/verification.json` | `22a905026cd3683fd2b71a57e60f0318ecf2ced38405de888cc1f27531fffdbe` |
| `alpha15-checkpoint-assessment-zsnh_yi6/component-verification.json` | `f70aa5a0987ca576f0ba7f428efec0abddbfafc6cae6cb46fb0929a4a331cdd9` |
| `alpha15-checkpoint-assessment-zsnh_yi6/component-final-supplement.json` | `f22c076cf788c1df6197375cd2f78481405b14fef8211d1c3d2b564b268d8ba8` |
| `alpha15-checkpoint-assessment-zsnh_yi6/final-manifest.json` | `362cf20438ce7fa0cdaab82be9133b532cb962a47718a3261a5665702da8267b` |
| `alpha15-checkpoint-component-final-independent-peer-review.json` | `72f7f9a62cdc194c1ab9c48ce7393446a67f60e36e3f58088f0334ba208d55ea` |
| `next16-attachment-removal-probe-v2-p7eyygyc/verification.json` | `b9bc12686a7de7ce299403e8eda3ef12973ce3e181d5db2aef051962abef98bc` |
| `next16-attachment-removal-probe-actual-independent-peer-review.json` | `d9c4ae50861c371b2c8fc4b0cb1fe0bd2e02a0453ab66ec89b908c9002b5880c` |
| `next16-attachment-removal-component-1lrk5c0f/revision2-partial-verification.json` | `99b102af0be3d4738a029a32417e5d7138cad15c505683c812a3b5e1e5ba5afa` |
| `next16-attachment-removal-component-1lrk5c0f/revision3-baseline-red-verification.json` | `6375a91042bc29308eda0070b82068fdf2dd80092641efe2eec9c98936d645a0` |
| `next16-attachment-removal-component-1lrk5c0f/verification.json` | `3e088482076adf5157c19daffaab8af110169fdd0ebeb0f6d798904cf6fea1a6` |
| `next16-attachment-removal-component-1lrk5c0f/final-manifest.json` | `387d84fcc7eda80eedf58df7710146615c5b04e7ea5eecb271609ebd631eb32a` |
| `next16-attachment-removal-final-independent-peer-review.json` | `97df06fe1beb223182f3d8f7bd0746b7ba11f158f3343c1d2a0ebc678caf1685` |
| `next17-gemini-briefing-xi0230x5/baseline-red-verification.json` | `95e0b7ad2026ff61d7b00be9936ca5c090e1e1bf0f631abaf477ce49a01d97c1` |
| `next17-gemini-briefing-xi0230x5/verification.json` | `2834b70a6357ea0244f1ca57267d4aaf218e54438d4ed94dee3e1161aeb20602` |
| `next17-gemini-briefing-xi0230x5/final-manifest.json` | `edadae8c6e54d6c552540b5b9863c13df450e37ab3aba5e5e16b893b12a987d7` |
| `next17-gemini-briefing-component-independent-peer-review.json` | `38cedbda2149b647750b4c446afecf62c07724742f80cf366ed34045f5bc2715` |
| `alpha14-all-source-manifest.json` | `ccd483608b8e1716e70c3a8a3b3384d300a93e6ca7762e41d52e8097a2cbbdbd` |
| `alpha14-full-verification-JMeKiL.json` | `ea63b184f9136bb5da41e5c1d1eeaabd348998308cb8533f6d9627a78dbc9351` |
| `alpha14-native-finalized-bpi1mdnb/native-verification.json` | `fde96a6893a5a4ca5fbf083ebb9222a8996bc43fc093ca1fa1f5c0e16099253c` |
| `alpha14-dependency-audit-summary.json` | `e4f8eb6a8bacf4af9c0962ef9007bbff6e7d7adeef175596d2390e7635aed155` |
| `alpha14-ci-review-verification.json` | `9f5f6bd1dffd2894157639c59498536f9f1e159dd21598e5c3f7a1e2d368f985` |
| `alpha14-ci-main-failure-verification.json` | `feed476a264be61d587fb4ad8ccadbc3bce6bbdc50937402b43ab063d2f7147a` |
| `alpha14-crawl-diagnostic-interrupted-verification.json` | `98025815d28f284bafdb8d6da993926504d7930f0b46868d0e89efa813ab3205` |
| `alpha14-ci-main-attempt2-verification.json` | `1bcbfe62e84028b47a6de57417c4ad9b1f9ba79f1fc4d97128d83f6236c9e4f4` |
| `alpha14-publication-verified.json` | `71f435108d009e8ce352852a93aee01350fb4211cfa0896706b38ea74f7246b4` |
| `alpha14-publication-root-final-review.json` | `f0ec44ba00eb0772bf3a81ea44f3d02bad8a7a8f6af8212de77a59eee0395b86` |
| `alpha14-release-notes-publication.md` | `3855a3151d2507a1db563cd85b93e93c4269828ef017a2ab9b14d292700dae50` |
| `alpha14-site-phone-live-final.json` | `c31b56d47ed41bd5fea996e4fc76ca175514dd209df917a23c4c3346f2dc3bd4` |
| `alpha14-site-live-root-final-review.json` | `a0d52b80d4ed3cf5441515ebc8959340ba4ff4910c2186355cbdc5836b7561f1` |


## Alpha.15 release and website completed

Alpha.15 `8c1b7ad145780d92d99c6ef00d476c962ccf96ce` completed its local full gate: 1,044 unit tests, desktop and Phone sweeps, 72 targeted checks and a crawl with 1,428 passes and zero failures. Seven serial native verification stages completed, including packaged/ZIP signatures and a read-only DMG Demo launch with three projects and one session. The ZIP smoke verified its focus alert; the source and packaged-app focus limitations remain recorded. The artifacts are ad hoc signed, not notarized; a clean macOS 13/Gatekeeper install and other platforms remain unverified.

Both exact-commit GitHub workflows passed: [main](https://github.com/DanePete/wanigan-2/actions/runs/37856719665) and [codex-review](https://github.com/DanePete/wanigan-2/actions/runs/37856719304). The first review attempt had one crawler input-click timeout. Its logs and failure image remain preserved; one unchanged retry passed. No cause or source fix for that first timeout is claimed.

The [alpha.15 prerelease](https://github.com/DanePete/wanigan-2/releases/tag/v2.0.0-alpha.15) is published. Fresh credential-free public downloads matched the verified assets: DMG 161,025,077 bytes, SHA-256 `17f1cb37e0c105ed0f65a2aaff90943a2000c22a347a8dfcd3c7566a7e41bafe`; ZIP 143,206,064 bytes, SHA-256 `08e641221141e9c7255aa1ffd5ce7fe0ca561b9baaa86656890aa8184413cb07`. Publication proof `alpha15-publication-verified.json` has SHA-256 `998fabeb6beecbf1311fe8e9d2a3e2dac8ac1907bcb65d79a26a593838f155b9`.

Website commit `f529913fdfcf1eea16bda200d203bfc006175e63` deployed as Cloudflare `17ae5dc4-8496-433f-bf2e-eced48201133`. Local gates and all eight live stages passed, including 543 assertions, mobile/archive cases and full/range video responses. All 36 fresh live images were individually reviewed. A hero poster/spinner at 0:00 is not playback evidence, and physical Phone behavior remains unverified. Live proof `alpha15-site-phone-live-final.json` has SHA-256 `372e017d06244d5d34d7ecb727495418bf9e01bc5b71eaade1f72f453e7956c7`. Owner edits, Phone assets, ignored videos and website worktrees were preserved.

## Alpha.16 component checkpoint

The next [feature proof](alpha16-feature-proof.md) records actual Git/History component red-green checks and the native Orb lifecycle reproduction/correction. The separate combined checkpoint passed both typecheckers, 148/148 selected tests and a production build with 109 verified outputs. Both before/after renderer runs passed all four cases in light and dark themes, and all sixteen fresh PNGs were individually reviewed. The measured code checkpoint was 664 files/fifteen selected paths; final scripts and documentation are subsequent additions. No full, native-package, CI or publication result for alpha.16 is inferred from these checks. This append preserves the entire 236,309-byte prior audit prefix unchanged (SHA-256 `39a815059132cc7331c4706b03db59e3d527e79cd89bb884d4267f51d0a8595a`). The broader audit continues.

## Alpha.16 crawler expectation correction

The first committed alpha.16 full run (`8179813440e01d611731a2fd84c022f55975917e`) passed both typechecks, all 1,063 unit tests, desktop and Phone sweeps, and all 72 targeted UI checks. Its complete crawl recorded 1,427 passes and one failure: the History failure/retry check still expected “Wanigan’s core is not answering” after History deliberately adopted “History could not be loaded”. The runner and supervisor exited 1. This is a stale test expectation, not a passed full gate. The failed state, all 361 artifact files, source manifest, runner inputs and logs are preserved.

The crawler now selects the expected heading per view and checks that same heading disappears after Retry. History supplies its specific title; all other views retain the existing default. Empty-state rejection, Retry, controls, timeouts and allowed outcomes are unchanged. The focused Checks run passed **29/29**, with actual child and wrapper exit zero, unchanged 683 source/109 built-output guards and owned cleanup verified. It reused the actual alpha.16 renderer without rebuilding. No production code changed in this correction. A new committed full local run and both exact-commit GitHub workflows are required before publication.

Retained receipt `alpha16-history-crawl-correction-pc7gas9m/verification.json` has SHA-256 `64e53130d7d4d07c59f5195472424c15323d15a8c2be3df8e88bbcac1c03ddc4`; its failed-full archive manifest has SHA-256 `f6c1d5a01e1a4bcb703f95e8233c47cd9a6393633d063c8bccfcc845b6af4c1b`. The broader audit remains open.


## Alpha.16 release closure and alpha.17 component checkpoint

Published alpha.16 is `ffb80fd56a9818d48cd97897dde63b4a848eb22b`. Its first local full run and both original CI runs on `8179813` failed the crawler's stale generic History headline assertion after the unit/sweep/targeted stages passed. The test-only correction made the initial and Retry checks use the view's deliberate “History could not be loaded” heading while retaining the other views' generic default, timeouts, target identity and verdicts. All 29 filtered Checks passed. A fresh unfiltered local gate then passed 1,063 units, both desktop/Phone sweeps, 72 targeted cases and 1,428 crawler passes with zero failures; 368 gone controls and six raw refusals/zero resize qualifications remain reported. Corrected-commit CI main `37875004056` and review `37875004234` each passed their secrets and test jobs, including 1,063 units and zero crawler failures (1,434 and 1,438 passes respectively). Original failures and complete logs are retained.

Seven fresh serial native stages passed: README development, source smoke before packaging, package, restored source smoke, packaged app, fresh ZIP and mounted DMG. The first README attempt rendered but failed cleanup with `kill EPERM`; its failed state and exact owned-Core cleanup remain preserved, and one unchanged retry passed. No cause is asserted for the transient error or complete nested-group absence for that failed attempt. The README and Demo screenshots are immediate render observations, not complete GPU/demo lifecycle coverage. Verified local extracted copies were disabled and later archived only after native success; release archive bytes and the installed owner application were preserved.

The prerelease was published once, then unauthenticated DMG and ZIP downloads returned HTTP 200 and matched the verified native hashes: DMG `340767afa9421bb5afba0ab2a76855d569e388ef930e9871b39286e8b24babc5`; ZIP `2506798f5d2f97b934aa22bd84d3dba951a0ae03e7c40bfbcb1112c1c77c2b91`. This closes alpha.16 publication, not the remaining audit.

The website is also verified at site commit `3f606d5155f1e24691d34872f65df692e54da352`, Cloudflare deployment `ac2b12d9-7a67-4c06-9896-2e39f7f261a6`. Local and live runs each passed all eight stages and 571 assertions. All 36 fresh live images were individually reviewed; the 296 tracked source files, Phone's 40 paths/32 images, both videos and four owner worktree entries were preserved. The initial local accuracy check had four no-Orb-copy failures; the reviewed Visuals wording correction was followed by the complete passing local run, without weakening assertions or changing the app. Historical alpha.15 before images remain historical, 19 additional automated images are excluded from individual QA counts, and fixture download clicks are separate from the actual public-download proof.

Alpha.17 now has a reviewed isolated 690-file code/version checkpoint with 20 selected paths. Its briefing/hook/migration composition passed both typecheckers and 90 cases. Aggregate Skills/MCP admission passed 17 focused cases, 162 including neighbors and both typecheckers. The aggregate constructor lifecycle defect and old copy-race fixture trigger were diagnosed with controlled reds and corrected; their failures and retained owned state remain evidence. The migration red is deliberate SQL-digest sensitivity, not a published upgrade failure. Exact-content Skills approval remains unchanged.

All 24 fresh desktop UI images were individually reviewed in both themes: eight briefing Start refusal/recovery and sixteen Skills/MCP complete-read refusal/recovery. Actual Core/gateway records establish the effects and cleanup; unchanged historical alpha.16 renderer outputs do not constitute an alpha.17 build. Small trusted limits and owned stand-ins establish the contract without real credentials, models or MCP services. The detailed [alpha.17 proof](alpha17-feature-proof.md) records these results, all meaningful component/helper failures, image links and limitations. Nine feature-matrix rows change; the other 243 and all preceding audit bytes remain unchanged.

The separate Tokens probe confirms stale same-size replacement/rewrite counts (cached 100 versus fresh 250), with a healthy append control. It remains open in this checkpoint; its separate correction candidate is not included. The actual integrated 690-file/20-path selection subsequently passed 252/252 cases and both typecheckers with zero tool/runner exits, source guards and owned environment cleanup. It does not claim unrecorded process-group absence. Alpha.17 production build, the unfiltered full gate, fresh native packages, exact-commit CI, publication and website update remain pending. Neither release closure nor these controlled fixtures finish the audit.

Closure evidence (owned audit directory):

- `alpha16-full-verification-TaKUkD.json` — `9f03d0a3be39095501df050894cfa39a364eb78305e4cb2bbfe6c9f91caa418a`.
- `alpha16-corrected-ci-ffb80fd-verification.json` — `95c26c8c16bb668efbb1410042a5aa8ad3ffa6fcadf13d6f2ca7af677a514f3f`.
- `alpha16-native-finalized-1v396opa/native-verification.json` — `e26b8b07deb9a7a838d133d9b27a846dd0bbca7721579e3cda745f2a6539b64a`.
- `alpha16-publication-tools/verificationHistory.final.md` — `2b7f2812e3030b480b4e1ce3914be71c496983f31fa978e3d144560d4470ceff`.
- `alpha16-publication-verified.json` — `a00633cab67b3c8cfa3e7aa04e20d9b0ed87658b7bf99ae00338a3992e26afe0`.
- `alpha16-site-phone-local-final.json` — `14e28f0bffba17d292380159440fd51af7b7c50de79d731b8256e5f16f723cbb`.
- `alpha16-site-phone-deployed.json` — `55b4ab3af852a988102be311f70535629b69f9f547a59491a25ab652180cc24d`.
- `alpha16-site-phone-live-final.json` — `807c59710b248a0a9fc16f06db552b8ef8339a3e37d59d38b815ee9ebfb78afe`.
- `alpha17-focused-verification.json` — `0cfa273e1c5acf3bd4133fb5e0c6995f35e1b1d44353a63e5792272d8f80091c`.


## Alpha.17 release closure and alpha.18 component checkpoint

Published alpha.17 is `50c37631084b66e862c52f92b05bbe43e75640aa`. Its unfiltered local gate passed both typecheckers, 1,100 units, desktop and Phone sweeps, 72 targeted cases and 1,429 crawler passes with zero failures. The crawl retains 368 gone controls and six raw refusals/zero qualified resize observations as coverage limits. Both exact-commit GitHub workflows passed on attempt one: [main](https://github.com/DanePete/wanigan-2/actions/runs/37881481834) and [codex-review](https://github.com/DanePete/wanigan-2/actions/runs/37881481521), including their secrets jobs. Their crawler results were 1,440/1,437 passes, zero failures and 368/371 gone controls respectively. These are separately measured runs, not interchangeable counts.

Seven serial native stages passed on macOS 26.5.2 build 25F84 arm64: README development, source smoke, packaging, restored source smoke, packaged app, fresh ZIP and mounted DMG. Missing metadata pins in the native preparation were corrected before execution; no failed native run is implied. The retained screenshots show immediate rendering, while the native stage receipts carry functional and owned-cleanup results. Post-PASS GPU/network diagnostics occurred during owned shutdown and do not establish a universal GPU lifecycle claim. The assets are ad hoc signed, not notarized; minimum-macOS/Gatekeeper and other platforms remain unverified. Redundant extracted owned bundles were removed only after archive equivalence and native success; release archives, installed owner app, data and evidence were preserved.

The [alpha.17 prerelease](https://github.com/DanePete/wanigan-2/releases/tag/v2.0.0-alpha.17) is published. Fresh unauthenticated full downloads returned HTTP 200 and matched the tested assets: DMG 161,065,555 bytes, SHA-256 `68b8d0a878f4c0e4a343210c4f4a854e7e4d08ef51b684b0b9dbae81071aa3d8`; ZIP 143,211,787 bytes, SHA-256 `f1697e6a63f339c6c568e322ca8e92a5eb1429ed0e66135d287277eb6b6bb321`. The full dependency audit reported eight moderate development findings, while production/high/critical findings were zero; all eight named packages were absent from the packaged inventories. The recorded 210-commit secret scan found no findings. These facts do not imply every dependency or future commit is safe.

Website commit `1dc25824292e1dee39cd8d7ab479f675f1f43e55` changed only `content/site.ts` and deployed as `987f0847-69ac-4ef1-b368-392aa97bc438`. Local and live checks each passed all eight stages and 599 assertions; root individually reviewed 36 fresh images from each run. Historical alpha.16 before images remain historical, and 19 additional automated images are excluded from each individual-review count. Mobile download clicks use fixtures; the separate public-download receipt establishes the actual assets. Static images do not prove playback, physical Phone/Tailscale operation, all interactions or accessibility. The final source guard preserved 296 tracked files, 256 build files including 219 client files, both videos and the owner website worktree entries.

The next [alpha.18 feature proof](alpha18-feature-proof.md) records the Tokens and History freshness corrections and Board marker fix. Its isolated seven-path/716-file code checkpoint passed both typecheckers and 62/62 selected units. The exact durable Board block reproduced six expected red failures with two controls, then passed all eight cases; separate green cases passed six real browser drops and four capped-Done/empty-target cancellation controls. All 34 fresh images were individually reviewed. Component totals overlap and must not be added into a unique-test count. Four feature rows change; the other 248 rows and the entire prior audit prefix remain unchanged. Final alpha.18 integration, the unfiltered full gate, fresh native packages, exact-commit CI, publication and website update remain pending. The broader audit continues.

Closure evidence under `/private/tmp/wanigan2-review`:

- `alpha17-full-verification-ATrKRZ.json` — `301bb0f27998caf8d2c72813574c5bb526b3031629ab1e90886d34099cf405c4`.
- `alpha17-ci-closure-slu11p4n/closures.json` — `696c03fccbb7fa90191397877a5c96daa4293c146aa76e15a82f21b0f9154542`.
- `alpha17-native-finalized-uri6xjnf/native-verification.json` — `6abc05fbb88557942da9009b63b558e86f95ad253dd50a0d9098a386e491bb70`.
- `alpha17-publication-peer-20261009/dependency-audit.final.json` — `eea62cc8f649fdb81f9b5c9137bf40431b17d5cb1fad73b9ab652b548c9a93fd`.
- `alpha17-publication-verified.json` — `22fd82a069c0e9f1a0ea89927999e52df440686c779afb9656b75a4207a3425d`.
- `alpha17-site-phone-local-final.json` — `46a074688412db052e856e5cd1b6b05469e80d9352eacdcb8ff9de602deb62b1`.
- `alpha17-site-phone-live-final.json` — `176da2f1bdc050f3da3848b2c6138184959c3af8ae65a7bfd44750bbf10210cc`.
- `alpha17-site-final-source-closure.json` — `2b92afb1eb12c817d2cd1b78a083ae8044663caa839c2b1cd353064ede79ef01`.
- `next-combined-seven-tm3p8_0g/verification.json` — `32e2ca1681adc210759aad999bc25c8a718ec365dd7eed838c53803a10d8dd10`.
- `next-combined-seven-tm3p8_0g/root-visual-review.json` — `74c9be763436d2358cbd018579f720ee6f3a7a498507eb385633c92e0d3ab375`.
