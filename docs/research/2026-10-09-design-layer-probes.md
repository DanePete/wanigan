# Design layer: five probes before code depends on them

The design layer (`docs/design/2026-10-09-design-layer.md` on `feat/design-layer`)
lists five things to prove under "Still to prove". Each was run on 9 October 2026
in Wanigan's own Electron (44.3.0, Chromium 152.0.7977.78) on macOS with a Retina
display (scale factor 2), in hidden windows (`show: false`,
`paintWhenInitiallyHidden: true`, `backgroundThrottling: false`) driven through
`webContents.debugger` (protocol 1.3). Pages were made-up fixtures (acme,
example.test) served from a local HTTP server, and the two demo sites from
`scripts/demo-sites`: Northstar (Drupal 11.4.8) and Fieldnotes (WordPress 7.1.3),
read with GET only. The probe scripts and their output stay in
`.artifacts/probe-design/` (git-ignored); `sass` 1.105.1 and `pngjs` 7.0.0 were
installed in a scratch folder outside the repository, and `source-map-js` 1.2.2
came from the repository's own dependencies.

## Before any of it: two ways to crash or stall the probe

**Answer.** Attaching the debugger and sending the first `Emulation` command to a
hidden window that has loaded nothing crashes Electron's main process; loading
`about:blank` first makes the same sequence work. Separately, an Electron app
with no `window-all-closed` listener starts quitting when its last window is
destroyed, and every window opened after that fails.

**Evidence.** One case per process (`p0-crash.cjs`):

| Sequence | Result |
|---|---|
| New hidden window, `debugger.attach`, `Emulation.setDeviceMetricsOverride` | Main process killed by SIGSEGV before the command returned |
| New hidden window, `debugger.attach`, `Page.enable` | No crash; the command fails with "target closed while handling command" and the window is unusable |
| `loadURL('about:blank')`, then attach and override | Works |
| Load the real page, then attach and override | Works |
| No `window-all-closed` listener, destroy the only window, open another | The second window's `loadURL` fails with `ERR_FAILED (-2)`; in a longer probe the next window creation ended the process with SIGTRAP |
| `capturePage()` on an 800 × 600 window | 1600 × 1136 (device pixels, content area only); with the override at `deviceScaleFactor: 1` still 1600 × 1200 |
| `Page.captureScreenshot` with the override | 800 × 600 exactly |

**What the design layer should do.** Every capture window loads `about:blank`
before the debugger is attached. A capture process keeps a `window-all-closed`
listener. Captures go through `Page.captureScreenshot` under
`Emulation.setDeviceMetricsOverride` with `deviceScaleFactor: 1`, never
`capturePage()`, which returns device pixels at the display's scale and only the
viewport.

## 1. Freezing clocks and timers: virtual time or an injected clock

**Answer.** DevTools virtual time half-works in this Electron: it freezes `Date`,
`setTimeout` and `setInterval` and waits for fonts and images, but
`requestAnimationFrame` keeps firing at the real frame rate after the budget ends,
CSS animations and transitions run on real time, and two of its four ways in leave
the page unable to load. An injected fake clock, plus finishing every animation
through the Web Animations API, gave 0 differing pixels within and across loads,
and is what to use.

**Evidence.** `p1-virtual-time.cjs` loads `clock.html`: a clock written from
`new Date().toISOString()` and `Date.now()` every 50 ms by `setInterval`, a box
moved by that interval, a box moved by `requestAnimationFrame`, an infinite CSS
animation, a CSS transition started by `setTimeout(100)`, a 1 s fade-in, a
`Math.random()` line, a web font served after 600 ms and an image served after
800 ms. Each method ran twice in fresh windows (separate partitions); each run
captured once when settled and again 1.5 s later.

