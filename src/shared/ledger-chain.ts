/**
 * The policy ledger's hash chain: the arithmetic, with no database and no key.
 * src/main/ledger-chain.ts writes and reads the rows and holds the signing key;
 * scripts/verify-ledger.mjs repeats this arithmetic offline, for someone who has
 * an export and no Wanigan. The two must stay byte-for-byte in step, which is
 * why the smoke suite runs that script against a real export rather than
 * trusting a comment to keep them aligned.
 *
 * What a chain proves. Each row's hash is sha256(previous hash + the canonical
 * JSON of what the row recorded), so editing a row changes its hash and deleting
 * or inserting one breaks the link after it. Both are found by recomputing, and
 * the first one found is named by id. What it does not prove: sha256 has no key,
 * so someone who rewrites a row and then recomputes every hash after it leaves a
 * chain that recomputes cleanly. The head signature is what catches that — the
 * last hash signed with a key only this Mac's keychain can open — and a row
 * written after the last signature is said to be unsigned, not presented as
 * covered by one.
 *
 * Rows written before the chain existed have no hash. They are counted and
 * reported as before the chain began, never as verified: nothing was ever
 * computed over them, so there is nothing to check them against.
 */

/** The previous hash of the first chained row. */
export const LEDGER_GENESIS = '0'.repeat(64);

/** Exactly what a policy_ledger row records, as stored. The hash covers these and nothing else. */
export type LedgerRecordedFields = {
  at: number;
  session_id: string | null;
  project_id: string | null;
  trust: string;
  tool_name: string;
  summary: string;
  decision: string;
  rule: string;
  reason: string;
};

const RECORDED: readonly (keyof LedgerRecordedFields)[] = [
  'at', 'decision', 'project_id', 'reason', 'rule', 'session_id', 'summary', 'tool_name', 'trust',
];

/** JSON with keys sorted, so the same values always make the same bytes. Flat objects only. */
export function canonicalJson(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])));
}

/** The text a row's hash is the sha256 of. */
export function ledgerHashInput(prevHash: string, row: LedgerRecordedFields): string {
  return prevHash + canonicalJson(Object.fromEntries(RECORDED.map((key) => [key, row[key]])));
}

/**
 * A value as SQLite will hand it back. A lone surrogate in a JS string is
 * written as U+FFFD, so hashing the string before that substitution made a row
 * that could never verify — a false break, recorded at the moment of writing.
 */
