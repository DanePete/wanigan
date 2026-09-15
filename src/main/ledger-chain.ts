import { app, safeStorage } from 'electron';
import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync,
  sign as signBytes, verify as verifyBytes, type KeyObject,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { db } from './db';
import { writeEncryptedCredential } from './keys';
import {
  LEDGER_GENESIS, createLedgerVerifier, exportStatementText, headStatementText, ledgerHashInput,
  signatureState, storedText,
  type LedgerChainRow, type LedgerChainStatus, type LedgerChainVerdict, type LedgerExportStatement,
  type LedgerHeadStatement, type LedgerRecordedFields, type LedgerSignatureState,
} from '../shared/ledger-chain';

/**
 * The policy ledger as a hash chain with a signed head: the writer, the check
 * and the key. src/shared/ledger-chain.ts holds the arithmetic.
 *
 * A row's hash is computed inside the transaction that inserts it, and that
 * transaction takes the write lock before it reads the previous hash. The
 * desktop app, its daemon and the CLI share this database; with a deferred
 * transaction two of them could read the same previous hash and write two rows
 * that both claim to follow it, and the verifier would report that fork as
 * tampering nobody did.
 *
 * The head is signed with an Ed25519 key made on first use and stored encrypted
 * by the OS keychain in Wanigan's user-data directory, the way keys.ts stores an
 * API key. Signing runs a moment after a write rather than inside it: the write
 * is on the hook path, where an agent is waiting for an answer, and the first
 * keychain read of a process can take far longer than that answer may.
 *
 * Signing never covers over evidence. Before the head moves, the head already
 * stored must still verify and still name a row carrying the hash it signed, and
 * every row after it must verify. Otherwise the stored head stays exactly as it
 * is — so a rewrite that recomputed every hash is still reported as a mismatch
 * after the next write, instead of being signed over by it.
 *
 * An unreadable key is never replaced. A new key would orphan every signature
 * the old one made and read, afterwards, as a key swapped under the ledger; the
 * file is left alone and the problem is reported in its place.
 */

const KEY_FILE = 'ledger-signing-key.bin';
/** Long enough to fold a burst of tool calls into one signature; short enough that the gap is not a window anyone plans around. */
const HEAD_SIGN_DELAY_MS = 250;

/** Every column the chain reads, in the order the verifier takes them. */
const CHAIN_SELECT = 'SELECT id, at, session_id, project_id, trust, tool_name, summary, decision, rule, reason, prev_hash, hash FROM policy_ledger';

type LedgerKey = { privateKey: KeyObject; publicKey: KeyObject; spki: string; fingerprint: string };
type KeyRead = { key: LedgerKey; problem: null } | { key: null; problem: string };

let cachedKey: LedgerKey | null = null;
/** A failure is remembered so a denied keychain prompt is not raised again on every write. "Verify now" clears it. */
let keyFailure: string | null = null;
let signTimer: NodeJS.Timeout | null = null;

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The first sixteen hex digits of a key's fingerprint, in fours: enough to compare by eye. */
export function shortFingerprint(hex: string): string {
  return (hex.slice(0, 16).match(/.{4}/g) ?? []).join(' ');
}

function keyFromPrivate(privateKey: KeyObject): LedgerKey {
  const publicKey = createPublicKey(privateKey);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey, publicKey, spki: der.toString('base64'), fingerprint: createHash('sha256').update(der).digest('hex') };
}

function spkiFingerprint(spkiBase64: string): string {
  return createHash('sha256').update(Buffer.from(spkiBase64, 'base64')).digest('hex');
}

function readKey(create: boolean): KeyRead {
  if (cachedKey) return { key: cachedKey, problem: null };
  // Smoke runs hold the key in memory, as mobile/secrets.ts holds its tokens:
  // reaching the real keychain from a temporary profile can block on a prompt,
  // and it would not exercise the file this process writes in any case.
  if (process.env.WANIGAN_SMOKE === '1') {
    cachedKey = keyFromPrivate(generateKeyPairSync('ed25519').privateKey);
    return { key: cachedKey, problem: null };
  }
  if (keyFailure) return { key: null, problem: keyFailure };
  if (!safeStorage.isEncryptionAvailable()) {
    return { key: null, problem: 'OS credential encryption is unavailable, so the ledger signing key cannot be opened or made.' };
  }
  const file = path.join(app.getPath('userData'), KEY_FILE);
  if (fs.existsSync(file)) {
    try {
      const stored = JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) as { v?: unknown; privateKey?: unknown };
      if (stored.v !== 1 || typeof stored.privateKey !== 'string') throw new Error('unexpected shape');
      cachedKey = keyFromPrivate(createPrivateKey({ key: Buffer.from(stored.privateKey, 'base64'), format: 'der', type: 'pkcs8' }));
      return { key: cachedKey, problem: null };
    } catch {
      keyFailure = `The ledger signing key in ${file} could not be opened, so no head was signed or checked. Wanigan leaves that file as it is rather than replace the key.`;
      return { key: null, problem: keyFailure };
    }
  }
  if (!create) return { key: null, problem: 'No ledger signing key has been made yet. One is made the first time a record is written.' };
  try {
    const pair = generateKeyPairSync('ed25519');
    const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    writeEncryptedCredential(file, safeStorage.encryptString(JSON.stringify({ v: 1, privateKey, createdAt: Date.now() })));
    cachedKey = keyFromPrivate(pair.privateKey);
    return { key: cachedKey, problem: null };
  } catch (e) {
    keyFailure = `Wanigan could not save a ledger signing key: ${e instanceof Error ? e.message : String(e)}.`;
    return { key: null, problem: keyFailure };
  }
}

