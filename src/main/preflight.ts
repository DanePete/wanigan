/**
 * What this machine has, read once for the first-run checklist.
 *
 * This module introduces no probing of its own. Provider resolution and the
 * version stamp come from providers.ts, login evidence from accounts.ts, and
 * the two counts from the database — so there is exactly one implementation of
 * each question and this surface cannot drift from the ones that launch
 * sessions. It is read-only: nothing here creates an account, registers a root,
 * writes a file or spawns a process beyond the version probe providers.ts
 * already caches.
 *
 * The derivation of what the operator is *told* lives in shared/preflight.ts,
 * where the smoke suite can reach it without a window or a database.
 */
import { detectProviders, searchedLocations, shellPath } from './providers';
import * as accounts from './accounts';
import { db } from './db';
import type { CredentialSource, Preflight, PreflightAgent, SignedIn } from '../shared/preflight';

/**
 * Login evidence for a harness, without inventing an account for one nobody
 * uses.
 *
 * `accounts.list()` seeds a Personal account for the harness it is asked about,
 * which is right for a surface about one agent and wrong here: asking about
 * every harness on first run would create rows for CLIs the operator has never
 * installed. So this is only ever called for a provider that actually resolved,
 * and `listAll()` — which does not seed — answers for everything else.
 */
function signedInFor(harness: string | null, resolved: boolean): SignedIn {
  if (!harness || !accounts.supportsAccounts(harness)) return 'unknown';
  const rows = resolved ? accounts.list(harness) : accounts.listAll().filter((a) => a.harness === harness);
  // Any directory with stored evidence is enough: the operator only needs one
  // signed-in account for the agent to be usable.
  return rows.some((account) => account.signedIn === 'yes') ? 'yes' : 'unknown';
}

/**
 * Whether the harness's own login is this profile's credential.
 *
 * Routed through accounts.appliesTo() rather than an id list, because a local
 * pack coins profile ids no build of Wanigan has heard of. It answers `false`
 * exactly for a Claude Code profile redirected to another backend — GLM,
 * DeepSeek, xAI — whose credential is a pasted key; `undefined` for a harness
 * the question does not apply to, which is not the same as "no". `redirected`
 * is passed false because at profile level the backend id already carries it;
 * a session's ambient override is a different question asked elsewhere.
 */
function credentialFor(harness: string | null, backendId: string | null): CredentialSource {
  if (!harness) return 'unknown';
  const applies = accounts.appliesTo({ harness, backendId }, false);
  if (applies === false) return 'provider-key';
  return accounts.supportsAccounts(harness) ? 'harness-login' : 'unknown';
}

function count(sql: string): number {
  try {
    const row = db().prepare(sql).get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  } catch {
    // A database that cannot be read is not a machine with zero projects. The
    // caller renders an unsatisfied item either way, but nothing downstream may
    // treat this as an observation, so it stays 0 and the checklist stays open.
    return 0;
  }
}

/** One read of everything the checklist derives from. */
export async function readPreflight(): Promise<Preflight> {
  const providers = await detectProviders();
  const agents: PreflightAgent[] = providers.map((provider) => {
    const harnessId = provider.harnessId ?? null;
    const credential = credentialFor(harnessId, provider.backendId ?? null);
    return {
      id: provider.id,
      label: provider.label,
      harnessId,
      found: provider.path !== null,
      path: provider.path,
      version: provider.version,
      // A key-backed profile shares the harness's configuration directory but
      // not its credential, so the login stored there says nothing about it.
      // Claiming otherwise is the false green this whole surface exists to
      // avoid, and it shipped once before a runtime probe caught it.
      signedIn: credential === 'provider-key' ? 'unknown' : signedInFor(harnessId, provider.path !== null),
      credential,
    };
  });

  let searched: string[] = [];
  try { searched = searchedLocations(await shellPath()); } catch { searched = []; }

  return {
    agents,
    searched,
    projects: count('SELECT COUNT(*) AS n FROM projects'),
    sessionsStarted: count('SELECT COUNT(*) AS n FROM session_log'),
  };
}