export function storedText(value: string): string {
  return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

export type LedgerChainRow = LedgerRecordedFields & { id: number; prev_hash: string | null; hash: string | null };

export type LedgerBreakKind =
  /** The row's contents no longer produce the hash written beside them. */
  | 'content'
  /** The row does not follow the one before it: a row was removed, inserted or reordered. */
  | 'link'
  /** A row with no hash after the chain began. */
  | 'unchained';

export type LedgerBreak = { id: number; at: number; toolName: string; kind: LedgerBreakKind };

export type LedgerChainVerdict = {
  /** Every row read. */
  total: number;
  /** Rows before the first hashed row: written before the chain began, never verified. */
  unchainedBefore: number;
  /** Rows carrying a hash, verified or not. */
  chained: number;
  /** Chained rows that recomputed and linked, counted up to the first break. */
  verifiedThrough: number;
  lastVerifiedId: number | null;
  firstBreak: LedgerBreak | null;
  /** The last chained row as stored, with how many chained rows end there. */
  head: { id: number; hash: string; count: number } | null;
  /** The row a stored signature names, as the chain holds it now; null when it is not there or not chained. */
  watched: { id: number; hash: string; count: number } | null;
};

/**
 * Reads rows in id order, one at a time, so a long ledger is never one array in
 * memory. `watchId` is the row a stored head signature names.
 *
 * `seed` starts the walk after a head that is already trusted — its hash and how
 * many chained rows end there — so the signer checks only the rows written since
 * rather than rehashing the whole ledger after every write. Seeded, a row with
 * no hash is a break from the first row on: the chain began before the seed.
 */
export function createLedgerVerifier(
  sha256Hex: (text: string) => string,
  watchId: number | null = null,
  seed: { prevHash: string; chained: number } | null = null,
) {
  let total = 0;
  let unchainedBefore = 0;
  let chained = seed?.chained ?? 0;
  let verifiedThrough = 0;
  let lastVerifiedId: number | null = null;
  let prev: string | null = seed?.prevHash ?? null;
  let firstBreak: LedgerBreak | null = null;
  let head: LedgerChainVerdict['head'] = null;
  let watched: LedgerChainVerdict['watched'] = null;
  return {
    push(row: LedgerChainRow): void {
      total += 1;
      if (typeof row.hash !== 'string' || !row.hash) {
        if (chained === 0) { unchainedBefore += 1; return; }
        firstBreak ??= { id: row.id, at: row.at, toolName: row.tool_name, kind: 'unchained' };
        return;
      }
      chained += 1;
      head = { id: row.id, hash: row.hash, count: chained };
      if (row.id === watchId) watched = { id: row.id, hash: row.hash, count: chained };
      const expected = prev ?? LEDGER_GENESIS;
      prev = row.hash;
      if (firstBreak) return;
      if (row.prev_hash !== expected) {
        firstBreak = { id: row.id, at: row.at, toolName: row.tool_name, kind: 'link' };
        return;
      }
      if (sha256Hex(ledgerHashInput(row.prev_hash, row)) !== row.hash) {
        firstBreak = { id: row.id, at: row.at, toolName: row.tool_name, kind: 'content' };
        return;
      }
      verifiedThrough += 1;
      lastVerifiedId = row.id;
    },
    result(): LedgerChainVerdict {
      return { total, unchainedBefore, chained, verifiedThrough, lastVerifiedId, firstBreak, head, watched };
    },
  };
}

/* ── signatures ─────────────────────────────────────────────────────── */

/** What a head signature commits to: the last chained row, how many rows end there, and when. */
export type LedgerHeadStatement = { lastId: number; count: number; hash: string; signedAt: number };

export function headStatementText(statement: LedgerHeadStatement): string {
  return `wanigan-ledger-head/v1\n${canonicalJson(statement)}`;
}

/**
 * What an export's closing record signs. `publicKey` is base64 SPKI DER.
 *
 * The app's own verdict at the moment of export is part of what is signed, not
 * a comment beside it. A signature over the rows alone would vouch for a chain
 * Wanigan had just found rewritten — a fresh signature is exactly what someone
 * who recomputed every hash would want — so the break and the head's state
 * travel inside the signed bytes, and the offline verifier prints them.
 */
export type LedgerExportStatement = {
  rows: number;
  unchainedBefore: number;
  chained: number;
  lastId: number | null;
  hash: string | null;
  verifiedThrough: number;
  firstBreakId: number | null;
  head: LedgerSignatureState['state'];
  exportedAt: number;
  publicKey: string;
};

export function exportStatementText(statement: LedgerExportStatement): string {
  return `wanigan-ledger-export/v1\n${canonicalJson(statement)}`;
}

export type LedgerSignatureState =
  /** A stored head verifies and still matches the chain. Rows after it are counted, not covered. */
  | { state: 'signed'; lastId: number; count: number; signedAt: number; unsignedAfter: number }
  /** No head has been signed: nothing is chained yet, or the key has not been available. */
  | { state: 'unsigned'; reason: string }
  /** A stored head exists and does not verify, or no longer matches the chain. This is evidence of tampering. */
  | { state: 'mismatch'; reason: string }
  /** A stored head exists and could not be checked, because the key could not be read. */
  | { state: 'unchecked'; reason: string };

export type LedgerChainStatus = LedgerChainVerdict & {
  checkedAt: number;
  signature: LedgerSignatureState;
  /** sha256 of the signing key's SPKI DER, hex, or null when the key could not be read. */
  keyFingerprint: string | null;
};

/**
 * What the stored head says about the chain as it is now.
 *
 * `valid` is null when the signature could not be checked at all, which is a
 * different answer from false and is never rendered as either signed or broken.
 */
export function signatureState(input: {
  verdict: LedgerChainVerdict;
  stored: LedgerHeadStatement | null;
  valid: boolean | null;
  keyProblem: string | null;
}): LedgerSignatureState {
  const { verdict, stored, valid, keyProblem } = input;
  if (!stored) {
    if (verdict.chained === 0) return { state: 'unsigned', reason: 'Nothing is chained yet, so there is no head to sign.' };
    // Not "nothing to worry about": Wanigan signs the head after the records it
    // writes whenever the key is readable, so a chain with no stored head either
    // never had a readable key here or has lost its signature.
    return {
      state: 'unsigned',
      reason: keyProblem ?? `No head signature is stored for these ${verdict.chained} chained ${verdict.chained === 1 ? 'record' : 'records'}, so a rewrite that recomputed every hash would not be caught.`,
    };
  }
  if (valid === null) {
    return { state: 'unchecked', reason: keyProblem ?? 'The signing key could not be read, so the stored head signature was not checked.' };
  }
  if (!valid) {
    return { state: 'mismatch', reason: 'The stored head signature does not verify against this Mac’s ledger key.' };
  }
  const watched = verdict.watched;
  if (!watched || watched.id !== stored.lastId) {
    return {
      state: 'mismatch',
      reason: `The signed head covers ${stored.count} ${stored.count === 1 ? 'record' : 'records'} through #${stored.lastId}, and record #${stored.lastId} is no longer in the chain.`,
    };
  }
  if (watched.hash !== stored.hash) {
    return { state: 'mismatch', reason: `Record #${stored.lastId} no longer carries the hash that was signed, so the records up to it were rewritten.` };
  }
  if (watched.count !== stored.count) {
    return {
      state: 'mismatch',
      reason: `The signed head covers ${stored.count} chained records through #${stored.lastId}, and ${watched.count} are chained there now.`,
    };
  }
  return {
    state: 'signed', lastId: stored.lastId, count: stored.count, signedAt: stored.signedAt,
    unsignedAfter: Math.max(0, verdict.chained - stored.count),
  };
}
