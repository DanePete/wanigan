import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { testCore } from './test-support.ts';

async function fixture() {
  const core = await testCore();
  try {
    const source = join(core.projectDir, '.claude', 'skills', 'copy-consent');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '---\nname: copy-consent\ndescription: An owned copy fixture.\n---\nRead the fixture.\n');
    const project = await core.owner.call('projects.add', { path: core.projectDir });
    const listing = await core.owner.call('skills.list', {});
    const skill = listing.groups.flatMap(group => group.skills).find(skill => skill.dir === source);
    assert.ok(skill);
    return { ...core, source, id: skill.id, to: { agent: 'codex' as const, projectId: project.id },
      destination: join(core.projectDir, '.agents', 'skills', 'copy-consent') };
  } catch (error) { await core.close(); throw error; }
}

test('a same-size source edit with restored mtime refuses old copy approval and accepts fresh approval', async () => {
  const t = await fixture();
  try {
    const payload = join(t.source, 'notes.txt');
    writeFileSync(payload, 'approved-A\n');
    const first = await t.owner.call('skills.copy', { id: t.id, to: t.to, preview: true });
    const before = statSync(payload);
    writeFileSync(payload, 'changed--B\n');
    utimesSync(payload, before.atime, before.mtime);
    assert.equal(statSync(payload).size, before.size);
    assert.equal(Math.round(statSync(payload).mtimeMs), Math.round(before.mtimeMs));
    await assert.rejects(t.owner.call('skills.copy', { id: t.id, to: t.to, planId: first.plan.planId }), /changed since you looked/);
    assert.equal(existsSync(t.destination), false, 'stale approval must write nothing');
    const fresh = await t.owner.call('skills.copy', { id: t.id, to: t.to, preview: true });
    assert.notEqual(fresh.plan.planId, first.plan.planId);
    const result = await t.owner.call('skills.copy', { id: t.id, to: t.to, planId: fresh.plan.planId });
    assert.equal(result.done, true);
    assert.equal(readFileSync(join(t.destination, 'notes.txt'), 'utf8'), 'changed--B\n');
  } finally { await t.close(); }
});

for (const change of ['mode', 'empty directory', 'skipped link'] as const) test(`copy approval binds a changed ${change}`, async () => {
  const t = await fixture();
  try {
    const payload = join(t.source, 'run.sh');
    writeFileSync(payload, '#!/bin/sh\nprintf approved\n', { mode: 0o644 });
    const first = await t.owner.call('skills.copy', { id: t.id, to: t.to, preview: true });
    if (change === 'mode') chmodSync(payload, 0o755);
    if (change === 'empty directory') mkdirSync(join(t.source, 'empty'));
    if (change === 'skipped link') symlinkSync(payload, join(t.source, 'linked.sh'));
    await assert.rejects(t.owner.call('skills.copy', { id: t.id, to: t.to, planId: first.plan.planId }), /changed since you looked/);
    assert.equal(existsSync(t.destination), false);
    const fresh = await t.owner.call('skills.copy', { id: t.id, to: t.to, preview: true });
    assert.notEqual(fresh.plan.planId, first.plan.planId);
    assert.equal((await t.owner.call('skills.copy', { id: t.id, to: t.to, planId: fresh.plan.planId })).done, true);
    if (change === 'mode') assert.equal(statSync(join(t.destination, 'run.sh')).mode & 0o777, 0o755);
    if (change === 'empty directory') assert.ok(statSync(join(t.destination, 'empty')).isDirectory());
    if (change === 'skipped link') {
      assert.deepEqual(fresh.plan.skipped, [{ path: 'linked.sh', why: 'a link' }]);
      assert.equal(existsSync(join(t.destination, 'linked.sh')), false);
    }
  } finally { await t.close(); }
});

