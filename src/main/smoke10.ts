import { filterPalette, groupPalette, transcriptHitRow, TRANSCRIPT_RESULT_CAP, type PaletteEntry } from '../shared/palette';
import type { TranscriptHit } from '../shared/types';
import { COMPOSER_DRAFT_MAX, COMPOSER_DRAFT_TOTAL_CHARS, parseDraftMap, pruneDrafts, putDraft, type ComposerDraftMap } from '../shared/composer-drafts';
import { deriveSendState, observeQueueTargets, queueWatcherWanted, type QueueTargetState } from '../shared/composer-queue';
import { QR_MAX_BYTES, qrMatrix } from '../shared/qr';
import { shouldBumpUnread, applyUnreadCounts } from '../shared/unread';
import type { Session } from '../shared/types';

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

    say('── composer drafts · one bounded key, not one key per session');

    /** The message a call threw, or null if it returned. */
    const thrownMessage = (run: () => unknown): string | null => {
      try { run(); return null; } catch (error) { return error instanceof Error ? error.message : String(error); }
    };

    say('── pairing QR · a code that does not scan is worse than no code');

    // This encoder is hand-written rather than a dependency, so the thing that
    // matters is whether a real camera reads what it emits — not whether it
    // agrees with itself. The fixture below was produced by this encoder and
    // then DECODED BACK by macOS Core Image, an implementation that shares no
    // code with ours: `swift qrdecode.swift` returned the original string for
    // versions 1, 4 and 8 across four different mask patterns. What is pinned
    // here is that exact verified bitmap, so a change to the Reed-Solomon
    // tables, the block interleave or the mask penalty fails loudly instead of
    // shipping a plausible square nobody can scan.
    const qrBits = (m: { size: number; modules: Uint8Array }): string => {
      let bits = '';
      for (let i = 0; i < m.modules.length; i++) bits += m.modules[i] ? '1' : '0';
      return (bits.match(/.{1,4}/g) ?? [])
        .map((nibble) => parseInt(nibble.padEnd(4, '0'), 2).toString(16)).join('');
    };
    const known = qrMatrix('wanigan');
    check(known.version === 1 && known.size === 21 && known.mask === 4
      && qrBits(known) === 'fe8bfc12506e8ebb7555dba8aec16907faafe017008bf7c8e1c19cdce5aa8e38aaf8805763fbb3d04f13ba920dd2c4ee8ca1044c0fecf08',
      'the QR encoder reproduces a bitmap macOS Core Image decoded back to its original string');

    // Version selection is a capacity calculation, and getting it wrong shows up
    // as a code that encodes fewer bytes than it was given.
    const longer = qrMatrix('https://mac.example.ts.net/#token=abc123def456');
    check(longer.version === 4 && longer.size === 33,
      'a longer payload picks the smallest version that actually holds it', longer.version);

    // Refusing beats degrading: an empty symbol and a truncated URL both scan
    // cleanly and both lie about what they carry.
    check(thrownMessage(() => qrMatrix('')) !== null
      && thrownMessage(() => qrMatrix('x'.repeat(QR_MAX_BYTES + 1))) !== null,
      'an empty string and an over-long payload are both refused rather than silently truncated');


    const saved = putDraft({}, 's-1', 'half a prompt', 1_000);
    check(saved['s-1']?.text === 'half a prompt' && saved['s-1']?.at === 1_000,
      'a draft is stored under its session id with the moment it was typed');
    check(!('s-1' in putDraft(saved, 's-1', '', 2_000)) && !('s-1' in putDraft(saved, 's-1', '   ', 2_000)),
      'clearing the box — or leaving only whitespace, which the composer refuses to send — frees the slot instead of holding it');

    const many: ComposerDraftMap = {};
    for (let i = 0; i < 30; i++) many[`s-${i}`] = { text: 'x'.repeat(10), at: 1_000 + i };
    const capped = pruneDrafts(many);
    const ats = Object.values(capped).map((d) => d.at).sort((a, b) => a - b);
    check(Object.keys(capped).length === COMPOSER_DRAFT_MAX && ats[0] === 1_005 && ats[ats.length - 1] === 1_029,
      'thirty drafts prune to the count cap, keeping the newest and dropping the oldest',
      `${Object.keys(capped).length} kept, ${ats[0]}..${ats[ats.length - 1]}`);

    const fat = pruneDrafts({
      old: { text: 'a'.repeat(100_000), at: 1 },
      mid: { text: 'b'.repeat(100_000), at: 2 },
      new: { text: 'c'.repeat(100_000), at: 3 },
    });
    check(Object.keys(fat).length < 3 && 'new' in fat,
      'the character budget evicts before the count does, and never the draft being typed into',
      Object.keys(fat).join(','));
    const alone = pruneDrafts({
      huge: { text: 'a'.repeat(COMPOSER_DRAFT_TOTAL_CHARS + 1), at: 9 },
      other: { text: 'b', at: 1 },
    });
    check(Object.keys(alone).length === 1 && 'huge' in alone,
      'the newest draft survives even when it alone is over budget — losing what is on screen is never the fix');

    check(Object.keys(parseDraftMap(null)).length === 0
      && Object.keys(parseDraftMap('not json')).length === 0
      && Object.keys(parseDraftMap(JSON.stringify({ 's-1': { text: 7, at: 1 } }))).length === 0,
      'a missing, unparseable or malformed key reads as no drafts rather than throwing at the composer');

    say('── composer queue · a send the session can no longer take');

    const dead = deriveSendState({ status: 'exited', attention: 'idle' });
    check(dead.mode === 'blocked' && typeof dead.reason === 'string' && dead.reason.length > 0,
      'a queue aimed at an exited session is blocked, with a sentence saying why rather than a bare disabled button',
      dead);
    check(deriveSendState({ status: 'running', attention: 'idle' }).mode === 'send'
      && deriveSendState({ status: 'running', attention: 'working' }).mode === 'queue',
      'a running agent at its prompt takes the send directly, and a busy one still queues');

    const seenLive = observeQueueTargets(['s-1'], { ok: true, sessions: [{ id: 's-1', status: 'running' }] }, new Map());
    check(seenLive.get('s-1') === 'live' && queueWatcherWanted(['s-1'], seenLive),
      'the two-second drain poll keeps running while the session it is aimed at is alive');

    const seenExited = observeQueueTargets(['s-1'], { ok: true, sessions: [{ id: 's-1', status: 'exited' }] }, seenLive);
    check(seenExited.get('s-1') === 'exited' && !queueWatcherWanted(['s-1'], seenExited),
      'an observed exit stops the poll — an exited session stays in the list, so a missing-id guard would never have fired');

    const seenGone = observeQueueTargets(['s-1'], { ok: true, sessions: [{ id: 's-2', status: 'running' }] }, seenLive);
    check(seenGone.get('s-1') === 'gone' && !queueWatcherWanted(['s-1'], seenGone),
      'a closed session disappears from a completed list read, and that stops the poll too');

    const readFailed = observeQueueTargets(['s-1'], { ok: false }, seenLive);
    check(readFailed.get('s-1') === 'live' && queueWatcherWanted(['s-1'], readFailed),
      'a list read that came back short leaves the last verdict alone — one failed IPC call must not strand a live queue');
    const neverRead = observeQueueTargets(['s-1'], { ok: false }, new Map<string, QueueTargetState>());
    check(neverRead.get('s-1') === 'unknown' && queueWatcherWanted(['s-1'], neverRead),
      'a queue nothing has been observed about yet keeps its watcher rather than being written off');

    const mixed = observeQueueTargets(['s-1', 's-2'], { ok: true, sessions: [{ id: 's-2', status: 'running' }] }, seenLive);
    check(queueWatcherWanted(['s-1', 's-2'], mixed) && !queueWatcherWanted([], mixed),
      'one live session keeps the shared poll alive for every queue, and an empty queue set stops it');
  } catch (e) {
    check(false, `palette smoke threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  say('── unread · main owns the count, and the words match what it counts');

  // The badge counts output that arrived while you were somewhere else, and
  // both halves of that sentence are load-bearing. A session you are looking at
  // must never raise its own badge — the bytes are on screen as they land, so a
  // count of them is a count of what was just read. An exited session must not
  // either: its last output arrives as it dies, and a badge on a session that
  // has stopped forever invites you to open a tab and find nothing.
  check(shouldBumpUnread({ sessionId: 'a', focusedSessionId: 'a', status: 'running' }) === false
    && shouldBumpUnread({ sessionId: 'a', focusedSessionId: 'b', status: 'running' }) === true
    && shouldBumpUnread({ sessionId: 'a', focusedSessionId: null, status: 'running' }) === true
    && shouldBumpUnread({ sessionId: 'a', focusedSessionId: null, status: 'starting' }) === true,
  'the session on screen never raises its own badge, and every other running session does while the operator is on another tab — which is the case the badge exists for',
  `self ${shouldBumpUnread({ sessionId: 'a', focusedSessionId: 'a', status: 'running' })}, other ${shouldBumpUnread({ sessionId: 'a', focusedSessionId: 'b', status: 'running' })}, unwatched ${shouldBumpUnread({ sessionId: 'a', focusedSessionId: null, status: 'running' })}`);

  // Negative, and the one a naive "not focused" test gets wrong.
  check(shouldBumpUnread({ sessionId: 'a', focusedSessionId: null, status: 'exited' }) === false,
    'a session that has exited raises no badge no matter where the operator is, so a dead tab cannot advertise output nobody can act on',
    `exited bumps: ${shouldBumpUnread({ sessionId: 'a', focusedSessionId: null, status: 'exited' })}`);

  const unreadList = [
    { id: 'a', unread: 0 }, { id: 'b', unread: 2 },
  ] as unknown as readonly Session[];
  // Identity, not tidiness. The rail, the tab strip and every Fleet card
  // re-render off this array, and a coalesced flush lands once a second whether
  // or not it carries news.
  check(applyUnreadCounts(unreadList, {}) === unreadList
    && applyUnreadCounts(unreadList, { a: 0 }) === unreadList
    && applyUnreadCounts(unreadList, { zzz: 9 }) === unreadList,
  'a flush that moves no number returns the very same array, so a count the list already agrees with cannot repaint the rail, the tab strip and every card in Fleet',
  `empty same: ${applyUnreadCounts(unreadList, {}) === unreadList}; unchanged same: ${applyUnreadCounts(unreadList, { a: 0 }) === unreadList}`);

  const unreadBumped = applyUnreadCounts(unreadList, { a: 3 });
  check(unreadBumped !== unreadList && unreadBumped[0].unread === 3
    && unreadBumped[1] === unreadList[1],
  'a count that did move produces a new array with the new number, and leaves the untouched session as the identical object it already was',
  `a=${unreadBumped[0].unread}, b reused: ${unreadBumped[1] === unreadList[1]}`);

}
