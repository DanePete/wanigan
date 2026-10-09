# Alpha.16 feature proof

This batch corrects untracked-diff refusals, limits logical History discovery work, and prevents a disposed Orb mount from disrupting its replacement. Component regressions, both combined typechecks, 148 selected cases and the 109-output production build passed. Before/after renderer checks passed in both themes. The full local gate, native packaging, new CI and publication remain pending at this checkpoint. The broader audit remains open.

## Git reads

An unreadable untracked file previously returned an empty successful diff. The workbench also treated oversized and symbolic-link notes as an empty diff. It now refuses those reads with an explanation; a genuine empty file and binary marker retain their existing meaning. The older project diff API now refuses failed reads while preserving its existing informational notes.

The same seven owner-RPC cases produced three passing controls and four intended failures on pristine alpha.15, then passed **7/7** with the correction. The **61-case** selected suite (including those seven cases) and both typecheckers passed. Actual EACCES is required by the fixture before asserting refusal; permissions recover and the original index and file bytes survive. Cases also cover the exact 200,000-byte limit, a cap-plus-one file, binary/empty files, links, FIFOs and stale partial staging. An initial TypeScript narrowing error was preserved and corrected with an explicit return before the final successful checks. These are owned local fixtures, not all-platform or external-writer guarantees.

## History discovery

A request now admits accounts, directory entries, rows, cell and aggregate metadata sizes, database/WAL copies and summary input before returning a result. Exhaustion refuses the whole query with “History is too large to inspect safely”; it never authorizes reading or resuming an earlier match from a partially inspected account set. Cold and cached reads charge the same logical costs. No account, transcript or stored evidence is removed.

Production defaults are 128 accounts, 65,536 directory entries, 32,768 rows, 16 MiB per accounted cell, 64 MiB accounted metadata, 256 MiB database/WAL input and 256 MiB summary input per request. Text accounts for twice its UTF-8 byte length; these numbers are accounting limits, not exact heap measurements. A trusted constructor-only seam can lower limits for tests; it is absent from settings and RPC.

The final twelve-case suite produced two passing compatibility controls and ten intended refusals missing on pristine source, then passed **12/12** after correction. The **75-case** selected suite (including those twelve cases) and both typecheckers passed. Exact-boundary and recovery fixtures include unrelated directory entries, a later over-budget account, binary cells, cached summaries/indexes, project session references and actual readable rollout content. Ordinary and WITHOUT ROWID tables remain supported; a VIEW or virtual table named `threads` is refused because two-pass admission cannot establish stable computed values. Earlier fixture revisions and their failures remain preserved.

The admission is not a CPU deadline, SQLite VM instruction budget, total heap bound or atomic snapshot of an external writer. Same-size/same-timestamp replacement and permission freshness remain separate limitations. Cumulative evidence retention is also separate; this batch adds no automatic deletion policy.

## Orb lifecycle

A real native WebGPU probe held delivery of actual asset, pipeline and completed-frame promises to reproduce lifecycle ordering. Pristine source passed two healthy controls and failed three regressions: an old mount overwrote the new context, old cleanup unconfigured the replacement, and an old completed-frame continuation reported ready after disposal.

The correction gives each mount a cancellation signal, checks it after asynchronous boundaries and before configuring/adopting a runtime, records which device currently owns a canvas context, and guards the frame continuation. Cleanup always destroys its own device and releases a context only while it still owns it. Cancellation is cooperative when promises settle; it does not claim to interrupt underlying GPU compilation or fetch immediately.

The same five native cases then passed with zero native validation errors, fallback notifications or unhandled errors. All owned devices, browser and loopback server closed; the successful fake environment was removed. Nine fresh green PNGs were individually reviewed: replacements remain visibly rendered after old work completes. This is one cached Chromium 151 / Apple Metal adapter fixture, not a claim about every GPU, the complete React lifecycle or the cause of earlier unrelated GPU warnings. The existing animation probe records frames; it does not establish a numerical 1/255 match against Wanigan 1.

The repository now includes the optional diagnostic `node scripts/orb-lifecycle-check.mjs --run --browser /absolute/path/to/Chrome`. Without `--run`, it only describes the plan. It runs real Orb modules in a disposable native browser with an empty environment, never starts the app/Core or a provider, and requires an explicit browser path. This is separate from `npm test`; a machine without a usable native WebGPU adapter reports unsupported. The integrated command subsequently passed the same five cases with actual worker and wrapper exit zero, all 666 source files and 109 built outputs unchanged, and owned browser/server cleanup complete. All nine new images were individually reviewed; no replacement became blank.

## Renderer outcome checks

The actual before and after runs each passed four cases and produced eight fresh PNGs at 1440×1000; all sixteen images were individually reviewed at original detail. Both child and wrapper exits were zero, every disposable Core closed, and source/output guards and successful-state cleanup passed. There were no observed clipping, overlap or horizontal-overflow defects.

The real renderer and disposable Core show Git's old false-empty outcome before correction, then an explicit read refusal afterward. Both builds show the two added lines after restoring only the owned fixture's permissions. History uses identical tiny data and a lowered four-entry constructor limit: published15 ignores the option and shows two rows, while the corrected source refuses the fifth visited entry. Removing that exact extra entry and pressing Retry restores both conversations. This verifies the lower-limit seam and recovery, not a default-cap stress workload.

History displays “History could not be loaded”, the resource-refusal explanation and Retry, so a deliberate refusal is not mislabeled as a stopped core. The shared component's default stays unchanged for other callers. Owner-RPC evidence agreed with every visible outcome; project/card/session/activity rows and fixed fixture bytes stayed unchanged. No real account, key, paid model, provider session or installed owner app participated.

