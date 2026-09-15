/**
 * Edit attribution, the pure half. The subject is the label: a file is placed
 * by the recorded route that names it, and a file nothing names is "changed
 * outside edit tools" — never "not the agent", which the record cannot support.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATTRIBUTION_LABEL, attributeFiles, inAgentScope, relativeToRoot } from './edit-attribution.ts';

test('hook paths are made relative to either spelling of the root, and a path elsewhere belongs to no file', () => {
  const roots = ['/var/folders/x/wt', '/private/var/folders/x/wt'];
  assert.equal(relativeToRoot('/private/var/folders/x/wt/src/a.ts', roots), 'src/a.ts');
  assert.equal(relativeToRoot('/var/folders/x/wt/b.md', roots), 'b.md');
  assert.equal(relativeToRoot('/var/folders/x/wtother/b.md', roots), null, 'a sibling that shares a prefix is not inside');
  assert.equal(relativeToRoot('/var/folders/x/wt', roots), null);
  assert.equal(relativeToRoot('/etc/hosts', roots), null);
  assert.equal(relativeToRoot('', roots), null);
});

test('an edit tool\'s record beats a shell report, which beats no record; renames match by either name', () => {
  const result = attributeFiles({
    files: [
      { path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'gen/schema.ts' },
      { path: 'lib/new-name.ts', oldPath: 'lib/old-name.ts' }, { path: 'both.ts' },
    ],
    editPaths: ['src/a.ts', 'lib/old-name.ts', 'both.ts'],
    shellPaths: ['gen/schema.ts', 'both.ts'],
    hooksRecorded: true,
  });
  assert.deepEqual(result, {
    'src/a.ts': 'edit-tool',
    'src/b.ts': 'outside-edit-tools',
    'gen/schema.ts': 'shell-reported',
    'lib/new-name.ts': 'edit-tool',
    'both.ts': 'edit-tool',
  });
});

test('with no hook record at all, absence proves nothing and every file says so', () => {
  const result = attributeFiles({ files: [{ path: 'a' }], editPaths: [], shellPaths: [], hooksRecorded: false });
  assert.deepEqual(result, { a: 'unrecorded' });
  assert.equal(inAgentScope('unrecorded'), false);
  assert.equal(inAgentScope('shell-reported'), true);
  assert.equal(inAgentScope(undefined), false);
});

test('no label claims who made a change', () => {
  for (const label of Object.values(ATTRIBUTION_LABEL)) {
    assert.doesNotMatch(label, /not (by )?the agent|by you|the operator|human/i);
  }
  assert.equal(ATTRIBUTION_LABEL['outside-edit-tools'], 'changed outside edit tools');
});
