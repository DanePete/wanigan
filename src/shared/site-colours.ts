// The site's own colours, for Try a style's colour fields (components/live/StyleFields.tsx): where each comes from, in
// this order of authority, and never a colour or a name made up.
//
// 1. The platform's declared palette. WordPress: theme.json and global styles, as core merges them
//    (wp_get_global_settings( array( 'color', 'palette' ) ), keyed by origin: default, theme, custom), read through the
//    site helper (GET /_wanigan/palette, helper version 5). Each entry is written as its preset's custom property,
//    `var(--wp--preset--color--<slug>)`, so the edit follows the site's design system. Drupal core has no palette
//    registry: for Drupal the theme's tokens are the declared source.
// 2. The theme's design tokens: custom properties on the page's root (and on <body> and the theme's top containers)
//    that hold a colour, by name, written as `var(--name)`.
// 3. The colours the page uses: the computed colour, background and border colour of its visible elements, weighted
//    by how much of the page each covers, merged where two are near-identical (OKLab distance), transparent ones left
//    out, ranked, about twelve kept. Unnamed: each is said by its value and how it is used.
//
// Everything the page script and the helper say is untrusted: checked here, anything else left out, never repaired.
// Pure, so node's test runner reads it as the window and the main process do.
import { layerValue } from './design-layer.ts';

/** A custom property's name, as the layer takes a token's. */
const TOKEN = /^--[a-z0-9][a-z0-9-]{0,99}$/i;

/**
 * A colour value as a page computes one or a theme declares one: a hex colour, a colour function of numbers (rgb,
 * hsl, hwb, lab, lch, oklab, oklch, color), or a colour's name. Never a keyword that is no colour of its own
 * (transparent, currentcolor, inherit and the like), never a length, never anything layerValue would refuse.
 */
const COLOUR_VALUE = /^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([a-z0-9 .,%/+-]{1,80}\)|[a-z]{3,20})$/i;
const NOT_A_COLOUR = /^(?:transparent|currentcolor|inherit|initial|unset|revert|revert-layer|none|auto|normal)$/i;

/** Whether a value is a colour the layer would print, by its shape: what every source's value is checked by. */
export function colourShaped(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const v = raw.trim();
  return v.length <= 100 && COLOUR_VALUE.test(v) && !NOT_A_COLOUR.test(v) && layerValue(v) !== null;
}

export const SITE_COLOUR_LIMITS = { palette: 100, tokens: 48, used: 12, samples: 400 } as const;

/* ── 1. the platform's declared palette ── */

/** Where WordPress's merged palette took an entry from: core's defaults, the theme's theme.json, or the Site Editor's global styles. */
export type PaletteOrigin = 'default' | 'theme' | 'custom';

/** One colour of the site's declared palette. */
export interface SitePaletteColour {
  /** As core writes it into the preset's custom property (kebab case). */
  slug: string;
  /** Its name as declared; null when the theme gave none. */
  name: string | null;
  /** Its value as declared. */
  value: string;
  origin: PaletteOrigin;
  /** The custom property core prints for it: what an edit writes, inside var(). */
  ref: string;
}

/** A palette source the helper knows is there but does not read yet (a page builder's own global colours). */
export interface PaletteNotYet { id: string; name: string; why: string }

export type SitePaletteAnswer =
  | { state: 'ok'; platform: 'wordpress'; colours: SitePaletteColour[]; notYet: PaletteNotYet[] }
  /** Drupal core has no palette registry: the theme's tokens are the declared source. */
  | { state: 'none'; platform: 'drupal' }
  /** No helper, or no trace of the page shown yet to say which platform it is. */
  | { state: 'no-helper' }
  | { state: 'no-trace' }
  /** The helper predates /_wanigan/palette: updating it adds it. */
  | { state: 'outdated' }
  | { state: 'refused'; status: number }
  | { state: 'down'; error: string }
  | { state: 'unreadable' };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ORIGINS: readonly PaletteOrigin[] = ['default', 'theme', 'custom'];
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * The helper's answer to GET /_wanigan/palette, checked: each entry a slug core would print, a name, a colour, an
 * origin. A slug in more than one origin is the custom property core prints once, with the last origin's value (its
 * compute_preset_vars() overwrites by slug in the order default, theme, custom): so here too, in the first one's place.
 */