| Method | Same load, 1.5 s apart | Two loads | What happened |
|---|---|---|---|
| Nothing (real time) | 17,878 px | 3,047 px | Clock, boxes and animations all move |
| `setVirtualTimePolicy` `pause` with `initialVirtualTime`, navigate, then `pauseIfNetworkFetchesPending` with a 3,000 ms budget | 13,320 px | 4,000 px | Budget expired after 813 ms real; `Date` exactly 2026-01-01T00:00:03.000Z and 60 interval ticks in both loads; font and image loaded, `load` fired. But rAF went from 97 to 283 callbacks while "paused", the CSS animation sat at the real elapsed time (160 px), the transition started moving after the first capture |
| Same, `Animation.setPlaybackRate(0)` first | 0 px | 1,105 px | Animations frozen at their start (fade-in at opacity 0). `performance.now()` printed 2999.9 in one load and 3000.0 in the other |
| Same, then finish/cancel every animation | 3,200 px | 80 px | rAF box still moving on real time |
| `pauseIfNetworkFetchesPending` with `waitForNavigation: true`, then navigate | — | — | Budget expired 3–4 ms after the call; the document stayed `loading` with an empty body; both captures timed out after 15 s |
| `pause`, never given a budget | — | — | No `load` event in 8 s, `readyState` stayed `loading`, captures timed out after 15 s |
| `pause`, then `advance` with a 3,000 ms budget | 48,724 px | 1,083 px | Budget expired after 9–22 ms real, before the font and the image arrived and before `load` |
| Injected clock (`Page.addScriptToEvaluateOnNewDocument`), wait for `load`, `document.fonts.ready` and `img.decode()`, then advance it 3,000 ms | 10,160 px | 80 px | Clock, timers and rAF frozen and identical; CSS animation and transition on real time |
| Injected clock + `Animation.setPlaybackRate(0)` before navigating | 0 px | 0 px | Identical, but the fade-in is captured at opacity 0 and the transition at its start |
| **Injected clock + finish finite / cancel infinite animations (`document.getAnimations()`) before capture** | **0 px** | **0 px** | Identical, fade-in at opacity 1, transition at its end, the infinite animation at its base style |

The injected clock replaces `Date` (and `Date.now`), `performance.now`,
`setTimeout`/`setInterval`, `requestAnimationFrame` and `Math.random` (a seeded
generator), queues callbacks on a virtual timeline and runs them in order when
the probe calls `tick(ms)`. Other clocks it does not reach, measured in the same
runs:

| Clock | Under virtual time | Under the injected clock |
|---|---|---|
| `new Intl.DateTimeFormat().format()` with no date | Virtual (1/1/26, 12:00:03 AM) | Real time leaks through |
| `document.timeline.currentTime` (drives CSS animations) | Real (≈ 807 ms) | Real (≈ 800 ms) |
| `new Event().timeStamp` | Virtual (3000) | Real (≈ 820) |
| `Math.random()` | Different every load (0.1976 vs 0.3800) unless Electron starts with `--js-flags=--random-seed=42`, which made it identical in every load, virtual time or not | Seeded by the script |

**What the design layer should do.** Freeze the page with an injected clock
added through `Page.addScriptToEvaluateOnNewDocument` before navigating, wait for
`load`, `document.fonts.ready` and every image's `decode()`, advance the clock a
fixed amount, then finish finite and cancel infinite animations through
`document.getAnimations()` before each capture. Do not use
`Animation.setPlaybackRate(0)` (it captures fade-ins invisible) and do not use
virtual time in this Electron. The clock script should also cover
`Intl.DateTimeFormat`'s no-argument `format`; `document.timeline` cannot be
faked, which is why animations are finished rather than timed. Not tested and
therefore not covered: timers in workers, work scheduled through `MessageChannel`
or `requestIdleCallback`, animated GIFs, video and canvas. Whatever still
differs is what the noise calibration in Stage 3 is for.

## 2. Full-page capture through the debugger

