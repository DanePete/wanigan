'use strict';

/*
 * Renderer style gate. Runs in `npm test` between typecheck and the package
 * hooks, and reads source only — it never renders the app.
 *
 * Four checks, each a ratchet against a baseline written into this file:
 *   1. inline `style={{` objects per renderer .tsx, keyed by path,
 *   2. `<style` tags in any renderer .tsx,
 *   3. literal px font sizes in styles/*.css (index.css owns the type scale and
 *      is the one sheet allowed to spell a size in px),
 *   4. literal transition/animation durations anywhere but styles/motion.css,
 *      which owns --mo-state / --mo-view.
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
  'components/ReviewGate.tsx': 8,
  'components/SessionLearning.tsx': 6,
  'components/ShortcutSheet.tsx': 0,
  'components/TeamPanel.tsx': 24,
  'components/TerminalPane.tsx': 1,
  'components/ThemeControl.tsx': 0,
  'components/Timeline.tsx': 8,
  'main.tsx': 0,
  'views/Batches.tsx': 206,
  'views/Context.tsx': 115,
  'views/Control.tsx': 0,
  'views/Fleet.tsx': 29,
  'views/Git.tsx': 32,
  'views/HeadlessRuns.tsx': 0,
  'views/ImprovementScout.tsx': 1,
  'views/Insights.tsx': 62,
  'views/Learning.tsx': 9,
  'views/Plugins.tsx': 38,
  'views/Schedules.tsx': 23,
  'views/Sessions.tsx': 126,
  'views/Settings.tsx': 269,
  'views/Skills.tsx': 39,
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
  'control.css': 11,
  'insights.css': 17,
  'evals.css': 20, 'skills.css': 20,
  'fleet.css': 15,
  'git.css': 13,
  'learning.css': 2,
  'pet.css': 10,
  'policy.css': 16, 'context.css': 16,
  'queue.css': 15, 'plugins.css': 15,
  'schedule.css': 8,
  'session-learning.css': 1,
  'settings.css': 27,
  'sessions.css': 2,
  'timeline.css': 26,
};

// 4. Declarations with a literal duration, per file, relative to src/renderer/src.
const DURATION_BASELINE = {
  'styles/attention.css': 2,
  'styles/evals.css': 1, 'styles/skills.css': 1,
  'styles/fleet.css': 2,
  'styles/learning.css': 2,
  'styles/pet.css': 0,
  'styles/sessions.css': 2,
  'styles/timeline.css': 1,
  'views/Settings.tsx': 3, 'styles/settings.css': 3,
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

  return { inline, styleTags, fontPx, durations };
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

  if (process.argv.includes('--print-baseline')) {
    const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    console.log(JSON.stringify({
      INLINE_STYLE_BASELINE: sorted(m.inline),
      STYLE_TAG_BASELINE: m.styleTags,
      FONT_PX_BASELINE: sorted(m.fontPx),
      DURATION_BASELINE: sorted(m.durations),
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

  const totals = [
    `${Object.values(m.inline).reduce((a, b) => a + b, 0)} inline style objects across ${Object.keys(m.inline).length} renderer files`,
    `${m.styleTags.length} TSX files with <style>`,
    `${Object.values(m.fontPx).reduce((a, b) => a + b, 0)} px font sizes in styles/`,
    `${Object.values(m.durations).reduce((a, b) => a + b, 0)} literal durations outside motion.css`,
  ];

  if (failures.length) {
    console.error('renderer style gate failed:');
    for (const f of failures) console.error(`  - ${f}`);
    console.error('New views use .pane and the bits.tsx primitives; sizes, paddings and durations come from the tokens in index.css and motion.css.');
    process.exitCode = 1;
    return;
  }
  console.log(`renderer style checks passed (${totals.join('; ')})`);
}

main();
