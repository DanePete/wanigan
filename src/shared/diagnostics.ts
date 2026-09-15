/**
 * A diagnostics bundle, the pure half: what goes in, and how it is scrubbed.
 *
 * Wanigan has no telemetry, so when something goes wrong the only way to show
 * someone else what this Mac looks like is a file the operator saves on
 * purpose. The rule for that file is the rule for everything Wanigan exports:
 * counts and shapes, never contents. No transcript, no prompt, no row of any
 * table, no credential, no value of any setting whose name says it is secret.
 * The operator sees the exact file list before the save dialog opens.
 */

export type DiagnosticsFile = {
  name: string;
  /** One line saying what is in it, and what is deliberately not. */
  describes: string;
  bytes: number;
};

export type DiagnosticsPreview = {
  files: DiagnosticsFile[];
  /** What is left out on purpose, said in the preview and in the bundle's README. */
  excluded: string[];
};

export const EXCLUDED = [
  'transcripts, prompts and agent output',
  'the contents of any database row',
  'API keys, tokens, pairing secrets and provider credentials',
  'environment variable values from provider manifests',
] as const;

const SECRET_KEY = /(token|secret|password|passwd|credential|api[_-]?key|private|auth|cookie|topic|vapid|pairing|session[_-]?id|endpoint)/i;

/**
 * Deep-copy a JSON value, replacing the value of any key whose name reads as
 * secret, and the operator's home directory in any string with `~`. Strings
 * are also passed through `redact` (the main-process credential redactor),
 * which the caller supplies so this file stays free of main imports.
 */
export function scrubForDiagnostics(value: unknown, home: string, redact: (s: string) => string, depth = 0): unknown {
  if (depth > 12) return '[too deep]';
  if (typeof value === 'string') {
    const withoutHome = home ? value.split(home).join('~') : value;
    return redact(withoutHome).slice(0, 2000);
  }
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => scrubForDiagnostics(item, home, redact, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) && inner !== null && inner !== '' && typeof inner !== 'boolean'
        ? '[redacted]'
        : scrubForDiagnostics(inner, home, redact, depth + 1);
    }
    return out;
  }
  return value;
}

/** The last `n` lines of a log, for the one file that is text. */
export function lastLines(text: string, n: number): string {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n') + (lines.length ? '\n' : '');
}

/** A bundle file name is fixed by Wanigan and never comes from the renderer. */
export function isBundleName(name: string): boolean {
  return /^[a-z0-9][a-z0-9.-]{0,60}\.(json|txt)$/.test(name);
}