test('copy writes the approved captured bytes when the source changes as destination creation begins', async () => {
  const t = await fixture();
  let boundary: ReturnType<typeof mock.method> | undefined;
  try {
    const payload = join(t.source, 'notes.txt');
    writeFileSync(payload, 'approved-A\n');
    const first = await t.owner.call('skills.copy', { id: t.id, to: t.to, preview: true });
    const mkdir = fs.mkdirSync;
    let changed = false;
    boundary = mock.method(fs, 'mkdirSync', (...args: Parameters<typeof mkdir>) => {
      if (args[0] === t.destination) { writeFileSync(payload, 'changed--B\n'); changed = true; }
      return mkdir(...args);
    });
    syncBuiltinESMExports();
    assert.equal((await t.owner.call('skills.copy', { id: t.id, to: t.to, planId: first.plan.planId })).done, true);
    assert.equal(changed, true, 'the owned filesystem boundary must actually change the source');
    assert.equal(readFileSync(payload, 'utf8'), 'changed--B\n');
    assert.equal(readFileSync(join(t.destination, 'notes.txt'), 'utf8'), 'approved-A\n');
  } finally { boundary?.mock.restore(); syncBuiltinESMExports(); await t.close(); }
});

for (const operation of ['directory listing', 'entry inspection'] as const) test(`copy refuses a failed ${operation} instead of approving an incomplete tree`, async () => {
  const t = await fixture();
  const patches: ReturnType<typeof mock.method>[] = [];
  try {
    const nested = join(t.source, 'nested'), file = join(nested, 'notes.txt');
    mkdirSync(nested); writeFileSync(file, 'must be reviewed\n');
    let injected = 0;
    const fail = (): never => { injected++; throw Object.assign(new Error('EACCES: owned fixture read denied'), { code: 'EACCES' }); };
    if (operation === 'directory listing') {
      const read = fs.readdirSync, open = fs.opendirSync;
      patches.push(mock.method(fs, 'readdirSync', (...args: Parameters<typeof read>) => args[0] === nested ? fail() : read(...args)));
      patches.push(mock.method(fs, 'opendirSync', (...args: Parameters<typeof open>) => args[0] === nested ? fail() : open(...args)));
    } else {
      const stat = fs.lstatSync;
      patches.push(mock.method(fs, 'lstatSync', (...args: Parameters<typeof stat>) => args[0] === file ? fail() : stat(...args)));
    }
    syncBuiltinESMExports();
    await assert.rejects(t.owner.call('skills.copy', { id: t.id, to: t.to, preview: true }), /EACCES|read denied/);
    assert.ok(injected > 0, 'the owned filesystem error must actually occur');
    assert.equal(existsSync(t.destination), false);
  } finally { for (const patch of patches) patch.mock.restore(); syncBuiltinESMExports(); await t.close(); }
});

test('copy accepts the entry limit and refuses one additional empty directory', async () => {
  const t = await fixture();
  try {
    for (let i = 0; i < 3999; i++) mkdirSync(join(t.source, `empty-${i}`));
    const exact = await t.owner.call('skills.copy', { id: t.id, to: t.to, preview: true });
    assert.deepEqual(exact.plan.files.map(file => file.path), ['SKILL.md']);
    mkdirSync(join(t.source, 'one-too-many'));
    await assert.rejects(t.owner.call('skills.copy', { id: t.id, to: t.to, preview: true }), /too big|too many/);
    await assert.rejects(t.owner.call('skills.copy', { id: t.id, to: t.to, planId: exact.plan.planId }), /too big|too many/);
    assert.equal(existsSync(t.destination), false);
  } finally { await t.close(); }
});

