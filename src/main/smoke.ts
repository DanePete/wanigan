import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as batch from './batch';
import { addProject, listProjects } from './store';
import type { RunConfig } from '../shared/types';

/**
 * Full batch lifecycle against the mock runner, run inside the real Electron
 * main process so it exercises the actual SQLite, IPC-facing functions and
 * native modules the app uses. No network, no spend.
 *
 *   npm run smoke
 */
let pass = 0, fail = 0;

/**
 * A macOS .app bundle's stdout is not connected to the launching shell, so
 * console.log from Electron main vanishes when piped. Everything is mirrored to
 * WANIGAN_SMOKE_LOG, which the shell script prints once the process exits.
 */
const LOG = process.env.WANIGAN_SMOKE_LOG;
function say(line: string) {
  console.log(line);
  if (LOG) { try { fs.appendFileSync(LOG, line + '\n'); } catch { /* best effort */ } }
}

// A smoke process has no window and therefore no natural operator escape
// hatch. Keep a generous, deterministic ceiling so an accidental future
// await cannot strand an Electron main process during test runs.
const SMOKE_SUITE_TIMEOUT_MS = 180_000;
setTimeout(() => {
  say(`\nFATAL: smoke suite exceeded ${SMOKE_SUITE_TIMEOUT_MS / 1000}s; exiting instead of leaving a headless Electron process.`);
  // Unlike app.exit(), this cannot be intercepted by the attended-app quit
  // drain. The smoke profile and its output are both temporary.
  process.exit(1);
}, SMOKE_SUITE_TIMEOUT_MS);

