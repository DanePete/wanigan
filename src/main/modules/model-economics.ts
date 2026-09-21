import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { WaniganModule } from '../module-registry';
import { db } from '../db';
import { getSetting, setSetting } from '../settings';
import { halted, refuseIfHalted } from '../halt';
import {
  economicsEndpointUrl, MODEL_ECONOMICS_SOURCE, MODEL_ECONOMICS_TTL_MS,
  parseEconomicsEndpoints, parseEconomicsModels, quoteEconomics, readEconomicsSelection,
  type EconomicsModel, type EconomicsSnapshot,
  type ModelEconomicsSettings, type ModelEconomicsStatus,
} from '../../shared/model-economics';

const AUTO_SETTING = 'model-economics.automatic-refresh';
const SELECTED_SETTING = 'model-economics.selected-models';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_ENDPOINT_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const REFRESH_TIMEOUT_MS = 60_000;
const LEASE_MS = 90_000;
type StateRow = { last_attempt_at: number | null; last_error: string | null; next_refresh_at: number | null; lease_token: string | null; lease_until: number | null };
type SnapshotRow = { data_json: string };

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS model_economics_snapshots (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, source_url TEXT NOT NULL,
      fetched_at INTEGER NOT NULL, content_hash TEXT NOT NULL, data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_economics_scope ON model_economics_snapshots(scope,fetched_at DESC);
    CREATE TABLE IF NOT EXISTS model_economics_state (
      id INTEGER PRIMARY KEY CHECK(id=1), last_attempt_at INTEGER, last_error TEXT,
      next_refresh_at INTEGER, lease_token TEXT, lease_until INTEGER
    );
    INSERT OR IGNORE INTO model_economics_state(id) VALUES(1);
  `);
}

function state(): StateRow {
  return db().prepare('SELECT * FROM model_economics_state WHERE id=1').get() as StateRow;
}

function settings(): ModelEconomicsSettings {
  return { automaticRefresh: getSetting(AUTO_SETTING, '0') === '1' };
}

function selectedModels(): string[] {
  try { return readEconomicsSelection(JSON.parse(getSetting(SELECTED_SETTING, '[]'))); }
  catch { return []; }
}

function cached<T>(scope: string): EconomicsSnapshot<T> | null {
  const row = db().prepare('SELECT data_json FROM model_economics_snapshots WHERE scope=? ORDER BY fetched_at DESC,rowid DESC LIMIT 1')
    .get(scope) as SnapshotRow | undefined;
  if (!row) return null;
  try { return JSON.parse(row.data_json) as EconomicsSnapshot<T>; }
  catch { return null; }
}

/** Purely local. Opening the surface never starts a request or reads a credential. */
export function status(): ModelEconomicsStatus {
  const current = state(); const config = settings(); const now = Date.now();
  const catalogue = cached<EconomicsModel>('models');
  const known = new Set(catalogue?.rows.map(row => row.id));
  const endpoints = selectedModels().filter(id => known.has(id)).flatMap(modelId => {
    const snapshot = cached<import('../../shared/model-economics').EconomicsEndpoint>(`endpoints:${modelId}`);
    return snapshot ? [{ ...snapshot, modelId }] : [];
  });
  return {
    settings: config, selectedModelIds: selectedModels(), catalogue, endpoints,
    stale: !catalogue || catalogue.fetchedAt > now || now - catalogue.fetchedAt >= MODEL_ECONOMICS_TTL_MS,
    refreshing: current.lease_token !== null && (current.lease_until ?? 0) > now,
    lastAttemptAt: current.last_attempt_at, lastError: current.last_error,
    nextRefreshAt: config.automaticRefresh ? current.next_refresh_at : null,
    endpointCoverage: { models: catalogue?.rows.length ?? 0, fetched: endpoints.length,
      fresh: endpoints.filter(row => row.fetchedAt <= now && now - row.fetchedAt < MODEL_ECONOMICS_TTL_MS).length },
  };
}

export function setSettings(raw: unknown): ModelEconomicsStatus {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(key => key !== 'automaticRefresh')
    || typeof (raw as { automaticRefresh?: unknown }).automaticRefresh !== 'boolean') {
    throw new Error('Automatic catalogue refresh must be true or false.');
  }
  const enabled = (raw as ModelEconomicsSettings).automaticRefresh;
  db().transaction(() => {
    setSetting(AUTO_SETTING, enabled ? '1' : '0');
    const last = state().last_attempt_at;
    const next = enabled ? Math.max(Date.now(), (last ?? 0) + MODEL_ECONOMICS_TTL_MS) : null;
    db().prepare('UPDATE model_economics_state SET next_refresh_at=? WHERE id=1').run(next);
  })();
  return status();
}

async function publicJson(url: string, signal: AbortSignal, maxBytes: number, automatic: boolean): Promise<{ body: unknown; hash: string }> {
  refuseIfHalted('refresh public model prices');
  if (automatic && !settings().automaticRefresh) throw new Error('Automatic catalogue refresh was switched off.');
  const response = await fetch(url, {
    method: 'GET', credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  if (!response.ok) throw new Error(`Public catalogue answered HTTP ${response.status}.`);
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Public catalogue exceeded its response size limit.');
  }
  if (!response.body) throw new Error('Public catalogue returned no body.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('Public catalogue exceeded its response size limit.');
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  let body: unknown;
  try { body = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Public catalogue returned invalid JSON.'); }
  return { body, hash: createHash('sha256').update(bytes).digest('hex') };
}

function save<T>(scope: string, sourceUrl: string, hash: string, parsed: Pick<EconomicsSnapshot<T>, 'rows' | 'received' | 'rejected' | 'truncated'>): EconomicsSnapshot<T> {
  const snapshot: EconomicsSnapshot<T> = {
    id: `economics_${randomUUID()}`, sourceUrl, fetchedAt: Date.now(), contentHash: hash, ...parsed,
  };
  db().prepare('INSERT INTO model_economics_snapshots(id,scope,source_url,fetched_at,content_hash,data_json) VALUES(?,?,?,?,?,?)')
    .run(snapshot.id, scope, sourceUrl, snapshot.fetchedAt, hash, JSON.stringify(snapshot));
  return snapshot;
}

function claim(): string | null {
  return db().transaction(() => {
    const now = Date.now(); const current = state();
    if (current.lease_token && (current.lease_until ?? 0) > now) return null;
    const token = randomUUID();
    db().prepare('UPDATE model_economics_state SET lease_token=?,lease_until=?,last_attempt_at=?,last_error=NULL,next_refresh_at=? WHERE id=1')
      .run(token, now + LEASE_MS, now, settings().automaticRefresh ? now + MODEL_ECONOMICS_TTL_MS : null);
    return token;
  })();
}

/** Public metadata only. A fixed origin/path, no keychain, redirect, inference or retry. */
export async function refresh(raw?: unknown, automatic = false): Promise<ModelEconomicsStatus> {
  let requested: string[] | undefined;
  if (raw !== undefined) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'modelIds')) {
      throw new Error('Refresh accepts only a bounded list of catalogue model ids.');
    }
    const modelIds = (raw as { modelIds?: unknown }).modelIds;
    if (modelIds !== undefined) requested = readEconomicsSelection(modelIds);
  }
  refuseIfHalted('refresh public model prices');
  const token = claim();
  if (!token) return status();
  const errors: string[] = [];
  const signal = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
  try {
    const fetched = await publicJson(MODEL_ECONOMICS_SOURCE, signal, MAX_BODY_BYTES, automatic);
    const parsed = parseEconomicsModels(fetched.body);
    if (!parsed.rows.length) throw new Error('Public catalogue contained no usable model declarations.');
    const catalogue = save('models', MODEL_ECONOMICS_SOURCE, fetched.hash, parsed);
    const known = new Set(catalogue.rows.map(row => row.id));
    const selected = requested ?? selectedModels();
    const admitted = selected.filter(id => known.has(id));
    if (admitted.length !== selected.length) errors.push('Some selected models are absent from the current catalogue.');
    setSetting(SELECTED_SETTING, JSON.stringify(admitted));
    // Three bounded metadata reads at a time; never fan out model inference.
    for (let index = 0; index < admitted.length; index += 3) {
      await Promise.all(admitted.slice(index, index + 3).map(async modelId => {
        try {
          const url = economicsEndpointUrl(modelId);
          const endpoint = await publicJson(url, signal, MAX_ENDPOINT_BYTES, automatic);
          const rows = parseEconomicsEndpoints(endpoint.body, modelId);
          save(`endpoints:${modelId}`, url, endpoint.hash, rows);
        } catch {
          errors.push(`Endpoint metadata could not be refreshed for ${modelId}; any prior snapshot remains dated as before.`);
        }
      }));
    }
  } catch (error) {
    errors.push(error instanceof Error && ['Error', 'SyntaxError'].includes(error.name)
      ? error.message.slice(0, 240) : 'Public catalogue refresh failed or timed out. The previous snapshot was retained.');
  } finally {
    db().prepare('UPDATE model_economics_state SET lease_token=NULL,lease_until=NULL,last_error=? WHERE id=1 AND lease_token=?')
      .run(errors.length ? errors.join(' ').slice(0, 1_500) : null, token);
  }
  return status();
}

export function quote(raw: unknown) {
  const current = status();
  return quoteEconomics(current.catalogue, current.endpoints, raw, Date.now());
}

async function runScheduledRefresh(): Promise<void> {
  const config = settings(); const current = state();
  if (!config.automaticRefresh || halted() || (current.next_refresh_at ?? 0) > Date.now()) return;
  await refresh(undefined, true);
}

/** Discovery is removable; launching, evidence and review do not depend on it. */
export const modelEconomicsModule: WaniganModule = {
  id: 'model-economics', label: 'Model prices and capabilities', required: null, migrate,
  ipc(handle) {
    handle('model-economics:status', () => status());
    handle('model-economics:setSettings', (raw: unknown) => setSettings(raw));
    handle('model-economics:refresh', (raw?: unknown) => refresh(raw));
    handle('model-economics:quote', (raw: unknown) => quote(raw));
  },
  maintenance: () => [{ id: 'model-economics-refresh', intervalMs: 60_000, run: runScheduledRefresh }],
  egress: () => [{ host: 'openrouter.ai', paths: ['/api/v1/models', '/api/v1/models/{author}/{model}/endpoints'],
    by: 'wanigan', purpose: 'Read public model capabilities and published endpoint prices; no prompts or credentials.',
    when: 'On explicit refresh, or once daily while automatic catalogue refresh is enabled.',
    activeNow: settings().automaticRefresh, overrideEnv: null }],
};
