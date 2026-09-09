# Wanigan design language: critique and recommendation

Date of research: 2026-09-07. Read-only audit of `the Wanigan repository`
at commit 591d758. Every code citation below is a file and line read in this pass;
every external claim carries its source and the date the source was read or
published. `verified` means the claim was read on the vendor's own site, docs or
repository; second-hand summaries are marked as such and not relied on for a rule.

Blocked or degraded sources: `devin.ai` returned HTTP 429 (docs.devin.ai was read
instead and says nothing about visual design); `developer.apple.com/design/...`
HTML pages returned only a title, so the HIG was read through its JSON data
endpoints (`developer.apple.com/tutorials/data/design/human-interface-guidelines/*.json`),
which are the same content the page renders. Vercel's `geist/text` page lists the
style names but not the numeric values, so no Geist numbers are claimed. Raycast
publishes no design-system document; its extension UI guidelines were read
instead. Arc's own page says it now "receives Chromium updates only", so Arc is
treated as a historical reference, not a current one.

---

## 1. What Wanigan is today, read from the tokens

### 1.1 Type

`index.css:88-99`:

```
--font-stencil: 'DIN Condensed', 'Avenir Next Condensed', 'Arial Narrow', ui-sans-serif, sans-serif;
--mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace;
--t-tiny: 10px; --t-micro: 11px; --t-small: 12px; --t-body: 13.5px;
--t-lead: 15px; --t-title: 20px; --t-display: 28px;
```

Body is `ui-sans-serif, -apple-system, 'SF Pro Text', system-ui` at 13.5px
(`index.css:245-252`). Headings are declared once, `h1..h6 { font-weight: 650 }`
with h1 28 / h2 20 / h3 15 / h4 13.5 (`index.css:269-273`). There are three
label styles: `.label` (12px/500 dim), `.label-stencil` (DIN Condensed 12px/700,
`.13em` tracking, uppercase) and `.sub` (11px/600, `.06em`, uppercase)
(`index.css:324-336`).

Observed facts:

- Seven named sizes, and `--t-tiny` is referenced by zero rules (grep across
  `src/renderer/src`), so the working scale is six.
- Font weights in use across the sheets (grep `font-weight`): 400 (4), 500 (15),
  550 (1), 600 (62), 650 (29), 700 (28), 750 (5), 800 (4). Eight weights where a
  system that reads as calm needs three.
- Eighteen distinct `letter-spacing` values between `-.035em` and `.13em`
  (`index.css` plus `styles/*.css`).
- Ten distinct `line-height` literals in `styles/*.css` (1, 1.2, 1.25, 1.35, 1.4,
  1.45, 1.48, 1.5, 1.55, 1.6).
- 187 literal `font-size: Npx` declarations remain in `styles/*.css`; the gate's
  `FONT_PX_BASELINE` (`scripts/check-renderer-style.cjs:95-113`) records them as
  debt: timeline 25, settings 27, evals/skills 19, insights 17, and so on.
- Fifteen sites set `font-size: 10px` and two set `9px` (`insights.css:147`,
  `session-learning.css:39`) — below the palette's own stated floor
  (`index.css:91-92`: "10px metadata is the contrast floor this palette
  refuses") and below the HIG's macOS minimum of 10pt.
- Mono is used correctly for code, paths and pids (`index.css:922-925`,
  `.code-file`, `.viz-table td.n`) but also for right-aligned numbers in the
  timeline tool table (`timeline.css:26-31`), where `font-variant-numeric:
  tabular-nums` in the sans face would do the job without a face change.
- The condensed "stencil" face appears in three CSS rules and five TSX sites:
  the brand lockup (`index.css:443-446`), `.label-stencil` eyebrows
  (`bits.tsx:255`) and the ATTENTION lead word. `index.css:315-323` records that
  it once spread to 235 sites and was pulled back to two roles. That pull-back
  is the right call and should be kept.

### 1.2 Colour

`index.css:69-176` (dark) and `178-240` (light). The surface ramp is six
neutrals — `--bg`, `--bg-soft`, `--bg-raised`, `--bg-sunk`, `--bg-selected`,
`--bg-chrome` — plus two lines (`--line`, `--line-soft`) and three text tones
(`--text`, `--text-dim`, `--text-faint`). The neutrals are warm (dark bg
`#14100d`, light bg `#f7f3ec`), which is a deliberate and good choice: Radix's
own advice is to pick the gray "saturated with the hue closest to your accent
hue", and Sand is the gray it pairs with orange. `--bg-raised` is referenced by
three rules and `--r-lg` by one, so the ramp is effectively five surfaces.

The accent is coral (`#fa7650` dark, `#ae401e` light). `--plate-red` is the
same value as `--accent` in both palettes (`index.css:82,85` and `191,194`), so
the "plate" pair is one hue plus `--plate-blue`, a second brand hue used for a
2px off-register shadow under the selected nav row and tab (`index.css:509-512`,
`754-757`) and as a radial wash behind Learning (`learning.css:3-5`).

Where the accent is painted (grep across `index.css` + `styles/*.css`):
`var(--accent)` appears in 125 declarations — 80 as `color:`, 28 as a border,
8 as a fill — and `--accent-soft` in 49. It is simultaneously:

1. the primary action fill (`.btn-primary`, `index.css:294`; `.nav-new-session`,
   `index.css:521`);
2. the focus ring for every control (`index.css:1014-1018`; `.field:focus`,
   `index.css:313`);
3. the link colour (`.link`, `index.css:759`; `.crumb:hover`, `913`);
4. the selection edge for the current nav row and tab (`--plate-red`,
   `index.css:507,753`), the current session row (`index.css:780-783`), a
   pressed stat tile (`ui.css` `.stat-tile[aria-pressed]`) and the current
   code file (`index.css:907`);
5. the unread count badge (`.nav-badge`, `index.css:616-622`);
6. the "in progress"/"submitting" status tone (`bits.tsx:15-16`, `.pill.tone-accent`,
   `index.css:350`);
7. the progress bar fill (`index.css:1029`);
8. the terminal cursor (`index.css:166`);
9. a hover border on the usage status pill (`index.css:545`);
10. the "Teach Wanigan" primary button on Learning, "Change model & effort..."
    on Sessions, "Build your first batch" and "New run" on Batches, "Type /init
    into a session" on Context (screenshots `dark-learning.png`,
    `dark-sessions.png`, `dark-batches.png`, `dark-context.png`).

