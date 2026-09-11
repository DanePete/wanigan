'use strict';

/*
 * Renderer style gate. Runs in `npm test` between typecheck and the package
 * hooks, and reads source only — it never renders the app.
 *
 * Eight checks, each a ratchet against a baseline written into this file:
 *   1. inline `style={{` objects per renderer .tsx, keyed by path,
 *   2. `<style` tags in any renderer .tsx,
 *   3. literal px font sizes in styles/*.css (index.css owns the type scale and
 *      is the one sheet allowed to spell a size in px),
 *   4. literal transition/animation durations anywhere but styles/motion.css,
 *      which owns --mo-state / --mo-view,
 *   5. declarations in a sheet index.css @imports that a rule in index.css
 *      overrides at the same or higher specificity, per sheet,
 *   6. <input>/<select>/<textarea> in a renderer .tsx that reach a screen
 *      reader with no name at all,
 *   7. hook calls below an early return in a renderer component, which make a
 *      render that has data run more hooks than one that does not,
 *   8. the native `title` attribute used as a tooltip on an intrinsic element,
 *      which is unreachable by keyboard and invisible to a finger.
 *
 * A baseline entry is a debt, not a permit. It records what the tree carried
 * the day the gate landed so the gate could pass that day; the only allowed
 * edit is downward. A file that is not listed is allowed zero. Run with
 * --print-baseline to see the current counts in the shape used below, and
 * paste them in once a sweep has lowered them.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer', 'src');

// 1. Inline style objects per renderer .tsx, keyed by path under
//    src/renderer/src. This counted views/ only until now, and the two other
//    renderer directories carried 199 inline objects nobody was measuring —
//    NewSessionDialog.tsx alone more than eleven of the fifteen views. Worse
//    than the unmeasured debt: the ratchet ran one way inside views/, so
//    lifting a block of Settings.tsx into a new components/ file read as a
//    large paydown while the objects were still there. The debt could be
//    moved rather than paid. Keying by path, not basename, also keeps two
//    files that share a name apart.
//    The views/ numbers below are the debts recorded when the gate landed; the
//    components/ and App.tsx numbers are what those files carried the day they
//    came under the gate. Both only ever go down.
const INLINE_STYLE_BASELINE = {
  'App.tsx': 10,
  'components/announce.tsx': 0,
  'components/AttentionQueue.tsx': 1,
  'components/bits.tsx': 2,
  'components/CodePanel.tsx': 46,
  'components/Composer.tsx': 0,
  'components/ErrorBoundary.tsx': 7,
  'components/NewSessionDialog.tsx': 79,
  'components/Pet.tsx': 8,
  'components/ReviewGate.tsx': 0,
  'components/SessionLearning.tsx': 5,
  'components/ShortcutSheet.tsx': 0,
  'components/TeamPanel.tsx': 0,
  'components/TerminalPane.tsx': 1,
  'components/ThemeControl.tsx': 0,
  'components/Timeline.tsx': 8,
  'main.tsx': 0,
  'views/Batches.tsx': 177,
  'views/Context.tsx': 44,
  'views/Control.tsx': 0,
  'views/Fleet.tsx': 29,
  'views/Git.tsx': 32,
  'views/HeadlessRuns.tsx': 0,
  'views/ImprovementScout.tsx': 0,
  'views/Insights.tsx': 62,
  'views/Learning.tsx': 9,
  'views/Plugins.tsx': 0,
  'views/Schedules.tsx': 0,
  'views/Sessions.tsx': 125,
  'views/Settings.tsx': 269,
  'views/Skills.tsx': 21,
  'views/Usage.tsx': 45,
};

// 2. Renderer files still carrying a stylesheet as a template string. Empty,
//    and it stays empty: Batches, Insights, Settings and Skills each shipped a
//    sheet inside a <style> element until it moved into styles/. A sheet inside
//    a component is a sheet nobody greps for, cannot be shared with a sibling
//    surface, and re-parses on every mount of the view.
const STYLE_TAG_BASELINE = new Set([]);

// 3. Literal px font sizes per sheet (font-size: Npx and the font: shorthand).
//    Two sheets due to be renamed are listed under both names so the rename
//    lands without a false failure; delete the old name when it does.
//    settings.css, insights.css and batches.css exist now — the sheets that
//    used to live inside those views — and carry the literals that came with
//    them. Tokenising those is the step after the move; each number here only
//    ever goes down.
const FONT_PX_BASELINE = {
  'attention.css': 11,
  'batches.css': 0,
  'control.css': 0,
  'insights.css': 17,
  'fleet.css': 15,
  'git.css': 13,
  'pet.css': 10,
  'policy.css': 0, 'context.css': 16,
  'queue.css': 0, 'plugins.css': 15,
  'schedule.css': 0,
  'session-learning.css': 0,
  'settings.css': 27,
  'sessions.css': 2,
  'timeline.css': 25,
};

// 4. Declarations with a literal duration, per file, relative to src/renderer/src.
//    Empty, and it stays empty. Every literal duration in the renderer is now
//    a --mo-state / --mo-view token, so Settings > Motion = off and the OS
//    reduced-motion preference reach all of them; a sheet that spells its own
//    140ms or .12s silently opts that one element out of both, which is how a
//    session rail kept sliding beside a live terminal after the operator asked
//    it to stop. motion.css is the one file exempt, because it owns the tokens.
const DURATION_BASELINE = {};

// 5. Declarations in a sheet index.css @imports that a rule in index.css
//    overrides at the same or higher specificity, per sheet basename.
//
//    The cascade here is read, not assumed. src/renderer/src/main.tsx loads
//    ./index.css and then ./styles/compact.css; index.css opens with fifteen
//    @import statements — xterm plus the fourteen local sheets below — and its
//    own first rule begins after the last of them. @import is required to
//    precede every other rule in a sheet, so a sheet index.css imports can
//    never sit below index.css's own declarations, and at equal specificity
//    index.css wins. A private modifier written in a feature sheet therefore
//    loses to the base class it was written to modify, and loses silently.
//    This repository has been bitten by that shape three times: .control-view's
//    `display` and `gap` were dead from the day they were written; .btn-small
//    in control.css and .skills-btn-sm in evals.css promised nine buttons a
//    smaller size they never got; and .control-view's and .set-hero's
//    media-query padding each lost to compact.css. Only the first two are the
//    case this check scores — compact.css loads after index.css, so it wins
//    rather than loses, and its half of the family is out of scope below. All
//    three were found by a person reading CSS, which is not a strategy.
//
//    What the check compares: a top-level rule in an imported sheet whose
//    selector is nothing but class tokens, against a top-level rule of the
//    same shape in index.css, when the sheet's selector carries no more
//    classes than index.css's (so `.pane.gt-view` over `.pane` is left alone —
//    it genuinely wins) and some className in a .tsx puts every class of both
//    selectors on one element. One count per distinct (sheet selector,
//    index.css selector, property). A declaration marked !important is not
//    counted, because it beats a later rule that is not.
//
//    What it cannot see, so a pass here is not proof:
//      - anything inside @media, @supports, @container or @layer, on either
//        side. Two of the three bugs above were media-query paddings; deciding
//        whether one condition shadows another means comparing the conditions,
//        which a regex reader cannot do honestly.
//      - selectors carrying a combinator, element, id, attribute or
//        pseudo-class, :has()/:is()/:where() included. index.css uses :has();
//        a rule of that shape is skipped rather than mis-scored.
//      - shorthand against longhand: `padding` in a sheet and `padding-inline`
//        in index.css read as two unrelated properties.
//      - class names a component assembles at runtime. The combo reader strips
//        ${...} out of a template literal, which under-counts — the safe
//        direction for a gate.
//      - the ten sheets a view imports from its own .tsx instead of from
//        index.css — batches, improvement-scout, insights, learning, observed,
//        runs, session-learning, sessions, settings and usage. Where those land
//        relative to index.css is decided by the bundler's module graph, not by
//        a rule of CSS, so they are reviewed by hand and not gated here.
//        compact.css is excluded for the opposite reason: main.tsx loads it
//        after index.css, so it wins.
//
//    Run with --print-shadowed for the selector, property and line behind every
//    count below. None of these is a permitted exception — each one is a
//    declaration that does nothing today, so every number here should fall.
//
//    Every number has now fallen. The sixteen this check found when it landed
//    were each read against the base rule and answered one of two ways:
//      - the value differed from the base, so someone wanted something they
//        never got, and the selector was made compound to give it to them.
//        .field.field-inline, .field.tl-search, .field.skills-search,
//        .field.gt-filter and .field.control-textarea are those; each carries a
//        comment saying the second class is required, because a compound
//        selector reads as redundant to anyone who has not traced the cascade.
//      - the value equalled the base, or the frame owns the decision, so the
//        declaration was deleted: .fleet-prov's padding and .pg-ver's font
//        family were copies of .pill and .mono, and .pg-head's and .sc-head's
//        `align-items: baseline` would have had to beat compact.css's 720px
//        .pane-head step to apply, which would have left two heads alone in
//        ignoring it.
//    Raising specificity is not free: two classes beat a one-class rule inside
//    a @media block as well, so a compound modifier silently opts its element
//    out of compact.css's breakpoint ladder and its (pointer: coarse) touch
//    targets. .gt-filter's min-height was dropped for exactly that reason.
//    A zero here is not a permit to add a sixteenth; it is the floor.
//
//    runs.css was swept by hand in the same pass, and this check scores none of
//    it: HeadlessRuns.tsx imports that sheet, so it is one of the ten in the
//    blind-spot list above. Read against index.css and compact.css it held six
//    shadowed declarations in two selectors — three times what this check would
//    have reported had runs.css been in its scope, because four of the six sit
//    inside @media, which it does not read.
//      - .hr-stats lost grid-template-columns twice: to .stat-grid's four
//        columns at full width, and to compact.css's two-column .stat-grid at
//        720px. Both rules now read .stat-grid.hr-stats, so three stats get
//        three columns and the row no longer paints an empty fourth cell.
//      - .hr-view lost four: a gap in its base rule and another at 720px, and a
//        padding at 980 and at 720. All four were deleted. .hr-view is a .pane,
//        and .pane plus compact.css's two .pane steps were already painting the
//        surface — in the padding cases with byte-identical values.
//    Six is a reading of one sheet on one day, not a number this check keeps.
//    Nothing here re-reads runs.css, or the other nine sheets a view imports
//    for itself, when one of them grows a new modifier tomorrow.
const SHADOWED_MODIFIER_BASELINE = {
  'attention.css': 0,
  'composer.css': 0,
  'control.css': 0,
  // New sheets start at zero and stay there: the baseline records debt that
  // existed the day the gate landed, and board.css was written after it.
  'board.css': 0,
  'fleet.css': 0,
  'git.css': 0,
  'motion.css': 0,
  'pet.css': 0,
  'policy.css': 0,
  'queue.css': 0,
  'schedule.css': 0,
  'shell.css': 0,
  'timeline.css': 0,
  'ui.css': 0,
};

// 6. A form control with no accessible name. A sighted operator reads the
//    <span className="label"> sitting above the box; a screen reader gets
//    nothing, because that span is not a <label> and carries no `for`. The
//    sweep that seeded this baseline found 55 across ten files — every field in
//    the Schedules editor, the commit message box, the batch configuration
//    form, the repository picker in Git — and a pass over the built renderer in
//    Chromium confirmed ten of them present on screen, the rest sitting behind
//    a tab or a conditional the sweep did not open.
//
//    A control counts as named by `aria-label`, by `aria-labelledby`, by an
//    `id` a <label for> can point at, or by sitting inside a <label>. Checkbox
//    and radio inputs are exempt: this codebase writes those inside their
//    <label>, and the wrapping test below already clears them.
//
//    Everything is at zero, so this one is not a debt list — it is the shape
//    the tree is in. A file added to it is a file that regressed.
const NO_ACCESSIBLE_NAME_BASELINE = {};

// 8. Native title tooltips, per renderer .tsx. These are the counts the tree
//    carried the day the check landed, and like every baseline here they are a
//    debt rather than a permit: a file may only ever go down, and a file not
//    listed is allowed zero. Replacing one means putting its sentence on the
//    screen — a Note, a cue, a line under the control — not moving it to
//    aria-label, which leaves a sighted keyboard user with nothing.
const TITLE_TOOLTIP_BASELINE = {
  "App.tsx": 8,
  "components/AttentionQueue.tsx": 1,
  "components/CodePanel.tsx": 10,
  "components/Composer.tsx": 9,
  "components/NewSessionDialog.tsx": 1,
  "components/ObservedBand.tsx": 2,
  "components/Pet.tsx": 8,
  "components/PlanEditor.tsx": 6,
  "components/SessionLearning.tsx": 11,
  "components/SpaceNavigation.tsx": 2,
  "components/ThemeControl.tsx": 1,
  "components/Timeline.tsx": 2,
  "components/bits.tsx": 8,
  "views/Batches.tsx": 4,
  "views/Context.tsx": 4,
  "views/Control.tsx": 3,
  "views/Fleet.tsx": 7,
  "views/Git.tsx": 14,
  "views/Insights.tsx": 14,
  "views/Learning.tsx": 4,
  "views/Plugins.tsx": 0,
  "views/Sessions.tsx": 9,
  "views/Settings.tsx": 5,
  "views/Skills.tsx": 1,
  "views/Usage.tsx": 4,
};

const INLINE_STYLE = /style=\{\{/g;
const STYLE_TAG = /<style[\s>]/;
const FONT_PX = /\bfont(?:-size)?:\s*[^;{}]*?(?<![\w.-])[0-9]*\.?[0-9]+px\b/g;
// One match per declaration that carries a literal duration, so
// "transition: a .12s, b .12s" counts once and the fix is one edit.
const DURATION = /\b(?:transition|animation)[\w-]*:[^;{}]*?[\s,(]([0-9]*\.?[0-9]+)m?s(?![\w-])/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const count = (text, re) => (text.match(re) || []).length;
const rel = (file) => path.relative(RENDERER, file).split(path.sep).join('/');

// --- check 5: modifiers an imported sheet declares and index.css overrides ---

// A selector made of class tokens and nothing else. Its specificity is
// (0, n, 0), so the count of tokens is the whole comparison; anything with a
// combinator, element, id, attribute or pseudo-class fails this and is skipped
// rather than scored wrongly.
const CLASS_ONLY_SELECTOR = /^(?:\.[a-z][a-z0-9-]*)+$/;
const CLASS_TOKEN = /\.[a-z][a-z0-9-]*/g;
const RENDERED_CLASS = /^[a-z][a-z0-9-]*$/;
// className="a b", className={`a ${x}`}, className={'a b'}, className={"a b"}.
const CLASS_NAME_ATTR = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\}|\{"([^"]*)"\})/g;
const AT_RULE_BLOCK = /@(?:media|supports|container|layer|scope|keyframes|font-face|property)\b/g;

