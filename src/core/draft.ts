// Draft a card from a rough note, on request: Claude Code reads the project with
// read-only tools and proposes a type, a clear title, a description, checkable
// acceptance criteria and a priority. The owner edits it before anything is
// created; nothing is filed by the draft itself.
import { CARD_TYPES, PRIORITIES, type Account, type CardDraft, type Project } from '../shared/model.ts';
import { CoreError } from '../shared/protocol.ts';
import { runHeadless } from './headless.ts';

const TIMEOUT_MS = 6 * 60_000;

const SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: [...CARD_TYPES] },
    title: { type: 'string' },
    body: { type: 'string' },
    criteria: { type: 'array', items: { type: 'string' } },
    priority: { type: 'integer', enum: [...PRIORITIES] },
    why: { type: 'string' },
  },
  required: ['type', 'title', 'body', 'criteria', 'priority', 'why'],
} as const;

export async function draftCard(options: {
  project: Project; note: string; account: Account | null; binary: string | null; decisions: string[];
}): Promise<{ draft: CardDraft; costUsd: number | null }> {
  const note = options.note.trim();
  if (!note) throw new CoreError('invalid', 'Write a note to draft from.');
  if (note.length > 8_000) throw new CoreError('invalid', 'That note is too long to draft from; keep it under 8,000 characters.');
  const prompt = [
    `Turn this note into a card for the project at ${options.project.path}. You can read files; you cannot change anything.`,
    'Read only as much of the code as you need to make the card specific (real file names, real behaviour).',
    '',
    `The note:\n"""\n${note}\n"""`,
    options.decisions.length ? `\nDecisions in force for this project:\n${options.decisions.map((d) => `- ${d}`).join('\n')}` : '',
    '',
    'type: bug if something is broken, feature if it is new behaviour, task for other work, idea if it is not yet decided.',
    'title: imperative and specific, at most 80 characters.',
    'body: what and why, in two to five plain sentences an agent can act on. Name files where you found them.',
    'criteria: two to six statements that are each checkable as true or false when the work is done.',
    'priority: 0 most urgent to 3 whenever; why: one sentence for the priority.',
  ].filter(Boolean).join('\n');
  const run = await runHeadless({ binary: options.binary, prompt, schema: SCHEMA, cwd: options.project.path, account: options.account, timeoutMs: TIMEOUT_MS });
  const result = await run.done;
  if (result.error || !result.answer) throw new CoreError('refused', result.error ?? 'Claude Code gave no draft.');
  const a = result.answer;
  const type = CARD_TYPES.includes(a.type as never) ? (a.type as CardDraft['type']) : 'task';
  const priority = PRIORITIES.includes(a.priority as never) ? (a.priority as CardDraft['priority']) : 2;
  const draft: CardDraft = {
    type,
    title: String(a.title ?? '').trim().slice(0, 200) || note.slice(0, 80),
    body: String(a.body ?? '').trim(),
    criteria: Array.isArray(a.criteria) ? a.criteria.map((c) => String(c).trim()).filter(Boolean).slice(0, 10) : [],
    priority,
    why: String(a.why ?? '').trim(),
  };
  return { draft, costUsd: result.costUsd };
}
