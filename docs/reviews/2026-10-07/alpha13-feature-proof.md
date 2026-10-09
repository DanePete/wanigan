# Alpha.13 focused candidate feature proof

Baseline: published alpha.12 `feaf446664e5bd341e58f5d82f1e8a276fad108d`.
The complete **180,838-byte historical audit prefix** remains exact, including
retained CI failures, pending checkpoints and the original Skills observation.
The separate alpha.12 feature-proof file is unchanged. The appended audit records
alpha.12's subsequent verification/publication rather than rewriting that history.

Alpha.12 is published, its two fresh unauthenticated asset downloads match the
verified hashes, and its website update passed all eight live stages and 459
functional checks. All 36 fresh live images were reviewed. These are alpha.12
results; they do not certify the next source changes described here.

**Alpha.13 remains a component-verified candidate.** Both Skills and MCP corrections have
focused red/green and type evidence. Their integrated union passed both typechecks
and 112 tests, then produced 109 outputs in an actual production build. The actual 12-case corrected MCP capture and its complete visual review also
passed. The unfiltered full gate, native/package checks, final secret scan/commit,
exact-commit CI, public assets and website publication remain pending. No owner source or frozen alpha.12 source was changed
by this documentation preparation.

The feature matrix keeps all **252 rows**. Only **Copy and remove**, **MCP listed**
and **Add, remove, check** are selected for this batch; the other **249 rows** must
retain their exact alpha.12 bytes. Inherited rows describe their historical
fixture evidence, not a new execution on alpha.13. No blanket “fixed” or complete
audit claim follows from a component pass.

| Matrix row | Observed assertion or current scope | Limits |
| --- | --- | --- |
| Copy and remove | Real owner RPC refuses an old plan after an equal-size/restored-mtime content edit, then accepts a fresh plan and writes the literal changed bytes. Mode, empty-directory and skipped-link changes require review. A controlled source edit when destination creation begins still copies the approved retained bytes. | No general source-tree snapshot or arbitrary external-writer exclusion. Existing destination replacement fingerprint, overwrite race and rollback semantics are unchanged. Removal behavior is retained evidence, not a new implementation. |
| MCP listed | Malformed nested collections retain scoped unknown notes; invalid rows and non-string arguments are omitted with fixed notes while healthy rows from the same file remain. Missing/empty mappings stay known absence. | No universal secret detector, exhaustive configuration inventory, plugin/legacy containment, arbitrary encoding or real credential exposure claim. |
| Add, remove, check | Raw relevant collections and target rows decide pre/postconditions. Unknown preflight starts no CLI; invalid added rows or malformed post-removal state refuse, while actual empty-map removal succeeds. | An already-dispatched stand-in can change its owned file before verification refuses; refusal is not rollback. Real installed-provider behavior and transactional file locking remain unverified. |

## Observed Skills proof

`skills-copy-fix-revision2-evidence/verification.json` has SHA-256
`f9226c40fe161bc06c91ad677fd9ad15124049fc9762873738ea4ba499b72d67`.
The candidate changes only `src/core/skills.ts` and adds
`src/core/skills-copy-consent.test.ts`; every other candidate baseline file and all
625 frozen alpha.12 files remained byte-identical. The selected hashes are
`337a5014c0d6f9a0f2ac0cab0d3b6fb065ba27ff5aa7a9d3acf8786516b99119`
and `8e12e4469b7e769e8f859747b3a3b8d4348da8366c988c66e69d29982779e0b8`.

- Initial content, metadata and traversal red tests preceded their respective
  changes. The separate final original-source comparison used the same first ten
  new tests on unchanged `feaf4466…`: **two passed/eight failed**, actual exit1.
  It ran after those initial slices and does not replace their earlier red runs.
- Independent review caught a new intermediate mode0644 permission window.
  The actual filesystem-boundary assertion failed before the exclusive descriptor
  correction and passed afterward. New files are opened mode0600, written from
  captured buffers and changed to the approved final mode through that same fd.