// Everything a conditioned or nested context puts out of reach, removed before
// the rule reader runs. The @import/@charset/@namespace statements go first:
// leave them in and the reader treats the first real rule of every sheet as
// part of an at-rule and drops it, which is how index.css's opening block went
// missing from the hand analysis that preceded this check.
function topLevelCss(source) {
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const noStatements = noComments.replace(/@(?:import|charset|namespace)\b[^;]*;/g, '');
  let out = '';
  let i = 0;
  while (i < noStatements.length) {
    AT_RULE_BLOCK.lastIndex = i;
    const at = AT_RULE_BLOCK.exec(noStatements);
    if (!at) { out += noStatements.slice(i); break; }
    out += noStatements.slice(i, at.index);
    let j = noStatements.indexOf('{', at.index);
    if (j < 0) break;
    let depth = 0;
    for (; j < noStatements.length; j++) {
      if (noStatements[j] === '{') depth++;
      else if (noStatements[j] === '}' && --depth === 0) { j++; break; }
    }
    i = j;
  }
  return out;
}

// One entry per class-only selector in a comma list, carrying the property
// names it declares. A comma list is n rules that happen to share a body, so
// splitting it loses nothing.
function classRules(source) {
  const rules = [];
  const RULE = /([^{}@;]+)\{([^{}]*)\}/g;
  let m;
  while ((m = RULE.exec(topLevelCss(source)))) {
    const props = [];
    for (const decl of m[2].split(';')) {
      const colon = decl.indexOf(':');
      if (colon < 0) continue;
      const prop = decl.slice(0, colon).trim().toLowerCase();
      if (!/^[a-z-]+$/.test(prop)) continue;
      props.push({ prop, important: /!\s*important/i.test(decl) });
    }
    if (!props.length) continue;
    for (const part of m[1].split(',')) {
      const sel = part.trim();
      if (!CLASS_ONLY_SELECTOR.test(sel)) continue;
      rules.push({ sel, classes: sel.match(CLASS_TOKEN).map((c) => c.slice(1)), props });
    }
  }
  return rules;
}

