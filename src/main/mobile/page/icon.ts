import { crc32, deflateSync } from 'node:zlib';

/**
 * The Home Screen icon, as a PNG, because iOS will not take the SVG.
 *
 * The page has always served an SVG and pointed `apple-touch-icon` at it. Safari
 * ignores an SVG there — it has never supported one — so an operator who added
 * Wanigan Remote to the Home Screen got a thumbnail of the page itself as the
 * icon. That was a cosmetic complaint right up until Web Push landed, because
 * iOS draws the *installed app's icon* on every notification and ignores the
 * `icon` a notification asks for. A screenshot of a fleet table on the lock
 * screen is not recognisable as anything, which makes the alert slower to read
 * than no alert at all is to ignore.
 *
 * Drawn here rather than checked in as a binary for two reasons. The icon is
 * three rectangles on a field, which is less code than a base64 blob is
 * characters; and it is the same three rectangles `dashboardIcon()` draws in
 * SVG, so keeping them in one file means the tab icon and the Home Screen icon
 * cannot drift apart in a way nobody notices until it is on a phone.
 *
 * Deliberately square and full-bleed, with no rounded corners. iOS applies its
 * own mask to a touch icon, and corners drawn here would be rounded twice —
 * the dark ring that produces is the classic sign of an icon made by someone
 * who could not test it on the device.
 */

/** 180×180 is the size iOS asks for on every current phone and iPad. */
export const ICON_SIZE = 180;

/** Where dispatch serves it, and therefore what the manifest and shell name. */
export const MOBILE_ICON_PNG_PATH = '/icon-180.png';

/** The palette `dashboardIcon()` uses, and the 192-unit grid it draws on. */
const GRID = 192;
const GROUND: RGB = [0x11, 0x15, 0x1c];
const PANEL: RGB = [0xe1, 0xa6, 0x51];
const INK: RGB = [0x17, 0x11, 0x0a];

type RGB = [number, number, number];
type Rect = { x: number; y: number; w: number; h: number; fill: RGB };

/** The same shapes as the SVG: a panel, and three lines of text on it. */
const SHAPES: readonly Rect[] = [
  { x: 45, y: 46, w: 102, h: 100, fill: PANEL },
  { x: 61, y: 68, w: 70, h: 16, fill: INK },
  { x: 61, y: 98, w: 70, h: 16, fill: INK },
  { x: 61, y: 128, w: 45, h: 16, fill: INK },
];

function scale(value: number): number {
  return Math.round((value * ICON_SIZE) / GRID);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, checksum]);
}

let cached: Buffer | null = null;

/**
 * The icon's bytes, built once per process.
 *
 * Cached because this is served on a request path and the image never varies:
 * it carries no appearance, no host name and nothing else about this machine,
 * which is also why it is safe to hand to an unauthenticated navigation the way
 * the SVG and the manifest already are.
 */
export function dashboardIconPng(): Buffer {
  if (cached) return cached;

  // One filter byte per row (0 = None) followed by RGB triples. Filtering would
  // shrink a photograph; against four flat rectangles it saves nothing and
  // costs a per-pixel branch on every byte.
  const stride = ICON_SIZE * 3;
  const raw = Buffer.alloc(ICON_SIZE * (stride + 1));
  for (let y = 0; y < ICON_SIZE; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < ICON_SIZE; x++) {
      // Painter's order: the last shape covering a pixel wins, exactly as the
      // SVG's document order decides it.
      let colour = GROUND;
      for (const shape of SHAPES) {
        const left = scale(shape.x);
        const top = scale(shape.y);
        if (x >= left && x < left + scale(shape.w) && y >= top && y < top + scale(shape.h)) {
          colour = shape.fill;
        }
      }
      const at = rowStart + 1 + x * 3;
      raw[at] = colour[0];
      raw[at + 1] = colour[1];
      raw[at + 2] = colour[2];
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(ICON_SIZE, 0);
  header.writeUInt32BE(ICON_SIZE, 4);
  header.writeUInt8(8, 8);   // bit depth
  header.writeUInt8(2, 9);   // colour type: truecolour
  header.writeUInt8(0, 10);  // deflate
  header.writeUInt8(0, 11);  // adaptive filtering
  header.writeUInt8(0, 12);  // no interlace

  cached = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return cached;
}
