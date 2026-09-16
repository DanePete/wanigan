#!/usr/bin/env node
// Check an exported Wanigan policy ledger with nothing but Node: no Wanigan, no
// database, no network. Settings › Projects & safety › Trust and the policy
// ledger › Export ledger writes the file this reads.
//
//   node scripts/verify-ledger.mjs <export.jsonl> [--fingerprint <hex>] [--json]
//
// Exit 0: every chained record recomputes and links, the closing signature is
// valid over exactly these records, and Wanigan's own check at export found the
// head signed. Exit 1: anything short of that, each reason printed. Exit 2: the
// file could not be read as an export at all.
//
// The arithmetic repeats src/shared/ledger-chain.ts line for line, and the two
// must stay in step: the smoke suite runs this script against a real export
// rather than trusting this comment to keep them aligned.
//
// A signature proves the file is what the holder of a key exported. It does not
// say whose key. Anyone can sign a file with a key of their own, so pass the
// fingerprint Wanigan shows beside the ledger with --fingerprint; without it the
// check says the key was not pinned instead of implying it was.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const GENESIS = '0'.repeat(64);
const RECORDED = ['at', 'decision', 'project_id', 'reason', 'rule', 'session_id', 'summary', 'tool_name', 'trust'];

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const canonicalJson = (value) => JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])));
const hashInput = (prevHash, fields) => prevHash + canonicalJson(Object.fromEntries(RECORDED.map((key) => [key, fields[key]])));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An exported row carries the list view's names; the hash is over the stored ones. */
const recorded = (row) => ({
  at: row.at, session_id: row.sessionId, project_id: row.projectId, trust: row.trust, tool_name: row.toolName,
  summary: row.summary, decision: row.decision, rule: row.rule, reason: row.reason,
});

const BREAK_WORDS = {
  content: 'its contents no longer produce the hash written beside them, so it was changed after it was written',
  link: 'it does not follow the record before it, so a record was removed, inserted or reordered',
  unchained: 'it has no hash although it comes after the chain began',
};

