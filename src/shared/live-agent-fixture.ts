// A made-up Acme page for the live view's agent tests. Test-only.
import type { LiveRegion } from './live.ts';

export const r = (index: number, parent: number | null, hook: string | null, file: string | null, extra: Partial<LiveRegion> = {}): LiveRegion => ({
  index, parent, hook, file, suggestions: [], component: null, entity: null, block: null, view: null, element: null, piece: null, field: null,
  order: index, rect: { x: 0, y: index * 100, width: 1440, height: 90 }, ...extra,
});

/** A Drupal front page, in small: html › page › header region › branding block; a hero component; three store teasers. */
export function acmePage(): LiveRegion[] {
  return [
    r(0, null, 'html', 'core/modules/system/templates/html.html.twig', { rect: { x: 0, y: 0, width: 1440, height: 3000 } }),
    r(1, 0, 'page', 'themes/custom/acme/templates/layout/page.html.twig', { suggestions: ['page--front', 'page'], rect: { x: 0, y: 0, width: 1440, height: 2990 } }),
    r(2, 1, 'region', 'themes/custom/acme/templates/region/region--header.html.twig', { suggestions: ['region--header', 'region'], rect: { x: 0, y: 0, width: 1440, height: 120 } }),
    r(3, 2, 'block', 'core/modules/system/templates/block--system-branding-block.html.twig',
      { suggestions: ['block--acme-branding', 'block--system-branding-block', 'block--system', 'block'], rect: { x: 20, y: 20, width: 200, height: 80 } }),
    r(4, 1, null, null, { component: 'acme:hero', rect: { x: 0, y: 120, width: 1440, height: 600 } }),
    ...[11, 12, 13].map((id, i) => r(5 + i, 1, 'node', 'themes/custom/acme/templates/content/node--store--teaser.html.twig',
      { suggestions: ['node--store--teaser', `node--${id}`, 'node--store'], entity: `node:store:${id}:teaser`, rect: { x: i * 480, y: 800, width: 460, height: 300 } })),
  ];
}
