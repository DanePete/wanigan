/**
 * What a session left running: the pure half.
 *
 * Wanigan owns every PTY it starts, so it is the one party that can say which
 * processes an agent's session spawned. The dev server an agent started to
 * test a change, the MCP server a CLI launched, the watcher nobody remembered —
 * each of those is reparented to launchd the moment the agent exits and then
 * holds a port and a slice of CPU with nothing on screen to say whose it is.
 *
 * Two readers feed this module, both of another program's human text, and both
 * are parsed strictly: `ps` for the process table and `lsof` for listening TCP
 * sockets. A row that does not have the shape is dropped rather than guessed
 * at, and the empty answer is a real answer — `lsof` prints nothing and exits 1
 * when no process listens, which is the common case and must read as "no
 * ports", never as "could not read".
 *
 * The rule that makes a Stop button safe also lives here: a pid is only ever
 * the process Wanigan recorded if its command and its start time still match.
 * macOS reuses pids, and the one mistake this feature must never make is to
 * signal an unrelated program that happened to inherit a number.
 */

/**
 * The exact `ps` invocation. `ww` lifts the column width so a long command is
 * not cut at 80 characters when there is no terminal; `time` is cumulative CPU
 * time, which is what "idle" is measured against — `%cpu` is a decaying average
 * and reads non-zero for a minute after a process has gone quiet.
 */
export const PS_ARGS = ['-axww', '-o', 'pid,ppid,pgid,%cpu,rss,etime,time,command'] as const;

/** `lsof` for listening TCP sockets of a pid list; the list is appended comma-joined. */
export function lsofListenArgs(pids: readonly number[]): string[] {
  return ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids.join(',')];
}

export type PsRow = {
  pid: number;
  ppid: number;
  pgid: number;
  /** ps's decaying average, as printed. */
  cpuPercent: number;
  /** Resident set size in kilobytes, as ps reports it. */
  rssKb: number;
  /** Wall-clock seconds since the process started. */
  elapsedSeconds: number;
  /** Cumulative CPU seconds. */
  cpuSeconds: number;
  command: string;
};

/** `[[dd-]hh:]mm:ss` → seconds, or null for anything else. */
export function parseEtime(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  if (Number(seconds) > 59 || (hours !== undefined && Number(minutes) > 59)) return null;
  return (Number(days ?? 0) * 86_400) + (Number(hours ?? 0) * 3_600) + Number(minutes) * 60 + Number(seconds);
}

/**
 * Cumulative CPU time → seconds. macOS prints `mm:ss.hh` with minutes allowed
 * past sixty (`96:45.24`); other builds print `[dd-]hh:mm:ss`. Both are read.
 */
export function parseCpuTime(text: string): number | null {
  const t = text.trim();
  let m = /^(\d+):(\d{2})(?:\.(\d{1,2}))?$/.exec(t);
  if (m) {
    if (Number(m[2]) > 59) return null;
    return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / 10 ** m[3].length : 0);
  }
  m = /^(?:(\d+)-)?(\d+):(\d{2}):(\d{2})(?:\.(\d{1,2}))?$/.exec(t);
  if (m) {
    if (Number(m[3]) > 59 || Number(m[4]) > 59) return null;
    return Number(m[1] ?? 0) * 86_400 + Number(m[2]) * 3_600 + Number(m[3]) * 60 + Number(m[4])
      + (m[5] ? Number(m[5]) / 10 ** m[5].length : 0);
  }
  return null;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/;

/**
 * The process table. The header is recognised and skipped; any other line
 * that does not carry all eight columns in their shapes is dropped. An empty
 * string is an empty table — ps with no output did not report a process.
 */
export function parsePsTable(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || /^\s*PID\s/.test(line)) continue;
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const elapsedSeconds = parseEtime(m[6]);
    const cpuSeconds = parseCpuTime(m[7]);
    const cpuPercent = Number(m[4]);
    if (elapsedSeconds === null || cpuSeconds === null || !Number.isFinite(cpuPercent)) continue;
    rows.push({
      pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]),
      cpuPercent, rssKb: Number(m[5]), elapsedSeconds, cpuSeconds, command: m[8],
    });
  }
  return rows;
}

/** When a row's process started, to the second, as seen from `sampledAt`. */
export function startedAtOf(row: Pick<PsRow, 'elapsedSeconds'>, sampledAt: number): number {
  return sampledAt - row.elapsedSeconds * 1000;
}

/**
 * Every process below `rootPid` in the ppid tree, the root included when it is
 * in the table. A cycle in a malformed table cannot loop: a pid is visited once.
 */
