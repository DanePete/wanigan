import { randomUUID } from 'node:crypto';
import { db } from './db';
import { conversationKeyForSession } from './sessions';
import {
  defaultTagColor, isTagColor, moveInOrder, normaliseSectionName, normaliseTag, parseTagInput,
  SECTIONS_MAX, TAGS_PER_CONVERSATION_MAX,
  type OrganisedTag, type OrganiseSnapshot, type Placement, type SectionRow, type SessionOrganisation, type TagColor,
} from '../shared/session-organize';

/**
 * Tags and Recent sections, stored.
 *
 * Every write names a session id, because that is what the renderer holds, and
 * is resolved here to the conversation key Recent groups by. The renderer never
 * supplies a key: a key it could name is a key it could invent, and a tag
 * written to an invented key is a tag nothing will ever show.
 *
 * Nothing in this module is read by anything that launches, prompts or ranks an
 * agent. These are the operator's words about their own list.
 */

const SNAPSHOT_IDS_MAX = 500;

function sessionIdOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new Error('Choose a session or conversation first.');
  }
  return value;
}

function keyFor(sessionId: unknown): string {
  const key = conversationKeyForSession(sessionIdOf(sessionId));
  if (!key) {
    throw new Error('This session has no conversation id yet, so there is nothing a tag or a section could stay attached to. Try again once the agent has started its conversation.');
  }
  return key;
}

function colorRows(): Map<string, TagColor> {
  const out = new Map<string, TagColor>();
  for (const row of db().prepare('SELECT tag_norm, color FROM tag_colors').all() as { tag_norm: string; color: string }[]) {
    // A colour that is not in today's palette is ignored rather than trusted;
    // the tag falls back to its default.
    if (isTagColor(row.color)) out.set(String(row.tag_norm), row.color);
  }
  return out;
}

function tagsForKeys(keys: readonly string[], colors: Map<string, TagColor>): Map<string, OrganisedTag[]> {
  const out = new Map<string, OrganisedTag[]>();
  if (!keys.length) return out;
  const marks = keys.map(() => '?').join(',');
  const rows = db().prepare(
    `SELECT key, tag, tag_norm FROM conversation_tags WHERE key IN (${marks}) ORDER BY added_at, tag_norm`,
  ).all(...keys) as { key: string; tag: string; tag_norm: string }[];
  for (const row of rows) {
    const list = out.get(row.key) ?? [];
    list.push({ tag: row.tag, norm: row.tag_norm, color: colors.get(row.tag_norm) ?? defaultTagColor(row.tag_norm) });
    out.set(row.key, list);
  }
  return out;
}

function placementsForKeys(keys: readonly string[]): Map<string, Placement> {
  const out = new Map<string, Placement>();
  if (!keys.length) return out;
  const marks = keys.map(() => '?').join(',');
  const rows = db().prepare(
    `SELECT key, section_id, position FROM recent_section_members WHERE key IN (${marks})`,
  ).all(...keys) as { key: string; section_id: string; position: number }[];
  for (const row of rows) out.set(row.key, { sectionId: row.section_id, position: Number(row.position) });
  return out;
}

export function listSections(): SectionRow[] {
  return (db().prepare('SELECT id, name, position FROM recent_sections ORDER BY position, id').all() as SectionRow[])
    .map((row) => ({ id: String(row.id), name: String(row.name), position: Number(row.position) }));
}

function allTags(colors: Map<string, TagColor>): OrganiseSnapshot['tags'] {
  const rows = db().prepare(`
    SELECT tag_norm, MIN(tag) AS tag, COUNT(DISTINCT key) AS n FROM conversation_tags
     GROUP BY tag_norm ORDER BY n DESC, tag_norm
  `).all() as { tag_norm: string; tag: string; n: number }[];
  return rows.map((row) => ({
    tag: row.tag, norm: row.tag_norm, count: Number(row.n),
    color: colors.get(row.tag_norm) ?? defaultTagColor(row.tag_norm),
  }));
}

/**
 * Tags, placements and sections for the session ids a surface is showing.
 * Ids the renderer names are validated one by one; an unknown id answers with
 * a null key rather than failing the whole read.
 */