/* ── writing ────────────────────────────────────────────────────────── */

/** The values exactly as SQLite will return them, which is what the hash has to be over. */
function recorded(fields: LedgerRecordedFields): LedgerRecordedFields {
  const orNull = (v: string | null | undefined) => (typeof v === 'string' ? storedText(v) : null);
  return {
    at: Math.trunc(fields.at),
    session_id: orNull(fields.session_id),
    project_id: orNull(fields.project_id),
    trust: storedText(fields.trust),
    tool_name: storedText(fields.tool_name),
    summary: storedText(fields.summary),
    decision: storedText(fields.decision),
    rule: storedText(fields.rule),
    reason: storedText(fields.reason),
  };
}

/** Append one decision to the chain and return its id. The head is signed shortly after, off the caller's path. */
export function appendLedgerRow(fields: LedgerRecordedFields, d: Database.Database = db()): number {
  const row = recorded(fields);
  const write = d.transaction(() => {
    const last = d.prepare('SELECT hash FROM policy_ledger WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined;
    const prevHash = last?.hash ?? LEDGER_GENESIS;
    const hash = sha256Hex(ledgerHashInput(prevHash, row));
    const info = d.prepare(
      `INSERT INTO policy_ledger (at, session_id, project_id, trust, tool_name, summary, decision, rule, reason, prev_hash, hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(row.at, row.session_id, row.project_id, row.trust, row.tool_name, row.summary, row.decision, row.rule, row.reason, prevHash, hash);
    return Number(info.lastInsertRowid);
  });
  const id = write.immediate();
  if (d === db()) scheduleHeadSignature();
  return id;
}

function scheduleHeadSignature(): void {
  if (signTimer) return;
  signTimer = setTimeout(() => {
    signTimer = null;
    // Best effort by design: a head left unsigned is reported as unsigned, and
    // the next write tries again.
    try { signLedgerHead(); } catch { /* reported by verifyLedger */ }
  }, HEAD_SIGN_DELAY_MS);
  signTimer.unref?.();
}

/* ── the stored head ────────────────────────────────────────────────── */

type StoredHead = LedgerHeadStatement & { signature: string; publicKey: string };

function storedHead(d: Database.Database): StoredHead | null {
  const r = d.prepare('SELECT last_id, count, hash, signed_at, signature, public_key FROM policy_ledger_head WHERE id = 1').get() as
    { last_id: number; count: number; hash: string; signed_at: number; signature: string; public_key: string } | undefined;
  return r ? { lastId: r.last_id, count: r.count, hash: r.hash, signedAt: r.signed_at, signature: r.signature, publicKey: r.public_key } : null;
}

function statementOf(head: StoredHead): LedgerHeadStatement {
  return { lastId: head.lastId, count: head.count, hash: head.hash, signedAt: head.signedAt };
}

function headVerifies(head: StoredHead, key: LedgerKey): boolean {
  if (head.publicKey !== key.spki) return false;
  try {
    return verifyBytes(null, Buffer.from(headStatementText(statementOf(head)), 'utf8'), key.publicKey, Buffer.from(head.signature, 'base64'));
  } catch {
    return false;
  }
}

export type HeadSigning = { signed: boolean; reason: string | null };

/**
 * Sign the chain's current head, when that can be done without signing over
 * something that no longer verifies. Exported for the smoke suite, which cannot
 * wait on the timer a write schedules.
 */
export function signLedgerHead(d: Database.Database = db()): HeadSigning {
  const read = readKey(true);
  if (!read.key) return { signed: false, reason: read.problem };
  const key = read.key;
  const stored = storedHead(d);
  // A head this key signed and that still matches is where checking resumes.
  // Anything else — no head yet, or one another key signed — is checked from
  // the first row, once.
  let seed: { prevHash: string; chained: number } | null = null;
  let after = 0;
  if (stored && stored.publicKey === key.spki) {
    const at = d.prepare('SELECT hash FROM policy_ledger WHERE id = ?').get(stored.lastId) as { hash: string | null } | undefined;
    if (!headVerifies(stored, key) || !at || at.hash !== stored.hash) {
      return { signed: false, reason: 'The stored head no longer matches the ledger, so it is kept as it is rather than signed over.' };
    }
    seed = { prevHash: stored.hash, chained: stored.count };
    after = stored.lastId;
  }
  const verifier = createLedgerVerifier(sha256Hex, null, seed);
  const rows = d.prepare(`${CHAIN_SELECT} WHERE id > ? ORDER BY id ASC`).iterate(after) as IterableIterator<LedgerChainRow>;
  for (const row of rows) verifier.push(row);
  const verdict = verifier.result();
  if (verdict.firstBreak) {
    return { signed: false, reason: `Record #${verdict.firstBreak.id} does not verify, so the head was not moved past it.` };
  }
  if (!verdict.head) {
    return stored ? { signed: true, reason: null } : { signed: false, reason: 'Nothing is chained yet, so there is no head to sign.' };
  }
  const statement: LedgerHeadStatement = { lastId: verdict.head.id, count: verdict.head.count, hash: verdict.head.hash, signedAt: Date.now() };
  const signature = signBytes(null, Buffer.from(headStatementText(statement), 'utf8'), key.privateKey).toString('base64');
  d.prepare(
    `INSERT INTO policy_ledger_head (id, last_id, count, hash, signed_at, signature, public_key) VALUES (1,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET last_id=excluded.last_id, count=excluded.count, hash=excluded.hash,
       signed_at=excluded.signed_at, signature=excluded.signature, public_key=excluded.public_key`,
  ).run(statement.lastId, statement.count, statement.hash, statement.signedAt, signature, key.spki);
  return { signed: true, reason: null };
}

/* ── checking ───────────────────────────────────────────────────────── */

function judgeHead(verdict: LedgerChainVerdict, stored: StoredHead | null, read: KeyRead): LedgerSignatureState {
  if (!stored) return signatureState({ verdict, stored: null, valid: null, keyProblem: verdict.chained ? read.problem : null });
  if (!read.key) return signatureState({ verdict, stored: statementOf(stored), valid: null, keyProblem: read.problem });
  if (stored.publicKey !== read.key.spki) {
    // Another key is not evidence of tampering on its own: a backup restored
    // from another Mac arrives exactly like this. It is also nothing this Mac
    // can vouch for, so it is unchecked rather than signed or broken.
    return signatureState({
      verdict, stored: statementOf(stored), valid: null,
      keyProblem: `The stored head was signed with a different key (${shortFingerprint(spkiFingerprint(stored.publicKey))}), not this Mac’s ledger key (${shortFingerprint(read.key.fingerprint)}), so it cannot be checked here. A backup restored from another Mac reads this way.`,
    });
  }
  return signatureState({ verdict, stored: statementOf(stored), valid: headVerifies(stored, read.key), keyProblem: null });
}

/**
 * Walk the whole ledger in id order and say how much of it verifies, where it
 * first breaks, and what the stored head signature says about it now.
 */
export function verifyLedger(d: Database.Database = db(), opts: { retryKey?: boolean } = {}): LedgerChainStatus {
  if (opts.retryKey) keyFailure = null;
  const stored = storedHead(d);
  const verifier = createLedgerVerifier(sha256Hex, stored?.lastId ?? null);
  for (const row of d.prepare(`${CHAIN_SELECT} ORDER BY id ASC`).iterate() as IterableIterator<LedgerChainRow>) verifier.push(row);
  const verdict = verifier.result();
  const read = readKey(false);
  return { ...verdict, checkedAt: Date.now(), signature: judgeHead(verdict, stored, read), keyFingerprint: read.key?.fingerprint ?? null };
}

/* ── exporting ──────────────────────────────────────────────────────── */

/**
 * The closing record of an export, built from the same rows the export wrote so
 * a record inserted mid-export cannot make the signature describe a different
 * file. Rows go in through `push` in id order; `finish` returns one JSON line.
 */
export function beginLedgerExport(d: Database.Database = db()) {
  const stored = storedHead(d);
  const verifier = createLedgerVerifier(sha256Hex, stored?.lastId ?? null);
  let rows = 0;
  return {
    push(row: LedgerChainRow): void {
      rows += 1;
      verifier.push(row);
    },
    finish(): string {
      const verdict = verifier.result();
      const read = readKey(true);
      const head = judgeHead(verdict, stored, read);
      if (!read.key) {
        return JSON.stringify({ record: 'signature', algorithm: 'ed25519', statement: null, signature: null, reason: `This export is not signed: ${read.problem}` });
      }
      const statement: LedgerExportStatement = {
        rows, unchainedBefore: verdict.unchainedBefore, chained: verdict.chained,
        lastId: verdict.head?.id ?? null, hash: verdict.head?.hash ?? null,
        verifiedThrough: verdict.verifiedThrough, firstBreakId: verdict.firstBreak?.id ?? null, head: head.state,
        exportedAt: Date.now(), publicKey: read.key.spki,
      };
      const signature = signBytes(null, Buffer.from(exportStatementText(statement), 'utf8'), read.key.privateKey).toString('base64');
      return JSON.stringify({
        record: 'signature', algorithm: 'ed25519', statement, signature,
        keyFingerprint: read.key.fingerprint, headReason: 'reason' in head ? head.reason : null,
      });
    },
  };
}
