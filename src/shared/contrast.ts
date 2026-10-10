// WCAG contrast for the interface's tokens (renderer/src/styles/tokens.css).
// Pure: it reads the stylesheet's two themes as text, resolves var()
// references, lays a translucent colour over the surface beneath it, and
// measures. contrast.test.ts runs it over the real file, so a token that
// slips under AA fails `npm test`, in either theme.

export type Theme = 'dark' | 'light';
type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

/**
 * One text (or UI part) on one surface. `over` is what a translucent surface
 * sits on (a selected row's water-soft lies over a panel). `min` is 4.5 for
 * text and 3 for a part of a control (WCAG 1.4.3 and 1.4.11).
 */
export interface ContrastPair {
  fg: string;
  on: string;
  over?: string;
  min: number;
  /** Where the pair appears, for the failure message. */
  use: string;
}

/** Every surface text is drawn on. */
export const TEXT_SURFACES = ['--bg', '--bg-rail', '--surface', '--raised', '--sunken', '--bg-field', '--bg-canvas', '--hover'] as const;

const on = (fg: string, min: number, use: string, surfaces: readonly string[] = TEXT_SURFACES): ContrastPair[] =>
  surfaces.map((s) => ({ fg, on: s, min, use }));

/** The pairs the Studio spec lists (docs/design/2026-10-10-studio.md, Tokens), in both themes. */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...on('--fg', 4.5, 'primary text'),
  ...on('--muted', 4.5, 'secondary text'),
  ...on('--faint', 4.5, 'tertiary text: counts, hints'),
  ...on('--water-text', 4.5, 'blue words: links, a selected row'),
  ...on('--water', 3, 'the focus ring, a selection outline, the selected tool'),
  ...on('--amber', 4.5, 'needs-you words'),
  ...on('--red', 4.5, 'failed or refused words'),
  ...on('--green', 4.5, 'saved or verified words'),
  { fg: '--water-ink', on: '--water-fill', min: 4.5, use: 'the primary button' },
  { fg: '--water-text', on: '--water-soft', over: '--surface', min: 4.5, use: 'a selected row' },
  { fg: '--fg', on: '--water-soft', over: '--surface', min: 4.5, use: 'text in a selected row' },
  { fg: '--muted', on: '--water-soft', over: '--surface', min: 4.5, use: 'secondary text in a selected row' },
  { fg: '--amber-fill-ink', on: '--amber-fill', min: 4.5, use: 'a needs-you count' },
  { fg: '--amber', on: '--amber-soft', over: '--surface', min: 4.5, use: 'a needs-you chip' },
  { fg: '--red', on: '--red-soft', over: '--surface', min: 4.5, use: 'a failure chip' },
  { fg: '--green', on: '--green-soft', over: '--surface', min: 4.5, use: 'a saved chip' },
];

/** The custom properties of each theme: :root is dark, and light overrides it. */
export function themeTokens(css: string): Record<Theme, Map<string, string>> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const dark = new Map<string, string>();
  const light = new Map<string, string>();
  // Top-level blocks only: a :root inside @media (reduced motion) changes no colour.
  let depth = 0;
  let start = 0;
  let selector = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      if (depth === 0) { selector = text.slice(start, i).trim(); start = i + 1; }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        const body = text.slice(start, i);
        const target = selector === ':root' ? dark : /^:root\[data-theme=['"]light['"]\]$/.test(selector) ? light : null;
        if (target) for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) target.set(m[1] as string, (m[2] as string).trim());
        start = i + 1;
      }
    }
  }
  return { dark, light: new Map([...dark, ...light]) };
}

/** A colour as written in the stylesheet, with var() followed. Null when it is not a plain colour. */
export function parseColour(value: string, tokens: Map<string, string>, seen = new Set<string>()): Rgba | null {
  const v = value.trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) {
    const name = ref[1] as string;
    if (seen.has(name)) return null;
    const next = tokens.get(name);
    return next === undefined ? null : parseColour(next, tokens, new Set([...seen, name]));
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = (hex[1] as string).length === 3 ? [...(hex[1] as string)].map((x) => x + x).join('') : (hex[1] as string);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (fn) {
    const parts = (fn[1] as string).split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return [parts[0] as number, parts[1] as number, parts[2] as number, parts[3] ?? 1];
  }
  return null;
}

/** A translucent colour laid over an opaque one. */
export function over([r, g, b, a]: Rgba, [R, G, B]: Rgb): Rgb {
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
}

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG 2 contrast ratio of two opaque colours. */
export function ratio(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export interface Measured extends ContrastPair { theme: Theme; ratio: number | null }

/** Every pair, measured in both themes. A pair whose colours cannot be read measures null (a failure). */
export function measure(css: string, pairs: readonly ContrastPair[] = CONTRAST_PAIRS): Measured[] {
  const themes = themeTokens(css);
  const out: Measured[] = [];
  for (const theme of ['dark', 'light'] as const) {
    const tokens = themes[theme];
    const read = (name: string): Rgba | null => parseColour(`var(${name})`, tokens);
    for (const pair of pairs) {
      const fg = read(pair.fg);
      const surface = read(pair.on);
      const beneath = pair.over ? read(pair.over) : null;
      if (!fg || !surface || (pair.over && !beneath) || (surface[3] < 1 && !beneath)) { out.push({ ...pair, theme, ratio: null }); continue; }
      const back = surface[3] < 1 ? over(surface, beneath!.slice(0, 3) as Rgb) : (surface.slice(0, 3) as Rgb);
      const front = fg[3] < 1 ? over(fg, back) : (fg.slice(0, 3) as Rgb);
      out.push({ ...pair, theme, ratio: ratio(front, back) });
    }
  }
  return out;
}

/** What falls short, in words: "light: --faint on --bg-canvas is 4.12:1, under 4.5 (tertiary text: counts, hints)". */
export function shortfalls(css: string, pairs: readonly ContrastPair[] = CONTRAST_PAIRS): string[] {
  return measure(css, pairs).filter((m) => m.ratio === null || m.ratio < m.min).map((m) => {
    const where = `${m.fg} on ${m.on}${m.over ? ` over ${m.over}` : ''}`;
    return m.ratio === null
      ? `${m.theme}: ${where} cannot be read as colours (${m.use})`
      : `${m.theme}: ${where} is ${m.ratio.toFixed(2)}:1, under ${m.min} (${m.use})`;
  });
}
