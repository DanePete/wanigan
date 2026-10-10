// What the design layer says of an edit's reach, in one wording for the main process (src/main/live-layer.ts, when it
// keys a pick) and the window (src/renderer/src/lib/live-layer.ts, the tray and the Inspector), so the two never say
// the same reach two ways. Pure.
//
// - What `kind` reaches: "every Card component", "the Body field of every article", "the heading in every Card
//   component", and a Drupal block by its plugin and where its instances are placed ("every card inline block placed
//   in a layout", "every main menu block placed in a region", "this reusable block wherever it is placed in a region").
import type { TracePart } from './live-trace.ts';

/**
 * What `kind` reaches for a Drupal block, in words, read from its plugin id for the plugin families core defines (the
 * id is what every instance of the kind shares; a block's label is its own and differs between them), and where its
 * instances are: placed in a region (Block layout) or placed in a layout (Layout Builder). "every card inline block
 * placed in a layout" (`inline_block:card`), "every article body field block …" (`field_block:node:article:body`),
 * "every main menu block …" (`system_menu_block:main`), "every news view block (block_1) …"
 * (`views_block:news-block_1`), "this reusable block wherever it is placed in …" (`block_content:<uuid>`); any other,
 * "every <its id> block …".
 */
function blockKindWords(plugin: string, where: 'a region' | 'a layout'): string {
  const [base, ...rest] = plugin.split(':');
  const derivative = rest.join(':');
  const every = (noun: string): string => `every ${noun} placed in ${where}`;
  if (!derivative) return every(`${plugin} block`);
  switch (base) {
    case 'inline_block': return every(`${derivative} inline block`);
    case 'field_block': case 'extra_field_block': {
      const [, bundle, field] = rest;
      return every(bundle && field && rest.length === 3 ? `${bundle} ${field} ${base === 'field_block' ? 'field ' : ''}block` : `${plugin} block`);
    }
    case 'system_menu_block': return every(`${derivative} menu block`);
    case 'views_block': {
      const at = derivative.lastIndexOf('-');
      return every(at > 0 ? `${derivative.slice(0, at)} view block (${derivative.slice(at + 1)})` : `${plugin} block`);
    }
    // One custom block, shown wherever it is placed.
    case 'block_content': return `this reusable block wherever it is placed in ${where}`;
    default: return every(`${plugin} block`);
  }
}

/**
 * What `kind` reaches, in words: "every Card component", "the Body field of every article", "the heading in every Card
 * component", "every card inline block placed in a layout", "every main menu block placed in a region".
 */
export function kindWords(part: Pick<TracePart, 'label' | 'identity'>, key: string, inner: string | null): string {
  const [kind, a, b] = key.split('|');
  const base = kind === 'field' ? `the ${part.label} field of every ${b}`
    : kind === 'entity' ? `every ${b} ${a}`
      // A block placement's kind and a Layout Builder component's are apart (their kindKeys differ): each says which.
      : kind === 'plugin' && a === 'block' && b ? blockKindWords(b, 'a region')
        : kind === 'plugin' && a === 'layout_builder_component' && b ? blockKindWords(b, 'a layout')
          : kind === 'plugin' ? `every ${b} ${a}`
            : `every ${part.label} ${part.identity?.kind === 'block' ? 'block' : 'component'}`;
  return inner ? `the ${inner.toLowerCase()} in ${base}` : base;
}