export function organiseSnapshot(ids: unknown): OrganiseSnapshot {
  const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && !!id.trim() && id.length <= 200) : [];
  const unique = [...new Set(list)].slice(0, SNAPSHOT_IDS_MAX);
  const keyOf = new Map<string, string | null>(unique.map((id) => [id, conversationKeyForSession(id)]));
  const keys = [...new Set([...keyOf.values()].filter((k): k is string => !!k))];
  const colors = colorRows();
  const tags = tagsForKeys(keys, colors);
  const placements = placementsForKeys(keys);
  const sessions: Record<string, SessionOrganisation> = {};
  for (const [id, key] of keyOf) {
    sessions[id] = { key, tags: key ? tags.get(key) ?? [] : [], placement: key ? placements.get(key) ?? null : null };
  }
  return { sessions, sections: listSections(), tags: allTags(colors) };
}

function one(sessionId: string): SessionOrganisation {
  return organiseSnapshot([sessionId]).sessions[sessionId];
}

/** Add one or more comma-separated tags. Refuses the whole write if any piece is invalid, so nothing is half-applied. */
export function addTags(sessionId: unknown, raw: unknown): SessionOrganisation {
  const id = sessionIdOf(sessionId);
  const key = keyFor(id);
  if (typeof raw !== 'string') throw new Error('Type a tag first.');
  const { tags, refused } = parseTagInput(raw);
  if (refused.length) throw new Error(refused[0]);
  if (!tags.length) throw new Error('Type a tag first.');
  const existing = db().prepare('SELECT tag_norm FROM conversation_tags WHERE key = ?').all(key) as { tag_norm: string }[];
  const have = new Set(existing.map((row) => row.tag_norm));
  const fresh = tags.filter((t) => !have.has(t.norm));
  if (have.size + fresh.length > TAGS_PER_CONVERSATION_MAX) {
    throw new Error(`A conversation carries at most ${TAGS_PER_CONVERSATION_MAX} tags. Remove one first.`);
  }
  const insert = db().prepare('INSERT OR IGNORE INTO conversation_tags (key, tag, tag_norm, added_at) VALUES (?,?,?,?)');
  const now = Date.now();
  db().transaction(() => { fresh.forEach((t, i) => insert.run(key, t.tag, t.norm, now + i)); })();
  return one(id);
}

export function removeTag(sessionId: unknown, tag: unknown): SessionOrganisation {
  const id = sessionIdOf(sessionId);
  const key = keyFor(id);
  const parsed = normaliseTag(tag);
  if (!parsed.ok) throw new Error(parsed.reason);
  db().prepare('DELETE FROM conversation_tags WHERE key = ? AND tag_norm = ?').run(key, parsed.value.norm);
  return one(id);
}

/** A colour for a tag everywhere it appears. Only palette ids are accepted. */
export function setTagColor(tag: unknown, color: unknown): TagColor {
  const parsed = normaliseTag(tag);
  if (!parsed.ok) throw new Error(parsed.reason);
  if (!isTagColor(color)) throw new Error('Choose one of the tag colours Wanigan offers.');
  db().prepare(`
    INSERT INTO tag_colors (tag_norm, color) VALUES (?, ?)
    ON CONFLICT(tag_norm) DO UPDATE SET color = excluded.color
  `).run(parsed.value.norm, color);
  return color;
}

/* ── sections ────────────────────────────────────────────────────────── */

function sectionIdOf(value: unknown): string {
  if (typeof value !== 'string' || !/^sec_[A-Za-z0-9-]{8,64}$/.test(value)) throw new Error('That section does not exist.');
  const found = db().prepare('SELECT id FROM recent_sections WHERE id = ?').get(value) as { id: string } | undefined;
  if (!found) throw new Error('That section does not exist any more.');
  return value;
}

/** Rewrite positions as 0..n-1 in the given order, so a gap or a tie never decides the order. */
function writeSectionOrder(order: readonly string[]): void {
  const update = db().prepare('UPDATE recent_sections SET position = ? WHERE id = ?');
  db().transaction(() => { order.forEach((id, i) => update.run(i, id)); })();
}

function writeMemberOrder(order: readonly string[]): void {
  const update = db().prepare('UPDATE recent_section_members SET position = ? WHERE key = ?');
  db().transaction(() => { order.forEach((key, i) => update.run(i, key)); })();
}

