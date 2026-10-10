// The design layer's log (docs/design/2026-10-09-design-layer.md, "Phase 1, as contracted"): the owner's edits to
// the live page, kept per project until they are made real in the site and verified. The core never writes to the
// site or the project; the main process shows the edits on the page (src/main/live-layer.ts).
//
// - One row per edit, as layerEdit() checked it (src/shared/design-layer.ts). The core gives it its id, who made it,
//   when, and its first state; nothing the caller sends for those is kept.
// - Beside it, an append-only list of what was done to the edits: add, discard, undo, redo and mark. Undo and redo
//   replay that list, so they are exact: undo takes back the newest add or discard still in effect, redo brings back
//   the newest one undone, and a new add or discard ends what redo could bring back.
// - An edit already in the site (implemented, verified) is never taken back by undo or redo: taking it out of the
//   layer would not take it out of the site, and the layer would lose track of it. Nor does it go back to draft or
//   to orphaned, from where it could be discarded: a page where its element is not found does not take it out of
//   the site, and a failed verification is kept with it, saying what differs.
// - States move only along the design's transitions (`mark`), and a refusal says why.
// - Bounded: edits listed per project, the bytes they hold, and every row a project's layer has ever had.
import { randomUUID } from 'node:crypto';
import { layerEdit, type LayerEdit, type LayerSnapshot, type LayerState, type LayerVerdict } from '../shared/design-layer.ts';
import { parseVerdict } from '../shared/layer-verify.ts';
import { CoreError } from '../shared/protocol.ts';
import type { Board } from './board.ts';
import type { Ctx } from './context.ts';
import type { Handlers } from './handlers.ts';

/** Edits a project's layer lists at once (drafts and edits in the site, not retired ones). */
export const MAX_LAYER_EDITS = 300;
/** What the listed edits may hold together, in characters of their stored JSON: a snapshot stays well inside one message. */
export const MAX_LAYER_BYTES = 8 * 1024 * 1024;
/** Every edit a project's layer has ever had, taken back and discarded ones included: the log is never pruned. */
export const MAX_LAYER_ROWS = 20_000;

const STATES: readonly LayerState[] = ['draft', 'implemented', 'verified', 'retired', 'orphaned'];
/** Kinds of change phase 1 shows on the page. Pictures, inserts and removals come later. */
const PHASE_1 = new Set(['style', 'token', 'text']);
/** Where an edit may go from each state. Once in the site (implemented), only forward: it is never a draft again. */
const NEXT: Record<LayerState, readonly LayerState[]> = {
  draft: ['implemented', 'orphaned'],
  implemented: ['verified'],
  orphaned: ['draft'],
  verified: ['retired'],
  retired: [],
};

interface EditRow {
  id: string; project_id: string; seq: number; target_json: string; label: string; page: string; scope: string; breakpoint: string;
  change_json: string; before_json: string; state: string; made_by: string; made_at: number; verdict_json: string | null; listed: number;
}

type Undoable = { action: 'add' | 'discard'; actionId: number; editId: string };

const invalid = (message: string): never => { throw new CoreError('invalid', message); };
const refused = (message: string): never => { throw new CoreError('refused', message); };

/** A stored row as an edit, read leniently: a row this build cannot read is left out rather than guessed at. */
function toEdit(r: EditRow): LayerEdit | null {
  try {
    const checked = layerEdit({
      id: r.id, target: JSON.parse(r.target_json), label: r.label, page: r.page, scope: r.scope, breakpoint: r.breakpoint,
      change: JSON.parse(r.change_json), before: JSON.parse(r.before_json), state: r.state, by: r.made_by, at: r.made_at,
    });
    if (!checked.edit) return null;
    const verdict = r.verdict_json ? parseVerdict(JSON.parse(r.verdict_json)) : null;
    return { ...checked.edit, verdict };
  } catch {
    return null;
  }
}

/** The words a state is said in. */
const said = (s: LayerState): string => (s === 'implemented' ? 'implemented (in the site, not yet verified)' : s);

export class LiveLayer {
  private readonly ctx: Ctx;
  private readonly board: Board;

  constructor(ctx: Ctx, board: Board) {
    this.ctx = ctx;
    this.board = board;
  }