- Two controlled directory replacements gave **two failures before/two passes
  after** canonical-path and dev/inode checks. The link-swap case refused before
  opening outside-file bytes; the inode-swap case refused after a bounded read.
- Final new/neighbor verification passed **27/27 tests**, zero failed/skipped/
  cancelled, and Node typechecking exited zero. Thirteen tests are new. These
  counts overlap prior suites and must not be summed into a combined total.
- Exact 1,000-file/25-MiB and 4,000-entry boundaries, the next file/byte/entry,
  failed listing/stat reads, top-level linked skills, internal skipped links,
  copied empty directories and actual file contents/modes are exercised.
  The traversal cap does not bound preceding discovery or all process memory.

Each actual run used a fake home, testCore and stand-ins, retained its source
before/after guards and removed its owned environment. The initial unprivileged
Core-socket EPERM is retained as a sandbox failure, not a behavioral red.
The prior candidate's two source preimages and all earlier evidence remain.
Independent review (`skills-copy-fix-revision2-peer-review.json`,
`ba0935d58eca9cd2c29eb2bef0062f65bc1798d4e9dbcd8af233d2953609c12f`)
found no blocking finding within this scope.

Portable Node pathname checks cannot rule out an external writer swapping and
restoring an ancestor between syscalls. The output is the captured bytes whose
digest was compared, not a general atomic filesystem snapshot. No change to
destination content fingerprints or overwrite recovery is claimed.

## MCP component checkpoint

`alpha13-mcp-schema-xw78ruo7/verification-v2.json` has SHA-256
`f609a8eda045b63c802f200609c3fd0f49366fa3ca2eb791e3ecd702b46e43b1`.
Only `src/core/mcp.ts` and new `src/core/mcp-schema.test.ts` differ in this
isolated component. Their final hashes are
`f3bc1abcb73bbdf624d3eb0b38faa9c7c44b529b2b674ffeb1667e2f30407ee8`
and `03fe58937500c87bd5814a93f25bd6ad5bd4e6781ee1722bd6cf50c3493848f6`.

The earlier final 16-case owner-RPC corpus on unchanged alpha.12 produced **two
healthy passes and 14 failures**, actual exit1. That corpus and its first 50/50 green
result remain historical. The final revision adds one healthy plugin fixture for
**17 new tests**, and expands the neighbor set: **85/85 passed**, zero failures/skips/
cancellations; Node and web typechecks each exited zero. Source guards and owned
environment cleanup passed. These component counts overlap prior tests and are
not a release-suite total. Independent review (`alpha13-mcp-schema-revision2-peer-review.json`,
`646a40cac4ee1c4bb89368cef24dfddd7bd3eb1eb34918cf0abac4c8d5364f20`)
found no blocking issue within this scope.

The asserted scopes are Claude user/local/project and Codex user/project.
Explicit malformed collections are unknown; genuinely missing or empty maps
remain known absence. Healthy same-file rows survive invalid row/argument
entries. Fixed notes contain no invented raw schema values. Preflight checks
refuse before CLI dispatch for unknown relevant mappings or invalid targets;
postchecks refuse invalid additions and unverifiable removals. The test stand-in
actually mutates its owned file, so a refused postcheck is explicitly not rollback.

No provider, configured MCP server, credential or model ran. Other field
coercions, plugin/manifest/legacy selection and containment, arbitrary schemas
and masking encodings remain open. Plugin rows retain direct pair iteration and the argument guard. Review showed
that the selector currently returns one mapping, so the proposed duplicate-pair
defect is unreachable; its cleanup is not a confirmed bug or new red proof. The
added fixture covers declared-source selection, two same-name installed plugins
with distinct server IDs, valid siblings and invalid arguments without CLI calls.
This is not comprehensive plugin validation or an aggregate memory bound. No
full/native/CI/publication result follows from this component receipt.

## Integrated alpha.13 focused/build checkpoint

