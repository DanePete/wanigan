/**
 * One declaration per destination, and the tables derived from it.
 *
 * A view reaches this app today through seven hand-edits in five files, and the
 * one that matters most is checked by nothing: a route registered in `TABS`
 * with no branch in `App.tsx` renders an empty pane while all eight gates pass.
 * Two more are silent by default rather than unchecked — a destination missing
 * from `projectScopeFor` is quietly `workspace`, and the digit row is the first
 * nine rows of an array, so inserting a row rather than appending one moves
 * every shortcut after it and drops the ninth off the end.
 *
 * This is the seam those seven edits collapse into. It is pure — no Electron,
 * no fs, no imports from `src/main` — so the suite beside it answers in under a
 * second and the renderer, the main process and the phone all read one record
 * rather than four that agree until they do not.
 *
 * What it deliberately does NOT do is invent new behaviour. Every derivation
 * below returns the shape its existing consumer already reads, because the
 * conversion that puts the current views on this registry has to be reviewable
 * as a move. The improvements are confined to things that were previously
 * unstated: a scope and a phone disposition are now required, and a digit-row
 * slot is declared rather than inferred from position.
 *
 * This is not the extension manifest. A third-party extension is declarations
 * over surfaces that already exist and never loads code; this registry is how
 * Wanigan's own defaults are assembled, and a module here is first-party code.
 * Keeping the two apart is the whole reason a stranger's bundle is installable.
 */

/** Where a destination sits when a project is or is not selected. */
export type ViewProjectScope = 'required' | 'optional' | 'workspace';

/**
 * The phone either narrows a destination into one of its screens, or says why
 * it has none. There is no third option, and no default: a destination absent
 * from both is the state that currently reads as an unfinished build.
 */
export type ViewPhone =
  | { narrowedBy: string }
  | { absent: string };

export type ViewModule = {
  /** The route id. Becomes a `Tab`, a memory key and a shortcut binding id. */
  id: string;
  label: string;
  /** What the surface does, never a restatement of the label — the palette
   *  matches title, hint and keywords as one string, so a stale word here
   *  outranks the view that actually owns it. */
  hint: string;
  keywords: string;
  icon: string;
  /** A `SPACE_AREAS` id. The palette's group string is derived from its label,
   *  so the two can no longer disagree. */
  area: string;
  projectScope: ViewProjectScope;
  shortcut: { label: string; aria: string };
  phone: ViewPhone;
  /** Whether the demo window renders it rather than the prepared placeholder. */
  demo: boolean;
  /**
   * Whether this destination holds one of the nine digit-row chords.
   *
   * Declared rather than inferred. Today the digit row is `TABS.slice(0, 9)`,
   * so a row inserted at index 5 takes a chord from whatever was ninth and
   * removes it from the cheat sheet, the Settings list and the key handler at
   * once — silently, because nothing counts them. Here ten claimants is an
   * error with both names in it.
   */
  digit: boolean;
};

/**
 * The area rows this registry derives group labels and sidebar order from.
 * `icon` is the sidebar's glyph for the area heading — carried here, rather
 * than in a second table, for the same reason `tabs` is: one array cannot
 * disagree with itself.
 */
export type ViewArea = { id: string; label: string; icon: string; tabs: readonly string[] };

/** How many chords the digit row has. Mirrors `DIGIT_ROUTES`. */
export const DIGIT_SLOTS = 9;

/** A phone reason is a sentence, because a phrase reads as a stub. */
const MIN_ABSENT_REASON = 20;

/* ── derivations ──────────────────────────────────────────────────────── */

export type RouteRow<Id extends string = string> = {
  id: Id; label: string; group: string; hint: string; keywords: string;
};

