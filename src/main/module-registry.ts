import type Database from 'better-sqlite3';
import type { BrowserWindow } from 'electron';
import type { ConsumptionPoint, EgressHost, ModelConsumption, QueueKind } from '../shared/types';

/**
 * The main-process half of "everything is a module" (AGENTS.md).
 *
 * A feature used to reach the main process through three hand-edits in two
 * files: a `migrate*` call in `db.ts`, a run of `handle('feature:…')` lines in
 * `index.ts`, and — for anything recurring — a `queue.registerRunner` beside a
 * schedule upsert somewhere in startup. Nothing tied the three together, so
 * nothing could say which channels a feature owned, which tables it had made,
 * or whether removing it would leave a runner with no schedule or a schedule
 * with no runner. This is the seam those edits collapse into: a module declares
 * its schema, its channels and its recurring work once, and `db.ts`, `index.ts`
 * and the scheduler each read that one record.
 *
 * The renderer half is `src/shared/view-module.ts`, which is how a destination
 * declares its route, icon, shortcut and phone disposition. A feature registers
 * once with each — this file does not know what a view is, and that file does
 * not know what a table is. Keeping the two apart is deliberate: this file runs
 * with Electron and SQLite in scope, that one is pure and tested in under a
 * second, and a shared record would drag one into the other.
 *
 * This is not the extension manifest either. A third-party extension is
 * declarations over surfaces that already exist and never loads code; a module
 * here is first-party code that *provides* one of those surfaces.
 */

/**
 * `index.ts`'s own IPC wrapper — sender trust, demo gating, the `{ok, error}`
 * envelope — passed in so a module registers a channel through it and cannot
 * reach `ipcMain` around it.
 */
/** Guarded fire-and-forget traffic; the host retains sender/demo checks. */
export type IpcOn = (channel: string, fn: (...args: never[]) => void) => void;

export type IpcHandle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => void;

/** Runtime-owned capabilities a module may need without discovering globals. */
export type ModuleIpcContext = {
  /** The exact window owned by index.ts at the moment the handler runs. */
  getWindow: () => BrowserWindow | null;
  /** Reconcile app-wide power management after a module starts an agent. */
  onAgentLaunched?: () => void;
};

/**
 * Recurring work, declared rather than wired.
 *
 * `kind` is a queue lane rather than a free string because lanes are a closed
 * union: each one is metered by its own slot setting and gated by the budget
 * check in `goal-gate`, and a module inventing a lane would run unmetered. So a
 * module names the lane it dispatches on, and the queue keeps deciding how
 * many of it may run. `run` receives the fired row's payload untrusted, exactly
 * as a `queue.registerRunner` callback does, because a payload check ("is this
 * really my schedule?") is part of the work and belongs with it. `sync` writes
 * or re-arms the durable `schedules` row at startup, the way the hand-wired
 * `syncWeeklySchedule()` call did beside its runner.
 */
export type ModuleSchedule = {
  /** The durable `schedules` row this module owns. */
  id: string;
  kind: QueueKind;
  /** What fires, in a sentence: a bare schedule id is a schedule nobody audits. */
  describe: string;
  run: (payload: unknown) => Promise<void>;
  sync: () => void;
};

/** Free module upkeep; separate from queue lanes that authorize paid work. */
export type ModuleMaintenance = {
  id: string;
  intervalMs: number;
  run: () => Promise<void>;
};

export type WaniganModule = {
  /** Namespaces every IPC channel the module owns: `${id}:…`. */
  id: string;
  label: string;
  /**
   * A required module cannot be disabled or removed and says why (AGENTS.md:
   * "Required is a declared property carrying its reason"). `null` means a
   * person may switch it off, and the module should say what that costs them.
   */
  required: { reason: string } | null;
  /**
   * Additive schema, the same contract as every `migrate*` in `db.ts`: CREATE
   * IF NOT EXISTS, ADD COLUMN guarded by a read, never DROP. Called inside
   * `db.ts`'s migration pass — inside its transaction, after the built-in
   * migrations — in registration order. Required schemas with legacy dependents
   * may also bootstrap earlier through migrateRequiredModule.
   */
  migrate?: (d: Database.Database) => void;
  /**
   * IPC channels this module owns. Every channel MUST start with `${id}:`; the
   * registry refuses one that does not, because a channel outside a module's
   * namespace is a channel nobody can attribute.
   */
  ipc?: (handle: IpcHandle, context: ModuleIpcContext) => void;
  /** Fire-and-forget channels use the same module namespace and host trust boundary. */
  events?: (on: IpcOn) => void;
  /** Module-local IPC operations that require the app's services to be ready. */
  requiresStartedServices?: readonly string[];
  schedules?: () => ModuleSchedule[];
  /** Declared here; the runtime host owns starting and stopping these timers. */
  maintenance?: () => ModuleMaintenance[];
  /** Outbound destinations and their current conditions. Local reads only;
   * include disabled capabilities with activeNow false, without probing them. */
  egress?: () => EgressHost[];
  /** Local recorded consumption outside agent sessions. Reads must never call
   * a provider or infer a quota. `since` is the Usage ledger's clamped cutoff;
   * the module owns its records and preserves estimates apart from billed cost. */
  usage?: {
    consumption: (since: number) => ModelConsumption[];
    daily: (since: number) => ConsumptionPoint[];
  };
};