Seventy-four `btn-primary` sites exist across views and components. The
screenshot of Sessions (`dark-sessions.png`) shows two accent-filled buttons in
one viewport ("New session" and "Change model & effort...") plus the accent
cursor block, the selected-row edge, the Batches nav underline and the
"Asking" red mark: five coral events competing before the operator has read
anything.

Status has two families that resolve to the same values: `--ok/--warn/--bad`
and `--good/--warning/--serious/--critical` (`index.css:130-149`). The comment
says both exist because "bits.tsx and the older sheets read" the short names.
The four-level serious/critical split is honest for an attention queue; the
duplication is not.

Contrast is contracted in a comment (`index.css:50-56`: text, dim, faint,
accent, good, warning, serious, critical "all clear 4.5:1 in both palettes").
That is a stronger promise than most of the references make (Radix guarantees
APCA Lc 60 for step 11 and Lc 90 for step 12 against step 2) and it should be
kept.

### 1.3 Space, radius, elevation

`index.css:101-103`: `--s-1..6` = 4, 8, 12, 16, 24, 32. Radii 2, 5, 9, 12, pill.
Control heights 32 and 26 (`index.css:117-118`); card paddings `14px 16px` and
`10px 13px` (`115-116`). The ladder is a clean 4/8 rhythm; the card paddings
are not on it, and the sheets do not use the ladder: 200 literal `padding:`
values, 263 literal `gap:` values and 85 literal `border-radius:` values remain
in `styles/*.css`. The gate ratchets font sizes and durations
(`check-renderer-style.cjs:7-13`) but has no baseline for padding, gap or
radius, so CLAUDE.md's rule ("spells no font size, padding or duration as a
literal") is only two-thirds enforced.

