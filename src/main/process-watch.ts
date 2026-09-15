import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redactCredentials } from './redact';
import {
  PS_ARGS, cpuIdle, descendantsOf, lsofListenArgs, observe, parseLsofListen, parsePsTable, recordFrom,
  sameProcess, startedAtOf, survivors,
  type ListeningPort, type PsRow, type RecordedProcess, type SessionProcesses, type StopSurvivorResult,
} from '../shared/process-tree';

const exec = promisify(execFile);

/**
 * What a session left running: the process table, read on demand.
 *
 * The sampler is deliberately lazy. One `ps` and one `lsof` cost a few tens of
 * milliseconds, and the reason to pay it is an operator looking at Fleet or a
 * session's details — so it runs when one of those views asks, at most once
 * every ten seconds however many ask, and also at the two moments an answer is
 * owed whether or not anyone is looking: just before Halt signals the fleet and
 * just before a session is stopped, because afterwards the ppid chain that
 * proves a process was the session's is gone.
 *
 * Attribution is by the ppid chain from the PTY's own child, plus one widening:
 * node-pty makes that child a session and process-group leader, so a process
 * still in its group was started from inside the terminal even if it was never
 * sampled while its parent lived. That widening only applies to a process that
 * started while the session was running — a pid reused after the session ended
 * cannot be pulled into its group by coincidence.
 *
 * Every pid recorded here is kept with its command and start time. A Stop is
 * refused unless both still match at the moment of signalling.
 */

export const SAMPLE_MIN_INTERVAL_MS = 10_000;
const COMMAND_TIMEOUT_MS = 4_000;
const STOP_GRACE_MS = 5_000;
const STOP_POLL_MS = 250;
/** A recorded process that has been gone for this long is forgotten. */
const FORGET_AFTER_MS = 6 * 60 * 60_000;
/** A session tree bigger than this is almost certainly a mistake in attribution. */
const MAX_RECORDED_PER_SESSION = 400;

/**
 * Codex's background terminals live in its app-server, not in the PTY's tree.
 * 0.154.0's generated app-server schema has no `thread/backgroundTerminals/*`
 * method, so there is nothing local to ask. Said on every Codex session rather
 * than guessed at.
 */
export const CODEX_BACKGROUND_TERMINALS_NOTE =
  'Codex background terminals are not listed: the Codex 0.154 app-server has no thread/backgroundTerminals method, so Wanigan cannot see terminals Codex keeps outside this process tree (unsupported in this version).';

export type TrackedSessionInput = {
  id: string;
  pid: number | null;
  status: 'starting' | 'running' | 'exited';
  createdAt: number;
  endedAt: number | null;
  harnessId?: string | null;
};

type Tracked = {
  sessionId: string;
  rootPid: number | null;
  createdAt: number;
  endedAt: number | null;
  live: boolean;
  harness: string | null;
  known: Map<number, RecordedProcess>;
  tree: SessionProcesses['tree'];
  ports: SessionProcesses['ports'];
  survivors: SessionProcesses['survivors'];
  sampledAt: number | null;
};

const tracked = new Map<string, Tracked>();
let lastSampleAt = 0;
let inFlight: Promise<void> | null = null;
let sessionSource: () => TrackedSessionInput[] = () => [];

/** index.ts hands in the live list; the offline suite hands in its own. */
export function setProcessSessionSource(source: () => TrackedSessionInput[]): void {
  sessionSource = source;
}

async function run(bin: string, args: readonly string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await exec(bin, [...args], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    return { stdout, code: 0 };
  } catch (error) {
    // lsof exits 1 with nothing on stdout when no process listens. That is an
    // answer, and it is carried through as one; only a missing binary or a
    // timeout is left to the caller as a failure.
    const e = error as { stdout?: string; code?: number | string };
    if (typeof e.code === 'number') return { stdout: typeof e.stdout === 'string' ? e.stdout : '', code: e.code };
    throw error;
  }
}

async function readTable(): Promise<{ rows: PsRow[]; at: number }> {
  const at = Date.now();
  const { stdout } = await run('/bin/ps', PS_ARGS);
  return { rows: parsePsTable(stdout), at };
}