The exact combined 627-file/seven-selected-path source manifest is
`alpha13-code-source-manifest.json`, SHA-256
`01fd1197ff29f2dbeddcdc4ed4980cb509679bb71a1fbc7cabda2d983ac83c07`.
It includes four production/test paths plus README/package/lock version metadata,
with 620 unselected baseline files preserved. Dependencies were copied physically
from the previously tested isolated installation; no fresh install is claimed.

The actual combined typechecks and **112/112 tests** passed, zero fail/skip/cancel,
in `alpha13-integration-focused-KmOmTf` (result
`a2b8525bdbe9d0226603f3acf0326c367f0f57a84cfa9a06b162490161a4855a`).
The subsequent actual production build exited zero and recorded 109 outputs in
`alpha13-integration-build-Uh86Ab` (result
`a8d95562ab9376945c49fabae294895110be3a384bbf866c0dcb7fadd9d14006`).
Both retained source/helper guards and owned cleanup with no interruption or
signal. These observations do not replace the unfiltered full gate or native
execution.

The feaf625/109 before capture `alpha13-mcp-ui-before-Ns6w6T` passed **12 known-before
cases** and produced 24 fresh PNGs; its existing outputs were reused without a new
build. The corrected `alpha13-mcp-ui-after-7jVHza` passed **12/12 cases**, produced
24 fresh PNGs and was bound to the actual 627-file/109-output build above. Both
wrappers and durable supervisors exited zero, with source/output guards and
owned cleanup. An initial sandbox-only before attempt ended before any Core
case/image and remains retained, separately from behavioral evidence.

The cases use actual owner RPC and the actual renderer for three scenarios in
both themes at 1440 and 960px: malformed nested mapping, invalid arguments beside a
healthy row, and removal whose stand-in writes an invalid postcondition. No MCP
reply or DOM was substituted. Both stages made four exact owned removal calls,
zero sessions and no real provider/MCP/model request. All 48 original PNGs were
individually reviewed; root also inspected six representative images. Actual
owner rows/config bytes and successful owned cleanup remain pinned.

After, a scoped unknown note replaces false absence, a valid same-file row
survives malformed arguments, and a failed removal keeps the refusal dialog
without a success toast. The header says 0 found beside the unknown collection
and 1 found for the healthy-row case. The removal backdrop retains two cached
initial rows/count while a fresh owner read reports unknown state; it does not
show rollback or a complete current inventory.