// Every set of two or more class names a .tsx puts on one element. Runtime
// interpolations are removed, so a class assembled from a variable is invisible
// here and its rule is never flagged.
function renderedCombos(tsxFiles, read) {
  const combos = [];
  for (const file of tsxFiles) {
    let m;
    CLASS_NAME_ATTR.lastIndex = 0;
    const src = read(file);
    while ((m = CLASS_NAME_ATTR.exec(src))) {
      const text = (m[1] ?? m[2] ?? m[3] ?? m[4]).replace(/\$\{[^}]*\}/g, ' ');
      const tokens = text.split(/\s+/).filter((t) => RENDERED_CLASS.test(t));
      if (tokens.length >= 2) combos.push(new Set(tokens));
    }
  }
  return combos;
}

function firstLineOf(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|[\\s,}])(${escaped})\\s*[,{]`, 'm').exec(source);
  if (!m) return 0;
  return source.slice(0, m.index + m[1].length).split('\n').length;
}

// The sheets index.css @imports, in the order it imports them. Only these are
// provably below index.css's own rules; nothing else is scored.
function importedSheets(indexSource) {
  return [...indexSource.replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/@import\s+['"]\.\/styles\/([a-z0-9-]+\.css)['"]/g)].map((m) => m[1]);
}

function shadowedModifiers(read, tsxFiles) {
  const indexSource = read(path.join(RENDERER, 'index.css'));
  const sheets = importedSheets(indexSource);
  const base = classRules(indexSource);
  const combos = renderedCombos(tsxFiles, read);
  const coRendered = (union) =>
    union.length <= 1 || combos.some((c) => union.every((cls) => c.has(cls)));

  const counts = {};
  const findings = [];
  for (const sheet of sheets) {
    const file = path.join(RENDERER, 'styles', sheet);
    counts[sheet] = 0;
    if (!fs.existsSync(file)) continue;
    const source = read(file);
    const seen = new Set();
    for (const rule of classRules(source)) {
      for (const winner of base) {
        // A sheet selector with more classes outranks index.css and is fine.
        if (rule.classes.length > winner.classes.length) continue;
        if (!coRendered([...new Set([...rule.classes, ...winner.classes])])) continue;
        for (const { prop, important } of rule.props) {
          if (important) continue;
          if (!winner.props.some((p) => p.prop === prop)) continue;
          const key = `${rule.sel}|${winner.sel}|${prop}`;
          if (seen.has(key)) continue;
          seen.add(key);
          counts[sheet] += 1;
          findings.push({ sheet, line: firstLineOf(source, rule.sel), sel: rule.sel, prop, winner: winner.sel });
        }
      }
    }
  }
  return { sheets, counts, findings };
}

/**
 * Controls in one file that reach a screen reader with no name.
 *
 * Attribute text cannot be matched with one regex here: every other attribute
 * may hold a JSX expression, and `onChange={(e) => ...}` puts a `>` inside the
 * tag. The scan walks forward from the tag name tracking brace depth and quotes
 * so the tag ends at the `>` that actually closes it — a plain
 * /<input[^>]*>/ stops at the arrow and reports a labelled control as bare.
 *
 * Comments are stripped first: Usage.tsx explains a <select> bug in prose, and
 * a check that reads the explanation as the defect teaches people to write
 * fewer explanations.
 */
// 8. Native title tooltips on intrinsic elements.
//
//    This repository already argued the case, in five separate comments:
//    bits.tsx says "a title is invisible to a finger", NewSessionDialog.tsx
//    that "a tooltip is unreachable by keyboard and touch", Settings.tsx that
//    there is "No `title` escape hatch". It then carried 145 of them across 25
//    files, bits.tsx itself holding eight — and a title added to the disabled
//    Start button of the first-run checklist, which is the one control a new
//    operator meets, went in without anything objecting.
//
//    Only intrinsic elements count: a lowercase tag is HTML, where `title`
//    renders a hover tooltip. `<EmptyState title=...>` is a component prop and
//    is not a tooltip at all. On the elements below the attribute is the
//    accessible name for embedded content rather than a tooltip, so they are
//    exempt for the same reason the HTML spec gives them one.
const TITLE_IS_A_NAME = new Set(['embed', 'frame', 'iframe', 'math', 'object']);
const OPEN_TAG = /<([a-zA-Z][\w.]*)((?:[^>"']|"[^"]*"|'[^']*')*?)>/g;
const TITLE_ATTR = /(?<![\w-])title\s*=/;

function titleTooltips(src) {
  let n = 0;
  for (const m of src.matchAll(OPEN_TAG)) {
    const [, tag, attrs] = m;
    if (tag[0] !== tag[0].toLowerCase()) continue;   // a component, not an element
    if (TITLE_IS_A_NAME.has(tag)) continue;
    if (TITLE_ATTR.test(attrs)) n += 1;
  }
  return n;
}

function unnamedControls(src) {
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const open = /<(input|select|textarea)(?=[\s/>])/g;
  const out = [];
  for (let m = open.exec(bare); m; m = open.exec(bare)) {
    let depth = 0, quote = null, end = bare.length;
    for (let i = m.index; i < bare.length; i++) {
      const c = bare[i];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) { end = i + 1; break; }
    }
    const attrs = bare.slice(m.index, end);
    if (/aria-label(?:ledby)?[=\s]/.test(attrs)) continue;
    if (/type=(["'])(?:checkbox|radio|hidden)\1/.test(attrs)) continue;
    if (/\sid=/.test(attrs)) continue;
    // Inside a <label>? Compare the nearest opener with the nearest closer
    // rather than counting every tag in the file: a running total carries any
    // imbalance above it — a `<label` inside a string, a stray tag — forward
    // over every later control in that file and silently stops reporting them.
    const before = bare.slice(0, m.index);
    if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue;
    out.push(m.index);
  }
  return out.length;
}

// 7. Hook calls a component reaches only on some renders.
//
//    React matches hooks by call order, so a useState below an early return is
//    called on the render that has data and skipped on the render that does
//    not. The second render then runs more hooks than the first, React throws
//    "Rendered more hooks than during the previous render", and ErrorBoundary
//    catches it — the view does not paint at all, so the symptom is an error
//    card rather than a wrong pixel. Batches' run detail shipped that way for
//    one commit: `actErr` and `confirmDelete` sat under `if (!d) return
//    <Reading/>`, and `d` arrives from an async read, so opening any run
//    faulted. There is no ESLint in this repository to carry
//    react-hooks/rules-of-hooks and nothing in `npm test` renders React, so
//    this is the cheapest honest guard.
//
//    What it reads: inside a top-level function or component-shaped const whose
//    name is capitalised, the first body-level (two-space) `return`, or the
//    first body-level if/for/while/switch/try block that contains one; every
//    body-level hook call below that is a finding.
//
//    What it cannot see, so a pass is not proof: a hook inside a nested
//    callback or a conditional at any deeper indentation, a component whose
//    body is not two-space indented, a hook reached through a helper that is
//    itself called conditionally, and a component written as a one-line arrow.
//
//    Empty, and it stays empty. This is not a debt list: a file listed here is
//    a file whose view throws on its second render.
const HOOK_AFTER_GUARD_BASELINE = {};

// `useState<string | null>(` puts its generic between the name and the paren,
// so the optional <…> is load-bearing rather than decoration: without it this
// misses one of the two calls that caused the crash the check exists for.
const HOOK_CALL = /(?:^|[^\w.$])use[A-Z]\w*\s*(?:<[^;{}=]*>\s*)?\(/;

function hooksAfterGuard(src) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(?:export default |export )?function ([A-Z]\w*)|^(?:export )?const ([A-Z]\w*)\s*=\s*(?:React\.)?(?:forwardRef|memo|function\b|\(|<)/.exec(lines[i]);
    if (!open) continue;
    const name = open[1] || open[2];
    // The component ends at the first line that starts a brace at column zero —
    // `}`, `};` and `});` all qualify, a body-level `  }` never does. Stop at
    // the wrong one and the next component's hooks read as this one's: matching
    // only a bare `}` ran FocusBtn in Sessions.tsx on into the whole Sessions
    // component and reported 37 findings that were not there.
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) if (/^\}/.test(lines[j])) { end = j; break; }
    let guard = -1;
    for (let j = i + 1; j < end && guard < 0; j++) {
      if (/^  return\b/.test(lines[j])) { guard = j; break; }
      if (!/^  (?:if|for|while|switch|try)\b.*\{\s*$/.test(lines[j])) continue;
      for (let k = j + 1; k < end; k++) {
        if (/^  \}/.test(lines[k])) break;
        if (/^\s+return\b/.test(lines[k])) { guard = j; break; }
      }
    }
    if (guard < 0) continue;
    for (let j = guard + 1; j < end; j++) {
      if (!/^  \S/.test(lines[j])) continue;
      if (/^  (?:\/\/|\/\*|\*)/.test(lines[j])) continue;
      if (HOOK_CALL.test(lines[j])) out.push({ component: name, line: j + 1, text: lines[j].trim() });
    }
  }
  return out;
}