async function readPorts(pids: number[]): Promise<ListeningPort[]> {
  if (!pids.length) return [];
  // One call for every pid in every session. -p takes a comma list; a very
  // long one is split so argv stays well under the platform limit.
  const out: ListeningPort[] = [];
  for (let i = 0; i < pids.length; i += 200) {
    try {
      const { stdout } = await run('/usr/sbin/lsof', lsofListenArgs(pids.slice(i, i + 200)));
      out.push(...parseLsofListen(stdout));
    } catch { /* lsof missing or timed out: ports are simply not shown */ }
  }
  return out;
}

function trackedFor(input: TrackedSessionInput): Tracked {
  let entry = tracked.get(input.id);
  if (!entry) {
    entry = {
      sessionId: input.id, rootPid: input.pid, createdAt: input.createdAt, endedAt: input.endedAt,
      live: input.status !== 'exited', harness: input.harnessId ?? null, known: new Map(),
      tree: null, ports: [], survivors: [], sampledAt: null,
    };
    tracked.set(input.id, entry);
  }
  entry.rootPid = input.pid ?? entry.rootPid;
  entry.live = input.status !== 'exited';
  entry.endedAt = input.endedAt ?? entry.endedAt;
  entry.harness = input.harnessId ?? entry.harness;
  return entry;
}

function recordRow(entry: Tracked, row: PsRow, at: number): void {
  const existing = entry.known.get(row.pid);
  if (existing && sameProcess(existing, row, at)) {
    entry.known.set(row.pid, observe(existing, row, at));
    return;
  }
  // A recorded pid that now belongs to a different program is replaced only if
  // this row is itself attributable, which the caller has already decided.
  if (entry.known.size >= MAX_RECORDED_PER_SESSION && !existing) return;
  entry.known.set(row.pid, recordFrom(row, at));
}

function attributable(entry: Tracked, rows: PsRow[], at: number): PsRow[] {
  if (!entry.rootPid) return [];
  const root = rows.find((row) => row.pid === entry.rootPid);
  // The root pid must still be the process this session spawned, started no
  // earlier than a moment before the session was created. Otherwise the pid
  // has been reused and nothing below it is this session's.
  const rootIsOurs = root !== undefined && startedAtOf(root, at) >= entry.createdAt - 5_000;
  if (!rootIsOurs) return [];
  const chain = descendantsOf(rows, entry.rootPid);
  const inChain = new Set(chain.map((row) => row.pid));
  const grouped = rows.filter((row) => !inChain.has(row.pid)
    && row.pgid === entry.rootPid
    && startedAtOf(row, at) >= entry.createdAt - 5_000);
  return [...chain, ...grouped];
}

function redactCommand(command: string): string {
  return redactCredentials(command).slice(0, 400);
}

async function sampleNow(): Promise<void> {
  const { rows, at } = await readTable();
  const listed = new Set<string>();
  for (const input of sessionSource()) { trackedFor(input); listed.add(input.id); }
  // A session closed between two samples is no longer in the list, and the
  // last thing this module saw of it may have been "running". Absent is ended.
  for (const entry of tracked.values()) {
    if (!listed.has(entry.sessionId) && entry.live) { entry.live = false; entry.endedAt = entry.endedAt ?? at; }
  }

  const portPids = new Set<number>();
  const liveTrees = new Map<string, PsRow[]>();
  const survivorRows = new Map<string, { recorded: RecordedProcess; row: PsRow }[]>();
  for (const entry of tracked.values()) {
    if (entry.live) {
      const tree = attributable(entry, rows, at);
      for (const row of tree) recordRow(entry, row, at);
      liveTrees.set(entry.sessionId, tree);
      for (const row of tree) portPids.add(row.pid);
    } else {
      // Ended: every recorded process that is still itself. Observe each so
      // its idle clock keeps counting from real CPU movement.
      const alive = survivors([...entry.known.values()], rows, at);
      for (const { recorded, row } of alive) entry.known.set(recorded.pid, observe(recorded, row, at));
      // The agent process itself is not a leftover of itself; if node-pty has
      // reported it gone and it is still in the table, it is listed too,
      // because that is exactly the wedged case an operator needs to see.
      survivorRows.set(entry.sessionId, alive);
      for (const { row } of alive) portPids.add(row.pid);
    }
  }

  const ports = await readPorts([...portPids]);
  const portsByPid = new Map<number, ListeningPort[]>();
  for (const port of ports) {
    const list = portsByPid.get(port.pid) ?? [];
    list.push(port);
    portsByPid.set(port.pid, list);
  }

  for (const entry of tracked.values()) {
    entry.sampledAt = at;
    if (entry.live) {
      const tree = liveTrees.get(entry.sessionId) ?? [];
      entry.tree = tree.length
        ? {
            processes: tree.length,
            cpuPercent: Math.round(tree.reduce((sum, row) => sum + row.cpuPercent, 0) * 10) / 10,
            rssBytes: tree.reduce((sum, row) => sum + row.rssKb, 0) * 1024,
          }
        : null;
      entry.ports = tree.flatMap((row) => (portsByPid.get(row.pid) ?? []).map((port) => ({
        pid: row.pid, command: redactCommand(row.command), address: port.address, port: port.port,
      })));
      entry.survivors = [];
    } else {
      entry.tree = null;
      entry.ports = [];
      entry.survivors = (survivorRows.get(entry.sessionId) ?? []).map(({ recorded, row }) => {
        const idle = cpuIdle(entry.known.get(recorded.pid) ?? recorded, at);
        return {
          pid: row.pid,
          command: redactCommand(row.command),
          ports: (portsByPid.get(row.pid) ?? []).map((port) => ({ address: port.address, port: port.port })),
          startedAt: recorded.startedAt,
          cpuIdleMs: idle.ms,
          cpuIdleBasis: idle.basis,
        };
      });
      // Forget what has been gone long enough, and the whole record once
      // nothing in it is alive and the session ended long ago.
      for (const [pid, recorded] of entry.known) {
        if (at - recorded.lastSeenAt > FORGET_AFTER_MS) entry.known.delete(pid);
      }
      if (!entry.known.size && entry.endedAt && at - entry.endedAt > FORGET_AFTER_MS) tracked.delete(entry.sessionId);
    }
  }
  lastSampleAt = at;
}