**Answer.** `Page.captureScreenshot` with `captureBeyondViewport: true` and a
clip returns exactly the requested size at every width from 360 to 1920, and a
static page captures identically every time (0 px). Three things make it wrong
unless handled: colours come out in the display's colour space unless Chromium is
launched with `--force-color-profile=srgb`; with GPU rendering, everything below
16,384 px silently repeats the page from the top; and classic scrollbars change
the layout width during the capture. GPU and software rendering differ on 14–24 %
of the pixels of the demo pages (30–33 % of a fixture full of gradients), so the
two renders of a comparison must use the same mode.

**Evidence.** `p2-fullpage.cjs`, `deviceScaleFactor: 1`, viewport height 800. The
bands fixture is a `100vh` hero followed by 100 px bands, each a unique exact
colour with a text label, a `position: fixed` marker at the top left, another at
the bottom, and a `position: sticky` marker inside bands 20–29. Every capture was
taken twice in the same load and once after a reload; band colours were checked
pixel by pixel against the layout measured in the page before capture.

- **Size.** PNG width and height equalled the clip at all seven widths (360, 390,
  768, 1024, 1280, 1440, 1920) for 7,200 px and 20,800 px pages, and at 390 and
  1280 for a 40,800 px page, GPU and software. A 1280 × 40,800 capture took
  0.5–0.6 s.
- **Colour.** Without the switch the PNG carries an embedded ICC profile and the
  pixels are the display's: page `rgb(250,128,0)` came back as 234,135,50,
  `rgb(255,0,255)` as 234,51,247; all 64 bands failed, worst channel off by 30.
  `app.commandLine.appendSwitch('force-color-profile', 'srgb')` before `ready` made
  no difference. Passing `--force-color-profile=srgb` on Electron's command line
  made every band exact (worst channel difference 0).
- **The 16,384 px wrap (GPU only).** On a 20,800 px page the capture is the right
  size, but from y = 16,384 down it starts again at the top of the page: the hero
  at 16,384–17,183, the fixed markers again, the sticky marker again at 19,184;
  45 of 200 bands wrong at every width. At 40,800 px it repeats at 16,384 and at
  32,768 (245 of 400 bands wrong). Nothing reports an error. With software
  rendering both pages were correct in one capture. With GPU rendering, clips of
  8,192 px stitched together were correct (0 bad bands of 400 at 390 and 1280).
- **Fixed, sticky, `100vh`.** In every correct capture the `100vh` hero was 800 px
  (the viewport, not the page), the top-fixed marker appeared once at 0–29, the
  bottom-fixed marker once at 770–799 (the bottom of the first viewport, not of
  the page), and the sticky marker at its place in the flow (2,800). No repeated
  or blank tiles.
- **Scrollbars.** With `mobile: false` the hidden window has classic 15 px
  scrollbars (`clientWidth` 375 at 390). During a capture the page is laid out at
  the full width without them and then back: a `ResizeObserver` on `<html>` saw
  1024 then 1009, and the captured bands reach the right edge. With
  `Emulation.setScrollbarsHidden({ hidden: true })` (or `mobile: true`, tested at
  360 and 390) the layout width stays the viewport's. Either way each capture fires
  a `resize` and a `visualViewport` `resize` event in the page (`p2b-resize.cjs`).
- **Noise floor.** Fixtures (bands, and a page of text, gradients, shadows, a
  blur, a rotation, an SVG and a scaled image): 0 px between two captures of one
  load and between loads, GPU and software. Northstar: 0 px, except one GPU reload
  at 390 with images forced eager that differed on 1,839 px by 1 level. Fieldnotes
  was not stable:

  | Fieldnotes, GPU, 1440 | Same load | Reload |
  |---|---|---|
  | As loaded (9 of 13 images still lazy) | 155,206 px | 81,488 px |
  | Images forced eager and decoded | 5,030 px | 110,094 px |

  The differences sit on downscaled route-map photos and two one-pixel rules; in
  software mode the first capture of an eager page missed one image entirely
  (drawn as its placeholder colour). `p2c-settle.cjs` then applied everything at
  once (sRGB, scrollbars hidden, animations finished, images `loading = 'eager'`,
  `decoding = 'sync'` and decoded, fonts ready, two frames) and captured until two
  captures in a row were identical:

  | Page | Captures until stable (GPU / software) | Two loads, GPU | Two loads, software |
  |---|---|---|---|
  | Northstar 390, 1440 | 2 / 2 | 0 px | 0 px |
  | Fieldnotes 390 | 3 / 3 | 127,925 px, max 7 levels (0 px in an earlier run) | 0 px |
  | Fieldnotes 1440 | 3 / 4–6 | 6 px, max 1 level (16 px in an earlier run) | 0 px |

  An earlier GPU run of the same script measured Northstar at 1440 as 3,369 px
  tall in both loads instead of 3,405; it did not happen again in later runs and
  its cause was not found.
