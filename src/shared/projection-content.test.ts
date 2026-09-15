/**
 * The byte-stability contract for knowledge projections: compiling the same
 * knowledge twice produces identical bytes and an identical hash for every
 * compiler target, and re-applying what is already there changes nothing.
 * Undo and staleness both compare hashes, so a builder that can render the
 * same knowledge two ways makes an unchanged projection read as changed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  canonicalSelectors, codexDirectoryScope, dominantEol, managedMarkdown, pathRuleFrontmatter, skillBody, sliceWhole, slug,
  stripLeadingFrontmatter,
} from './projection-content.ts';

const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const item = { key: 'kitem_42', title: 'Run the offline smoke', proposedText: 'Use the direct electron command.\nNever `npm run smoke` from a non-tty shell.' };
const skill = { title: 'Tidy imports', rationale: 'Three sessions sorted imports by hand before committing.', proposedText: '## Steps\n1. Sort.\n' };

/** Every target format a compiler writes, from the same knowledge. */
function compileAll(existing: { agents: string | null; claude: string | null; rule: string | null }) {
  const rule = stripLeadingFrontmatter(existing.rule);
  return {
    'claude-instructions': managedMarkdown(existing.claude, item),
    'codex-agents': managedMarkdown(existing.agents, item),
    'claude-path-rule': pathRuleFrontmatter(canonicalSelectors('src/main/**, src/shared/**'), dominantEol(rule)) + managedMarkdown(rule, item),
    'claude-skill': skillBody(skill),
    'agent-skill': skillBody(skill),
  };
}

test('compiling the same knowledge twice gives identical bytes and hash for every target', () => {
  const inputs = [
    { agents: null, claude: null, rule: null },
    { agents: '# Repo\n\nHand-written.\n', claude: '# CLAUDE\r\n\r\nWindows file.\r\n', rule: '---\npaths:\n  - "old/**"\n---\n\nold body\n' },
  ];
  for (const existing of inputs) {
    const first = compileAll(existing);
    const second = compileAll(structuredClone(existing));
    for (const target of Object.keys(first) as (keyof typeof first)[]) {
      assert.equal(second[target], first[target], target);
      assert.equal(sha(second[target]), sha(first[target]), target);
    }
  }
});

test('re-applying a projection onto its own output is a no-op, byte for byte', () => {
  for (const base of [null, '# Repo\n\nHand-written.\n', '# CRLF\r\n\r\nbody\r\n', 'trailing spaces   \n\n\n']) {
    const once = managedMarkdown(base, item);
    const twice = managedMarkdown(once, item);
    assert.equal(sha(twice), sha(once), JSON.stringify(base));
  }
});

test('two items applied in either order converge once each is re-applied in the same order', () => {
  const other = { key: 'kitem_7', title: 'Second rule', proposedText: 'Keep migrations additive.' };
  const ab = managedMarkdown(managedMarkdown(null, item), other);
  const abAgain = managedMarkdown(managedMarkdown(ab, item), other);
  assert.equal(sha(abAgain), sha(ab));
});

test('selector order and duplicates do not change a path rule', () => {
  const eol = '\n' as const;
  assert.equal(
    pathRuleFrontmatter(canonicalSelectors('src/b/**, src/a/**\nsrc/b/**'), eol),
    pathRuleFrontmatter(canonicalSelectors('src/a/**,src/b/**'), eol),
  );
  assert.deepEqual(canonicalSelectors(' , '), []);
});

test('the block adopts the file’s line ending, so a CRLF file stays CRLF', () => {
  const out = managedMarkdown('# A\r\n\r\nB\r\n', item);
  assert.equal(out.replace(/\r\n/g, '').includes('\n'), false);
});

test('a SKILL.md proposal with CRLF frontmatter is not given a second frontmatter', () => {
  const crlf = '---\r\nname: x\r\ndescription: y\r\n---\r\n\r\nbody';
  const out = skillBody({ title: 'X', rationale: 'r', proposedText: crlf });
  assert.equal(out.match(/^---/gm)?.length, 2);
  assert.ok(out.endsWith('\r\n'));
});

test('a description is never cut through the middle of a character', () => {
  const rationale = `${'a'.repeat(499)}😀tail`;
  assert.equal(sliceWhole(rationale, 500), 'a'.repeat(499));
  const out = skillBody({ title: 'Emoji', rationale, proposedText: 'body' });
  assert.equal(/\\ud83d/i.test(out), false);
});

test('slug and the Codex directory scope are stable and refuse what they cannot express', () => {
  assert.equal(slug('Run the Offline Smoke!'), 'run-the-offline-smoke');
  assert.equal(slug('!!!'), 'wanigan-skill');
  assert.equal(codexDirectoryScope('./src/main/learning/**'), 'src/main/learning');
  assert.equal(codexDirectoryScope('src/a/**, src/b/**'), null);
  assert.equal(codexDirectoryScope('src/*.ts'), null);
  assert.equal(codexDirectoryScope('../outside/**'), null);
  assert.equal(codexDirectoryScope('/abs/**'), null);
  assert.equal(codexDirectoryScope('src/../lib/**'), 'lib');
});