export function createSection(name: unknown): SectionRow[] {
  const parsed = normaliseSectionName(name);
  if (!parsed.ok) throw new Error(parsed.reason);
  const sections = listSections();
  if (sections.length >= SECTIONS_MAX) throw new Error(`Recent holds at most ${SECTIONS_MAX} sections.`);
  if (sections.some((s) => s.name.toLocaleLowerCase() === parsed.name.toLocaleLowerCase())) {
    throw new Error(`There is already a section called “${parsed.name}”.`);
  }
  db().prepare('INSERT INTO recent_sections (id, name, position, created_at) VALUES (?,?,?,?)')
    .run(`sec_${randomUUID()}`, parsed.name, sections.length, Date.now());
  return listSections();
}

export function renameSection(id: unknown, name: unknown): SectionRow[] {
  const sectionId = sectionIdOf(id);
  const parsed = normaliseSectionName(name);
  if (!parsed.ok) throw new Error(parsed.reason);
  if (listSections().some((s) => s.id !== sectionId && s.name.toLocaleLowerCase() === parsed.name.toLocaleLowerCase())) {
    throw new Error(`There is already a section called “${parsed.name}”.`);
  }
  db().prepare('UPDATE recent_sections SET name = ? WHERE id = ?').run(parsed.name, sectionId);
  return listSections();
}

export function moveSection(id: unknown, delta: unknown): SectionRow[] {
  const sectionId = sectionIdOf(id);
  if (delta !== -1 && delta !== 1) throw new Error('A section moves one place up or down.');
  const order = listSections().map((s) => s.id);
  const next = moveInOrder(order, sectionId, delta);
  if (next !== order) writeSectionOrder(next);
  return listSections();
}

/**
 * Deleting a section deletes the shelf, not what was on it: its conversations
 * go back to the unfiled part of Recent, where they were before being filed.
 */
export function deleteSection(id: unknown): SectionRow[] {
  const sectionId = sectionIdOf(id);
  db().transaction(() => {
    db().prepare('DELETE FROM recent_section_members WHERE section_id = ?').run(sectionId);
    db().prepare('DELETE FROM recent_sections WHERE id = ?').run(sectionId);
  })();
  writeSectionOrder(listSections().map((s) => s.id));
  return listSections();
}

/** File a conversation into a section, at its end, or take it out with null. */
export function placeInSection(sessionId: unknown, sectionId: unknown): SessionOrganisation {
  const id = sessionIdOf(sessionId);
  const key = keyFor(id);
  if (sectionId === null) {
    const was = db().prepare('SELECT section_id FROM recent_section_members WHERE key = ?').get(key) as { section_id: string } | undefined;
    db().prepare('DELETE FROM recent_section_members WHERE key = ?').run(key);
    if (was) writeMemberOrder(membersOf(was.section_id));
    return one(id);
  }
  const target = sectionIdOf(sectionId);
  const was = db().prepare('SELECT section_id FROM recent_section_members WHERE key = ?').get(key) as { section_id: string } | undefined;
  if (was?.section_id === target) return one(id);
  const end = (db().prepare('SELECT COUNT(*) AS n FROM recent_section_members WHERE section_id = ?').get(target) as { n: number }).n;
  db().prepare(`
    INSERT INTO recent_section_members (key, section_id, position, moved_at) VALUES (?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET section_id = excluded.section_id, position = excluded.position, moved_at = excluded.moved_at
  `).run(key, target, Number(end), Date.now());
  if (was) writeMemberOrder(membersOf(was.section_id));
  return one(id);
}

function membersOf(sectionId: string): string[] {
  return (db().prepare('SELECT key FROM recent_section_members WHERE section_id = ? ORDER BY position, moved_at').all(sectionId) as { key: string }[])
    .map((row) => row.key);
}

/** Move a filed conversation one place up or down within its section. */
export function moveInSection(sessionId: unknown, delta: unknown): SessionOrganisation {
  const id = sessionIdOf(sessionId);
  const key = keyFor(id);
  if (delta !== -1 && delta !== 1) throw new Error('A conversation moves one place up or down.');
  const row = db().prepare('SELECT section_id FROM recent_section_members WHERE key = ?').get(key) as { section_id: string } | undefined;
  if (!row) throw new Error('This conversation is not in a section.');
  const order = membersOf(row.section_id);
  const next = moveInOrder(order, key, delta);
  writeMemberOrder(next);
  return one(id);
}
