// A complete session briefing or an explicit refusal. These are logical row and
// serialized-byte limits, not a bound on SQLite work or total JavaScript heap.
import { CoreError } from '../shared/protocol.ts';
import type { DB } from './db.ts';

export interface BriefingLimits { bytes: number; rows: number }
export type BriefingFormat = 'hook' | 'codex';
const DEFAULTS: Readonly<BriefingLimits> = { bytes: 64 * 1024, rows: 256 };
export const BRIEFING_REFUSAL = 'Session briefing refused: the board instructions are too large to provide safely. Ask the owner to reduce them before working. No board instructions were supplied.';
export const hookBriefing = (text: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });
export const codexBriefing = (text: string): string => `developer_instructions=${JSON.stringify(text)}`;

export class BriefingRefused extends CoreError {
  constructor() { super('refused', 'The session briefing is too large to provide safely. Reduce the card instructions or active project decisions before starting.'); }
}

/** Trusted constructor-only test seam. Even a test cannot raise a shipped cap. */
export function briefingLimits(given: Partial<BriefingLimits> = {}): Readonly<BriefingLimits> {
  const limits = { ...DEFAULTS, ...given };
  for (const key of Object.keys(DEFAULTS) as (keyof BriefingLimits)[]) {
    const minimum = key === 'bytes' ? Buffer.byteLength(hookBriefing(BRIEFING_REFUSAL)) : 1;
    if (!Number.isSafeInteger(limits[key]) || limits[key] < minimum || limits[key] > DEFAULTS[key]) throw new Error(`Invalid briefing ${key} limit.`);
  }
  return Object.freeze(limits);
}

interface ProjectText { name: string; path: string }
interface CardText {
  project_id: string; key: string; title: string; status: string; body: string; sent_back: number;
  worktree_path: string | null; worktree_branch: string | null; worktree_base: string | null;
}

/** Narrow own-store read: no CardDetail, evidence, session history or old comments.
 * Admission and values share one synchronous SQLite read transaction. Limits
 * bound admitted values; SQLite can still scan/sort more rows to answer a query. */
export function readBriefing(db: DB, projectId: string, cardId: string | null, limits: Readonly<BriefingLimits>, format: BriefingFormat): string {
  return db.transaction(() => {
    let rawBytes = 0, rowCount = 0;
    function read<T>(sql: string, params: (string | number)[], columns: readonly string[], collection = false): T[] {
      // SQL and column names below are fixed program text, never caller input.
      const size = columns.map((column) => `COALESCE(length(CAST(${column} AS BLOB)), 0)`).join(' + ');
      const cost = db.prepare(`SELECT count(*) AS rows, COALESCE(sum(${size}), 0) AS bytes FROM (${sql})`).get(...params) as { rows: number; bytes: number };
      if (!Number.isSafeInteger(cost.bytes) || cost.bytes < 0 || cost.bytes > limits.bytes - rawBytes ||
          !Number.isSafeInteger(cost.rows) || cost.rows < 0 || (collection && cost.rows > limits.rows - rowCount)) throw new BriefingRefused();
      rawBytes += cost.bytes;
      if (collection) rowCount += cost.rows;
      // Only after count/length admission may SQLite materialize these values in JS.
      return db.prepare(sql).all(...params) as T[];
    }
    const project = read<ProjectText>('SELECT name, path FROM projects WHERE id = ?', [projectId], ['name', 'path'])[0];
    if (!project) throw new CoreError('not_found', 'No such project.');
    const card = cardId ? read<CardText>(
      'SELECT project_id, key, title, status, body, sent_back, worktree_path, worktree_branch, worktree_base FROM cards WHERE id = ?',
      [cardId], ['project_id', 'key', 'title', 'status', 'body', 'worktree_path', 'worktree_branch', 'worktree_base'],
    )[0] : null;
    if (cardId && !card) throw new CoreError('not_found', 'No such card.');
    if (card && card.project_id !== projectId) throw new CoreError('invalid', 'That card belongs to another project.');
    const criteria = cardId ? read<{ text: string; done: number }>(
      'SELECT text, done FROM criteria WHERE card_id = ? ORDER BY position, rowid LIMIT ?',
      [cardId, limits.rows + 1], ['text'], true,
    ) : [];
    const decisions = read<{ title: string; body: string }>(
      'SELECT title, body FROM decisions WHERE project_id = ? AND removed_at IS NULL ORDER BY created_at, rowid LIMIT ?',
      [projectId, limits.rows - rowCount + 1], ['title', 'body'], true,
    );
    const last = card?.sent_back ? read<{ body: string }>(
      'SELECT body FROM comments WHERE card_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [cardId!], ['body'],
    )[0] : null;

    const lines: string[] = [];
    let encodedBytes = Buffer.byteLength(format === 'hook' ? hookBriefing('') : codexBriefing(''));
    const add = (line: string): void => {
      // Each line comes from the bounded values above. Charge JSON escaping and
      // the encoded newline before retaining it or joining the complete text.
      const bytes = Buffer.byteLength(JSON.stringify(line)) - 2 + (lines.length ? 2 : 0);
      if (bytes > limits.bytes - encodedBytes) throw new BriefingRefused();
      encodedBytes += bytes; lines.push(line);
    };
    add(`You are working in "${project.name}" (${project.path}), a project on the owner's Wanigan board.`);
    add('The `wanigan` command is your board: `wanigan status` shows your card, cards sent back to you and the top of Ready.');
    add('Claim a card before working on it (`wanigan claim KEY`), add notes as you go (`wanigan note KEY "..."`),');
    add('and submit with evidence when done (`wanigan review KEY --evidence <file|url> --note "..."`). You cannot mark work done; the owner reviews it.');
    add('File problems you find but are not fixing with `wanigan file bug "title"`. Ask the owner with `wanigan ask KEY "question"`.');
    if (card) {
      add(''); add(`Your card is ${card.key}: ${card.title} (${card.status}).`);
      if (card.worktree_path && card.worktree_branch && card.worktree_base) {
        add(`You are working in ${card.worktree_path}, a git worktree on the branch ${card.worktree_branch}, made from ${card.worktree_base}. ` +
          `Stay on this branch and commit your work to it; do not switch branches or edit ${project.path} directly. The owner merges it after review.`);
      }
      if (card.body) add(card.body);
      if (criteria.length) {
        add('Acceptance criteria:');
        for (const criterion of criteria) add(`- [${criterion.done ? 'x' : ' '}] ${criterion.text}`);
      }
      if (last) { add(''); add(`It was sent back. The owner's note: ${last.body}`); }
    }
    if (decisions.length) {
      add(''); add('Decisions in force for this project (follow them):');
      for (const decision of decisions) add(`- ${decision.title}${decision.body ? ` — ${decision.body}` : ''}`);
    }
    return lines.join('\n');
  })();
}