- **GPU against software**, same page, same settings (`p2-compare.cjs`):

  | Page | Pixels differing | Largest channel difference |
  |---|---|---|
  | Bands (flat colour, monospace labels) | 22,356 px (the labels), every width | 1 |
  | Rich fixture | 29.6–32.7 % | 53 |
  | Northstar | 14.0–18.6 % | 69–94 |
  | Fieldnotes | 15.9–24.4 % | 86–224 |

**What the design layer should do.** Capture in a dedicated capture process
started with `--force-color-profile=srgb` on its command line (a switch appended
at run time is ignored, and forcing sRGB in the main app would change how the
whole app draws). Prefer software rendering there: it has no 16,384 px wrap and
was the only mode that reached 0 px across loads on Fieldnotes; if GPU is kept,
capture in clips of at most 8,192 CSS px and stitch them. Never compare a GPU
render with a software one. Hide scrollbars (`Emulation.setScrollbarsHidden`), or
use `mobile: true` for phone widths, so the captured layout is the viewport's.
Before capturing: the clock and animation steps from question 1, images forced
eager with `decoding = 'sync'` and decoded, fonts ready, two frames; then capture
until two consecutive captures match, and check the page height did not change.
The calibration in Stage 3 stays necessary: a real page settled this way still
differed by up to 7 colour levels between GPU loads. Expect page scripts to see a
`resize` event on every capture. A bottom-fixed element is drawn at the bottom of
the first viewport; both renders do the same, so it compares, but a person
reading the image should be told.

## 3. Where a DevTools-edited rule lands in the cascade

**Answer.** `CSS.setStyleTexts` edits the rule where it is: an edited rule in a
`<link>` stylesheet or an inline `<style>` keeps its source order, its
specificity, its `@layer` and its `@media`, and `!important` added by the edit
behaves as it would in the file. Injected sheets rank in three different places:
`webContents.insertCSS` (author) comes before every page stylesheet, `insertCSS`
with `cssOrigin: 'user'` is the user origin, and an inspector stylesheet
(`CSS.createStyleSheet` + `CSS.addRule`) comes after every page stylesheet,
including a `<style>` at the end of `<body>`.

**Evidence.** `p3-cascade.cjs`. Each element's winner was read with
`CSS.getComputedStyleForNode` (`color` set to a distinct `rgb()` per rule), and
the order of matched rules with `CSS.getMatchedStylesForNode`.

Edits with `CSS.setStyleTexts` on `cascade.html` (a `<style>` before a `<link>`,
the `<link>`, a `<style>` after it):

| Edited rule | Competing rule | Winner after the edit |
|---|---|---|
| `.t1` in the `<link>` | `.t1` in the later `<style>` | Still the later `<style>` |
| First of two `.t2` in the same `<style>` | The second | Still the second |
| `.t3` inside `@layer base` in the `<link>` | Unlayered `.t3` in an earlier `<style>` | Still the unlayered rule |
| `.t4 .u` in the `<link>` | `.u` in the later `<style>` | The edited rule (its specificity kept) |
| `.t6` inside `@media (min-width: 1px)` | A later plain `.t6` in the same file | Still the later rule; the edited rule still lists its `@media` |
| `.t1` in the `<link>`, edited to add `!important` | The later `<style>` rule | The edited rule |
| The winning `.t2` | — | The edit applies (computed colour changed) |

