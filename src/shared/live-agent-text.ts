// What an agent reads back from the live view's tools: plain words a model can
// act on, and the same as data. Pure, so the tests read exactly what an agent
// will. Paths are the project's own (the core passes `where` to turn a
// template the site names into one); nothing here invents a name the page did
// not give.
import type { LiveComponent, LivePlatform, LiveProblem, LiveRegion } from './live.ts';
import { editPath, entityOf, nameOf, originOf, overrideDir, overrides, themeOf, type LiveOrigin } from './live-names.ts';
import { ancestors, kindKey, layersOf, type Layer } from './live-tree.ts';
import { diffSummary } from './live-diff.ts';
import {
  findParts, partIds, type ExplainedArea, type LiveDiffAnswer, type LiveProblemsAnswer, type LiveRendered, type LiveSource,
  type LiveStatusAnswer, type TimedProblem,
} from './live-agent.ts';

/** What the core knows that the page does not say. */
export interface TextContext {
  site: string;
  platform: LivePlatform | null;
  /** A template as the site names it, as a path in the project (relative to its folder). */
  where: (file: string) => string;
  /** An absolute path on this Mac, relative to the project when it is inside it. */
  local: (path: string) => string;
  component: (id: string) => LiveComponent | null;
}

const ORIGIN: Record<LiveOrigin, string> = { yours: 'your code', contrib: 'a contributed project’s', core: 'core’s' };
const MAX_LINES = 140;

/** The path of an address on the site, as an agent would type it back. */
export function pathOf(url: string | null): string | null {
  if (!url) return null;
  try { const u = new URL(url); return `${u.pathname}${u.search}`; } catch { return null; }
}

const quote = (text: string, max = 60): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t ? `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”` : '';
};
const at = (r: { x: number; y: number; width: number; height: number }): string => `${r.x},${r.y} ${r.width}×${r.height}`;
const sourceSaid: Record<LiveSource, string> = {
  view: 'the page the owner is looking at',
  card: 'the card’s page (the owner’s view is not on this project)',
  site: 'the site’s own address (the owner’s view is not on this project)',
  asked: 'as asked',
};

/** "/about at 375 px" */
export const pageAt = (url: string, width: number): string => `${pathOf(url) ?? url} at ${width} px`;

/* ── live_status ───────────────────────────────────────────────────────── */

export function statusText(input: {
  site: { url: string | null; platform: LivePlatform | null; helper: boolean };
  cardPage: string | null;
  app: LiveStatusAnswer | null;
}): { text: string; structured: Record<string, unknown> } {
  const { site, app } = input;
  const kind = site.platform === 'drupal' ? 'Drupal' : site.platform === 'wordpress' ? 'WordPress' : 'other';
  const view = app?.view ?? null;
  const state = !site.url ? 'no site' : !app ? 'app not running' : !app.on ? 'off' : !app.onForSite ? `off for ${kind} sites` : 'on';
  const lines: string[] = [];
  if (!site.url) {
    lines.push('No local site is set for this project, so there is no live view to read. The owner chooses the site in the project’s Live tab.');
  } else {
    lines.push(`Site: ${site.url} (${kind === 'other' ? 'a site' : kind}). Only this site’s own pages are ever opened.`);
    if (!app) lines.push('Wanigan’s app is not running (or not connected to its core), so the live view cannot be read now.');
    else if (!app.on) lines.push('The live view is off: the owner switches it on in Settings › Live view.');
    else if (!app.onForSite) lines.push(`The live view is off for ${kind === 'other' ? 'other' : kind} sites in Settings › Live view.`);
    else {
      lines.push('The live view is on.');
      lines.push(app.window ? 'Wanigan’s window is open.' : 'Wanigan’s window is closed; pages are still rendered in a hidden window.');
      if (view?.showing && view.url) {
        lines.push(`The owner’s view shows ${pathOf(view.url)}${view.title ? ` (${quote(view.title, 80)})` : ''}${view.width ? ` at ${view.width} px wide` : ''}${view.visible ? '' : ', in a tab not in front now'}${view.loading ? ', still loading' : ''}.`);
      } else {
        lines.push('The owner’s view is not on this project now; tools read the card’s page, or the site’s address.');
      }
      lines.push(site.helper ? 'The site helper is installed: parts are named exactly.'
        : site.platform === 'drupal' ? 'No site helper: parts are named from Twig debug comments and component ids, which need Twig debug on.' : 'No site helper is installed.');
      lines.push(`Screenshots before and after each turn: ${app.shots ? 'on (live_diff can compare)' : 'off (live_diff has nothing to compare with)'}.`);
    }
    if (input.cardPage) lines.push(`This card’s page: ${pathOf(input.cardPage)}.`);
  }
  return {
    text: lines.join('\n'),
    structured: {
      liveView: state,
      site: site.url ? { url: site.url, platform: site.platform, helper: site.helper } : null,
      window: app?.window ?? null,
      view: view?.showing ? { path: pathOf(view.url), title: view.title, width: view.width, visible: view.visible, loading: view.loading } : null,
      cardPage: pathOf(input.cardPage),
      screenshots: app ? app.shots : null,
    },
  };
}

