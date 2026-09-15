/**
 * `codex doctor --json`, read strictly.
 *
 * Verified on Codex 0.154.0: `doctor --json` "emits a redacted machine-readable
 * report" shaped `{ schemaVersion: 1, generatedAt, overallStatus, codexVersion,
 * checks: { <id>: { id, category, status, summary, details, remediation,
 * durationMs } } }`, with status `ok`, `warning` or `fail`, and exits 1 when
 * any check fails — so a non-zero exit with a well-formed report is a report,
 * not a crash. The unauthenticated home (no auth.json) is the zero case worth
 * testing: it fails `auth.credentials` and passes nearly everything else.
 *
 * A report whose schemaVersion is not 1, or whose checks do not have the shape,
 * is `unreadable` with the reason, never an empty list of checks: "no failing
 * checks" is a claim only a readable report can make.
 */

export type DoctorCheck = {
  id: string;
  category: string | null;
  status: string;
  summary: string;
  remediation: string | null;
};

export type DoctorReport =
  | {
      state: 'report';
      overall: string;
      codexVersion: string | null;
      checks: DoctorCheck[];
      failing: DoctorCheck[];
      warnings: DoctorCheck[];
    }
  | { state: 'unreadable'; reason: string }
  | { state: 'summary-text'; text: string; note: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCodexDoctor(stdout: string): DoctorReport {
  const text = stdout.trim();
  if (!text) return { state: 'unreadable', reason: 'codex doctor printed nothing.' };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { state: 'unreadable', reason: 'codex doctor --json did not print JSON.' }; }
  if (!isRecord(parsed)) return { state: 'unreadable', reason: 'codex doctor --json printed something other than a report object.' };
  if (parsed.schemaVersion !== 1) {
    return { state: 'unreadable', reason: `codex doctor reported schemaVersion ${JSON.stringify(parsed.schemaVersion)}; Wanigan reads version 1 only, so the format may have changed.` };
  }
  if (!isRecord(parsed.checks)) return { state: 'unreadable', reason: 'The doctor report has no checks object.' };
  const checks: DoctorCheck[] = [];
  for (const [key, raw] of Object.entries(parsed.checks)) {
    if (!isRecord(raw) || typeof raw.status !== 'string' || typeof raw.summary !== 'string') {
      return { state: 'unreadable', reason: `The doctor check "${key}" does not have a status and a summary.` };
    }
    checks.push({
      id: typeof raw.id === 'string' ? raw.id : key,
      category: typeof raw.category === 'string' ? raw.category : null,
      status: raw.status,
      summary: raw.summary,
      remediation: typeof raw.remediation === 'string' ? raw.remediation : null,
    });
  }
  if (!checks.length) return { state: 'unreadable', reason: 'The doctor report lists no checks at all.' };
  checks.sort((a, b) => a.id.localeCompare(b.id));
  return {
    state: 'report',
    overall: typeof parsed.overallStatus === 'string' ? parsed.overallStatus : 'unknown',
    codexVersion: typeof parsed.codexVersion === 'string' ? parsed.codexVersion : null,
    checks,
    failing: checks.filter((c) => c.status === 'fail' || c.status === 'error'),
    warnings: checks.filter((c) => c.status === 'warning' || c.status === 'warn'),
  };
}

/** An older Codex without `--json` says so on stderr; that is when the summary fallback runs. */
export function doctorFlagMissing(stderr: string): boolean {
  return /unexpected argument '--json'|unrecognized (?:option|argument).*--json/i.test(stderr);
}
