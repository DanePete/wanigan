/**
 * Tags and Recent sections, the pure half.
 *
 * A tag is a word the operator puts on a conversation — "release-blocker",
 * "spike", "waiting on CI" — and a section is a named shelf in Recent they
 * create, order and move conversations into. Both are the operator's own
 * words about the work. Neither is inferred, suggested or ranked here: this
 * file only normalises what was typed, colours it from a fixed palette, and
 * arranges rows in the order the operator chose.
 *
 * Both are keyed by the conversation, not the launch. A session id belongs to
 * one process and a resume starts a new one; the conversation key
 * (`<harness>:conversation:<id>`, the grouping Recent already uses) is what a
 * resume keeps, so a tag put on a running tab is still there on the Recent row
 * it becomes and on the tab that resumes it.
 */

/** Longest tag, in characters. Long enough for "waiting on CI", short enough for a chip. */
export const TAG_MAX_CHARS = 32;
/** Tags on one conversation. A chip row past this stops being scannable. */
export const TAGS_PER_CONVERSATION_MAX = 8;
/** Longest section name. */
export const SECTION_NAME_MAX_CHARS = 40;
/** Sections in Recent. */
export const SECTIONS_MAX = 24;

/**
 * The colours a tag may wear, by id. Each id is a token in index.css
 * (`--tag-<id>`), which maps to a palette colour already defined for both
 * themes — so a tag can never carry a hex value a renderer or a database row
 * invented, and every colour has a light and a dark rendering.
 *
 * Colour is never the only thing that tells two tags apart: the chip always
 * prints the word.
 */
export const TAG_COLORS = ['blue', 'orange', 'green', 'yellow', 'violet', 'teal', 'red', 'grey'] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export function isTagColor(value: unknown): value is TagColor {
  return typeof value === 'string' && (TAG_COLORS as readonly string[]).includes(value);
}

export type NormalisedTag = { tag: string; norm: string };

/** C0 controls and DEL. A loop rather than a character class, which the linter reads as a mistake. */
export function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * What the operator typed, as a tag, or the sentence that says why not.
 *
 * Whitespace is collapsed and the ends trimmed; case is kept for display and
 * folded for identity, so "CI" and "ci" are one tag. Control characters are
 * refused rather than stripped — a pasted escape sequence is not a word
 * somebody meant.
 */
export function normaliseTag(raw: unknown): { ok: true; value: NormalisedTag } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: 'A tag is a word or a short phrase.' };
  if (hasControlCharacter(raw)) return { ok: false, reason: 'A tag cannot contain control characters.' };
  const tag = raw.replace(/\s+/g, ' ').trim().replace(/^#+/, '').trim();
  if (!tag) return { ok: false, reason: 'Type a tag first.' };
  if ([...tag].length > TAG_MAX_CHARS) return { ok: false, reason: `A tag is at most ${TAG_MAX_CHARS} characters.` };
  return { ok: true, value: { tag, norm: tag.toLocaleLowerCase() } };
}

/** Several tags typed at once, comma-separated, duplicates folded. Invalid pieces are reported, not dropped silently. */
export function parseTagInput(raw: string): { tags: NormalisedTag[]; refused: string[] } {
  const tags: NormalisedTag[] = [];
  const refused: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(',')) {
    if (!piece.trim()) continue;
    const result = normaliseTag(piece);
    if (!result.ok) { refused.push(`${piece.trim().slice(0, 40)}: ${result.reason}`); continue; }
    if (seen.has(result.value.norm)) continue;
    seen.add(result.value.norm);
    tags.push(result.value);
  }
  return { tags, refused };
}

/**
 * The colour a tag gets before anyone chooses one: a stable hash of its folded
 * text into the palette, so the same word is the same colour on every row and
 * after every restart without a row having been written for it.
 */
export function defaultTagColor(norm: string): TagColor {
  let h = 2166136261;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Grey is kept for the operator to choose; a default never lands on it,
  // because a grey chip reads as disabled.
  return TAG_COLORS[h % (TAG_COLORS.length - 1)];
}

