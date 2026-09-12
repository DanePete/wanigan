# bits.tsx — 1 findings

## src/renderer/src/components/bits.tsx:439 — [low] aria-reference  (PLAUSIBLE, sustained 2/3)

**Claim.** A collapsed Explainer points aria-controls at an element id that is in no document, which is the exact dangling-reference shape this repository writes its other disclosures to avoid; both target views hit it in their default state.

**Evidence.**

```
src/renderer/src/components/bits.tsx:436-440 — the `if (hidden)` branch returns only `<p className="explainer-reopen"><button type="button" className="explainer-toggle" onClick={() => set(false)} aria-expanded={false} aria-controls={`explainer-${id}`}>Show: {title}</button></p>`; the element carrying `id={`explainer-${id}`}` exists only in the two non-hidden branches (447, 455). The repository's stated rule for this case is in src/renderer/src/styles/composer.css:75-78 — "The list stays in the DOM whether or not it has options, so the composer's aria-controls always resolves" — and Learning.tsx:546-551 records the same fix for the tab panel: "the id existed only for the selected tab and every other button in the tablist pointed at an id that was in no document."
```

**Failure.** Settings.tsx:788 `<Explainer id="settings-how" title="Saving your changes" defaultHidden>` and Learning.tsx:759, 783, 880, 1534, 2078, 2107 all pass `defaultHidden`, so on a fresh profile (no stored explainer pref) every one of them renders the collapsed branch. A screen-reader user meets `<button aria-expanded="false" aria-controls="explainer-settings-how">Show: Saving your changes</button>` while nothing in the document has that id; JAWS's "move to controlled element" finds nothing, and the expanded/collapsed pair is reported against a reference that never resolves.

**Fix.** Either drop `aria-controls` from the collapsed branch (aria-expanded alone is valid when the content is not in the DOM), or keep the container mounted with `hidden` and a `[hidden]{display:none}` rule, matching the `.composer-menu` pattern.

**Dissent (the verifier who refuted).** The finding's facts check out but its failure does not, and the repo's own documented rule distinguishes this case from the two it fixed.

Facts confirmed: bits.tsx:435-441 returns only the reopen `<p>` when hidden, and `id={`explainer-${id}`}` appears only at bits.tsx:445 and 453; Settings.tsx:788 and seven Learning.tsx sites pass `defaultHidden`, and `useState<boolean>(defaultHidden === true)` (bits.tsx:403) means the collapsed branch is the fresh-profile render.

Why it is not a defect:

1. The repo's stated rule is narrower than the finding quotes it. Both cited precedents are cases where aria-controls was the ONLY carrier of the relationship. Composer.tsx:466-473 says so in its own comment: "aria-expanded is not supported on textbox — a reader may ignore an unsupported attribute... The two a textbox does support carry the whole message: aria-controls names the list that just opened". Learning.tsx:548-554 is a tablist, where tab→panel has no alternative attribute. The Explainer's reopen button is an ordinary named button carrying `aria-expanded={false}` (bits.tsx:439), which is the complete and correct state signal; no shipping screen reader announces an aria-controls target, so nothing is announced wrongly, nothing renders wrongly, no crash. Note also that the repo does use the conditional form elsewhere (Composer.tsx:535 `aria-controls={stashOpen ? 'composer-stash-list' : undefined}`, SpaceNavigation.tsx:19) — so at most this is a consistency nit of the kind the brief excludes, not a failure.

2. The asserted failure is the correct outcome, not a wrong one. "Move to controlled element" finding nothing while the controlled content does not exist is what should happen; the moment the user activates the button, `set(false)` renders bits.tsx:445 or 453 carrying exactly that id, so the reference resolves in the only state where it is meaningful. A collapsed disclosure that does not render its content is the recognized exception for aria-controls (an unresolved ARIA IDREF is ignored by user agents rather than erroring), and the repo ships no axe/a11y linter that would even flag it — there is no `axe-core` in node_modules or scripts/, no aria-controls rule in scripts/check-renderer-style.cjs (its only aria logic is the accessible-name scan at lines 242-263, 526).

3. What is pinned about this component is the state machine, not the markup: smoke3.ts:7767-7772 pins `decided`/`defaultHidden` behaviour ("an explainer keeps following defaultHidden until a stored choice or a click decides it"), and smoke3.ts:7736-7757 pins the `defaultHidden` call sites. Nothing pins the reopen button's attributes either way, so there is no assertion to break.

Caveat that keeps this at medium rather than high: the behaviour is not documented as a deliberate choice in the comment above bits.tsx:439 (the jsdoc there covers `compact` and `defaultHidden` only), so I cannot show intent by citation. I am refuting on the failure, not on intent: no wrong render, no wrong announcement, no crash, no money — and the one precedent the finding leans on is a case where the attribute was load-bearing and here it is not.

---
