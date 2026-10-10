// Drawing a snap: the picture, its blurs, then the marks over it. The same
// drawing is what the owner sees while marking it up and what is kept, so what
// is sent is exactly what was seen. The blur is shared/live-snap.ts pixelate():
// the pixels under it are replaced in the drawing itself, before anything is
// kept or sent; the picture as taken is never kept anywhere.
import { blurBlock, type Rect, type SnapMark } from '@shared/live-snap';
import { pixelate } from '@shared/live-snap';
import { tokenColor } from '../../lib/live';

export interface SnapColors { mark: string; ink: string }

/** The marks' colours, from Wanigan's own tokens: water for a mark, its ink for the line that keeps it readable on any page. */
export function snapColors(): SnapColors {
  return { mark: tokenColor('water') ?? '#63b3e4', ink: tokenColor('water-ink') ?? '#06131c' };
}

const rgba = (hex: string, alpha: number): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};

/**
 * Draw `crop` of `image` at its own pixels into `g` (sized to the crop), its blurs applied, then its marks.
 * `scale` is image pixels per CSS pixel, so a line is as thick on a Retina picture as on any other.
 */
export function drawSnap(g: CanvasRenderingContext2D, image: CanvasImageSource, crop: Rect, marks: readonly SnapMark[], scale: number, colors: SnapColors): void {
  const w = Math.round(crop.width);
  const h = Math.round(crop.height);
  g.clearRect(0, 0, w, h);
  g.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, w, h);
  for (const m of marks) {
    if (m.tool !== 'blur') continue;
    const x = Math.max(0, Math.floor(m.x)); const y = Math.max(0, Math.floor(m.y));
    const bw = Math.min(w - x, Math.ceil(m.width)); const bh = Math.min(h - y, Math.ceil(m.height));
    if (bw < 1 || bh < 1) continue;
    const px = g.getImageData(x, y, bw, bh);
    pixelate(px.data, bw, bh, { x: 0, y: 0, width: bw, height: bh }, blurBlock(m, scale));
    g.putImageData(px, x, y);
  }
  const line = Math.max(2, Math.round(3 * scale));
  for (const m of marks) {
    if (m.tool === 'highlight') {
      g.fillStyle = rgba(colors.mark, 0.3);
      g.fillRect(m.x, m.y, m.width, m.height);
    } else if (m.tool === 'box') {
      // A dark line under the colour: it reads on a light page and a dark one.
      g.lineWidth = line + Math.max(2, Math.round(scale * 2));
      g.strokeStyle = rgba(colors.ink, 0.55);
      g.strokeRect(m.x, m.y, m.width, m.height);
      g.lineWidth = line;
      g.strokeStyle = colors.mark;
      g.strokeRect(m.x, m.y, m.width, m.height);
    } else if (m.tool === 'arrow') {
      const angle = Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
      const head = Math.max(10 * scale, line * 4);
      const path = (): void => {
        g.beginPath();
        g.moveTo(m.x1, m.y1);
        g.lineTo(m.x2, m.y2);
        g.moveTo(m.x2, m.y2);
        g.lineTo(m.x2 - head * Math.cos(angle - Math.PI / 7), m.y2 - head * Math.sin(angle - Math.PI / 7));
        g.moveTo(m.x2, m.y2);
        g.lineTo(m.x2 - head * Math.cos(angle + Math.PI / 7), m.y2 - head * Math.sin(angle + Math.PI / 7));
      };
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.lineWidth = line + Math.max(2, Math.round(scale * 2));
      g.strokeStyle = rgba(colors.ink, 0.55);
      path();
      g.stroke();
      g.lineWidth = line;
      g.strokeStyle = colors.mark;
      path();
      g.stroke();
    } else if (m.tool === 'text' && m.text) {
      const size = Math.round(14 * scale);
      g.font = `600 ${size}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
      const pad = Math.round(5 * scale);
      const tw = g.measureText(m.text).width;
      g.fillStyle = colors.mark;
      g.fillRect(m.x, m.y - size - pad, tw + pad * 2, size + pad * 2);
      g.fillStyle = colors.ink;
      g.textBaseline = 'alphabetic';
      g.fillText(m.text, m.x + pad, m.y - Math.round(pad / 2));
    }
  }
}

/** The snap as kept: drawn whole, then PNG (or JPEG when a PNG would be too large to attach), as base64. */
export function flatten(image: CanvasImageSource, crop: Rect, marks: readonly SnapMark[], scale: number, colors: SnapColors): string {
  // A whole page at the screen's scale can be enormous: at most about 12 million pixels are kept.
  const most = 12_000_000;
  const shrink = Math.min(1, Math.sqrt(most / Math.max(1, crop.width * crop.height)));
  const c = document.createElement('canvas');
  c.width = Math.round(crop.width);
  c.height = Math.round(crop.height);
  const g = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  drawSnap(g, image, crop, marks, scale, colors);
  let out = c;
  if (shrink < 1) {
    out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(c.width * shrink));
    out.height = Math.max(1, Math.round(c.height * shrink));
    (out.getContext('2d') as CanvasRenderingContext2D).drawImage(c, 0, 0, out.width, out.height);
  }
  const png = out.toDataURL('image/png').split(',')[1] ?? '';
  // An attachment may be 20 MB; base64 is a third larger than the file.
  return png.length < 18 * 1024 * 1024 ? png : out.toDataURL('image/jpeg', 0.9).split(',')[1] ?? '';
}
