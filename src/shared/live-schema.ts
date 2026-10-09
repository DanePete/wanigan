// A small form for an edit target the site helper describes with JSON Schema
// (`via: 'schema'` in live-trace.ts): a site tagline, a block's attributes, a
// component's props. It reads only what a short form can show faithfully:
// strings, numbers, booleans, a choice from a list, a list of strings, and one
// object of those. Anything else is not drawn here, and the target's own
// form in the site is the way to change it.
//
// The helper validates every value again before it saves, and is the
// authority. These checks are for saying what is wrong before the round trip,
// and for the main process to refuse a value that could not be right. Regular
// expressions from a schema (`pattern`) are never run here: they come from the
// site, and one written badly could hang the window or the main process.

const MAX_TEXT = 20_000;
const MAX_ITEMS = 200;
const MAX_FIELDS = 60;

interface Base {
  /** The property's key; '' for a schema that is one value, not an object. */
  name: string;
  title: string;
  description: string | null;
  required: boolean;
}

export type SchemaField =
  | Base & { kind: 'string'; multiline: boolean; minLength: number | null; maxLength: number | null }
  | Base & { kind: 'number'; integer: boolean; minimum: number | null; maximum: number | null }
  | Base & { kind: 'boolean' }
  | Base & { kind: 'choice'; options: { value: string | number; label: string }[] }
  | Base & { kind: 'strings'; minItems: number | null; maxItems: number | null; maxLength: number | null };

export interface SchemaForm {
  /** An object of fields, or one value. */
  object: boolean;
  fields: SchemaField[];
  /** An object's properties this form cannot show: kept as they are when it saves. */
  kept: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 300): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** `machine_name` as the owner reads it. */
const human = (key: string): string => {
  const words = key.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
};

/** A schema's type, when it names exactly one (a nullable `["string", "null"]` counts as its one real type). */
function typeOf(s: Record<string, unknown>): string | null {
  if (typeof s.type === 'string') return s.type;
  if (Array.isArray(s.type)) {
    const real = s.type.filter((t) => t !== 'null');
    return real.length === 1 && typeof real[0] === 'string' ? real[0] : null;
  }
  return null;
}

/** The choices a schema offers: `enum`, or `oneOf` of `{ const, title }`. Null when it offers none. */
function choices(s: Record<string, unknown>): { value: string | number; label: string }[] | null {
  const plain = (v: unknown): v is string | number => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
  if (Array.isArray(s.enum)) {
    const list = s.enum.filter(plain).slice(0, 200);
    return list.length && list.length === s.enum.length ? list.map((v) => ({ value: v, label: String(v) })) : null;
  }
  if (Array.isArray(s.oneOf) && s.oneOf.length && s.oneOf.every((o) => isObj(o) && plain(o.const))) {
    return s.oneOf.slice(0, 200).map((o) => {
      const c = (o as Record<string, unknown>).const as string | number;
      return { value: c, label: text((o as Record<string, unknown>).title) ?? String(c) };
    });
  }
  return null;
}

/** One field from one schema, or null when a short form cannot show it. */
function field(name: string, raw: unknown, required: boolean): SchemaField | null {
  if (!isObj(raw)) return null;
  const base: Base = { name, title: text(raw.title) ?? (name ? human(name) : 'Value'), description: text(raw.description, 600), required };
  const options = choices(raw);
  if (options) return { ...base, kind: 'choice', options };
  switch (typeOf(raw)) {
    case 'string': {
      const maxLength = count(raw.maxLength);
      return { ...base, kind: 'string', minLength: count(raw.minLength), maxLength, multiline: raw.format === 'textarea' || maxLength === null || maxLength > 255 };
    }
    case 'integer':
    case 'number':
      return { ...base, kind: 'number', integer: typeOf(raw) === 'integer', minimum: finite(raw.minimum), maximum: finite(raw.maximum) };
    case 'boolean':
      return { ...base, kind: 'boolean' };
    case 'array': {
      const items = isObj(raw.items) ? raw.items : null;
      if (!items || typeOf(items) !== 'string' || choices(items)) return null;
      return { ...base, kind: 'strings', minItems: count(raw.minItems), maxItems: count(raw.maxItems), maxLength: count(items.maxLength) };
    }
    default:
      return null;
  }
}

/**
 * The form for a schema: one value, or one object whose properties are each
 * one of the kinds above. Null when the schema is something else (nested
 * objects, references, unions): the site's own form is the way to edit it.
 */
export function schemaForm(schema: unknown): SchemaForm | null {
  if (!isObj(schema)) return null;
  if (typeOf(schema) === 'object' || (!schema.type && isObj(schema.properties))) {
    if (!isObj(schema.properties)) return null;
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []);
    const fields: SchemaField[] = [];
    const kept: string[] = [];
    for (const [key, prop] of Object.entries(schema.properties).slice(0, MAX_FIELDS)) {
      if (isObj(prop) && (prop.readOnly === true)) { kept.push(key); continue; }
      const f = field(key, prop, required.has(key));
      if (f) fields.push(f); else kept.push(key);
    }
    // An object the form can show none of, or must leave a required property of, is not one to edit here.
    if (!fields.length || kept.some((k) => required.has(k))) return null;
    return { object: true, fields, kept };
  }
  const one = field('', schema, true);
  return one ? { object: false, fields: [one], kept: [] } : null;
}

