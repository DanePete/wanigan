# Alpha.15 component feature proof

Three main-process corrections have measured pristine red and corrected green
evidence. At the combined code checkpoint, isolated `2.0.0-alpha.15` contained
661 files and nine selected paths, based on published alpha.14
`5f967ffc9b13af6c535efb9a78cd349530efc0d1`. Both combined typechecks, 90 selected tests and the 109-output production build
passed. Final commit, full/native/CI and alpha.15 publication remain pending.
This is a pre-release checkpoint, not a release verdict or a completed audit.

The [continued audit](continued-audit.md#alpha14-release-and-website-completed)
records alpha.14's completed local/native/CI/release/website proof, its failed
main-CI attempt and successful unchanged retry, and the interrupted diagnostic.
The [alpha.14 feature proof](alpha14-feature-proof.md) remains unchanged as its
historical pre-release checkpoint.

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