/**
 * Sample if the last sample is older than the interval, or when forced. Callers
 * that arrive during a sample share it rather than starting another.
 */
export async function sampleProcesses(force = false): Promise<void> {
  if (inFlight) return inFlight;
  if (!force && Date.now() - lastSampleAt < SAMPLE_MIN_INTERVAL_MS) return;
  const work = sampleNow();
  inFlight = work;
  try { await work; }
  finally { if (inFlight === work) inFlight = null; }
}

function view(entry: Tracked): SessionProcesses {
  return {
    sessionId: entry.sessionId,
    sampledAt: entry.sampledAt,
    live: entry.live,
    tree: entry.tree ? { ...entry.tree } : null,
    ports: entry.ports.map((port) => ({ ...port })),
    survivors: entry.survivors.map((s) => ({ ...s, ports: s.ports.map((p) => ({ ...p })) })),
    recorded: entry.known.size,
    notes: entry.harness === 'codex' ? [CODEX_BACKGROUND_TERMINALS_NOTE] : [],
  };
}

export async function processesForSession(sessionId: string): Promise<SessionProcesses> {
  await sampleProcesses(false);
  const entry = tracked.get(sessionId);
  if (!entry) {
    const input = sessionSource().find((session) => session.id === sessionId);
    return {
      sessionId, sampledAt: lastSampleAt || null, live: input ? input.status !== 'exited' : false,
      tree: null, ports: [], survivors: [], recorded: 0,
      notes: input?.harnessId === 'codex' ? [CODEX_BACKGROUND_TERMINALS_NOTE] : [],
    };
  }
  return view(entry);
}

/** Every ended session that still has something running, closed tabs included. */
export async function allSurvivors(): Promise<SessionProcesses[]> {
  await sampleProcesses(false);
  return [...tracked.values()].filter((entry) => !entry.live && entry.survivors.length).map(view);
}

/**
 * Record a session's tree right now, whatever the throttle says. Called just
 * before its processes are signalled, because afterwards the chain is gone.
 */
export async function captureBeforeStop(): Promise<void> {
  try { await sampleProcesses(true); } catch { /* a failed read must never block a stop */ }
}

/**
 * How many recorded processes are still running after the sessions ended.
 * Waits a bounded moment for the PTYs to exit first, then samples.
 */