/** A section name, trimmed, or the sentence that says why not. */
export function normaliseSectionName(raw: unknown): { ok: true; name: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: 'A section needs a name.' };
  if (hasControlCharacter(raw)) return { ok: false, reason: 'A section name cannot contain control characters.' };
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, reason: 'A section needs a name.' };
  if ([...name].length > SECTION_NAME_MAX_CHARS) return { ok: false, reason: `A section name is at most ${SECTION_NAME_MAX_CHARS} characters.` };
  return { ok: true, name };
}

/**
 * Move one id a step up (-1) or down (+1) in an ordered list. Returns the same
 * array when the move would leave the list, so a caller can tell "nothing to
 * do" from "moved" by identity and skip a write.
 */
export function moveInOrder<T extends string>(order: readonly T[], id: T, delta: -1 | 1): readonly T[] {
  const at = order.indexOf(id);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= order.length) return order;
  const next = order.slice();
  next[at] = order[to];
  next[to] = id;
  return next;
}

export type SectionRow = { id: string; name: string; position: number };
export type Placement = { sectionId: string; position: number };

/**
 * Recent, arranged: pinned first (a pin wins over a section, exactly as it
 * wins over the recency cap), then each section in the operator's order with
 * its members in theirs, then everything unfiled, then the settled shelf. A
 * member whose section no longer exists is unfiled rather than lost.
 */
export function arrangeRecent<T extends { id: string; pinnedAt: number | null; settledAt: number | null }>(
  rows: readonly T[],
  sections: readonly SectionRow[],
  placementOf: (row: T) => Placement | null,
): { pinned: T[]; sections: { section: SectionRow; rows: T[] }[]; unfiled: T[]; settled: T[] } {
  const ordered = sections.slice().sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const known = new Set(ordered.map((s) => s.id));
  const bySection = new Map<string, { row: T; position: number }[]>();
  const pinned: T[] = [];
  const unfiled: T[] = [];
  const settled: T[] = [];
  for (const row of rows) {
    if (row.pinnedAt != null) { pinned.push(row); continue; }
    if (row.settledAt != null) { settled.push(row); continue; }
    const place = placementOf(row);
    if (place && known.has(place.sectionId)) {
      const list = bySection.get(place.sectionId) ?? [];
      list.push({ row, position: place.position });
      bySection.set(place.sectionId, list);
    } else {
      unfiled.push(row);
    }
  }
  return {
    pinned,
    sections: ordered.map((section) => ({
      section,
      rows: (bySection.get(section.id) ?? []).sort((a, b) => a.position - b.position).map((entry) => entry.row),
    })),
    unfiled,
    settled,
  };
}

/** Rows carrying a tag, by folded text. A null filter keeps everything. */
export function filterByTag<T>(rows: readonly T[], norm: string | null, tagsOf: (row: T) => readonly { norm: string }[]): T[] {
  if (!norm) return rows.slice();
  return rows.filter((row) => tagsOf(row).some((t) => t.norm === norm));
}

/**
 * Every tag in use across some rows, most used first, then alphabetical — the
 * order a filter row lists them in. Counts are rows carrying the tag, not
 * occurrences.
 */
export function tagCounts<T>(rows: readonly T[], tagsOf: (row: T) => readonly { tag: string; norm: string }[]): { tag: string; norm: string; count: number }[] {
  const by = new Map<string, { tag: string; norm: string; count: number }>();
  for (const row of rows) {
    const seen = new Set<string>();
    for (const t of tagsOf(row)) {
      if (seen.has(t.norm)) continue;
      seen.add(t.norm);
      const entry = by.get(t.norm) ?? { tag: t.tag, norm: t.norm, count: 0 };
      entry.count += 1;
      by.set(t.norm, entry);
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.norm.localeCompare(b.norm));
}

/* ── what crosses the bridge ─────────────────────────────────────────── */

export type OrganisedTag = { tag: string; norm: string; color: TagColor };

/** One session id's organisation: its conversation, the tags on it, and its Recent shelf. */
export type SessionOrganisation = {
  /** Null when the session has no conversation id yet, so nothing can attach. */
  key: string | null;
  tags: OrganisedTag[];
  placement: Placement | null;
};

export type OrganiseSnapshot = {
  sessions: Record<string, SessionOrganisation>;
  sections: SectionRow[];
  /** Every tag in use on any conversation, with its colour and how many conversations carry it. */
  tags: (OrganisedTag & { count: number })[];
};