const registry: WaniganModule[] = [];

/**
 * The handle the migration pass ran on, kept once it has. A module that
 * registers after the pass is migrated on the spot, in its own transaction on
 * this same handle, so its tables exist from the moment it is registered.
 *
 * This used to be a refusal: "register before the first db() call". It was
 * the wrong tool. index.ts's imports evaluate before its body, and somewhere
 * down the chain a module opens the database on load — so the pass had run
 * before any body-level registration could, and the app threw during load on
 * every fresh-database smoke run. Moving the registration to the first import
 * did not help, because the module being registered imports that same chain.
 * Evaluation order is not a contract a feature should have to know about;
 * migrating late instead makes the order irrelevant, and the named failure the
 * refusal was protecting against — a first query hitting "no such table" —
 * cannot happen, because the table is created before registerModule returns.
 */
let migratedOn: Database.Database | null = null;

export function registerModule(module: WaniganModule): void {
  if (!/^[a-z][a-z0-9-]*$/.test(module.id)) {
    throw new Error(`Module id "${module.id}" must be lower-case letters, digits and hyphens: it prefixes every IPC channel the module owns.`);
  }
  if (registry.some((entry) => entry.id === module.id)) {
    throw new Error(`Module "${module.id}" is already registered. One feature registers once; a second registration is two features claiming one namespace.`);
  }
  registry.push(module);
  // Late is fine; see the note on migratedOn. Additive migrations are safe to
  // run alone, and a failure here surfaces at registration with the module's
  // name on it rather than at some later query with nobody's.
  if (migratedOn && module.migrate) {
    const d = migratedOn;
    d.transaction(() => module.migrate!(d))();
  }
}

export function modules(): readonly WaniganModule[] {
  return registry;
}

/** Startup policy is declared beside the operation, not restated in index.ts. */
export function moduleNeedsStartedServices(channel: string): boolean {
  return registry.some((module) => module.requiresStartedServices?.some(
    (operation) => channel === `${module.id}:${operation}`,
  ));
}

/**
 * Bootstrap a required module at an existing legacy dependency boundary.
 * Some built-in migrations still extend a required module's tables before
 * runtime imports can finish registration. Keep that order explicit while
 * the module remains the sole schema owner; the normal pass is idempotent.
 */
export function migrateRequiredModule(module: WaniganModule, d: Database.Database): void {
  if (!module.required?.reason.trim()) {
    throw new Error(`Module "${module.id}" must declare why it is required before its schema can bootstrap legacy dependencies.`);
  }
  module.migrate?.(d);
}

/** Called from `db.ts` after the built-in `migrate*` functions, inside their transaction. */
export function migrateModules(d: Database.Database): void {
  for (const module of registry) module.migrate?.(d);
  migratedOn = d;
}

/** Called from `index.ts` once, inside `registerIpc()`, with its own `handle`. */
export function registerModuleIpc(
  handle: IpcHandle,
  context: ModuleIpcContext = { getWindow: () => null },
): void {
  for (const module of registry) {
    const prefix = `${module.id}:`;
    const scoped: IpcHandle = (channel, fn) => {
      if (!channel.startsWith(prefix)) {
        throw new Error(`Module "${module.id}" tried to register IPC channel "${channel}" outside its namespace "${prefix}".`);
      }
      handle(channel, fn);
    };
    module.ipc?.(scoped, context);
  }
}

/** Every module's recurring work, flattened for the scheduler in registration order. */
export function moduleSchedules(): ModuleSchedule[] {
  return registry.flatMap((module) => module.schedules?.() ?? []);
}

/** Register hot-path traffic through the host's guarded event wrapper. */
export function registerModuleEvents(on: IpcOn): void {
  for (const module of registry) {
    const prefix = `${module.id}:`;
    module.events?.((channel, fn) => {
      if (!channel.startsWith(prefix)) {
        throw new Error(`Module "${module.id}" tried to register IPC event "${channel}" outside its namespace "${prefix}".`);
      }
      on(channel, fn);
    });
  }
}
