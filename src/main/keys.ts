import { safeStorage, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Claude Platform API key, encrypted at rest by the OS keychain.
 *
 * safeStorage delegates to Keychain on macOS, DPAPI on Windows, and libsecret
 * on Linux — the ciphertext on disk is useless without the logged-in user's
 * session. A plaintext .env file is readable by anything that can read the
 * user's home directory, which includes every npm postinstall script.
 */
function keyFile(): string {
  return path.join(app.getPath('userData'), 'apikey.bin');
}

export function hasKey(): boolean {
  return fs.existsSync(keyFile());
}

export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

type Creds = { key: string; workspaceId?: string };

function readCreds(): Creds | null {
  if (!hasKey()) return null;
  try {
    const raw = safeStorage.decryptString(fs.readFileSync(keyFile()));
    // Older installs stored the bare key string.
    if (raw.startsWith('{')) return JSON.parse(raw) as Creds;
    return { key: raw };
  } catch {
    return null;
  }
}

export function getKey(): string | null {
  // An explicit env var still wins, for CI and scripted runs.
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return readCreds()?.key ?? null;
}

/**
 * Identity-linked API keys must name the workspace they act in on every request,
 * or the API returns 400 `anthropic-workspace-id is required`. Plain keys ignore
 * the header, so it is safe to always send when set.
 */
export function getWorkspaceId(): string | null {
  return process.env.ANTHROPIC_WORKSPACE_ID || readCreds()?.workspaceId || null;
}

/** The auth headers every call to the API must carry. */
export function authHeaders(key?: string, workspaceId?: string): Record<string, string> {
  const h: Record<string, string> = {
    'x-api-key': (key ?? getKey() ?? '').trim(),
    'anthropic-version': '2023-06-01',
  };
  const ws = (workspaceId ?? getWorkspaceId() ?? '').trim();
  if (ws) h['anthropic-workspace-id'] = ws;
  return h;
}

export function setKey(key: string, workspaceId?: string) {
  const trimmed = key.trim();
  if (!trimmed.startsWith('sk-ant-')) {
    throw new Error(
      'That does not look like a Claude Platform key — they start with "sk-ant-". ' +
      'A Claude Code OAuth token will not work here; the Batches API bills against a Platform account.'
    );
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS encryption is unavailable, so the key cannot be stored safely. Set ANTHROPIC_API_KEY instead.');
  }
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  const creds: Creds = { key: trimmed };
  const ws = workspaceId?.trim();
  if (ws) creds.workspaceId = ws;
  fs.writeFileSync(keyFile(), safeStorage.encryptString(JSON.stringify(creds)), { mode: 0o600 });
}

export function clearKey() {
  try { fs.unlinkSync(keyFile()); } catch { /* already gone */ }
}

/** Never return the key itself to the renderer — only enough to recognise it. */
export function keyFingerprint(): string | null {
  const k = getKey();
  if (!k) return null;
  return `${k.slice(0, 14)}…${k.slice(-4)}`;
}

/** Reads the API's own error text. An HTTP status alone is not a diagnosis. */
async function apiError(r: Response): Promise<string> {
  let body = '';
  try { body = await r.text(); } catch { /* nothing to read */ }
  try {
    const j = JSON.parse(body) as { error?: { type?: string; message?: string } };
    if (j.error?.message) return `${j.error.type ?? 'error'}: ${j.error.message}`;
  } catch { /* not JSON */ }
  return body.slice(0, 300) || `HTTP ${r.status}`;
}

/**
 * Verifies against the live API before we let the user believe it works.
 *
 * Tries /v1/models first for capabilities, but falls back to /v1/messages/batches
 * when that 400s: some key types and workspace configurations reject the models
 * endpoint while batches works fine, and failing the whole setup on that would be
 * wrong.
 */
export async function verifyKey(
  key?: string,
  workspaceId?: string
): Promise<{ ok: boolean; detail: string; batches: boolean; needsWorkspaceId?: boolean }> {
  const k = (key ?? getKey())?.trim();
  if (!k) return { ok: false, detail: 'No key set.', batches: false };

  if (k.startsWith('sk-ant-admin')) {
    return {
      ok: false, batches: false,
      detail: 'That is an Admin API key. Admin keys manage org settings and cannot call the Messages or Batches API. Create a standard API key instead.',
    };
  }

  // GET with no body: sending content-type here is meaningless and some proxies
  // reject it.
  const H = authHeaders(k, workspaceId);
  const missingWorkspace = (t: string) => t.includes('anthropic-workspace-id');

  let modelDetail = '';
  let modelsOk = false;
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: H });
    if (r.ok) {
      const models = (await r.json()) as { data?: { id: string }[] };
      modelsOk = true;
      modelDetail = `Newest model: ${models.data?.[0]?.id ?? 'unknown'}`;
    } else if (r.status === 401) {
      return { ok: false, batches: false, detail: `Key rejected (401). ${await apiError(r)}` };
    } else if (r.status === 403) {
      return { ok: false, batches: false, detail: `Key lacks permission (403). ${await apiError(r)}` };
    } else {
      const t = await apiError(r);
      if (missingWorkspace(t)) {
        return {
          ok: false, batches: false, needsWorkspaceId: true,
          detail: 'This is an identity-linked API key: it must name the workspace it acts in. Add the Workspace ID below — find it in the Console under Settings → Workspaces (it looks like wrkspc_…).',
        };
      }
      modelDetail = `/v1/models returned ${r.status} — ${t}`;
    }
  } catch (e) {
    return { ok: false, batches: false, detail: `Network error reaching the API: ${e instanceof Error ? e.message : String(e)}` };
  }

  // The endpoint that actually matters for this app.
  let batches = false;
  let batchDetail = '';
  try {
    const b = await fetch('https://api.anthropic.com/v1/messages/batches?limit=1', { headers: H });
    if (b.ok) { batches = true; }
    else if (b.status === 401 || b.status === 403) {
      return { ok: false, batches: false, detail: `Key rejected by the Batches API (${b.status}). ${await apiError(b)}` };
    } else {
      const t = await apiError(b);
      if (missingWorkspace(t)) {
        return {
          ok: false, batches: false, needsWorkspaceId: true,
          detail: 'This is an identity-linked API key: it must name the workspace it acts in. Add the Workspace ID below — find it in the Console under Settings → Workspaces (it looks like wrkspc_…).',
        };
      }
      batchDetail = `Batches API returned ${b.status} — ${t}`;
    }
  } catch (e) {
    batchDetail = `Could not reach the Batches API: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (!modelsOk && !batches) {
    return { ok: false, batches: false, detail: [modelDetail, batchDetail].filter(Boolean).join(' · ') };
  }

  // Batches working is the bar for this app; a models failure is a note, not a stop.
  return {
    ok: true,
    batches,
    detail: [
      'Authenticated.',
      modelsOk ? modelDetail : `Note: ${modelDetail} — the model catalog will fall back to the local table.`,
      batches ? '' : batchDetail,
    ].filter(Boolean).join(' '),
  };
}


/* ── provider credentials ────────────────────────────────────────────────
   A second class of secret entirely. GLM runs the Claude Code binary against
   Z.ai's Anthropic-compatible endpoint, so it needs a Z.ai token — which is
   NOT the Anthropic key and must never be substituted for it. Separate file,
   separate keychain blob, separate decision.
   ──────────────────────────────────────────────────────────────────────── */

function providerKeyFile(id: string): string {
  // The id is ours, not the user's, but a path built from a string still gets
  // the same treatment as any other.
  const safe = id.replace(/[^a-z0-9-]/gi, '');
  if (!safe) throw new Error('A provider credential needs a provider id.');
  return path.join(app.getPath('userData'), `provider-${safe}.bin`);
}

export function hasProviderKey(id: string): boolean {
  return fs.existsSync(providerKeyFile(id));
}

export function getProviderKey(id: string): string | null {
  // An explicit env var still wins, for CI and scripted runs.
  const fromEnv = process.env[`WANIGAN_${id.toUpperCase()}_KEY`];
  if (fromEnv) return fromEnv;
  try {
    return safeStorage.decryptString(fs.readFileSync(providerKeyFile(id))).trim() || null;
  } catch {
    return null;
  }
}

export function setProviderKey(id: string, key: string) {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('That key is empty.');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'The OS keychain is unavailable, so this key cannot be stored safely. ' +
      'Wanigan will not write a credential to disk in plaintext.'
    );
  }
  fs.writeFileSync(providerKeyFile(id), safeStorage.encryptString(trimmed), { mode: 0o600 });
}

export function clearProviderKey(id: string) {
  try { fs.unlinkSync(providerKeyFile(id)); } catch { /* already gone */ }
}

export function providerKeyFingerprint(id: string): string | null {
  const k = getProviderKey(id);
  if (!k) return null;
  return k.length <= 12 ? '…' + k.slice(-4) : k.slice(0, 8) + '…' + k.slice(-4);
}
