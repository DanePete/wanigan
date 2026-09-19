import type Database from 'better-sqlite3';
import type { DocketPlanNode } from '../../shared/types';
import type { WaniganModule } from '../module-registry';

/** Idempotent ALTER TABLE — SQLite has no "ADD COLUMN IF NOT EXISTS". */
function addColumn(d: Database.Database, table: string, column: string, decl: string) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/**
 * P30 · Durable agent control plane.
 *
 * A terminal is an execution detail, not the record of a piece of work. These
 * rows preserve the human contract (objective, acceptance, evidence and
 * decision) across a terminal exit, provider swap, app restart, or a handoff
 * to a second agent. Prompts and terminal output deliberately stay out of the
 * coordination tables; their owning session/transcript remains the source.
 */
function migrate(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS work_dockets (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title           TEXT NOT NULL,
      objective       TEXT NOT NULL,
      acceptance_json TEXT NOT NULL DEFAULT '[]',
      risk            TEXT NOT NULL DEFAULT 'elevated',
      budget_usd      REAL,
      base_commit     TEXT,
      status          TEXT NOT NULL DEFAULT 'draft',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_dockets_project_updated
      ON work_dockets(project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_work_dockets_status_updated
      ON work_dockets(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS work_nodes (
      id              TEXT PRIMARY KEY,
      docket_id       TEXT NOT NULL REFERENCES work_dockets(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL,
      title           TEXT NOT NULL,
      instructions    TEXT NOT NULL,
      depends_json    TEXT NOT NULL DEFAULT '[]',
      status          TEXT NOT NULL DEFAULT 'pending',
      provider_id     TEXT,
      model           TEXT,
      session_id      TEXT,
      worktree        TEXT,
      started_at      INTEGER,
      ended_at        INTEGER,
      detail          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_work_nodes_docket ON work_nodes(docket_id, id);
    CREATE INDEX IF NOT EXISTS idx_work_nodes_session ON work_nodes(session_id);

    CREATE TABLE IF NOT EXISTS work_claims (
      id          TEXT PRIMARY KEY,
      docket_id   TEXT NOT NULL REFERENCES work_dockets(id) ON DELETE CASCADE,
      node_id     TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
      path        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      released_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_work_claims_open ON work_claims(path) WHERE released_at IS NULL;

    CREATE TABLE IF NOT EXISTS work_proofs (
      id           TEXT PRIMARY KEY,
      docket_id    TEXT NOT NULL REFERENCES work_dockets(id) ON DELETE CASCADE,
      node_id      TEXT REFERENCES work_nodes(id) ON DELETE SET NULL,
      kind         TEXT NOT NULL,
      status       TEXT NOT NULL,
      summary      TEXT NOT NULL,
      detail_json  TEXT NOT NULL DEFAULT '{}',
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_proofs_docket ON work_proofs(docket_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS work_checkpoints (
      id              TEXT PRIMARY KEY,
      docket_id       TEXT NOT NULL REFERENCES work_dockets(id) ON DELETE CASCADE,
      node_id         TEXT REFERENCES work_nodes(id) ON DELETE SET NULL,
      session_id      TEXT,
      conversation_id TEXT,
      repo_commit     TEXT,
      worktree        TEXT,
      note            TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_checkpoints_docket ON work_checkpoints(docket_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS work_model_outcomes (
      id            TEXT PRIMARY KEY,
      docket_id     TEXT NOT NULL REFERENCES work_dockets(id) ON DELETE CASCADE,
      node_id       TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
      provider_id   TEXT NOT NULL,
      model         TEXT NOT NULL,
      task_kind     TEXT NOT NULL,
      accepted      INTEGER NOT NULL DEFAULT 0,
      tests_passed  INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      UNIQUE(node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_model_outcomes_route
      ON work_model_outcomes(provider_id, model, task_kind, created_at DESC);

    CREATE TABLE IF NOT EXISTS control_events (
      id          TEXT PRIMARY KEY,
      project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
      source      TEXT NOT NULL,
      kind        TEXT NOT NULL,
      summary     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'new',
      docket_id   TEXT REFERENCES work_dockets(id) ON DELETE SET NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_control_events_status ON control_events(status, created_at DESC);

    -- This mirrors the safe, server-owned task lifecycle from the current MCP
    -- Tasks extension. It is an adapter boundary, not a claim that Wanigan
    -- implements every experimental wire version.
    CREATE TABLE IF NOT EXISTS mcp_task_records (
      id          TEXT PRIMARY KEY,
      docket_id   TEXT NOT NULL REFERENCES work_dockets(id) ON DELETE CASCADE,
      node_id     TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'working',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      UNIQUE(node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_task_records_status ON mcp_task_records(status, updated_at DESC);

    -- Recovery facts identify the exact conversation and worktree a Goal task
    -- owns. They exclude prompts and terminal output.
    CREATE TABLE IF NOT EXISTS work_resume_receipts (
      node_id         TEXT PRIMARY KEY REFERENCES work_nodes(id) ON DELETE CASCADE,
      docket_id       TEXT NOT NULL REFERENCES work_dockets(id) ON DELETE CASCADE,
      session_id      TEXT NOT NULL,
      conversation_id TEXT,
      provider_id     TEXT NOT NULL,
      model           TEXT,
      base_commit     TEXT,
      worktree        TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_resume_receipts_docket ON work_resume_receipts(docket_id, updated_at DESC);

    -- Provider-neutral, content-free operational evidence. The terminal and
    -- provider retain any prompt or response content; Control records only
    -- linkage, timing, spend, token totals and safe summaries.
    CREATE TABLE IF NOT EXISTS work_trace_events (
      id           TEXT PRIMARY KEY,
      docket_id    TEXT NOT NULL REFERENCES work_dockets(id) ON DELETE CASCADE,
      node_id      TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
      session_id   TEXT NOT NULL,
      source       TEXT NOT NULL,
      kind         TEXT NOT NULL,
      status       TEXT NOT NULL,
      tool_name    TEXT,
      summary      TEXT,
      duration_ms  INTEGER,
      cost_usd     REAL NOT NULL DEFAULT 0,
      in_tokens    INTEGER NOT NULL DEFAULT 0,
      out_tokens   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_trace_events_docket ON work_trace_events(docket_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_work_trace_events_session ON work_trace_events(session_id, created_at DESC);

    -- The sessions a task ran under, kept past the life of the pointer on the
    -- task row. work_nodes.session_id is a live pointer that retryNode nulls,
    -- and a goal's spend against its cap is summed over the sessions it can
    -- see, so without this table reopening a task handed the money it had
    -- already spent back to the cap, and a goal whose tasks had all been
    -- reopened reported that it had launched nothing. A row is written when a
    -- dispatch claims the task, and again by retryNode before it nulls the
    -- pointer — which covers a task dispatched before this table existed, but
    -- not one already reopened by then. Append-only: nothing issues a DELETE
    -- against it, and a row leaves only with the task or project it belongs to.
    -- It holds the task, its goal, the session id and when the row was
    -- written, and nothing else.
    CREATE TABLE IF NOT EXISTS work_node_sessions (
      node_id    TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
      docket_id  TEXT NOT NULL REFERENCES work_dockets(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      at         INTEGER NOT NULL,
      PRIMARY KEY (node_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_node_sessions_docket ON work_node_sessions(docket_id);
  `);

  // P31 · a docket is a graph, not a fixed four-step chain.
  //
  // `depends_json` always described an arbitrary DAG; nothing ever wrote one.
  // Declaring the path a node intends to own is what makes fan-out safe to
  // plan: two nodes that can run at the same time and want the same directory
  // are a conflict the planner can be told about, instead of a merge the
  // operator discovers later. Nullable, because a node that declares nothing
  // simply takes no claim when it starts.
  addColumn(d, 'work_nodes', 'claim_path', 'TEXT');

  // Autopilot dispatch. The provider/model are frozen per docket at the moment
  // consent is given, so a later default change cannot silently redirect work
  // already running unattended.
  addColumn(d, 'work_dockets', 'autopilot', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(d, 'work_dockets', 'autopilot_provider', 'TEXT');
  addColumn(d, 'work_dockets', 'autopilot_model', 'TEXT');
  // Marks a node the sweep has already handed to the queue. Without a durable
  // marker the sweep re-enqueues the same node every tick until the runner
  // wins the race, and the losers burn queue attempts on an error.
  addColumn(d, 'work_nodes', 'dispatch_state', 'TEXT');
  // Whether the CLI reported a cost for the session behind an outcome. The
  // column used to hold 0 for both "reported nothing" and "reported zero", so
  // the Outcome router totalled unmetered work as free and ranked it cheapest —
  // the one thing CLAUDE.md says never to do with an unpriced call. Existing
  // rows default to 0: they were written before the distinction was recorded,
  // and claiming they were reported would be inventing evidence. `effort` joins
  // them because a router that cannot say which effort produced a result cannot
  // answer whether the expensive one was worth it.
  addColumn(d, 'work_model_outcomes', 'cost_reported', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(d, 'work_model_outcomes', 'effort', 'TEXT');
  // A ticket the operator parked until a date. Null is the normal case: work
  // that is ready is ready. This is what lets the board hold a real backlog —
  // "not now, but not never" — instead of forcing every known issue to be
  // either in progress or forgotten.
  addColumn(d, 'work_nodes', 'defer_until', 'INTEGER');
  // When a task was last reopened. A gate proof written before it is evidence
  // about a tree the reopened work has since replaced, so it must not complete
  // the task a second time — hasPassedProof in control.ts and the phone's gate
  // reading both count only proofs from after this moment.
  addColumn(d, 'work_nodes', 'reopened_at', 'INTEGER');
  // Verified done, opted into per goal. `gate_on_stop` runs the review gate
  // each time an implementation or verification agent stops, and holds an
  // implementation task until a gate has passed. `return_failures` types a
  // failed gate's error lines back into that session, which starts another
  // agent turn and so spends tokens: off unless chosen, and never on without
  // the gate. `gate_returns` counts those per task run so the cap holds across
  // a restart; starting or reopening the task resets it.
  addColumn(d, 'work_dockets', 'gate_on_stop', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(d, 'work_dockets', 'return_failures', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(d, 'work_nodes', 'gate_returns', 'INTEGER NOT NULL DEFAULT 0');
  // The interview that produced a goal, kept after it did.
  //
  // Durable rather than in memory because an interview is ten minutes of the
  // operator's own answers, and losing that to a quit — or to the app crashing
  // on question nine — costs them the work and the money already spent on it.
  // The transcript stays after the goal is written: it is the record of why the
  // acceptance checks say what they say, which is the question somebody asks
  // three weeks later when one of them fails.
  d.exec(`
    CREATE TABLE IF NOT EXISTS interviews (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      seed          TEXT NOT NULL,
      model         TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'asking',
      turns_json    TEXT NOT NULL DEFAULT '[]',
      proposal_json TEXT,
      docket_id     TEXT,
      spend_usd     REAL NOT NULL DEFAULT 0,
      budget_usd    REAL NOT NULL,
      calls         INTEGER NOT NULL DEFAULT 0,
      detail        TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_interviews_project ON interviews(project_id, updated_at DESC);
  `);
  // How hard the operator asked to be grilled. The dial used to be a dollar
  // budget, which was the wrong thing to put in front of them: a whole
  // interview costs between ten and thirty cents, so every option on that menu
  // meant "yes". The budget still exists as a runaway guard and is derived from
  // this. Rows written before it default to the standard length.
  addColumn(d, 'interviews', 'max_questions', 'INTEGER NOT NULL DEFAULT 10');

  // The third field of the same decision. `provider_id` and `model` are already
  // on the node, and effort is what the two of them leave unsaid: the same
  // provider and model at two efforts are two different runs with two different
  // prices. A controlled experiment has to pin provider, model, effort and
  // commit before a token-saving claim means anything, and a column that only
  // records two of the four cannot support one. Nullable: rows written before
  // this, and providers that expose no effort dial, genuinely have no value —
  // defaulting them to a level nobody chose would be inventing evidence.
  addColumn(d, 'work_nodes', 'effort', 'TEXT');
  // Counts the automatic hand-backs a task has taken, so the cap on them holds
  // across a restart. An in-memory counter resets when the app quits, and a
  // hand-back loop that forgets how many it has already spent is a loop that
  // spends tokens without end. Existing rows default to 0, which is the truth
  // about them: nothing was handed back before this was counted.
  addColumn(d, 'work_nodes', 'handbacks', 'INTEGER NOT NULL DEFAULT 0');
  // What a stage launches as, beside the provider/model/effort already here.
  // A phase is a session, so a phase should be able to pin what a session pins:
  // a relay that could route the work but not say which account paid for it
  // billed whichever account the project happened to default to, across five
  // phases, with the estimate phase promising the operator knew the cost first.
  // NULL keeps the old behaviour exactly — resolve() falls to the project's
  // account and startNode to its per-kind default — so every existing row and
  // every ordinary goal is unchanged.
  addColumn(d, 'work_nodes', 'account_id', 'TEXT');
  addColumn(d, 'work_nodes', 'permission_mode', 'TEXT');
  d.exec('CREATE INDEX IF NOT EXISTS idx_work_nodes_dispatch ON work_nodes(dispatch_state) WHERE dispatch_state IS NOT NULL');
  d.exec('CREATE INDEX IF NOT EXISTS idx_work_nodes_defer ON work_nodes(defer_until) WHERE defer_until IS NOT NULL');
}

/**
 * Control owns the durable goal, dispatch and evidence boundary. The runtime
 * implementation remains in ../control.ts. Keep this declaration free of
 * runtime imports: legacy migrations depend on its tables before session and
 * credential services can load. IPC already awaits each handler, so loading
 * the implementation on invocation preserves the existing renderer contract.
 */
export const controlModule: WaniganModule = {
  id: 'control',
  label: 'Control',
  required: {
    reason: 'Control owns goal dispatch, session recovery and the evidence used to decide whether work is verified.',
  },
  migrate,
  ipc(handle) {
    handle('control:list', async (projectId?: string | null, limit?: number) => (await import('../control')).listDockets(projectId, limit));
    handle('control:get', async (id: string) => (await import('../control')).docket(id));
    handle('control:sessionGoal', async (id: string) => (await import('../control')).sessionGoal(id));
    handle('control:create', async (input: {
      projectId: string; title: string; objective: string; acceptance?: string[];
      risk?: 'low' | 'elevated' | 'high'; budgetUsd?: number | null; plan?: DocketPlanNode[];
    }) => (await import('../control')).createDocket(input));
    handle('control:claim', async (nodeId: string, relPath: string) => (await import('../control')).claimPath(nodeId, relPath));
    handle('control:releaseClaim', async (id: string) => (await import('../control')).releaseClaim(id));
    handle('control:start', async (nodeId: string, input: { providerId: string; model?: string; effort?: string; permissionMode?: string }) =>
      (await import('../control')).startNode(nodeId, input));
    handle('control:retry', async (nodeId: string) => (await import('../control')).retryNode(nodeId));
    handle('control:checkpoint', async (nodeId: string, note: string) => (await import('../control')).checkpointNode(nodeId, note));
    handle('control:runProof', async (nodeId: string) => (await import('../control')).runProof(nodeId));
    handle('control:complete', async (nodeId: string, input?: { detail?: string; decision?: 'approve' | 'request_changes' | 'reject' }) =>
      (await import('../control')).completeNode(nodeId, input ?? {}));
    handle('control:setAutopilot', async (docketId: string, input: { enabled: boolean; providerId?: string; model?: string | null }) =>
      (await import('../control')).setAutopilot(docketId, input));
    // Budget is a separate call rather than a field on setAutopilot: arming and
    // capping are two decisions, and a goal created without a cap needs a way to
    // get one before it can ever be armed. The value stays untrusted until
    // setDocketBudget bounds it in the main process.
    handle('control:setBudget', async (docketId: string, budgetUsd: number | null) =>
      (await import('../control')).setDocketBudget(docketId, budgetUsd));
    handle('control:setGate', async (docketId: string, input: { onStop: boolean; returnFailures: boolean }) =>
      (await import('../control')).setGoalGate(docketId, input ?? {}));
    // The board reads the same rows the goal graph does, a second way. There is
    // no ticket table behind it — see control.boardCards.
    handle('control:board', async (projectId?: string | null, limit?: number) =>
      (await import('../control')).boardCards({ projectId, limit }));
    handle('control:defer', async (nodeId: string, until: number | null) => (await import('../control')).deferNode(nodeId, until));
    handle('control:outcomes', async (projectId?: string | null) => (await import('../control')).outcomes(projectId));
    handle('control:events', async (status?: 'new' | 'triaged' | 'dismissed' | 'all', limit?: number) => (await import('../control')).listEvents(status ?? 'all', limit));
    handle('control:addEvent', async (input: { projectId?: string | null; source: string; kind: string; summary: string }) => (await import('../control')).addEvent(input));
    handle('control:triageEvent', async (id: string, input?: { title?: string; acceptance?: string[]; risk?: 'low' | 'elevated' | 'high' }) =>
      (await import('../control')).triageEvent(id, input ?? {}));
    handle('control:dismissEvent', async (id: string) => (await import('../control')).dismissEvent(id));
    handle('control:mcpTasks', async (docketId?: string) => (await import('../control')).mcpTasks(docketId));
    handle('control:cancelMcpTask', async (id: string) => (await import('../control')).cancelMcpTask(id));
    handle('control:resumeReceipts', async (docketId: string) => (await import('../control')).resumeReceipts(docketId));
    handle('control:traces', async (docketId: string, limit?: number) => (await import('../control')).traces(docketId, limit));
    handle('control:plan', async (docketId: unknown) => {
      if (typeof docketId !== 'string' || !docketId) throw new Error('Choose a goal.');
      return (await import('../control')).goalPlan(docketId);
    });
  },
};
