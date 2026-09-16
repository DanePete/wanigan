import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { app } from 'electron';
import { assistedByPreview } from './assisted-by';
import { db, migrateSchema } from './db';
import { runGit } from './git';
import { commitChecked, pushChecked } from './guarded-git';
import { appendLedgerRow, sha256Hex, signLedgerHead, verifyLedger } from './ledger-chain';
import * as mobile from './mobile';
import { clearActionWindowForSmoke } from './mobile/dispatch';
import * as policy from './policy';
import { scanFor } from './secret-scan';
import { setSetting, setUserPreference } from './settings';
import { addProject } from './store';
import { ALLOW_MARKER } from '../shared/secret-scan';
import { ledgerHashInput, type LedgerChainRow, type LedgerRecordedFields } from '../shared/ledger-chain';
import type { HookInput } from '../shared/types';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Secrets caught before they leave, a policy ledger that shows tampering, and
 * Assisted-by trailers, each exercised where it acts: real repositories with a
 * real bare remote, the guarded commit and push the IPC handlers call, the
 * phone's commit route over HTTP, a database made with the pre-chain schema and
 * then migrated, and the offline verifier run as its own process.
 *
 * No credential appears in this file. Every planted token is assembled at run
 * time from a split prefix and a hash of a fixed seed, so it is well formed and
 * high in entropy — which is what the scanner looks for — and a secret scanner
 * pointed at this repository reads nothing here.
 */
