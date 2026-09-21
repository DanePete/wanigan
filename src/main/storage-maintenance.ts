import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import { assertStorageRuntimeSideEffects } from './modules/storage-runtime';

/** Required Storage owns this interlock. It is deliberately outside wanigan.db
 * and the backup manifest. It contains coordination, never usage or execution
 * evidence. Closed acknowledgements are explicit; timestamps/PIDs confer no
 * authority to reap a participant or adopt its connection. */
const FORMAT = 1;
const CONTROL_DIR = '.storage-control';
const CONTROL_FILE = 'journal.sqlite';
const MARKER_FILE = 'format.json';

type StorageMode = 'active' | 'maintenance' | 'inspection';
type State = { identity: string; generation: string; revision: number; mode: StorageMode; operation_id: string | null; database_identity: string | null };
type ParticipantRow = { token: string; generation: string; kind: string; pid: number; opened_at: number; closed_at: number | null; protocol: number };
export type StorageRestoreOperation = {
  id: string; source_generation: string; destination_generation: string; phase: string;
  source: string; manifest_digest: string; staging_dir: string; replaced_dir: string;
  created_at: number; updated_at: number; detail: string | null;
};
export type StorageStatus = {
  generation: string; revision: string; mode: StorageMode;
  automationHeld: boolean; spendingHeld: boolean;
  operation: StorageRestoreOperation | null;
  participants: { token: string; generation: string; kind: string; pid: number; openedAt: number }[];
};

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error('Storage coordination requires a real private directory.');
  }
  fs.chmodSync(directory, 0o700);
}

function regularFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Storage coordination file is not a regular file: ${file}`);
  fs.chmodSync(file, 0o600);
}

class StorageControl {
  readonly directory: string;
  readonly file: string;
  readonly identity: string;
  private readonly native: Database.Database;
  private readonly fileIdentity: string;
  private depth = 0;

  constructor(readonly root: string) {
    privateDirectory(root);
    this.directory = path.join(root, CONTROL_DIR);
    this.file = path.join(this.directory, CONTROL_FILE);
    let created = false;
    try { fs.mkdirSync(this.directory, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    privateDirectory(this.directory);
    const marker = path.join(this.directory, MARKER_FILE);
    let identity: string;
    if (created) {
      identity = randomUUID();
    } else {
      try {
        regularFile(marker);
        const parsed: unknown = JSON.parse(fs.readFileSync(marker, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || !('format' in parsed) || parsed.format !== FORMAT ||
            !('identity' in parsed) || typeof parsed.identity !== 'string' || !/^[a-f0-9-]{36}$/.test(parsed.identity)) {
          throw new Error('Unsupported coordination marker.');
        }
        identity = parsed.identity;
        regularFile(this.file);
      } catch (error) {
        throw new Error(`Storage recovery required: the external journal or marker is missing, unreadable or incompatible. No database was opened. ${String(error)}`);
      }
    }
    this.identity = identity;
    this.native = new Database(this.file, { fileMustExist: !created });
    regularFile(this.file);
    const identityStat = fs.statSync(this.file);
    this.fileIdentity = `${identityStat.dev}:${identityStat.ino}`;
    this.native.pragma('busy_timeout = 10000');
    // DELETE + FULL keeps a single durable journal database; WAL-sidecar
    // replacement must never become part of this protocol's publication.
    this.native.pragma('journal_mode = DELETE');
    this.native.pragma('synchronous = FULL');
    if (created) {
      this.native.exec(`
        CREATE TABLE state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL,
          generation TEXT NOT NULL, revision INTEGER NOT NULL, mode TEXT NOT NULL, operation_id TEXT, database_identity TEXT);
        CREATE TABLE participants (token TEXT PRIMARY KEY, generation TEXT NOT NULL, kind TEXT NOT NULL,
          pid INTEGER NOT NULL, opened_at INTEGER NOT NULL, closed_at INTEGER, protocol INTEGER NOT NULL);
        CREATE TABLE restores (id TEXT PRIMARY KEY, source_generation TEXT NOT NULL, destination_generation TEXT NOT NULL,
          phase TEXT NOT NULL, source TEXT NOT NULL, manifest_digest TEXT NOT NULL, staging_dir TEXT NOT NULL,
          replaced_dir TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, detail TEXT);
      `);
      this.native.prepare('INSERT INTO state VALUES(1,?,?,0,?,NULL,NULL)').run(identity, randomUUID(), 'active');
      fs.writeFileSync(marker, JSON.stringify({ format: FORMAT, identity }), { flag: 'wx', mode: 0o600 });
      const fd = fs.openSync(marker, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const dirFd = fs.openSync(this.directory, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    }
    this.state();
  }

  /** Reject removal/replacement even while this process still owns a SQLite
   * handle to the old inode. The marker is an identity anchor, not a lock. */
  private checkFiles(): void {
    try {
      regularFile(this.file);
      const stat = fs.statSync(this.file);
      if (`${stat.dev}:${stat.ino}` !== this.fileIdentity) throw new Error('External journal file was replaced.');
      const marker = path.join(this.directory, MARKER_FILE);
      regularFile(marker);
      const parsed = JSON.parse(fs.readFileSync(marker, 'utf8')) as { format?: unknown; identity?: unknown };
      if (parsed.format !== FORMAT || parsed.identity !== this.identity) throw new Error('Journal identity changed.');
    } catch (error) { throw new Error(`Storage recovery required: external journal integrity is unknown. ${String(error)}`); }
  }

  state(): State {
    this.checkFiles();
    const row = this.native.prepare('SELECT identity,generation,revision,mode,operation_id,database_identity FROM state WHERE singleton=1').get() as State | undefined;
    if (!row || row.identity !== this.identity || !['active', 'maintenance', 'inspection'].includes(row.mode) ||
        !Number.isSafeInteger(row.revision) || row.revision < 0 || typeof row.generation !== 'string' ||
        (row.mode === 'maintenance' && !row.operation_id) ||
        (row.database_identity !== null && (typeof row.database_identity !== 'string' || !/^[0-9]+:[0-9]+$/.test(row.database_identity)))) {
      throw new Error('Storage recovery required: external journal state is corrupt or incomplete.');
    }
    if (row.mode === 'active' && row.operation_id) throw new Error('Storage recovery required: active storage has an unexpected restore operation.');
    if (row.operation_id) {
      const operation = this.operation(row.operation_id);
      if (!operation || (row.mode === 'inspection'
        ? operation.phase !== 'published' || operation.destination_generation !== row.generation
        : !['prepared', 'closed', 'swapping', 'failed'].includes(operation.phase) || operation.source_generation !== row.generation)) {
        throw new Error('Storage recovery required: restore journal phase or generation is inconsistent.');
      }
    }
    return row;
  }

  operation(id: string): StorageRestoreOperation | null {
    const row = this.native.prepare('SELECT * FROM restores WHERE id=?').get(id) as StorageRestoreOperation | undefined;
    if (!row) return null;
    if (!/^[a-f0-9-]{36}$/.test(row.id) || !/^[a-f0-9-]{36}$/.test(row.source_generation) ||
        !/^[a-f0-9-]{36}$/.test(row.destination_generation) || !/^[a-f0-9]{64}$/.test(row.manifest_digest) ||
        !['prepared', 'closed', 'swapping', 'published', 'failed', 'canceled'].includes(row.phase) ||
        !Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.updated_at) ||
        ![row.source, row.staging_dir, row.replaced_dir].every(value => typeof value === 'string' && path.isAbsolute(value) && value.length <= 4096)) {
      throw new Error('Storage recovery required: restore journal fields are corrupt or unsupported.');
    }
    return row;
  }

  atomic<T>(operation: () => T): T {
    this.checkFiles();
    if (this.depth) return operation();
    this.native.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const value = operation();
      this.native.exec('COMMIT');
      return value;
    } catch (error) {
      this.native.exec('ROLLBACK');
      throw error;
    } finally { this.depth--; }
  }

  prepare(sql: string): Database.Statement { return this.native.prepare(sql); }
  advanceRevision(): void { this.native.prepare('UPDATE state SET revision=revision+1 WHERE singleton=1').run(); }
  peers(): ParticipantRow[] {
    const rows = this.native.prepare('SELECT * FROM participants WHERE closed_at IS NULL ORDER BY opened_at,token').all() as ParticipantRow[];
    if (rows.some(row => row.protocol !== FORMAT || !/^[a-f0-9-]{36}$/.test(row.token) || !/^[a-f0-9-]{36}$/.test(row.generation))) {
      throw new Error('Storage recovery required: an incompatible or corrupt participant has not acknowledged closure.');
    }
    return rows;
  }
}

function databaseFileIdentity(root: string): string {
  const stat = fs.lstatSync(path.join(root, 'wanigan.db'));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Storage recovery required: the live database is not a regular file.');
  return `${stat.dev}:${stat.ino}`;
}

function assertDatabaseFileIdentity(c: StorageControl, state: State): void {
  if (!state.database_identity) return;
  try {
    if (databaseFileIdentity(c.root) !== state.database_identity) throw new Error('Database file was replaced outside its coordinator.');
  } catch (error) { throw new Error(`Storage recovery required: database file identity changed. ${String(error)}`); }
}

let control: StorageControl | null = null;
let participant: StorageParticipant | null = null;
function coordinator(root = app.getPath('userData')): StorageControl {
  privateDirectory(path.resolve(root));
  const canonical = fs.realpathSync.native(path.resolve(root));
  if (control && control.root !== canonical) throw new Error('This process already owns another storage root; restart before changing userData.');
  control ??= new StorageControl(canonical);
  return control;
}

export function storageStatus(): StorageStatus {
  const c = coordinator();
  return c.atomic(() => {
    const state = c.state();
    return {
      generation: state.generation, revision: currentStorageRevision(state), mode: state.mode,
      automationHeld: state.mode !== 'active', spendingHeld: state.mode !== 'active',
      operation: state.operation_id ? c.operation(state.operation_id) : null,
      participants: c.peers().map(row => ({ token: row.token, generation: row.generation, kind: row.kind, pid: row.pid, openedAt: row.opened_at })),
    };
  });
}
export function storageGeneration(): string { return coordinator().state().generation; }
export function storageRevision(): string { return currentStorageRevision(coordinator().state()); }

function currentStorageRevision(state: State): string {
  return `${state.revision}:${participant?.observedRevision() ?? 'unopened'}`;
}

export function assertStorageAdmission(input: { automatic?: boolean; paid?: boolean } = {}): void {
  assertStorageRuntimeSideEffects(input);
  const state = coordinator().state();
  if (state.mode === 'maintenance') throw new Error('Storage maintenance is active. No new work may start; inspect the restore journal.');
  if (state.mode === 'inspection' && (input.automatic || input.paid)) {
    throw new Error(input.paid
      ? 'Restored spending is historical. Paid admission remains held until post-backup liability and spending are reconciled; that reconciliation is not yet supported.'
      : 'The restored database is in inspection mode. Archived jobs and automatic actions are not authorized to run again.');
  }
}

export class StorageParticipant {
  readonly token = randomUUID();
  readonly generation: string;
  private native: Database.Database | null = null;
  private closed = false;
  private asynchronous = 0;

  constructor(private readonly c: StorageControl) {
    this.generation = c.atomic(() => {
      const state = c.state();
      if (state.mode === 'maintenance') {
        const operation = c.operation(state.operation_id!);
        throw new Error(`Storage recovery required: restore ${operation?.id} is ${operation?.phase}. The database stays closed. ` +
          `Journal: ${c.file}. Retained originals: ${operation?.replaced_dir}. Staging: ${operation?.staging_dir}. ` +
          'Automatic repair or barrier takeover is unsupported; preserve these files for inspection.');
      }
      assertDatabaseFileIdentity(c, state);
      c.prepare('INSERT INTO participants VALUES(?,?,?,?,?,NULL,1)').run(this.token, state.generation,
        process.argv.includes('--daemon') ? 'scheduler' : process.argv.includes('--cli') ? 'cli' : 'app', process.pid, Date.now());
      return state.generation;
    });
  }

  /** Native bootstrap follows the same control → evidence-DB lock order as
   * every guarded query. Inspection permits only these controlled migrations. */
  initialize<T>(action: () => T): T {
    return this.c.atomic(() => {
      const state = this.c.state();
      if (state.mode === 'maintenance' || state.generation !== this.generation || this.closed) {
        throw new Error('Storage initialization is fenced by maintenance or another generation.');
      }
      const result = action();
      this.c.advanceRevision();
      return result;
    });
  }

  attach(native: Database.Database): void {
    this.native = native;
    this.c.atomic(() => {
      const state = this.c.state();
      assertDatabaseFileIdentity(this.c, state);
      const fileIdentity = databaseFileIdentity(this.c.root);
      if (!state.database_identity) this.c.prepare('UPDATE state SET database_identity=? WHERE singleton=1').run(fileIdentity);
      const exists = native.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='storage_identity'").get();
      if (exists) {
        const row = native.prepare('SELECT generation FROM storage_identity WHERE singleton=1').get() as { generation: string } | undefined;
        if (row?.generation !== this.generation) throw new Error('Storage recovery required: the database generation does not match its external journal.');
      } else {
        // Only initial adoption may lack identity. A restored historical image
        // must be stamped by its coordinator before publication, never on open.
        if (this.c.state().operation_id) throw new Error('Storage recovery required: restored database identity is missing.');
        stampStorageIdentity(native, this.generation);
      }
    });
    process.once('exit', () => { try { this.close(); } catch { /* No acknowledgement is safer than a false one. */ } });
  }

  observedRevision(): string {
    if (!this.native || !this.native.open) return 'closed';
    assertDatabaseFileIdentity(this.c, this.c.state());
    return `${String(this.native.pragma('data_version', { simple: true }))}:${this.databaseRevision()}`;
  }

  owns(native: Database.Database): boolean { return native === this.native; }

  inspectionMode(): boolean { return this.c.state().mode === 'inspection'; }

  access<T>(write: boolean, action: () => T): T {
    return this.c.atomic(() => {
      const state = this.c.state();
      if (this.closed || this.generation !== state.generation || state.mode === 'maintenance') {
        throw new Error('Storage access is fenced: this database handle is closed, belongs to another generation, or maintenance is active.');
      }
      assertDatabaseFileIdentity(this.c, state);
      if (write && state.mode === 'inspection') throw new Error('The restored database is read-only in inspection mode. Historical jobs, approvals and spending cannot authorize new work.');
      const before = write ? this.databaseRevision() : '';
      const value = action();
      // Lazy CREATE IF NOT EXISTS in read helpers is not a new live revision.
      // Native counters also cover DDL and cached statements without relying
      // on a list of business tables or assuming every run() changed a row.
      if (write && before !== this.databaseRevision()) this.c.advanceRevision();
      return value;
    });
  }

  private databaseRevision(): string {
    if (!this.native) throw new Error('Storage participant has no attached database.');
    const row = this.native.prepare('SELECT total_changes() AS changes').get() as { changes: number };
    return `${row.changes}:${String(this.native.pragma('schema_version', { simple: true }))}`;
  }

  async backup<T>(action: () => Promise<T>): Promise<T> {
    this.access(false, () => { this.asynchronous++; });
    try { return await action(); } finally { this.asynchronous--; }
  }

  close(): void {
    if (this.closed) return;
    this.c.atomic(() => {
      if (this.asynchronous) throw new Error('A database backup is still finishing; the connection cannot acknowledge closure.');
      // A close failure leaves the participant registered. No timeout or exit
      // callback may convert this to an acknowledgement without native.close.
      this.native?.close();
      this.closed = true;
      this.c.prepare('UPDATE participants SET closed_at=? WHERE token=? AND generation=? AND closed_at IS NULL')
        .run(Date.now(), this.token, this.generation);
    });
  }

  closeForRestore(): void {
    if (this.asynchronous) throw new Error('A database backup is still finishing; restore must wait.');
    if (!this.native || this.closed) throw new Error('The current database connection is not available for coordinated closure.');
    this.native.pragma('wal_checkpoint(TRUNCATE)');
    this.close();
  }
}

export function registerStorageParticipant(root: string): StorageParticipant {
  if (participant) throw new Error('This process already registered its database participant.');
  participant = new StorageParticipant(coordinator(root));
  return participant;
}

/** The module registry carries this lifecycle guard for modules whose schema
 * arrives after initial bootstrap. Fixture/legacy migration handles are local
 * caller-owned databases; only the live native handle belongs to this owner. */
export function guardStorageMigration<T>(native: Database.Database, action: () => T): T {
  return participant?.owns(native) ? participant.initialize(action) : action();
}

/** Some SQLite PRAGMAs execute while compiling, before Statement.readonly can
 * be inspected. Classify the narrow supported read forms without touching the
 * native connection; every other PRAGMA needs mutation admission first. */
function readOnlyPragma(sql: string): boolean {
  if (typeof sql !== 'string') return false;
  const body = sql.trim().replace(/;$/, '').trim();
  return /^(?:(?:main|temp)\.)?(?:schema_version|data_version|user_version|query_only|foreign_keys|journal_mode|busy_timeout|locking_mode|synchronous|page_count|freelist_count|page_size|database_list|compile_options|collation_list|function_list|module_list|pragma_list|quick_check|integrity_check|foreign_key_check)$/i.test(body)
    || /^(?:(?:main|temp)\.)?(?:table_info|table_xinfo|index_info|index_xinfo|index_list|foreign_key_list)\s*\(\s*(?:[a-z_][a-z0-9_]*|'(?:[^']|'')*'|"(?:[^"]|"")*")\s*\)$/i.test(body);
}

function skipSqlTrivia(sql: string): string {
  let remaining = sql.trimStart();
  for (;;) {
    if (remaining.startsWith(';')) remaining = remaining.slice(1).trimStart();
    else if (remaining.startsWith('--')) {
      const end = remaining.indexOf('\n');
      if (end < 0) return '';
      remaining = remaining.slice(end + 1).trimStart();
    } else if (remaining.startsWith('/*')) {
      const end = remaining.indexOf('*/', 2);
      if (end < 0) return '';
      remaining = remaining.slice(end + 2).trimStart();
    } else return remaining;
  }
}

function preparationMayMutate(sql: string): boolean {
  if (typeof sql !== 'string') return true;
  let body = skipSqlTrivia(sql);
  if (/^EXPLAIN\b/i.test(body)) {
    body = skipSqlTrivia(body.slice(7));
    if (/^QUERY\b/i.test(body)) {
      body = skipSqlTrivia(body.slice(5));
      if (/^PLAN\b/i.test(body)) body = skipSqlTrivia(body.slice(4));
    }
  }
  return /^PRAGMA\b/i.test(body) && !readOnlyPragma(body.slice(6));
}

/** Wrap cached statements too: a db() entry check alone cannot fence a runner
 * retaining a statement or a transaction across an awaited admission gate. */
export function guardStorageDatabase(native: Database.Database, owner: StorageParticipant): Database.Database {
  const statements = new WeakMap<object, object>();
  function statement(stmt: Database.Statement): Database.Statement {
    const cached = statements.get(stmt);
    if (cached) return cached as Database.Statement;
    const wrapped = new Proxy(stmt, { get(target, property) {
      if (property === 'database') return wrappedDatabase;
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => owner.access(!target.readonly, () => {
        const result: unknown = Reflect.apply(value, target, args);
        if (result === target) return wrapped;
        if (property === 'iterate' && result && typeof result === 'object') {
          const iterator = result as IterableIterator<unknown>;
          return { next: () => owner.access(!target.readonly, () => iterator.next()),
            return: () => owner.access(false, () => iterator.return ? iterator.return() : { done: true, value: undefined }),
            [Symbol.iterator]() { return this; } };
        }
        return result;
      });
    } });
    statements.set(stmt, wrapped);
    return wrapped;
  }
  const wrappedDatabase = new Proxy(native, { get(target, property) {
    const value: unknown = Reflect.get(target, property, target);
    if (property === 'close') return () => owner.close();
    if (typeof value !== 'function') return value;
    if (property === 'exec' && owner.inspectionMode()) return (sql: string) => {
      // Legacy read helpers lazily ensure their table. Permit a single no-op
      // CREATE only, with SQLite query_only proving it performs no mutation.
      // Native module migrations retain their privileged bootstrap handle;
      // query_only is scoped to this synchronous no-op attempt, not that handle.
      const single = typeof sql === 'string' ? sql.trim().replace(/;$/, '') : '';
      if (!/^CREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s/i.test(single) || single.includes(';')) {
        throw new Error('The restored database is read-only in inspection mode.');
      }
      return owner.access(false, () => {
        const previous = target.pragma('query_only', { simple: true });
        target.pragma('query_only = ON');
        try { target.prepare(single).run(); return wrappedDatabase; }
        finally { if (!previous) target.pragma('query_only = OFF'); }
      });
    };
    if (property === 'prepare') return (sql: string) => owner.access(preparationMayMutate(sql), () => statement(target.prepare(sql)));
    if (property === 'pragma') return (sql: string, options?: Database.PragmaOptions) =>
      owner.access(!readOnlyPragma(sql), () => target.pragma(sql, options));
    if (property === 'backup') return (...args: unknown[]) => owner.backup(() => Reflect.apply(value, target, args) as Promise<unknown>);
    if (property === 'transaction') return (fn: (...args: unknown[]) => unknown) => {
      const transaction = owner.access(false, () => target.transaction(fn));
      const run = (...args: unknown[]) => owner.access(true, () => transaction(...args));
      for (const mode of ['deferred', 'immediate', 'exclusive'] as const) {
        Object.defineProperty(run, mode, { value: (...args: unknown[]) => owner.access(true, () => transaction[mode](...args)) });
      }
      return run;
    };
    return (...args: unknown[]) => owner.access(true, () => {
      const result: unknown = Reflect.apply(value, target, args);
      return result === target ? wrappedDatabase : result;
    });
  } });
  return wrappedDatabase;
}

function stampStorageIdentity(d: Database.Database, generation: string): void {
  d.exec('CREATE TABLE IF NOT EXISTS storage_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation TEXT NOT NULL)');
  d.prepare('INSERT INTO storage_identity VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET generation=excluded.generation').run(generation);
}

export type StorageRestoreInput = {
  expectedGeneration: string; expectedRevision: string; source: string; manifestDigest: string;
  stagingDir: string; replacedDir: string; validateCurrent: () => void;
};
export type StorageRestoreCoordinator = {
  id: string; generation: string;
  prepareRestoredDatabase: (d: Database.Database) => void;
  closeCurrent: () => void; beforeSwap: () => void; publish: () => void;
  fail: (detail: string) => void; cancel: () => void;
};

/** A handle inventory can REFUSE an observed legacy reader/writer. Its absence
 * is not an exclusion lock: a binary that ignores this protocol can open later.
 * Restore support is explicitly limited to cooperating participants. */
function refuseObservedForeignHandles(root: string): void {
  const executable = process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof';
  if (process.platform === 'win32' || !fs.existsSync(executable)) {
    throw new Error('Coordinated restore is unsupported here: a database-handle inventory is unavailable.');
  }
  let output: string;
  try {
    output = execFileSync(executable, ['-t', '-n', '-P', '--', path.join(root, 'wanigan.db')], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 65536, env: { PATH: '/usr/sbin:/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`Restore refused: database-handle inventory was unavailable or incomplete. ${error instanceof Error ? error.message : String(error)}`);
  }
  const pids = output.trim().split(/\s+/).filter(Boolean).map(Number);
  if (!pids.length || pids.some(pid => !Number.isSafeInteger(pid) || pid < 1)) {
    throw new Error('Restore refused: the database-handle inventory could not identify the current connection.');
  }
  const foreign = pids.filter(pid => pid !== process.pid);
  if (foreign.length) throw new Error(`Restore refused: unregistered/legacy database handles remain open (reported PIDs ${foreign.join(', ')}). Close their owning application deliberately; a PID is not termination authority.`);
}

export function beginStorageRestore(input: StorageRestoreInput): StorageRestoreCoordinator {
  const c = coordinator();
  if (!/^[a-f0-9]{64}$/.test(input.manifestDigest) || typeof input.expectedRevision !== 'string' || !/^[0-9:]{1,100}$/.test(input.expectedRevision) ||
      ![input.source, input.stagingDir, input.replacedDir].every(value => typeof value === 'string' && path.isAbsolute(value) && value.length <= 4096) ||
      ![input.stagingDir, input.replacedDir].every(value => fs.realpathSync.native(path.dirname(value)) === c.root && path.resolve(value) !== c.root)) {
    throw new Error('Restore coordination requires verified digest, revision and private destination paths.');
  }
  const owner = participant;
  if (!owner) throw new Error('Restore requires the current database to register and open first.');
  const id = randomUUID(), generation = randomUUID();
  const prior = c.atomic(() => {
    const state = c.state();
    if (state.mode === 'maintenance') throw new Error('Another restore or unfinished storage operation owns the maintenance barrier.');
    if (input.expectedGeneration !== state.generation || input.expectedRevision !== currentStorageRevision(state)) {
      throw new Error('Storage changed after review. Inspect and confirm a fresh restore preview.');
    }
    const peers = c.peers().filter(row => row.token !== owner.token);
    if (peers.length) throw new Error(`Restore refused: ${peers.length} other database participant(s) have not acknowledged closed handles. ` +
      peers.map(row => `${row.kind} ${row.token} (reported PID ${row.pid}; identity/liveness unproven)`).join(', '));
    refuseObservedForeignHandles(c.root);
    input.validateCurrent();
    if (currentStorageRevision(c.state()) !== input.expectedRevision) throw new Error('Storage changed during restore validation; a fresh preview is required.');
    const now = Date.now();
    c.prepare('INSERT INTO restores VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(id, state.generation, generation,
      'prepared', input.source, input.manifestDigest, input.stagingDir, input.replacedDir, now, now);
    c.prepare("UPDATE state SET mode='maintenance',operation_id=?,revision=revision+1 WHERE singleton=1").run(id);
    return state;
  });
  let closed = false;
  function current(phases: string[]): StorageRestoreOperation {
    const state = c.state(), operation = c.operation(id);
    if (state.operation_id !== id || state.mode !== 'maintenance' || !operation || !phases.includes(operation.phase)) {
      throw new Error('The restore coordinator is stale or this journal transition has already been applied.');
    }
    return operation;
  }
  function phase(value: string, detail: string | null = null): void {
    c.prepare('UPDATE restores SET phase=?,updated_at=?,detail=? WHERE id=?').run(value, Date.now(), detail, id);
  }
  return {
    id, generation,
    prepareRestoredDatabase(d) { c.atomic(() => { current(['prepared']); stampStorageIdentity(d, generation); }); },
    closeCurrent() {
      c.atomic(() => { current(['prepared']); owner.closeForRestore(); closed = true; phase('closed'); });
    },
    beforeSwap() { c.atomic(() => { current(['closed']); phase('swapping'); }); },
    publish() {
      c.atomic(() => {
        current(['swapping']);
        const installed = new Database(path.join(c.root, 'wanigan.db'), { readonly: true, fileMustExist: true });
        try {
          const row = installed.prepare('SELECT generation FROM storage_identity WHERE singleton=1').get() as { generation: string } | undefined;
          if (row?.generation !== generation) throw new Error('Installed database does not match the destination generation; storage remains fenced.');
          if (installed.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Installed database failed integrity checking.');
        } finally { installed.close(); }
        phase('published');
        c.prepare("UPDATE state SET generation=?,database_identity=?,mode='inspection',revision=revision+1 WHERE singleton=1").run(generation, databaseFileIdentity(c.root));
      });
    },
    fail(detail) {
      c.atomic(() => { current(['prepared', 'closed', 'swapping']); phase('failed', String(detail).slice(0, 2000)); });
    },
    cancel() {
      c.atomic(() => {
        current(['prepared']);
        if (closed) throw new Error('A closed database requires restart/recovery even if the files were rolled back.');
        phase('canceled');
        c.prepare('UPDATE state SET mode=?,operation_id=?,revision=revision+1 WHERE singleton=1').run(prior.mode, prior.operation_id);
      });
    },
  };
}