The edited rules kept their position in the matched-rules list. An edit changes
the CSSOM and what `CSS.getStyleSheetText` returns, but not the DOM: the inline
`<style>` element's `textContent` was unchanged after its rules were edited. A
reload drops every edit.

Injection ranks, on `inject.html` (a `<link>`, a `<style>` in `<head>`, a
`<style>` at the end of `<body>`), each method on a fresh load, "injected" meaning
the injected rule won:

| Page rule against the injected one | Inspector sheet | `insertCSS` author | `insertCSS` user | `<link>` or `<style>` appended to `<head>` | `adoptedStyleSheets` |
|---|---|---|---|---|---|
| Normal, equal specificity, in `<head>` | injected | page | page | injected | injected |
| Normal, equal specificity, `<style>` at end of `<body>` | injected | page | page | page | injected |
| `!important` vs injected `!important` | injected | page | injected | injected | injected |
| In `@layer`, normal | injected | injected | page | injected | injected |
| In `@layer`, `!important` vs injected `!important` | page | page | injected | page | page |
| Higher specificity | page | page | page | page | page |
| `style` attribute vs injected normal | page | page | page | page | page |
| `style` attribute vs injected `!important` | injected | injected | injected | injected | injected |
| Normal vs injected `!important` | injected | injected | injected | injected | injected |

How the protocol labels them: `insertCSS` author rules come back with origin
`injected` and are listed before the page's rules; `insertCSS` user rules come
back with origin `user-agent`; the inspector sheet's rules have origin
`inspector`, are listed after the page's, and the sheet does not appear in
`document.querySelectorAll('style, link')`.

**What the design layer should do.** For a `kind` edit, `CSS.setStyleTexts` on
the winning rule is a faithful preview of editing that rule in its source file,
as the design assumes; re-apply it after every load, and do not rely on the
`<style>` element's text to hold it. For the layer's own stylesheet the design's
premise is confirmed (`insertCSS` author sits before the page and loses ties), and
`!important` there beats every normal page rule. It still lost, as measured, to a
page `!important` of equal specificity (the injected sheet comes first) and to a
page `!important` inside `@layer` (layers outrank specificity); by the cascade's
rules a page `!important` more specific than the doubled attribute selector would
also win. Two better homes exist. The inspector stylesheet ranks after
everything the page has, so a plain rule there wins ties the way a rule appended
to the theme's last file would, with no `!important` needed; it is invisible to
page scripts and lives only in the debugger session, so it must be recreated after
each load. `insertCSS` with `cssOrigin: 'user'` plus `!important` beat every page
declaration tested, layered `!important` included, and should be the choice when an
override must win whatever the theme does; the protocol reports those rules as
`user-agent`, so tell them apart by their style sheet id.

## 4. Sass source maps and mixins

**Answer.** For a declaration written inside a `@mixin`, dart-sass maps the
declaration to the mixin body, not to the `@include`. Only the value can lead
back: when the value is a mixin argument passed as a literal, the map has a second
segment at the value's column pointing to that argument on the `@include` line; a
value from a variable points to the variable's definition; a value that mixes a
literal and a parameter (`2px solid $c`) has no second segment. Chromium gives the
map's URL and exact ranges for every property, and nothing else: resolving the map
is Wanigan's job.

**Evidence.** `p4-sass.cjs` compiled `acme.scss` with dart-sass 1.105.1
(`sourceMap: true`, `sourceMapIncludeSources: true`, `style: 'expanded'`), with a
mixin in a `@use`d partial `_mixins.scss`, a mixin in the same file, a placeholder
`@extend`, a class `@extend`, a variable, a nested rule and a `&:hover`. Each
output line was looked up with `source-map-js` (`originalPositionFor`, and every
segment on the line):

