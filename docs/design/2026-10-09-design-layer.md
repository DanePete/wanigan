# The design layer: edit live, implement natively, prove it pixel for pixel

Status: draft, 9 October 2026. Research behind it: `reports/Real time visual
editors.md` and the notes in `research_notes/Design layer and native fidelity/`
(local, not in git).

## The problem

The owner wants to change a real Drupal or WordPress site the way Wix or
Webflow let you change theirs: click the words and type, swap a picture, change
a colour, a font, a size or the space around something, and see it at once.

Every tool that does this today pays for it in one of two ways. Site builders
and page builders (Wix, Webflow, Elementor, Drupal Canvas) store the design in
their own data model and render it themselves, so the site depends on them.
AI app builders (v0, Lovable, Bolt) gave up direct edits in 2026 and now have a
model rewrite the source, which costs tokens, lands in the wrong place and
cannot be checked.

His sites are neither. They are ordinary Drupal and WordPress sites with their
own themes, most without Canvas, and the result has to be the site's own code
and content: what a good developer would have written by hand, deployed the
usual way, with no Wanigan in production.

## The idea

Three stages, each with one job.

1. **Edit, in a layer.** Changes apply to the live view instantly, inside a
   layer that Wanigan keeps on its own side. Nothing in the site changes while
   the owner designs, so editing is fast, free and risk-free.
2. **Implement, natively.** "Make it real" turns each change into how this site
   would really do it: content into its field or block through core, a colour
   into the theme's token, a component's style into that component's own CSS or
   SCSS source, a one-off into the right native hook. Deterministically where
   the target is exact; through a coding agent with a precise brief where it
   needs judgement.
3. **Verify, pixel for pixel.** Wanigan renders the page without the layer and
   compares it with the page as designed, at every breakpoint. Where they
   differ, it says which change and where. A change leaves the layer only when
   the native page matches it.

The layer gives the real-time feel. The verification gives the fidelity. The
agent, when one is used, checks its own work against the same test.

## Stage 1: the layer

### What an edit is

One record per change, kept in an append-only log so undo and redo are exact:

| Field | What it holds |
|---|---|
| `target` | The part's identity from the trace (below), never a DOM path alone |
| `scope` | `this` (one element), `kind` (every instance of this component, block type or field), or `site` (a token) |
| `breakpoint` | `all`, or one of the theme's breakpoints |
| `change` | `text` (new value), `image` (new asset, alt), `style` (property → value or token), `token` (name → value), `insert` (a component, block or pattern at a place, with its props), `remove` (one placed item) |
| `before` | The computed value or content as it was, for undo and for the verify step |
| `state` | `draft`, `implemented`, `verified`, `retired`, or `orphaned` |
| `by`, `at` | Who made it (owner, or an agent through MCP) and when |

### Identity that survives a reload

The trace's part ids (`p237`) are numbered in render order, so they belong to
a position, not to a part. Seen on a real Drupal site on 9 October 2026: after
two blocks swapped places, the ids stayed where they were and the blocks under
them changed. The layer therefore keys each edit on what the part is, which the
helpers already report:

- content: entity type, UUID, field, delta, language (Drupal); post id, block
  path and block name (WordPress);
- components: the single-directory component id or block name, plus its path
  among its siblings;
- configuration: block id, menu link id, menu name, a Layout Builder
  component's UUID, template part slug;
- fallback, for markup no helper explains: a CSS selector path plus a hash of
  the element's text, and the edit is marked `fragile`.

After every load the page script resolves each edit's identity to elements and
tags them with a dev-only attribute (`data-wl-edit`). The layer's CSS uses only
those attributes, so nothing it does can reach an element it was not meant for.
A draft whose identity no longer resolves becomes `orphaned`, is listed, and is
never applied to whatever now sits in its place. An implemented edit is in the
site: a load where it does not resolve is said, and it stays `implemented`
(never a draft again, so never discarded or undone while its words are in the
site); a failed verification is kept with it, saying what differs.

### How it renders