Elevation is by fill plus a soft line: `.card` on `--bg-soft` with `--line-soft`,
`.sunk` on `--bg-sunk`, nested boxes lose their border (`index.css:713-720`).
This is the right model (Linear 2026: "structure should be felt not seen";
HIG: reduce toolbar backgrounds). Popovers and modals use shadow tokens
(`--shadow-popover`, `--shadow-modal`). Chrome sits one step darker than the
page (`--bg-chrome`, `index.css:66-67`, `429`, `466`) — again the Linear 2026
move ("sidebar reduced in brightness to allow main content to take
precedence").

### 1.4 Motion

`motion.css:1-26` states the one rule — "every animation is driven by a
measurement" — with two durations (`--mo-state` 180ms, `--mo-view` 240ms), one
easing, and a `data-motion` root switch that also honours
`prefers-reduced-motion` (`motion.css:28-40`). Nothing animates inside
`.terminal-host` (`motion.css:98-105`). The literal-duration baseline is empty
(`check-renderer-style.cjs:121`). This is better than any reference's stated
policy; the HIG's "Don't add motion for the sake of adding motion" is a
weaker form of the same rule.

### 1.5 Copy

Every view opens with a sentence under the title (`PageHead lead`,
`bits.tsx:257`), and eleven of fifteen views carry an `Explainer` — a remembered
teaching block (`bits.tsx:383-461`). Sessions keeps a three-line explainer in
permanent chrome under the terminal (`Sessions.tsx:2080-2084`; the comment at
2078 admits "Three lines of teaching, permanently"). The Learning empty state
runs to roughly 120 words with three bold-led bullets (`dark-learning.png`);
Schedules' "Run in every registered repository" note is a four-line paragraph
beside a checkbox (`state-1100.png`); Settings shows three stacked prose blocks
before the first field (`light-settings.png`). Tooltips are the native `title`
attribute — 264 in views and 82 in components — and there is no tooltip or
popover primitive in `bits.tsx`; `App.tsx` is the only file mentioning a
popover (the "need you" list, `shell.css:38-52`).

Label case is mixed: `.tabs button` forces `text-transform: capitalize`
(`index.css:747`); the eyebrow and group labels are uppercase; buttons are
sentence case ("New session", "Run anything due now"); marks are lowercase
words ("executing", "review", `bits.tsx:61-96`); Fleet's attention words are
capitalised ("Asking", "Failed", "Done", `bits.tsx:92-95`).

### 1.6 Empty, loading, icons

`EmptyState` has three postures with a glyph, a title and a cue
(`bits.tsx:325-351`); `Reading` renders the final frame plus one sentence and no
spinner (`bits.tsx:353-366`). Both are right. Icons are inline Lucide paths at
16px, 1.75 stroke (`bits.tsx:468-526`), always beside a word; status glyphs are
text characters (`○ ▸ ✓ ✕ ■ ⊘ ?`) in a 1em box (`index.css:353-358`). The
sidebar row is icon + word + chord (`index.css:481-495`).

### 1.7 Density

There is no density mode. `compact.css` is a breakpoint ladder (980/720/460)
plus a coarse-pointer block that raises hit targets to 44px. The terminal gets
12.5px on desktop and 15.5px on touch (`TerminalPane.tsx:38-41`). Settings has
a theme control but no density control (`Settings.tsx:4518`).

---

## 2. Sources, dated

| # | Claim | Source | Date | Verified |
|---|-------|--------|------|----------|
| 1 | Linear 2024 redesign goals: "reduce visual noise, maintain visual alignment, and increase the hierarchy"; Inter for body, Inter Display for headings; themes generated in LCH from three variables — base colour, accent colour, contrast — replacing 98 per-theme variables; "limiting how much chrome (blue in our case) was used". | linear.app/now/how-we-redesigned-the-linear-ui (Part II) | published 2024-03-28, read 2026-09-07 | yes |
| 2 | Linear 2026 refresh: "Don't compete for attention you haven't earned"; "Structure should be felt not seen"; sidebar dimmer, smaller icons, muted inactive text, more vertical padding; tabs more compact; borders softened, separators trimmed; palette moved from cool blue-ish to warmer gray; "If most people don't immediately notice what changed, that's probably a good sign." | linear.app/now/behind-the-latest-design-refresh (Aufmann, Heckel) | published 2026-03-12, read 2026-09-07 | yes |
| 3 | Radix Colors 12-step scale: 1 app bg, 2 subtle bg, 3 element bg, 4 hovered, 5 active/selected, 6 subtle border, 7 element border, 8 hover border/focus ring, 9 solid, 10 hovered solid, 11 low-contrast text, 12 high-contrast text; step 11 guarantees Lc 60 and step 12 Lc 90 (APCA) on a step-2 background. | radix-ui.com/colors/docs/palette-composition/understanding-the-scale | read 2026-09-07 | yes |
| 4 | Radix: "choose the gray scale which is saturated with the hue closest to your accent hue"; Sand pairs with yellow, amber, orange, brown; Mauve with tomato, red, ruby, crimson, pink, plum, purple, violet; semantic: error red/ruby/tomato/crimson, success green/teal/jade/grass/mint, warning yellow/amber/orange, info blue/indigo/sky/cyan. | radix-ui.com/colors/docs/palette-composition/composing-a-palette | read 2026-09-07 | yes |
| 5 | Geist colours: non-background scales have 10 steps 100-1000; 100-300 component backgrounds (default/hover/active), 400-600 borders, 700-800 high-contrast backgrounds, 900-1000 text and icons; "use Background 1 ... especially when color is being placed on top of the background", Background 2 "sparingly". Scales: gray, gray-alpha, blue, red, amber, green, teal, purple, pink. | vercel.com/geist/colors | read 2026-09-07 | yes |
| 6 | Geist type styles are named by role and size: heading-72..14, button-16/14/12, label-20..12 with -mono variants at 14/13/12, copy-24..13 with copy-13-mono; each class "pre-set[s] a combination of font-size, line-height, letter-spacing, and font-weight". Numeric values are not on the page. | vercel.com/geist/text | read 2026-09-07 | yes (names only) |
| 7 | Geist Sans/Mono: "began by creating a monospace version that prioritized readability and seamlessly integrated into coding environments"; principles "simplicity, minimalism, and speed, drawing inspiration from the renowned Swiss design movement"; nine weights Thin to Ultra Black. | vercel.com/font | read 2026-09-07 | yes |
| 8 | shadcn/ui theming: "semantic background and foreground pairs. The base token controls the surface color and the -foreground token controls the text and icon color that sits on that surface"; tokens background, foreground, card, popover, primary, secondary, muted, accent, destructive, border, input, ring, chart-1..5, sidebar, sidebar-primary, sidebar-accent, sidebar-border, sidebar-ring; one `--radius` derives sm..4xl; colours in OKLCH. | ui.shadcn.com/docs/theming | read 2026-09-07 | yes |
| 9 | HIG macOS text styles: Large Title 26/32, Title 1 22/26, Title 2 17/22, Title 3 15/20, Headline 13 bold/16, Body 13/16, Callout 12/15, Subheadline 11/14, Footnote 10/13, Caption 1 10/13, Caption 2 10 medium/13; "Default size: 13 pt", "Minimum size: 10 pt"; "avoid Ultralight, Thin, and Light font weights". | developer.apple.com HIG Typography (JSON data endpoint) | read 2026-09-07 | yes |
| 10 | HIG Sidebars: "show no more than two levels of hierarchy"; "use succinct, descriptive labels to title each group ... omit unnecessary words"; "Consider letting people hide the sidebar"; "Avoid hiding the sidebar by default"; "By default, sidebar icons use your app's accent color" and people expect the system accent to apply; fixed colours only "sparingly" to "clarify the meaning of an icon"; sidebars "can float above content in the Liquid Glass layer". | HIG Sidebars (JSON) | read 2026-09-07 | yes |
| 11 | HIG Toolbars: "Reduce the use of toolbar backgrounds and tinted controls"; "Prefer system-provided symbols without borders"; "Group toolbar items logically by function and frequency of use"; "Make every toolbar item available as a command in the menu bar"; "toolbar items don't include a bezel". | HIG Toolbars (JSON) | read 2026-09-07 | yes |
| 12 | HIG Color: "reserve [color] for elements that truly benefit from emphasis, such as status indicators or primary actions"; "To emphasize primary actions, apply color to the background rather than to symbols or text"; "Refrain from adding color to the background of multiple controls"; "Avoid relying solely on color"; "Avoid using the same color to mean different things". | HIG Color (JSON) | read 2026-09-07 | yes |
| 13 | HIG Materials: Liquid Glass "forms a distinct functional layer for controls and navigation elements — like tab bars and sidebars — that floats above the content layer"; "Don't use Liquid Glass in the content layer"; "Use Liquid Glass effects sparingly". | HIG Materials (JSON) | read 2026-09-07 | yes |
| 14 | HIG Motion: "Add motion purposefully"; "Don't add motion for the sake of adding motion"; "Make motion optional"; "Aim for brevity and precision in feedback animations"; "generally avoid adding motion to UI interactions that occur frequently"; "Let people cancel motion". | HIG Motion (JSON) | read 2026-09-07 | yes |
| 15 | HIG Writing: "When labeling buttons and links, it's almost always best to use a verb"; "Check each word to be sure it needs to be there"; "Choose a style for each UI element type and use it consistently"; "Avoid using we altogether"; "If the setting label isn't enough, add an explanation. Describe what it does when turned on". | HIG Writing (JSON) | read 2026-09-07 | yes |
| 16 | Apple: Liquid Glass ships in macOS Tahoe 26; controls "act as a distinct functional layer that sits above apps"; sidebars are "subtly tinted based on what's under them". | apple.com/newsroom 2025-06 "Apple introduces a delightful and elegant new software design" | published 2025-06-09, read 2026-09-07 via search summary | yes for the newsroom quote; the sidebar-tint sentence came through a search summary (second-hand) |
| 17 | Raycast extension guidelines: action titles in Title Case ("Open in Browser"); "Don't use subtitles as descriptions"; "Avoid having a list of actions where some have icons and some don't"; "Add ellipses … for actions that will have a submenu"; "Don't leave the search bar without a placeholder"; avoid a "flickering empty state view" by showing a loading indicator; four UI containers List, Grid, Detail, Form plus ActionPanel. | developers.raycast.com/basics/prepare-an-extension-for-store and /api-reference/user-interface | read 2026-09-07 | yes |
| 18 | Raycast has no public design-system document; descriptions of its palette (near-black canvas, one coral accent, Inter with ss03, hairline borders) come from third-party "DESIGN.md" write-ups. | search results (VoltAgent awesome-design-md, open-design.ai, refero) | read 2026-09-07 | no (second-hand) |
| 19 | Conductor: "Run parallel coding agents on your Mac"; "Create parallel Claude Code, Codex, and Cursor agents in isolated workspaces"; "See at a glance what they're working on, then review and merge their changes". No typography or colour is stated. | conductor.build | read 2026-09-07 | yes (product claims only) |
| 20 | Cursor's site describes agent task lists ("In Progress", "Ready for Review"), an agent summary line ("Explored 12 files, 4 searches", "Worked for 14m 22s") and a CLI prompt legend ("/ for commands · @ for files · ! shell"); no design-language statement. | cursor.com | read 2026-09-07 | yes (product claims only) |
| 21 | Devin: "conversational user interface" with Shell, IDE and Browser panes; "You can find Devin's tools in the sidebar or by clicking any progress steps in the session". devin.ai returned HTTP 429. | docs.devin.ai | read 2026-09-07 | yes (product claims only) |
| 22 | Arc: "Clean and calm, Arc shapes itself to how you use the internet"; "Arc receives Chromium updates only ... download Dia instead". | arc.net | read 2026-09-07 | yes |

Not claimed anywhere in this document: any numeric value for Geist, Linear or
Raycast type sizes, spacing or colours — none was read on a primary source.

---

## 3. Rules that transfer, and what Wanigan should change

Each rule states the reference, what Wanigan does today (token or sheet), and the
change, inside CLAUDE.md's constraints (surface sheets declare no colour and
spell no size/padding/duration literal; tokens live in `index.css` and
`motion.css`; views compose `bits.tsx`; Learning shows no composite score).