| Output | Maps to |
|---|---|
| `.card, .button {` (from `@extend %heading-base`) | `acme.scss:9` `%heading-base {` |
| `font-weight: 700;` | `acme.scss:10` inside the placeholder |
| `.card, .button {` (main rule; `.button` came from `@extend .card`) | `acme.scss:13` `.card {` only; the `@extend .card;` line is not mapped |
| `color: #0a7f5a;` | `acme.scss:14` `color: $accent;`; the value segment → `acme.scss:3` `$accent: #0a7f5a;` |
| `padding: 12px;` (mixin from the partial, argument `12px`) | `_mixins.scss:3` `padding: $size;`; the value segment → `acme.scss:15` col 22, the `12px` in `@include m.card-pad(12px);` |
| `border-radius: 4px;` (literal inside the mixin) | `_mixins.scss:4` only |
| `box-shadow: …;` (mixin in the same file) | `acme.scss:6`, inside the mixin, not the `@include local-shadow;` at line 16 |
| `.card .title, .button .title {` | `acme.scss:19` `.title {` |
| `outline: 2px solid #0a7f5a;` (`focus-ring($accent)`) | `_mixins.scss:8` `outline: 2px solid $c;` only |
| `.card:hover, .button:hover {` | `acme.scss:24` `&:hover {` |
| `color: rgb(…);` from `darken($accent, 10%)` | `acme.scss:25`, the declaration with the call |
| `background: #0a7f5a;` | `acme.scss:31`; the value segment → `$accent`'s definition |

`p4-chromium.cjs` loaded the compiled CSS with its `sourceMappingURL` comment.
`CSS.styleSheetAdded` reported `sourceMapURL: "acme.css.map"` exactly as written
(relative); Chromium did not request the map (the fixture server never saw a
request for it). `CSS.getMatchedStylesForNode` gave each rule's selector list, the
index of the selector that matched (`[1]`, the `.button` half of `.card, .button`,
for the button) and a range for every property in the compiled file. Resolving the
map against the sheet's URL and looking up each property range's start
(0-based line plus 1, same column) gave exactly the table above.

