// A QR code drawn as one SVG path: dark squares on a light square with the
// four-module margin scanners expect, in both themes (a camera reads dark on
// light most reliably, so it never inverts).
import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

const MARGIN = 4;

export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) if (qr.isDark(row, col)) d += `M${col + MARGIN} ${row + MARGIN}h1v1h-1z`;
    }
    return { size: n + 2 * MARGIN, path: d };
  }, [text]);

  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect className="qr-paper" width={size} height={size} />
      <path className="qr-ink" d={path} />
    </svg>
  );
}
