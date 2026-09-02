import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeContextUsage, contextUsageFromTail } from './transcripts';
import { claudeContextLabel } from '../shared/provider-status';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Offline contract tests for the context meter. CLAUDE_CONFIG_DIR points the
 * transcript path logic at fixture files, so every honest state — measured,
 * unknown model, sidechain noise, tail bounds, lifetime fallback — runs
 * through the real reader with no agent and no real config touched.
 */
export async function runContextMeterSmoke(check: Check, say: Say): Promise<void> {
  say('── context meter · transcript usage, honest bounds');

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-ctx-'));
  const configDir = path.join(base, 'claude-config');
  const cwd = path.join(base, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const slug = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  const projectDir = path.join(configDir, 'projects', slug);
  const savedEnv = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;

  const usageLine = (tokens: { in: number; read?: number; create?: number; out?: number }, model = 'claude-sonnet-4-5', extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'assistant', timestamp: '2026-09-01T10:00:00Z', ...extra,
      message: {
        role: 'assistant', model,
        usage: {
          input_tokens: tokens.in, cache_read_input_tokens: tokens.read ?? 0,
          cache_creation_input_tokens: tokens.create ?? 0, output_tokens: tokens.out ?? 0,
        },
      },
    });
  const userLine = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  const write = (name: string, lines: string[]) => {
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, name), lines.join('\n') + '\n');
  };

  try {
    const since = Date.now() - 60_000;

    check(claudeContextUsage(cwd, 'conv-a', since).kind === 'no-transcript',
      'no transcript directory at all is an honest no-transcript');

    // ── the ordinary measurement ─────────────────────────────────────
    write('conv-a.jsonl', [
      'this line is not JSON and is tolerated',
      usageLine({ in: 999, out: 1 }),
      userLine('a prompt'),
      usageLine({ in: 4_000, read: 110_000, create: 8_000, out: 2_000 }),
    ]);
    let r = claudeContextUsage(cwd, 'conv-a', since);
    check(r.kind === 'ok' && r.tokens === 124_000,
      'the newest usage record wins and all four token fields are summed', JSON.stringify(r));
    check(r.kind === 'ok' && r.window === 200_000 && r.percent === 62 && r.model === 'claude-sonnet-4-5',
      'a claude-family model reads against the assumed 200k window as 62%', JSON.stringify(r));
    check(r.kind === 'ok' && r.at === Date.parse('2026-09-01T10:00:00Z'),
      'the measurement carries the record\u2019s own timestamp');

    // ── noise that must not become a measurement ─────────────────────
    write('conv-a.jsonl', [
      usageLine({ in: 50_000 }),
      usageLine({ in: 70_000 }, 'claude-sonnet-4-5', { isSidechain: true }),
    ]);
    r = claudeContextUsage(cwd, 'conv-a', since);
    check(r.kind === 'ok' && r.tokens === 50_000,
      'a sidechain (subagent) record is someone else\u2019s context and is skipped', JSON.stringify(r));
    write('conv-a.jsonl', [
      usageLine({ in: 50_000 }),
      usageLine({ in: 0 }, '<synthetic>'),
    ]);
    r = claudeContextUsage(cwd, 'conv-a', since);
    check(r.kind === 'ok' && r.tokens === 50_000,
      'a zero-sum synthetic record is an error line, not a measurement', JSON.stringify(r));

    // ── absences stay absences ───────────────────────────────────────
    write('conv-a.jsonl', [userLine('only prompts so far')]);
    check(claudeContextUsage(cwd, 'conv-a', since).kind === 'no-usage',
      'a transcript with no usage records says so instead of showing zero');
    write('conv-a.jsonl', [usageLine({ in: 42_000 }, 'glm-4.6')]);
    r = claudeContextUsage(cwd, 'conv-a', since);
    check(r.kind === 'ok' && r.tokens === 42_000 && r.window === null && r.percent === null,
      'an unmapped model gets measured tokens and no invented window or percent', JSON.stringify(r));

    // ── the tail bound, both directions ──────────────────────────────
    const padding = Array.from({ length: 400 }, (_, i) => userLine(`pad ${i} ${'x'.repeat(1_000)}`));
    write('conv-a.jsonl', [...padding, usageLine({ in: 77_000 })]);
    r = claudeContextUsage(cwd, 'conv-a', since);
    check(r.kind === 'ok' && r.tokens === 77_000,
      'a usage record near the end of a file larger than the 256 KiB tail is still found', JSON.stringify(r));
    write('conv-a.jsonl', [usageLine({ in: 88_000 }), ...padding]);
    check(claudeContextUsage(cwd, 'conv-a', since).kind === 'no-usage',
      'a record older than the tail is honestly out of reach, not silently stale');

    // ── lifetime-bounded fallback when the exact id is gone ──────────
    write('old.jsonl', [usageLine({ in: 11_000 })]);
    write('new.jsonl', [usageLine({ in: 22_000 })]);
    const old = new Date(Date.now() - 30_000);
    const fresh = new Date(Date.now() - 5_000);
    fs.utimesSync(path.join(projectDir, 'conv-a.jsonl'), old, old);
    fs.utimesSync(path.join(projectDir, 'old.jsonl'), old, old);
    fs.utimesSync(path.join(projectDir, 'new.jsonl'), fresh, fresh);
    r = claudeContextUsage(cwd, 'conv-gone', since);
    check(r.kind === 'ok' && r.tokens === 22_000,
      'a missing conversation id falls back to the newest transcript written in this session\u2019s lifetime', JSON.stringify(r));
    check(claudeContextUsage(cwd, 'conv-gone', Date.now() + 3_600_000 + 300_000).kind === 'no-transcript',
      'a transcript older than the session is never claimed as this session\u2019s context');

    // ── the pure pieces ──────────────────────────────────────────────
    check(contextUsageFromTail('') === null && contextUsageFromTail('not json\n{"broken') === null,
      'empty and malformed tails measure nothing rather than throwing');
    check(claudeContextLabel({ kind: 'ok', tokens: 124_000, window: 200_000, percent: 62, model: 'claude-sonnet-4-5', at: null }) === 'ctx 62% · 124k/200k',
      'the badge label states percent against the window');
    check(claudeContextLabel({ kind: 'ok', tokens: 42_000, window: null, percent: null, model: 'glm-4.6', at: null }) === 'ctx 42k',
      'without a window the label is tokens only');
    check(claudeContextLabel({ kind: 'no-transcript' }) === null && claudeContextLabel(null) === null,
      'absences render as absence, never as a zero meter');
  } catch (e) {
    check(false, `context meter smoke threw: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedEnv;
    fs.rmSync(base, { recursive: true, force: true });
  }
}