/* ── live_look ─────────────────────────────────────────────────────────── */

interface PartRow { id: string; title: string; kind: string; file: string | null; component: string | null; origin: LiveOrigin | null; depth: number; rect: LiveRegion['rect']; count: number; ids?: string[] }

/** One line for a part: its name and kind, what made it, a few of its words, its id and where it is. */
function partLine(layer: Layer, id: string, text: string, ctx: TextContext, depth: number, all: string[]): string {
  const r = layer.region;
  const name = nameOf(r, r.component ? ctx.component(r.component)?.name ?? null : null);
  const made = r.file ? `${ctx.where(r.file)}${originOf(r.file) ? ` (${ORIGIN[originOf(r.file) as LiveOrigin]})` : ''}` : r.component ?? r.block ?? r.view ?? r.element ?? r.entity ?? '';
  const many = layer.regions.length > 1;
  const ids = many ? `ids ${all.slice(0, 4).join(', ')}${all.length > 4 ? ', …' : ''}` : `id ${id}`;
  return `${'  '.repeat(depth)}- ${name.title}${many ? ` ×${layer.regions.length}` : ''} · ${name.kind || 'Part'}${made ? ` · ${made}` : ''}${text ? ` · ${quote(text, 50)}` : ''} · ${ids} · ${many ? 'first at ' : 'at '}${at(r.rect)}`;
}

export function lookText(page: LiveRendered, ctx: TextContext, options: { all?: boolean } = {}): { text: string; structured: Record<string, unknown> } {
  const ids = partIds(page.regions);
  const layers = layersOf(page.regions, { all: options.all, componentName: (id) => ctx.component(id)?.name ?? null });
  const lines: string[] = [];
  const rows: PartRow[] = [];
  let shown = 0;
  let total = 0;
  const walk = (list: Layer[], depth: number): void => {
    for (const layer of list) {
      total += layer.regions.length;
      const all = layer.regions.map((r) => ids.get(r.index) ?? '');
      if (lines.length < MAX_LINES) {
        const id = ids.get(layer.region.index) ?? '';
        lines.push(partLine(layer, id, page.texts[String(layer.region.index)] ?? '', ctx, depth, all));
        const name = nameOf(layer.region, layer.region.component ? ctx.component(layer.region.component)?.name ?? null : null);
        rows.push({
          id, title: name.title, kind: name.kind, file: layer.region.file ? ctx.where(layer.region.file) : null, component: layer.region.component,
          origin: originOf(layer.region.file), depth, rect: layer.region.rect, count: layer.regions.length, ...(layer.regions.length > 1 ? { ids: all.slice(0, 50) } : {}),
        });
        shown += layer.regions.length;
      }
      // A run of one kind lists the first one's parts: the rest are made the same way.
      const inside = layer.regions.length > 1 ? layer.children[0]?.children ?? [] : layer.children;
      walk(inside, depth + 1);
    }
  };
  walk(layers, 0);
  const named = page.regions.filter((r) => !nameOf(r).wrapper).length;
  const head = [
    `${pageAt(page.url, page.width)}${page.title ? ` — ${quote(page.title, 80)}` : ''} (${sourceSaid[page.source]}). ${page.height.toLocaleString('en-US')} px tall.`,
  ];
  if (!page.regions.length) {
    head.push(ctx.platform === 'drupal'
      ? 'The page names none of its parts: Twig debug is off, or this is not a Drupal page. The owner can install the site helper from the Live tab, which turns Twig debug on.'
      : ctx.platform === 'wordpress' ? 'The page names none of its parts: the site helper is not installed, or this page is not WordPress’s.'
        : 'This site does not name its parts (only Drupal’s Twig debug, Drupal and WordPress with the site helper, and Elementor do).');
  } else {
    head.push('Its parts, named as the site names them. Ids work with live_part, and with live_look part=…:');
  }
  const out = [...head, ...lines];
  if (total > shown) out.push(`… and ${total - shown} more parts. live_find searches all of them.`);
  if (!options.all && page.regions.length) {
    const small = page.regions.filter((r) => nameOf(r).small).length;
    if (small) out.push(`${small} small pieces (icons, images, form fields) are folded away: pass all: true to list them.`);
  }
  if (page.image) out.push(imageSaid(page));
  else if (page.partFound === false) out.push('That part is not on this page now (an id is the same on the next load only while the page still has that part).');
  return {
    text: out.join('\n'),
    structured: { url: page.url, path: pathOf(page.url), title: page.title, width: page.width, height: page.height, source: page.source, parts: rows, partsOnPage: named, image: !!page.image },
  };
}