export function descendantsOf(rows: readonly PsRow[], rootPid: number): PsRow[] {
  const children = new Map<number, PsRow[]>();
  const byPid = new Map<number, PsRow>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    if (row.pid === row.ppid) continue;
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const out: PsRow[] = [];
  const seen = new Set<number>();
  const queue: number[] = [rootPid];
  const root = byPid.get(rootPid);
  if (root) { out.push(root); }
  seen.add(rootPid);
  while (queue.length) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

export type ListeningPort = { pid: number; command: string; address: string; port: number };

const LSOF_LINE = /^(\S+)\s+(\d+)\s+.*\sTCP\s+(\S+):(\d+)\s+\(LISTEN\)\s*$/;

/**
 * `lsof -nP -iTCP -sTCP:LISTEN` → one entry per pid, address and port. The same
 * socket is printed once for IPv4 and once for IPv6 (`*:5173` twice); those are
 * two lines in lsof and two distinct addresses here, and a repeat of the exact
 * same triple is collapsed. Empty output is the zero case, not a failure.
 */
export function parseLsofListen(text: string): ListeningPort[] {
  const out: ListeningPort[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim() || /^COMMAND\s/.test(line)) continue;
    const m = LSOF_LINE.exec(line);
    if (!m) continue;
    const port = Number(m[4]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) continue;
    const key = `${m[2]}|${m[3]}|${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pid: Number(m[2]), command: m[1], address: m[3], port });
  }
  return out;
}

/** What Wanigan remembers about one process it saw inside a session's tree. */
export type RecordedProcess = {
  pid: number;
  command: string;
  /** Derived from `etime` at the sample that first recorded it. */
  startedAt: number;
  firstSeenAt: number;
  lastSeenAt: number;
  cpuSeconds: number;
  /** The last sample at which its cumulative CPU time had grown; null until one has. */
  lastCpuAt: number | null;
};

/**
 * A pid's start time is known to the second from `etime`, and two samples
 * taken at different moments round it differently; this is the slack. A pid
 * reused by another program inside the same two seconds *and* with a
 * byte-identical command line is not a case this defends against, and the
 * command check is what carries the weight.
 */
export const START_TOLERANCE_MS = 2_500;

/** True only when `row` is still the process that was recorded. */
export function sameProcess(recorded: Pick<RecordedProcess, 'pid' | 'command' | 'startedAt'>, row: PsRow, sampledAt: number): boolean {
  return row.pid === recorded.pid
    && row.command === recorded.command
    && Math.abs(startedAtOf(row, sampledAt) - recorded.startedAt) <= START_TOLERANCE_MS;
}

/** Fold a fresh sample into a recorded process: last seen, and whether CPU moved. */
export function observe(recorded: RecordedProcess, row: PsRow, sampledAt: number): RecordedProcess {
  // A hundredth of a second is the resolution ps prints; anything less is the
  // same number read twice.
  const moved = row.cpuSeconds - recorded.cpuSeconds >= 0.01;
  return {
    ...recorded,
    lastSeenAt: sampledAt,
    cpuSeconds: Math.max(recorded.cpuSeconds, row.cpuSeconds),
    lastCpuAt: moved ? sampledAt : recorded.lastCpuAt,
  };
}

export function recordFrom(row: PsRow, sampledAt: number): RecordedProcess {
  return {
    pid: row.pid, command: row.command, startedAt: startedAtOf(row, sampledAt),
    firstSeenAt: sampledAt, lastSeenAt: sampledAt, cpuSeconds: row.cpuSeconds, lastCpuAt: null,
  };
}

/**
 * Which recorded processes are still running as themselves. A pid that is gone,
 * or is now a different program, is not a survivor — it is simply not ours.
 */
export function survivors(recorded: readonly RecordedProcess[], rows: readonly PsRow[], sampledAt: number): { recorded: RecordedProcess; row: PsRow }[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const out: { recorded: RecordedProcess; row: PsRow }[] = [];
  for (const entry of recorded) {
    const row = byPid.get(entry.pid);
    if (row && sameProcess(entry, row, sampledAt)) out.push({ recorded: entry, row });
  }
  return out;
}

/**
 * How long a process has shown no CPU activity, and on what basis. `observed`
 * means Wanigan saw its CPU time grow and then stop; `since-first-seen` means it
 * has never been seen doing anything, so the figure is a lower bound from the
 * first sample, and the renderer says "at least".
 */
export function cpuIdle(recorded: RecordedProcess, now: number): { ms: number; basis: 'observed' | 'since-first-seen' } {
  if (recorded.lastCpuAt !== null) return { ms: Math.max(0, now - recorded.lastCpuAt), basis: 'observed' };
  return { ms: Math.max(0, now - recorded.firstSeenAt), basis: 'since-first-seen' };
}

/* ── the shapes that cross IPC ─────────────────────────────────────────── */

export type ProcessSurvivor = {
  pid: number;
  /** Redacted in main before it leaves; a command line is where a pasted token ends up. */
  command: string;
  ports: { address: string; port: number }[];
  startedAt: number;
  cpuIdleMs: number;
  cpuIdleBasis: 'observed' | 'since-first-seen';
};

export type SessionProcesses = {
  sessionId: string;
  sampledAt: number | null;
  live: boolean;
  /** The session's current tree, while it runs. Null once it has ended or before a sample. */
  tree: { processes: number; cpuPercent: number; rssBytes: number } | null;
  ports: { pid: number; command: string; address: string; port: number }[];
  survivors: ProcessSurvivor[];
  /** How many distinct processes Wanigan has recorded in this session's tree. */
  recorded: number;
  /** Said when something about this reading is limited, e.g. an unsupported harness surface. */
  notes: string[];
};

export type StopSurvivorResult = {
  pid: number;
  outcome: 'terminated' | 'killed' | 'already-gone' | 'refused' | 'still-running';
  detail: string;
};
