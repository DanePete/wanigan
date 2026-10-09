// Fieldnotes' pictures: landscapes for the field journal.

import { landscape, svg, topoMap, flatlay } from './draw.mjs';

const FIELDNOTES_SCENES = [
  { name: 'birch-trail', w: 1600, h: 1000, o: { sky: 'day', horizon: 0.5, birches: 26, trail: true, trailColor: '#cdb48a', trees: false } },
  { name: 'weather-front', w: 1600, h: 1000, o: { sky: 'storm', horizon: 0.62, clouds: 7, cloudColor: '#56616a', cloudOpacity: 0.9, rain: 220, treeCount: 8, treeFrom: 0.7, treeTo: 1 } },
  { name: 'river-crossing', w: 1600, h: 1000, o: { sky: 'day', water: true, horizon: 0.5, waterAt: 0.04, clouds: 3, birds: [0.7, 0.2] } },
  { name: 'night-sky', w: 1600, h: 1000, o: { sky: 'night', horizon: 0.66, stars: 320, milkyWay: true, tent: [0.3, 0.9, 1], tentColor: '#c4512d', sunX: 0.85, sunR: 0.035 } },
  { name: 'marsh-fog', w: 1600, h: 1000, o: { sky: 'dawn', water: true, horizon: 0.55, mist: 0.9, reeds: 120, birds: [0.25, 0.3] } },
  { name: 'first-snow', w: 1600, h: 1000, o: { sky: 'winter', horizon: 0.55, snow: true, snowcaps: true, snowfall: 240, treeCount: 30 } },
  { name: 'ridge-sunrise', w: 1600, h: 1000, o: { sky: 'dawn', horizon: 0.6, sunY: 0.7, sunR: 0.1, clouds: 2, cloudColor: '#ffe4cf', trees: true } },
  { name: 'lake-ice', w: 1600, h: 1000, o: { sky: 'winter', water: true, ice: true, horizon: 0.5, snow: true, palette: { water: ['#dfe9f0', '#f4f8fb'] } } },
  { name: 'autumn-trail', w: 1600, h: 1000, o: { sky: 'autumn', horizon: 0.55, trail: true, birds: [0.3, 0.2], clouds: 2 } },
  { name: 'dusk-paddle', w: 1600, h: 1000, o: { sky: 'dusk', water: true, horizon: 0.55, canoe: [0.55, 0.8, 1.3], canoeColor: '#2f3d2a' } },
  { name: 'meadow-rain', w: 1600, h: 1000, o: { sky: 'storm', horizon: 0.6, rain: 160, reeds: 90, reedColor: '#6b7a3a', trees: true, treeCount: 12 } },
  { name: 'header-ridge', w: 2400, h: 700, o: { sky: 'dawn', horizon: 0.62, sunX: 0.8, sunR: 0.07, birds: [0.25, 0.3], mist: 0.5 } },
];

/** Every picture this site needs: [file name, () => SVG text]. */
export function jobs() {
  const out = [];
  for (const s of FIELDNOTES_SCENES) out.push([`${s.name}.jpg`, () => landscape(s.w, s.h, { name: s.name, ...s.o })]);
  out.push(['gear-flatlay.jpg', () => flatlay(1600, 1000, 'gear-flatlay')]);
  out.push(['trail-map.jpg', () => svg(1600, 1000, topoMap(1600, 1000, 'trail-map'))]);
  return out;
}