function imageSaid(page: LiveRendered): string {
  const i = page.image;
  if (!i) return '';
  return `The picture shows ${at(i.rect)} of the page (CSS px), ${i.width}×${i.height} pixels${i.cut ? '; the page goes on below it' : ''}.`;
}

/* ── live_find ─────────────────────────────────────────────────────────── */

export function findText(page: LiveRendered, query: string, ctx: TextContext): { text: string; structured: Record<string, unknown> } {
  const found = findParts(page.regions, page.texts, query, (id) => ctx.component(id)?.name ?? null);
  const where = pageAt(page.url, page.width);
  if (!found.length) {
    const named = page.regions.filter((r) => !nameOf(r).wrapper).length;
    return {
      text: `Nothing on ${where} matches ${quote(query, 80)}. ${named ? `The page has ${named} named parts; live_look lists them.` : 'The page names none of its parts.'}`,
      structured: { url: page.url, path: pathOf(page.url), width: page.width, query, parts: [] },
    };
  }
  const lines = [`${found.length === 1 ? 'One part' : `${found.length} parts`} on ${where} ${found.length === 1 ? 'matches' : 'match'} ${quote(query, 80)}${found.length >= 20 ? ' (the first 20)' : ''}:`];
  const parts = found.map((f) => {
    const crumbs = ancestors(page.regions, f.region.index).filter((r) => !nameOf(r).wrapper).reverse().map((r) => nameOf(r, r.component ? ctx.component(r.component)?.name ?? null : null).title);
    const made = f.region.file ? ctx.where(f.region.file) : f.region.component ?? null;
    lines.push(`- ${f.name.title} · ${f.name.kind || 'Part'}${made ? ` · ${made}` : ''} · id ${f.id} · at ${at(f.region.rect)}${crumbs.length ? ` · in ${crumbs.join(' › ')}` : ''}${f.text ? `\n  words: ${quote(f.text, 120)}` : ''}`);
    return { id: f.id, title: f.name.title, kind: f.name.kind, file: made, matched: f.by, rect: f.region.rect, path: crumbs, text: f.text.slice(0, 120) };
  });
  return { text: lines.join('\n'), structured: { url: page.url, path: pathOf(page.url), width: page.width, query, parts } };
}

/* ── live_part ─────────────────────────────────────────────────────────── */