test('copy accepts exact file and byte limits and refuses the next file or byte before writing', async () => {
  const t = await fixture();
  try {
    for (let i = 0; i < 998; i++) writeFileSync(join(t.source, `empty-${i}`), '');
    const payload = join(t.source, 'payload.bin');
    writeFileSync(payload, '');
    const payloadSize = 25 * 1024 * 1024 - statSync(join(t.source, 'SKILL.md')).size;
    truncateSync(payload, payloadSize);
    const exact = await t.owner.call('skills.copy', { id: t.id, to: t.to, preview: true });
    assert.equal(exact.plan.files.length, 1000); assert.equal(exact.plan.totalBytes, 25 * 1024 * 1024);
    truncateSync(payload, payloadSize + 1);
    await assert.rejects(t.owner.call('skills.copy', { id: t.id, to: t.to, preview: true }), /too big|too large/);
    truncateSync(payload, payloadSize);
    writeFileSync(join(t.source, 'one-too-many.txt'), '');
    await assert.rejects(t.owner.call('skills.copy', { id: t.id, to: t.to, preview: true }), /too big|too many/);
    assert.equal(existsSync(t.destination), false);
  } finally { await t.close(); }
});

test('copy follows the selected top-level skill link but skips its internal links', async () => {
  const t = await fixture();
  try {
    const real = join(t.dir, 'shared-skill'); renameSync(t.source, real); symlinkSync(real, t.source);
    writeFileSync(join(real, 'notes.txt'), 'owned linked source\n', { mode: 0o640 });
    symlinkSync(join(real, 'notes.txt'), join(real, 'internal-link'));
    mkdirSync(join(real, 'empty'));
    const preview = await t.owner.call('skills.copy', { id: t.id, to: t.to, preview: true });
    assert.deepEqual(preview.plan.skipped, [{ path: 'internal-link', why: 'a link' }]);
    assert.equal((await t.owner.call('skills.copy', { id: t.id, to: t.to, planId: preview.plan.planId })).done, true);
    assert.equal(readFileSync(join(t.destination, 'notes.txt'), 'utf8'), 'owned linked source\n');
    assert.equal(statSync(join(t.destination, 'notes.txt')).mode & 0o777, 0o640);
    assert.ok(statSync(join(t.destination, 'empty')).isDirectory());
    assert.equal(existsSync(join(t.destination, 'internal-link')), false);
    assert.equal(readFileSync(join(real, 'notes.txt'), 'utf8'), 'owned linked source\n');
  } finally { await t.close(); }
});

test('copy creates private destination files before writing and preserves the approved final mode', async () => {
  const t = await fixture();
  const patches: ReturnType<typeof mock.method>[] = [];
  try {
    const payload = join(t.source, 'private.txt'), output = join(t.destination, 'private.txt');
    writeFileSync(payload, 'private fixture bytes\n', { mode: 0o640 });
    const preview = await t.owner.call('skills.copy', { id: t.id, to: t.to, preview: true });
    const open = fs.openSync, write = fs.writeFileSync;
    let destinationFd: number | undefined, observed = false;
    patches.push(mock.method(fs, 'openSync', (...args: Parameters<typeof open>) => {
      const fd = open(...args);
      if (args[0] === output) destinationFd = fd;
      return fd;
    }));
    patches.push(mock.method(fs, 'writeFileSync', (...args: Parameters<typeof write>) => {
      const destination = args[0] === output || (destinationFd !== undefined && args[0] === destinationFd);
      if (destination && typeof args[0] === 'number') {
        assert.equal(fs.fstatSync(args[0]).mode & 0o777, 0o600, 'new descriptor must be private before bytes are written');
      }
      const result = write(...args);
      if (destination) {
        observed = true;
        assert.equal(statSync(output).mode & 0o777, 0o600, 'new file must remain private until its approved final mode is applied');
      }
      return result;
    }));
    syncBuiltinESMExports();
    assert.equal((await t.owner.call('skills.copy', { id: t.id, to: t.to, planId: preview.plan.planId })).done, true);
    assert.ok(observed, 'the owned destination write must actually occur');
    assert.equal(readFileSync(output, 'utf8'), 'private fixture bytes\n');
    assert.equal(statSync(output).mode & 0o777, 0o640);
  } finally { for (const patch of patches) patch.mock.restore(); syncBuiltinESMExports(); await t.close(); }
});