The preview must predict the native result, not just look like it. So a style
edit is previewed the way it will be implemented:

- **Every instance of a component (`kind`)**: Wanigan finds the theme rule that
  actually sets the property (Chrome's own matched-rules data, with the cascade
  worked out as DevTools does, following `var(--x)` to where `--x` is set) and
  edits that rule in place through the DevTools protocol. When the source map
  or the theme's conventions lead to that rule's line in SCSS or CSS, the native
  change is the same value at the same place, so specificity, layer and load
  order cannot differ between preview and result.
- **One element (`this`), tokens, and any rule that cannot be found**: the
  layer's own stylesheet, scoped by `data-wl-edit` and by media queries for
  breakpoints. It wins with `!important` and a doubled attribute selector:
  Chromium places stylesheets injected by Electron before the page's own, so a
  plain rule would lose ties. Whether the native rule wins is proven in Stage 3.

Each change repaints at once, without a reload.
- **Text** patches the traced node's text in place (plain text, or the field's
  allowed markup through a schema-checked editor: no `contenteditable` free-for-all).
- **Images** swap the `src`/`srcset` of the traced image to a local preview of
  the new file, keeping its box, so layout changes show honestly.
- **Tokens** override the theme's custom property (`--color-accent`,
  `--wp--preset--color--accent`) on `:root`, so every use repaints together.
- **Adding a component** renders it on the server, alone, through the helper's
  piece route with the props the owner chose, and places that HTML where it
  goes, so the preview is the site's own markup and CSS. **Removing one** hides
  it and marks the gap; nothing is deleted until it is implemented.

### Where it lives

In Wanigan's data folder, per project, never in the site and never in the
owner's repository. It survives a restart and a crash. A pending-edit tray
lists every draft with before and after, per-edit undo, and the reach of each
(this page, 14 pages, every page).

## Stage 2: implement natively

### The router

Each edit is routed to one native home by what it is and what the site is. The
site's facts come from the trace and a one-time scan of the theme (its build,
its tokens, its breakpoints, whether it is a custom theme).

| Edit | Native home | How |
|---|---|---|
| Text, image, alt (one instance) | The field or block that holds it, through core: Drupal Entity API with `validate()`, a new revision; on WordPress, the block's own element in the post, template, template part, synced pattern or navigation menu that stores it (one block written alone with `WP_Block_Processor`, formatted words spliced as core splices bound rich text), words bound to post meta in that field, one placement's override in its `core/block`, an image's media-library alt through media REST | Deterministic, through the helper's edit targets, with a base hash and a 409 if the site changed; each target says where it shows |
| Token (site-wide colour, font, size, space) | The theme's token: `theme.json` presets (WordPress), the theme's `:root` custom properties or its SCSS variables (Drupal) | Deterministic for `theme.json` and plain CSS custom properties; agent for SCSS maps and Tailwind config |
| Style, every instance of a component | That component's own source: its SDC `.css`, its SCSS partial, or its block stylesheet, found from the matched rule and source maps | Deterministic when the rule and file are plain CSS; agent otherwise |
| Style, one instance | Where core stores one instance's style: WordPress block-support attributes (preset references first); Drupal, a field or component prop that already varies it | Deterministic for block supports; otherwise an agent adds a native hook (a modifier class from a field or a variant prop) and a rule in the component's CSS |
| Template text | On a WordPress block theme, the template or template part, saved as the Site Editor saves it (its first save copies the theme's file into the database); otherwise the theme's Twig or PHP template, and on WordPress a theme pattern's file | Deterministic through `/wp/v2/templates` and `/wp/v2/template-parts` for block templates; a diff the owner approves, or an agent, for template and pattern files |
| Add a component, block or pattern | Where core places it on this page: a Layout Builder section, a block region, an entity's component or reference field, WordPress block markup in the post, template or part | Deterministic through the helpers' existing insert paths, with a base hash, a 409 and undo |
| Remove one | The same place: take the placement or reference out | Deterministic; never deletes the content entity, block content or media it showed. Shared placements (a block on every page) say their reach and ask first |
| A component placed by a template | The template itself | A diff the owner approves, or an agent |

Finding where a style lives in the theme's source, in this order:

1. The rule that wins, from Chrome's matched rules for the element (the
   protocol lists every matching rule with its source ranges; which one wins
   is worked out as DevTools does). A `var(--x)` value is followed to where
   `--x` is set, which may be the real place to change.