export function partText(page: LiveRendered, id: string, ctx: TextContext, options: { helper: boolean }): { text: string; structured: Record<string, unknown> } | null {
  const ids = partIds(page.regions);
  const index = [...ids].find(([, pid]) => pid === id)?.[0];
  const r = index === undefined ? null : page.regions.find((x) => x.index === index) ?? null;
  if (!r) return null;
  const component = r.component ? ctx.component(r.component) : null;
  const name = nameOf(r, component?.name ?? null);
  const chain = [r, ...ancestors(page.regions, r.index)];
  const crumbs = chain.slice(1).filter((x) => !nameOf(x).wrapper).reverse().map((x) => nameOf(x, x.component ? ctx.component(x.component)?.name ?? null : null).title);
  const like = page.regions.filter((x) => kindKey(x) === kindKey(r)).length;
  const origin = originOf(r.file);
  const lines = [`${name.title} (id ${id}) on ${pageAt(page.url, page.width)}`, `Kind: ${name.kind || 'a part of the page'}`];
  lines.push(`Where it sits: ${[...crumbs, name.title].join(' › ')}`);
  lines.push(`At ${at(r.rect)} (CSS px of the page).${like > 1 ? ` One of ${like} like it on this page: changing what made it changes them all.` : ''}`);
  const made: Record<string, unknown> = {};
  if (r.file) {
    const file = ctx.where(r.file);
    lines.push(`Made by: ${file}${origin ? `, ${ORIGIN[origin]}` : ''}${r.hook ? ` (theme hook ${r.hook})` : ''}.`);
    made.template = file;
    made.origin = origin;
    made.hook = r.hook;
  }
  if (component) {
    const props = component.props.map((p) => `${p.name} (${p.type}${p.required ? ', required' : ''})`).join(', ');
    lines.push(`Component ${component.id}${component.name !== component.id ? ` (“${component.name}”)` : ''}: ${ctx.local(component.dir)}/ with ${component.files.join(', ')}${props ? `; props: ${props}` : ''}.`);
    made.component = { id: component.id, name: component.name, folder: ctx.local(component.dir), files: component.files, props: component.props };
  } else if (r.component) {
    lines.push(`Component ${r.component} (its folder is not in this project).`);
    made.component = { id: r.component };
  }
  for (const [label, value] of [['Content', r.entity], ['Block', r.block], ['View', r.view], ['Elementor element', r.element], ['Field', r.field]] as const) {
    if (value) lines.push(`${label}: ${value}`);
  }
  if (!r.file && !r.component && !r.entity && !r.block && !r.view && !r.element) lines.push('The page does not say which file made it.');
  const options_ = overrides(r);
  const theme = themeOf(page.regions);
  let override: string[] = [];
  if (r.file && origin && origin !== 'yours' && options_.length && theme) {
    override = options_.slice(0, 3).map((f) => ctx.where(`${overrideDir(r, theme)}${f}`));
    lines.push(`This template is ${origin === 'core' ? 'Drupal core’s' : 'a contributed project’s'}: an edit there is lost on the next update. To change it for this site, copy it into the theme as ${override[0]} (only parts exactly like this one)${override.length > 1 ? `, or ${override.slice(1).join(' or ')} (more parts)` : ''}, then clear Drupal’s cache.`);
  }
  const admin = chain.map((x) => editPath(x)).find((p) => p) ?? null;
  const entity = chain.map((x) => entityOf(x)).find((e) => e?.id) ?? null;
  if (entity) lines.push(`It shows ${entity.type.replace(/_/g, ' ')} ${entity.id}${entity.bundle ? ` (${entity.bundle.replace(/_/g, ' ')})` : ''}${entity.viewMode ? `, ${entity.viewMode.replace(/_/g, ' ')} view` : ''}.`);
  const adminUrl = admin ? new URL(admin, ctx.site).toString() : null;
  if (adminUrl) lines.push(`Where to change it in the site’s admin: ${adminUrl}`);
  if (r.piece && options.helper) lines.push(`The site helper can show it alone (piece ${r.piece}); the owner opens that from the Inspector.`);
  const words = page.texts[String(r.index)] ?? '';
  if (words) lines.push(`Words: ${quote(words, 200)}`);
  if (page.style) {
    const keep = Object.entries(page.style).filter(([, v]) => v && v !== 'normal' && v !== 'none' && v !== 'auto' && v !== '0px');
    if (keep.length) lines.push(`Computed style: ${keep.map(([k, v]) => `${k} ${v}`).join('; ')}`);
  }
  if (page.image) lines.push(imageSaid(page));
  return {
    text: lines.join('\n'),
    structured: {
      id, url: page.url, path: pathOf(page.url), width: page.width, title: name.title, kind: name.kind, breadcrumb: crumbs, rect: r.rect, alike: like,
      made, overrides: override, entity, admin: adminUrl, words: words.slice(0, 200), style: page.style, image: !!page.image,
    },
  };
}

/* ── live_problems ─────────────────────────────────────────────────────── */

const problemLine = (p: LiveProblem): string => `- ${p.level === 'error' ? 'Error' : 'Warning'} (${p.source === 'page' ? 'on the page' : p.source === 'network' ? 'request' : 'console'}): ${p.text}`;