const ok = (m: string) => { say(`  \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m: string, d?: unknown) => {
  say(`  \x1b[31m✗\x1b[0m ${m}`);
  if (d !== undefined) say(`      ${String(d).slice(0, 300)}`);
  fail++;
};
const check = (cond: unknown, m: string, d?: unknown) => (cond ? ok(m) : bad(m, d));

const CSV = `id,city,venue
1,"Ithaca, NY","Barton Hall"
2,"Veneta, OR","Old Renaissance Faire Grounds"
3,"Cornell","Barton Hall"`;

function cfg(over: Partial<RunConfig> = {}): RunConfig {
  return {
    name: 'smoke run',
    model: 'claude-sonnet-5',
    maxTokens: 512,
    cacheTtl: '1h',
    keyColumn: 'id',
    system: [{ text: 'You normalise venue names. '.repeat(60), cache: true }],
    userTemplate: 'Venue: {{venue}} in {{city}}',
    source: { kind: 'csv', text: CSV },
    ...over,
  };
}

async function expectThrow(fn: () => Promise<unknown>, needle: string, label: string) {
  try { await fn(); bad(label, 'no error thrown'); }
  catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    check(m.includes(needle), label, m);
  }
}

export async function runSmoke(): Promise<void> {
  say('\nWanigan — batch lifecycle smoke (mock runner, no API calls)\n');

  say('── environment');
  check(process.env.WANIGAN_MOCK === '1', 'mock mode active');
  const p = batch.presetsFor();
  check(p.presets.length >= 3, 'presets served', p.presets.length);
  check(p.models.length >= 5, 'model table served', p.models.length);

  say('── shared project list');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-smoke-'));
  const proj = await addProject(tmp);
  check(listProjects().some((x) => x.id === proj.id), 'project added to the shared list');
  const resolved = batch.presetsFor(proj.id);
  const repoAudit = resolved.presets.find((x: { id: string }) => x.id === 'repo-audit');
  check(!JSON.stringify(resolved.presets).includes('{{PROJECT_PATH}}'), 'preset placeholder resolved to the project');
  check(repoAudit?.config.source.root?.startsWith(tmp), 'repo-audit preset points at the chosen project', repoAudit?.config.source.root);

  say('── dataset');
  const pv = await batch.previewSource({ kind: 'csv', text: CSV }, 'Venue: {{venue}} in {{city}}');
  check(pv.rowCount === 3, 'CSV parsed: 3 rows', pv.rowCount);
  check(pv.columns.join(',') === 'id,city,venue', 'columns detected', pv.columns);
  check(String(pv.rows[0].city) === 'Ithaca, NY', 'quoted field with comma preserved', pv.rows[0].city);
  check(pv.missingSlots.length === 0, 'no unresolved slots');
  const bad1 = await batch.previewSource({ kind: 'csv', text: CSV }, '{{ghost}}');
  check(bad1.missingSlots[0] === 'ghost', 'unresolved slot is caught');

  say('── pre-flight');
  const est = await batch.estimateRun(cfg());
  check(est.estimate?.requests === 3, 'estimate covers every row', est.estimate?.requests);
  check((est.estimate?.costHighUsd ?? 0) > 0, 'cost estimated');
  check((est.estimate?.cachedPrefixTokens ?? 0) > 0, 'cached prefix measured');
  const dr = await batch.dryRunOne(cfg());
  check(dr.result?.ok === true, 'dry run passes', JSON.stringify(dr.result));

  say('── guard rails');
  await expectThrow(() => batch.createAndSubmitRun(cfg({ maxTokens: 0 })),
    'max_tokens must be at least 1', 'max_tokens 0 refused before submit');
  await expectThrow(() => batch.createAndSubmitRun(cfg({ userTemplate: '{{ghost}}' })),
    'does not have', 'unresolved slot refused before submit');
  await expectThrow(() => batch.createAndSubmitRun(cfg({ maxTokens: 999_999 })),
    'exceeds', 'over-cap max_tokens refused');

  say('── submit and poll');
  const sub = await batch.createAndSubmitRun(cfg({ projectId: proj.id }));
  check(Boolean(sub.runId), `submitted: ${sub.runId}`);
  let d = batch.runDetail(sub.runId);
  check(d.run.project_id === proj.id, 'run is linked to the project');

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await batch.pollOnce();
    d = batch.runDetail(sub.runId);
    if (d.run.status === 'ended') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check(d.run.status === 'ended', "run reached 'ended'", d.run.status);
  check((d.counts.succeeded ?? 0) >= 1, `${d.counts.succeeded ?? 0} succeeded`);
  check(d.run.cost_usd > 0, 'actual cost rolled up from usage', d.run.cost_usd);
  check((d.batches[0] as { results_ingested_at: number | null }).results_ingested_at !== null, 'results ingested');

  say('── results');
  const all = batch.runResults(sub.runId, 'all', '', 0);
  check(all.total === 3, 'all rows indexed', all.total);
  const first = all.rows[0] as { custom_id: string; rendered: string };
  check(first.custom_id.startsWith('r0-'), 'custom_id keyed to source column', first.custom_id);
  check(first.rendered.includes('Barton Hall'), 'input preserved beside output');
  check(batch.runResults(sub.runId, 'all', 'Veneta', 0).total === 1, 'search filters rows');

  say('── dead-letter queue (real failures)');
  const rows = ['id,city,venue'];
  for (let i = 1; i <= 40; i++) rows.push(`${i},City${i},Venue${i}`);
  const big = await batch.createAndSubmitRun(cfg({ name: 'smoke dlq', source: { kind: 'csv', text: rows.join('\n') } }));
  const dl = Date.now() + 30_000;
  let bd = batch.runDetail(big.runId);
  while (Date.now() < dl) {
    await batch.pollOnce();
    bd = batch.runDetail(big.runId);
    if (bd.run.status === 'ended') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const errored = bd.counts.errored ?? 0;
  check(errored >= 1, `${errored} request(s) errored as expected`);
  if (errored >= 1) {
    const child = await batch.retryFailed(big.runId);
    const cd = batch.runDetail(child.runId);
    check(cd.run.parent_run_id === big.runId, 'child links back to parent');
    check(cd.run.total_requests === errored, `retry contains exactly the ${errored} failed row(s), not all 40`, cd.run.total_requests);
  }

  say('── deletion safety');
  const live = await batch.createAndSubmitRun(cfg({ name: 'smoke delete guard' }));
  await expectThrow(async () => batch.deleteRun(live.runId),
    'Cancel the run before deleting', 'in-flight run cannot be silently deleted');

  // Everything above is the batch pipeline. Phases 1-24 are exercised here,
  // in the same real main process, because compiling is not working.
  try {
    const { runPhaseSmoke } = await import('./smoke2');
    await runPhaseSmoke(check, say);
    const { runPhaseSmoke2 } = await import('./smoke3');
    await runPhaseSmoke2(check, say);
    const { runLearningSmoke } = await import('./smoke4');
    await runLearningSmoke(check, say);
  } catch (e) {
    check(false, `phase smoke threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  say(`\n════ ${pass} passed, ${fail} failed ════\n`);
  app.exit(fail === 0 ? 0 : 1);
}
