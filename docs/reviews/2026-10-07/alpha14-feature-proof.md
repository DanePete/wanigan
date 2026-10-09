# Alpha.14 feature proof — plugin paths and legacy selection

This is an unpublished candidate checkpoint on corrected alpha.13 lineage
`830caa6e1e971a407dd019fd5996cad8b263b7ab`. At the combined code checkpoint, the
isolated integration contained 642 files and eight selected paths. The two component corrections
have focused red/green and type evidence. The exact combined integration then
passed both typechecks and 163/163 tests, and its production build exited zero
with 109 actual outputs. Four actual before/after UI stages then passed with
32 cases and 64 individually reviewed images. **Full local gate, native/package
verification, exact-commit CI and alpha.14 publication remain pending.** The
audit continues.

## MCP plugin files and preferred legacy configuration

Plugin manifests, the selected declared MCP file, and root `.mcp.json` now use
bounded regular-file reads after lexical and canonical checks against the
installed plugin root. A malformed, inaccessible, dangling or escaping selected
source remains unknown with a fixed note, while healthy independent rows remain
visible. An invalid explicit declaration no longer silently selects the root
fallback. This compatibility choice is deliberate; owned fixtures do not prove
all installed-provider behavior.

The preferred legacy configuration is retained unless genuine absence is
established. EACCES, EPERM, ENOTDIR, present nonregular entries and dangling
leaf/ancestor links cannot silently substitute readable fallback data. Preview
and fresh apply inspect that state; unknown preconditions refuse before CLI
dispatch. A cached removal plan also rechecks. Genuine absence and valid
personal links remain supported. Generic `readJson` and the RPC protocol are
unchanged.

The final exact **32-test** file on independently preserved pristine `a06d11ab…`
produced **seven passing controls and 25 failures**, actual exit1. Corrected
source passed **32/32**, selected neighbors **100/100**, and both Node and web
typechecks exited zero. Source guards and owned cleanup passed. A second review
caught a leaf-only absence ambiguity: adding five ancestor cases first gave
29 passes/three failures, then 32/32 after checking the nearest existing
ancestor. Genuine absence and contained-link controls already passed. Earlier
27-case evidence and a test-only optional-value narrowing error are preserved.

## Skills plugin directories

An owned owner-RPC probe confirmed that both a declared skills-directory link
and a default child-directory link could escape the installed plugin root:
outside invented metadata/full text was listed and read, and copy preview was
allowed. The contained plugin and deliberate personal-link controls worked;
an outside `SKILL.md` leaf remained refused. No protected owner data or copy
apply was used in that observation.

The correction checks the installed plugin anchor and canonical root/child
directory **before enumeration or frontmatter**, then carries the checked
canonical directory into metadata, measurement, owner reads and copy capture.
Outside, dangling and inaccessible directories are omitted with the fixed note
“Some plugin skill directories could not be read safely and were not listed.”
Healthy rows remain. An ordinarily absent optional default skills directory
remains known absence without that note. Contained plugin aliases and deliberate
personal/project folder links remain supported; the existing leaf refusal is
retained.

Cached actions rescan. The tested retarget to an outside directory now refuses
read and copy preview. A contained A-to-B alias retarget invalidates the existing
source-bound copy approval even when file bytes match. Alpha.13's retained
copy bytes, effective modes, bounds and approval checks remain intact.

The final exact **19-test** file on pristine alpha.14 MCP source produced
**nine passing controls and ten failures**, actual exit1. Corrected source
passed **19/19**, selected neighbors **75/75**, and both typechecks exited zero.
The 75-test selection includes the 32 MCP cases; component totals must not be
added as disjoint coverage. Earlier 8-pass/11-fail evidence is preserved: one
failure required new refusal wording although old stale apply already refused
via its approval fingerprint. The corrected assertion counts that safe behavior
as a passing control. **No old copy-apply bypass is claimed.**

## Evidence and limits

All component runs used invented owned files, sealed fake homes and testCore
stand-ins. No real credentials, provider/model call, configured MCP endpoint or
paid operation ran. Source and test bytes were independently reviewed; original
repositories, prior integration snapshots and earlier evidence were preserved.

Canonical checks and bounded reads are not an atomic filesystem transaction.
Arbitrary concurrent swaps or swap-and-restore writers remain outside this
proof. The existing destination overwrite/rollback limits remain; a refused
postcheck does not undo dispatched work. Unsupported provider schemas, broader
field coercions, aggregate work/memory and heuristic masking forms/encodings
remain audit work. No new generic filesystem or personal-link policy is claimed.

Records below are retained under `/private/tmp/wanigan2-review`:

| Record | SHA-256 |
| --- | --- |
| `alpha14-plugin-legacy-5r1_wnhh/verification.json` | `e5b970026daa8844203c8035c76e3cd175dab088a168565c3e47744a487693ce` |
| `alpha14-plugin-legacy-revision2-independent-peer-review.json` | `da29f0a5ba00c9d9c7e86353e3142b08a4c8ce0ff5bd9044d05222b05f2cde8e` |
| `alpha14-skills-plugin-directory-32e78z83/verification.json` | `1b6e5ef2d0ab82f1c83aacbc3a618d58dd64b81fd8c38e902f05e0ee21251009` |
| `alpha14-skills-plugin-directory-independent-peer-review.json` | `168094da6528a8eaed0ba3b9494ae71f10a4ffed2dc4de1edb6cb39a3b31454f` |
| `skills-plugin-directory-probe-rz23ni73/verification.json` | `230ca8f70f3de0c7e2fd3cb9dbf12110391337c25614abac23aff6f010ab32ec` |
| `skills-plugin-directory-probe-actual-peer-review.json` | `3e84c6bd3d7119a8f1480b53e7078452163a7f81be76462c804436ceacd15c47` |
| `alpha14-combined-code-source-manifest.json` | `1b3ce51fbd93f3729eb9a26fa7f5d4f5a74d0ac08b167416b33a7afbf34135f1` |

The [appended audit](continued-audit.md#alpha13-corrected-release-and-website-completed)
records completed alpha.13 local/native/CI/release and eight-stage website proof.
That publication is separate from this candidate. No future image, unit count or
gate is credited by prepared metadata.


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
