/**
 * Spend by source, the part that needs no database. The attribute values are
 * the ones the 2.1.270 binary puts on its cost and token metrics: query_source
 * main/subagent/auxiliary, and the `custom` / `third-party` words it uses in
 * place of a name it will not log.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupSpend, spendKeyLabel, spendReport, type SpendSourceRow } from './spend-sources.ts';

const row = (over: Partial<SpendSourceRow>): SpendSourceRow => ({
  metric: 'cost', tokenType: '', querySource: 'main', agent: '', skill: '', plugin: '', mcpServer: '',
  value: 0, unverified: false, ...over,
});

const ROWS: SpendSourceRow[] = [
  row({ value: 2.5 }),
  row({ metric: 'tokens', tokenType: 'input', value: 1000 }),
  row({ metric: 'tokens', tokenType: 'output', value: 200 }),
  row({ querySource: 'subagent', agent: 'custom', value: 1.25 }),
  row({ querySource: 'subagent', agent: 'custom', metric: 'tokens', tokenType: 'cacheRead', value: 5000 }),
  row({ querySource: 'auxiliary', value: 0.1 }),
  row({ querySource: 'main', skill: 'third-party', plugin: 'third-party', value: 0.4 }),
  row({ querySource: 'main', mcpServer: 'custom', value: 0.3, unverified: true }),
  row({ querySource: '', value: 0.05 }),
];

test('the main, subagent and auxiliary split adds back to the whole, with unattributed spend kept as its own row', () => {
  const groups = groupSpend(ROWS, 'source');
  assert.deepEqual(groups.map((g) => [g.key, Math.round(g.costUsd * 100) / 100]), [
    ['main', 2.9], ['subagent', 1.25], ['auxiliary', 0.1], ['', 0.05],
  ]);
  const report = spendReport(ROWS, 30, 0);
  const sum = groups.reduce((a, g) => a + g.costUsd, 0);
  assert.equal(Math.round(sum * 100), Math.round(report.totals.costUsd * 100));
});

test('tokens are split by the CLI’s token types and carried beside the dollars', () => {
  const [main] = groupSpend(ROWS, 'source');
  assert.equal(main.inTokens, 1000);
  assert.equal(main.outTokens, 200);
  const subagent = groupSpend(ROWS, 'agent').find((g) => g.key === 'custom')!;
  assert.equal(subagent.cacheReadTokens, 5000);
});

test('dollars from a backend nobody bills at that price are kept apart from the estimate', () => {
  const mcp = groupSpend(ROWS, 'mcp').find((g) => g.key === 'custom')!;
  assert.equal(mcp.costUsd, 0);
  assert.equal(mcp.unverifiedUsd, 0.3);
  assert.equal(spendReport(ROWS, 30, 0).totals.unverifiedUsd, 0.3);
});

test('every dimension accounts for every row', () => {
  const report = spendReport(ROWS, 30, 0);
  for (const groups of Object.values(report.groups)) {
    const cost = groups.reduce((a, g) => a + g.costUsd + g.unverifiedUsd, 0);
    assert.equal(Math.round(cost * 100), Math.round((report.totals.costUsd + report.totals.unverifiedUsd) * 100));
  }
});

test('withheld names are said as withheld, and each empty key says which absence it is', () => {
  assert.equal(spendKeyLabel('agent', 'custom'), 'custom — name withheld by the CLI');
  assert.equal(spendKeyLabel('plugin', 'third-party'), 'third-party — name withheld by the CLI');
  assert.equal(spendKeyLabel('source', ''), 'not reported');
  assert.equal(spendKeyLabel('skill', ''), 'no skill');
  assert.equal(spendKeyLabel('skill', 'code-review'), 'code-review');
});

test('no rows is an empty report, not a zero bill with groups in it', () => {
  const report = spendReport([], 7, 0);
  assert.equal(report.rows, 0);
  assert.deepEqual(report.groups.source, []);
});