2. That rule's line in the original source, through the stylesheet's source
   map (ECMA-426). Drupal's CSS aggregation strips the map link, so Wanigan
   reads styles with aggregation off.
3. No map: the theme's conventions (a `.scss` or `.pcss.css` beside the CSS, a
   single-directory component's own file), then a one-time build with maps in
   a scratch copy, then matching the rule by its text.
4. Tailwind: the class list in the Twig or PHP template, or the `@theme` token.
   Its source maps lead into `node_modules`, not to the edit.

Rules for every write:

- Only inside the project's custom theme, custom modules and content. Never
  core, contrib, vendor or a parent theme someone else ships. If the active
  theme is not custom, the first step is creating a subtheme or child theme,
  as its own reviewed change.
- Every code change is a diff in Changes. Nothing is committed for the owner.
- A theme build (Sass, PostCSS, Vite, Gulp, Tailwind) runs only on the owner's
  click, as argv without a shell, with its output shown.
- An agent is started only on the owner's click (it spends tokens). Its brief
  carries the edits, the computed styles before and after, the matched source
  rules and files, the tokens, the breakpoints, and the verification it must
  pass, which it runs itself through Wanigan's MCP tools.

## Stage 3: verify, pixel for pixel

No design-to-code tool measures its fidelity, and agents' own screenshot checks
do not predict it (an independent comparison found no correlation). So Wanigan
runs the check itself, the same way every time, and an agent's own check never
counts.

**Two renders that can be compared.** The design (the native page with the
layer) and the result (the native page without it), in hidden windows of the
same size, device pixel ratio, zoom, GPU mode and session, never throttled.
Before each capture: web fonts loaded, animations, transitions and the caret
switched off, lazy images loaded and decoded, the page settled. Full pages are
captured through the DevTools protocol, not `capturePage`, which takes only
the viewport.

**Calibrated noise.** Each version is captured twice first. The difference
between a version and itself is the noise floor, and the tolerance is stated
as two numbers in the manner of the web-platform-tests "fuzzy" annotation (the
largest colour difference and the number of pixels allowed), never as a
percentage, with anti-aliasing forgiveness off for the verdict. As built, the
floor is page-wide: one pair of numbers for the whole page (the largest over
both versions and every width), applied to each area. A block whose content
changes between renders anywhere on the page (a random order, a clock)
therefore forgives as many differing pixels next to an edit as it differs
by; nothing masks it. Measuring the floor per area would need the verdict to
state more than one, which it does not yet.

**In this order, stopping at the first failure:**

1. **Styles and boxes, exactly.** A DOM snapshot of both renders: for every
   element an edit touched, the computed values of its properties and its box
   must be equal. This says exactly which property is off.
2. **Pixels.** The two full-page captures, within the calibrated tolerance; a
   difference is boxed and tied to its edit.
3. **The rest of the page.** Outside the edited elements, the result must equal
   the design. As built (phase 1), the design is the native page with the
   layer, so this catches a layer that reaches further than its edits, but a
   change the native implementation itself made beyond the touched elements
   is in both renders and is not caught yet. Catching that needs the page as
   it was before the edits, kept when an edit is made real and compared row by
   row (text reflows); that is still to build.
4. **States and edges.** Hover, focus and active forced on the touched
   elements; each breakpoint and one pixel either side; dark mode and reduced
   motion where the theme answers them; long, short and empty text for text
   edits. Drupal pages are checked with CSS aggregation off and on.