export function parseSitePalette(raw: unknown): SitePaletteAnswer | null {
  if (!isObj(raw) || raw.version !== 1 || raw.platform !== 'wordpress') return null;
  const bySlug = new Map<string, SitePaletteColour>();
  for (const e of Array.isArray(raw.palette) ? raw.palette.slice(0, 1000) : []) {
    if (!isObj(e) || typeof e.slug !== 'string' || !SLUG.test(e.slug) || !colourShaped(e.color)) continue;
    if (!ORIGINS.includes(e.origin as PaletteOrigin)) continue;
    const ref = `--wp--preset--color--${e.slug}`;
    if (!TOKEN.test(ref)) continue;
    const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim().slice(0, 80) : null;
    if (!bySlug.has(e.slug) && bySlug.size >= SITE_COLOUR_LIMITS.palette) continue;
    bySlug.set(e.slug, { slug: e.slug, name, value: e.color.trim(), origin: e.origin as PaletteOrigin, ref });
  }
  const notYet: PaletteNotYet[] = [];
  for (const s of Array.isArray(raw.notYet) ? raw.notYet.slice(0, 10) : []) {
    if (!isObj(s) || typeof s.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(s.id) || typeof s.name !== 'string' || typeof s.why !== 'string') continue;
    notYet.push({ id: s.id, name: s.name.trim().slice(0, 60), why: s.why.trim().slice(0, 300) });
  }
  return { state: 'ok', platform: 'wordpress', colours: [...bySlug.values()], notYet };
}

/** Where a palette entry came from, said plainly. */
export const ORIGIN_WORDS: Record<PaletteOrigin, string> = {
  default: 'WordPress’s default palette',
  theme: 'the theme’s theme.json',
  custom: 'global styles (Site Editor)',
};

/* ── 2. the theme's design tokens ── */

/** Where a token is set: the page's root, <body>, or one of the theme's top containers (a child of <body>). */
export type TokenOn = 'root' | 'body' | 'container';

export interface ThemeToken { name: string; value: string; on: TokenOn }

/** The tokens the page script read, checked: a custom property's name, a colour value, each name once, at most the limit. */
export function themeTokens(raw: unknown): ThemeToken[] {
  if (!Array.isArray(raw)) return [];
  const out: ThemeToken[] = [];
  const seen = new Set<string>();
  for (const t of raw.slice(0, 400)) {
    if (out.length >= SITE_COLOUR_LIMITS.tokens) break;
    if (!isObj(t) || typeof t.name !== 'string' || !TOKEN.test(t.name) || t.name.startsWith('--wl-')) continue;
    if (seen.has(t.name.toLowerCase()) || !colourShaped(t.value)) continue;
    const on: TokenOn = t.on === 'body' || t.on === 'container' ? t.on : 'root';
    seen.add(t.name.toLowerCase());
    out.push({ name: t.name, value: (t.value as string).trim(), on });
  }
  return out;
}

/* ── 3. the colours the page uses ── */

export type UsedAs = 'text' | 'background' | 'border';

/** What the page script measured for one computed colour in one use: how much of the page it covers, on how many elements. */
export interface UsedSample { value: string; as: UsedAs; weight: number; elements: number }

/** A colour the page uses: its value (the heaviest of those merged into it), how it is used, and how much. */
export interface UsedColour {
  value: string;
  as: UsedAs[];
  elements: number;
  /** Of everything measured, the part it covers, 0 to 1. */
  share: number;
}

/** sRGB channels 0–1 and alpha, from the forms a browser computes: rgb()/rgba() (either syntax), hex, color(srgb …). Null for any other. */
export function srgbOf(css: string): { r: number; g: number; b: number; a: number } | null {
  const v = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (hex) {
    const h = hex[1] as string;
    const full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h;
    const n = (i: number): number => Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) : 1 };
  }
  const alpha = (s: string | undefined): number | null => {
    if (s === undefined) return 1;
    const a = s.endsWith('%') ? Number.parseFloat(s) / 100 : Number(s);
    return Number.isFinite(a) && a >= 0 && a <= 1 ? a : null;
  };
  const rgb = /^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(v);
  if (rgb) {
    const ch = (s: string): number | null => {
      const n = s.endsWith('%') ? Number.parseFloat(s) / 100 : Number(s) / 255;
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
    };
    const [r, g, b, a] = [ch(rgb[1] as string), ch(rgb[2] as string), ch(rgb[3] as string), alpha(rgb[4])];
    return r === null || g === null || b === null || a === null ? null : { r, g, b, a };
  }
  const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/.exec(v);
  if (srgb) {
    const [r, g, b] = [Number(srgb[1]), Number(srgb[2]), Number(srgb[3])];
    const a = alpha(srgb[4]);
    if ([r, g, b].some((n) => !Number.isFinite(n) || n < 0 || n > 1) || a === null) return null;
    return { r, g, b, a };
  }
  return null;
}

