import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db } from './db';
import { runGit } from './git';
import { addProject } from './store';
import { checkoutSnapshot } from './review-checkout';
import { compareCheckoutEvidence, recipe, run, saveRecipe } from './review';
import { commitReadingDigest, readGate, repoDigest, type MobileRepoReading } from './mobile/git';
import { expandMcpArgs } from './mcp/registry';
import { matchSkillProjection } from './learning-service';
import { catalogFromResults } from './plugins';
import type { ReviewRun, Session } from '../shared/types';

type Check = (ok: boolean, label: string, detail?: unknown) => void;

/** Offline fixtures only: no provider, plugin command, network or user-data access. */
export async function runAuditIntegrationsSmoke(check: Check, say: (text: string) => void): Promise<void> {
  say('── audit integrations · mobile content evidence, MCP, skill attribution, plugin failures');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-audit-integrations-'));
  const repo = path.join(dir, 'project');
  fs.mkdirSync(repo);
  const gitIn = async (root: string, ...args: string[]) => {
    const result = await runGit(root, ['-c', 'core.hooksPath=/dev/null', ...args], { timeout: 15_000 });
    if (!result.ok) throw new Error(result.err);
    return result.out;
  };
  const git = (...args: string[]) => gitIn(repo, ...args);
  try {
    await git('init');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'baseline\n');
    await git('add', '.');
    await git('-c', 'user.name=Smoke', '-c', 'user.email=smoke@localhost', 'commit', '-m', 'baseline');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'reviewed content\n');
    const reading: MobileRepoReading = { branch: 'main', detached: false, operation: null, dropped: 0,
      rows: [{ path: 'tracked.txt', status: ' M', where: 'unstaged' }] };
    const first = await checkoutSnapshot(repo);
    const firstStatus = await git('status', '--porcelain');
    const firstToken = commitReadingDigest(reading, first);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'unseen replacement\n');
    const changed = await checkoutSnapshot(repo);
    check(firstToken !== null && firstStatus === await git('status', '--porcelain')
      && firstToken !== commitReadingDigest(reading, changed),
    'mobile commit evidence changes for different contents under identical Git status rows');
    await git('add', 'tracked.txt');
    const staged = await checkoutSnapshot(repo);
    await git('-c', 'user.name=Smoke', '-c', 'user.email=smoke@localhost', 'commit', '-m', 'new HEAD');
    const committed = await checkoutSnapshot(repo);
    check(commitReadingDigest(reading, changed) !== commitReadingDigest(reading, staged)
      && commitReadingDigest(reading, staged) !== commitReadingDigest(reading, committed),
    'mobile commit evidence includes index and HEAD, independently of visible row identity');
    check(commitReadingDigest(reading, { ...first, fingerprint: null, unavailableReason: 'Unavailable fixture' }) === null
      && repoDigest(reading) !== firstToken,
    'unavailable comparisons and old status-only digests cannot authorize a mobile commit');

    const largeRepo = path.join(dir, 'large-checkout');
    const archive = path.join(largeRepo, 'archive');
    const sparseBytes = 15 * 1024 * 1024;
    fs.mkdirSync(archive, { recursive: true });
    await gitIn(largeRepo, 'init');
    const image = (index: number) => path.join(archive, `screenshot-${String(index).padStart(2, '0')}.png`);
    for (let index = 0; index < 40; index++) {
      fs.closeSync(fs.openSync(image(index), 'w'));
      fs.truncateSync(image(index), sparseBytes);
    }
    fs.writeFileSync(path.join(largeRepo, '.gitignore'), 'archive/*.png\n');
    await gitIn(largeRepo, 'add', '.gitignore');
    await gitIn(largeRepo, 'add', '-f', 'archive');
    await gitIn(largeRepo, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@localhost', 'commit', '-m', 'tracked archive');
    const largeFirst = await checkoutSnapshot(largeRepo);
    const largeRepeated = await checkoutSnapshot(largeRepo);
    check(largeFirst.fingerprint !== null && largeFirst.fingerprint === largeRepeated.fingerprint,
      'a checkout over 512 MiB receives a stable fingerprint without dropping tracked images ignored by current config',
      largeFirst.unavailableReason ?? largeRepeated.unavailableReason);
    const changedImage = fs.openSync(image(39), 'r+');
    try { fs.writeSync(changedImage, Buffer.from([1]), 0, 1, 0); }
    finally { fs.closeSync(changedImage); }
    const largeChanged = await checkoutSnapshot(largeRepo);
    check(largeChanged.fingerprint !== null && largeChanged.fingerprint !== largeFirst.fingerprint,
      'content changes beyond the former 512 MiB boundary invalidate the checkout fingerprint',
      largeChanged.unavailableReason);
    for (let index = 40; index < 69; index++) {
      fs.closeSync(fs.openSync(image(index), 'w'));
      fs.truncateSync(image(index), sparseBytes);
    }
    await gitIn(largeRepo, 'add', '-f', 'archive');
    const oversized = await checkoutSnapshot(largeRepo);
    check(oversized.fingerprint === null && oversized.unavailableReason === 'Checkout content exceeds the 1 GiB fingerprint limit.',
      'the checkout fingerprint keeps a bounded 1 GiB aggregate maximum', oversized.unavailableReason);

    const project = await addProject(repo);
    saveRecipe(project.id, ['true']);
    const pendingGate = run(project.id);
    check(readGate(project.id).latest?.live === true,
      'mobile can read a durable running receipt before asynchronous checkout comparison completes');
    const passed = await pendingGate;
    check(readGate(project.id, await checkoutSnapshot(repo)).latest?.freshness === 'current',
      'mobile reads persisted passing checkout evidence without a process-local gate map');
    const legacy = { ...passed, evidence: null } as ReviewRun;
    check(compareCheckoutEvidence(legacy, committed, recipe(project.id).commands).state === 'unavailable',
      'legacy review evidence stays unavailable on mobile');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'after gate\n');
    const afterGate = await checkoutSnapshot(repo);
    check(readGate(project.id, afterGate).latest?.freshness === 'stale',
      'a gate pass becomes stale after content changes');
    db().prepare(`INSERT INTO review_runs (id,project_id,session_id,started_at,ended_at,status,results_json,evidence_json)
      VALUES (?,?,?,?,?,?,?,?)`).run(`mobile-session-scope-${project.id}`, project.id, 'isolated-session',
      Date.now() + 10, Date.now() + 11, 'passed', '[]', JSON.stringify(passed.evidence));
    check(readGate(project.id, afterGate).latest?.id === passed.id,
      'a newer session-scoped gate is not substituted for the project gate on mobile');
    saveRecipe(project.id, ['false']);
    check(readGate(project.id, committed).latest?.freshness === 'stale',
      'mobile gate evidence also becomes stale when saved commands change');

    const spacePath = path.join(dir, 'My Project "quoted"');
    check(JSON.stringify(expandMcpArgs('-y server {{PROJECT_PATH}} --root={{PROJECT_PATH}}', spacePath))
      === JSON.stringify(['-y', 'server', spacePath, `--root=${spacePath}`])
      && JSON.stringify(expandMcpArgs('"{{PROJECT_PATH}}"', spacePath)) === JSON.stringify([spacePath]),
    'MCP placeholder expansion preserves spaces and literal quotes inside argv entries');

    const skills = (root: string) => path.join(root, '.claude', 'skills', 'review', 'SKILL.md');
    const other = path.join(dir, 'other');
    const isolated = path.join(dir, 'isolated');
    const personal = path.join(dir, 'personal');
    for (const root of [repo, other, isolated, personal]) {
      fs.mkdirSync(path.dirname(skills(root)), { recursive: true });
      fs.writeFileSync(skills(root), 'project skill');
    }
    const hash = createHash('sha256').update('project skill').digest('hex');
    const a = { id: 'a', item_id: 'item-a', version_id: 'v-a', provider_id: 'claude', project_id: project.id,
      scope: 'project', target_path: skills(repo), target_format: 'claude-skill', applied_hash: hash };
    const b = { ...a, id: 'b', item_id: 'item-b', project_id: 'other', target_path: skills(other) };
    const session: Pick<Session, 'providerId' | 'projectId' | 'projectPath' | 'worktree' | 'harnessId'> = {
      providerId: 'claude', projectId: project.id, projectPath: repo, worktree: null, harnessId: 'claude-code',
    };
    const personalRoot = path.join(personal, '.claude');
    check(matchSkillProjection('review', session, [b, a], personalRoot)?.itemId === 'item-a'
      && matchSkillProjection('review', { ...session, providerId: 'another' }, [a], personalRoot) === null
      && matchSkillProjection('plugin:review', session, [a], personalRoot) === null,
    'skill-use attribution stays within the session project/provider and preserves plugin namespaces');
    check(matchSkillProjection('review', { ...session, worktree: isolated }, [a], personalRoot) === null
      && matchSkillProjection('review', session, [a, { ...a, id: 'duplicate', item_id: 'other-item' }], personalRoot) === null,
    'isolated sessions and ambiguous projections do not inherit another checkout’s skill evidence');
    check(matchSkillProjection('review', session, [{ ...a, id: 'reinstalled', version_id: 'v-new' }, a], personalRoot)?.projectionId === 'reinstalled',
      'same-item reinstalls with identical bytes select the newest receipt without inventing an ambiguity');
    const p = { ...a, id: 'personal', item_id: 'personal-item', project_id: null, scope: 'personal', target_path: skills(personal) };
    check(matchSkillProjection('review', session, [p], personalRoot)?.itemId === 'personal-item'
      && matchSkillProjection('review', session, [a, p], personalRoot) === null,
    'personal skill attribution needs its actual root and refuses an ambiguous project/personal name');
    fs.writeFileSync(skills(repo), 'modified outside projection');
    check(matchSkillProjection('review', session, [a], personalRoot) === null,
      'modified skill files are not credited as the applied knowledge projection');

    const available = { ok: true, output: '{"available":[{"id":"review@market"}]}', error: null };
    const failed = catalogFromResults(available, { ok: false, output: '', error: 'Fixture installed list timed out' });
    const malformed = catalogFromResults(available, { ok: true, output: '{"unknown":[]}', error: null });
    const invalidRows = catalogFromResults(available, { ok: true, output: '{"installed":[null,{}]}', error: null });
    const empty = catalogFromResults(available, { ok: true, output: '', error: null });
    const installed = catalogFromResults(available, { ok: true, output: '{"installed":[{"id":"review@market","enabled":true}]}', error: null });
    check(!!failed.note && failed.plugins.length === 0 && !!malformed.note && !!invalidRows.note && !!empty.note
      && installed.note === null && installed.plugins[0]?.installed && installed.plugins[0]?.enabled,
    'plugin installed-list failures remain unavailable; successful installed state remains observed');
  } catch (error) { check(false, 'audit integration smoke completed', String(error)); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