test('copy refuses a traversed directory replaced by a link before opening outside file bytes', async () => {
  const t = await fixture();
  const patches: ReturnType<typeof mock.method>[] = [];
  try {
    const nested = join(t.source, 'nested'), moved = join(t.source, 'was-nested'), outside = join(t.dir, 'outside-copy');
    mkdirSync(nested); writeFileSync(join(nested, 'notes.txt'), 'approved inside\n');
    mkdirSync(outside); writeFileSync(join(outside, 'outside.txt'), 'unapproved outside\n');
    const openDir = fs.opendirSync, lstat = fs.lstatSync, open = fs.openSync;
    let rootOpens = 0, changed = false, changedAtRootOpen = 0, outsideOpens = 0;
    patches.push(mock.method(fs, 'opendirSync', (...args: Parameters<typeof openDir>) => {
      // Discovery measures this root first; the second enumeration captures the copy.
      if (args[0] === t.source) rootOpens++;
      return openDir(...args);
    }));
    patches.push(mock.method(fs, 'lstatSync', (...args: Parameters<typeof lstat>) => {
      const result = lstat(...args);
      if (rootOpens === 2 && !changed && args[0] === nested) {
        changed = true; changedAtRootOpen = rootOpens; renameSync(nested, moved); symlinkSync(outside, nested);
      }
      return result;
    }));
    patches.push(mock.method(fs, 'openSync', (...args: Parameters<typeof open>) => {
      if (args[0] === join(nested, 'outside.txt')) outsideOpens++;
      return open(...args);
    }));
    syncBuiltinESMExports();
    await assert.rejects(t.owner.call('skills.copy', { id: t.id, to: t.to, preview: true }), /changed|link|inside|directory/);
    assert.equal(rootOpens, 2, 'the owned root must be measured, then traversed for copying');
    assert.equal(changedAtRootOpen, 2, 'replace the directory during copy traversal, after discovery');
    assert.ok(changed, 'the controlled ancestor replacement must actually occur');
    assert.equal(outsideOpens, 0, 'a detected directory link must be refused before opening its file bytes');
    assert.equal(existsSync(t.destination), false);
  } finally { for (const patch of patches) patch.mock.restore(); syncBuiltinESMExports(); await t.close(); }
});

test('copy refuses a directory whose identity changes during bounded file capture', async () => {
  const t = await fixture();
  const patches: ReturnType<typeof mock.method>[] = [];
  try {
    const nested = join(t.source, 'nested'), payload = join(nested, 'notes.txt');
    mkdirSync(nested); writeFileSync(payload, 'approved inside\n');
    const openDir = fs.opendirSync, open = fs.openSync, read = fs.readSync;
    let walking = false, fd: number | undefined, changed = false;
    patches.push(mock.method(fs, 'opendirSync', (...args: Parameters<typeof openDir>) => {
      if (args[0] === t.source) walking = true;
      return openDir(...args);
    }));
    patches.push(mock.method(fs, 'openSync', (...args: Parameters<typeof open>) => {
      const result = open(...args);
      if (walking && args[0] === payload) fd = result;
      return result;
    }));
    patches.push(mock.method(fs, 'readSync', (...args: Parameters<typeof read>) => {
      const result = read(...args);
      if (!changed && fd !== undefined && args[0] === fd) {
        changed = true; renameSync(nested, join(t.source, 'was-nested')); mkdirSync(nested);
        writeFileSync(payload, 'changed outside the captured directory\n');
      }
      return result;
    }));
    syncBuiltinESMExports();
    await assert.rejects(t.owner.call('skills.copy', { id: t.id, to: t.to, preview: true }), /changed|directory/);
    assert.ok(changed, 'the controlled directory identity change must actually occur');
    assert.equal(existsSync(t.destination), false);
  } finally { for (const patch of patches) patch.mock.restore(); syncBuiltinESMExports(); await t.close(); }
});
