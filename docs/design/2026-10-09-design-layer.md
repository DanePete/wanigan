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
- **Text** patches the traced node's text in place (plain text, typed on the
  one element that holds only those words, `plaintext-only` while it is typed;
  or the field's allowed markup through a schema-checked editor: no
  `contenteditable` free-for-all).
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
| Text, image, alt (one instance) | The field, block or configuration that holds it, through core. Drupal: the Entity API with `validate()` and a new revision, one run of words inside formatted text spliced and checked through its own format, configuration through the Config API with typed validation or its translation's override, an inline block through its layout's section storage. WordPress: the block's own element in the post, template, template part, synced pattern or navigation menu that stores it (one block written alone with `WP_Block_Processor`, formatted words spliced as core splices bound rich text), words bound to post meta in that field, one placement's override in its `core/block`, an image's media-library alt through media REST. Last, words nothing on the page offers, where the content keeps them (the stored-words search): WordPress, the post's stored content (markup, shortcodes' settings and wrapped words, block settings, a block's settings and markup together), excerpt and custom fields (JSON token by token, saved lists as lists) through `wp_update_post()` or `update_metadata_by_mid()`; Drupal, the fields of the shown translation its other saves do not model, through the Entity API; Elementor's tree through its `Document::save()`, ACF's fields, rows, blocks and options through `acf_update_value()` | Deterministic, through the helper, with a base hash and a 409 if the site changed; each target says where it shows, and a Drupal default layout every entity of a bundle shares says its reach and asks first; a stored-words save is read back on the reloaded page and can be undone |
| Token (site-wide colour, font, size, space) | The theme's token: `theme.json` presets (WordPress), the theme's `:root` custom properties or its SCSS variables (Drupal) | Deterministic for `theme.json` and plain CSS custom properties; agent for SCSS maps and Tailwind config |
| Style, every instance of a component | That component's own source: its SDC `.css`, its SCSS partial, or its block stylesheet, found from the matched rule and source maps | Deterministic when the rule and file are plain CSS; agent otherwise |
| Style, one instance | Where core stores one instance's style: WordPress block-support attributes (preset references first); Drupal, a field or component prop that already varies it | Deterministic for block supports; otherwise an agent adds a native hook (a modifier class from a field or a variant prop) and a rule in the component's CSS |
| Template text | On a WordPress block theme, the template or template part, saved as the Site Editor saves it (its first save copies the theme's file into the database); otherwise the theme's Twig or PHP template, and on WordPress a theme pattern's file (Drupal keeps no such thing in the site; a Drupal template's `t()` strings are interface translation, not changed yet) | Deterministic through `/wp/v2/templates` and `/wp/v2/template-parts` for block templates; a diff the owner approves, or an agent, for template and pattern files |
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
percentage, with anti-aliasing forgiveness off for the verdict. The verdict
states one pair of numbers (the largest over both versions and every width),
measured over what is left once the parts the site says change between
renders are masked:

- **Drupal**, from each render's own trace: a part built late (a
  placeholder), never cached, kept for a while (a max-age that is not
  permanent), or made per user, session, query, cookie, header or address.
  Core bubbles max-age and contexts up to every part around, so a reason is a
  part's own only when no part inside it has it, and the innermost part is
  masked, never the article around a "time ago" field.
- **WordPress**, which keeps no cache metadata: the helper marks the root tag
  of the core blocks that differ by type (a gallery in random order, the
  calendar, a relative date, latest comments, RSS, login/out, a Query Loop
  ordered by rand) with `data-wanigan-vary`, through `render_block` and
  `WP_HTML_Tag_Processor`, which changes no layout.

A mask never covers an edited element: its zone is compared in full, and a
masked part around one says so. Each mask is named in the verdict with why.
Where core lets the helper remove the change instead, it does, for
Wanigan's own token requests that carry a verification's hold
(`X-Wanigan-Steady`: a time no later than now and a seed) and no others:
Drupal renders the request at that `REQUEST_TIME` (put back before anything
is kept) and seeds a view's random sort; WordPress measures relative dates to
that time and orders random queries by `RAND(seed)`. Both say what they held,
and Wanigan compares a held change between renders held alike rather than
masking it. Variation nothing declares (a theme calling `rand()`) still
shows only in the floor.