### R1. Six sizes, three weights, one tracking per size

Reference: HIG macOS uses eleven named styles but only five distinct sizes
below Title 1 (15, 13, 12, 11, 10) and its default is 13pt; Linear reserves a
second face (Inter Display) for headings only; Geist names styles by role
(heading/label/copy/button) and bakes size+leading+tracking+weight into each.

Today: seven tokens with one unused (`--t-tiny`); eight weights; eighteen
trackings; ten leadings; 187 literal px sizes in sheets; 9px text in two sheets.

Change:
- Keep six sizes and rename by role so a sheet cannot pick a size without
  picking its leading: `--t-display` 28, `--t-title` 20, `--t-lead` 15,
  `--t-body` 13.5, `--t-small` 12, `--t-micro` 11. Delete `--t-tiny`. Add
  `--lh-display: 1.15; --lh-title: 1.25; --lh-body: 1.45; --lh-prose: 1.55;
  --lh-tight: 1` and `--track-title: -.015em; --track-display: -.02em;
  --track-caps: .06em`. Replace the eighteen trackings with those three plus 0.
- Three weights: `--w-regular: 400; --w-medium: 500; --w-strong: 600`. `650`,
  `700`, `750`, `800` collapse to 600 except the brand lockup, which may keep
  700 because DIN Condensed has no 600. The nav row's `550` (`index.css:484`)
  becomes 500.
- Add a ratchet for `letter-spacing`, `line-height` and `font-weight` literals
  in `styles/*.css`, seeded at today's counts, mirroring `FONT_PX_BASELINE`.
- Raise the two 9px sites (`insights.css:147`, `session-learning.css:39`) and
  the fifteen 10px sites to `--t-micro`; 10px stays only for a glyph beside a
  number, which is what the token comment already says.
- Mono is for code, paths, pids, cron and diff. Numbers in a sans table use
  `font-variant-numeric: tabular-nums` in the sans face (`timeline.css:26-31`
  changes face; it should not).

Size: medium (tokens are a 20-line edit; the sheet sweep is ~190 replacements
across 16 sheets, mechanical).

### R2. A neutral ramp with named steps, one accent with one job

Reference: Radix's 12 steps give each surface, border and text tone a fixed
role (bg 1-2, element 3-5, border 6-8, solid 9-10, text 11-12); Geist does the
same in 10 (100-300 bg, 400-600 border, 700-800 solid, 900-1000 text); Linear
generates the whole theme from base + accent + contrast; the HIG says apply
colour "to the background rather than to symbols or text" for the primary
action and "Refrain from adding color to the background of multiple controls";
"Avoid using the same color to mean different things".

Today: the ramp exists but its steps are not named by role (`--bg-raised` is
nearly unused, `--bg-selected` is a hue step in light); the accent has ten jobs
(section 1.2), and `--plate-red` duplicates it.

Change:
- Name the neutral ramp by Radix step so a sheet author picks by role:
  `--n-1` app bg, `--n-2` card, `--n-3` element, `--n-4` hover, `--n-5`
  selected, `--n-6` soft line, `--n-7` line, `--n-8` strong line/focus,
  `--n-11` dim text, `--n-12` text. Keep the existing semantic names as
  aliases that point at the steps (`--bg: var(--n-1)` etc.) so no sheet
  changes on day one.
