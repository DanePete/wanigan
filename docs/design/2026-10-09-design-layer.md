# The design layer: edit live, implement natively, prove it pixel for pixel

Status: draft, 9 October 2026. Research behind it: `reports/Real time visual
editors.md` and `reports/Design layer and native fidelity.md` (local, not in git).

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
| `change` | `text` (new value), `image` (new asset, alt), `style` (property → value or token), `token` (name → value) |
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
- configuration: block id, menu link id, template part slug;
- fallback, for markup no helper explains: a CSS selector path plus a hash of
  the element's text, and the edit is marked `fragile`.

After every load the page script resolves each edit's identity to elements and
tags them with a dev-only attribute (`data-wl-edit`). The layer's CSS uses only
those attributes, so nothing it does can reach an element it was not meant for.
An edit whose identity no longer resolves becomes `orphaned`, is listed, and is
never applied to whatever now sits in its place.

### How it renders

- **Styles** compile to one stylesheet injected into the live view after the
  theme's own, scoped by `data-wl-edit` and by media queries for breakpoints.
  Each change repaints at once, without a reload.
- **Text** patches the traced node's text in place (plain text, or the field's
  allowed markup through a schema-checked editor: no `contenteditable` free-for-all).
- **Images** swap the `src`/`srcset` of the traced image to a local preview of
  the new file, keeping its box, so layout changes show honestly.
- **Tokens** override the theme's custom property (`--color-accent`,
  `--wp--preset--color--accent`) on `:root`, so every use repaints together.

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
| Text, image, alt (one instance) | The field or block that holds it, through core (Drupal Entity API with `validate()`, a new revision; WordPress posts and media REST) | Deterministic, through the helper, with a base hash and a 409 if the site changed |
| Token (site-wide colour, font, size, space) | The theme's token: `theme.json` presets (WordPress), the theme's `:root` custom properties or its SCSS variables (Drupal) | Deterministic for `theme.json` and plain CSS custom properties; agent for SCSS maps and Tailwind config |
| Style, every instance of a component | That component's own source: its SDC `.css`, its SCSS partial, or its block stylesheet, found from the matched rule and source maps | Deterministic when the rule and file are plain CSS; agent otherwise |
| Style, one instance | Where core stores one instance's style: WordPress block-support attributes (preset references first); Drupal, a field or component prop that already varies it | Deterministic for block supports; otherwise an agent adds a native hook (a modifier class from a field or a variant prop) and a rule in the component's CSS |
| Template text | The theme's Twig or PHP template | A diff the owner approves, or an agent |

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

For each implemented edit, at each breakpoint and on each page in its reach
(sampled from Go to's index when it is many):

1. **Computed styles first.** On the edited elements, the computed values
   without the layer must equal those with it. This is exact, cheap, and says
   precisely which property is off.
2. **Then pixels.** Two renders of the same URL in a hidden window: the
   implemented page with the layer (the design) and without it (the native
   result). Same viewport, device pixel ratio, fonts loaded, animations off,
   lazy images loaded, dynamic regions masked as Compare already does. A
   difference beyond rendering noise is a failure, boxed and attached to its edit.
3. **Then the rest of the page.** Outside the edited elements, the native page
   must equal the page as it was before the edits, so an implementation that
   changed something else is caught.

An edit is `verified` when all three pass everywhere it reaches. The owner then
retires it from the layer; the site now carries it natively.

## What this does not promise

- Content that differs between renders (dates, random order, personalisation)
  is masked, not verified.
- A text format may change saved markup (Drupal filters, WordPress kses). The
  verify step shows the difference; it does not hide it.
- Interaction states (hover, focus) and other content lengths are verified only
  where the edit names them.

## Phases

1. **Layer and content.** Identity, the edit log, live injection, the tray,
   scopes; text and images implemented through core and verified.
2. **Styles, deterministic.** Tokens in `theme.json` and plain custom
   properties; WordPress block supports; Drupal component CSS in plain files;
   the computed-style and pixel verification loop.
3. **Sources and agents.** Source maps to SCSS and PostCSS, Tailwind, the theme
   build, the agent brief and its `live_verify` tool.
4. **Themes and reach.** Creating a subtheme or child theme; reach checks
   across many pages.

## Open questions

Answered by the research in progress (pixel verification, mapping styles to
source, how design-to-code tools measure fidelity):

- What tolerance separates rendering noise from a real difference in Electron's
  Chromium, and does capture need software rendering to be repeatable?
- How often do real Drupal and WordPress themes ship CSS source maps in
  development, and what is the fallback when they do not?
- Which hand-over (structured spec or screenshot) makes an agent's
  implementation match first time most often?