export async function survivorCountAfter(exited: Promise<unknown>, graceMs = 3_000): Promise<number> {
  let timer: NodeJS.Timeout | null = null;
  await Promise.race([
    exited.catch(() => {}),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); }),
  ]);
  if (timer) clearTimeout(timer);
  try { await sampleProcesses(true); } catch { return 0; }
  return [...tracked.values()].reduce((sum, entry) => sum + (entry.live ? 0 : entry.survivors.length), 0);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function stillOurs(recorded: RecordedProcess): Promise<boolean> {
  const { rows, at } = await readTable();
  const row = rows.find((candidate) => candidate.pid === recorded.pid);
  return row !== undefined && sameProcess(recorded, row, at);
}

/**
 * Stop one process a session left behind: SIGTERM, then SIGKILL after a grace
 * period if it is still the same process.
 *
 * Refused for anything Wanigan did not record in that session's tree, for a
 * session that is still running (ending the session is a different act with
 * its own button), and for a pid whose command or start time no longer match —
 * which is checked again immediately before each signal, not once up front.
 */
export async function stopSurvivor(sessionId: unknown, pid: unknown): Promise<StopSurvivorResult> {
  const n = typeof pid === 'number' && Number.isInteger(pid) && pid > 1 ? pid : null;
  if (typeof sessionId !== 'string' || n === null) {
    return { pid: typeof pid === 'number' ? pid : 0, outcome: 'refused', detail: 'That is not a process Wanigan recorded.' };
  }
  // The session's current state, not the one at the last sample: a session
  // that ended a moment ago must not be refused as "still running".
  const current = sessionSource().find((session) => session.id === sessionId);
  if (current) trackedFor(current);
  const entry = tracked.get(sessionId);
  const recorded = entry?.known.get(n);
  if (!entry || !recorded) {
    return { pid: n, outcome: 'refused', detail: 'Wanigan did not record this process in that session, so it will not signal it.' };
  }
  if (entry.live) {
    return { pid: n, outcome: 'refused', detail: 'That session is still running. End the session instead; this button is for what it left behind.' };
  }
  if (n === process.pid) {
    return { pid: n, outcome: 'refused', detail: 'That pid is Wanigan itself.' };
  }
  if (!(await stillOurs(recorded))) {
    entry.known.delete(n);
    return {
      pid: n,
      outcome: alive(n) ? 'refused' : 'already-gone',
      detail: alive(n)
        ? 'That pid now belongs to a different process (its command or start time changed), so nothing was signalled.'
        : 'It had already exited.',
    };
  }
  try { process.kill(n, 'SIGTERM'); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { pid: n, outcome: 'already-gone', detail: 'It had already exited.' };
    return { pid: n, outcome: 'refused', detail: `The system refused the signal (${code ?? 'unknown error'}).` };
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
    if (!alive(n)) {
      entry.known.delete(n);
      entry.survivors = entry.survivors.filter((s) => s.pid !== n);
      return { pid: n, outcome: 'terminated', detail: 'Stopped with SIGTERM.' };
    }
  }
  if (!(await stillOurs(recorded))) {
    entry.known.delete(n);
    entry.survivors = entry.survivors.filter((s) => s.pid !== n);
    return { pid: n, outcome: 'terminated', detail: 'Stopped with SIGTERM; the pid was reused afterwards and was not signalled again.' };
  }
  try { process.kill(n, 'SIGKILL'); } catch { /* exited between the check and the signal */ }
  await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  if (alive(n) && (await stillOurs(recorded))) {
    return { pid: n, outcome: 'still-running', detail: 'It ignored SIGTERM and is still running after SIGKILL.' };
  }
  entry.known.delete(n);
  entry.survivors = entry.survivors.filter((s) => s.pid !== n);
  return { pid: n, outcome: 'killed', detail: `It ignored SIGTERM for ${STOP_GRACE_MS / 1000} seconds and was stopped with SIGKILL.` };
}

/** For the offline suite: forget everything between cases. */
export function resetProcessWatch(): void {
  tracked.clear();
  lastSampleAt = 0;
}

/**
 * For the offline suite: rewrite what was recorded about a pid, which is the
 * only way to stand up "this number now belongs to another program" without
 * waiting for the kernel to reuse one.
 */
export const __test = {
  forgeRecordedCommand(sessionId: string, pid: number, command: string): boolean {
    const recorded = tracked.get(sessionId)?.known.get(pid);
    if (!recorded) return false;
    tracked.get(sessionId)!.known.set(pid, { ...recorded, command });
    return true;
  },
  recordedPids(sessionId: string): number[] {
    return [...(tracked.get(sessionId)?.known.keys() ?? [])];
  },
};
