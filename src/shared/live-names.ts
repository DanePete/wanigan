// What to call each part of a live page, read from what the site itself wrote:
// Drupal's theme hook and template file name suggestions, a component's id,
// the helpers' marks. Pure, so the window and the tests read it the same way.
// Nothing here guesses past the markup: a name it cannot read stays the
// template's own file name.
import type { LiveRegion } from './live.ts';

/** Whose code a template is: the owner's, a contributed project's, or Drupal core's. */
export type LiveOrigin = 'yours' | 'contrib' | 'core';

export type LiveKind = 'component' | 'content' | 'field' | 'block' | 'region' | 'view' | 'menu' | 'form' | 'media' | 'page' | 'template' | 'element';

export interface PartName {
  title: string;
  /** What kind of thing it is, in a few words ("Block", "Field on node"). */
  kind: string;
  icon: LiveKind;
  origin: LiveOrigin | null;
  /** The page itself, its document and wrappers: structure, not a part anyone edits as such. */
  wrapper: boolean;
  /** Small pieces inside a part (an icon, an image, a form field): listed under it, folded away. */
  small: boolean;
}

/** An entity the page shows, as far as the markup says. */
interface LiveEntity {
  type: string;
  id: string | null;
  bundle: string | null;
  viewMode: string | null;
}

const WRAPPERS = new Set(['html', 'page', 'off_canvas_page_wrapper', 'maintenance_page', 'wanigan_live_piece']);
const FORM = /^(form|form_element|form_element_label|input|input__\w+|select|textarea|container|fieldset|details|radios|checkboxes|actions)$/;
const MEDIA = /^(image|image_style|image_formatter|responsive_image|responsive_image_formatter|\w+_image_style|\w*icon\w*|svg_image_field\w*|file_link|media_oembed_iframe)$/;
const ENTITY_HOOKS = new Set(['node', 'taxonomy_term', 'paragraph', 'media', 'block_content', 'user', 'comment', 'commerce_product',
  'commerce_product_variation', 'commerce_store', 'group', 'profile', 'eck_entity', 'storage', 'contact_message', 'site_settings']);

const human = (machine: string): string => {
  const words = machine.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : machine;
};
const machine = (suggestionPart: string): string => suggestionPart.replace(/-/g, '_');
const base = (file: string): string => (file.split('/').pop() ?? file).replace(/\.html\.twig$|\.twig$|\.php$/, '');

/** A "Product | Full" style name, read the way the rest of Wanigan writes it. */
const tidyName = (name: string): string => name.replace(/\s*\|\s*/g, ' · ');

