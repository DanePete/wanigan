/**
 * Whether a Claude Code transcript's message chain will carry the whole
 * conversation into a resume, read without writing a byte.
 *
 * Claude Code rebuilds a resumed conversation by walking `parentUuid` back from
 * the newest message. A message whose parent the walk cannot follow cuts off
 * everything before it (anthropics/claude-code#22107; claude-code-tools'
 * fix-session relinks such entries). Wanigan never repairs a provider's
 * transcript — it is the harness's file — so this only detects and counts.
 *
 * What counts as a break is read from the installed 2.1.271 binary, not
 * assumed. Its loader keeps `user`, `assistant`, `attachment` and `system`
 * entries in the message map (`Ge=new Set(["user","assistant","attachment",
 * "system"])`), so a parent of any of those types is an ordinary link: 1,683
 * attachment parents and 67 system parents across this machine's own 60 newest
 * transcripts all resume. A break is a parent the walk cannot follow:
 *
 *  - progress  — the parent is a `progress` record, which is not in that map.
 *                2.1.271 relinks through these when it loads ("legacy progress
 *                bridge"); an older CLI drops everything before one.
 *  - sidechain — a main-conversation message whose parent is a subagent's
 *                (`isSidechain`) entry, so the walk wanders into the subagent's
 *                thread instead of the conversation.
 *  - missing   — the parent uuid is not in the file at all. 2.1.271 tries a
 *                timestamp fallback within five seconds on the same side of the
 *                sidechain line; when nothing that close exists, the walk ends.
 *
 * "May be skipped" is counted as the difference between two walks from the
 * newest message: a strict one that stops at the first break, and a bridged
 * one that steps over each break the way fix-session relinks it (through a
 * progress record to its own parent, otherwise to the previous conversation
 * entry in the file). The messages only the bridged walk reaches are the ones
 * a resume may leave out. A compaction boundary has no parent by design and
 * ends both walks, so summarised history is never counted as lost.
 */

export type ChainBreakKind = 'progress' | 'sidechain' | 'missing';

export type ChainBreak = {
  /** The message whose parent could not be followed. */
  uuid: string;
  parentUuid: string;
  kind: ChainBreakKind;
  /** 1-based line in the transcript file. */
  line: number;
};

export type ChainReport = {
  /** Main-conversation user and assistant messages in the file. */
  messages: number;
  /** Messages a walk that stops at the first break reaches from the newest one. */
  reached: number;
  /** Messages reachable once each break is stepped over. */
  reachable: number;
  /** reachable − reached: what a resume may leave out. */
  skipped: number;
  breaks: ChainBreak[];
  /** Lines that were not JSON — a partial last line on a live file is normal. */
  unreadableLines: number;
};

type Entry = { uuid: string; parentUuid: string | null; type: string; sidechain: boolean; index: number; line: number };

const CHAIN_TYPES = new Set(['user', 'assistant', 'attachment', 'system']);

function isMessage(e: Entry): boolean {
  return (e.type === 'user' || e.type === 'assistant') && !e.sidechain;
}

export function checkTranscriptChain(text: string): ChainReport {
  const byUuid = new Map<string, Entry>();
  const progress = new Map<string, Entry>();
  const ordered: Entry[] = [];
  let unreadableLines = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { unreadableLines++; continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.uuid !== 'string' || typeof r.type !== 'string') continue;
    const entry: Entry = {
      uuid: r.uuid, parentUuid: typeof r.parentUuid === 'string' ? r.parentUuid : null,
      type: r.type, sidechain: r.isSidechain === true, index: ordered.length, line: i + 1,
    };
    if (entry.type === 'progress') { progress.set(entry.uuid, entry); continue; }
    if (!CHAIN_TYPES.has(entry.type)) continue;
    byUuid.set(entry.uuid, entry);
    ordered.push(entry);
  }

  const messages = ordered.filter(isMessage).length;
  const leaf = [...ordered].reverse().find(isMessage) ?? null;
  if (!leaf) return { messages, reached: 0, reachable: 0, skipped: 0, breaks: [], unreadableLines };

  /** Classify the step from `from` to its parent. */
  const step = (from: Entry): { next: Entry | null; broke: ChainBreakKind | null } => {
    const pid = from.parentUuid;
    if (!pid) return { next: null, broke: null };
    const parent = byUuid.get(pid);
    if (parent) {
      if (parent.sidechain && !from.sidechain) return { next: null, broke: 'sidechain' };
      return { next: parent, broke: null };
    }
    return { next: null, broke: progress.has(pid) ? 'progress' : 'missing' };
  };

  // Strict: the first break ends it.
  const strict = new Set<string>();
  for (let cur: Entry | null = leaf; cur && !strict.has(cur.uuid);) {
    strict.add(cur.uuid);
    cur = step(cur).next;
  }

  // Bridged: step over each break and keep counting.
  const bridged = new Set<string>();
  const breaks: ChainBreak[] = [];
  for (let cur: Entry | null = leaf; cur && !bridged.has(cur.uuid);) {
    bridged.add(cur.uuid);
    const { next, broke } = step(cur);
    if (!broke) { cur = next; continue; }
    breaks.push({ uuid: cur.uuid, parentUuid: cur.parentUuid!, kind: broke, line: cur.line });
    let resumed: Entry | null = null;
    if (broke === 'progress') {
      // Follow progress records back to the first parent that is in the map.
      let pid: string | null = cur.parentUuid;
      const seen = new Set<string>();
      while (pid && progress.has(pid) && !seen.has(pid)) { seen.add(pid); pid = progress.get(pid)!.parentUuid; }
      resumed = pid ? byUuid.get(pid) ?? null : null;
    }
    if (!resumed) {
      // The previous main-conversation chain entry in the file.
      const from: number = cur.index;
      for (let j = from - 1; j >= 0; j--) {
        if (!ordered[j].sidechain) { resumed = ordered[j]; break; }
      }
    }
    cur = resumed;
  }

  const count = (set: Set<string>) => [...set].filter((u) => { const e = byUuid.get(u); return !!e && isMessage(e); }).length;
  const reached = count(strict);
  const reachable = count(bridged);
  return { messages, reached, reachable, skipped: Math.max(0, reachable - reached), breaks: breaks.reverse(), unreadableLines };
}

/** The sentence the Recent row and the resume confirmation both show. */
export function chainWarning(report: Pick<ChainReport, 'skipped'>): string | null {
  if (report.skipped <= 0) return null;
  return `${report.skipped} message${report.skipped === 1 ? '' : 's'} may be skipped when this conversation resumes (broken message chain in the transcript)`;
}

/** What main reports per conversation. `checked: false` says why nothing could be read. */
export type ChainCheck =
  | { checked: true; skipped: number; breaks: number; kinds: ChainBreakKind[]; messages: number; bytes: number }
  | { checked: false; reason: string };
