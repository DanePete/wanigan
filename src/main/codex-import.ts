import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as accounts from './accounts';
import { db } from './db';
import { detectProviders, shellPath } from './providers';
import { projectById } from './store';
import { exitReason, probeEnv, takeStderr } from './codex-status';
import {
  NOT_IMPORTED, importRefusal, isMethodMissing, ledgerThreadFor, parseImportCompleted, sessionImportRequest,
  type CodexImportOutcome, type CodexImportPlan, type ImportResult,
} from '../shared/codex-import';

/**
 * Continue a Claude Code conversation in Codex — the main-process half.
 *
 * The consent comes first and is exact: the dialog is built from
 * `planCodexImport`, which names the one transcript file, the one Codex account
 * (its CODEX_HOME) and everything that will not be sent. The import then
 * re-plans and refuses unless the transcript it would send is the one the
 * operator confirmed.
 *
 * The import itself is a short-lived `codex app-server --stdio` under that
 * account, the same way codex-status reads limits, sending one
 * `externalAgentConfig/import` with one SESSIONS item. Plugins are disabled on
 * that child: the import needs none, and without the flag a fresh home clones
 * a plugin catalogue from the network before it answers. If Codex asks for
 * anything during the import — an approval, a login, a turn — the child is
 * stopped and the request is reported, unanswered.
 */

const IMPORT_TIMEOUT_MS = 120_000;

type SessionRow = {
  id: string; conversation_id: string | null; provider_id: string; project_id: string | null;
  project_path: string; project_name: string; worktree: string | null; harness_id: string | null;
  account_id: string | null; title: string | null;
};

function codexAccounts(): CodexImportPlan['codexAccounts'] {
  try {
    return accounts.list('codex').map((a) => ({ accountId: a.id, label: a.label, home: path.resolve(a.configDir) }));
  } catch { return []; }
}

function realpath(p: string): string | null {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

/** The exact transcript for a Claude conversation: its own account's directory first, then every known root. */
function claudeTranscript(row: SessionRow): string | null {
  if (!row.conversation_id || !/^[0-9a-f-]{36}$/i.test(row.conversation_id)) return null;
  const roots: string[] = [];
  const own = row.account_id ? accounts.byId(row.account_id) : null;
  if (own && own.harness === 'claude-code') roots.push(own.configDir);
  try { roots.push(...accounts.readRoots('claude-code')); } catch { /* accounts unavailable */ }
  const cwds = [row.worktree, row.project_path].filter((c): c is string => typeof c === 'string' && c.length > 0);
  for (const root of [...new Set(roots)]) {
    for (const cwd of cwds) {
      const slug = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
      const file = path.join(root, 'projects', slug, `${row.conversation_id}.jsonl`);
      try { if (fs.statSync(file).isFile()) return file; } catch { /* not here */ }
    }
  }
  return null;
}

async function codexBin(): Promise<{ path: string | null; version: string | null }> {
  try {
    const codex = (await detectProviders()).find((p) => p.harnessId === 'codex' && p.path);
    return { path: codex?.path ?? null, version: codex?.version ?? null };
  } catch { return { path: null, version: null }; }
}

export async function planCodexImport(sessionId: unknown, accountId: unknown): Promise<CodexImportPlan> {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('A conversation is required.');
  const row = db().prepare(`
    SELECT id, conversation_id, provider_id, project_id, project_path, project_name, worktree, harness_id, account_id, title
    FROM session_log WHERE id = ?
  `).get(sessionId) as SessionRow | undefined;
  if (!row) throw new Error('That conversation is no longer in Wanigan’s history.');
  const project = row.project_id ? projectById(row.project_id) : null;
  const all = codexAccounts();
  const chosen = typeof accountId === 'string' && accountId
    ? all.find((a) => a.accountId === accountId) ?? null
    : (() => {
      const resolved = accounts.resolve({ harness: 'codex', projectId: row.project_id ?? undefined }).account;
      return resolved ? all.find((a) => a.accountId === resolved.id) ?? null : all[0] ?? null;
    })();
  const bin = await codexBin();
  const transcript = claudeTranscript(row);
  let bytes = 0;
  if (transcript) { try { bytes = fs.statSync(transcript).size; } catch { bytes = 0; } }

  let refusal: string | null = null;
  const harness = row.harness_id ?? (row.provider_id === 'claude' ? 'claude-code' : null);
  if (harness !== 'claude-code') refusal = 'Only a Claude Code conversation can be continued in Codex.';
  else if (!row.conversation_id) refusal = 'This conversation has no recorded Claude session id, so there is no exact transcript to import.';
  else if (!transcript) refusal = 'The Claude transcript for this conversation is not on disk any more.';
  else if (!project) refusal = 'The project this conversation ran in is no longer registered, so Codex would have no folder to resume it in.';
  else if (!bin.path) refusal = 'Codex is not installed, so there is nothing to import into.';
  else if (!chosen) refusal = 'No Codex account is configured in Wanigan. Add one under Settings › Accounts first.';
  else {
    const real = realpath(transcript);
    const homeProjects = realpath(path.join(os.homedir(), '.claude', 'projects'));
    refusal = !real || !homeProjects
      ? `Codex 0.154 imports only transcripts under ${path.join(os.homedir(), '.claude', 'projects')}, which does not exist on this Mac. Unsupported for this account.`
      : importRefusal(real, homeProjects);
  }
  return {
    sessionId: row.id,
    conversationId: row.conversation_id,
    title: row.title,
    projectId: project?.id ?? null,
    projectName: row.project_name,
    cwd: project?.path ?? row.project_path,
    transcript: transcript ? { path: transcript, bytes } : null,
    codex: chosen,
    codexAccounts: all,
    codexVersion: bin.version,
    notImported: NOT_IMPORTED,
    refusal,
  };
}

/**
 * One import over a fresh app-server. Exported for the offline suite, which
 * runs it against a temporary HOME and CODEX_HOME and a synthetic transcript.
 */
export async function runSessionImport(opts: {
  bin: string; env: NodeJS.ProcessEnv; transcriptPath: string; cwd: string; title: string | null; timeoutMs?: number;
}): Promise<{ result: ImportResult; importId: string | null; observed: string[] }> {
  const observed: string[] = [];
  return new Promise((resolve) => {
    const child = spawn(opts.bin, ['app-server', '--stdio', '--disable', 'plugins', '--disable', 'remote_plugin'], {
      env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], cwd: fs.existsSync(opts.cwd) ? opts.cwd : os.tmpdir(),
    });
    let settled = false;
    let buffer = '';
    let stderr = '';
    let importId: string | null = null;
    const finish = (result: ImportResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      resolve({ result, importId, observed });
    };
    const fail = (message: string) => finish({ ok: false, failures: [message] });
    const send = (message: Record<string, unknown>) => {
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); } catch { /* closed */ }
    };
    const timer = setTimeout(() => fail(`Codex did not finish the import within ${Math.round((opts.timeoutMs ?? IMPORT_TIMEOUT_MS) / 1000)} seconds.`), opts.timeoutMs ?? IMPORT_TIMEOUT_MS);
    child.on('error', (e) => fail(`Could not start codex app-server: ${e.message}`));
    child.stderr.on('data', (chunk: Buffer) => { stderr = takeStderr(stderr, chunk); });
    child.on('close', (code) => fail(exitReason('codex app-server', code, stderr)));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
        try { msg = JSON.parse(line) as typeof msg; } catch { continue; }
        const method = typeof msg.method === 'string' ? msg.method : null;
        if (method) observed.push(method);
        if (method && msg.id !== undefined) {
          // A server-to-client request: an approval, an auth elicitation. The
          // import is not allowed to need either; nothing is answered.
          fail(`Codex asked for ${method} during the import. Wanigan stopped without answering, and nothing was spent.`);
          return;
        }
        if (method && /^(turn|item)\//.test(method)) {
          fail(`Codex began ${method} during the import. Wanigan stopped it; an import must not start a turn.`);
          return;
        }
        if (msg.id === 1) {
          if (msg.error) { fail(`codex app-server did not initialize: ${String(msg.error.message ?? 'unknown error')}`); return; }
          send({ method: 'initialized' });
          send({ id: 2, method: 'externalAgentConfig/import', params: sessionImportRequest({ transcriptPath: opts.transcriptPath, cwd: opts.cwd, title: opts.title }) });
        } else if (msg.id === 2) {
          if (msg.error) {
            fail(isMethodMissing(msg.error)
              ? 'This Codex has no externalAgentConfig/import method. Upgrade Codex to continue a Claude conversation in it.'
              : `Codex refused the import: ${String(msg.error.message ?? 'unknown error')}`);
            return;
          }
          const r = msg.result as { importId?: unknown } | undefined;
          importId = typeof r?.importId === 'string' ? r.importId : null;
          if (!importId) { fail('Codex accepted the import but returned no import id.'); return; }
        } else if (method === 'externalAgentConfig/import/completed' && importId) {
          const parsed = parseImportCompleted(msg.params, importId);
          if (parsed) { finish(parsed); return; }
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'wanigan', version: '0.1.0' }, capabilities: { experimentalApi: true } } });
  });
}

