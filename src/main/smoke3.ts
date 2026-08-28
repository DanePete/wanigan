import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as worktrees from './worktrees';
import * as transcripts from './transcripts';
import * as notify from './notify';
import * as spend from './spend';
import * as evals from './batch/evals';
import * as cachediag from './batch/cachediag';
import * as mcpRegistry from './mcp/registry';
import * as ctxConfig from './context/config';
import * as schedule from './schedule';
import type { RunConfig } from '../shared/types';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

const baseCfg = (over: Partial<RunConfig> = {}): RunConfig => ({
  name: 'smoke', model: 'claude-sonnet-5', maxTokens: 1024,
  system: [{ text: 'You are a classifier.', cache: true }],
  userTemplate: 'Classify {{text}}', cacheTtl: '5m',
  source: { kind: 'jsonl', text: '{"text":"a"}' },
  ...over,
});

/**
 * Second verification pass: the subsystems the lifecycle smoke never reaches.
 * Everything here is offline and spends nothing — a test suite that needs an
 * API key is a test suite nobody runs.
 */
export async function runPhaseSmoke2(check: Check, say: Say): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-p2-'));

  /* ── phase 9 · worktrees against a real repo ───────────────────────── */
  say('── phase 9 · worktrees');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString();
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'smoke@foreman.test');
    git('config', 'user.name', 'Smoke');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'first');

    const root = await worktrees.repoRootFor(repo);
    check(root !== null && fs.existsSync(root), 'the repo root resolves');

    const wt = await worktrees.createWorktree(repo, 'smoke', 's_smoke');
    check(fs.existsSync(wt.path), `a worktree was created at ${path.basename(wt.path)}`);
    // Outside the repo on purpose: a worktree inside it shows up in the repo's
    // own listings and globs, and an agent will find it and get confused.
    check(!path.resolve(wt.path).startsWith(path.resolve(repo) + path.sep),
      'the worktree lives outside the repo it belongs to');
    check((wt.branch ?? '').includes('foreman/'), 'the branch is namespaced to Foreman', wt.branch);

    const listed = await worktrees.listWorktrees(repo);
    check(listed.some((w) => w.path === wt.path), 'the worktree is listed by git');

    // Refusing to destroy uncommitted work is the whole safety property.
    fs.writeFileSync(path.join(wt.path, 'dirty.txt'), 'unsaved\n');
    const refused = await worktrees.removeWorktree(wt.path, false);
    check(!refused.removed, 'a dirty worktree is not removed without force');
    check(/\d/.test(refused.detail), 'the refusal names how many files would be lost', refused.detail);

    const forced = await worktrees.removeWorktree(wt.path, true);
    check(forced.removed, 'force removes it');
  } catch (e) {
    check(false, `worktree suite threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  /* ── phase 4 · transcript search survives hostile input ────────────── */
  say('── phase 4 · transcripts');
  check(transcripts.transcriptPathFor(path.join(tmp, 'nope'), null) === null,
    'a project with no transcript returns null rather than throwing');
  // A bare quote or a lone * is an FTS5 syntax error. Users type apostrophes.
  for (const q of ["it's", '*', '"', 'a AND', 'NEAR(']) {
    let threw = false;
    try { transcripts.searchTranscripts(q, 5); } catch { threw = true; }
    check(!threw, `search survives the query ${JSON.stringify(q)}`);
  }

  /* ── phase 14 · the polling curve and webhook signatures ───────────── */
  say('── phase 14 · polling and webhooks');
  const now = Date.now();
  const fresh = notify.pollIntervalFor(now - 5 * 60_000, now - 60_000, now);
  const old = notify.pollIntervalFor(now - 6 * 3600_000, now - 3 * 3600_000, now);
  check(fresh < old, 'polling is tighter in the first hour than after six', `${fresh}ms vs ${old}ms`);
  const nearExpiry = notify.pollIntervalFor(now - 23.7 * 3600_000, now - 3 * 3600_000, now);
  check(nearExpiry < old, 'polling tightens again as the 24-hour expiry approaches', `${nearExpiry}ms`);

  // A webhook secret is `whsec_` plus base64 key material, and the HMAC is over
  // the DECODED bytes — signing with the printable string is the classic
  // integration bug, so the test signs the way a real sender would.
  // Standard Webhooks: the signed content is {id}.{timestamp}.{body}, and the
  // key is the base64 payload after `whsec_`. Signing the printable secret, or
  // omitting the id, is the pair of mistakes that make a receiver reject every
  // genuine delivery — so the test signs exactly the way Anthropic does.
  const keyBytes = crypto.randomBytes(24);
  const secret = 'whsec_' + keyBytes.toString('base64');
  const body = '{"type":"batch.ended"}';
  const wid = 'msg_01SmokeWebhookId';
  const ts = String(Math.floor(Date.now() / 1000));
  const signWith = (id: string, t: string) =>
    crypto.createHmac('sha256', keyBytes).update(`${id}.${t}.${body}`).digest('hex');
  const sig = signWith(wid, ts);
  check(notify.verifyWebhookSignature(secret, wid, ts, body, sig), 'a correct webhook signature verifies');
  check(!notify.verifyWebhookSignature(secret, wid, ts, body, sig.replace(/.$/, '0')),
    'a tampered signature is rejected');
  check(!notify.verifyWebhookSignature(secret, 'msg_01Different', ts, body, sig),
    'a signature bound to a different webhook id is rejected');
  const oldTs = String(Math.floor(Date.now() / 1000) - 3600);
  check(!notify.verifyWebhookSignature(secret, wid, oldTs, body, signWith(wid, oldTs)),
    'a replayed old timestamp is rejected even with a valid signature');

  /* ── phase 18 · budgets ────────────────────────────────────────────── */
  say('── phase 18 · budgets');
  spend.setBudget(null, 25, 0.8);
  const g = spend.budgetState(null);
  check(g.monthlyUsd === 25, 'a global budget is stored and read back', g.monthlyUsd);
  check(g.daysInMonth >= 28 && g.daysElapsed >= 1, 'the month is measured for the projection',
    `${g.daysElapsed}/${g.daysInMonth}`);
  check(typeof g.projectedUsd === 'number' && Number.isFinite(g.projectedUsd),
    'month-end spend is projected from the run rate');
  spend.setBudget(null, 0);

  /* ── phase 16 · cache diagnosis ────────────────────────────────────── */
  say('── phase 16 · cache diagnosis');
  const min = cachediag.minimumCacheablePrefix('claude-sonnet-5');
  check(min >= 512, 'a minimum cacheable prefix is known for the model', min);
  const ttl = cachediag.recommendedTtl(baseCfg(), 20_000);
  check(ttl.ttl === '1h', 'a large batch is recommended the 1-hour TTL', ttl.ttl);
  check(ttl.why.length > 20, 'the recommendation explains itself', ttl.why);

  /* ── phase 17 · single-variable enforcement ────────────────────────── */
  say('── phase 17 · evals');
  const one = evals.variableBetween(baseCfg(), baseCfg({ model: 'claude-opus-5' }));
  check(one.variable === 'model', 'a single differing field is identified', one.variable);
  const two = evals.variableBetween(baseCfg(), baseCfg({ model: 'claude-opus-5', effort: 'max' }));
  check(two.variable === null && two.differences.length === 2,
    'two differing fields yield no single variable — the comparison is uninterpretable',
    two.differences);
  const same = evals.variableBetween(baseCfg(), baseCfg());
  check(same.differences.length === 0, 'identical configs differ in nothing');

  /* ── phase 12 · MCP registry ───────────────────────────────────────── */
  say('── phase 12 · MCP registry');
  const srv = mcpRegistry.upsertServer({
    projectId: null, name: 'smoke-fs', transport: 'stdio',
    command: 'echo', args: 'hello', enabled: true,
  });
  check(mcpRegistry.listServers(null).some((x) => x.id === srv.id), 'an MCP server is stored');
  const cfgPath = mcpRegistry.writeMcpConfig(null, tmp);
  check(cfgPath !== null && fs.existsSync(cfgPath), 'an .mcp.json-shaped config is generated');
  if (cfgPath) {
    // Never into the user's repo: the config belongs to Foreman's own storage.
    check(!path.resolve(cfgPath).startsWith(path.resolve(tmp) + path.sep),
      'the generated MCP config is written outside the project');
  }
  mcpRegistry.removeServer(srv.id);
  check(!mcpRegistry.listServers(null).some((x) => x.id === srv.id), 'it can be removed again');

  /* ── phase 23 · settings precedence ────────────────────────────────── */
  say('── phase 23 · settings precedence');
  const proj = path.join(tmp, 'cfgproj');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'),
    JSON.stringify({ model: 'from-project', cleanupPeriodDays: 5 }));
  fs.writeFileSync(path.join(proj, '.claude', 'settings.local.json'),
    JSON.stringify({ model: 'from-local' }));
  const pc = ctxConfig.readProjectConfig(proj);
  const model = pc.settings.find((x) => x.key === 'model');
  check(model?.from === 'local', 'local settings win over project settings', model?.from);
  check((model?.shadowed ?? []).some((s) => s.from === 'project'),
    'the panel can say what the winning layer overrode');

  const budget = ctxConfig.contextBudget(proj, []);
  check(budget.estTokens === 0 && /estimate/i.test(budget.note),
    'an empty context costs nothing and still says it is an estimate');

  /* ── phase 25 · durable schedules ──────────────────────────────────── */
  say('── phase 25 · schedules');

  // A cron parser is the kind of code that looks right and is off by an hour.
  const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
  const fire = (expr: string, from: number) => schedule.nextFire(expr, from);
  const iso = (t: number | null) => (t === null ? 'never' : new Date(t).toLocaleString());

  check(fire('*/15 * * * *', at(2026, 6, 1, 9, 7)) === at(2026, 6, 1, 9, 15), 'a step lands on the next multiple');
  check(fire('0 9 * * *', at(2026, 6, 1, 9, 30)) === at(2026, 6, 2, 9, 0), 'a daily job past its time waits for tomorrow');
  check(fire('0 9 * * 1-5', at(2026, 6, 6, 12, 0)) === at(2026, 6, 8, 9, 0), 'a weekday job skips the weekend', iso(fire('0 9 * * 1-5', at(2026, 6, 6, 12, 0))));
  check(fire('30 14 15 3 *', at(2026, 4, 1, 0, 0)) === at(2027, 3, 15, 14, 30), 'an annual date rolls to next year');
  // Sunday is both 0 and 7 in vixie-cron, and getting that wrong shifts a
  // weekly job by a day without ever failing loudly.
  check(fire('0 8 * * 7', at(2026, 6, 1, 0, 0)) === fire('0 8 * * 0', at(2026, 6, 1, 0, 0)), '7 and 0 both mean Sunday');
  // When both day fields are constrained, either matching counts.
  const both = fire('0 0 1 * 5', at(2026, 5, 2, 0, 0));
  check(both === at(2026, 5, 8, 0, 0), 'day-of-month OR day-of-week, not AND', iso(both));
  check(fire('0 0 30 2 *', Date.now()) === null, '30 February never fires, and says so');

  for (const bad of ['* * * *', '61 * * * *', '* 25 * * *', 'every minute', '*/0 * * * *']) {
    let threw = false;
    try { schedule.parseCron(bad); } catch { threw = true; }
    check(threw, `"${bad}" is rejected rather than stored`);
  }

  check(schedule.describeCron('*/15 * * * *').includes('15'), 'a step reads as words');
  check(/weekday/i.test(schedule.describeCron('0 9 * * 1-5')), 'weekdays read as words', schedule.describeCron('0 9 * * 1-5'));

  const sch = schedule.createSchedule({
    name: 'smoke nightly audit', cron: '0 3 * * *', kind: 'headless',
    payload: { prompt: 'audit' }, projectId: null,
  });
  check(sch.nextAt !== null && sch.nextAt > Date.now(), 'a new schedule is armed for the future');
  check(schedule.listSchedules().some((x) => x.id === sch.id), 'it is listed');
  const off = schedule.setScheduleEnabled(sch.id, false);
  check(off?.enabled === false && off?.nextAt === null, 'disabling disarms it rather than leaving it primed');
  const on = schedule.setScheduleEnabled(sch.id, true);
  check(on?.nextAt !== null && (on?.nextAt ?? 0) > Date.now(), 're-enabling re-arms from now, not from the backlog');

  let rejected = false;
  try { schedule.createSchedule({ name: 'bad', cron: '0 0 31 2 *', kind: 'headless', payload: {} }); }
  catch { rejected = true; }
  check(rejected, 'a schedule that can never fire is refused at creation');

  check(schedule.deleteSchedule(sch.id), 'it can be deleted');

  fs.rmSync(tmp, { recursive: true, force: true });
}
