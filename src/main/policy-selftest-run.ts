import fs from 'node:fs';
import path from 'node:path';
import { db } from './db';
import { runGateSelfTest } from '../shared/policy-selftest';
import type { GateSelfTestRun } from '../shared/types';

/**
 * The gate's fixture corpus, run in the process that enforces it.
 *
 * `npm run test:shared` proves the corpus passes against the source; this
 * proves it against the build that is running, with this process's own path
 * resolver on the path. It is cheap — a few dozen evaluations with no I/O the
 * synthetic paths can reach — so it runs at every start, and a failure is
 * written down and shown in Settings rather than logged and forgotten.
 */

function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      return path.join(fs.realpathSync(cur), ...[...rest].reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
  return p;
}

export function runAndRecordGateSelfTest(): GateSelfTestRun {
  const at = Date.now();
  const result = runGateSelfTest(realish);
  const failures = JSON.stringify({ failures: result.failures, uncovered: result.uncovered });
  let id = 0;
  try {
    id = Number(db().prepare('INSERT INTO policy_selftest_runs (at, rules, passed, failures_json) VALUES (?,?,?,?)')
      .run(at, result.rules, result.passed, failures).lastInsertRowid);
  } catch {
    // Unrecorded is still reported: the caller gets the result either way.
  }
  return { id, at, rules: result.rules, passed: result.passed, failures: result.failures, uncovered: result.uncovered };
}

export function latestGateSelfTest(): GateSelfTestRun | null {
  const row = db().prepare('SELECT id, at, rules, passed, failures_json FROM policy_selftest_runs ORDER BY at DESC, id DESC LIMIT 1')
    .get() as { id: number; at: number; rules: number; passed: number; failures_json: string } | undefined;
  if (!row) return null;
  let parsed: { failures?: GateSelfTestRun['failures']; uncovered?: string[] } = {};
  try { parsed = JSON.parse(row.failures_json) as typeof parsed; } catch { /* shown as unreadable below */ }
  return {
    id: row.id, at: row.at, rules: row.rules, passed: row.passed,
    failures: Array.isArray(parsed.failures) ? parsed.failures : [],
    uncovered: Array.isArray(parsed.uncovered) ? parsed.uncovered : [],
  };
}