  /** A project's layer: the edits in effect and in the site, in the order made, and what undo and redo would do. */
  snapshot(projectId: string): LayerSnapshot {
    const project = this.board.project(projectId);
    const rows = this.ctx.db.prepare("SELECT * FROM live_layer_edits WHERE project_id = ? AND listed = 1 AND state != 'retired' ORDER BY seq")
      .all(project.id) as EditRow[];
    const edits = rows.map(toEdit).filter((e): e is LayerEdit => e !== null);
    const { undo, redo } = this.stacks(project.id);
    const entry = (u: Undoable | null): LayerSnapshot['undo'] => {
      if (!u) return null;
      const row = this.row(u.editId);
      return row ? { id: row.id, label: row.label, action: u.action } : null;
    };
    return { projectId: project.id, edits, undo: entry(undo), redo: entry(redo) };
  }

  /** Add an edit the window keyed (a LayerEditInput): checked with layerEdit(), given its id, `owner`, now and `draft`. */
  add(projectId: string, raw: unknown): LayerSnapshot {
    const project = this.board.project(projectId);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid('An edit is its target, its change and the page it was made on.');
    const r = raw as Record<string, unknown>;
    const now = this.ctx.now();
    const checked = layerEdit({
      id: randomUUID(), target: r.target, label: r.label, page: r.page, scope: r.scope, breakpoint: r.breakpoint, change: r.change, before: r.before,
      by: 'owner', at: now, state: 'draft',
    });
    if (!checked.edit) return invalid(checked.refused);
    const edit = checked.edit;
    // layerEdit reads a missing page as the front page; an edit added here must say where it was made.
    if (r.page !== edit.page) return invalid('An edit says the page it was made on, as a path of the site (“/about”).');
    if (!PHASE_1.has(edit.change.type)) return refused('Only words, styles and tokens are layer edits so far. Pictures, inserting and taking out are done directly on the page.');
    const json = { target: JSON.stringify(edit.target), change: JSON.stringify(edit.change), before: JSON.stringify(edit.before) };
    const size = json.target.length + json.change.length + json.before.length;
    const { db } = this.ctx;
    db.transaction(() => {
      const rows = db.prepare('SELECT count(*) AS n FROM live_layer_edits WHERE project_id = ?').get(project.id) as { n: number };
      if (rows.n >= MAX_LAYER_ROWS) refused(`This project’s layer has kept ${MAX_LAYER_ROWS.toLocaleString('en')} edits, its limit; it keeps no more.`);
      const listed = db.prepare(`SELECT count(*) AS n, coalesce(sum(length(target_json) + length(change_json) + length(before_json)), 0) AS bytes
        FROM live_layer_edits WHERE project_id = ? AND listed = 1 AND state != 'retired'`).get(project.id) as { n: number; bytes: number };
      if (listed.n >= MAX_LAYER_EDITS) refused(`The layer holds at most ${MAX_LAYER_EDITS} edits at once. Make some real, or discard some, first.`);
      if (listed.bytes + size > MAX_LAYER_BYTES) refused('The layer’s edits are too large together to keep another. Make some real, or discard some, first.');
      const { seq } = db.prepare('SELECT coalesce(max(seq), 0) + 1 AS seq FROM live_layer_edits WHERE project_id = ?').get(project.id) as { seq: number };
      db.prepare(`INSERT INTO live_layer_edits (id, project_id, seq, target_json, label, page, scope, breakpoint, change_json, before_json, state, made_by, made_at, verdict_json, listed, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'owner', ?, NULL, 1, ?)`)
        .run(edit.id, project.id, seq, json.target, edit.label, edit.page, edit.scope, edit.breakpoint, json.change, json.before, now, now);
      this.log(project.id, edit.id, 'add', null, null, null, now);
    }).immediate();
    return this.changed(project.id);
  }

  /** Take a draft or orphaned edit out of the tray; it stays in the log, and undo brings it back. */
  discard(projectId: string, id: string): LayerSnapshot {
    const project = this.board.project(projectId);
    const { db } = this.ctx;
    db.transaction(() => {
      const row = this.listed(project.id, id);
      if (row.state !== 'draft' && row.state !== 'orphaned') {
        refused(`Only a draft or an orphaned edit is discarded; this one is ${said(row.state as LayerState)}, so taking it out of the layer would not take it out of the site.`);
      }
      const now = this.ctx.now();
      db.prepare('UPDATE live_layer_edits SET listed = 0, updated_at = ? WHERE id = ?').run(now, row.id);
      this.log(project.id, row.id, 'discard', null, null, null, now);
    }).immediate();
    return this.changed(project.id);
  }

