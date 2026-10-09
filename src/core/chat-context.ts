// What Wanigan tells Claude about the desk with each message: projects and their
// counts, what needs the owner, sessions and what they are doing, cards in
// Review and Working, today's activity, the project's decisions, and any card
// the owner named. Recorded state only, capped at a few KB, and never file
// contents, transcripts or terminal output: Claude reads files itself, and only
// inside a project.
import { createHash } from 'node:crypto';
import type { NeedKind, Provider, SessionState } from '../shared/model.ts';
import { cardKeysIn } from '../shared/chat.ts';
import type { Ctx } from './context.ts';
import { computeNeeds } from './needs.ts';
import { LIVE_SQL } from './records.ts';

/** The whole state, header included, is cut to fit this many characters. */
export const STATE_CAP = 6_000;
const LINE_CAP = 240;
const ASKED_CARDS = 3;

export interface DeskState {
  /** When and what it covers. Not part of the hash: the clock always moves. */
  header: string;
  body: string;
  /** Identifies the body, so an unchanged state need not be sent again. */
  hash: string;
}

const NEED_LABEL: Record<NeedKind, string> = {
  permission: 'Asking permission',
  starting: 'Has not started',
  overlap: 'Two sessions edited one file',
  review: 'Ready for review',
  failed: 'Failed',
  interrupted: 'Interrupted',
  quiet: 'Gone quiet',
  question: 'Question from an agent',
  waiting: 'Finished its turn',
  limit: 'Hit its usage limit',
};
const STATE_WORDS: Record<SessionState, string> = {
  starting: 'starting', working: 'working', waiting: 'waiting at its prompt', permission: 'asking permission',
  running: 'running', ended: 'ended', failed: 'failed', interrupted: 'interrupted', limited: 'stopped at its usage limit',
};
const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', shell: 'Shell' };
const STATUS_NAME: Record<string, string> = { inbox: 'Inbox', ready: 'Ready', working: 'Working', review: 'Review', done: 'Done', archived: 'Archived' };
const VERDICT: Record<string, string> = { pass: 'looks done', changes: 'changes needed', unsure: 'needs your judgment' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface Section { title: string; lines: string[]; empty?: string }

export function deskState(ctx: Ctx, options: { projectId: string | null; question: string }): DeskState {
  const now = ctx.now();
  const day = startOfDay(now);
  const pid = options.projectId;
  const at = (t: number | null | undefined): string => (t ? clock(t, now) : 'unknown');
  const project = pid ? ctx.db.prepare('SELECT key, name, path FROM projects WHERE id = ?').get(pid) as { key: string; name: string; path: string } | undefined : undefined;

  const header = `Wanigan's state at ${stamp(now)} (the owner's local time), covering ${project ? `the project ${project.name} (${project.key}) in detail, and every project in outline` : 'every open project'}.`;
  const sections: Section[] = [];

  // A card the owner named comes first: it is what the question is about.
  const asked = cardKeysIn(options.question).slice(0, ASKED_CARDS);
  if (asked.length) sections.push({ title: 'Cards the owner named', lines: asked.flatMap((key) => cardDetail(ctx, key, at)) });

  const needs = computeNeeds(ctx);
  const ordered = pid ? [...needs.filter((n) => n.projectId === pid), ...needs.filter((n) => n.projectId !== pid)] : needs;
  sections.push({
    title: 'Needs the owner, most urgent first',
    empty: 'Nothing needs the owner.',
    lines: ordered.map((n) => `${NEED_LABEL[n.kind]}: ${n.cardKey ?? n.projectKey} "${n.title}"${n.detail ? ` — ${n.detail}` : ''} (since ${at(n.since)})`),
  });

  const sessions = ctx.db.prepare(`
    SELECT s.id, s.provider, s.title, s.state, s.activity, s.started_at, s.ended_at, s.last_event_at, s.exit_code,
           c.key AS card_key, p.key AS project_key, s.state IN (${LIVE_SQL}) AS live
    FROM sessions s JOIN projects p ON p.id = s.project_id AND p.archived_at IS NULL LEFT JOIN cards c ON c.id = s.card_id
    WHERE (s.state IN (${LIVE_SQL}) OR s.started_at >= ? OR coalesce(s.ended_at, 0) >= ?) AND (? IS NULL OR s.project_id = ?)
    ORDER BY live DESC, coalesce(s.last_event_at, s.ended_at, s.started_at) DESC LIMIT 24
  `).all(day, day, pid, pid) as {
    id: string; provider: Provider; title: string; state: SessionState; activity: string | null; started_at: number;
    ended_at: number | null; last_event_at: number | null; exit_code: number | null; card_key: string | null; project_key: string; live: number;
  }[];
  const edited = filesEdited(ctx, sessions.map((s) => s.id), day);
  const sessionLine = (s: (typeof sessions)[number]): string => {
    const files = edited.get(s.id) ?? [];
    return [
      `${PROVIDER_NAME[s.provider]} "${s.title}" ${s.card_key ? `on ${s.card_key}` : `(one-off, ${s.project_key})`}: ${STATE_WORDS[s.state]}`,
      s.activity ? ` — ${s.activity}` : '',
      s.live ? `; started ${at(s.started_at)}${s.last_event_at ? `, last event ${at(s.last_event_at)}` : ''}` : `; ended ${at(s.ended_at)}${s.exit_code !== null ? `, exit code ${s.exit_code}` : ''}`,
      files.length ? `; edited ${files.slice(0, 4).join(', ')}${files.length > 4 ? ` and ${files.length - 4} more` : ''}` : '',
    ].join('');
  };
  sections.push({ title: 'Live sessions', empty: 'No session is running.', lines: sessions.filter((s) => s.live).map(sessionLine) });

  const cards = ctx.db.prepare(`
    SELECT c.key, c.title, c.type, c.priority, c.status, c.updated_at, c.sent_back, c.reopened,
           (SELECT count(*) FROM criteria k WHERE k.card_id = c.id) AS total,
           (SELECT count(*) FROM criteria k WHERE k.card_id = c.id AND k.done = 1) AS met,
           (SELECT count(*) FROM evidence e WHERE e.card_id = c.id) AS evidence,
           (SELECT count(*) FROM comments q WHERE q.card_id = c.id AND q.kind = 'question' AND q.resolved_at IS NULL) AS questions,
           (SELECT r.result_json FROM ai_reviews r WHERE r.card_id = c.id AND r.state = 'done' ORDER BY r.started_at DESC LIMIT 1) AS review,
           (SELECT s.provider || '|' || s.state || '|' || coalesce(s.activity, '') FROM sessions s
              WHERE s.card_id = c.id AND s.state IN (${LIVE_SQL}) ORDER BY s.started_at DESC LIMIT 1) AS live
    FROM cards c JOIN projects p ON p.id = c.project_id AND p.archived_at IS NULL
    WHERE c.status IN ('review', 'working', 'ready') AND (? IS NULL OR c.project_id = ?)
    ORDER BY c.priority, c.rank
  `).all(pid, pid) as {
    key: string; title: string; type: string; priority: number; status: string; updated_at: number; sent_back: number; reopened: number;
    total: number; met: number; evidence: number; questions: number; review: string | null; live: string | null;
  }[];
  const cardLine = (c: (typeof cards)[number]): string => {
    const parts = [`${c.key} "${c.title}" (${c.type}, P${c.priority})`];
    const facts: string[] = [];
    if (c.status === 'review') facts.push(`submitted ${at(c.updated_at)}`);
    if (c.live) {
      const [provider, state, activity] = c.live.split('|');
      facts.push(`${PROVIDER_NAME[provider as Provider] ?? provider} session ${STATE_WORDS[state as SessionState] ?? state}${activity ? ` (${activity})` : ''}`);
    } else if (c.status === 'working') facts.push('no live session');
    if (c.total) facts.push(`criteria ${c.met}/${c.total} ticked`);
    if (c.status !== 'ready' && c.evidence) facts.push(`${c.evidence} evidence`);
    if (c.questions) facts.push(`${c.questions} open question${c.questions === 1 ? '' : 's'} for the owner`);
    if (c.sent_back) facts.push('sent back with changes');
    if (c.reopened) facts.push('reopened as not fixed');
    const verdict = reviewVerdict(c.review);
    if (verdict) facts.push(`AI review: ${verdict}`);
    return `${parts[0]}${facts.length ? `: ${facts.join('; ')}` : ''}`;
  };
  sections.push({ title: 'In Review (waiting for the owner to approve or send back)', empty: 'Nothing is in Review.', lines: cards.filter((c) => c.status === 'review').map(cardLine) });
  sections.push({ title: 'In Working', empty: 'Nothing is in Working.', lines: cards.filter((c) => c.status === 'working').map(cardLine) });

  const projects = ctx.db.prepare('SELECT id, key, name, paused_at FROM projects WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE')
    .all() as { id: string; key: string; name: string; paused_at: number | null }[];
  const counts = ctx.db.prepare("SELECT project_id, status, count(*) AS n FROM cards WHERE status != 'archived' GROUP BY project_id, status")
    .all() as { project_id: string; status: string; n: number }[];
  const live = new Map((ctx.db.prepare(`SELECT project_id, count(*) AS n FROM sessions WHERE state IN (${LIVE_SQL}) GROUP BY project_id`)
    .all() as { project_id: string; n: number }[]).map((r) => [r.project_id, r.n]));
  sections.push({
    title: 'Projects',
    empty: 'No project is open.',
    lines: projects.map((p) => {
      const columns = ['inbox', 'ready', 'working', 'review', 'done']
        .map((s) => `${counts.find((c) => c.project_id === p.id && c.status === s)?.n ?? 0} ${s}`).join(', ');
      const need = needs.filter((n) => n.projectId === p.id).length;
      const liveN = live.get(p.id) ?? 0;
      return `${p.key} ${p.name}${p.id === pid ? ' (this chat)' : ''}: ${columns}; ${liveN} live session${liveN === 1 ? '' : 's'}; ${need} need${need === 1 ? 's' : ''} the owner${p.paused_at ? `; paused since ${at(p.paused_at)}` : ''}`;
    }),
  });

  if (pid) {
    const decisions = ctx.db.prepare('SELECT title, body FROM decisions WHERE project_id = ? AND removed_at IS NULL ORDER BY created_at')
      .all(pid) as { title: string; body: string }[];
    sections.push({
      title: `Decisions in force for ${project?.key ?? 'this project'} (every session there is told these)`,
      empty: 'No decisions recorded.',
      lines: decisions.map((d) => `${d.title}${d.body.trim() ? `: ${d.body.trim().replace(/\s+/g, ' ')}` : ''}`),
    });
  }

  sections.push({ title: 'Top of Ready', empty: 'Nothing is Ready.', lines: cards.filter((c) => c.status === 'ready').slice(0, 6).map(cardLine) });

  const names = new Map(sessions.map((s) => [s.id, `${PROVIDER_NAME[s.provider]} "${s.title}"`]));
  const sessionName = (id: string): string => {
    const known = names.get(id);
    if (known) return known;
    const row = ctx.db.prepare('SELECT provider, title FROM sessions WHERE id = ?').get(id) as { provider: Provider; title: string } | undefined;
    const name = row ? `${PROVIDER_NAME[row.provider]} "${row.title}"` : 'a session';
    names.set(id, name);
    return name;
  };
  const recent = (since: number, limit: number) => ctx.db.prepare(`
    SELECT a.actor, a.verb, a.detail, a.at, c.key AS card_key, p.key AS project_key
    FROM activity a LEFT JOIN cards c ON c.id = a.card_id LEFT JOIN projects p ON p.id = a.project_id
    WHERE (? IS NULL OR a.project_id = ?) AND a.at >= ?
    ORDER BY a.id DESC LIMIT ?
  `).all(pid, pid, since, limit) as { actor: string; verb: string; detail: string | null; at: number; card_key: string | null; project_key: string | null }[];
  const today = recent(day, 30);
  const activity = today.length >= 5 ? today : recent(0, 10);
  sections.push({
    title: 'Activity, newest first (today, or the latest if today is quiet)',
    empty: 'No activity recorded.',
    lines: activity.map((a) => {
      const who = a.actor === 'owner' ? 'Owner' : a.actor === 'system' ? 'Wanigan' : a.actor.startsWith('session:') ? sessionName(a.actor.slice(8)) : a.actor;
      const what = a.card_key ?? a.project_key ?? '';
      return `${at(a.at)} ${who}${what ? ` · ${what}` : ''}: ${a.verb}${a.detail ? ` — ${a.detail.replace(/\s+/g, ' ')}` : ''}`;
    }),
  });

  sections.push({ title: 'Sessions that ended today', lines: sessions.filter((s) => !s.live).map(sessionLine) });

  const body = fit(sections, STATE_CAP - header.length - 1);
  return { header, body, hash: createHash('sha256').update(body).digest('hex').slice(0, 24) };
}

/**
 * Sections in order of importance, each line clipped, cut to the cap. What is
 * cut is said, never silently dropped: a missing line must not read as "none".
 */
function fit(sections: Section[], cap: number): string {
  const room = cap - 220; // kept for the notes that say what was left out
  const out: string[] = [];
  const left: string[] = [];
  let used = 0;
  const fits = (line: string): boolean => used + line.length + 1 <= room;
  const push = (line: string): void => { out.push(line); used += line.length + 1; };
  for (const section of sections) {
    if (!section.lines.length && !section.empty) continue;
    const title = `\n${section.title}:`;
    if (!fits(`${title}\n- ${section.empty ?? clip(section.lines[0] ?? '', 60)}`)) { left.push(section.title.split(' (')[0] as string); continue; }
    push(title);
    if (!section.lines.length) { push(`- ${section.empty}`); continue; }
    let shown = 0;
    for (const raw of section.lines) {
      const line = `- ${clip(raw, LINE_CAP)}`;
      if (!fits(line)) break;
      push(line);
      shown++;
    }
    if (shown < section.lines.length) push(`- … and ${section.lines.length - shown} more not shown`);
  }
  if (left.length) out.push(`\n(Left out to fit: ${left.join('; ')}.)`);
  const text = out.join('\n').trim();
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

/** One card in full, for a question that names it. */
function cardDetail(ctx: Ctx, key: string, at: (t: number | null) => string): string[] {
  const card = ctx.db.prepare(`
    SELECT c.*, p.name AS project_name FROM cards c JOIN projects p ON p.id = c.project_id WHERE c.key = ?
  `).get(key) as {
    id: string; key: string; title: string; body: string; type: string; priority: number; status: string; updated_at: number;
    sent_back: number; reopened: number; claim_session: string | null; claim_expires: number | null;
    worktree_branch: string | null; worktree_base: string | null; project_name: string;
  } | undefined;
  if (!card) return [`${key}: no such card.`];
  const lines = [`${card.key} "${card.title}": ${card.type}, P${card.priority}, in ${STATUS_NAME[card.status] ?? card.status} (${card.project_name}), last changed ${at(card.updated_at)}`];
  if (card.body.trim()) lines.push(`${card.key} description: ${card.body.trim().replace(/\s+/g, ' ').slice(0, 400)}`);
  const criteria = ctx.db.prepare('SELECT text, done FROM criteria WHERE card_id = ? ORDER BY position').all(card.id) as { text: string; done: number }[];
  lines.push(criteria.length ? `${card.key} criteria: ${criteria.map((c) => `[${c.done ? 'x' : ' '}] ${c.text}`).join('; ')}` : `${card.key} has no acceptance criteria.`);
  const live = ctx.db.prepare(`SELECT provider, title, state, activity FROM sessions WHERE card_id = ? AND state IN (${LIVE_SQL}) ORDER BY started_at DESC LIMIT 1`)
    .get(card.id) as { provider: Provider; title: string; state: SessionState; activity: string | null } | undefined;
  if (live) lines.push(`${card.key} session: ${PROVIDER_NAME[live.provider]} "${live.title}", ${STATE_WORDS[live.state]}${live.activity ? ` — ${live.activity}` : ''}`);
  else if (card.claim_session) lines.push(`${card.key} is claimed by a session that is not running (claim ends ${at(card.claim_expires)}).`);
  else lines.push(`${card.key}: no session is working on it.`);
  if (card.worktree_branch) lines.push(`${card.key} works on its own branch ${card.worktree_branch}, from ${card.worktree_base ?? 'its base'}.`);
  const flags = [card.sent_back ? 'sent back with changes' : '', card.reopened ? 'reopened as not fixed' : ''].filter(Boolean);
  if (flags.length) lines.push(`${card.key} was ${flags.join(' and ')}.`);
  const evidence = ctx.db.prepare('SELECT kind, value FROM evidence WHERE card_id = ? ORDER BY created_at DESC LIMIT 4').all(card.id) as { kind: string; value: string }[];
  if (evidence.length) lines.push(`${card.key} evidence: ${evidence.map((e) => `${e.kind} ${e.value.replace(/\s+/g, ' ').slice(0, 80)}`).join('; ')}`);
  const review = ctx.db.prepare("SELECT result_json FROM ai_reviews WHERE card_id = ? AND state = 'done' ORDER BY started_at DESC LIMIT 1").get(card.id) as { result_json: string | null } | undefined;
  const verdict = reviewVerdict(review?.result_json ?? null, true);
  if (verdict) lines.push(`${card.key} latest AI review: ${verdict}`);
  const comments = ctx.db.prepare('SELECT author, body, kind, resolved_at, created_at FROM comments WHERE card_id = ? ORDER BY created_at DESC LIMIT 3')
    .all(card.id) as { author: string; body: string; kind: string; resolved_at: number | null; created_at: number }[];
  for (const c of comments.reverse()) {
    const who = c.author === 'owner' ? 'Owner' : c.author === 'system' ? 'Wanigan' : 'An agent';
    const kind = c.kind === 'question' ? (c.resolved_at ? ' (question, answered)' : ' (question, still open)') : '';
    lines.push(`${card.key} comment, ${at(c.created_at)}, ${who}${kind}: ${c.body.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  return lines;
}

function reviewVerdict(json: string | null, withSummary = false): string | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as { verdict?: string; summary?: string };
    const verdict = VERDICT[r.verdict ?? ''] ?? null;
    if (!verdict) return null;
    return withSummary && r.summary ? `${verdict} — ${r.summary.replace(/\s+/g, ' ').slice(0, 200)}` : verdict;
  } catch {
    return null;
  }
}

/** Files each session edited since `since`, most recent first, as short paths. */
function filesEdited(ctx: Ctx, sessionIds: string[], since: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!sessionIds.length) return out;
  const rows = ctx.db.prepare(`
    SELECT session_id, path, max(at) AS last FROM session_events
    WHERE path IS NOT NULL AND at >= ? AND session_id IN (${sessionIds.map(() => '?').join(',')})
    GROUP BY session_id, path ORDER BY last DESC
  `).all(since, ...sessionIds) as { session_id: string; path: string }[];
  for (const r of rows) {
    const list = out.get(r.session_id) ?? [];
    list.push(r.path.split('/').slice(-2).join('/'));
    out.set(r.session_id, list);
  }
  return out;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "13:58" today, "Mon 13:58" this week, "Oct 1 13:58" before that. */
export function clock(at: number, now: number): string {
  const d = new Date(at);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === new Date(now).toDateString()) return hm;
  if (at < now && now - at < 6 * 86_400_000) return `${DAYS[d.getDay()]} ${hm}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm}`;
}

function stamp(now: number): string {
  const d = new Date(now);
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
