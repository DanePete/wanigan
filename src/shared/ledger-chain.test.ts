/**
 * The ledger chain, the pure half. The subject is "does it name the tampered
 * row, and does it ever say verified about something nobody computed": an edit
 * found one row late sends a reviewer to the wrong decision, and a pre-chain row
 * counted as verified is a green light over rows nothing ever hashed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  LEDGER_GENESIS, canonicalJson, createLedgerVerifier, exportStatementText, headStatementText, ledgerHashInput,
  signatureState, storedText,
  type LedgerChainRow, type LedgerChainVerdict, type LedgerRecordedFields,
} from './ledger-chain.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function fields(i: number): LedgerRecordedFields {
  return {
    at: 1_757_000_000_000 + i * 1000, session_id: i % 2 ? `s${i}` : null, project_id: 'p1', trust: 'project',
    tool_name: 'Bash', summary: `npm test ${i}`, decision: i % 3 ? 'allow' : 'ask', rule: 'project.command', reason: 'ok',
  };
}

/** Rows as the writer makes them: `unchained` pre-chain rows first, then `chained` hashed ones. */
function ledger(unchained: number, chained: number): LedgerChainRow[] {
  const rows: LedgerChainRow[] = [];
  let prev = LEDGER_GENESIS;
  for (let i = 0; i < unchained + chained; i++) {
    const f = fields(i);
    if (i < unchained) { rows.push({ id: i + 1, ...f, prev_hash: null, hash: null }); continue; }
    const hash = sha256(ledgerHashInput(prev, f));
    rows.push({ id: i + 1, ...f, prev_hash: prev, hash });
    prev = hash;
  }
  return rows;
}

function verify(rows: LedgerChainRow[], watchId: number | null = null): LedgerChainVerdict {
  const v = createLedgerVerifier(sha256, watchId);
  for (const row of rows) v.push(row);
  return v.result();
}

test('canonical JSON sorts keys, so field order in a row cannot change a hash', () => {
  assert.equal(canonicalJson({ b: 1, a: null, c: 'x' }), '{"a":null,"b":1,"c":"x"}');
  const a = fields(1);
  const shuffled = { reason: a.reason, at: a.at, trust: a.trust, tool_name: a.tool_name, summary: a.summary,
    decision: a.decision, rule: a.rule, session_id: a.session_id, project_id: a.project_id };
  assert.equal(ledgerHashInput(LEDGER_GENESIS, a), ledgerHashInput(LEDGER_GENESIS, shuffled));
});

test('only the recorded fields are hashed: a joined project name or an id cannot move it', () => {
  const base = fields(2);
  assert.equal(ledgerHashInput('p', base), ledgerHashInput('p', { ...base, project_name: 'renamed', id: 99 } as LedgerRecordedFields));
});

test('an intact chain verifies every chained row and names its head', () => {
  const v = verify(ledger(0, 5));
  assert.deepEqual([v.total, v.unchainedBefore, v.chained, v.verifiedThrough, v.lastVerifiedId, v.firstBreak], [5, 0, 5, 5, 5, null]);
  assert.equal(v.head?.id, 5);
  assert.equal(v.head?.count, 5);
});

test('rows from before the chain began are counted apart and never verified', () => {
  const v = verify(ledger(3, 4));
  assert.deepEqual([v.unchainedBefore, v.chained, v.verifiedThrough, v.firstBreak], [3, 4, 4, null]);
  const only = verify(ledger(2, 0));
  assert.deepEqual([only.unchainedBefore, only.verifiedThrough, only.head], [2, 0, null]);
});

test('an edited row is named at that row, as a content break', () => {
  const rows = ledger(0, 6);
  rows[3] = { ...rows[3], summary: 'rm -rf build' };
  const v = verify(rows);
  assert.deepEqual(v.firstBreak, { id: 4, at: rows[3].at, toolName: 'Bash', kind: 'content' });
  assert.equal(v.verifiedThrough, 3);
});

test('a deleted row breaks the link of the row after it', () => {
  const rows = ledger(0, 6);
  rows.splice(2, 1);
  const v = verify(rows);
  assert.deepEqual([v.firstBreak?.id, v.firstBreak?.kind, v.verifiedThrough], [4, 'link', 2]);
});

test('a rewritten row with its own hash recomputed still breaks the next link', () => {
  const rows = ledger(0, 5);
  const edited = { ...rows[1], decision: 'deny' };
  assert.notEqual(edited.decision, ledger(0, 5)[1].decision, 'the edit changes something');
  rows[1] = { ...edited, hash: sha256(ledgerHashInput(edited.prev_hash!, edited)) };
  const v = verify(rows);
  assert.deepEqual([v.firstBreak?.id, v.firstBreak?.kind, v.verifiedThrough], [3, 'link', 2]);
});

test('a row without a hash after the chain began is a break, not a pre-chain row', () => {
  const rows = ledger(1, 4);
  rows[3] = { ...rows[3], hash: null, prev_hash: null };
  const v = verify(rows);
  assert.deepEqual([v.unchainedBefore, v.firstBreak?.id, v.firstBreak?.kind], [1, 4, 'unchained']);
});

test('clearing the hash of the first chained rows does not make them pre-chain', () => {
  const rows = ledger(0, 4);
  rows[0] = { ...rows[0], hash: null, prev_hash: null };
  rows[1] = { ...rows[1], hash: null, prev_hash: null };
  const v = verify(rows);
  // They now read as before the chain, but the row after them links to a hash no row carries.
  assert.deepEqual([v.unchainedBefore, v.firstBreak?.id, v.firstBreak?.kind], [2, 3, 'link']);
});