| View and state | Before (published15) | After (candidate16) |
|---|---|---|
| Dark git — blocked | [Image](alpha16/dark-git-blocked-before.png) | [Image](alpha16/dark-git-blocked-after.png) |
| Dark git — recovered | [Image](alpha16/dark-git-recovered-before.png) | [Image](alpha16/dark-git-recovered-after.png) |
| Dark history — blocked | [Image](alpha16/dark-history-blocked-before.png) | [Image](alpha16/dark-history-blocked-after.png) |
| Dark history — recovered | [Image](alpha16/dark-history-recovered-before.png) | [Image](alpha16/dark-history-recovered-after.png) |
| Light git — blocked | [Image](alpha16/light-git-blocked-before.png) | [Image](alpha16/light-git-blocked-after.png) |
| Light git — recovered | [Image](alpha16/light-git-recovered-before.png) | [Image](alpha16/light-git-recovered-after.png) |
| Light history — blocked | [Image](alpha16/light-history-blocked-before.png) | [Image](alpha16/light-history-blocked-after.png) |
| Light history — recovered | [Image](alpha16/light-history-recovered-before.png) | [Image](alpha16/light-history-recovered-after.png) |

## Combined verification

The measured checkpoint contains 664 source files and fifteen selected code/test/version paths. Both typecheckers and the combined 17-file **148/148** suite passed without skipped, canceled or failing cases. The 61-case Git and 75-case History selections already include their seven and twelve new regressions; twelve existing Orb choreography tests bring the union to 148. The production build produced 109 inventoried outputs. Both runners and supervisors exited zero, current source/output hashes matched, and their successful owned states were removed.

Dependencies are a verified, independently writable filesystem clone of the frozen alpha.15 dependency directory: 11,809 regular files, 63 internal relative links and distinct inodes. Initial copy-on-write storage can be shared. This is not a fresh install, new dependency resolution, arbitrary-writer guarantee or deliberate write-isolation experiment. Optional native regression scripts and these documentation/images are added after that measured code checkpoint; the final full gate will cover the final committed source.

## Evidence

Retained local receipts under `/private/tmp/wanigan2-review/` identify actual runs; they are not public download links. Final release verification is recorded separately.

| Receipt | SHA-256 |
|---|---|
| `next-untracked-diff-component-byh8lep6/final-manifest.json` | `183fdae47ac98ffb803cc3ba9089391d1528f0a1fd9624b7234715918455565d` |
| `next-history-budget-x5vrhbsw/final-manifest.json` | `233cc49e2e8989e7cf415c1caf9cb63d3ed8bad41f369971d80363170e7c6132` |
| `next-orb-lifecycle-vq5y7gup/baseline-red-verification.json` | `6d2ca6d2b0ffda39b98cec146f446c957029d373ca3c29247958d90c840276d3` |
| `next-orb-lifecycle-vq5y7gup/native-green-verification.json` | `b658ae6fe97542cd1ddae7f1083062a6664ef6c3de45f8365fce7500c7eeabf2` |
| `next-orb-lifecycle-vq5y7gup/root-green-visual-review.json` | `c66b881798cf06c0c89b1b5ccdc655592e3b3499f2cec4e6f9eea8d5ab837dab` |
| `alpha16-durable-orb-verification.json` | `c25eb8f9f63235c333a9c0f4ef4e386a8eb48e5c534277ac3f8926e93300070d` |
| `alpha16-durable-orb-root-visual-review.json` | `e5fcc05c582cc0b2fe7a672b1678388664e1b938f4c32ba09e4ac32e4ab1894b` |
| `alpha16-combined-verification.json` | `0b7a17fd6f2d61f4938ad6c6fb4b4f2e73525ecd802cfd05e6cd25431806cb5c` |
| `alpha16-outcomes-ui-before-OtEBNv/root-visual-review.json` | `1023546b0b134be68b079c4f6ea0b844a15fba7f93aa9158f843246af0868d4a` |
| `alpha16-outcomes-ui-after-oHw0So/root-visual-review.json` | `727322324608fb7de15f68c77f6828acdaf048c87a8cb362937f4799ca0d6f57` |

## Alpha.16 crawler expectation correction

The first committed alpha.16 full run (`8179813440e01d611731a2fd84c022f55975917e`) passed both typechecks, all 1,063 unit tests, desktop and Phone sweeps, and all 72 targeted UI checks. Its complete crawl recorded 1,427 passes and one failure: the History failure/retry check still expected “Wanigan’s core is not answering” after History deliberately adopted “History could not be loaded”. The runner and supervisor exited 1. This is a stale test expectation, not a passed full gate. The failed state, all 361 artifact files, source manifest, runner inputs and logs are preserved.

The crawler now selects the expected heading per view and checks that same heading disappears after Retry. History supplies its specific title; all other views retain the existing default. Empty-state rejection, Retry, controls, timeouts and allowed outcomes are unchanged. The focused Checks run passed **29/29**, with actual child and wrapper exit zero, unchanged 683 source/109 built-output guards and owned cleanup verified. It reused the actual alpha.16 renderer without rebuilding. No production code changed in this correction. A new committed full local run and both exact-commit GitHub workflows are required before publication.

Retained receipt `alpha16-history-crawl-correction-pc7gas9m/verification.json` has SHA-256 `64e53130d7d4d07c59f5195472424c15323d15a8c2be3df8e88bbcac1c03ddc4`; its failed-full archive manifest has SHA-256 `f6c1d5a01e1a4bcb703f95e8233c47cd9a6393633d063c8bccfcc845b6af4c1b`. The broader audit remains open.