In this design, an edit is `verified` when all four pass everywhere it reaches
(pages sampled from Go to's index when it reaches many). Phase 1 builds less,
and its `verified` means less: steps 1 to 3 as built (step 3 against the
design, not the page before) passed on the edit's own page at the widths
asked. Step 4 and reach across pages are not built. The owner then retires it; retired
edits are archived, not deleted. An agent's implementation gets at most three
automatic rounds of "verify, give it the failures, try again"; after that the
evidence goes to the owner.

**What an agent is given.** The edits as records (computed values before and
after, the tokens, the matched rules and their source lines, the
breakpoints), plus the design and current screenshots, as intent rather than
coordinates. Measured on design-to-code tasks, structured data with an image
beats an image alone, while coordinates push models to absolute positioning.

## The component library

A view of every component the site can place, so the owner sees what exists
before adding it:

- **What is listed:** Drupal's single-directory components and placeable
  blocks, through core's own plugin managers; WordPress's registered block
  types, patterns and block styles, through core's registries. Each with its
  name, its source, its props and slots, and the module, plugin or theme it
  comes from.
- **A picture of each:** rendered alone through the helper's piece route with
  example props (a component's schema examples, a block's `example`, a
  pattern as written), at phone and desktop widths, in a hidden window, cached
  until the component's files change.
- **Where it is used:** the places the site's stored data says use it, from
  the helper's read-only search (`GET /_wanigan/usage`; how each platform's
  search works and what it cannot see is in
  docs/research/2026-10-09-core-limits.md, build item 10), each opening in
  the view where a page shows it; and where the page shown uses it, from its
  trace.
- **From there:** add it to the page (drag it onto the live view, or choose it
  and click where it goes), open its source in the Code tab, or ask an agent
  about it.
- Agents read the same library through an MCP tool, so a request can name a
  real component instead of describing one.

## What this does not promise

- Content that differs between renders (dates, random order, personalisation)
  is not verified, and is not masked either: it raises the page-wide noise
  floor, which then forgives as much next to every edit.
- A page is compared down to 6,000 px; below that nothing is, and the verdict
  says so (a statement among its differences, even on one that passed).
- A text format may change saved markup (Drupal filters, WordPress kses). The
  verify step shows the difference; it does not hide it.
- Interaction states (hover, focus) and other content lengths are verified only
  where the edit names them.

## Phases

1. **Layer and content.** Identity, the edit log, live injection, the tray,
   scopes; text and images implemented through core and verified; the verify
   loop (calibration, styles and boxes, pixels, the rest of the page).
2. **Components.** The library with pictures; adding and removing on the page,
   implemented through the helpers' insert paths and a new remove path.
3. **Styles, deterministic.** Tokens in `theme.json` and plain custom
   properties; WordPress block supports; Drupal component CSS in plain files;
   editing the winning rule in place for `kind` edits.
4. **Sources and agents.** Source maps to SCSS and PostCSS, Tailwind, the theme
   build, the agent brief and its `live_verify` tool.
5. **Themes and reach.** Creating a subtheme or child theme; reach checks
   across many pages.

## Phase 1, as contracted

The types are in `src/shared/design-layer.ts` and `src/shared/live-trace.ts`
(`PartIdentity`), the core's methods in `src/shared/protocol.ts`
(`live.layer*`), the main process's in `src/shared/bridge.ts`
(`LiveBridge.layer*`). Phase 1 covers text and style edits; images, inserts
and removals as layer edits come later (inserting and removing already work
directly through the helpers).

**The helpers (version 4, the same bump as removal and the library).** Every
part a helper can name carries `identity`:

- Drupal: an entity part is `entity` (type, UUID, bundle, langcode); a field
  part adds `field`; a field item adds `item`, `ref:<type>:<uuid>` for a
  reference (so a reorder does not move it) and `delta:<n>` for a value. A
  single-directory component is `component` (its id, the identity key of the
  nearest identified part it is inside, and which of that id it is there). A
  block placement is `config` `block` (its id, its plugin); a menu link is
  `config` `menu_link`; a menu is `config` `menu` (its machine name, as its
  template is given it); a view display is `config` `view`. A Layout Builder
  component is `config` `layout_builder_component`: its UUID, the key
  `Section::toRenderArray()` gives it in its region, so a reorder or a move
  to another section or region keeps it, on the stored entity it is rendered
  for (`<entity type>:<entity UUID>/<component UUID>`), with its block plugin
  so `kind` reaches every component of that plugin in a layout. The entity is
  part of it because one UUID can name two stored things: a display's
  default layout is shared by every entity without its own, and an entity's
  own layout starts as a copy of the default, UUIDs and all. A placement and
  a component of one plugin are two kinds, and the library's "where it is
  used" counts both. A menu has no kind beyond itself, as a menu link has
  none, and the same menu shown twice is one identity reached twice, as an
  entity in two view modes is. Content not saved yet, a key that is not a
  UUID or a value that is not plain names nothing.
- WordPress: a post is `entity` `post` (its ID, post type as bundle), a term
  `entity` `term`; `post_title`, `post_content`, `post_excerpt` or a
  registered meta key as `field`. A block in stored markup is `block` (its
  store, path and name). A widget, menu item, template and template part are
  `config`. WordPress keeps no id for a block, so a block's path is a place:
  after a reorder its identity stays with the place (seen on the Fieldnotes
  demo). What keeps an edit from landing on the block that moved there is
  the target's text hash, which is therefore taken over all of the element's
  words, children included; a container with no words at all cannot be
  guarded, and its edit says it is fragile.

**The core** keeps the log in its database (an additive migration): one row
per edit and an append-only list of what was done to them (add, discard,
undo, redo, mark), so undo and redo are exact and nothing is lost. It checks
every edit with `layerEdit()` and gives it its id. It never writes to the site
or the project.

**The main process** (`src/main/live-layer.ts`):

1. After every load of the view, and on `layerApply()`, it reads the
   project's edits from the core and resolves each one on the page: the
   trace's parts by `identityKey` (or, for scope `kind`, every part with the
   same `kindKey`), then `inner` inside each part's own element, and checks
   `textHash` (words one of the layer's own text edits saved are put back
   first, so a style on a retyped heading, or the card around it, still
   resolves). It tags what it found with `data-wl-edit`, injects
   `compileLayer()` as one stylesheet, and patches the words of text edits in
   place. The sheet is gated on a generation the page's root names
   (`data-wl-layer`): Electron cannot take a user-origin sheet out again
   (`removeInsertedCSS` removes author sheets only, seen on Electron 44), so
   a new sheet replaces the old one by the root naming its generation, and
   switching the layer off names none. A draft of this page that does not
   resolve is reported as orphaned (and the core told); an implemented edit
   that does not resolve on a load is reported, and stays implemented: its
   words are in the site, so it never becomes a draft again or discardable.
   Edits of other pages are left alone.
2. `layerTarget()` keys the picked element: its part's identity (the
   innermost region with a part that has one), the CSS path from that part's
   root element to it, its words' hash, what `kind` would reach and how many
   elements that is on this page, and its computed values as `before`.