function measure() {
  const files = walk(RENDERER);
  const tsx = files.filter((f) => f.endsWith('.tsx'));
  const css = files.filter((f) => f.endsWith('.css'));
  const read = (f) => fs.readFileSync(f, 'utf8');

  const inline = {};
  for (const f of tsx) inline[rel(f)] = count(read(f), INLINE_STYLE);

  const styleTags = tsx.filter((f) => STYLE_TAG.test(read(f))).map(rel).sort();

  const fontPx = {};
  for (const f of css.filter((f) => rel(f).startsWith('styles/'))) {
    fontPx[path.basename(f)] = count(read(f), FONT_PX);
  }

  const durations = {};
  for (const f of [...css, ...tsx]) {
    const r = rel(f);
    if (r === 'styles/motion.css') continue;
    const n = count(read(f), DURATION);
    if (n > 0) durations[r] = n;
  }

  const shadowed = shadowedModifiers(read, tsx);

  const unnamed = {};
  const titles = {};
  for (const f of tsx) {
    const n = unnamedControls(read(f));
    if (n > 0) unnamed[rel(f)] = n;
    const t = titleTooltips(read(f));
    if (t > 0) titles[rel(f)] = t;
  }

  const hookOrder = {};
  const hookFindings = [];
  for (const f of tsx) {
    const hits = hooksAfterGuard(read(f));
    if (!hits.length) continue;
    hookOrder[rel(f)] = hits.length;
    for (const h of hits) hookFindings.push({ file: rel(f), ...h });
  }

  return { inline, styleTags, fontPx, durations, shadowed, unnamed, titles, hookOrder, hookFindings };
}