- Give the accent one job: **the one primary action per surface, and the focus
  ring**. Everything else moves:
  - Selection (nav row, tab, session row, code file, pressed tile) uses
    `--n-5` fill plus a 2px `--text` edge — the "plate" idiom keeps its shape
    and loses the hue. `--plate-red` and `--plate-blue` are retired;
    `learning.css:3-5`'s radial wash goes with them.
  - Links use `--text` underlined (`index.css:759`); accent on links makes
    every citation compete with the primary button.
  - "In progress" status (`bits.tsx:15-16`) is `quiet`, which is what the
    MARKS table already says at `bits.tsx:55-57` ("a running agent asks
    nothing and stays quiet").
  - The unread badge (`index.css:616-622`) uses `--n-5`/`--text` unless the
    count is an attention count, in which case it is already `--critical`.
  - The progress bar (`index.css:1029`) uses `--text-dim`.
  - The terminal cursor keeps the accent: it is the one place the operator's
    hand is.
- One primary button per viewport. The header's "New session" is the global
  primary; a view that also needs a primary (Batches "New run", Learning
  "Teach Wanigan") should demote the header button to secondary while that
  view is mounted, or demote its own. The screenshots show two to three accent
  fills per viewport today.
- Collapse the status double-naming: `--ok/--warn/--bad` become aliases of
  `--good/--warning/--critical` in `index.css:133-135` today; make the four
  canonical names the only ones read by `bits.tsx` and delete the aliases once
  the sheets are swept (grep shows `.bar-ok`, `.note.tone-*` still read the
  short names in `ui.css`).

Size: small for the tokens and `bits.tsx`; medium for the selection and link
sweep (about 40 declarations across `index.css`, `ui.css`, `learning.css`,
`sessions.css`).

### R3. Semantic status colour is words first, hue second, and never a score

Reference: HIG "Avoid relying solely on color"; Radix maps error/success/
warning/info to hue families; the learning UX doctrine in this repo bans
composite scores.

Today: Wanigan already does this well — every mark is glyph + word
(`bits.tsx:103-110`), the bar hatches failures (`ui.css .bar-bad`), and
`learning.css:267` labels its section "observed facts, never a score". The
Fleet cards paint spend "~$5.76 est." in body colour and "Not reported" in the
same weight as a number (`dark-fleet.png`), which is honest.

Change: none to the policy. Two consistency fixes: `Stat`'s `tone` prop takes a
raw colour string and applies it inline (`bits.tsx:144`: `style={tone ? {
color: tone } : undefined}`), and callers pass `'var(--ok)'`, `'var(--bad)'`,
`'var(--critical)'`, `'var(--accent)'` (grep). That is colour entering the
primitive as data, which `bits.tsx:6-7` says never happens. Make `tone` the
`Tone` union and resolve it to `.tone-*` classes like `Mark`. Second, the
attention words in MARKS are capitalised ("Asking", "Done") while every other
mark is lowercase (`bits.tsx:92-95`); pick one.

Size: small.

### R4. Space on the 4/8 ladder, everywhere, and enforce it

Reference: every reference system publishes a single spacing scale; Linear's
2026 refresh increased sidebar vertical padding and made tabs more compact —
both are moves on a ladder, not new literals.

Today: the ladder exists (`index.css:101-102`) but the sheets carry 200 literal
paddings, 263 literal gaps and 85 literal radii; `--card-pad` is `14px 16px`
and `--card-pad-tight` `10px 13px` (off-ladder); `.note` is `7px 11px`
(`ui.css`); `.chip` is `0 10px`; `.section-n` is 19px; `.need-popover` is 8px
(`shell.css:41`).

Change:
- Add half-steps the sheets actually need: `--s-0: 2px` and `--s-1h: 6px`, and
  move `--card-pad` to `var(--s-3) var(--s-4)` (12/16) and `--card-pad-tight`
  to `var(--s-2) var(--s-3)` (8/12). Nothing visible moves more than 2px.
- Add `PAD_PX_BASELINE`, `GAP_PX_BASELINE` and `RADIUS_PX_BASELINE` to
  `check-renderer-style.cjs`, seeded at today's counts, so CLAUDE.md's stated
  rule is enforced for padding as it is for font size.
- Radii: four is right (2/5/9/12/pill). Derive them from one base the way
  shadcn does (`--r-md: 8px; --r-sm: calc(var(--r-md) - 3px); --r-lg:
  calc(var(--r-md) + 4px)`), and move `--r-md` from 9 to 8 so controls and
  cards land on the grid.

Size: small for tokens and the gate; large-but-mechanical for the sweep (~550
literals). Do the sweep per sheet as each sheet is next touched; the ratchet
prevents growth meanwhile.

### R5. Structure by fill, not by line; chrome recedes

Reference: Linear 2026 ("Structure should be felt not seen"; sidebar dimmer,
fewer separators); HIG toolbars ("Reduce the use of toolbar backgrounds and
tinted controls"; items "don't include a bezel"); Liquid Glass puts chrome on
its own layer and keeps content flat.

Today: already mostly right — `.card` is soft-lined, nested boxes drop their
border (`index.css:713-720`), chrome is one step darker (`--bg-chrome`). Two
exceptions: the header still puts a 1px `--line` under itself and the sidebar a
1px `--line` beside itself (`index.css:429`, `466`), and every header control
wears a bezel (`.nav-usage-status`, `.nav-views-button`, `index.css:514-519`,
`540-544`), so the top strip reads as four outlined boxes (`shell.png`).

Change: header and sidebar edges use `--line-soft`; header controls other than
the primary lose their border and take `--n-3` fill on hover only; the usage
pill keeps a border only in its `.low` state, where the border is the warning.
The sidebar's group labels are already three short uppercase words (WORK,
EXPLORE, MANAGE) — keep them; the HIG asks for exactly that.

Size: small.

### R6. Density is a setting, not a breakpoint

Reference: Linear ships density in its 2026 refresh (compact tabs) and its
sidebar; the HIG raises targets to 44pt on touch; Wanigan's `compact.css:56-79`
already does the touch half.

Today: no density switch. Row height 32 for nav rows, 26 for chips, 38 for the
tab bar (`index.css:483`, `788`), and the terminal font is fixed per pointer
type (`TerminalPane.tsx:38-41`).

Change: add `--density` as a root attribute `data-density="comfortable |
compact"` set from Settings beside the theme control (`Settings.tsx:4518`),
and derive `--control-h`, `--control-h-sm`, `--row-h` and `--card-pad` from it
in `index.css` (compact: 28/22/28, `--s-2 --s-3`). Sheets keep reading the
tokens and need no change. This is a token-only feature and it is the one
"knob" an operator who lives in Fleet all day asks for.

Size: small-medium (tokens + one Settings row + a pref key in main).

### R7. Labels, not paragraphs; explanation behind a control

Reference: HIG writing ("Check each word to be sure it needs to be there";
"If the setting label isn't enough, add an explanation. Describe what it does
when turned on"; verbs on buttons); Raycast ("Don't use subtitles as
descriptions"; "If your subtitle is almost a duplication of your command title,
you probably don't need it"); Linear ("Don't compete for attention you haven't
earned").

Today: `Explainer` is the right primitive and its "remembered, never
self-collapsing" rule (`bits.tsx:368-379`) is well reasoned, but the default is
open and eleven views mount one. The `PageHead lead` is a sentence on every
view; four of them are 15-30 words (`Control.tsx:433`, `Git.tsx:450`,
`Settings.tsx:709`). The Sessions attachment strip is three lines of prose in
permanent chrome under the terminal (`Sessions.tsx:2080-2084`). Learning's
empty state is a ~120-word essay (`dark-learning.png`). Settings stacks three
prose blocks above the first field (`light-settings.png`; screenshot evidence
only).

Change:
- Copy budget as a lint in the style gate: `PageHead lead` at most 12 words;
  `Hint` at most one sentence (the primitive says 64ch, `bits.tsx:463`);
  `EmptyState cue` at most two sentences; `Explainer` body at most 60 words
  and `defaultHidden` unless the view is empty. Seed the baseline with today's
  offenders.
- Add one tooltip/popover primitive to `bits.tsx` (`Tip`, anchored, keyboard
  reachable, `--n-2` fill, `--shadow-popover`) and route the 346 `title=`
  attributes through it where the text is an explanation rather than a name.
  A native `title` is invisible to touch and to a screen reader that never
  hovers — `bits.tsx:42-43` already says so for `Pill` and renders the reason
  off-screen; generalise that.
- Case policy, written once in `bits.tsx`: page and section titles sentence
  case; buttons verb-first sentence case; marks lowercase words; eyebrows and
  group labels uppercase via the token, never via `text-transform:
  capitalize` (`index.css:747` goes).
- The learning surfaces already refuse composite scores; keep the estimate
  grammar ("~$5.76 est.") and never let a `Tip` restate a number as a score.

Size: medium (a lint, one primitive, then per-view copy edits that can land
one view at a time).

### R8. Empty is not loading is not failed

Reference: Raycast ("Avoid ... flickering empty state view" — show loading
instead); HIG ("Show errors right next to the field").

Today: right in the primitives — `EmptyState` has three postures and `Reading`
keeps the frame (`bits.tsx:325-366`). Batches still renders a bare
"No runs yet." line with an accent button inside a table body
(`dark-batches.png`), not the primitive; the `.chart-empty` rule (`index.css:876`)
and `table.grid .center` (`739`) are two more private empty shapes.

Change: route those three through `EmptyState nothing-yet`; the accent button
in an empty state is the one primary of that view, so the header's "New
session" should be secondary there.

Size: small.

### R9. Icons beside words; status as text glyphs

Reference: HIG sidebars ("Consider using familiar symbols"; sidebar icons take
the accent by default and people expect the system accent); Linear 2026 reduced
icon usage and sizes.

Today: right. Lucide outline at 16/1.75 beside every word (`bits.tsx:468-484`),
status as text characters (`index.css:353-358`), no icon-only control in the
sidebar. Sidebar icons are `--text-faint` at rest and `--text` when selected
(`index.css:487`, `504`) rather than accent — the HIG default would tint them,
but Wanigan's accent is not the system accent and a tinted column of fifteen
icons is fifteen more coral events. Keep them neutral.

Change: none, except that the sidebar icon should follow the row's hover
colour transition token (it does, `motion.css:150-152`).

### R10. Motion is a measurement

Reference: HIG motion ("Don't add motion for the sake of adding motion";
"Let people cancel motion"; avoid motion on frequent interactions).

Today: `motion.css` is stricter than the HIG and the duration baseline is
empty. The nav underline slides from measured geometry (`motion.css:107-125`);
the view transition skips when a terminal is on either side.

Change: none to policy. One naming nit: `--mo-period` is "overwritten per
element from measured rate" (`motion.css:25`) but has a 2400ms default that
implies a breath even before a measurement lands; set the default to `0ms`
and let `[data-flow='live']` supply it, which is what the rule at
`motion.css:47-49` promises ("Neither has a default that implies activity").

Size: trivial.

---

## 4. Proposed token set

Names and values for both palettes. Existing names stay as aliases so no sheet
breaks; the ratchets then move sheets to the new names as they are touched.
Colours stay explicit hex (the file's own comment at `index.css:52-55` explains
why a generated/inverted palette breaks terminal ANSI and series separation),
but the light and dark values below were chosen so each step keeps the same
role in both, the Radix way. Hex values marked (=) are today's values; the
rest are new. Contrast claims below are not measured in this pass and must be
checked before landing: the existing 4.5:1 contract at `index.css:50-52` is the
bar.

### 4.1 Neutral ramp (Radix-style roles, warm Sand-like gray)

| Token | Role | Dark | Light | Today's alias |
|---|---|---|---|---|
| `--n-1` | app background | `#14100d` (=) | `#f7f3ec` (=) | `--bg` |
| `--n-2` | card / document surface | `#1b1714` (=) | `#fffdfa` (=) | `--bg-soft` |
| `--n-3` | element at rest (input, chip, sunk) | `#221c18` | `#f1ebe3` | `--bg-sunk`, `--bg-raised` (retire) |
| `--n-4` | element hover | `#2a2320` | `#ebe3d8` | (new) |
| `--n-5` | selected / pressed | `#3c332c` (=) | `#f0e2d3` (=) | `--bg-selected` |
| `--n-6` | soft line (non-interactive) | `#332b26` (=) | `#e5ddd3` (=) | `--line-soft` |
| `--n-7` | line (inputs, table rules) | `#473b33` (=) | `#d4c9bc` (=) | `--line` |
| `--n-8` | strong line / hover border | `#5c4e44` | `#bfb3a4` | (new; replaces `border-color: var(--text-faint)` on hover) |
| `--n-11` | dim text | `#c5b9a6` (=) | `#5f554b` (=) | `--text-dim` |
| `--n-12` | text | `#f6eedf` (=) | `#25201b` (=) | `--text` |
| `--chrome` | header + sidebar ground | `#100d0a` (=) | `#f4efe7` (=) | `--bg-chrome` |
| `--text-faint` | keep, but only for chords, counts and units — never a sentence | `#b4a895` (=) | `#706459` (=) | — |

`--bg-raised` (3 uses) folds into `--n-3`. `--n-4` gives hover its own step so
`:hover { background: var(--bg-sunk) }` stops colliding with "at rest" sunk
surfaces (today a hovered nav row and a sunk card are the same colour,
`index.css:496`, `719`).

### 4.2 Accent (one job: the primary action and the focus ring)

| Token | Dark | Light | Notes |
|---|---|---|---|
| `--accent` | `#fa7650` (=) | `#ae401e` (=) | primary fill, focus ring, terminal cursor |
| `--accent-hover` | `#ff8a66` | `#983717` | replaces `filter: brightness(1.1)` at `index.css:295`, `524` |
| `--accent-ink` | `#1a100c` (=) | `#fffdfa` (=) | text on the fill |
| `--accent-soft` | `#3b1c13` (=) | `#f7dcd2` (=) | only for the primary command-palette row; every other use moves to `--n-5` |
| `--ring` | `var(--accent)` | `var(--accent)` | named so a future decision to decouple the ring is one line |

Retired: `--plate-red` (alias of `--accent`), `--plate-blue` (a second brand hue
with no semantic job; its 9 uses become `--n-12` edges or go).

### 4.3 Status (four levels, one name each, `-soft` fills, `-ink` text)

| Token | Dark | Light | Meaning |
|---|---|---|---|
| `--good` / `--good-soft` | `#7be3a2` / `#123524` (=) | `#127247` / `#d8f1e0` (=) | completed, passed, accepted |
| `--warning` / `--warning-soft` | `#ffd16d` / `#382b12` (=) | `#8f5b00` / `#faebc8` (=) | waits on the operator, review, input required |
| `--serious` / `--serious-soft` | `#ffad7b` / `#432719` (=) | `#a74420` / `#f8e0d3` (=) | failed, rejected, blocked, canceled |
| `--critical` / `--critical-soft` | `#ff938c` / `#421d1d` (=) | `#ae332e` / `#f8dddb` (=) | permission asked, could-not-read, startup recovery |
| `--dead` / `--dead-soft` | `#b4a895` / `#302a25` (=) | `#706459` / `#e8e0d6` (=) | exited, expired, dismissed, demo |

`--ok`, `--warn`, `--bad` and their `-soft` become `var()` aliases in this
change and are deleted when `ui.css` and `bits.tsx` stop reading them. The
serious hue sits close to the accent in dark (`#ffad7b` vs `#fa7650`); once the
accent stops meaning "selected", that closeness stops being a problem, but it
is one more reason the accent must have one job.

### 4.4 Provider and series (unchanged)

`--claude`, `--codex`, `--glm` and `--series-1..4` keep their values; they are
data colours and already avoid the accent hue in light. Add `--deepseek` when a
DeepSeek session first needs a swatch; today `--glm` has zero uses in CSS, so
provider colour is effectively carried by TSX — check whether it is inline.

### 4.5 Type

```
--font-ui:     ui-sans-serif, -apple-system, 'SF Pro Text', system-ui, sans-serif;
--font-brand:  'DIN Condensed', 'Avenir Next Condensed', 'Arial Narrow', var(--font-ui);
--mono:        ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace;

--t-display: 28px;  --lh-display: 1.15;  --track-display: -.02em;
--t-title:   20px;  --lh-title:   1.25;  --track-title:   -.015em;
--t-lead:    15px;  --lh-title:   1.25;
--t-body:  13.5px;  --lh-body:    1.45;
--t-small:   12px;  --lh-body:    1.45;
--t-micro:   11px;  --lh-tight:   1.2;   --track-caps: .06em;   /* uppercase labels only */
--lh-prose: 1.55;   /* Explainer, Note, Hint bodies */

--w-regular: 400;  --w-medium: 500;  --w-strong: 600;
```

Both palettes share these. `--t-tiny` is deleted. The brand lockup keeps
`font-weight: 700` as the one recorded exception because the condensed face has
no 600.

### 4.6 Space, radius, geometry

```
--s-0: 2px; --s-1: 4px; --s-1h: 6px; --s-2: 8px; --s-3: 12px;
--s-4: 16px; --s-5: 24px; --s-6: 32px;

--r-md: 8px;  --r-sm: calc(var(--r-md) - 3px);  --r-xs: 2px;
--r-lg: calc(var(--r-md) + 4px);  --r-pill: 999px;

/* density-derived; data-density="compact" swaps the block */
--control-h: 32px;  --control-h-sm: 26px;  --row-h: 32px;
--card-pad: var(--s-3) var(--s-4);  --card-pad-tight: var(--s-2) var(--s-3);
:root[data-density='compact'] {
  --control-h: 28px; --control-h-sm: 22px; --row-h: 28px;
  --card-pad: var(--s-2) var(--s-3); --card-pad-tight: var(--s-1h) var(--s-2);
}
```

### 4.7 Elevation and motion (unchanged names)

`--line-soft` for structure, `--line` for inputs and table rules, `--n-8` for a
hovered interactive border; `--shadow-popover` and `--shadow-modal` only on
floating layers; no shadow on cards. `--mo-state` 180ms, `--mo-view` 240ms,
`--mo-ease` unchanged; `--mo-period` default becomes `0ms`.

---

## 5. Findings (file:line, failure, fix, size)

F1. **Accent has ten jobs.** `index.css:294` (`.btn-primary`), `313`
(`.field:focus`), `507` (`.nav-tab.on::before` via `--plate-red`), `521`
(`.nav-new-session`), `545`, `607`, `616-622` (`.nav-badge`), `759` (`.link`),
`780-783` (`.session-item.active`), `907`, `1014-1018` (focus ring), `1029`
(`.nav-progress`), `bits.tsx:15-16` (in-progress tone). Operator sees 3-5
coral events per viewport (`dark-sessions.png`) and cannot tell "chosen" from
"do this" from "link". Fix: R2. Size: medium.

F2. **`--plate-red` is `--accent` by another name.** `index.css:82,85` and
`191,194` hold identical values. The comment at `index.css:498-500` says colour
"happens twice — here, and the lamp in a mark", but the token pair makes it
happen four ways. Fix: retire both plate tokens (R2). Size: small.

F3. **Status colours are double-named.** `index.css:133-135` vs `146-149`
resolve to the same hex; `ui.css` `.bar-ok`, `.note.tone-*` read the short
names, `index.css:345-350` the long ones. Fix: alias then delete. Size: small.

F4. **`Stat` accepts a raw colour.** `bits.tsx:137-144` applies `tone` as
`style={{ color: tone }}`; callers pass `'var(--ok)'`, `'var(--critical)'`,
`'var(--accent)'` (grep, 8 sites). Contradicts `bits.tsx:6-7`. Fix: `tone:
Tone` and `.stat-value.tone-*` classes in `ui.css`. Size: small.

F5. **Eight font weights, eighteen trackings, ten leadings.** Counts from grep
across `index.css` + `styles/*.css`; `index.css:484` uses `550`. The UI reads
as several hands. Fix: R1 tokens + a ratchet. Size: medium.

F6. **187 literal font sizes and 15 at 10px / 2 at 9px in sheets.**
`check-renderer-style.cjs:95-113` baseline; `insights.css:147`,
`session-learning.css:39` (9px); `fleet.css:108,123`, `pet.css:11,41`,
`timeline.css:20-23` (10px). Below the HIG 10pt floor and the palette's own
stated floor (`index.css:91-92`). Fix: R1 sweep, `--t-micro` minimum for any
word. Size: medium, mechanical.

F7. **Padding, gap and radius literals are unenforced.** 200 / 263 / 85 in
`styles/*.css`; the gate at `check-renderer-style.cjs:7-13` ratchets only
font-size and duration. CLAUDE.md states the padding rule; the gate does not.
Fix: R4 baselines. Size: small for the gate, large-mechanical for the sweep.

F8. **`--card-pad` is off the ladder.** `index.css:115-116` (`14px 16px`,
`10px 13px`). Fix: `--s-3 --s-4` / `--s-2 --s-3`. Size: trivial.

F9. **Hover and at-rest share a step.** `.nav-tab:hover` (`index.css:496`),
`.command-item:hover` (`601`), `.btn:hover` (`292`) all paint `--bg-sunk`,
which is also the resting fill of `.sunk` (`719`) and `.seg` (`ui.css`). A
hovered row over a sunk card disappears. Fix: `--n-4`. Size: small.

F10. **Header controls are four outlined boxes.** `index.css:514-519`,
`540-544`, `363-367` each carry `border: 1px solid var(--line)`; `shell.png`
shows the strip as bezels. HIG: toolbar items "don't include a bezel". Fix: R5.
Size: small.

F11. **Three-line explainer in permanent chrome under the terminal.**
`Sessions.tsx:2080-2084`, acknowledged by its own comment at 2078. Fix:
`defaultHidden` plus a `Tip` on the "+ Add files" button (R7). Size: small.

F12. **Explainer defaults open on eleven views; leads run to 30 words.**
`Control.tsx:433`, `Git.tsx:450`, `Settings.tsx:709`; `Explainer` default
`hidden=false` unless `defaultHidden` (`bits.tsx:403`). Fix: copy lint (R7).
Size: medium, one view at a time.

F13. **346 native `title` tooltips and no tooltip primitive.** 264 in views, 82
in components; `bits.tsx` has no `Tip`. `bits.tsx:42-43` already documents why
`title` alone is insufficient. Fix: one primitive (R7). Size: medium.

F14. **Mixed label case.** `index.css:747` `text-transform: capitalize` on
tabs; `bits.tsx:92-95` capitalised attention words next to lowercase marks.
Fix: one policy in `bits.tsx` (R7). Size: small.

F15. **Batches empty state bypasses `EmptyState`.** `dark-batches.png` shows a
bare "No runs yet." in a table body with an accent button; `index.css:739`
(`table.grid .center`) and `876` (`.chart-empty`) are private empty shapes.
Screenshot evidence for the Batches row; `stubRisk=true` for that half. Fix:
R8. Size: small.

F16. **Two primaries per viewport.** Header "New session" (`index.css:521`)
plus the view's own primary (`dark-batches.png`, `dark-learning.png`,
`dark-context.png`, `dark-sessions.png`). HIG: "Refrain from adding color to
the background of multiple controls." Fix: demote one (R2). Size: small per
view.

F17. **`--mo-period` default implies a breath.** `motion.css:25` sets 2400ms;
`motion.css:47-49` promises no default that implies activity. Fix: `0ms`.
Size: trivial.

F18. **No density setting.** `compact.css` is breakpoints and pointer only;
`Settings.tsx:4518` has a theme row and nothing beside it. Fix: R6. Size:
small-medium.

F19. **Unused or near-unused tokens.** `--t-tiny` 0 uses, `--bg-raised` 3,
`--r-lg` 1, `--glm` 0 (grep). Dead tokens invite a sheet to pick the wrong one.
Fix: delete `--t-tiny`; fold `--bg-raised` into `--n-3`; find where GLM colour
is actually painted. Size: trivial.

F20. **Mono used for sans numbers.** `timeline.css:26-31` switches face for
right-aligned numerals; `index.css:873-874` does the same in `.viz-table`.
Tabular figures in the sans face keep the column aligned without a second
texture. Fix: drop `font-family` and keep `tabular-nums`. Size: trivial.

F21. **A second brand hue with no job.** `--plate-blue` (`index.css:86,195`)
paints a 2px off-register ghost (`509-512`, `754-757`, `learning.css:57-60`)
and a radial wash (`learning.css:3-5`). It is decoration in a system whose
motion sheet says a moving thing "is a claim about the world". Fix: retire.
Size: small.

---

## 6. What not to change

- The warm neutral family and the coral accent. Radix's pairing rule endorses
  a warm gray under an orange accent; Linear moved *toward* warmer gray in
  2026.
- The motion contract. It is stricter than the HIG's and it is already
  enforced by an empty baseline.
- Glyph + word status, text-character glyphs, Lucide beside a word, no
  icon-only sidebar. The HIG and Linear both trend this way.
- `Reading` with no spinner and `EmptyState` with three postures.
- Sticky page heads with a soft rule, chrome one step darker than content,
  nested cards losing their border.
- The stencil face confined to the nameplate and one eyebrow per surface.
- The 4.5:1 contract and the "estimate grammar" on every number that is not
  observed.
