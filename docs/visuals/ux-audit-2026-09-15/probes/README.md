# September 15 UX baseline probes

These are **synthetic renderer experiments**, using the built Wanigan renderer
inside a separate Electron BrowserWindow. The bridge is the repository's
`scripts/renderer-harness.mjs` STUB plus explicit overrides in
`wanigan-ux-baseline.mjs.txt` (an archived source snapshot). Every screenshot carries a fixture label.

No production main process, preload bridge, provider request, agent session, Git
command, or real user data was used. These results demonstrate renderer behavior
for the supplied inputs. They do not validate main-process behavior, persistence,
or real agent execution. The fixture's blank terminal is deliberate and is not a
reported product defect.

`verification.json` records each input and the observed DOM state, the fixture
profile path, the renderer index hash, and renderer errors. The run completed
without renderer errors.

## Reproduced findings

1. **Project context is lost across a global detour.** The initial scope is
   `storefront` and the selected subview is Changes. Opening Fleet changes scope
   to All spaces. Returning through Projects opens Sessions with All spaces,
   rather than restoring storefront/Changes.
   Evidence: `scope-01-project-changes-{dark,light}.png` and
   `scope-02-returned-projects-{dark,light}.png`.
2. **The destination sidebar retains opener focus and does not dismiss on
   Escape.** Focus remained on the All destinations button after opening; the
   sidebar remained visible after Escape.
   Evidence: `sidebar-open-{dark,light}.png` and the recorded active-element
   attributes in `verification.json`.
3. **The palette does not recognize two names visible elsewhere in the app.**
   Searching Changes produced zero results. The synthetic session's
   `displayTitle` was AuroraQuantumFox, visibly used by Sessions, but searching
   that exact title also produced zero results. Transcript search returned an
   explicit empty fixture so it could not accidentally mask this result.
   Evidence: `palette-changes-{dark,light}.png` and
   `palette-renamed-session-{dark,light}.png`.
4. **An unreadable changes response renders as no changes.** The fixture returned
   `isRepo: true`, `files: []`, `attributed: false`, and
   `unreadable: 'SYNTHETIC Git status failed: permission denied'`. The panel
   displayed “No changes yet. Edits appear here as the agent makes them.” The
   recorded calls confirm the read used `/example/storefront` and `s1`.
   Evidence: `code-unreadable-response-{dark,light}.png`.

## Reproduction

This is the historical pre-overhaul harness. Its selectors require the original
renderer identified in the parent source manifest. From the repository root,
using Node 22.23.2 and that baseline build:

```sh
cp docs/visuals/ux-audit-2026-09-15/probes/wanigan-ux-baseline.mjs.txt /private/tmp/wanigan-ux-baseline.mjs
node /private/tmp/wanigan-ux-baseline.mjs
```

The script uses `process.cwd()` as the repository root; set `WANIGAN_REPO` when
running elsewhere. It creates a temporary profile and closes its Electron window
when finished. It intentionally retains that temporary directory for inspection.
Running it replaces the probe artifacts in this directory. Preserve the recorded
baseline before doing so.

The current renderer is verified by `scripts/probe-workbench-navigation.mjs` and
`scripts/probe-workbench-evidence.mjs`; their results are indexed in
[`../../workbench-2026-09-15/README.md`](../../workbench-2026-09-15/README.md).
They assert the corrected behavior and include verification refresh after
navigation, which the original harness did not exercise.
