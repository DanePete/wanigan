# Wanigan 2 independent git/checkpoint audit

Reviewed the Wanigan 2 checkout on `codex-review`. All nine code fixes below shipped in [`bd3e03c`](https://github.com/DanePete/wanigan-2/commit/bd3e03c9ccbb39a7b84f9c10c889fee2febc6575). Findings below reference alpha.3 working-tree lines, with the original vulnerable operation described. All experiments used `testCore()` temporary folders and stand-ins; no real models, credentials, application data directories, or remote services were used.

## Fixed findings, ranked

### P1 — Concurrent stash removal could delete an unrelated stash

- Location: `src/core/git-client.ts:768` (`stashRef` and later ordinal-based stash commands); fix `src/core/git-lock.ts:11`, `src/core/git-handlers.ts:420`, `src/core/handlers.ts:212`, `src/core/checkpoints.ts:192`.
- Reproduction: create two stashes; submit two `git.stashDrop` requests naming the same index and SHA. Both requests validated `stash@{0}` before either command ran. The first command dropped the requested stash; the second dropped what had just become `stash@{0}`. A temporary forwarding git wrapper ordered these commands deterministically after validation. Before the fix both requests succeeded, and both stashes were removed.
- Fix: serialize each owner git mutation's checks plus writes, using the real common git directory as the queue key. Worktrees share the queue because they share stashes and refs. Reads remain concurrent. Card merge/remove/PR operations and checkpoint undo/redo use the same queue.
- Regression: `src/core/workbench.test.ts:659`, “simultaneous stash drops cannot delete the next stash after both validated the same one”. It now uses two worktrees of the same repository. One succeeds, the stale request is refused, and the unrelated stash remains.
- Red: `2 !== 1` successful requests. Green: final 96-test run passes.

### P1 — Conflict resolver overwrote hand edits made after its panel opened

- Location: `src/core/git-client.ts:696`; bridge `src/core/git-handlers.ts:337`, `src/shared/protocol.ts` `git.resolve`; renderer `src/renderer/src/views/git/Resolver.tsx:69`.
- Reproduction: open a conflicted file; change it in an editor while its resolver remains open; submit the old resolver content. Before the fix the old content replaced the new work without refusal. Taking a side or removing the file had the same missing freshness check.
- Fix: return a digest of the conflict stages plus the working file's inode/device/mode/size/mtime/ctime when reading it; require that version before destructive resolution; send it from the resolver and reread after refusal. Mark-as-edited stages current disk content and does not replace it.
- Regression: `src/core/conflicts.test.ts:303`, “a stale resolver never overwrites edits made after the conflict was shown”, checks stale content, side and removal, retained bytes and unresolved index, then verifies mark-as-edited stages current contents.
- Red: missing expected rejection, file overwritten. Green: the targeted 96-test run below passes.

### P1 — Card pull-request publishing bypassed the secret gate

- Location: `src/core/pulls.ts:73`, especially gate added at line 82.
- Reproduction: approve a card containing a committed vendor-shaped key, use a signed-in stand-in gh, and invoke `cards.openPullRequest`. The separate card publisher pushed directly without the workbench's scan. The regression gives the worktree another upstream to ensure scanning cannot accidentally use that instead of origin.
- Fix: scan the exact card ref and origin destination before the publisher sends anything. It refuses rather than silently bypasses a finding; the owner can review/push through the workbench before reopening the PR flow.
- Regression: `src/core/pull-request.test.ts:111`, “a card pull request refuses secrets before publishing its branch, even when its worktree follows another remote”. Checks no branch reaches origin and no gh PR request occurs.
- Red: missing expected rejection; branch published. Green: the targeted 96-test run below passes.

### P1 — Push scanner omitted merge-resolution secrets

- Location: `src/core/git-secrets.ts:87`, merge diff flag at line 114.
- Reproduction: merge two clean branches with `--no-commit`, add a vendor-shaped key only in the merge resolution, commit, then scan/push. Ordinary `git log -p` omitted that merge patch; the scan reported no findings.
- Fix: `--diff-merges=first-parent` includes merge resolution patches while traversing all parents, retaining side-branch historical coverage.
- Regression: `src/core/workbench.test.ts:554`, “a push scans secrets introduced only by a merge resolution”, checks the finding, push refusal and unchanged bare origin.
- Red: findings `[]` instead of the expected key finding. Green: the targeted 96-test run below passes.

### P1 — Different push destination excluded history it would newly publish

- Location: `src/core/git-secrets.ts:95` through `:110`.
- Reproduction: commit a key to a private fetch remote, remove it in the next local commit, set origin's pushurl to a new bare repository, and scan/push. The scan excluded commits already in origin's remote-tracking refs, even though those refs described the fetch repository, not the new destination.
- Fix: when any actual push URL differs from the fetch URL, conservatively scan all reachable history under the same declared size/commit bounds. This applies to the workbench and direct card publisher.
- Regression: `src/core/workbench.test.ts:691`, “a different push destination scans history already present on the fetch remote”. Checks the historical finding, refusal, and untouched destination.
- Red: expected finding false. Green: the targeted 96-test run below passes.

### P1 — Untracked-diff endpoint read outside-project files through directory symlinks

- Location: `src/core/git-client.ts:204`, validation beginning at line 207.
- Reproduction: create a directory symlink in the project to a separate temporary folder; call owner `git.diff` with `area: untracked` and `linked/note.txt`. The lexical path check passed and O_NOFOLLOW protected only the final file, so outside bytes were returned. The endpoint also allowed `.git/config` despite it not being an untracked work file. Session tokens remain blocked by ACCESS; this is an untrusted-window input-validation gap.
- Fix: require Git to list the exact path as untracked and verify its real parent remains inside the checkout before reading it. Alpha.3 additionally returns an empty stale-area result for a path Git now lists in the index; [the review-introduced refresh regression](staging-refresh.md) is recorded separately.
- Regression: `src/core/workbench.test.ts:601`, “an untracked diff cannot read through a directory link outside the checkout”. Also checks `.git/config` refusal and normal untracked-file support.
- Red: missing expected rejection. Green: the targeted 96-test run below passes.

### P1 — Live-agent refusal was bypassed through another project or subfolder

- Location: `src/core/git-handlers.ts:51`, `src/core/handlers.ts:243`; checkpoint counterpart `src/core/checkpoints.ts:324` and `:351`.
- Reproduction: open a card's worktree as another project, start its agent there, then mutate/remove the worktree through the original card. The guard only listed sessions belonging to the original project. A session in a nested project was similarly invisible to a parent checkout operation. Checkpoint undo's exact-cwd query also missed a nested live agent.
- Fix: inspect live sessions across all projects and match real paths inside the affected checkout; worktree removal uses the same guard. Undo and shared-turn detection include sessions in subfolders.
- Regressions: `src/core/workbench.test.ts:633`, “an agent in a checkout opened as another project still blocks changes to that checkout”; `src/core/checkpoints.test.ts:426`, “undo refuses while another project has an agent in a subfolder of the worktree”. Assert preserved branch/folder and unchanged checkpoint file contents.
- Red: missing mutation refusal; checkpoint refusal was empty. Green: the targeted 96-test run below passes.

### P2 — Mark-as-edited deleted dangling symlinks

- Location: `src/core/git-client.ts:714`.
- Reproduction: replace a conflicted file with a symlink to a target that will be generated later; choose mark resolved as edited. `existsSync` followed the missing target, concluded the file was gone, and ran git rm, deleting the link.
- Fix: lstat determines whether the directory entry exists without following the link.
- Regression: `src/core/conflicts.test.ts:325`, “marking a conflict resolved as edited preserves a dangling symbolic link”. Checks symlink target, mode 120000 in the index and indexed target text.
- Red: lstat after resolution failed ENOENT because the link was deleted. Green: the targeted 96-test run below passes.

### P2 — Push confirmations displayed the fetch URL, not actual destinations

- Location: `src/core/git-client.ts:873`, `src/core/pulls.ts:54`.
- Reproduction: configure origin with one fetch URL and two push URLs. Both push and card-PR plans showed only the fetch repository while Git would publish elsewhere.
- Fix: ask Git for `remote get-url --push --all`; the existing string field lists every destination.
- Regression: `src/core/workbench.test.ts:617`, “push previews show every push URL, including a destination different from the fetch URL”. Checks both publisher previews.
- Red: origin fetch path instead of the two push paths. Green: the targeted 96-test run below passes.

## Verified correct and additional coverage

The named feature-matrix tests for worktrees, diffs and checkpoint safety exist and assert actual git/file/database outcomes, not merely that a function was called. Existing assertions still passed after the fixes:

- File/hunk/line staging, unstaging, no-final-newline patches, stale diff refusals and whole-file discard.
- Branch refs with leading options/control characters rejected, new branch names validated against Git; paths become literal pathspecs or follow `--`.
- Push has no force option or force refspec; divergent and remote-raced non-fast-forward pushes are refused. Pull defaults to fast-forward and only merges after explicit request.
- Normal and amended commits scan staged changes; secrets added then removed in local history are still found on push; findings redact key bytes; failing hooks, missing identity and signing errors are explained.
- Stash content/show/apply/pop/drop preserve their intended state, with stale ordinal checks now serialized.
- Clean/dirty worktree guards, merge refusal on wrong base, aborted card conflicts, setup copies, ignored-file boundaries and hooks.
- Binary conflict side choice, content conflicts, add/add, modify/delete, editor changes, inline/incomplete literal marker text, marker acknowledgment, cherry-pick continuation and abort.
- Added a real rename/rename scenario: `src/core/conflicts.test.ts:342`, “a rename on both branches can be resolved without leaving either renamed copy behind”. Git's DD/AU/UA states are resolved to the chosen rename, no duplicate survives, and the final commit tree has only the chosen path. It already passed before code changes.
- Checkpoint capture preserves working status, index bytes, HEAD, refs, reflog, stash and repository-owned objects. New snapshot objects remain in the temporary Wanigan object store.
- Checkpoints capture same-size/racy-index edits, include normal untracked files, skip oversized untracked files, report non-repositories/timeouts honestly, and record shared-session turns.
- Undo/redo works on text and binary changes, changes only the working tree, records events, refuses stale checkpoint buttons, newer edits, intervening commits, missing snapshots, unsafe .gitignore changes and deletion of previously existing files.

The feature matrix previously omitted the newer git workbench (staging, mutations, scanner and conflict resolver) and still called Changes read-only. The corrected matrix includes those claims and mappings using these tests.

## Checks actually run

- Node selected through `nvm use`: 22.23.2.
- Demonstrated red tests before each fix, as listed above. The initial PR regression called the same publisher directly, then was strengthened to use the actual owner RPC.
- Final targeted run:

  `node scripts/run-electron-node.mjs --test src/core/workbench.test.ts src/core/conflicts.test.ts src/core/pull-request.test.ts src/core/checkpoints.test.ts src/core/worktree-merge.test.ts src/core/worktree-setup.test.ts src/shared/git.test.ts src/shared/conflict.test.ts src/shared/checkpoints.test.ts src/shared/secret-scan.test.ts`

  **96 passed, 0 failed**, 29.93 seconds. Full log: `/private/tmp/wanigan2-git-tests.log`.
- Final `npm run typecheck`: both Node and renderer TypeScript projects passed, exit 0.
- `git diff --check` on every git/checkpoint/protocol/resolver file touched here: exit 0.
- The [consolidated report](README.md) records the full suite, smoke, packaging, screenshots, gitleaks and publication results.

## Literal marker coverage

The prior feature-matrix sentence “markers inside strings remain text” overstated the proof. `src/shared/conflict.test.ts:38` covers inline quoted markers, indented markers, comment dividers, incomplete/mismatched markers and an isolated Markdown underline. It does not prove language-aware recognition of complete whole-line marker blocks inside multiline strings. This documentation correction changes no application code.

Reproduction: commit a JavaScript template string containing these literal lines, then create a genuine merge conflict elsewhere in the same file:

```js
const fileText = [
  'const example = `',
  '<<<<<<< docs',
  'one',
  '=======',
  'two',
  '>>>>>>> docs',
  '`;'
].join('\n');
```

`parseConflicts` counts that complete block as a hunk. In an already-unmerged file, choosing a side for this apparent hunk changes literal content. The parser is language-agnostic; it cannot universally distinguish such text from merge markers. Review and edit the file, then choose **Mark resolved as edited** and confirm **Keep the markers and stage it**. The ordinary **Mark resolved** button writes reconstructed resolver content instead. These UI labels and routes were checked in `src/renderer/src/views/git/Resolver.tsx:132` and `:165`; the additional verification below exercised the core API, not browser clicks.

A standalone check using `testCore()` and Git 2.50.1 exercised the actual owner RPC and verified all four outcomes:

1. Literal blocks alone produce no Git-unmerged status. Both `git.conflict` and `git.resolve` refuse the ordinary file, preserving its bytes.
2. Conflicting edits to a separate value produce genuine unmerged index stages.
3. After a hand edit resolves that value while preserving the template, `git.resolve` with `asIs: true, keepMarkers: false` refuses and preserves both working bytes and every unmerged stage.
4. `asIs: true, keepMarkers: true` stages the exact hand-edited bytes, including every literal marker line, and removes all unmerged stages.

Result: **4 passed, 0 failed**, exit 0. This is additional manual actual-core verification, not a newly committed regression test or a claim of automatic language-aware resolution. The existing `src/core/conflicts.test.ts:123` tests explicit marker acknowledgment with conflict-marker bytes. The standalone reproduction and output remain at `/private/tmp/wanigan2-review/literal-conflict-markers.mjs` and `.log`; they use only temporary fake-home fixtures, with no real model or application data.

## Remaining limits / not verified

- **P2, not fixed: checkpoint disk retention is unbounded.** `src/core/checkpoints.ts:280` captures every turn, `:435` writes new commits, and `:494` only creates/uses a per-repository object store. There is no total store budget, age/turn cap, pruning or retention setting. The 20 MB rule bounds individual untracked files, not tracked files or cumulative storage. Repeated edits to a tracked binary continue adding objects. This conclusion is from code inspection, not a claim of a disk-exhaustion run. Safely deleting stored evidence needs a retention policy and a user-visible “not captured”/gone contract; no automatic evidence deletion was introduced in a safety audit.
- **Session-start race fixed in the coordinated review:** `Sessions.start` now holds the same common-directory gate through preparation and PTY spawn. The session reviewer reproduced the race and added `session-git-race.test.ts`, including pause/close/archive while waiting. External editors and git processes remain outside this in-core queue. See [trust/session findings](trust-and-sessions.md).

- Secret scanning is deliberately heuristic, not a proof of no secrets. `src/shared/secret-scan.ts:11` documents misses: short/plain passwords, unprefixed tokens without a secret-named assignment, values without digits, binary-only diffs, changed PEM body under an unchanged header, generic assignments in very long lines. Binary content marked by .gitattributes is also outside text-diff scanning. An allow marker deliberately suppresses a finding and increments its count. At 200 commits or 16 MB, the scan explicitly requires acknowledgment of incomplete coverage. No actual key was used.
- The card PR publisher still relies on gh/network outcome after the push; an authenticated gh does not prove a future PR creation will succeed. The code honestly reports “branch pushed, PR not opened” on failure. No real GitHub publication was performed through the app’s PR workflow; root subsequently published the reviewed source and releases using the owner-authorized repository workflow.
- Repository-controlled Git hooks, filters and configured remote helpers run with the user’s permissions when the owner invokes applicable Git operations. No OS sandbox is claimed; agents already run as the user. Read-only workbench diff/scan paths explicitly disable fsmonitor, external diff and textconv.
- Narrow-window/keyboard/theme visual checks, real native app packaging, release DMG SHA/mount/demo, live model behavior and real provider resumes were delegated outside this scope. No claim here substitutes stand-ins for actual model verification.
