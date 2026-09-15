/**
 * Can this reader actually read that file? The pure half of the Codex rollout
 * readers' honesty.
 *
 * Wanigan reads Codex's local rollout files for exact token counters, thread
 * identity and recovery. Every one of those readers splits a file on newlines
 * and hands each line to JSON.parse, and every one of them treats a line that
 * does not parse as "not the record I wanted" and moves on. That is correct for
 * a torn trailing line and silently wrong for a whole file: Codex has shipped
 * `local_thread_store_compression` (under development, off by default in
 * 0.154.0), which stores cold rollouts compressed, and a zstd frame read as
 * UTF-8 parses as nothing at all. The Usage screen would then report no usage
 * for a thread that has plenty — the zero-case trap in its purest form.
 *
 * So a file is classified before it is parsed, by name and by its first bytes,
 * and a parse keeps count of the lines it could not read. Both counts are
 * surfaced; neither is ever turned into a zero.
 */

export type RolloutFormat =
  | { kind: 'jsonl' }
  | { kind: 'compressed'; codec: 'zstd' | 'gzip' | 'xz' | 'bzip2' | 'lz4' | 'unknown'; by: 'magic' | 'extension' }
  | { kind: 'empty' }
  | { kind: 'binary' };

const EXTENSIONS: [RegExp, Exclude<Extract<RolloutFormat, { kind: 'compressed' }>['codec'], 'unknown'>][] = [
  [/\.(zst|zstd)$/i, 'zstd'],
  [/\.gz$/i, 'gzip'],
  [/\.xz$/i, 'xz'],
  [/\.bz2$/i, 'bzip2'],
  [/\.lz4$/i, 'lz4'],
];

/** Is this a file name a Codex rollout reader should consider at all? */
export function isRolloutName(name: string): boolean {
  return /^rollout-.+\.jsonl(?:\.[A-Za-z0-9]{1,5})?$/.test(name);
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((value, index) => bytes[index] === value);
}

/**
 * Classify by the first bytes, falling back to the name. Magic wins over the
 * extension: a `.jsonl` that begins with a zstd frame is compressed whatever
 * it is called, and that is exactly the case a name-only check misses.
 */
export function classifyRollout(name: string, head: Uint8Array): RolloutFormat {
  if (startsWith(head, [0x28, 0xb5, 0x2f, 0xfd])) return { kind: 'compressed', codec: 'zstd', by: 'magic' };
  if (startsWith(head, [0x1f, 0x8b])) return { kind: 'compressed', codec: 'gzip', by: 'magic' };
  if (startsWith(head, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return { kind: 'compressed', codec: 'xz', by: 'magic' };
  if (startsWith(head, [0x42, 0x5a, 0x68])) return { kind: 'compressed', codec: 'bzip2', by: 'magic' };
  if (startsWith(head, [0x04, 0x22, 0x4d, 0x18])) return { kind: 'compressed', codec: 'lz4', by: 'magic' };
  for (const [pattern, codec] of EXTENSIONS) {
    if (pattern.test(name)) return { kind: 'compressed', codec, by: 'extension' };
  }
  if (!/\.jsonl$/i.test(name)) return { kind: 'compressed', codec: 'unknown', by: 'extension' };
  if (head.length === 0) return { kind: 'empty' };
  // A JSONL rollout opens with `{`, possibly after a UTF-8 BOM or whitespace.
  let i = 0;
  if (startsWith(head, [0xef, 0xbb, 0xbf])) i = 3;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x0a || head[i] === 0x0d || head[i] === 0x09)) i++;
  if (i >= head.length || head[i] === 0x7b) return { kind: 'jsonl' };
  return { kind: 'binary' };
}

export type LineTally = {
  parsed: number;
  unparsed: number;
  /** A final line with no newline after it: a writer mid-record, not drift. */
  partialTail: boolean;
};

/**
 * Count what JSON.parse accepted and what it did not, over text a reader has
 * already decided to read. `startsMidLine` is true when the text is a tail
 * window whose first line was cut by the window, which is the reader's own
 * doing and not a malformed record.
 */
export function tallyJsonLines(text: string, startsMidLine = false): LineTally {
  const lines = text.split('\n');
  const partialTail = text.length > 0 && !text.endsWith('\n');
  const tally: LineTally = { parsed: 0, unparsed: 0, partialTail };
  lines.forEach((line, index) => {
    if (index === 0 && startsMidLine) return;
    if (index === lines.length - 1 && (partialTail || line === '')) {
      if (partialTail) {
        try { JSON.parse(line); tally.parsed += 1; } catch { /* a record still being written */ }
      }
      return;
    }
    if (!line.trim()) return;
    try { JSON.parse(line); tally.parsed += 1; } catch { tally.unparsed += 1; }
  });
  return tally;
}

/** The sentence both surfaces print. Null when there is nothing to say. */
export function unreadableSentence(compressed: number): string | null {
  if (compressed <= 0) return null;
  return `${compressed} Codex session${compressed === 1 ? ' is' : 's are'} stored in a format this version of Wanigan cannot read (compressed rollouts).`;
}

export function unparsedSentence(lines: number, files: number): string | null {
  if (lines <= 0) return null;
  return `The Codex reader could not parse ${lines} line${lines === 1 ? '' : 's'} in ${files} rollout file${files === 1 ? '' : 's'}.`;
}

/** What the Codex readers could and could not read, per account, as IPC carries it. */
export type CodexReaderHealth = {
  checkedAt: number;
  accounts: {
    accountId: string | null;
    label: string;
    home: string;
    rollouts: number;
    /** Compressed or otherwise not JSONL: the reader cannot read these at all. */
    unreadable: number;
    codecs: string[];
    /** Lines JSON.parse refused, in files the readers actually opened. */
    unparsedLines: number;
    filesWithUnparsed: number;
  }[];
  /** The Codex CLI the readers last ran against, and the one before it when it changed. */
  cliVersion: string | null;
  previousCliVersion: string | null;
  versionRecordedAt: number | null;
};