  /** Take back the newest add or discard still in effect. */
  undo(projectId: string): LayerSnapshot {
    const project = this.board.project(projectId);
    const { db } = this.ctx;
    db.transaction(() => {
      const { undo, blocked } = this.stacks(project.id);
      if (!undo) refused(blocked ?? 'There is nothing to undo.');
      const u = undo as Undoable;
      const now = this.ctx.now();
      db.prepare('UPDATE live_layer_edits SET listed = ?, updated_at = ? WHERE id = ?').run(u.action === 'add' ? 0 : 1, now, u.editId);
      this.log(project.id, u.editId, 'undo', u.actionId, null, null, now);
    }).immediate();
    return this.changed(project.id);
  }

  /** Do again the newest add or discard undo took back, until a new add or discard. */
  redo(projectId: string): LayerSnapshot {
    const project = this.board.project(projectId);
    const { db } = this.ctx;
    db.transaction(() => {
      const { redo, blockedRedo } = this.stacks(project.id);
      if (!redo) refused(blockedRedo ?? 'There is nothing to redo.');
      const u = redo as Undoable;
      const now = this.ctx.now();
      db.prepare('UPDATE live_layer_edits SET listed = ?, updated_at = ? WHERE id = ?').run(u.action === 'add' ? 1 : 0, now, u.editId);
      this.log(project.id, u.editId, 'redo', u.actionId, null, null, now);
    }).immediate();
    return this.changed(project.id);
  }

  /**
   * What became of an edit: draft → implemented → verified → retired; a draft → orphaned, and back to draft when it
   * resolves again. An implemented edit is in the site: it never goes back to draft or to orphaned, and a verification
   * that failed is kept with it (marked implemented again, with the verdict). A verdict is kept only on an implemented
   * edit by its verification: verified needs one that passed, and one that passed makes it verified. Marking an edit
   * the state it is in only records a verdict.
   */
  mark(projectId: string, id: string, rawState: unknown, rawVerdict: unknown): LayerSnapshot {
    const project = this.board.project(projectId);
    if (!STATES.includes(rawState as LayerState)) return invalid('A state is draft, implemented, verified, retired or orphaned.');
    const to = rawState as LayerState;
    let verdict: LayerVerdict | null = null;
    if (rawVerdict !== undefined && rawVerdict !== null) {
      verdict = parseVerdict(rawVerdict);
      if (!verdict) return invalid('That is not a verification’s verdict.');
    }
    const { db } = this.ctx;
    let changed = false;
    db.transaction(() => {
      const row = this.listed(project.id, id);
      const from = row.state as LayerState;
      if (to === from && !verdict) return;
      if (to !== from && !NEXT[from].includes(to)) refused(this.why(from, to));
      if (to === 'verified' && !verdict?.ok) refused('An edit is verified only by a verification that passed.');
      if (verdict && to !== 'verified' && !(from === 'implemented' && to === 'implemented')) {
        refused(`A verification’s verdict is kept only on an edit in the site; this one is ${said(from)}.`);
      }
      if (verdict?.ok && to !== 'verified') refused('A verification that passed marks the edit verified.');
      const now = this.ctx.now();
      if (verdict) db.prepare('UPDATE live_layer_edits SET state = ?, verdict_json = ?, updated_at = ? WHERE id = ?').run(to, JSON.stringify(verdict), now, row.id);
      else db.prepare('UPDATE live_layer_edits SET state = ?, updated_at = ? WHERE id = ?').run(to, now, row.id);
      this.log(project.id, row.id, 'mark', null, from, to, now);
      changed = true;
    }).immediate();
    return changed ? this.changed(project.id) : this.snapshot(project.id);
  }

  /** Why a move between two states is refused, in the owner's words. */
  private why(from: LayerState, to: LayerState): string {
    if (from === 'retired') return 'A retired edit is archived: it does not change again.';
    if (to === 'verified') return `Only an implemented edit is verified; this one is ${said(from)}. Make it real first.`;
    if (to === 'retired') return `Only a verified edit is retired; this one is ${said(from)}.`;
    if (to === 'implemented') return from === 'orphaned'
      ? 'An orphaned edit no longer finds its element: it goes back to draft when it does, and is made real from there.'
      : `Only a draft becomes implemented; this one is ${said(from)}.`;
    if (from === 'implemented') return to === 'orphaned'
      ? 'An implemented edit is in the site: a page where its element is not found does not take it out of the layer.'
      : 'An implemented edit is in the site: it does not go back to draft. A verification that failed is kept with it, and says what differs.';
    if (to === 'orphaned') return `Only a draft becomes orphaned; this one is ${said(from)}.`;
    return `A ${from} edit does not go back to draft.`;
  }

