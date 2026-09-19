/**
 * Mustache-lite prompt templating: {{column}} slots bound to dataset rows.
 * Deliberately not a real template engine — no logic, no partials, no eval.
 */
export type Row = Record<string, unknown>;

const SLOT = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function slotsIn(template: string): string[] {
  return [...new Set([...template.matchAll(SLOT)].map((m) => m[1]))];
}

export function render(template: string, row: Row): string {
  return template.replace(SLOT, (_, key: string) => {
    const v = lookup(row, key);
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

function lookup(row: Row, key: string): unknown {
  if (key in row) return row[key];
  // dotted path support for nested JSONL rows
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as Row)) return (acc as Row)[part];
    return undefined;
  }, row);
}

/** Slots referenced by the template that no row actually provides. */
export function missingSlots(template: string, columns: string[]): string[] {
  const cols = new Set(columns);
  return slotsIn(template).filter((s) => !cols.has(s) && !cols.has(s.split('.')[0]));
}

/**
 * custom_id must match ^[a-zA-Z0-9_-]{1,64}$ and be unique within the batch.
 * We derive it from the row index plus an optional stable key column so results
 * (which come back out of order) can always be matched to their input.
 */
export function customIdFor(index: number, row: Row, keyColumn?: string): string {
  const base = keyColumn ? String(lookup(row, keyColumn) ?? '') : '';
  const safe = base.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 48);
  const id = safe ? `r${index}-${safe}` : `r${index}`;
  return id.slice(0, 64);
}