The [12 durable affected crops](continued-audit.md#alpha13-durable-mcp-ui-selection)
link every scenario's before/after at 960px in both themes. The before removal
crop omits the false toast; pinned full viewport images and actual successful
owner RPC prove that observation. The crop alone is not toast evidence. The
final visual receipt `alpha13-mcp-ui-after-visual-review.json` has SHA-256
`50eea7def43528ccd3c64dcfb1b532c7d5343144238868fb13de5607f05c466b`.
Static review is not keyboard-only, screen-reader, real-provider or broad-schema
verification. The full suite, native checks and release gates remain pending.

## Completed alpha.12 evidence, kept separate

The [appended audit](continued-audit.md#alpha12-corrected-verification-release-and-website-completed)
records the actual corrected gate: **955/955 units**, both sweeps and 72 targeted
cases; crawler 1,430 passed, zero failed, 368 gone. The detached npm process's
actual zero exit was observed through the OS; the interrupted original wrapper's
exit remains unknown. Source guards and owned cleanup followed that event.
Both new exact-commit CI runs independently passed 955 units, both sweeps and 72
cases, with zero crawler failures. Main recorded 1,434 crawler passes/375 gone;
review recorded 1,431/375. Gone controls remain a coverage gap.

Seven native observations retain their original 606/608-file execution bindings.
The corrected 625-file source and its 109 rebuilt outputs were verified identical
to those artifacts; the rebind does not constitute fresh native execution.
The existing alpha.12 draft was published and its actual DMG/ZIP downloads each
returned HTTP200 with the complete matching size and SHA-256. Website commit
`8c4cd2ed1f04a48c9be297c3a02249b09288b596` deployed as
`2f90b054-6cab-4466-85a2-a0c93c1b8cc7`; all eight live stages exited zero.
Its before images were explicitly reused historical local alpha.11 after images,
and the fresh live captures do not claim video playback or real Phone operation.

| Evidence record | SHA-256 |
| --- | --- |
| `alpha12-ci-full-verification-2OEw5n.json` | `071f881100cb2bb459527a4c94eda553eb095698f1de2eb6cc288016ad8def07` |
| `alpha12-ci-native-rebind.json` | `2187457d4be60e35e9f530ecb3c059c7d7124b091c166226ab56db453f855fac` |
| `alpha12-publication-verified.json` | `ae6699bc46cb0fcbea55463f8bcae718db3494f4351511df89ac0e45021d35d2` |
| `alpha12-site-phone-live-final.json` | `f74e784c6d8a578e86202b52ac6737322f579f4573dba98a314b45bc6e0c962b` |

## Pending verification and audit limits

Alpha.13 has combined focused/type/build and actual MCP before/after evidence,
but no full/native/package/CI/publication result at this checkpoint. No dependency refresh, new package provenance or public-download
identity is inferred from alpha.12. Published alpha.12 continues to disclose the
Skills and nested MCP gaps until a verified later release is published.

Aggregate enumeration/parsing memory, cumulative evidence/attachment/checkpoint
storage, plugin/legacy selection and containment, unsupported schemas/encodings,
external writers, real providers/models/MCP/Phone/Tailscale, clean minimum-macOS
Gatekeeper, other OS/architectures and WebGPU lifecycle remain open. Fixture runs
use no credentials or paid model calls. The audit continues.

## Alpha.13 CI fixture correction and controlled proof

This appended checkpoint supersedes the earlier pending-full status only for
original commit `a06d11ab1d342534a40643ac943d27f02525a8fe`. Its unfiltered
local `npm test` completed with actual npm and durable supervisor exit zero:
985/985 units, both UI sweeps, 72 targeted cases, and crawler 1,428 passed, zero
failed, 11 allowed, one guarded and 368 gone. Six raw RPC refusals were recorded;
none qualified as resize refusals. Source guards and owned cleanup passed, and
the 337-file artifact archive was preserved. Dependencies were an independent
physical copy of previously tested dependencies; no fresh install is claimed.
This historical pass does not verify the following correction.

The same commit's codex-review CI run `37816570156` passed 985 units, then
failed at `scripts/ui-sweep.mjs:550` because `.drawer .merge-conflict` was absent.
Its 37 saved images precede the fatal failure; the final DOM, bridge state and
suppressed prerequisite-error array were not recorded. The exact event ordering
of that run remains unknown.

The focused probe used the actual renderer and seeded Core, the existing
explicit merge-reply fixture, and two native hash writes in one task. In both
themes, that controlled timing retained the old drawer with zero new filtered
session queries and zero merge calls; the original five-second merge action
timed out against a disabled button. This expected timeout was asserted inside
an overall successful diagnostic run, not a failed full-suite exit. After
observing real drawer detachment, reopening created a new drawer and a fresh
filtered session query; the original conflict text, all action labels, merge
resolution calls with `false` then `true`, and Changes route assertions passed.

The wrapper, probe and owned gateway each exited zero; 640 baseline files, 640
candidate files and 109 built outputs matched their expected guards, and owned
cleanup passed. All four 1440×900 screenshots were individually reviewed in dark
and light themes, showing the disabled stale control and complete conflict
actions. No material visual blocker was observed. Merge replies remain the
sweep's explicit fixture, so this does not establish real Git merge behavior.
No product code, renderer output, synthetic DOM or custom hash event substituted
for the real renderer transition.

The one-path sweep correction waits for actual detachment, reports prerequisite
state on failure and rethrows the original error. It retains the original
five-second action waits, conflict assertions and merge replies. See the
[full appended audit](continued-audit.md#alpha13-ci-fixture-correction-and-controlled-proof)
for exact evidence pins and limits. The corrected full gate, new exact-commit
CI on both branches, fresh native/package checks, release and website update
remain pending. All broader audit gaps listed above remain open.