  /** A listed edit of this project, or why there is none. */
  private listed(projectId: string, id: unknown): EditRow {
    if (typeof id !== 'string' || !id || id.length > 64) return invalid('Which edit?');
    const row = this.ctx.db.prepare('SELECT * FROM live_layer_edits WHERE id = ? AND project_id = ?').get(id, projectId) as EditRow | undefined;
    if (!row) throw new CoreError('not_found', 'No such edit in this project’s layer.');
    if (!row.listed) return refused('That edit is not in the layer now: it was undone or discarded.');
    return row;
  }

  private row(id: string): EditRow | null {
    return (this.ctx.db.prepare('SELECT * FROM live_layer_edits WHERE id = ?').get(id) as EditRow | undefined) ?? null;
  }

  private log(projectId: string, editId: string, action: 'add' | 'discard' | 'undo' | 'redo' | 'mark', ref: number | null, from: string | null, to: string | null, at: number): void {
    this.ctx.db.prepare('INSERT INTO live_layer_actions (project_id, edit_id, action, ref, state_from, state_to, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, editId, action, ref, from, to, at);
  }

  /**
   * Undo's and redo's next step, from the log replayed in order: each add or discard goes on the done list and
   * empties the undone list; undo moves the newest done one to undone; redo moves it back. An edit in the site
   * blocks the step that would take it out of the layer, and the reason is kept to say.
   */
  private stacks(projectId: string): { undo: Undoable | null; redo: Undoable | null; blocked: string | null; blockedRedo: string | null } {
    const rows = this.ctx.db.prepare("SELECT id, edit_id, action FROM live_layer_actions WHERE project_id = ? AND action IN ('add', 'discard', 'undo', 'redo') ORDER BY id")
      .all(projectId) as { id: number; edit_id: string; action: 'add' | 'discard' | 'undo' | 'redo' }[];
    const done: Undoable[] = [];
    let undone: Undoable[] = [];
    for (const r of rows) {
      if (r.action === 'add' || r.action === 'discard') { done.push({ action: r.action, actionId: r.id, editId: r.edit_id }); undone = []; }
      else if (r.action === 'undo') { const u = done.pop(); if (u) undone.push(u); }
      else { const u = undone.pop(); if (u) done.push(u); }
    }
    const inSite = (u: Undoable | undefined): string | null => {
      if (!u) return null;
      const state = this.row(u.editId)?.state;
      return state === 'draft' || state === 'orphaned' ? null : `“${this.row(u.editId)?.label ?? 'That edit'}” is ${said(state as LayerState)}: taking it out of the layer would not take it out of the site.`;
    };
    const top = done.at(-1);
    // Taking back an add, or doing a discard again, takes the edit out of the layer.
    const blocked = top && top.action === 'add' ? inSite(top) : null;
    const next = undone.at(-1);
    const blockedRedo = next && next.action === 'discard' ? inSite(next) : null;
    return { undo: top && !blocked ? top : null, redo: next && !blockedRedo ? next : null, blocked, blockedRedo };
  }

  /** Tell the window the layer changed, and answer with it. */
  private changed(projectId: string): LayerSnapshot {
    this.ctx.emit('liveLayer', { projectId });
    return this.snapshot(projectId);
  }
}

type LayerMethods = 'live.layer' | 'live.layerAdd' | 'live.layerDiscard' | 'live.layerUndo' | 'live.layerRedo' | 'live.layerMark';

export function liveLayerHandlers(layer: LiveLayer): Pick<Handlers, LayerMethods> {
  return {
    'live.layer': (p) => layer.snapshot(ref(p.projectId, 'project')),
    'live.layerAdd': (p) => layer.add(ref(p.projectId, 'project'), p.edit),
    'live.layerDiscard': (p) => layer.discard(ref(p.projectId, 'project'), ref(p.id, 'edit')),
    'live.layerUndo': (p) => layer.undo(ref(p.projectId, 'project')),
    'live.layerRedo': (p) => layer.redo(ref(p.projectId, 'project')),
    'live.layerMark': (p) => layer.mark(ref(p.projectId, 'project'), ref(p.id, 'edit'), p.state, p.verdict),
  };
}

function ref(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > 200) throw new CoreError('invalid', `Which ${what}?`);
  return v;
}