/*
 * Every derivation below is generic in the module type — `T extends
 * ViewModule`, keyed off `T['id']` rather than plain `string` — so a registry
 * declared `as const` keeps its literal ids through the call: `RouteRow<Tab>`
 * and `Record<Tab, string>` rather than `RouteRow<string>` and `Record<string,
 * string>`. Widening here would quietly drop the exhaustiveness the
 * hand-written tables got from `satisfies Record<Tab, …>` — and would surface
 * as a real defect the moment a caller like `routes.ts` assigns the result to
 * a `Tab`-keyed table and expects `TABS[number].id` to still narrow.
 */

/**
 * The `TABS` rows, with `group` taken from the module's area rather than typed
 * beside it. Nothing enforced that pairing before, and the palette prints
 * `group · hint`, so a mismatch was a visible lie with no test behind it.
 */
export function routeRows<T extends ViewModule>(
  modules: readonly T[], areas: readonly ViewArea[],
): RouteRow<T['id']>[] {
  const label = new Map(areas.map((area) => [area.id, area.label]));
  return modules.map((m) => ({
    id: m.id, label: m.label, group: label.get(m.area) ?? '', hint: m.hint, keywords: m.keywords,
  }));
}

export function iconMap<T extends ViewModule>(modules: readonly T[]): Record<T['id'], string> {
  return Object.fromEntries(modules.map((m) => [m.id, m.icon])) as Record<T['id'], string>;
}

export function shortcutMap<T extends ViewModule>(
  modules: readonly T[],
): Record<T['id'], { label: string; aria: string }> {
  return Object.fromEntries(modules.map((m) => [m.id, m.shortcut])) as
    Record<T['id'], { label: string; aria: string }>;
}

/**
 * The order the cheat sheet, Settings › Keyboard and the key handler read.
 * Digit holders first in declared order, then everything else — which is what
 * `TABS.slice(0, DIGIT_ROUTES)` plus a hand-listed tail produces today, without
 * the hand-listed tail being a second place to forget a destination.
 */
export function shortcutOrder<T extends ViewModule>(modules: readonly T[]): T['id'][] {
  return [
    ...modules.filter((m) => m.digit).map((m) => m.id),
    ...modules.filter((m) => !m.digit).map((m) => m.id),
  ];
}

/**
 * The destinations claiming one area, in REGISTRY order.
 *
 * This is deliberately not the sidebar's order and must not be wired to it.
 * The two are independent: the registry is ordered for the palette, which
 * prints results in table order, while an area orders its own rows for the
 * sidebar — and they genuinely differ in four of seven areas today. Swapping
 * one for the other would reshuffle the sidebar silently while every test
 * stayed green, which is the class of change this seam exists to prevent.
 *
 * `ViewArea.tabs` stays the sidebar's source of truth. What the registry adds
 * is that the two can no longer disagree about MEMBERSHIP — see
 * `validateViewModules`, which is the check nothing performed before.
 */
export function areaTabs<T extends ViewModule>(modules: readonly T[], areaId: string): T['id'][] {
  return modules.filter((m) => m.area === areaId).map((m) => m.id);
}

/** A scope, or null when the id is not a registered destination. */
export function projectScopeOf(
  modules: readonly ViewModule[], id: string,
): ViewProjectScope | null {
  return modules.find((m) => m.id === id)?.projectScope ?? null;
}

/** The destinations the demo window renders itself rather than placeholding. */
export function demoViews<T extends ViewModule>(modules: readonly T[]): T['id'][] {
  return modules.filter((m) => m.demo).map((m) => m.id);
}

/** The destinations with no phone surface, and the sentence each gives. */
export function phoneAbsences<T extends ViewModule>(
  modules: readonly T[],
): { id: T['id']; reason: string }[] {
  return modules
    .filter((m): m is T & { phone: { absent: string } } => 'absent' in m.phone)
    .map((m) => ({ id: m.id, reason: m.phone.absent }));
}

/* ── validation ───────────────────────────────────────────────────────── */