export function problemsText(answer: LiveProblemsAnswer, since: number | null): { text: string; structured: Record<string, unknown> } {
  const where = pageAt(answer.url, answer.width);
  const lines = [answer.page.length
    ? `${where}, loaded fresh just now: ${answer.page.length === 1 ? 'one problem' : `${answer.page.length} problems`}.`
    : `${where}, loaded fresh just now: no error or warning messages on the page, nothing logged as an error in its console, no failed requests.`];
  lines.push(...answer.page.map(problemLine));
  const view = answer.view === null ? null : answer.view.filter((p) => since === null || p.at >= since);
  if (view === null) lines.push('The owner’s view is not on this page, so only the fresh load is reported.');
  else if (!view.length) lines.push(`The owner’s view of this page has logged nothing${since !== null ? ' since your turn began' : ' since it loaded'}.`);
  else {
    lines.push(`The owner’s view of this page logged ${since !== null ? 'since your turn began' : 'since it loaded'}:`);
    lines.push(...view.map(problemLine));
  }
  const strip = (p: LiveProblem | TimedProblem) => ({ level: p.level, source: p.source, text: p.text, ...('at' in p ? { at: p.at } : {}) });
  return { text: lines.join('\n'), structured: { url: answer.url, path: pathOf(answer.url), width: answer.width, page: answer.page.map(strip), view: view?.map(strip) ?? null } };
}

/* ── live_diff ─────────────────────────────────────────────────────────── */

export function diffText(answer: LiveDiffAnswer, explained: ExplainedArea[], input: {
  since: 'start' | 'turn'; base: 'before' | 'after'; takenAt: number; now: number; stylesheets: string[]; edited: number; local: (path: string) => string;
}): { text: string; structured: Record<string, unknown>; summary: string } {
  const ago = Math.max(0, Math.round((input.now - input.takenAt) / 60_000));
  const when = ago < 1 ? 'less than a minute ago' : ago === 1 ? 'a minute ago' : ago < 120 ? `${ago} minutes ago` : `${Math.round(ago / 60)} hours ago`;
  const against = input.base === 'before'
    ? `its screenshot from before this session worked (${when})${input.since === 'turn' ? '; no turn of this session has ended with changed files yet, so that is the before' : ''}`
    : `its screenshot from the end of this session’s last turn that changed files (${when})`;
  const lines = [`${pageAt(answer.url, answer.width)}, now, compared with ${against}:`];
  lines.push(`${diffSummary(answer)}.`);
  const name = (f: string): string => input.local(f);
  let explainedCount = 0;
  const areas = explained.map((e, i) => {
    const part = e.parts[0];
    const inPart = part ? ` · in ${part.title} (${part.id})` : '';
    if (e.explainedBy.length) explainedCount++;
    const why = e.explainedBy.length
      ? `explained by ${e.explainedBy.map(name).join(', ')}, which this session edited`
      : `not explained by any template or component this session edited${input.stylesheets.length ? ` (it edited ${input.stylesheets.length === 1 ? 'a stylesheet' : `${input.stylesheets.length} stylesheets`}, ${input.stylesheets.slice(0, 3).map(name).join(', ')}, which may)` : ''}`;
    lines.push(`${i + 1}. ${at(e.area)} · ${e.area.pixels.toLocaleString('en-US')} px differ${inPart} · ${why}`);
    return { rect: { x: e.area.x, y: e.area.y, width: e.area.width, height: e.area.height }, pixels: e.area.pixels, parts: e.parts, explainedBy: e.explainedBy.map(name) };
  });
  if (answer.heights.before && answer.heights.after && answer.heights.before !== answer.heights.after) {
    lines.push(`The page is ${answer.heights.after.toLocaleString('en-US')} px tall now; it was ${answer.heights.before.toLocaleString('en-US')} px. Everything below a change in height can shift, and shows as changed.`);
  }
  if (!input.edited) lines.push('This session has edited no files in the time compared.');
  const n = explained.length;
  const files = [...new Set(explained.flatMap((e) => e.explainedBy))].map((f) => f.split('/').pop() ?? f);
  const summary = !n ? 'nothing changed'
    : `${n === 1 ? '1 area' : `${n} areas`} changed${explainedCount === n ? `, ${n === 1 ? '' : n === 2 ? 'both ' : 'all '}explained by ${files.slice(0, 2).join(', ')}${files.length > 2 ? '…' : ''}`
      : explainedCount ? `, ${explainedCount} explained by ${files.slice(0, 2).join(', ')}, ${n - explainedCount} not explained` : ', none explained by an edited file'}`;
  return {
    text: lines.join('\n'),
    summary: summary.replace(/, {2}/g, ', '),
    structured: {
      url: answer.url, path: pathOf(answer.url), width: answer.width, since: input.since, comparedWith: input.base, takenAt: input.takenAt,
      pixels: answer.pixels, total: answer.total, areas, heights: answer.heights,
    },
  };
}
