import { db } from './db';

/**
 * Small key/value settings. The spend cap is the one that matters: a batch is
 * fire-and-forget, so a mis-typed row count or a runaway max_tokens is only
 * catchable *before* submit.
 */
function ensure() {
  db().exec('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
}

export function getSetting(k: string, fallback: string): string {
  ensure();
  const r = db().prepare('SELECT v FROM settings WHERE k = ?').get(k) as { v: string } | undefined;
  return r?.v ?? fallback;
}

export function setSetting(k: string, v: string) {
  ensure();
  db().prepare('INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v);
}

/** Hard ceiling on a single run's estimated cost, in USD. 0 disables it. */
export function spendCap(): number {
  const n = Number(getSetting('spend_cap_usd', '1.00'));
  return Number.isFinite(n) && n >= 0 ? n : 1.0;
}