/** What a form holds while the owner types: text for text and numbers, true or false, a choice, a list of text. */
export type Draft = Record<string, string | boolean | string[]>;

/** The draft for a form, from the target's current value. */
export function draftOf(form: SchemaForm, value: unknown): Draft {
  const at = (f: SchemaField): unknown => (form.object ? (isObj(value) ? value[f.name] : undefined) : value);
  const draft: Draft = {};
  for (const f of form.fields) {
    const v = at(f);
    switch (f.kind) {
      case 'string': draft[f.name] = typeof v === 'string' ? v.slice(0, MAX_TEXT) : ''; break;
      case 'number': draft[f.name] = typeof v === 'number' && Number.isFinite(v) ? String(v) : ''; break;
      case 'boolean': draft[f.name] = v === true; break;
      case 'choice': { const at = f.options.findIndex((o) => o.value === v); draft[f.name] = at >= 0 ? String(at) : ''; break; }
      case 'strings': draft[f.name] = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_ITEMS) : []; break;
    }
  }
  return draft;
}

/** What is wrong with one field's value, in the owner's words; null when nothing is. */
function problem(f: SchemaField, v: unknown): string | null {
  const missing = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  if (missing) return f.required && f.kind !== 'boolean' && f.kind !== 'strings' ? `${f.title} is required.` : null;
  switch (f.kind) {
    case 'string':
      if (typeof v !== 'string') return `${f.title} must be text.`;
      if (v.length > MAX_TEXT) return `${f.title} is too long.`;
      if (f.maxLength !== null && v.length > f.maxLength) return `${f.title} can be at most ${f.maxLength} characters (it is ${v.length}).`;
      if (f.minLength !== null && v.length < f.minLength) return `${f.title} needs at least ${f.minLength} characters.`;
      return null;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${f.title} must be a number.`;
      if (f.integer && !Number.isInteger(v)) return `${f.title} must be a whole number.`;
      if (f.minimum !== null && v < f.minimum) return `${f.title} must be ${f.minimum} or more.`;
      if (f.maximum !== null && v > f.maximum) return `${f.title} must be ${f.maximum} or less.`;
      return null;
    case 'boolean':
      return typeof v === 'boolean' ? null : `${f.title} must be on or off.`;
    case 'choice':
      return f.options.some((o) => o.value === v) ? null : `${f.title} must be one of its choices.`;
    case 'strings': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return `${f.title} must be a list of text.`;
      if (v.length > MAX_ITEMS) return `${f.title} has too many items.`;
      if (f.maxItems !== null && v.length > f.maxItems) return `${f.title} can have at most ${f.maxItems} items.`;
      if (f.minItems !== null && v.length < f.minItems) return `${f.title} needs at least ${f.minItems} items.`;
      if (f.maxLength !== null && v.some((x) => (x as string).length > (f.maxLength as number))) return `Each item of ${f.title} can be at most ${f.maxLength} characters.`;
      return null;
    }
  }
}

/**
 * The value a draft makes, ready to save: the object's other properties kept
 * from the current value. Or what is wrong, by field name ('' for one value).
 */
export function valueOf(form: SchemaForm, draft: Draft, current: unknown): { value: unknown } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const out: Record<string, unknown> = form.object && isObj(current) ? Object.fromEntries(form.kept.filter((k) => k in current).map((k) => [k, current[k]])) : {};
  let single: unknown;
  for (const f of form.fields) {
    const d = draft[f.name];
    let v: unknown;
    switch (f.kind) {
      case 'string': v = typeof d === 'string' ? d : ''; if (v === '' && !f.required) v = undefined; break;
      case 'number': {
        const t = typeof d === 'string' ? d.trim() : '';
        v = t === '' ? undefined : Number(t);
        if (t !== '' && !/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(t)) { errors[f.name] = `${f.title} must be a number.`; continue; }
        break;
      }
      case 'boolean': v = d === true; break;
      case 'choice': v = typeof d === 'string' && d !== '' ? f.options[Number(d)]?.value : undefined; break;
      case 'strings': v = Array.isArray(d) ? d.map((s) => s.trim()).filter(Boolean) : []; break;
    }
    const wrong = problem(f, v);
    if (wrong) { errors[f.name] = wrong; continue; }
    if (form.object) { if (v !== undefined) out[f.name] = v; } else single = v ?? null;
  }
  if (Object.keys(errors).length) return { errors };
  return { value: form.object ? out : single };
}

/**
 * Whether a value could be what a schema asks for: the main process's check
 * before it posts a save to the site. A schema this form cannot draw is left
 * to the helper, which validates every save itself. Returns what is wrong, or
 * an empty list.
 */
export function checkValue(schema: unknown, value: unknown): string[] {
  const form = schemaForm(schema);
  if (!form) return [];
  if (!form.object) {
    const f = form.fields[0] as SchemaField;
    const wrong = problem(f, value);
    return wrong ? [wrong] : [];
  }
  if (!isObj(value)) return ['The value must be an object of fields.'];
  return form.fields.map((f) => problem(f, value[f.name])).filter((p): p is string => p !== null);
}
