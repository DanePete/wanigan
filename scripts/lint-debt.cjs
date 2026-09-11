'use strict';

/*
 * What the linter is currently holding its nose about.
 *
 * `eslint-suppressions.json` is a machine-written baseline: it records the
 * violations the tree carried the day the linter landed, so the gate could pass
 * that day. It is a debt, not a permit, and ESLint enforces that in both
 * directions on its own — a new violation fails, and a suppression whose
 * violation has been fixed also fails until somebody runs
 * `npm run lint:prune`. What it does not do is make the debt easy to read, so
 * this prints it ranked, which is how a sweep picks its next target.
 */

const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '..', 'eslint-suppressions.json');
if (!fs.existsSync(file)) {
  console.log('No suppressions file: the tree is clean, which is the goal.');
  process.exit(0);
}

const suppressions = JSON.parse(fs.readFileSync(file, 'utf8'));
const byRule = new Map();
const byFile = new Map();
let total = 0;

for (const [name, rules] of Object.entries(suppressions)) {
  for (const [rule, entry] of Object.entries(rules)) {
    const count = Number(entry.count) || 0;
    total += count;
    byRule.set(rule, (byRule.get(rule) ?? 0) + count);
    byFile.set(name, (byFile.get(name) ?? 0) + count);
  }
}

const ranked = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);

console.log(`${total} suppressed violation${total === 1 ? '' : 's'} across ${byFile.size} files.\n`);
console.log('── by rule ──');
for (const [rule, count] of ranked(byRule)) console.log(`${String(count).padStart(5)}  ${rule}`);
console.log('\n── ten heaviest files ──');
for (const [name, count] of ranked(byFile).slice(0, 10)) console.log(`${String(count).padStart(5)}  ${name}`);
console.log('\nFix some, then run `npm run lint:prune` to take them off the books.');