test('a seeded walk checks only the rows after a trusted head, and still finds a break among them', () => {
  const rows = ledger(1, 6);
  const seed = { prevHash: rows[3].hash!, chained: 3 };
  const after = (list: LedgerChainRow[]) => {
    const v = createLedgerVerifier(sha256, null, seed);
    for (const row of list.slice(4)) v.push(row);
    return v.result();
  };
  const clean = after(rows);
  assert.deepEqual([clean.verifiedThrough, clean.unchainedBefore, clean.head?.id, clean.head?.count, clean.firstBreak], [3, 0, 7, 6, null]);
  const edited = [...rows];
  edited[5] = { ...edited[5], reason: 'changed' };
  assert.deepEqual(after(edited).firstBreak?.id, 6);
  // After a seed there is no "before the chain began": a row with no hash is a break.
  const cleared = [...rows];
  cleared[4] = { ...cleared[4], hash: null, prev_hash: null };
  assert.deepEqual([after(cleared).firstBreak?.kind, after(cleared).unchainedBefore], ['unchained', 0]);
});

test('the watched row reports the hash and count the chain holds there now', () => {
  const rows = ledger(2, 5);
  const v = verify(rows, 5);
  assert.deepEqual(v.watched, { id: 5, hash: rows[4].hash, count: 3 });
  assert.equal(verify(rows, 99).watched, null);
});

test('a lone surrogate is stored as U+FFFD, and is hashed that way before it is written', () => {
  assert.equal(storedText('a\uD800b'), 'a�b');
  assert.equal(storedText('pair 😀 kept'), 'pair 😀 kept');
  assert.equal(storedText('\uDC00'), '�');
});

test('signed statements are prefixed by kind, so a head signature cannot pass as an export signature', () => {
  const head = headStatementText({ lastId: 3, count: 3, hash: 'ab', signedAt: 1 });
  const exp = exportStatementText({
    rows: 3, unchainedBefore: 0, chained: 3, lastId: 3, hash: 'ab', verifiedThrough: 3, firstBreakId: null, head: 'signed', exportedAt: 1, publicKey: 'k',
  });
  assert(head.startsWith('wanigan-ledger-head/v1\n') && exp.startsWith('wanigan-ledger-export/v1\n'));
  assert.equal(head, 'wanigan-ledger-head/v1\n{"count":3,"hash":"ab","lastId":3,"signedAt":1}');
});

test('a stored head that verifies and still matches the chain is signed, counting newer rows as unsigned', () => {
  const rows = ledger(0, 6);
  const stored = { lastId: 4, count: 4, hash: rows[3].hash!, signedAt: 7 };
  const s = signatureState({ verdict: verify(rows, 4), stored, valid: true, keyProblem: null });
  assert.deepEqual(s, { state: 'signed', lastId: 4, count: 4, signedAt: 7, unsignedAfter: 2 });
});

test('truncation past a signed head, and a recomputed rewrite under it, are both mismatches', () => {
  const rows = ledger(0, 6);
  const stored = { lastId: 6, count: 6, hash: rows[5].hash!, signedAt: 7 };
  const truncated = signatureState({ verdict: verify(rows.slice(0, 4), 6), stored, valid: true, keyProblem: null });
  assert.equal(truncated.state, 'mismatch');
  assert.match((truncated as { reason: string }).reason, /through #6, and record #6 is no longer in the chain/);

  // Row 2 edited and every hash after it recomputed: the chain verifies, the head does not.
  const rewritten: LedgerChainRow[] = [];
  let prev = LEDGER_GENESIS;
  for (const row of rows) {
    const f = row.id === 2 ? { ...row, summary: 'nothing to see' } : row;
    const hash = sha256(ledgerHashInput(prev, f));
    rewritten.push({ ...f, prev_hash: prev, hash });
    prev = hash;
  }
  const verdict = verify(rewritten, 6);
  assert.equal(verdict.firstBreak, null, 'a recomputed chain recomputes cleanly — which is why the head is signed');
  const s = signatureState({ verdict, stored, valid: true, keyProblem: null });
  assert.deepEqual([s.state, (s as { reason: string }).reason], ['mismatch', 'Record #6 no longer carries the hash that was signed, so the records up to it were rewritten.']);
});

test('an unreadable key is unchecked, a bad signature is a mismatch, and no head is unsigned', () => {
  const rows = ledger(0, 2);
  const stored = { lastId: 2, count: 2, hash: rows[1].hash!, signedAt: 1 };
  assert.equal(signatureState({ verdict: verify(rows, 2), stored, valid: null, keyProblem: 'The keychain refused.' }).state, 'unchecked');
  assert.equal(signatureState({ verdict: verify(rows, 2), stored, valid: false, keyProblem: null }).state, 'mismatch');
  assert.deepEqual(signatureState({ verdict: verify(rows), stored: null, valid: null, keyProblem: 'No key yet.' }), { state: 'unsigned', reason: 'No key yet.' });
  assert.equal((signatureState({ verdict: verify([]), stored: null, valid: null, keyProblem: null }) as { reason: string }).reason,
    'Nothing is chained yet, so there is no head to sign.');
  // A chain with no stored head is not reported as fine: it says what a missing
  // signature fails to catch.
  assert.match((signatureState({ verdict: verify(rows), stored: null, valid: null, keyProblem: null }) as { reason: string }).reason,
    /^No head signature is stored for these 2 chained records, so a rewrite that recomputed every hash would not be caught\.$/);
});