**In this order, stopping at the first failure:**

1. **Styles and boxes, exactly.** A DOM snapshot of both renders: for every
   element an edit touched, the computed values of its properties and its box
   must be equal. This says exactly which property is off.
2. **Pixels.** The two full-page captures, within the calibrated tolerance; a
   difference is boxed and tied to its edit.
3. **The rest of the page.** Outside the edited elements, the result must equal
   the design. The design rendered now is the native page with the layer, so
   a change the native implementation made beyond the touched elements is in
   both renders. So the page as it was is kept just before an edit is made
   real (and when a style or token is handed to an agent), rendered without
   the layer and, in the same load, with that one edit as designed on it; the
   result must also equal that page outside the touched elements. It carries
   the edit's own reflow and reach (text that reflows, a token used
   everywhere), but not everything the save does: saving a title also changes
   the breadcrumb that shows the same stored words, which may wrap and move
   the rest of the page down. So this comparison is element by element: each
   element outside the touched ones is matched by its place in the page's
   structure, and its own words and computed values for the layer's
   properties (not width and height, which are the layout's) are compared
   wherever it now sits. Words that changed only from the edit's old words to
   its new ones are the save's own reach, said in the verdict ("the same
   words also changed in one other place"), never a failure; anything else
   that changed is a difference named by its element. Pixels are compared
   only inside elements that kept their place and size and hold nothing that
   moved. What the page decides for itself is set aside, with everything in
   it, and named among what was masked: an element a script added after the
   page arrived (not in the HTML the server sent, found by lining the page up
   with that HTML child by child, so it does not move its siblings' paths
   either: a marketing form, a chat bubble), and an element the page's two
   renders of the same version did not agree on (present in one only, or with
   other words or values). An element the server sent, that both renders
   agree on and the save changed, still fails. With no page from before (an edit made real elsewhere), or another
   edit made real on the page since, the verdict says this could not run, and
   why.
4. **States and edges.** Hover, focus and active forced on the touched
   elements; each breakpoint and one pixel either side; dark mode and reduced
   motion where the theme answers them; long, short and empty text for text
   edits. Drupal pages are checked with CSS aggregation off and on.

In this design, an edit is `verified` when all four pass everywhere it reaches
(pages sampled from Go to's index when it reaches many). Phase 1 builds less,
and its `verified` means less: steps 1 to 3 passed on the edit's own page at
the widths asked, step 3 against the page from before too where one was kept
(the verdict says when it was not). Step 4 and reach across pages are not
built. The owner then retires it; retired
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

- Content the site says differs between renders (a placeholder, a per-user
  block, a feed, a random order the helper cannot seed) is masked, not
  verified, and named in the verdict. What nothing declares (a theme's own
  `rand()` or `time()`, remote embeds, script-driven content) is not masked:
  it raises the noise floor.
- What a script adds after the page arrives, and whatever the page does not
  agree on with itself between two renders, is set aside, not compared;
  a script that changes the server's own elements in the same way on every
  visit is compared, as the page shows it.
- Step 3 against the page from before runs only where one was kept just
  before the edit was made real, and no other edit has been made real on
  that page since; otherwise the verdict says it did not run.
- A page is compared down to 6,000 px; below that nothing is, and the verdict
  says so (a statement of its own, even on one that passed).
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

**The helpers (version 4, the same bump as removal and the library).** For a
verification's renders only (the view's token and `X-Wanigan-Steady`), they
hold the request still and say what they held, and the WordPress helper marks
the blocks that differ by type ("Calibrated noise", above). Every part a
helper can name carries `identity`:

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
  so `kind` reaches every component of that plugin in a layout. A paragraph
  (a composite) is named as itself, and its identity and its fields' add the
  `revision` the page showed, which neither the key nor `kind` counts. The entity is
  part of it because one UUID can name two stored things: a display's
  default layout is shared by every entity without its own, and an entity's
  own layout starts as a copy of the default, UUIDs and all. A placement and
  a component of one plugin are two kinds, and the library's "where it is
  used" counts both. Where Webform is installed, its adapter names a webform
  `config` `webform` (its id), one of its elements `config`
  `webform_element` (`<webform id>/<element key>`, its element type as
  plugin; a form's own buttons are `actions`, the key Webform gives the
  element that replaces them) and a setting a page shows of it
  `config` `webform_setting`. A menu has no kind beyond itself, as a menu link has
  none, and the same menu shown twice is one identity reached twice, as an
  entity in two view modes is. Content not saved yet, a key that is not a
  UUID or a value that is not plain names nothing.
- WordPress: a post is `entity` `post` (its ID, post type as bundle), a term
  `entity` `term`; `post_title`, `post_content`, `post_excerpt` or a
  registered meta key as `field`. A block in stored markup is `block` (its
  store, path and name). A widget, menu item, template and template part are
  `config`. A theme's PHP template file (header.php, a template part, the page
  template a classic theme's hierarchy chose) is `template`: the theme's
  folder, the file's path in it, and whether that theme is the active one, its
  child or the parent of the active child (the role is not in the key). A
  plugin's or core's file has none. Such a file runs once for each place it is
  loaded, so an edit for one element in it reaches only the places that show
  the words it was made on. WordPress keeps no id for a block, so a block's path is a place:
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
   - Drupal: a text field the helper marks around the words
     (`data-wl-field`, which names the formatter that showed it), saved
     through `helperSave` (`POST /_wanigan/save`) to exactly the content,
     translation and item the target's identity names (its UUID, langcode and
     item, never the default language or the first item holding the same
     words; a target that names no field is refused), only over the version
     the page showed (content saved since and a newer draft are refused,
     saying why). Validation refuses it as Drupal's own form for that one
     field would (a violation of the field or of the content as a whole),
     and besides on any of the workflow's and any the change brings,
     validated before and after the change and compared; a problem the
     content already had in a field the edit does not touch is no reason to
     refuse, and the answer's note says it. Where the page shows the
     item's words with more around them that the field does not hold (a
     template or a preprocess adds it), and the field's mark shows the
     content is as the page rendered it (its revision, and its changed time
     where it carries one), the edit is made on the field's own words: kept
     when what is added stays unchanged around the new words, refused as
     code when the change touches it; without that proof the refusal says
     Wanigan cannot tell, and nothing is said to have changed since unless
     it might have. The site's note on a save is in the answer. A plain
     value is the words; in formatted text one run of words inside one stored
     text node is spliced byte for byte and kept only when rendering the old
     and new text through the item's format differs in those words alone
     (words a filter makes, words across tags or found twice, and a trimmed
     summary's cut are refused). Words that are the field's label, which no
     item holds, go to its configuration. Words in an inline Layout Builder
     block go through its layout: the component that pins the version the
     page showed gets the changed block in `block_serialized` and the section
     storage is saved (an entity's own layout as a new revision); a default
     layout every entity of a bundle shares answers first with how far it
     reaches and a token, and is saved when made real again, the layer
     sending that token back. Words in a paragraph (any composite its host
     pins by revision, known by its type naming its parent fields) are never
     saved in the paragraph: the Paragraphs site adapter walks up to the root
     content, refuses on its state (any newer revision, whose draft keeps its
     own copy of the paragraph; access; the workflow and every violation),
     goes down its default revision to the item pinning the revision the page
     showed (else the page is stale), changes that paragraph, marks it and
     every paragraph above it as needing a save, and saves the root as a new
     revision with its log, user and changed time. A Paragraphs Library item
     asks first with its reach and a token, as a default layout does; an open
     Layout Paragraphs builder holding a copy, an orphan, a composite it
     cannot walk, a translatable paragraphs field, and a paragraph with no
     translation in the page's language are refused. Every answer carries the
     saved content's address after the save and before it, and a save that
     moved the page shown (a new alias) takes the view to the new address
     instead of reloading the old one.
   - Otherwise (WordPress's helper marks no field; it saves fields through
     schema targets, as both helpers save configuration): the one
     `via: 'schema'` edit target of the page's trace whose value, or a string
     property of it, equals the words as the site rendered them (whitespace
     folded, wptexturize's quotes, dashes and ellipsis read as typed): a title,
     an excerpt, a string meta, the site title or tagline, a menu link's text
     (its address sent back as it was), a WordPress block's words, a term's
     name a menu built from the term or an archive's heading shows (saved
     through `wp_update_term()`, and asked first: it shows wherever the term
     does); on Drupal a
     block's title, the site's name or slogan, one run of a view's header,
     footer or empty text (offered run by run, so its markup is never in the
     value), a content menu link's text, or a webform's words through the
     Webform adapter (docs/design/2026-10-10-site-adapters.md): an element's
     title, description, help, placeholder, prefix, suffix, markup or own
     option label through `getElementDecoded()` and `setElementProperties()`
     with every property the element stores kept, read in the form's own
     language; a translation to the language override of `elements`, the
     language named in the answer; a form's setting through `setSetting()`.
     Words only the site's Webform settings keep (the default submit label)
     are saved on this form, which then has its own; the default for every
     form, and shared `webform_options`, are targets that show beyond the
     page, and the helper answers their first save with how many forms they
     reach and a token, which the schema save sends back once the window or
     the layer has asked. Words a token or a computed element makes, and
     untranslated words, are refused with why; the form's own permissions are
     checked, and Webform's entity saves it, as Webform's own forms do. A
     field mark around a part named as configuration (a webform a reference
     field shows) is the content's, so its words are looked for here. Other
     configuration is validated against its typed schema with the rules only
     Drupal's forms keep, needs the form route's permission, is written to its translation's override when the
     page showed one, and says that the next configuration import puts back
     what is exported.
     Never a slug, a status, a choice, an address or a read-only value. It is
     looked for in the parts the edit's identity names, then outward a level
     at a time, the nearest level deciding: each part's parent, and the post
     a block shows through its block context (`context.postId`), so a
     post-title block finds its post's title whether it sits inside the post
     or beside it in the template. It is saved through the window's own
     schema save (`POST /_wanigan/edit/<id>` with the trace's id, checked
     with `checkValue` in main and again by the helper), refused if the view
     holds another trace by then.
   - A string its schema calls HTML (`contentMediaType: 'text/html'`: a
     WordPress block's rich text, a field a block binds as rich text, a
     navigation label) is sent as HTML, never as typed text
     (`src/shared/rich-text.ts`). Words alone (no tag inside): the new words
     escaped as the helper's own save writes text (`WP_HTML_Processor`
     serialization: `&`, `<`, `>`, `"` and `'` as `&amp;`, `&lt;`, `&gt;`,
     `&quot;` and `&apos;`), so what is sent is what the site keeps. Words
     between tags: the one stretch where old and new words differ (compared
     as words) must fall inside one run of text between two tags, at both
     ends of the slide repeated letters allow; it is written there escaped,
     every tag and every other run kept byte for byte, the new words taking
     the formatting of the words they replace.
   - A target the helper says shows beyond this page (its `shows`: a
     template or template part, a synced pattern's own words, a navigation
     menu, a widget, a site setting, a media library alt) is said first,
     with where (`route: 'none'`, nothing saved or rendered), and saved when
     the edit is made real again within five minutes for the same target,
     reach and words. The edit sheet asks the same way (`editNotice()`).
   - On WordPress a change across formatting (or words added right beside a
     tag, which could go inside it or outside), words inside a classic
     post's content, and a block setting whose schema says neither HTML nor
     text answer `route: 'agent'`, saying which (and where they show, when
     beyond this page), as styles and tokens do until phase 3. Every refusal
     names its cause: Drupal keeps no such thing (words written in a
     template, which answer `route: 'agent'`; a menu link written in code; a
     base field's label), or Wanigan does not do it yet (a template's `t()`
     strings, which are interface translation; a caption; words across
     formatting; a draft; words code makes from what is not saved here). The
     Drupal helper lists each template part's own words, read by Drupal's
     Twig lexer, for this, and the WordPress helper each PHP template file's,
     read with PHP's tokenizer (never run; bounded, a file not read saying
     why): the runs of words typed into its HTML, cut wherever its PHP runs,
     and the literal first argument of the gettext functions, by text domain,
     each with its line. On WordPress a theme template's words and strings
     answer `route: 'agent'` with the file, the line and a string's text
     domain (a translation file is the way without code; a parent theme's file
     under an active child is changed as a copy at the same path in the child
     theme); a plugin's or core's template says whose it is; words in no
     template are said by what made their part (a plugin or the theme's own
     code, named from its file; the template's PHP, never guessed at; a
     template not read).
     An element no part with an identity names is looked up the same way from
     the trace's parts around it (the page script's `layerOf` lists them), on
     both platforms, and only an element outside every traced part is said to
     be unknown. A brief to an agent carries the answer's why. Nothing holding the words, more than one thing
     holding them (named), a changed page, a target the trace says this user
     may not change, or a refusal from the site (passed on as the site said
     it) answers `route: 'none'`, with why.
   - Last, words nothing the page offers to edit holds (on WordPress also
     words in a post's content no target offers, not formatted text a target
     holds; on Drupal words no template writes, and first for a marked field of
     a type its word saves do not model) are looked for where the content the
     edit's part belongs to keeps them: the helpers' `POST /_wanigan/words`
     (`find` reads only; `save` re-finds the place and writes only there, over
     the hash `find` took, 409 otherwise), contract in
     `src/shared/live-stored-words.ts`. Both helpers share one matcher: words
     compared as the page shows them (wptexturize's typography read as typed,
     references read, whitespace folded), whole words, found exactly once as
     text (a string value, a text node, a quoted attribute that is not an
     address, class, id, style or script); JSON read token by token and
     written back with that token's flags; a serialized list walked and
     written back only when it round-trips byte for byte. WordPress searches
     the post's stored content (markup, registered shortcodes' settings and
     wrapped words, block settings, a block's settings and markup holding the
     same words changed together as `serialize_block_attributes()` writes
     them, JSON content as JSON), its excerpt and every custom field by
     `meta_id`; it saves with `wp_update_post()` (a revision) only when core's
     filters on saving content would store exactly those bytes, or
     `update_metadata_by_mid()` slashed deeply with `clean_post_cache()` after,
     as a user with `edit_post` and no live lock, new words through kses as
     plain text. Drupal searches the shown translation's default revision,
     every field its word saves do not model and that can hold words (string
     and map properties, never references, choices, addresses, machine names
     or a contributed module's own structures), and saves through the Entity
     API with the other word saves' gates, as a new revision; a paragraph is
     refused until its save goes through the page that holds it. Adapters for
     plugins that keep words their own way register with the WordPress search,
     each in its own class, used only when the plugin is active, never needed
     by the core path: Elementor, a site adapter on the shared base
     (docs/design/2026-10-10-site-adapters.md: what it calls is declared and
     checked, a missing call refuses by name, a version past the verified
     range saves and says so) (its elements tree, `Document::save()`, its
     caches and revisions; a template the page shows found through its
     `data-elementor-id` marks and asked first), ACF (fields, sub-field rows,
     blocks and options through `acf_update_value()` after
     `acf_validate_value()`; an option asked first), and known copies and
     builders' own data that are never saved (Beaver Builder's and
     SiteOrigin's layouts refused with whose they are, their content copies,
     Bricks', Breakdance's and Elementor's data, Pagelayer's copy, an SEO
     plugin's mirror). Found once, the page as it is is kept, the words saved,
     the edit marked implemented on the site's ok, and the page reloaded and
     read back; the answer says where the words are kept and through whose
     save, whether the site keeps a revision, what a plugin's own copy may do,
     and when the page still shows the old words says so first. Undo puts
     the old value back by the token the site gave (ten minutes); the edit
     stays implemented. Refusals name their cause: nowhere ("the site does not
     keep these words in this content: code or another content item makes
     them"), more than once (named), only in code, made from a template
     (`%%title%%`, `{{post_title}}`, `[node:title]`), kept in the site's
     settings (an option, not changed from here yet), or changed since. Still
     not saved: words a plugin computes and never stores, a builder's own
     cache (said, not cleared, outside the adapters), words in another
     content item than the one the trace names, and options outside ACF's.
   - Just before words are saved, and when a style, a token or formatted
     words are handed to an agent (once: asking again never keeps a page
     that may already have the agent's change), the page the edit is on is
     rendered at the verification widths through the same hidden render as a
     verification, without the layer and then, in the same load on the same
     stopped clock, with that one edit as designed on it, held at one time
     and seed. Both pictures, the touched elements, the masks, the hold and
     the edits already in the site are kept under the edit's folder
     (`live-layer/<project>/<edit>/before/`). A render that fails is kept as
     why, and the edit is made real all the same.
4. `layerVerify(id)` renders the page with the layer (the design) and without
   it (the result) in hidden windows in the view's session at each width,
   every render sent one hold (the newest page from before's, or now's),
   measures the noise floor by rendering each version twice (every width is
   judged against the one floor the verdict states, the largest over both
   versions and every width, over what the masks leave), then runs the
   steps in order: computed styles and boxes of the touched elements (a token:
   its custom property as the root computes it, in both renders), pixels
   around them, then the rest of the page, against the design and against
   each edit's page from before with that edit designed on it, the latter
   element by element (the page script's `layerPage` reads each element's
   path from `<body>`, own words and computed values, in both) and in pixels
   only where the layout kept still. Nothing passes
   for want of a comparison: an edit found but gone when the page was
   measured, a token whose value was not read, or an edit for a named
   breakpoint (phase 1 reads no breakpoints, so the design cannot show it)
   fails, saying so. Every step that waits on a hidden page has a deadline,
   and so does each render: a page that never answers fails the
   verification, its window is closed, and the next one runs. It keeps the
   pictures in the data folder and tells the core (`verified`, or still
   `implemented` with the verdict, which says what differs: the words are in
   the site either way). Besides its differences, the verdict says (each
   optional, so a verdict kept before them still reads): what was masked and
   why (`masked`), where else the saved words changed (`reach`), whether step 3 compared the page from before or why not
   (`before`), whether every render was held still (`held`), and how far
   down a page taller than 6,000 px was compared (`cut`, a statement, never
   a difference). `verified` here is phase 1's: steps 1 to 3 passed on this
   page at these widths, step 3 against the page before where one was kept;
   step 4 and other pages are not checked.

**The window** shows a tray of the project's edits (before and after, the
page each is on, its state and verdict, fragile ones said so) and per-edit
discard, undo and redo. Edits are made where they show, as a site builder
makes them. "Retype the words" (E on a part that is only words, or a
double-click on the chosen part's words in the page) makes that element
editable where it is, through the page script (`LiveBridge.layerType`): plain
text, the caret at its end, every keystroke the page itself. It is keyed
first (`layerTarget()`), so the edit names the words the site rendered. Enter
or clicking away keeps the words as a text edit (`live.layerAdd`, scope
`this`), which the layer goes on showing without a flicker; Escape puts back
exactly what was there, its text nodes and the helper's part marks; a
navigation ends it as cancelled. Meanwhile the status line says it is typing,
with Keep and Put back, the live view's keys stay off the page, and links
around the words do not act. "Retype in a box" makes the same edit from the
side panel, for the keyboard and screen readers. The style panel shows each
value on the page as its control moves, as one preview the page script owns
(`LiveBridge.layerTry`) on the element or every one of its kind, through a
sheet that outranks the layer's own rules, and keeps it as a layer edit with
a scope (`this`, every instance of its `kind`, or a token for the site) on
Show it on the page. A style edit's "Make it real" goes to an agent as
intent, as before; a text edit's saves through the helper and then verifies.

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