**What the design layer should do.** Resolve `sourceMapURL` against the sheet's
`sourceURL`, fetch and parse the map in the main process, and look up the
property's range start. If the result lies inside a `@mixin`, do not edit that
line: it changes every rule that includes the mixin. Route instead to the
`@include` in the rule the selector segment points to (the selector maps to the
rule's own block, so search that block for the include of that mixin), using the
value segment when it exists to land on the exact argument. A value segment that
points to a variable's definition means the edit is a token edit. A selector made
by `@extend` maps to the extended rule, so a `kind` edit there reaches every
extender; the router has to say so. Placeholders map to the placeholder.

## 5. Stylesheet order on each CMS

**Answer.** Both demo front pages put every stylesheet in `<head>` and none
carries a source map. Northstar loads 31 separate files (aggregation is off): core's
base-theme CSS, then the theme's global files, then its single-directory
components, then the rest of the theme. Fieldnotes has 38: three core block
stylesheets as links and 35 inline styles, with `wp-block-library-inline-css` and
`global-styles-inline-css` near the end and the theme's own stylesheet after them.
On both, a sheet from `webContents.insertCSS` ranks before all of them and loses
every tie, and a `<link>` appended to `<head>` ranks after all of them and wins.

**Evidence.** `p5-cms.cjs`, front page at 1280 wide, every `link[rel~=stylesheet]`
and `style` in document order, `CSS.styleSheetAdded` headers for `sourceMapURL`,
and each linked sheet's text checked for a `sourceMappingURL` comment.

Northstar (Drupal 11.4.8), all `<link>` in `<head>`, `media` all, URLs carry a
`?tmnxq1` cache key:

| # | Stylesheets | From |
|---|---|---|
| 0–8 | `system/components/*.module.css` (5), `views/views.module.css`, three Layout Builder and Layout Discovery layout CSS files | Core, through the `stable9` base theme (`/core/themes/stable9/…`) |
| 9–13 | `css/fonts.css`, `tokens.css`, `base.css`, `layout.css`, `navigation.css` | The custom theme |
| 14–24 | `components/<name>/<name>.css` for 11 single-directory components, alphabetical | The custom theme's components |
| 25–30 | `css/blocks.css`, `content.css`, `views.css`, `forms.css`, `layout-builder.css`, `motion.css` | The custom theme |

No `/sites/default/files/css/css_*.css` URLs, so CSS aggregation is off, and no
file has a `sourceMappingURL` (the theme ships plain CSS). Aggregation could not
be observed live without changing the site. Read in core's
`CssOptimizer::processCss()` instead: when a file is aggregated, every comment
block is removed with one regular expression, which includes a
`/*# sourceMappingURL=… */` comment.

Fieldnotes (WordPress 7.1.3), all in `<head>`, `media` all:

| # | Stylesheets |
|---|---|
| 0–28 | Per-block core styles, mostly inline (`wp-block-site-title-inline-css`, `wp-block-search-inline-css`, …), three as links from `/wp-includes/blocks/` (`wp-block-navigation-css` #3, `wp-block-image-css` #14, `wp-block-cover-css` #26); the theme's own per-block styles are inline right after the core style of the same block (`fieldnotes-heading-inline-css` after `wp-block-heading-inline-css`, and so on), and two styles for the theme's own blocks at #25 and #27 |
| 29 | `wp-block-library-inline-css` (there is no `wp-block-library-css` link) |
| 30 | `global-styles-inline-css` (theme.json, 25,727 characters) |
| 31–34 | `block-style-variation-styles-inline-css`, `wp-emoji-styles-inline-css`, `core-block-supports-inline-css`, `wp-block-template-skip-link-inline-css` |
| 35 | `fieldnotes-css`, the theme's stylesheet (`/wp-content/themes/fieldnotes/assets/css/theme.css`) |
| 36 | An inline style added to a theme handle |
| 37 | `<style class="wp-fonts-local">`, the theme.json font faces |

Rank on the real pages: for `body` and `a`, the page's own winning `color` rule
(`body { color: var(--ns-ink) }` and `a { color: var(--ns-pine) }` on Northstar;
`body { color: var(--wp--preset--color--contrast) }` and
`a:where(:not(.wp-element-button)) { color: currentColor }` on Fieldnotes) was
repeated with the same selector and a marker colour, on a fresh load per method.
`insertCSS` author: the page won all four. `insertCSS` user: the page won all four.
`<link>` appended to `<head>`: the injected rule won all four. Inspector
stylesheet: the injected rule won all four.

**What the design layer should do.** On Drupal, where a native rule lands depends
on its file: a rule added to a component's own CSS (#14–24 here) loses a tie to the
same selector in `blocks.css` or `content.css` (#25–30), so the implement step
should write into the file that holds the winning rule, which `CSS.setStyleTexts`
already previews exactly. Read styles with aggregation off, as the design says:
aggregation removes the map comment. On WordPress, global styles from theme.json
come after the core block styles and before the theme's stylesheet, so an equal
selector in the theme's CSS beats a theme.json style; many global-style selectors
use `:where()` and have no specificity at all. A layer preview that should rank
like a rule appended to the theme belongs in the inspector stylesheet or an
appended `<link>`; an `insertCSS` author sheet needs `!important` to show anything
these themes also set.

## Not proven here

- Captures at `deviceScaleFactor` 2; only 1 was tested, and the GPU wrap may come
  sooner in CSS pixels at a higher scale.
- Why Fieldnotes still differs by up to 7 colour levels between GPU loads after
  settling, and the one Northstar run that measured 36 px shorter.
- A Drupal page with aggregation on (the demo runs with it off and was not
  changed); the stripping is read from core's source, not observed.
- The injected clock against workers, `MessageChannel`, `requestIdleCallback`,
  animated images, video and canvas.
- A user-origin `!important` against a `style` attribute that is itself
  `!important`.