3. `layerImplement(id)` makes a text edit real where its element holds plain
   words and one thing the site saves holds exactly those words, as the
   logged-in user with a revision where the site keeps them, and marks it
   `implemented` only when the site says it saved (with that revision).
   - Drupal: a plain text field the helper marks around the words
     (`data-wl-field`), saved through `helperSave` (`POST /_wanigan/save`) to
     exactly the content, translation and item the target's identity names
     (its UUID, langcode and item, never the default language or the first
     item holding the same words; a target that names no field is refused),
     only over the version the page showed (content saved since, a newer
     draft, an inline Layout Builder block and any validation violation, the
     workflow's included, are refused, saying why).
   - Otherwise (WordPress's helper marks no field; it saves fields through
     schema targets): the one `via: 'schema'` edit target of the page's trace
     whose value, or a string property of it, equals the words as the site
     rendered them (whitespace folded, wptexturize's quotes, dashes and
     ellipsis read as typed): a title, an excerpt, a string meta, the site
     title or tagline, a menu link's text (its address sent back as it was).
     Never a slug, a status, a choice, an address or a read-only value. It is
     looked for in the parts the edit's identity names, then outward a level
     at a time, the nearest level deciding: each part's parent, and the post
     a block shows through its block context (`context.postId`), so a
     post-title block finds its post's title whether it sits inside the post
     or beside it in the template. It is saved through the window's own
     schema save (`POST /_wanigan/edit/<id>` with the trace's id, checked
     with `checkValue` in main and again by the helper), refused if the view
     holds another trace by then.
   - Formatted text (a block's rich text, words inside a post's content, a
     value holding markup) answers `route: 'agent'`, as styles and tokens do
     until phase 3. Nothing holding the words, more than one thing holding
     them (named), a changed page, a target the trace says this user may not
     change, or a refusal from the site (passed on as the site said it)
     answers `route: 'none'`, with why.
4. `layerVerify(id)` renders the page with the layer (the design) and without
   it (the result) in hidden windows in the view's session at each width,
   measures the noise floor by rendering each version twice (every width is
   judged against the one floor the verdict states, the largest over both
   versions and every width), then runs the
   steps in order: computed styles and boxes of the touched elements (a token:
   its custom property as the root computes it, in both renders), pixels
   around them, then the rest of the page. Nothing passes for want of a
   comparison: an edit found but gone when the page was measured, a token
   whose value was not read, or an edit for a named breakpoint (phase 1 reads
   no breakpoints, so the design cannot show it) fails, saying so. Every step
   that waits on a hidden page has a deadline, and so does each render: a page
   that never answers fails the verification, its window is closed, and the
   next one runs. A page taller than 6,000 px is compared down to there, and
   the verdict says how far, passing or not. It keeps the pictures in the data
   folder and tells the core (`verified`, or still `implemented` with the
   verdict, which says what differs: the words are in the site either way).
   `verified` here is phase 1's: steps 1 to 3 passed on this page at these
   widths, step 3 against the design rather than the page before the edits,
   so a change the native implementation made beyond the touched elements is
   in both renders and is not caught; step 4 and other pages are not checked.

**The window** shows a tray of the project's edits (before and after, the
page each is on, its state and verdict, fragile ones said so), per-edit
discard, undo and redo, and the style panel and "Retype the words", which now
make layer edits with a scope (`this`, every instance of its `kind`, or a
token for the site) instead of trying values on the page. A style edit's
"Make it real" goes to an agent as intent, as before; a text edit's saves
through the helper and then verifies.

## Proven, and what it changed

Probed on 9 October 2026 in Wanigan's own Electron against made-up fixtures
and the two demo sites; the measurements are in
`docs/research/2026-10-09-design-layer-probes.md`.

- **Freezing a page.** DevTools virtual time does not freeze this Electron
  (animation frames and CSS animations run on, and two of its modes stop the
  page loading). An injected clock, with every animation finished or
  cancelled, gives identical pixels across loads.
- **Full-page capture.** Exact sizes at every width, one device pixel per CSS
  pixel through the debugger, once the hidden window has a page (the first
  Emulation command on an empty one crashes the app). With GPU rendering, a
  capture taller than 16,384 px repeats the page from the top: pages are
  taken in clips of at most 8,192 px. Scrollbars are hidden while capturing,
  and both renders of a comparison come from the same process and mode.
- **Where an edited rule lands.** A rule edited through the protocol keeps
  its place in the cascade (order, specificity, layer, media). An injected
  author sheet ranks before every page sheet; the preview sheet is therefore
  injected at user origin, where its `!important` wins.
- **Sass.** A declaration written by a mixin maps to the mixin's body, not
  its `@include`; Chromium does not fetch maps, so Wanigan reads them.
- **Stylesheet order.** On both demos every sheet is in the head, the
  theme's after core's, and none carries a source map (Drupal's aggregation
  strips them).