function ratchet(label, current, baseline, failures) {
  for (const [file, n] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0;
    if (n > allowed) {
      failures.push(`${label}: ${file} has ${n}, baseline allows ${allowed}`);
    }
  }
}

function main() {
  const m = measure();

  if (process.argv.includes('--print-shadowed')) {
    if (!m.shadowed.findings.length) console.log('no shadowed modifiers found in the sheets index.css imports');
    for (const f of m.shadowed.findings) {
      console.log(`styles/${f.sheet}:${f.line}  ${f.sel} { ${f.prop} }  is overridden by index.css ${f.winner}`);
    }
    return;
  }

  if (process.argv.includes('--print-baseline')) {
    const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    console.log(JSON.stringify({
      INLINE_STYLE_BASELINE: sorted(m.inline),
      STYLE_TAG_BASELINE: m.styleTags,
      FONT_PX_BASELINE: sorted(m.fontPx),
      DURATION_BASELINE: sorted(m.durations),
      SHADOWED_MODIFIER_BASELINE: sorted(m.shadowed.counts),
      NO_ACCESSIBLE_NAME_BASELINE: sorted(m.unnamed),
      TITLE_TOOLTIP_BASELINE: sorted(m.titles),
      HOOK_AFTER_GUARD_BASELINE: sorted(m.hookOrder),
    }, null, 2));
    return;
  }

  const failures = [];
  ratchet('inline style objects', m.inline, INLINE_STYLE_BASELINE, failures);
  for (const f of m.styleTags) {
    if (!STYLE_TAG_BASELINE.has(f)) failures.push(`<style> in TSX: ${f} — put the rules in styles/<surface>.css`);
  }
  ratchet('px font sizes outside index.css', m.fontPx, FONT_PX_BASELINE, failures);
  ratchet('literal durations outside motion.css', m.durations, DURATION_BASELINE, failures);
  ratchet('form control with no accessible name', m.unnamed, NO_ACCESSIBLE_NAME_BASELINE, failures);
  ratchet('native title tooltip', m.titles, TITLE_TOOLTIP_BASELINE, failures);

  const shadowFailures = [];
  ratchet('modifier shadowed by a base rule', m.shadowed.counts, SHADOWED_MODIFIER_BASELINE, shadowFailures);
  if (!m.shadowed.sheets.length) {
    shadowFailures.push('modifier shadowed by a base rule: no @import of ./styles/*.css found in index.css, so check 5 measured nothing');
  }
  for (const line of shadowFailures) {
    failures.push(line);
    const sheet = line.split(': ')[1]?.split(' ')[0];
    for (const f of m.shadowed.findings.filter((x) => x.sheet === sheet)) {
      failures.push(`    styles/${f.sheet}:${f.line} — ${f.sel} { ${f.prop} } is overridden by index.css ${f.winner}`);
    }
  }

  const hookFailures = [];
  ratchet('hook called below an early return', m.hookOrder, HOOK_AFTER_GUARD_BASELINE, hookFailures);
  for (const line of hookFailures) {
    failures.push(line);
    const file = line.split(': ')[1]?.split(' ')[0];
    for (const h of m.hookFindings.filter((x) => x.file === file)) {
      failures.push(`    ${h.file}:${h.line} — ${h.component} calls ${h.text} on only some renders`);
    }
  }

  const totals = [
    `${Object.values(m.inline).reduce((a, b) => a + b, 0)} inline style objects across ${Object.keys(m.inline).length} renderer files`,
    `${m.styleTags.length} TSX files with <style>`,
    `${Object.values(m.fontPx).reduce((a, b) => a + b, 0)} px font sizes in styles/`,
    `${Object.values(m.durations).reduce((a, b) => a + b, 0)} literal durations outside motion.css`,
    `${m.shadowed.findings.length} shadowed modifier declarations in the ${m.shadowed.sheets.length} sheets index.css imports`,
    `${Object.values(m.unnamed).reduce((a, b) => a + b, 0)} form controls with no accessible name`,
    `${Object.values(m.titles).reduce((a, b) => a + b, 0)} native title tooltips`,
    `${m.hookFindings.length} hooks called below an early return`,
  ];

  if (failures.length) {
    console.error('renderer style gate failed:');
    for (const f of failures) console.error(`  - ${f}`);
    console.error('New views use .pane and the bits.tsx primitives; sizes, paddings and durations come from the tokens in index.css and motion.css.');
    console.error('A rule in a sheet index.css imports always loses to index.css at equal specificity; run --print-shadowed for the full list.');
    console.error('A native title is unreachable by keyboard and invisible to a finger: put the reason in text beside the control.');
    process.exitCode = 1;
    return;
  }
  console.log(`renderer style checks passed (${totals.join('; ')})`);
}

main();