/** Whose a file is, by where it sits: contrib and core are someone else's to change. */
export function originOf(path: string | null): LiveOrigin | null {
  if (!path) return null;
  const p = `/${path.replace(/^\.?\/+/, '')}`;
  if (/^\/core\/|\/wp-includes\/|\/wp-admin\//.test(p)) return 'core';
  if (/\/(?:contrib|vendor|node_modules)\/|\/wp-content\/plugins\//.test(p)) return 'contrib';
  // A WordPress theme may be the owner's, or the parent theme theirs is a child of: the path cannot say which.
  if (/\/wp-content\/themes\//.test(p)) return null;
  return 'yours';
}

/** The suggestions of a region that begin with its hook, split into their parts after the hook. */
function tails(r: LiveRegion, hook: string): string[][] {
  const prefix = `${hook.replace(/_/g, '-')}--`;
  return r.suggestions.filter((s) => s.startsWith(prefix)).map((s) => s.slice(prefix.length).split('--'));
}

/** The entity a region renders: the helper's mark, else what Drupal's suggestions spell out. */
export function entityOf(r: LiveRegion): LiveEntity | null {
  if (r.entity) {
    const [type, bundle, id, viewMode] = r.entity.split(':');
    if (type) return { type, bundle: bundle || null, id: id || null, viewMode: viewMode || null };
  }
  const hook = r.hook?.split('__')[0] ?? null;
  if (!hook || !ENTITY_HOOKS.has(hook)) return null;
  const found: LiveEntity = { type: hook, id: null, bundle: null, viewMode: null };
  for (const parts of tails(r, hook)) {
    const [first, second] = parts;
    if (!first) continue;
    if (/^\d+$/.test(first)) { found.id ??= first; if (second) found.viewMode ??= machine(second); }
    else if (parts.length >= 2) { found.bundle ??= machine(first); found.viewMode ??= machine(second as string); }
  }
  // A lone `paragraph--hero` is a bundle when no longer suggestion said otherwise.
  if (!found.bundle) {
    const lone = tails(r, hook).find((p) => p.length === 1 && !/^\d+$/.test(p[0] as string));
    if (lone) found.bundle = machine(lone[0] as string);
  }
  return found;
}

/** A field a region renders: `field--{entity type}--{field}--{bundle}`, the most specific suggestion core writes. */
export function fieldOf(r: LiveRegion): { entityType: string; field: string; bundle: string | null } | null {
  if (r.field) {
    const [entityType, , field] = r.field.split(':');
    if (entityType && field) return { entityType, field, bundle: null };
  }
  if (r.hook?.split('__')[0] !== 'field') return null;
  const full = tails(r, 'field').find((p) => p.length === 3);
  if (full) return { entityType: machine(full[0] as string), field: machine(full[1] as string), bundle: machine(full[2] as string) };
  return null;
}

/** The icon for each kind of part the site helper reports. */
const PART_ICON: Record<string, LiveKind> = {
  template: 'template', component: 'component', block: 'block', entity: 'content', field: 'field', view: 'view', region: 'region',
  form: 'form', shortcode: 'element', pattern: 'component', menu: 'menu', widget: 'block',
};

/**
 * What to call a region, from what made it. `componentName` is the component's
 * own name, when the site has it on disk; `part` is the site helper's label and
 * kind for it, from the page's trace, used when the markup says nothing else.
 */
export function nameOf(r: LiveRegion, componentName?: string | null, part?: { label: string; kind: string } | null): PartName {
  const origin = originOf(r.file);
  const only = !r.component && !r.element && !r.view && !r.block && !r.entity && !r.field && !r.file && !r.hook;
  if (only && part) {
    return { title: part.label, kind: `${human(part.kind)} · from the trace`, icon: PART_ICON[part.kind] ?? 'template', origin: null, wrapper: false, small: false };
  }
  if (r.component) {
    const [provider, id] = r.component.split(':');
    return { title: tidyName(componentName ?? human(id ?? r.component)), kind: `Component · ${provider}`, icon: 'component', origin, wrapper: false, small: false };
  }
  if (r.element) {
    const [what] = r.element.split('#');
    const [type, widget] = (what ?? '').split(':');
    return { title: human(widget ?? type ?? 'Element'), kind: `Elementor ${type ?? 'element'}`, icon: 'element', origin: null, wrapper: false, small: false };
  }
  if (r.view) {
    const [id, display] = r.view.split(':');
    return { title: human(id ?? r.view), kind: display ? `View · ${display}` : 'View', icon: 'view', origin, wrapper: false, small: false };
  }
  // A WordPress block: core/paragraph, acf/hero, core/template-part:header.
  if (r.block && /^[a-z0-9-]+\/[a-z0-9-]+/.test(r.block) && !r.block.includes('@')) {
    const [name, part] = r.block.split(':');
    const [ns, block] = (name ?? '').split('/');
    if (part) return { title: `${human(part)} part`, kind: 'Template part', icon: 'region', origin: null, wrapper: false, small: false };
    return { title: human(block ?? name ?? 'Block'), kind: `Block · ${ns}`, icon: 'block', origin: null, wrapper: false, small: false };
  }
  const hook = r.hook ?? '';
  const root = hook.split('__')[0] ?? hook;
  const entity = entityOf(r);
  if (entity) {
    const what = entity.bundle ? human(entity.bundle) : human(entity.type);
    const title = entity.id ? `${what} ${entity.id}` : what;
    const kind = [human(entity.type), entity.viewMode ? `${entity.viewMode.replace(/_/g, ' ')} view` : null].filter(Boolean).join(' · ');
    return { title, kind, icon: 'content', origin, wrapper: false, small: false };
  }
  const field = fieldOf(r);
  if (field || root === 'field') {
    const title = field ? human(field.field.replace(/^field_/, '')) : 'Field';
    const kind = field ? `Field ${field.field} on ${field.entityType.replace(/_/g, ' ')}${field.bundle ? ` (${field.bundle})` : ''}` : 'Field';
    return { title, kind, icon: 'field', origin, wrapper: false, small: false };
  }
  if (r.block || root === 'block') {
    const id = r.block?.split('@')[1] ?? tails(r, 'block')[0]?.join('_') ?? (r.file ? base(r.file).replace(/^block--?/, '') : '');
    const plugin = r.block?.split('@')[0];
    return { title: human(machine(id) || plugin || 'Block'), kind: plugin ? `Block · ${plugin}` : 'Block', icon: 'block', origin, wrapper: false, small: false };
  }
  if (root === 'region') {
    const name = tails(r, 'region')[0]?.[0] ?? (r.file ? base(r.file).replace(/^region--?/, '') : '');
    return { title: `${human(machine(name) || 'Page')} region`, kind: 'Region', icon: 'region', origin, wrapper: false, small: false };
  }
  if (root === 'menu' || root === 'menu_local_tasks' || root === 'links') {
    const name = hook.split('__')[1] ?? tails(r, 'menu')[0]?.[0] ?? '';
    return { title: name ? `${human(machine(name))} menu` : human(root), kind: 'Menu', icon: 'menu', origin, wrapper: false, small: false };
  }
  if (root.startsWith('views_')) {
    const id = tails(r, 'views-view')[0]?.[0] ?? tails(r, root)[0]?.[0];
    return { title: id ? human(machine(id)) : 'View', kind: id ? 'View' : `View · ${hook}`, icon: 'view', origin, wrapper: false, small: false };
  }
  if (WRAPPERS.has(root)) {
    const front = r.suggestions.includes('page--front');
    return { title: root === 'html' ? 'Document' : root === 'page' ? (front ? 'Front page' : 'Page') : human(root), kind: 'Page', icon: 'page', origin, wrapper: true, small: false };
  }
  if (FORM.test(root)) return { title: human(root.replace(/^input__/, '')), kind: 'Form', icon: 'form', origin, wrapper: false, small: true };
  if (MEDIA.test(root)) return { title: /icon/.test(root) ? 'Icon' : 'Image', kind: human(root), icon: 'media', origin, wrapper: false, small: true };
  // A theme's own component folder, as Drupal's SDC and many WordPress themes keep them: components/<name>/<name>.php.
  const folder = r.file ? /\/components\/([^/]+)\/\1\.(?:php|twig|html\.twig)$/.exec(r.file) : null;
  if (folder) return { title: human(folder[1] as string), kind: 'Component · template', icon: 'component', origin, wrapper: false, small: false };
  if (r.file) return { title: human(base(r.file)), kind: hook ? `Template · ${hook}` : 'Template', icon: 'template', origin, wrapper: false, small: false };
  if (r.entity === null && r.piece) return { title: human(r.piece.split('/')[0] ?? 'Part'), kind: 'Part', icon: 'template', origin: null, wrapper: false, small: false };
  return { title: 'A part of the page', kind: '', icon: 'template', origin: null, wrapper: false, small: false };
}

/**
 * Where to change a region in the site's own admin, as a path on the site:
 * an entity's edit form, a block's settings, a view, a menu, the block
 * layout. Null when the markup does not say enough to know.
 */
export function editPath(r: LiveRegion): string | null {
  const entity = entityOf(r);
  if (entity?.id) {
    const id = encodeURIComponent(entity.id);
    switch (entity.type) {
      case 'node': return `/node/${id}/edit`;
      case 'taxonomy_term': return `/taxonomy/term/${id}/edit`;
      case 'media': return `/media/${id}/edit`;
      case 'user': return `/user/${id}/edit`;
      case 'comment': return `/comment/${id}/edit`;
      case 'block_content': return `/admin/content/block/${id}`;
      case 'commerce_product': return `/product/${id}/edit`;
      case 'post': return `/wp-admin/post.php?post=${id}&action=edit`;
      default: return null;
    }
  }
  if (r.view) {
    const [id, display] = r.view.split(':');
    return id ? `/admin/structure/views/view/${encodeURIComponent(id)}${display ? `/edit/${encodeURIComponent(display)}` : ''}` : null;
  }
  const root = r.hook?.split('__')[0] ?? '';
  if (r.block || root === 'block') {
    const id = r.block?.split('@')[1] ?? (tails(r, 'block')[0]?.length === 1 ? machine(tails(r, 'block')[0]![0]!) : null);
    return id && /^[a-z0-9_]+$/.test(id) ? `/admin/structure/block/manage/${id}` : null;
  }
  if (root === 'region') return '/admin/structure/block';
  if (root === 'menu') {
    const name = r.hook?.split('__')[1];
    return name && /^[a-z0-9_]+$/.test(name) ? `/admin/structure/menu/manage/${name.replace(/_/g, '-')}` : null;
  }
  return null;
}

/**
 * The template files that would change this region and fewer others, most
 * specific first: the suggestions Drupal checked before the one it used. Each
 * is a file name to create in the owner's theme (a copy of the one in use).
 */
export function overrides(r: LiveRegion): string[] {
  if (!r.file || !r.suggestions.length) return [];
  const used = base(r.file);
  const at = r.suggestions.indexOf(used);
  return (at < 0 ? r.suggestions : r.suggestions.slice(0, at)).map((s) => `${s}.html.twig`);
}

/**
 * The owner's own theme, as the page shows it: the folder (up to its
 * templates/) that most of the page's own templates come from. Null when the
 * page has none of the owner's templates.
 */
export function themeOf(regions: readonly LiveRegion[]): string | null {
  const counts = new Map<string, number>();
  for (const r of regions) {
    if (!r.file || originOf(r.file) !== 'yours') continue;
    const m = /^(.*?\/)templates\//.exec(r.file) ?? /^(themes\/(?:custom\/)?[^/]+\/)/.exec(r.file);
    if (m?.[1]?.startsWith('themes/')) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [dir, n] of counts) if (!best || n > (counts.get(best) ?? 0)) best = dir;
  return best;
}

/** Where an override of a region would go in the owner's theme: the same folder below templates/ as the file in use. */
export function overrideDir(r: LiveRegion, theme: string): string {
  const sub = r.file ? /\/templates\/(.*\/)?[^/]+$/.exec(r.file)?.[1] ?? '' : '';
  return `${theme}templates/${sub}`;
}
