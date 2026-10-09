# Extra UI review — 960 × 700, dark and light

Run against `startGateway({ demo: true })`, using a separate temporary core, fake accounts and stand-in agents. No real data or models were used. Chromium had a temporary profile. Expanded evidence is under `/private/tmp/wanigan2-review/ui-extra`; durable [before/after screenshots](screenshots/README.md) accompany this report; `report.json` contains the measured routes, rendered input names, focus styles, dialog results and errors. Accessibility snapshots accompany each screenshot.

## New finding: P2 — some dialogs leave keyboard focus behind the modal

`src/renderer/src/components/ui.tsx:190` preferred a body input/button, or a `data-autofocus` target. A text-only confirmation has no body field; New Session’s preferred Start button is disabled in a paused project. In either case focus remained behind the modal. Tab then operated the covered page, contrary to the modal’s accessibility contract.

Reproductions, observed in both themes:

1. Demo → Northstar → Changes → NS-13 → Mark resolved with conflicts remaining. The confirmation appears, then Tab focuses “Show what both sides came from” behind it. The audit observed 15 consecutive Tab presses outside the dialog.
2. Demo → paused Field Notes project → New Session. Start is disabled; initial focus remains outside the dialog.

The shared trap now picks only visible, enabled candidates, falling back to another dialog control. Permanent regressions in `scripts/ui-sweep.mjs:485` and `:1138` assert initial focus, Tab/Shift+Tab containment, and Escape restoration in both themes. Typecheck and `git diff --check` pass. Before evidence: `before/dialog-before.json`, `before/dark-resolver-confirm-keyboard.png`, `before/light-resolver-confirm-keyboard.png`, and paused-session screenshots.

Green verification completed against the final alpha.2 renderer at `/private/tmp/wanigan2-review/alpha2-source/out/renderer`, served through a separate demo gateway. All assertions passed: 24 surfaces, 132 input-name checks, 686 keyboard observations, zero failures/errors. Both repaired dialogs take and retain focus; Escape returns to the opener. After screenshots: `dark-resolver-confirm-keyboard.png`, `light-resolver-confirm-keyboard.png`, and `{dark,light}-paused-session.png`. Before and after screenshots were visually inspected.

## Final results otherwise

- 24 representative surfaces, including board/card drawer, Needs/reply, Settings, History, git workbench/resolver, Open Project and the new restart warning, in both themes.
- 132 rendered-input name checks passed; no unnamed input, select or textarea in these states. Counts include repeated controls across states, not 132 unique inputs.
- No document horizontal overflow at 960px; no commit-box overflow from its column; collapsed rail used at minimum width.
- 686 keyboard observations had visible focus styling. Screenshots manually inspected for board, drawer, workbench, resolver, Settings, History, dialogs and restart warning.
- Open Project trapped keyboard focus and restored it on Escape in both themes.
- No browser console errors or renderer crashes.
- Initial Needs Reply return-focus flag was a test timing issue: the product uses requestAnimationFrame. The final audit waited for that frame; return focus passed in both themes without an app change.

This adds coverage at the exact minimum width and both themes. It is not a complete screen-reader or WCAG conformance audit. The root full UI sweep/crawl remains the broader behavior gate.