/**
 * Every rule that a hand-registered view could previously break quietly.
 *
 * It returns a list rather than throwing, and names the offending id in every
 * message, because this runs in a test whose job is to say what to fix rather
 * than that something is wrong.
 */
export function validateViewModules(
  modules: readonly ViewModule[], areas: readonly ViewArea[],
): string[] {
  const errors: string[] = [];
  const areaIds = new Set(areas.map((a) => a.id));

  const seen = new Set<string>();
  for (const m of modules) {
    if (seen.has(m.id)) errors.push(`${m.id}: declared twice.`);
    seen.add(m.id);

    if (!m.label.trim()) errors.push(`${m.id}: has no label.`);
    if (!m.hint.trim()) errors.push(`${m.id}: has no hint.`);
    // The palette searches hint and keywords, so a hint echoing the label adds
    // a row that matches its own name and nothing a person would type.
    if (m.hint.trim().toLowerCase() === m.label.trim().toLowerCase()) {
      errors.push(`${m.id}: hint restates the label instead of saying what the surface does.`);
    }
    if (!m.keywords.trim()) errors.push(`${m.id}: has no keywords.`);
    if (!m.icon.trim()) errors.push(`${m.id}: has no icon.`);
    if (!areaIds.has(m.area)) errors.push(`${m.id}: area "${m.area}" is not a known area.`);

    if (!m.shortcut.label.trim() || !m.shortcut.aria.trim()) {
      errors.push(`${m.id}: shortcut needs both a printed label and an aria chord.`);
    }

    if ('absent' in m.phone) {
      const reason = m.phone.absent.trim();
      if (reason.length < MIN_ABSENT_REASON) {
        errors.push(`${m.id}: phone absence reason is too short to be a decision.`);
      } else if (!reason.endsWith('.')) {
        errors.push(`${m.id}: phone absence reason is not a sentence.`);
      }
    } else if (!m.phone.narrowedBy.trim()) {
      errors.push(`${m.id}: phone narrowing names no screen.`);
    }
  }

  // The hazard this registry exists to remove: a tenth claimant is an error
  // naming every holder, rather than a shortcut quietly vanishing.
  const digits = modules.filter((m) => m.digit).map((m) => m.id);
  if (digits.length > DIGIT_SLOTS) {
    errors.push(
      `${digits.length} destinations claim a digit-row chord and there are ${DIGIT_SLOTS}: `
      + `${digits.join(', ')}.`,
    );
  }

  // Two destinations printing the same chord means one of them never fires.
  const chords = new Map<string, string>();
  for (const m of modules) {
    const key = m.shortcut.label.trim();
    if (!key) continue;
    const held = chords.get(key);
    if (held) errors.push(`${m.id}: shortcut ${key} is already held by ${held}.`);
    else chords.set(key, m.id);
  }

  // An area with no destinations renders a sidebar row that opens nothing.
  for (const area of areas) {
    if (!modules.some((m) => m.area === area.id)) {
      errors.push(`area "${area.id}" has no destinations.`);
    }
  }

  // Membership, not order: an area lists its rows in its own sequence for the
  // sidebar, and that is allowed to differ from registry order. What is not
  // allowed is the two disagreeing about WHICH destinations an area holds — a
  // module claiming an area that does not list it never reaches the sidebar,
  // and an area listing a module that does not claim it renders a dead row.
  // Nothing checked either direction before this.
  for (const area of areas) {
    const claimed = new Set(modules.filter((m) => m.area === area.id).map((m) => m.id));
    const listed = new Set(area.tabs);
    for (const id of claimed) {
      if (!listed.has(id)) {
        errors.push(`${id}: claims area "${area.id}", which does not list it — it would never reach the sidebar.`);
      }
    }
    for (const id of listed) {
      if (!claimed.has(id)) {
        errors.push(`area "${area.id}" lists "${id}", which does not claim it — that sidebar row opens nothing.`);
      }
    }
  }

  return errors;
}
