import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { db } from './db';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/*
 * Helper sweep · P9 — second opinions. A real repository, real git, the real
 * database and headless.ts's real spawn, supervision and ledger writes, with the
 * agent CLI replaced by a stand-in shell script that prints a canned reply. The
 * stand-in is the only binary a read-only call will start in mock mode, and with
 * none registered the call refuses: no provider, no network, no spend.
 */

function repoFixture(prefix: string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'smoke@wanigan.test');
  git('config', 'user.name', 'Smoke');
  return { dir, git, write };
}

const STAND_IN = `#!/bin/sh
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
printf '%s\\n' "$@" > "$WANIGAN_OPINION_ARGV"
pwd > "$WANIGAN_OPINION_CWD"
ls -A >> "$WANIGAN_OPINION_CWD"
if [ -n "$WANIGAN_OPINION_STDOUT" ]; then cat "$WANIGAN_OPINION_STDOUT"; fi
if [ -n "$out" ] && [ -n "$WANIGAN_OPINION_LAST" ]; then cat "$WANIGAN_OPINION_LAST" > "$out"; fi
exit 0
`;

export async function runSecondOpinionSmoke(check: Check, say: Say): Promise<void> {
  say('── second opinions · consent, the read-only call, adjudication, decisions, the ledger');
  const repo = repoFixture('wanigan-opinions-');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-opinions-standin-'));
  const { addProject, removeProject } = await import('./store');
  const headless = await import('./headless');
  const opinions = await import('./second-opinions');
  const shared = await import('../shared/second-opinions');
  const { formatReviewSubmission } = await import('../shared/review-marks');
  const priorEnv = { argv: process.env.WANIGAN_OPINION_ARGV, cwd: process.env.WANIGAN_OPINION_CWD, out: process.env.WANIGAN_OPINION_STDOUT, last: process.env.WANIGAN_OPINION_LAST };
  let projectId: string | null = null;
  try {
    const standIn = path.join(tmp, 'stand-in-cli');
    fs.writeFileSync(standIn, STAND_IN, { mode: 0o755 });
    const argvFile = path.join(tmp, 'argv.txt');
    const cwdFile = path.join(tmp, 'cwd.txt');
    const stdoutFile = path.join(tmp, 'stdout.json');
    const lastFile = path.join(tmp, 'last.txt');
    process.env.WANIGAN_OPINION_ARGV = argvFile;
    process.env.WANIGAN_OPINION_CWD = cwdFile;
    process.env.WANIGAN_OPINION_STDOUT = stdoutFile;
    process.env.WANIGAN_OPINION_LAST = lastFile;

    // With no stand-in registered, mock mode refuses rather than reaching for a real CLI.
    let refusedBare = '';
    try {
      await headless.runReadOnlyCall({ name: 'x', providerId: 'claude', fingerprint: (await import('./providers')).providerById('claude')?.profileFingerprint ?? '',
        projectId: null, rowId: 'x', rowLabel: 'x', cwd: tmp, prompt: 'x', schema: {}, maxBudgetUsd: 1, timeoutMs: 5_000, meta: {} });
    } catch (e) { refusedBare = String(e); }
    check(/no stand-in CLI is registered, so no agent was started/.test(refusedBare),
      'in mock mode a read-only call with no stand-in registered refuses instead of starting a real, paid CLI', refusedBare);

    // A session that changed three files; the operator had edited one before launch.
    repo.write('src/cart.ts', 'export function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i.price;\n  return sum;\n}\n');
    repo.write('src/old.ts', 'export const legacy = true;\n');
    repo.write('notes.md', '# notes\n');
    // Rules scoped to src/: the review payload carries them for src/cart.ts and src/retry.ts, cited.
    repo.write('src/AGENTS.md', '# src\n\n## Code Review Rules\n\n- Round money once, at the edge, never inside a loop.\n');
    repo.git('add', '-A'); repo.git('commit', '-qm', 'base');
    const base = repo.git('rev-parse', 'HEAD').trim();
    const project = await addProject(repo.dir);
    projectId = project.id;
    repo.write('notes.md', '# notes\nmine, before launch\n');
    const sid = `p9-opinions-${Date.now()}`;
    const now = Date.now();
    db().prepare(`INSERT INTO session_log (id, conversation_id, provider_id, harness_id, backend_id, project_id, project_path, project_name, started_at, ended_at, exit_code, worktree, baseline_head, baseline_dirty_json, initial_prompt, title)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sid, null, 'claude', 'claude-code', 'anthropic', project.id, repo.dir, path.basename(repo.dir),
      now - 60_000, now - 1_000, 0, null, base, JSON.stringify(['notes.md']), 'Make the cart total respect quantity. password=hunter2', 'Cart totals');
    repo.write('src/cart.ts', 'export function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i.price * i.qty;\n  if (sum > 1000) sum *= 0.9;\n  return Math.round(sum);\n}\n');
    repo.write('src/retry.ts', 'export async function retry(fn) {\n  for (let i = 0; i < 5; i++) { try { return await fn(); } catch { /* again */ } }\n}\nconst API_KEY = "sk-live-abcdefghijklmnop";\n');
    fs.rmSync(path.join(repo.dir, 'src/old.ts'));

    /* ── profiles and the preview ──────────────────────────────────────── */
    const profiles = await opinions.opinionProfiles(sid, 'review');
    const byId = Object.fromEntries(profiles.map((p) => [p.providerId, p]));
    check(!!byId.claude && !!byId.codex && byId.claude.harness === 'claude-code' && byId.codex.harness === 'codex',
      'a second review is offered to Claude Code and Codex profiles, including the vendor that did not write the code', profiles.map((p) => p.providerId));
    check(byId.claude.cap.kind === 'usd' && byId.codex.cap.kind === 'timeout-only' && byId.claude.vendor === 'Anthropic' && byId.codex.vendor === 'OpenAI',
      'a Claude profile carries a dollar cap and a Codex profile a timeout only, each naming its vendor', [byId.claude.cap, byId.codex.cap, byId.codex.vendor]);
    check(byId.claude.metering === 'unproven' && byId.claude.refusal === null,
      'a profile that has never run a second opinion is unproven, not assumed priced, and is offered');

    const preview = await opinions.previewOpinion({ sessionId: sid, kind: 'review', providerId: 'claude', maxBudgetUsd: 0.75 });
    check(preview.refusal === null && preview.sends.files === 3 && preview.sends.preexistingLeftOut === 1 && preview.sends.capBytes === shared.OPINION_LIMITS.diffBytes
      && preview.sends.sentBytes > 0 && preview.sends.sentBytes === preview.sends.diffBytes && !preview.sends.truncated,
      'the preview counts the files and bytes sent, leaves out the operator\'s pre-launch edit, and states the cap', preview.sends);
    check(/Anthropic receives it/.test(preview.statements.vendor) && /\$0\.75 \(--max-budget-usd\)/.test(preview.statements.cap)
      && /^No other file from this session or repository, no transcript, no MCP server, and no tool/.test(preview.statements.nothingElse) && /^This is billed\./.test(preview.statements.billed),
      'the preview states the vendor, the dollar cap, that nothing else is sent, and that it is billed', preview.statements);
    check(/1 line holding something shaped like a credential is replaced with \[REDACTED\]/.test(preview.statements.environment),
      'a credential in the diff is counted in the preview and redacted before sending', preview.statements.environment);
    check(preview.argv.includes('--disallowedTools') && preview.argv.includes('--strict-mcp-config') && preview.argv.includes('--max-budget-usd')
      && preview.argv.includes('<the payload described above>') && !preview.argv.some((a) => a.includes('retry(fn)')),
      'the argv on the consent screen is the real one with the payload elided', preview.argv);

    check(preview.sends.reviewRules === 1,
      'the Code Review Rules covering the changed files are counted in what the preview says it sends', preview.sends.reviewRules);
    const codexPreview = await opinions.previewOpinion({ sessionId: sid, kind: 'review', providerId: 'codex' });
    check(/Codex has no spending cap Wanigan can set\. Wanigan stops it after 10 minutes/.test(codexPreview.statements.cap)
      && /blocks writes but not reads/.test(codexPreview.statements.nothingElse),
      'a Codex preview says honestly that no hard cap exists and a timeout applies, and what its sandbox does not stop', codexPreview.statements);

    let bad = '';
    try { await opinions.previewOpinion({ sessionId: sid, kind: 'review', providerId: 'claude', maxBudgetUsd: 500 }); } catch (e) { bad = String(e); }
    const overCap = await opinions.previewOpinion({ sessionId: sid, kind: 'review', providerId: 'claude', maxBudgetUsd: 500 });
    check(!bad && /A cap is between/.test(overCap.refusal ?? ''), 'a cap outside the allowed range is a refusal on the preview, not a clamp', overCap.refusal);

    /* ── consent refusals: nothing is written, nothing is started ─────── */
    const runsBefore = (db().prepare("SELECT COUNT(*) AS n FROM runs WHERE kind='headless'").get() as { n: number }).n;
    const opinionRowsBefore = (db().prepare('SELECT COUNT(*) AS n FROM second_opinion_runs').get() as { n: number }).n;
    let refused = '';
    try { await opinions.startOpinion({ sessionId: sid, kind: 'review', providerId: 'claude', maxBudgetUsd: 0.75, digest: 'f'.repeat(64), fingerprint: preview.profile.fingerprint }, async () => true); }
    catch (e) { refused = String(e); }
    check(/changed after the dialog was drawn\. Nothing was sent/.test(refused), 'a confirm carrying a digest other than the preview\'s is refused', refused);
    refused = '';
    let asked = 0;
    try {
      await opinions.startOpinion({ sessionId: sid, kind: 'review', providerId: 'claude', maxBudgetUsd: 0.75, digest: preview.digest, fingerprint: preview.profile.fingerprint },
        async (q) => { asked += 1; check(/Send .* of this session's diff to Anthropic/.test(q.message) && /This is billed/.test(q.detail), 'main\'s own confirmation names the vendor, the size and that it is billed', q); return false; });
    } catch (e) { refused = String(e); }
    check(asked === 1 && /Cancelled\. Nothing was sent\./.test(refused), 'declining main\'s native confirmation cancels the call', refused);
    const runsAfterRefusals = (db().prepare("SELECT COUNT(*) AS n FROM runs WHERE kind='headless'").get() as { n: number }).n;
    const opinionRowsAfter = (db().prepare('SELECT COUNT(*) AS n FROM second_opinion_runs').get() as { n: number }).n;
    check(runsAfterRefusals === runsBefore && opinionRowsAfter === opinionRowsBefore && !fs.existsSync(argvFile),
      'a refused or cancelled call writes no run, no opinion row, and starts no process');

    /* ── a Claude review: the call, the record, the cost ────────────────── */
    headless.useReadOnlyCallStandIn(standIn, '2.1.271 (Claude Code)');
    fs.writeFileSync(stdoutFile, JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'Structured output provided successfully',
      structured_output: {
        verdict: 'needs-attention',
        findings: [
          { file: 'src/cart.ts', line_start: 4, line_end: 5, severity: 'high', title: 'Discount applied before rounding', body: 'Round first, then discount.', confidence: 0.8 },
          { file: 'src/retry.ts', line_start: 2, line_end: 2, severity: 'medium', title: 'Every error is swallowed', body: 'The last error is lost.', confidence: 0.6 },
          { file: 'src/payments.ts', line_start: 9, line_end: 9, severity: 'low', title: 'Invented file', body: 'Not in the diff.', confidence: 0.2 },
        ],
      },
      total_cost_usd: 0.0421, usage: { input_tokens: 5200, output_tokens: 610 },
    }));
    const started = await opinions.startOpinion({ sessionId: sid, kind: 'review', providerId: 'claude', maxBudgetUsd: 0.75, digest: preview.digest, fingerprint: preview.profile.fingerprint }, async () => true);
    await opinions.settled(started.runId);
    const argv = fs.readFileSync(argvFile, 'utf8');
    const lines = argv.split('\n');
    check(lines[0] === '-p' && lines.includes('--json-schema') && lines.includes('--no-session-persistence') && lines.includes('--strict-mcp-config')
      && lines[lines.indexOf('--max-budget-usd') + 1] === '0.75' && lines[lines.indexOf('--output-format') + 1] === 'json',
      'the Claude call runs -p with the JSON output format, the schema flag its version supports, no MCP servers, and the agreed dollar cap', lines.filter((l) => l.startsWith('--')));
    check(argv.includes('## Code review rules for this scope') && argv.includes('- Round money once, at the edge, never inside a loop. (src/AGENTS.md › Code Review Rules)'),
      'the prompt carries the scoped rule, cited by the file and heading it came from', argv.slice(0, 300));
    const denied = lines[lines.indexOf('--disallowedTools') + 1] ?? '';
    check(['Read', 'Bash', 'Write', 'Edit', 'WebFetch', 'Task', 'Agent'].every((t) => denied.split(',').includes(t)) && !lines.includes('--dangerously-skip-permissions'),
      'every tool Wanigan can name is denied, reads included, so the reviewer has only the payload', denied);
    check(argv.includes('+  if (sum > 1000) sum *= 0.9;') && argv.includes('+const API_KEY = [REDACTED];') && !argv.includes('sk-live-abcdefghijklmnop')
      && !argv.includes('mine, before launch'),
      'the prompt carries the session\'s diff with its credential redacted, and not the operator\'s pre-launch edit', null);
    const cwdSeen = fs.readFileSync(cwdFile, 'utf8').trim().split('\n');
    check(cwdSeen[0].includes(path.join('second-opinions', started.runId)) && cwdSeen.slice(1).join(',') === 'payload.txt'
      && !fs.existsSync(cwdSeen[0]),
      'the call ran in a scratch folder holding only the payload, and the folder is gone afterwards', cwdSeen);

    let runs = await opinions.opinionRuns(sid);
    let run = runs.find((r) => r.id === started.runId);
    check(run?.status === 'done' && run.verdict === 'needs-attention' && run.findings.length === 3 && run.structuredFlag === 'json-schema',
      'the reply is read from the structured output and stored as three findings with the verdict', run && { status: run.status, n: run.findings.length, flag: run.structuredFlag });
    check(run?.costReported === true && Math.abs((run.costUsd ?? 0) - 0.0421) < 1e-9 && run.costText === '$0.04' && run.inTokens === 5200,
      'the run\'s cost is read from its headless row, as the CLI reported it', run && [run.costUsd, run.costText]);
    const hrow = db().prepare('SELECT status, cost_usd, cost_reported, output, project_path FROM headless_rows WHERE run_id = ?').get(run?.headlessRunId ?? '') as
      { status: string; cost_usd: number; cost_reported: number; output: string; project_path: string } | undefined;
    const hrun = db().prepare('SELECT kind, status, config_json, cost_usd FROM runs WHERE id = ?').get(run?.headlessRunId ?? '') as { kind: string; status: string; config_json: string; cost_usd: number } | undefined;
    check(hrow?.status === 'succeeded' && hrow.cost_reported === 1 && hrun?.kind === 'headless' && hrun.status === 'ended' && Math.abs(hrun.cost_usd - 0.0421) < 1e-9,
      'the call is a headless run like any other: one succeeded row, the run ended, its cost rolled up where Runs and Insights read it', [hrow?.status, hrun?.status]);
    const stored = JSON.stringify(db().prepare('SELECT * FROM second_opinion_runs WHERE id = ?').get(started.runId)) + (hrun?.config_json ?? '') + (hrow?.output ?? '');
    check(!stored.includes('sum *= 0.9') && !stored.includes('Make the cart total') && /"diff_sha256":"[0-9a-f]{64}"/.test(stored) && run?.sentBytes === preview.sends.sentBytes,
      'the diff sent is recorded as its hash and size — not stored again in the opinion row, the run\'s config or the headless row', null);
    check(run?.findings.find((f) => f.file === 'src/payments.ts')?.located === 'not-in-diff' && run.findings.find((f) => f.file === 'src/cart.ts')?.located === 'lines-in-diff',
      'each finding is located against the diff: an invented file reads as not in the diff', run?.findings.map((f) => [f.file, f.located]));

    // Adjudication, and the confirmed ones into the review message.
    const [cartFinding, retryFinding, fakeFinding] = run!.findings;
    opinions.adjudicate(cartFinding.id, 'confirmed');
    opinions.adjudicate(retryFinding.id, 'refuted');
    opinions.adjudicate(fakeFinding.id, 'confirmed');
    let badVerdict = '';
    try { opinions.adjudicate(cartFinding.id, 'approved'); } catch (e) { badVerdict = String(e); }
    check(/confirmed, refuted, not sure/.test(badVerdict), 'a verdict other than confirmed, refuted or not sure is refused', badVerdict);
    runs = await opinions.opinionRuns(sid);
    run = runs.find((r) => r.id === started.runId);
    const work = await import('./review-work');
    const index = shared.indexDiff((await work.reviewPatch(sid)).patch);
    const notes = run!.findings.map((f) => shared.findingNote(f, index, run!.profileLabel)).filter((n): n is NonNullable<typeof n> => n !== null);
    const message = formatReviewSubmission({ anchor: "this session's changes against base", files: [], marks: [], lineNotes: notes });
    check(notes.length === 1 && message.ok && /`src\/cart\.ts`, lines 4–5:/.test(message.text) && /second review by Claude Code, confirmed by the operator/.test(message.text)
      && !/Every error is swallowed/.test(message.ok ? message.text : ''),
      'only a confirmed finding on the diff joins the review message, anchored to its lines and cited to the reviewer', message.ok ? message.text : message);

    /* ── a reply that could not be read ────────────────────────────────── */
    fs.writeFileSync(stdoutFile, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Looks fine to me, ship it.', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } }));
    const p2 = await opinions.previewOpinion({ sessionId: sid, kind: 'review', providerId: 'claude' });
    const unreadable = await opinions.startOpinion({ sessionId: sid, kind: 'review', providerId: 'claude', digest: p2.digest, fingerprint: p2.profile.fingerprint }, async () => true);
    await opinions.settled(unreadable.runId);
    run = (await opinions.opinionRuns(sid)).find((r) => r.id === unreadable.runId);
    check(run?.status === 'unreadable' && /no JSON object/.test(run.reason ?? '') && run.raw === 'Looks fine to me, ship it.' && run.findings.length === 0 && run.costText === '$0.01',
      'a reply with no readable findings is kept raw with the reason, and its cost is still recorded', run && [run.status, run.reason, run.raw]);

    /* ── a Codex review: unpriced, timeout only ─────────────────────────── */
    headless.useReadOnlyCallStandIn(standIn, 'codex-cli 0.154.0');
    fs.writeFileSync(stdoutFile, [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4100, cached_input_tokens: 0, output_tokens: 390 } }),
    ].join('\n'));
    fs.writeFileSync(lastFile, JSON.stringify({ verdict: 'approve', findings: [] }));
    const cp = await opinions.previewOpinion({ sessionId: sid, kind: 'review', providerId: 'codex' });
    const codexRun = await opinions.startOpinion({ sessionId: sid, kind: 'review', providerId: 'codex', digest: cp.digest, fingerprint: cp.profile.fingerprint }, async () => true);
    await opinions.settled(codexRun.runId);
    const cargv = fs.readFileSync(argvFile, 'utf8').split('\n');
    check(cargv[0] === 'exec' && cargv[cargv.indexOf('--sandbox') + 1] === 'read-only' && cargv.includes('--output-schema') && cargv.includes('--output-last-message')
      && cargv.includes('--ephemeral') && !cargv.includes('--max-budget-usd') && !cargv.some((a) => /dangerously/.test(a)),
      'the Codex call is codex exec in its read-only sandbox with an output schema and no cap flag', cargv.filter((l) => l.startsWith('-')));
    run = (await opinions.opinionRuns(sid)).find((r) => r.id === codexRun.runId);
    check(run?.status === 'done' && run.verdict === 'approve' && run.findings.length === 0 && run.costText === 'unpriced' && run.inTokens === 4100,
      'a Codex review reads its last message, records its tokens, and says "unpriced" rather than a dollar figure', run && [run.status, run.costText, run.inTokens]);
    const codexProfile = (await opinions.opinionProfiles(sid, 'review')).find((p) => p.providerId === 'codex');
    check(codexProfile?.metering === 'unpriced' && codexProfile.refusal === null,
      'a profile that reported tokens and no price is unpriced, and still offered for an explicit per-run call', codexProfile?.metering);

    headless.useReadOnlyCallStandIn(standIn, 'codex-cli 0.120.0');
    const old = await opinions.previewOpinion({ sessionId: sid, kind: 'review', providerId: 'codex' });
    const rowsBeforeOld = (db().prepare('SELECT COUNT(*) AS n FROM second_opinion_runs').get() as { n: number }).n;
    let oldRefused = '';
    try { await opinions.startOpinion({ sessionId: sid, kind: 'review', providerId: 'codex', digest: old.digest, fingerprint: old.profile.fingerprint }, async () => true); }
    catch (e) { oldRefused = String(e); }
    check(/checked its read-only sandbox and schema flags on 0\.154\.0 and later only/.test(old.refusal ?? '') && /0\.154\.0 and later only/.test(oldRefused)
      && (db().prepare('SELECT COUNT(*) AS n FROM second_opinion_runs').get() as { n: number }).n === rowsBeforeOld,
      'a Codex older than the version its read-only flags were checked on is refused on the preview, and nothing is written or started', old.refusal);

    /* ── an unmetered harness is refused by name ────────────────────────── */
    headless.useReadOnlyCallStandIn(standIn, '2.1.271 (Claude Code)');
    fs.writeFileSync(stdoutFile, JSON.stringify({ type: 'result', is_error: false, result: '{"verdict":"approve","findings":[]}' }));
    const gp = await opinions.previewOpinion({ sessionId: sid, kind: 'review', providerId: 'glm' });
    const glmRun = await opinions.startOpinion({ sessionId: sid, kind: 'review', providerId: 'glm', digest: gp.digest, fingerprint: gp.profile.fingerprint }, async () => true);
    await opinions.settled(glmRun.runId);
    const glmAfter = (await opinions.opinionProfiles(sid, 'review')).find((p) => p.providerId === 'glm');
    let unmetered = '';
    try {
      const again = await opinions.previewOpinion({ sessionId: sid, kind: 'review', providerId: 'glm' });
      await opinions.startOpinion({ sessionId: sid, kind: 'review', providerId: 'glm', digest: again.digest, fingerprint: again.profile.fingerprint }, async () => true);
    } catch (e) { unmetered = String(e); }
    check(glmAfter?.metering === 'unmetered' && /GLM · Z\.ai returned no usage figures/.test(glmAfter.refusal ?? '') && /GLM · Z\.ai returned no usage figures/.test(unmetered),
      'a harness whose completed run reported neither dollars nor tokens is proven unmetered by that run and refused by name', [glmAfter?.metering, unmetered]);

    /* ── decisions nobody asked for: same backend, locations checked ────── */
    const dProfiles = await opinions.opinionProfiles(sid, 'decisions');
    const dById = Object.fromEntries(dProfiles.map((p) => [p.providerId, p]));
    check(dById.claude?.refusal === null && dById.claude.sameBackend && /stay with the backend that processed them/.test(dById.codex?.refusal ?? ''),
      'the decisions search is offered only on the backend the session ran on; every other backend is refused with the reason', dProfiles.map((p) => [p.providerId, p.refusal]));
    let crossBackend = '';
    try {
      const x = await opinions.previewOpinion({ sessionId: sid, kind: 'decisions', providerId: 'codex' });
      await opinions.startOpinion({ sessionId: sid, kind: 'decisions', providerId: 'codex', digest: x.digest, fingerprint: x.profile.fingerprint }, async () => true);
    } catch (e) { crossBackend = String(e); }
    check(/stay with the backend/.test(crossBackend), 'a cross-backend decisions call is refused in main, whatever the renderer sends', crossBackend);

    const dp = await opinions.previewOpinion({ sessionId: sid, kind: 'decisions', providerId: 'claude' });
    check(dp.refusal === null && dp.sends.messages?.sent === 1 && dp.statements.nothingElse.includes('beyond your messages'),
      'the decisions preview counts the operator\'s messages it sends', dp.sends.messages);
    fs.writeFileSync(stdoutFile, JSON.stringify({
      type: 'result', is_error: false, result: '', total_cost_usd: 0.031, usage: { input_tokens: 3000, output_tokens: 200 },
      structured_output: { entries: [
        { decision: 'A 10% discount on totals over 1000', why_it_matters: 'A pricing rule nobody asked for.', touches: ['src/cart.ts:4', 'src/cart.ts:90'], risk: 'high' },
        { decision: 'Retries five times and swallows errors', why_it_matters: 'Failures disappear.', touches: ['src/retry.ts:2'], risk: 'medium' },
        { decision: 'Adds a payments queue', why_it_matters: 'Invented.', touches: ['src/queue.ts:3'], risk: 'low' },
        { decision: 'Cites nothing at all', why_it_matters: 'Cannot be checked.', touches: [], risk: 'low' },
      ] },
    }));
    const dRun = await opinions.startOpinion({ sessionId: sid, kind: 'decisions', providerId: 'claude', digest: dp.digest, fingerprint: dp.profile.fingerprint }, async () => true);
    await opinions.settled(dRun.runId);
    const dargv = fs.readFileSync(argvFile, 'utf8');
    check(dargv.includes("## The operator's messages (1)") && dargv.includes('Make the cart total respect quantity. password: [REDACTED]') && !dargv.includes('hunter2'),
      'the decisions prompt carries the operator\'s message with its credential redacted', null);
    run = (await opinions.opinionRuns(sid)).find((r) => r.id === dRun.runId);
    check(run?.status === 'done' && run.decisions.length === 2 && run.dropped === 2 && run.unrealTouches === 1
      && run.decisions[0].touches.map((t) => t.raw).join() === 'src/cart.ts:4',
      'entries citing code not in the diff are dropped and counted, and a fake touch on a kept entry is removed', run && { kept: run.decisions.length, dropped: run.dropped, unreal: run.unrealTouches });
    check(shared.droppedSentence(run?.dropped ?? 0) === "2 entries cited code that isn't in the diff and were dropped.",
      'the dropped count reads as the sentence the operator sees');
    const dNote = shared.decisionNote(run!.decisions[0], index, 'Claude Code');
    check(!!dNote && dNote.file === 'src/cart.ts' && dNote.newStart === 4 && /A decision nobody asked for \(high risk\)/.test(dNote.body) && opinions.markDecisionAdded(run!.decisions[0].id),
      'a kept entry becomes an anchored note for the review message, and adding it is recorded', dNote);

    // No messages, no search: every choice would look unrequested.
    const quiet = `${sid}-quiet`;
    db().prepare(`INSERT INTO session_log (id, provider_id, harness_id, backend_id, project_id, project_path, project_name, started_at, ended_at, exit_code, baseline_head, baseline_dirty_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(quiet, 'claude', 'claude-code', 'anthropic', project.id, repo.dir, 'quiet', now - 50_000, now - 900, 0, base, '[]');
    const qp = await opinions.previewOpinion({ sessionId: quiet, kind: 'decisions', providerId: 'claude' });
    check(/No operator message was found/.test(qp.refusal ?? ''), 'a session with no recorded operator message is refused rather than sent with nothing to compare against', qp.refusal);

    /* ── the ledger ────────────────────────────────────────────────────── */
    const ledger = opinions.opinionLedger(sid);
    const reviewRow = ledger.rows.find((r) => r.id === started.runId);
    const decisionRow = ledger.rows.find((r) => r.id === dRun.runId);
    const codexRow = ledger.rows.find((r) => r.id === codexRun.runId);
    check(reviewRow?.confirmed === 2 && reviewRow.refuted === 1 && reviewRow.unsure === 0 && reviewRow.costText === '$0.04'
      && decisionRow?.kept === 2 && decisionRow.dropped === 2 && codexRow?.costText === 'unpriced',
      'the ledger lists both kinds with reviewer, cost or unpriced, adjudication counts and kept/dropped entries', ledger.rows.map((r) => [r.kind, r.profileLabel, r.costText, r.confirmed, r.refuted, r.kept, r.dropped]));
    check(Math.abs(ledger.pricedUsd - (0.0421 + 0.01 + 0.031)) < 1e-9 && ledger.pricedRuns === 3 && ledger.unpricedRuns === 2,
      'its totals sum recorded dollars only and count unpriced and failed runs apart, never as spend', [ledger.pricedUsd, ledger.pricedRuns, ledger.unpricedRuns]);
    check(opinions.opinionLedger().rows.some((r) => r.id === started.runId && r.sessionLabel === 'Cart totals'),
      'the all-sessions ledger for Spend names the session each run was about');
  } catch (error) {
    check(false, 'the second-opinion checks ran without throwing', error instanceof Error ? error.stack : String(error));
  } finally {
    try { headless.useReadOnlyCallStandIn(null); } catch { /* not mock mode */ }
    for (const [key, value] of Object.entries({ WANIGAN_OPINION_ARGV: priorEnv.argv, WANIGAN_OPINION_CWD: priorEnv.cwd, WANIGAN_OPINION_STDOUT: priorEnv.out, WANIGAN_OPINION_LAST: priorEnv.last })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (projectId) { try { removeProject(projectId); } catch { /* temp */ } }
    try { fs.rmSync(repo.dir, { recursive: true, force: true }); } catch { /* temp */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