function usage(problem) {
  process.stderr.write(`${problem}\n\nUsage: node scripts/verify-ledger.mjs <export.jsonl> [--fingerprint <hex>] [--json]\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const pinAt = args.indexOf('--fingerprint');
const pin = pinAt >= 0 ? (args[pinAt + 1] ?? '').replace(/[\s:]/g, '').toLowerCase() : null;
if (pin !== null && !/^[0-9a-f]{16,64}$/.test(pin)) usage('--fingerprint takes at least sixteen hex digits of the key fingerprint.');
const file = args.find((a, i) => !a.startsWith('--') && (pinAt < 0 || i !== pinAt + 1));
if (!file) usage('Name the exported .jsonl file to check.');

let lines;
try {
  lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
} catch (e) {
  usage(`Could not read ${file}: ${e.message}`);
}

const rows = [];
let closing = null;
for (const [index, line] of lines.entries()) {
  let value;
  try { value = JSON.parse(line); } catch { usage(`Line ${index + 1} is not JSON, so this is not a ledger export.`); }
  if (closing) usage(`Line ${index + 1} comes after the signature record, which is always the last line of an export.`);
  if (value && value.record === 'signature') { closing = value; continue; }
  if (!value || typeof value.id !== 'number') usage(`Line ${index + 1} is not a ledger record.`);
  rows.push(value);
}

// ── the chain ──────────────────────────────────────────────────────────
let unchainedBefore = 0;
let chained = 0;
let verifiedThrough = 0;
let prev = null;
let firstBreak = null;
let head = null;
for (const row of rows) {
  if (typeof row.hash !== 'string' || !row.hash) {
    if (chained === 0) { unchainedBefore += 1; continue; }
    firstBreak ??= { id: row.id, kind: 'unchained' };
    continue;
  }
  chained += 1;
  head = { id: row.id, hash: row.hash };
  const expected = prev ?? GENESIS;
  prev = row.hash;
  if (firstBreak) continue;
  if (row.prev_hash !== expected) { firstBreak = { id: row.id, kind: 'link' }; continue; }
  if (sha256(hashInput(row.prev_hash, recorded(row))) !== row.hash) { firstBreak = { id: row.id, kind: 'content' }; continue; }
  verifiedThrough += 1;
}

// ── the signature ──────────────────────────────────────────────────────
const problems = [];
const warnings = [];
if (firstBreak) problems.push(`The chain breaks at record #${firstBreak.id}: ${BREAK_WORDS[firstBreak.kind]}.`);

const signature = { present: Boolean(closing), valid: null, fingerprint: null, pinned: pin !== null, pinMatches: null, head: null, exportedAt: null };
const statement = closing?.statement ?? null;
if (!closing) {
  problems.push('There is no signature record, so nothing shows these records are the ones Wanigan exported.');
} else if (!statement || typeof closing.signature !== 'string') {
  problems.push(`The export is not signed${closing.reason ? ` (${closing.reason})` : ''}, so a rewrite that recomputed every hash would pass the chain check.`);
} else {
  try {
    const der = Buffer.from(String(statement.publicKey), 'base64');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    signature.fingerprint = createHash('sha256').update(der).digest('hex');
    signature.valid = verify(null, Buffer.from(`wanigan-ledger-export/v1\n${canonicalJson(statement)}`, 'utf8'), key, Buffer.from(closing.signature, 'base64'));
  } catch {
    signature.valid = false;
  }
  signature.head = statement.head ?? null;
  signature.exportedAt = typeof statement.exportedAt === 'number' ? statement.exportedAt : null;
  if (!signature.valid) {
    problems.push('The signature does not verify: the signed statement was changed, or it was not signed by the key it names.');
  } else {
    // A valid signature over a statement that no longer describes the file means
    // records were added, removed or edited after it was signed.
    const described = [
      ['records', statement.rows, rows.length],
      ['records before the chain began', statement.unchainedBefore, unchainedBefore],
      ['chained records', statement.chained, chained],
      ['last chained record', statement.lastId, head?.id ?? null],
      ['head hash', statement.hash, head?.hash ?? null],
      ['verified records', statement.verifiedThrough, verifiedThrough],
      ['first break', statement.firstBreakId, firstBreak?.id ?? null],
    ].filter(([, signed, found]) => signed !== found);
    for (const [what, signed, found] of described) {
      problems.push(`The signed statement says ${what} ${JSON.stringify(signed)}, and this file has ${JSON.stringify(found)}: the file changed after it was signed.`);
    }
    if (statement.head === 'mismatch') {
      problems.push(`When it exported this file, Wanigan found the ledger's signed head no longer matched its records${closing.headReason ? `: ${closing.headReason}` : '.'}`);
    } else if (statement.head === 'unchecked' || (statement.head === 'unsigned' && chained > 0)) {
      problems.push(`When it exported this file, Wanigan could not vouch for the ledger's head${closing.headReason ? `: ${closing.headReason}` : '.'}`);
    }
  }
  if (pin !== null) {
    signature.pinMatches = Boolean(signature.fingerprint?.startsWith(pin));
    if (!signature.pinMatches) problems.push('The signing key is not the one named by --fingerprint.');
  } else {
    warnings.push('The key was not pinned: anyone can sign a file with a key of their own. Pass --fingerprint with the one Wanigan shows beside the ledger.');
  }
}

const ok = problems.length === 0;
if (json) {
  process.stdout.write(`${JSON.stringify({ ok, file, rows: rows.length, unchainedBefore, chained, verifiedThrough, firstBreak, signature, problems, warnings })}\n`);
} else {
  const out = [];
  out.push(`Wanigan policy ledger export: ${file}`);
  out.push(`  Records    ${plural(rows.length, 'record')}: ${unchainedBefore ? `${unchainedBefore} from before the chain began, not verified; ` : ''}${chained} chained`);
  out.push(firstBreak
    ? `  Chain      ✕ verified through ${plural(verifiedThrough, 'record')}, then breaks at record #${firstBreak.id}`
    : `  Chain      ✓ verified through ${plural(verifiedThrough, 'record')}`);
  if (signature.valid !== null) {
    out.push(`  Signature  ${signature.valid ? '✓ valid' : '✕ invalid'} Ed25519${signature.exportedAt ? `, exported ${new Date(signature.exportedAt).toISOString()}` : ''}`);
    out.push(`  Key        ${signature.fingerprint ?? 'unreadable'}${pin === null ? ' (not pinned)' : signature.pinMatches ? ' (matches --fingerprint)' : ' (does not match --fingerprint)'}`);
  } else {
    out.push('  Signature  ✕ none');
  }
  for (const line of problems) out.push(`  ✕ ${line}`);
  for (const line of warnings) out.push(`  ! ${line}`);
  out.push(ok ? 'Verified.' : 'Not verified.');
  process.stdout.write(`${out.join('\n')}\n`);
}
process.exit(ok ? 0 : 1);