/** Run the import the operator confirmed, into the account they confirmed. */
export async function importIntoCodex(sessionId: unknown, accountId: unknown, confirmedPath: unknown): Promise<CodexImportOutcome> {
  const plan = await planCodexImport(sessionId, accountId);
  if (plan.refusal) return { ok: false, error: plan.refusal };
  if (!plan.transcript || !plan.codex || typeof confirmedPath !== 'string' || confirmedPath !== plan.transcript.path) {
    return { ok: false, error: 'The transcript Wanigan would import is not the one you confirmed. Open the dialog again.' };
  }
  const bin = await codexBin();
  if (!bin.path) return { ok: false, error: 'Codex is not installed.' };
  const account = accounts.byId(plan.codex.accountId);
  if (!account || account.harness !== 'codex') return { ok: false, error: 'That Codex account no longer exists in Wanigan.' };
  const env = probeEnv(await shellPath(), accounts.launchEnv(account));
  const real = realpath(plan.transcript.path) ?? plan.transcript.path;
  const run = await runSessionImport({ bin: bin.path, env, transcriptPath: real, cwd: plan.cwd, title: plan.title });
  let outcome: CodexImportOutcome;
  if (run.result.ok) {
    let ledger: string | null = null;
    try { ledger = ledgerThreadFor(fs.readFileSync(path.join(plan.codex.home, 'external_agent_session_imports.json'), 'utf8'), real); }
    catch { ledger = null; }
    outcome = {
      ok: true, threadId: run.result.threadId, title: run.result.title, projectId: plan.projectId,
      accountId: account.id, ledgerConfirmed: ledger === run.result.threadId,
    };
  } else {
    outcome = { ok: false, error: run.result.failures.join(' · ') };
  }
  try {
    db().prepare(`INSERT INTO codex_imports (at, session_id, account_id, source_path, codex_version, thread_id, ledger_confirmed, error)
                  VALUES (?,?,?,?,?,?,?,?)`)
      .run(Date.now(), plan.sessionId, account.id, real, bin.version,
        outcome.ok ? outcome.threadId : null, outcome.ok ? (outcome.ledgerConfirmed ? 1 : 0) : null,
        outcome.ok ? null : outcome.error.slice(0, 1000));
  } catch { /* the record is evidence, never the import's dependency */ }
  return outcome;
}
