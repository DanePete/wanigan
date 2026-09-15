/**
 * Codex's loader model, its config reader, and the pre-apply budget check.
 * The subject is the cut: what loads, what is truncated and where, and whether
 * a projected rule would land somewhere a session never reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  byteLength, candidateFilenames, codexChain, codexSkillBudget, managedBlockEnd, projectionBudgetCheck, readImplicitInvocation,
  searchDirectories, skillListingLine, withImplicitInvocation, CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES, type DirectoryListing,
} from './codex-loader.ts';
import { readTomlKeys, tomlInteger, tomlString, tomlStrings } from './toml-keys.ts';

const file = (dir: string, name: string, bytes: number, blank = false) => ({ name, path: `${dir}/${name}`, bytes, blank });

test('the packaged default budget is the 32 KiB the 0.154.0 binary ships', () => {
  assert.equal(CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES, 32768);
});

test('precedence is override, then AGENTS.md, then fallbacks, with path-like fallbacks refused', () => {
  assert.deepEqual(candidateFilenames(['CLAUDE.md', '../x.md', 'AGENTS.md', '']), ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md']);
});

test('directories run from the root marker down to cwd, or cwd alone without one', () => {
  assert.deepEqual(searchDirectories('/r/a/b', '/r'), ['/r', '/r/a', '/r/a/b']);
  assert.deepEqual(searchDirectories('/r', '/r'), ['/r']);
  assert.deepEqual(searchDirectories('/r/a', null), ['/r/a']);
  assert.deepEqual(searchDirectories('/elsewhere', '/r'), ['/elsewhere']);
});

test('one file per directory, root first, and the override shadows AGENTS.md', () => {
  const chain = codexChain([
    { dir: '/r', present: [file('/r', 'AGENTS.md', 100), file('/r', 'AGENTS.override.md', 40)] },
    { dir: '/r/a', present: [file('/r/a', 'AGENTS.md', 60)] },
  ], [], 32768);
  assert.deepEqual(chain.files.map((f) => [f.name, f.offset, f.status, f.shadows]), [
    ['AGENTS.override.md', 0, 'loaded', ['AGENTS.md']],
    ['AGENTS.md', 40, 'loaded', []],
  ]);
  assert.equal(chain.loadedBytes, 100);
  assert.equal(chain.droppedBytes, 0);
});

test('the file that crosses the budget is truncated with its dropped range, and later files never load', () => {
  const listings: DirectoryListing[] = [
    { dir: '/r', present: [file('/r', 'AGENTS.md', 30)] },
    { dir: '/r/a', present: [file('/r/a', 'AGENTS.md', 30)] },
    { dir: '/r/a/b', present: [file('/r/a/b', 'AGENTS.md', 10)] },
  ];
  const chain = codexChain(listings, [], 50);
  assert.deepEqual(chain.files.map((f) => [f.status, f.loadedBytes, f.droppedRange, f.runningTotal]), [
    ['loaded', 30, null, 30],
    ['truncated', 20, [20, 30], 50],
    ['past-budget', 0, [0, 10], 50],
  ]);
  assert.equal(chain.droppedBytes, 20);
  assert.equal(chain.totalBytes, 70);
});

test('a blank file is listed but consumes nothing', () => {
  const chain = codexChain([{ dir: '/r', present: [file('/r', 'AGENTS.md', 3, true)] }, { dir: '/r/a', present: [file('/r/a', 'AGENTS.md', 10)] }], [], 10);
  assert.deepEqual(chain.files.map((f) => f.status), ['blank', 'loaded']);
});

test('the skills budget is 2% of the window, and explicit values cap at 10,000', () => {
  assert.deepEqual(codexSkillBudget({ explicit: null, contextWindow: 272000 }), { status: 'known', tokens: 5440, source: 'window-share', contextWindow: 272000 });
  assert.deepEqual(codexSkillBudget({ explicit: 50000, contextWindow: 272000 }), { status: 'known', tokens: 10000, source: 'explicit-capped', contextWindow: 272000 });
  assert.deepEqual(codexSkillBudget({ explicit: 800, contextWindow: null }), { status: 'known', tokens: 800, source: 'explicit', contextWindow: null });
  assert.equal(codexSkillBudget({ explicit: null, contextWindow: null }).status, 'unknown');
  assert.match(skillListingLine({ name: 'x', description: 'does y', path: '/p/SKILL.md' }), /^- x: does y \(file: \/p\/SKILL\.md\)\n$/);
});

test('a projected block that ends past the cut is refused with the byte it would end at', () => {
  const listings: DirectoryListing[] = [{ dir: '/r', present: [file('/r', 'AGENTS.md', 90)] }, { dir: '/r/a', present: [] }];
  const refused = projectionBudgetCheck({ listings, fallbacks: [], maxBytes: 100, targetPath: '/r/a/AGENTS.md', targetDir: '/r/a',
    targetName: 'AGENTS.md', proposedBytes: 40, blockEnd: 40 });
  assert.equal(refused.verdict, 'refuse');
  assert.match(refused.reason ?? '', /byte 130/);
  const warned = projectionBudgetCheck({ listings, fallbacks: [], maxBytes: 100, targetPath: '/r/a/AGENTS.md', targetDir: '/r/a',
    targetName: 'AGENTS.md', proposedBytes: 5, blockEnd: 5 });
  assert.equal(warned.verdict, 'warn');
  const fine = projectionBudgetCheck({ listings: [{ dir: '/r', present: [file('/r', 'AGENTS.md', 10)] }], fallbacks: [], maxBytes: 100,
    targetPath: '/r/AGENTS.md', targetDir: '/r', targetName: 'AGENTS.md', proposedBytes: 20, blockEnd: 20 });
  assert.deepEqual(fine, { verdict: 'ok', share: 0.2, reason: null });
});

test('replacing the target file does not double-count its old bytes', () => {
  const verdict = projectionBudgetCheck({ listings: [{ dir: '/r', present: [file('/r', 'AGENTS.md', 95)] }], fallbacks: [], maxBytes: 100,
    targetPath: '/r/AGENTS.md', targetDir: '/r', targetName: 'AGENTS.md', proposedBytes: 50, blockEnd: 50 });
  assert.equal(verdict.verdict, 'ok');
});

test('a projection shadowed by an override in the same directory is refused', () => {
  const verdict = projectionBudgetCheck({ listings: [{ dir: '/r', present: [file('/r', 'AGENTS.override.md', 5)] }], fallbacks: [], maxBytes: 100,
    targetPath: '/r/AGENTS.md', targetDir: '/r', targetName: 'AGENTS.md', proposedBytes: 10, blockEnd: 10 });
  assert.equal(verdict.verdict, 'refuse');
  assert.match(verdict.reason ?? '', /shadowed/);
});

test('the managed block end is measured in bytes, not UTF-16 units', () => {
  const text = 'é\n<!-- wanigan:begin k -->\nrule\n<!-- wanigan:end k -->\ntail\n';
  assert.equal(managedBlockEnd(text), byteLength('é\n<!-- wanigan:begin k -->\nrule\n<!-- wanigan:end k -->'));
  assert.equal(managedBlockEnd('no block'), null);
  assert.equal(byteLength('é'), 2);
});

test('the TOML subset reads the keys Codex budgets depend on', () => {
  const keys = readTomlKeys([
    'model = "gpt-6-astra" # trailing comment',
    'project_doc_max_bytes = 65_536',
    'project_doc_fallback_filenames = [',
    '  "CLAUDE.md", # one',
    "  'TEAM.md',",
    ']',
    'notify = ["a", "b"]',
    '[skills]',
    'max_context_tokens = 4000',
    '[projects."/Users/x/repo"]',
    'trust_level = "trusted"',
    'inline = { a = 1 }',
  ].join('\n'));
  assert.equal(tomlString(keys, 'model'), 'gpt-6-astra');
  assert.equal(tomlInteger(keys, 'project_doc_max_bytes'), 65536);
  assert.deepEqual(tomlStrings(keys, 'project_doc_fallback_filenames'), ['CLAUDE.md', 'TEAM.md']);
  assert.equal(tomlInteger(keys, 'skills.max_context_tokens'), 4000);
  assert.equal(tomlString(keys, 'projects./Users/x/repo.trust_level'), 'trusted');
  assert.deepEqual(keys.unreadable, ['projects./Users/x/repo.inline']);
});

test('a TOML file with a dotted key and a hash inside a string keeps both', () => {
  const keys = readTomlKeys('skills.max_context_tokens = 12\nname = "a # b"\n[[array]]\nx = 1\n');
  assert.equal(tomlInteger(keys, 'skills.max_context_tokens'), 12);
  assert.equal(tomlString(keys, 'name'), 'a # b');
  assert.equal(keys.values.x, undefined);
});

test('openai.yaml policy is read by shape and rewritten without disturbing the rest', () => {
  const yaml = 'interface:\n  display_name: "Review Agent"\npolicy:\n  allow_implicit_invocation: false\n';
  assert.equal(readImplicitInvocation(yaml), false);
  assert.equal(readImplicitInvocation('interface:\n  display_name: x\n'), null);
  assert.equal(readImplicitInvocation('policy:\n  allow_implicit_invocation: maybe\n'), 'unknown');
  assert.equal(readImplicitInvocation('policy: { allow_implicit_invocation: true }\n'), true);
  // A nested key of the same name under another mapping is not the policy.
  assert.equal(readImplicitInvocation('interface:\n  allow_implicit_invocation: false\n'), null);

  const flipped = withImplicitInvocation(yaml, true);
  assert.equal(readImplicitInvocation(flipped), true);
  assert.match(flipped, /display_name: "Review Agent"/);
  const added = withImplicitInvocation('interface:\n  display_name: x\n', false);
  assert.equal(readImplicitInvocation(added), false);
  assert.equal(readImplicitInvocation(withImplicitInvocation('', false)), false);
});
