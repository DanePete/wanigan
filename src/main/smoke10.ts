import { filterPalette, groupPalette, transcriptHitRow, TRANSCRIPT_RESULT_CAP, type PaletteEntry } from '../shared/palette';
import type { TranscriptHit } from '../shared/types';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Offline contract tests for the palette's pure half: which rows a query
 * keeps, how rows group and count, and how an FTS hit becomes a row. The
 * FTS index itself is covered in smoke3; closures stay in the renderer.
 */
export async function runPaletteSmoke(check: Check, say: Say): Promise<void> {
  say('── command palette · filter, groups, transcript rows');

  const row = (key: string, group: string, extra: Partial<PaletteEntry> = {}): PaletteEntry => ({
    key, title: key, hint: `about ${key}`, meta: 'x', haystack: `${key} words`, group, ...extra,
  });

  try {
    const items = [
      row('git', 'Views'),
      row('sessions', 'Views'),
      row('observation', 'Settings'),
      row('hit-1', 'Transcripts', { prefiltered: true, title: 'proj — agent', hint: '…ran «git» push…' }),
    ];

    const empty = filterPalette(items, '   ');
    check(empty.length === 3 && empty.every((i) => !i.prefiltered),
      'an empty query lists everything except search results, which only exist as answers');

    const matched = filterPalette(items, 'GIT');
    check(matched.map((i) => i.key).join(',') === 'git,hit-1',
      'a query is case-insensitive over title, hint and haystack, and never re-judges a prefiltered row',
      matched.map((i) => i.key).join(','));

    const unrelated = filterPalette(items, 'zzz-no-match');
    check(unrelated.length === 1 && unrelated[0].prefiltered === true,
      'a prefiltered FTS hit survives a substring the palette itself cannot see');

    const groups = groupPalette(filterPalette(items, ''));
    check(groups.map((g) => `${g.label}:${g.items.length}`).join(',') === 'Views:2,Settings:1',
      'groups keep first-appearance order and count their own rows',
      groups.map((g) => `${g.label}:${g.items.length}`).join(','));

    const hit: TranscriptHit = {
      sessionId: 's-1', projectName: 'wanigan', projectPath: '/tmp/x', providerId: 'claude',
      startedAt: Date.parse('2026-08-30T09:00:00Z'), at: Date.parse('2026-08-30T09:05:00Z'),
      role: 'user', snippet: 'before «rm -rf» after',
    };
    const a = transcriptHitRow(hit, 0);
    const b = transcriptHitRow({ ...hit, role: 'assistant' }, 1);
    check(a.key !== b.key && a.prefiltered === true,
      'two hits from one moment get distinct keys and arrive prefiltered');
    check(a.title.includes('wanigan') && a.title.includes('you') && b.title.includes('agent'),
      'the row names the project and who said it', `${a.title} | ${b.title}`);
    check(a.hint === 'before «rm -rf» after',
      'the snippet passes through untouched — the archive\u2019s evidence, not copy');
    check(TRANSCRIPT_RESULT_CAP === 8, 'the palette asks the archive for the number the count line describes');
  } catch (e) {
    check(false, `palette smoke threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}