export async function runAccountabilitySmoke(check: Check, say: Say): Promise<void> {
  say('── accountability · secrets before they leave, a ledger that shows tampering, Assisted-by trailers');

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-accountability-'));
  const remote = path.join(base, 'origin.git');
  const repo = path.join(base, 'work');
  const seeded: string[] = [];
  let ledgerDb: Database.Database | null = null;
  let monitorStarted = false;

  const git = async (cwd: string, ...args: string[]) => {
    const r = await runGit(cwd, args, { timeout: 20_000 });
    if (!r.ok) throw new Error(`git ${args.join(' ')}: ${r.err}`);
    return r.out.trim();
  };
  /** The refusal a call threw, or null when it went through. */
  const attempt = async (fn: () => Promise<unknown>): Promise<string | null> => {
    try { await fn(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
  };
  /** Alphanumeric material of a given length, the same every run. */
  const material = (seed: string, length: number) => {
    let out = '';
    for (let i = 0; out.length < length; i++) out += createHash('sha256').update(`${seed}:${i}`).digest('base64').replace(/[^A-Za-z0-9]/g, '');
    return out.slice(0, length);
  };

  try {
    fs.mkdirSync(repo, { recursive: true });
    await git(base, 'init', '-q', '--bare', '-b', 'main', remote);
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'config', 'user.email', 'smoke@wanigan.test');
    await git(repo, 'config', 'user.name', 'Smoke');
    await git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    await git(repo, 'add', 'README.md');
    await git(repo, 'commit', '-q', '-m', 'base');
    await git(repo, 'remote', 'add', 'origin', remote);
    await git(repo, 'push', '-q', '-u', 'origin', 'main');

    /* ── the staged scan ───────────────────────────────────────────── */
    const token = ['gh', 'p_', material('planted', 36)].join('');
    const tokenBody = token.slice(4);
    fs.mkdirSync(path.join(repo, 'src'));
    const client = path.join(repo, 'src', 'client.ts');
    fs.writeFileSync(client, ['export const region = "us-east-1";', `export const client = connect("${token}");`, 'export const retries = 3;', ''].join('\n'));
    await git(repo, 'add', 'src/client.ts');
    const first = await scanFor(repo, { action: 'commit' });
    const [found] = first.findings;
    check(first.findings.length === 1 && found?.file === 'src/client.ts' && found.line === 2 && found.rule === 'github-token' && found.commit === null,
      'a well-formed token planted in a staged file is found at its file and at its line in the new version of that file',
      JSON.stringify(first.findings));
    check(Boolean(found?.excerpt.includes(`${token.slice(0, 4)}[redacted]`)) && !JSON.stringify(first).includes(tokenBody.slice(0, 12)),
      "the finding's excerpt masks the token after its public prefix, and nothing in the report the renderer receives carries any of the token's body",
      found?.excerpt);
    check(first.needsAcknowledgement && /^[0-9a-f]{64}$/.test(first.digest) && first.scope === 'the staged changes',
      'a finding makes the scan ask for an acknowledgement, bound to a digest, over a scope stated in words', first.scope);

    const allowed = ['gh', 'p_', material('allowed', 36)].join('');
    fs.appendFileSync(client, `export const fixture = "${allowed}"; // ${ALLOW_MARKER}\n`);
    await git(repo, 'add', 'src/client.ts');
    const marked = await scanFor(repo, { action: 'commit' });
    check(marked.suppressed === 1 && marked.findings.length === 1 && marked.findings[0]?.line === 2,
      'a line carrying wanigan:allow-secret is not reported and is counted as suppressed, while the unmarked token on line 2 still is',
      JSON.stringify({ suppressed: marked.suppressed, lines: marked.findings.map((f) => f.line) }));

    /* ── commit, refused and acknowledged ──────────────────────────── */
    const headBefore = await git(repo, 'rev-parse', 'HEAD');
    const bare = await attempt(() => commitChecked(repo, 'Add the client', {}));
    check(bare !== null && /found 1 possible secret in the staged changes/.test(bare) && await git(repo, 'rev-parse', 'HEAD') === headBefore,
      'a commit that carries no acknowledgement is refused in main, says what was found, and leaves HEAD where it was', bare);
    const forged = await attempt(() => commitChecked(repo, 'Add the client', { acknowledge: 'f'.repeat(64) }));
    check(forged !== null && /changed after it was shown/.test(forged) && await git(repo, 'rev-parse', 'HEAD') === headBefore,
      'an acknowledgement that is not the digest of these findings is refused as stale, and nothing is committed', forged);

    const shown = await scanFor(repo, { action: 'commit' });
    const extra = path.join(repo, 'src', 'extra.ts');
    fs.writeFileSync(extra, `export const registry = use("${['np', 'm_', material('second', 36)].join('')}");\n`);
    await git(repo, 'add', 'src/extra.ts');
    const late = await attempt(() => commitChecked(repo, 'Add the client', { acknowledge: shown.digest }));
    check(late !== null && /changed after it was shown/.test(late) && await git(repo, 'rev-parse', 'HEAD') === headBefore,
      'a digest acknowledged before a second secret was staged no longer matches, so the commit is refused rather than carrying a secret nobody was shown', late);
    await git(repo, 'rm', '-q', '--cached', 'src/extra.ts');
    fs.rmSync(extra);

    const current = await scanFor(repo, { action: 'commit' });
    const accepted = await attempt(() => commitChecked(repo, 'Add the client', { acknowledge: current.digest }));
    const committed = await git(repo, 'rev-parse', 'HEAD');
    check(accepted === null && committed !== headBefore && (await git(repo, 'show', '--name-only', '--format=', 'HEAD')).split('\n').includes('src/client.ts'),
      'with the digest of the findings as they are now, the same commit proceeds and records the file', accepted);

    /* ── push, refused and acknowledged ────────────────────────────── */
    const remoteMain = () => git(remote, 'rev-parse', 'refs/heads/main');
    const remoteBefore = await remoteMain();
    const pushScan = await scanFor(repo, { action: 'push' });
    check(pushScan.findings.length === 1 && pushScan.findings[0]?.commit === committed && pushScan.suppressed === 1
      && pushScan.scope === 'the commits not yet on origin/main (1 commit)',
    'a push scans each commit its upstream does not have, and names the commit that added the token', JSON.stringify({ scope: pushScan.scope, findings: pushScan.findings }));
    const pushBare = await attempt(() => pushChecked(repo, {}));
    check(pushBare !== null && /possible secret in the commits not yet on origin\/main/.test(pushBare) && await remoteMain() === remoteBefore,
      'a push with no acknowledgement is refused in main, and the remote branch does not move', pushBare);
    const pushed = await attempt(() => pushChecked(repo, { acknowledge: pushScan.digest }));
    check(pushed === null && await remoteMain() === committed,
      'with the digest back, the push proceeds and the remote holds the commit', pushed);

    await git(repo, 'checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(repo, 'notes.md'), 'side work\n');
    await git(repo, 'add', 'notes.md');
    await git(repo, 'commit', '-q', '-m', 'side base');
    // Pushed without -u: origin/side exists, and no upstream is configured.
    await git(repo, 'push', '-q', 'origin', 'side');
    const slack = ['xo', 'xb-', '123456789012', '-', '1234567890123', '-', material('slack', 24)].join('');
    fs.writeFileSync(path.join(repo, 'notify.ts'), `export const hook = post("${slack}");\n`);
    await git(repo, 'add', 'notify.ts');
    await git(repo, 'commit', '-q', '-m', 'notify');
    const sideTip = await git(repo, 'rev-parse', 'HEAD');
    const sideScan = await scanFor(repo, { action: 'push', setUpstream: true, branch: 'side' });
    check(sideScan.findings.length === 1 && sideScan.findings[0]?.rule === 'slack-token' && sideScan.findings[0]?.file === 'notify.ts'
      && sideScan.suppressed === 0 && sideScan.scope === 'the commits not yet on origin/side (1 commit)',
    'with no upstream set, a push reads from the merge base with origin/<branch>: the one new commit, not the history already published',
    JSON.stringify({ scope: sideScan.scope, findings: sideScan.findings, suppressed: sideScan.suppressed }));
    const remoteSide = () => git(remote, 'rev-parse', 'refs/heads/side');
    const sideBefore = await remoteSide();
    const sideBare = await attempt(() => pushChecked(repo, { setUpstream: true, branch: 'side' }));
    check(sideBare !== null && await remoteSide() === sideBefore,
      'setting an upstream does not skip the check: that push is refused too, and origin/side does not move', sideBare);
    const sidePushed = await attempt(() => pushChecked(repo, { setUpstream: true, branch: 'side', acknowledge: sideScan.digest }));
    check(sidePushed === null && await remoteSide() === sideTip && await git(repo, 'rev-parse', '--abbrev-ref', '@{upstream}') === 'origin/side',
      'acknowledged, the push publishes the commit and sets the upstream it was asked to', sidePushed);

    await git(repo, 'checkout', '-q', '-b', 'fresh');
    fs.writeFileSync(path.join(repo, 'fresh.md'), 'nothing secret\n');
    await git(repo, 'add', 'fresh.md');
    await git(repo, 'commit', '-q', '-m', 'fresh');
    const freshScan = await scanFor(repo, { action: 'push', setUpstream: true, branch: 'fresh' });
    check(!freshScan.needsAcknowledgement && freshScan.findings.length === 0 && freshScan.scope === 'the commits on fresh that no origin branch has (1 commit)',
      'a first push of a branch reads only the commits no origin branch already has, so a token already published elsewhere is not reported again',
      JSON.stringify({ scope: freshScan.scope, findings: freshScan.findings.length }));

    /* ── the phone cannot acknowledge ──────────────────────────────── */
    await git(repo, 'checkout', '-q', 'main');
    const stripe = ['sk', '_live_', material('stripe', 32)].join('');
    fs.appendFileSync(path.join(repo, 'README.md'), `billing uses "${stripe}"\n`);
    const project = await addProject(repo);
    const port = await unusedLoopbackPort();
    const monitor = await mobile.setMobileConfig({ dashboardEnabled: true, port });
    monitorStarted = true;
    setSetting('mobile_repository_review', '1');
    const bearer = new URLSearchParams(new URL(monitor.pairingUrl).hash.slice(1)).get('token') ?? '';
    const auth = { authorization: `Bearer ${bearer}` };
    const reading = await (await fetch(new URL(`api/repo?project=${encodeURIComponent(project.id)}`, monitor.localUrl), { headers: auth })).json() as { digest?: string };
    const phoneHead = await git(repo, 'rev-parse', 'HEAD');
    // smoke3 spends this minute's remote-action budget to prove the 429; that
    // refusal is not the one under test here.
    clearActionWindowForSmoke();
    const phone = await fetch(new URL('api/repo/commit', monitor.localUrl), {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ project: project.id, digest: reading.digest, message: 'Commit from the phone' }),
    });
    const phoneAnswer = await phone.json() as { error?: string; secrets?: boolean };
    const phoneText = JSON.stringify(phoneAnswer);
    check(phone.status === 409 && phoneAnswer.secrets === true && /A phone cannot acknowledge a possible secret/.test(phoneAnswer.error ?? '')
      && await git(repo, 'rev-parse', 'HEAD') === phoneHead,
    "the phone's commit route refuses a change set carrying a possible secret, says a phone cannot acknowledge one, and commits nothing",
    `${phone.status} ${phoneText}`);
    check(phone.status === 409 && !phoneText.includes('README') && !phoneText.includes(stripe.slice(8, 20)) && !phoneText.includes(base),
      'and the refusal it sends carries no path, no excerpt and no part of the value', phoneText);
    await git(repo, 'checkout', '-q', '--', 'README.md');

    /* ── the ledger chain ──────────────────────────────────────────── */
    policy.recordDecision({ sessionId: 'smoke17', projectId: null, projectPath: base, trust: 'project' },
      { tool_name: 'Bash', tool_input: { command: 'echo chained' } } as HookInput,
      { decision: 'ask', rule: 'smoke17.chain', reason: 'The accountability smoke writes one decision through the policy writer.' });
    const newest = db().prepare('SELECT id, prev_hash, hash FROM policy_ledger ORDER BY id DESC LIMIT 1').get() as { id: number; prev_hash: string | null; hash: string | null };
    const live = await verifyLedger();
    check(/^[0-9a-f]{64}$/.test(newest.hash ?? '') && /^[0-9a-f]{64}$/.test(newest.prev_hash ?? '')
      && live.firstBreak === null && live.chained > 0 && live.verifiedThrough === live.chained && live.lastVerifiedId === newest.id,
    "a decision recorded through the policy writer is chained, and the app's own ledger verifies through it", JSON.stringify({ newest, live }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    const liveSigned = await verifyLedger();
    check(liveSigned.signature.state === 'signed' && liveSigned.signature.lastId === newest.id,
      'the head is signed shortly after that write, without the writer waiting on the key', JSON.stringify(liveSigned.signature));

    const ledgerFile = path.join(base, 'pre-chain.db');
    ledgerDb = new Database(ledgerFile);
    const old = ledgerDb;
    // The policy_ledger table exactly as it was before the chain.
    old.exec(`CREATE TABLE policy_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, session_id TEXT, project_id TEXT, trust TEXT NOT NULL,
      tool_name TEXT NOT NULL, summary TEXT NOT NULL, decision TEXT NOT NULL, rule TEXT NOT NULL, reason TEXT NOT NULL)`);
    const oldInsert = old.prepare('INSERT INTO policy_ledger (at, session_id, project_id, trust, tool_name, summary, decision, rule, reason) VALUES (?,?,?,?,?,?,?,?,?)');
    oldInsert.run(1_757_000_000_000, 's-old', null, 'project', 'Bash', 'npm test', 'allow', 'project.command', 'before the chain');
    oldInsert.run(1_757_000_001_000, 's-old', null, 'project', 'Write', '/etc/hosts', 'deny', 'project.outside', 'before the chain');
    migrateSchema(old);
    const columns = (old.prepare('PRAGMA table_info(policy_ledger)').all() as { name: string }[]).map((c) => c.name);
    const preRows = old.prepare('SELECT COUNT(*) AS n FROM policy_ledger WHERE hash IS NULL AND prev_hash IS NULL').get() as { n: number };
    check(columns.includes('prev_hash') && columns.includes('hash') && preRows.n === 2,
      'the migration adds prev_hash and hash to an existing ledger and leaves the rows already in it as they were', JSON.stringify({ columns, preRows }));
    const fields = (i: number): LedgerRecordedFields => ({
      at: 1_757_000_100_000 + i * 1000, session_id: `s-${i}`, project_id: null, trust: 'project', tool_name: 'Bash',
      summary: `chained ${i}`, decision: i % 2 ? 'ask' : 'allow', rule: 'project.command', reason: `after the chain ${i}`,
    });
    const chainedIds = [0, 1, 2, 3].map((i) => appendLedgerRow(fields(i), old));
    const fresh = await verifyLedger(old);
    check(fresh.unchainedBefore === 2 && fresh.chained === 4 && fresh.verifiedThrough === 4 && fresh.firstBreak === null && fresh.total === 6,
      'records from before the migration are reported as before the chain began and never counted as verified, and the four written after it verify',
      JSON.stringify(fresh));
    const signing = await signLedgerHead(old);
    const signed = await verifyLedger(old);
    check(signing.signed && signed.signature.state === 'signed' && signed.signature.lastId === chainedIds[3] && signed.signature.count === 4,
      'the head is signed with the Ed25519 ledger key, and the stored signature checks against the chain as it stands', JSON.stringify({ signing, signature: signed.signature }));

    const script = path.join(appRoot(), 'scripts', 'verify-ledger.mjs');
    const offline = (...args: string[]) => {
      const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      let report: { ok?: boolean; verifiedThrough?: number; unchainedBefore?: number; firstBreak?: { id: number; kind: string } | null;
        signature?: { valid?: boolean | null; pinMatches?: boolean | null }; problems?: string[] } = {};
      try { report = JSON.parse(r.stdout) as typeof report; } catch { /* reported through the check's detail */ }
      return { status: r.status, report, text: `${r.stdout}${r.stderr}`.slice(0, 600) };
    };
    const exportFile = path.join(base, 'ledger.jsonl');
    const exported = await policy.exportLedger(exportFile, old);
    const good = offline(exportFile, '--json', '--fingerprint', signed.keyFingerprint ?? '');
    check(exported === 6 && good.status === 0 && good.report.ok === true && good.report.signature?.valid === true && good.report.signature.pinMatches === true
      && good.report.verifiedThrough === 4 && good.report.unchainedBefore === 2,
    'scripts/verify-ledger.mjs, a separate process with only node:crypto, recomputes the exported chain and verifies its signature against the pinned key', good.text);

    const lines = fs.readFileSync(exportFile, 'utf8').split('\n').filter(Boolean);
    const editedAt = lines.findIndex((line) => (JSON.parse(line) as { id?: number }).id === chainedIds[2]);
    const tampered = path.join(base, 'ledger-edited.jsonl');
    fs.writeFileSync(tampered, lines.map((line, i) => (i === editedAt ? line.replace('"chained 2"', '"chained 2, tidied"') : line)).join('\n') + '\n');
    const bad = offline(tampered, '--json');
    check(bad.status === 1 && bad.report.firstBreak?.id === chainedIds[2] && bad.report.firstBreak.kind === 'content',
      'an export edited after it was written fails the offline check, at the record that was edited', bad.text);

    old.prepare('UPDATE policy_ledger SET summary = ? WHERE id = ?').run('rm -rf nothing-to-see', chainedIds[1]);
    const edited = await verifyLedger(old);
    check(edited.firstBreak?.id === chainedIds[1] && edited.firstBreak.kind === 'content' && edited.verifiedThrough === 1 && edited.unchainedBefore === 2,
      'a row changed directly in SQLite is found at that row, and only the chained record before it is still called verified', JSON.stringify(edited.firstBreak));

    // The careful version of the same edit: every hash from that row on recomputed.
    let prev = (old.prepare('SELECT hash FROM policy_ledger WHERE id = ?').get(chainedIds[0]) as { hash: string }).hash;
    for (const row of old.prepare('SELECT * FROM policy_ledger WHERE id >= ? ORDER BY id').all(chainedIds[1]) as LedgerChainRow[]) {
      const hash = sha256Hex(ledgerHashInput(prev, row));
      old.prepare('UPDATE policy_ledger SET prev_hash = ?, hash = ? WHERE id = ?').run(prev, hash, row.id);
      prev = hash;
    }
    const rewritten = await verifyLedger(old);
    check(rewritten.firstBreak === null && rewritten.signature.state === 'mismatch',
      'a rewrite that recomputes every hash after the edit passes the chain walk but not the signed head, which reports the mismatch', JSON.stringify(rewritten.signature));
    appendLedgerRow(fields(4), old);
    const after = await signLedgerHead(old);
    const still = await verifyLedger(old);
    check(!after.signed && still.signature.state === 'mismatch',
      'the next write does not sign over the rewrite: the stale head is kept, and the mismatch is still reported', JSON.stringify({ after, signature: still.signature }));
    const rewrittenExport = path.join(base, 'ledger-rewritten.jsonl');
    await policy.exportLedger(rewrittenExport, old);
    const laundered = offline(rewrittenExport, '--json');
    check(laundered.status === 1 && (laundered.report.problems ?? []).some((p) => /signed head no longer matched/.test(p)),
      "exporting the rewritten ledger does not launder it: the export's signature carries the mismatch, and the offline check fails on it", laundered.text);

    /* ── Assisted-by trailers ──────────────────────────────────────── */
    const since = Number(await git(repo, 'show', '-s', '--format=%ct', 'HEAD')) * 1000;
    const insert = db().prepare(`INSERT INTO session_log
      (id, provider_id, project_id, project_path, project_name, model, started_at, ended_at, harness_id, worktree, origin)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const seed = (id: string, row: { provider: string; harness: string | null; model: string | null; dir: string; worktree?: string | null;
      started: number; ended: number | null; origin?: string }) => {
      insert.run(id, row.provider, project.id, row.dir, 'work', row.model, row.started, row.ended, row.harness, row.worktree ?? null, row.origin ?? 'wanigan');
      seeded.push(id);
    };
    seed('smoke17-opus-a', { provider: 'claude', harness: 'claude-code', model: 'claude-opus-5', dir: repo, started: since - 30_000, ended: null });
    seed('smoke17-opus-b', { provider: 'claude', harness: 'claude-code', model: 'claude-opus-5', dir: repo, started: since - 10_000, ended: null });
    seed('smoke17-codex', { provider: 'codex', harness: 'codex', model: 'gpt-5-codex', dir: repo, started: since - 20_000, ended: null });
    seed('smoke17-elsewhere', { provider: 'claude', harness: 'claude-code', model: 'claude-sonnet-5', dir: path.join(base, 'elsewhere'), started: since - 5_000, ended: null });
    seed('smoke17-worktree', { provider: 'claude', harness: 'claude-code', model: 'claude-sonnet-5', dir: repo, worktree: path.join(base, 'worktrees', 'agent'), started: since - 5_000, ended: null });
    seed('smoke17-earlier', { provider: 'claude', harness: 'claude-code', model: 'claude-haiku-5', dir: repo, started: since - 600_000, ended: since - 300_000 });
    seed('smoke17-foreign', { provider: 'claude', harness: 'claude-code', model: 'claude-haiku-5', dir: repo, started: since - 5_000, ended: null, origin: 'observed' });
    const expected = ['Assisted-by: Claude Code (claude-opus-5)', 'Assisted-by: Codex (gpt-5-codex)'];

    setUserPreference('assisted_by_trailers', '0');
    const changelog = path.join(repo, 'CHANGELOG.md');
    fs.writeFileSync(changelog, 'one\n');
    await git(repo, 'add', 'CHANGELOG.md');
    const offPreview = await assistedByPreview(repo);
    const offCommit = await attempt(() => commitChecked(repo, 'Changelog, attribution off', { trailers: [] }));
    const offBody = await git(repo, 'log', '-1', '--format=%B');
    check(!offPreview.enabled && offPreview.trailers.length === 0 && offCommit === null && !/Assisted-by/i.test(offBody),
      'with the setting off, no trailer is derived and the commit carries none, although recorded sessions ran in this checkout',
      JSON.stringify({ offPreview, offCommit, offBody }));

    setUserPreference('assisted_by_trailers', '1');
    fs.writeFileSync(changelog, 'one\ntwo\n');
    await git(repo, 'add', 'CHANGELOG.md');
    const onSince = Number(await git(repo, 'show', '-s', '--format=%ct', 'HEAD')) * 1000;
    const onPreview = await assistedByPreview(repo);
    check(onPreview.enabled && JSON.stringify(onPreview.trailers) === JSON.stringify(expected) && onPreview.sessions === 3 && onPreview.since === onSince,
      'with it on, one Assisted-by line is derived per distinct agent and model among sessions recorded in this checkout since the last commit; other directories, other worktrees, earlier sessions and unrecorded ones are left out',
      JSON.stringify(onPreview));
    const onHead = await git(repo, 'rev-parse', 'HEAD');
    const shortList = await attempt(() => commitChecked(repo, 'Changelog two', { trailers: [expected[0]] }));
    check(shortList !== null && /changed after they were shown/.test(shortList) && await git(repo, 'rev-parse', 'HEAD') === onHead,
      'a commit whose trailer list differs from what main derives now is refused, so the commit box can never commit lines it did not show', shortList);
    const onCommit = await attempt(() => commitChecked(repo, 'Changelog two', { trailers: onPreview.trailers }));
    const values = (await git(repo, 'log', '-1', '--format=%(trailers:key=Assisted-by,valueonly)')).split('\n').filter(Boolean);
    check(onCommit === null && JSON.stringify(values) === JSON.stringify(['Claude Code (claude-opus-5)', 'Codex (gpt-5-codex)']),
      'the commit made with the displayed list ends with exactly those Assisted-by trailers, as git itself parses them', JSON.stringify({ onCommit, values }));

    setUserPreference('assisted_by_trailers', '0');
    fs.writeFileSync(changelog, 'one\ntwo\nthree\n');
    await git(repo, 'add', 'CHANGELOG.md');
    const offAgain = await attempt(() => commitChecked(repo, 'Changelog three', { trailers: expected }));
    check(offAgain !== null && /switched off/.test(offAgain),
      'lines sent while the setting is off are refused rather than committed', offAgain);

    const mainSrc = fs.readFileSync(path.join(appRoot(), 'src', 'main', 'index.ts'), 'utf8');
    check(/handle\('git:commit',[^\n]*commitChecked\(gitRoot\(root\)/.test(mainSrc) && /handle\('git:push',[^\n]*pushChecked\(gitRoot\(root\)/.test(mainSrc),
      'the commit and push IPC handlers call the guarded functions exercised above rather than reaching git directly');
  } catch (e) {
    check(false, 'the accountability smoke ran to its end without throwing', e instanceof Error ? e.stack : String(e));
  } finally {
    if (monitorStarted) {
      setSetting('mobile_repository_review', '0');
      setSetting('mobile_dashboard_enabled', '0');
      mobile.stopMobileMonitor();
    }
    setSetting('assisted_by_trailers', '0');
    for (const id of seeded) db().prepare('DELETE FROM session_log WHERE id = ?').run(id);
    try { ledgerDb?.close(); } catch { /* already closed */ }
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function appRoot(): string {
  const a = app.getAppPath();
  return fs.existsSync(path.join(a, 'src', 'main')) ? a : process.cwd();
}

async function unusedLoopbackPort(): Promise<number> {
  const listener = createNetServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => resolve());
  });
  const address = listener.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  if (!port) throw new Error('The OS did not assign a loopback port for the accountability smoke.');
  return port;
}