/** OKLab (Björn Ottosson's, 2020) from sRGB: a space where distance follows how different two colours look. */
export function oklabOf(c: { r: number; g: number; b: number }): [number, number, number] {
  const lin = (x: number): number => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [lin(c.r), lin(c.g), lin(c.b)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Two colours closer than this in OKLab look the same: about one just-noticeable difference. */
export const MERGE_DISTANCE = 0.02;
/** Two alphas further apart than this are different colours however close their channels are. */
const MERGE_ALPHA = 0.05;

/**
 * The colours the page uses, ranked: samples checked, the transparent left out, near-identical ones (OKLab distance
 * under MERGE_DISTANCE, alpha within MERGE_ALPHA) merged into the heaviest of them, then ordered by how much of the
 * page each covers, at most `keep`. A colour in a form this cannot read (a wide-gamut lab() or oklch()) is kept as it
 * is and merged only with the same value.
 */
export function rankUsed(raw: unknown, keep: number = SITE_COLOUR_LIMITS.used): UsedColour[] {
  const samples: UsedSample[] = [];
  for (const s of Array.isArray(raw) ? raw.slice(0, SITE_COLOUR_LIMITS.samples) : []) {
    if (!isObj(s) || !colourShaped(s.value) || (s.as !== 'text' && s.as !== 'background' && s.as !== 'border')) continue;
    const weight = typeof s.weight === 'number' && Number.isFinite(s.weight) && s.weight > 0 ? s.weight : 0;
    const elements = typeof s.elements === 'number' && Number.isInteger(s.elements) && s.elements > 0 ? s.elements : 0;
    if (!weight || !elements) continue;
    samples.push({ value: (s.value as string).trim(), as: s.as, weight, elements });
  }
  samples.sort((a, b) => b.weight - a.weight);
  interface Cluster { value: string; lab: [number, number, number] | null; alpha: number; as: Set<UsedAs>; weight: number; elements: number }
  const clusters: Cluster[] = [];
  for (const s of samples) {
    const c = srgbOf(s.value);
    if (c && c.a === 0) continue;
    const lab = c ? oklabOf(c) : null;
    const alpha = c ? c.a : 1;
    const near = clusters.find((k) => (lab && k.lab
      ? Math.hypot(lab[0] - k.lab[0], lab[1] - k.lab[1], lab[2] - k.lab[2]) < MERGE_DISTANCE && Math.abs(alpha - k.alpha) <= MERGE_ALPHA
      : !lab && !k.lab && k.value.toLowerCase() === s.value.toLowerCase()));
    if (near) {
      near.as.add(s.as);
      near.weight += s.weight;
      near.elements += s.elements;
    } else {
      clusters.push({ value: s.value, lab, alpha, as: new Set([s.as]), weight: s.weight, elements: s.elements });
    }
  }
  const total = clusters.reduce((n, k) => n + k.weight, 0);
  const order: UsedAs[] = ['text', 'background', 'border'];
  return clusters.sort((a, b) => b.weight - a.weight).slice(0, Math.max(0, keep)).map((k) => ({
    value: k.value, as: order.filter((a) => k.as.has(a)), elements: k.elements, share: total ? k.weight / total : 0,
  }));
}

/** How a used colour is used, in words: "text and background, on 34 elements". */
export function usedWords(u: UsedColour): string {
  const as = u.as.length > 1 ? `${u.as.slice(0, -1).join(', ')} and ${u.as.at(-1)}` : (u.as[0] ?? 'colour');
  return `${as}, on ${u.elements.toLocaleString('en')} ${u.elements === 1 ? 'element' : 'elements'}`;
}

/* ── together ── */

/** Everything Try a style offers as the site's own colours (LiveBridge.siteColours). */
export interface SiteColours {
  palette: SitePaletteAnswer;
  tokens: ThemeToken[];
  used: UsedColour[];
}

/**
 * The site's colours from what the page script read (layerColors: tokens and used samples) and the palette the
 * helper answered. A token that is a palette entry's own custom property is shown once, as the palette's.
 */
export function siteColoursOf(page: unknown, palette: SitePaletteAnswer): SiteColours {
  const p = isObj(page) ? page : {};
  const refs = new Set(palette.state === 'ok' ? palette.colours.map((c) => c.ref) : []);
  return { palette, tokens: themeTokens(p.tokens).filter((t) => !refs.has(t.name)), used: rankUsed(p.used) };
}
