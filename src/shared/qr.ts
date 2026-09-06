/**
 * A QR encoder: byte mode, error-correction level M, versions 1 through 10.
 *
 * It exists because pairing a second device by hand means retyping a URL with
 * a long random token in it, and a mistyped token does not read as a typo — it
 * reads as a pairing that failed. A camera does not mistype.
 *
 * It is written out rather than installed. Wanigan ships three runtime
 * dependencies deliberately, and a QR symbol is a closed, fully specified
 * algorithm with published test vectors, so the offline smoke suite can hold
 * this to account in a way it could never hold a transitive dependency tree.
 * Level M recovers roughly 15 % of a damaged symbol, which is the usual choice
 * for a screen-to-camera scan, and version 10 carries 213 bytes — far more
 * than a pairing URL needs.
 *
 * Everything here is pure: no DOM, no Electron, no clock. It lives in
 * src/shared/ so the main process can render one and the smoke suite can
 * import it directly, the way shared/palette.ts is imported by smoke10.
 *
 * Section numbers below refer to ISO/IEC 18004. Where a table is transcribed
 * rather than derived, it is marked as such: a transcription error is the one
 * failure mode that produces a symbol which looks right and does not scan.
 */

/* ── the published tables ────────────────────────────────────────────────── */

/**
 * Per version, at level M: error-correction codewords per block, and the block
 * groups as [block count, data codewords in each]. Transcribed from the
 * standard's block table. Versions 8 to 10 carry two groups whose blocks
 * differ in length by one codeword, which is what makes the interleaving below
 * bother with a ragged loop.
 */
const BLOCKS: { ec: number; groups: [number, number][] }[] = [
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
];

/** Alignment-pattern centre coordinates per version. Version 1 has none. */
const ALIGN: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

const MAX_VERSION = 10;

function dataCodewords(version: number): number {
  return BLOCKS[version - 1].groups.reduce((n, [count, size]) => n + count * size, 0);
}

/**
 * Byte mode spends four bits on the mode indicator and then the length: eight
 * bits up to version 9, sixteen from version 10. That is a boundary the
 * standard draws, not a choice, and getting it wrong shifts every later bit.
 */
function lengthBits(version: number): number {
  return version < 10 ? 8 : 16;
}

function capacity(version: number): number {
  return Math.floor((dataCodewords(version) * 8 - 4 - lengthBits(version)) / 8);
}

/** The most a version-10 symbol at level M carries: 213 bytes of UTF-8. */
export const QR_MAX_BYTES = capacity(MAX_VERSION);

/* ── GF(256) ─────────────────────────────────────────────────────────────── */

/**
 * Reed–Solomon here works over GF(256) with the QR field polynomial
 * x⁸+x⁴+x³+x²+1, which is 0x11d. Multiplication in that field is addition of
 * logarithms, so the two tables turn every multiply into a lookup: EXP[i] is
 * α^i and LOG[x] is the i that produced x. EXP runs to 512 entries — a second
 * copy of the same cycle — so a sum of two logarithms, each at most 254, can
 * be indexed straight without a modulo on the hot path.
 */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  // Doubling in GF(256) is a shift; when it overflows eight bits, the field
  // polynomial folds the overflow back in.
  x = ((x << 1) ^ (x & 0x80 ? 0x11d : 0)) & 0xff;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

/** The generator polynomial for n EC codewords: the product of (x − α^i). */
function generator(n: number): number[] {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];                                               // × x
      next[j + 1] ^= poly[j] === 0 ? 0 : EXP[LOG[poly[j]] + i];         // × α^i
    }
    poly = next;
  }
  return poly;
}

/**
 * The error-correction codewords for one block: the remainder of the data
 * polynomial divided by the generator, by synthetic division in place. The
 * leading coefficient of the generator is 1, so each step just scales the
 * generator by the current leading term and adds it — addition being XOR.
 */
function ecCodewords(data: number[], ecLen: number): number[] {
  const gen = generator(ecLen);
  const rem = data.concat(new Array<number>(ecLen).fill(0));
  for (let i = 0; i < data.length; i++) {
    const lead = rem[i];
    if (lead === 0) continue;
    const scale = LOG[lead];
    for (let j = 0; j < gen.length; j++) {
      rem[i + j] ^= gen[j] === 0 ? 0 : EXP[LOG[gen[j]] + scale];
    }
  }
  return rem.slice(data.length);
}

/* ── message bits ────────────────────────────────────────────────────────── */

/** Mode header, length, payload, terminator and the standard's pad bytes. */
function bitstream(bytes: Uint8Array, version: number): number[] {
  const total = dataCodewords(version);
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4);
  push(bytes.length, lengthBits(version));
  for (const b of bytes) push(b, 8);

  // Terminator: four zero bits, or fewer when the symbol is nearly full.
  for (let i = 0; i < 4 && bits.length < total * 8; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    words.push(byte);
  }
  // Filler alternates 11101100 / 00010001 starting with the first, whatever
  // the message length — the alternation is not a function of position.
  for (let pad = 0; words.length < total; pad++) words.push(pad % 2 === 0 ? 0xec : 0x11);
  return words;
}

/** Split into blocks, add error correction, and interleave. */
function codewords(bytes: Uint8Array, version: number): number[] {
  const spec = BLOCKS[version - 1];
  const data = bitstream(bytes, version);
  const blocks: number[][] = [];
  const checks: number[][] = [];
  let at = 0;
  for (const [count, size] of spec.groups) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(at, at + size);
      at += size;
      blocks.push(block);
      checks.push(ecCodewords(block, spec.ec));
    }
  }

  // Interleaving column-wise is what makes a thumb across the symbol a shallow
  // error spread over every block rather than a fatal one inside a single
  // block. Short blocks simply run out first, hence the length guard.
  const out: number[] = [];
  const widest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < widest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < spec.ec; i++) for (const c of checks) out.push(c[i]);
  return out;
}

/* ── the module grid ─────────────────────────────────────────────────────── */

type Grid = {
  size: number;
  /** Row-major, 1 dark. */
  dark: Uint8Array;
  /** Row-major, 1 where a function pattern or a reserved strip lives, which is
   *  the same thing as "the mask must not touch this and data cannot go here". */
  fixed: Uint8Array;
};

function drawFunctionPatterns(grid: Grid, version: number): void {
  const { size } = grid;
  const put = (r: number, c: number, on: boolean) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    grid.dark[r * size + c] = on ? 1 : 0;
    grid.fixed[r * size + c] = 1;
  };
  const reserve = (r: number, c: number) => { grid.fixed[r * size + c] = 1; };

  // Finder patterns with their separators, stamped as one 9×9 block clipped at
  // the symbol edge. The ring of light around each eye is not decoration: it
  // is what lets a scanner find the eye against whatever the symbol sits on.
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const eye = r >= 0 && r <= 6 && c >= 0 && c <= 6
          && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        put(r0 + r, c0 + c, eye);
      }
    }
  }

  // Timing patterns: the alternating ruler along row 6 and column 6 that lets
  // a scanner count module positions across a symbol photographed at an angle.
  for (let i = 8; i < size - 8; i++) {
    put(6, i, i % 2 === 0);
    put(i, 6, i % 2 === 0);
  }

  // Alignment patterns at every pair of centres except the three that would
  // land on a finder.
  const centres = ALIGN[version - 1];
  const last = centres[centres.length - 1];
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          // Dark ring, light ring, dark centre — dark where the Chebyshev
          // distance from the centre is 0 or 2.
          put(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // The module the standard fixes dark, and the format strips. The format bits
  // are written only once a mask is chosen, but the strips have to be off
  // limits to the data run now or the payload would be laid over them.
  put(size - 8, 8, true);
  for (let i = 0; i <= 8; i++) { reserve(8, i); reserve(i, 8); }
  for (let i = size - 8; i < size; i++) { reserve(8, i); reserve(i, 8); }

  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      reserve(b, a);
      reserve(a, b);
    }
  }
}

/**
 * Lay the interleaved codewords in the standard's zigzag: two columns at a
 * time from the right edge leftwards, alternating up and down, skipping every
 * module already claimed by a function pattern.
 */
function drawData(grid: Grid, words: number[]): void {
  const { size } = grid;
  const total = words.length * 8;
  let bit = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing ruler. Stepping over it rather than
    // through it keeps the remaining column pairs aligned to (5,4), (3,2)…
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (grid.fixed[r * size + c]) continue;
        // Past the last codeword sit the version's remainder bits, which the
        // standard leaves light.
        grid.dark[r * size + c] = bit < total ? (words[bit >> 3] >> (7 - (bit & 7))) & 1 : 0;
        bit++;
      }
    }
    upward = !upward;
  }
}

/** The eight mask conditions, by pattern number. True means invert. */
function maskAt(pattern: number, r: number, c: number): boolean {
  switch (pattern) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

/** XOR the mask over the data modules. Applying it twice undoes it. */
function applyMask(grid: Grid, pattern: number): void {
  const { size } = grid;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const i = r * size + c;
      if (!grid.fixed[i] && maskAt(pattern, r, c)) grid.dark[i] ^= 1;
    }
  }
}

/**
 * Format information: level M (00) and the mask number, protected by a
 * BCH(15,5) code and then XORed with 101010000010010 so that an all-zero
 * format — level M with mask 0 — is not an all-light strip.
 */
function formatBits(mask: number): number {
  const data = mask; // level M is 00 in the two high bits, so the value is the mask
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

/** Version information for versions 7 and up: 6 bits under a BCH(18,6) code. */
function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | (rem & 0xfff);
}

/**
 * Both copies of the format strip. Bit 0 is the least significant. Copy one
 * runs down column 8 and then left along row 8 around the top-left eye; copy
 * two is split, its low bits running right to left along row 8 beside the
 * top-right eye and its high bits down column 8 beside the bottom-left one.
 */
function drawFormat(grid: Grid, mask: number): void {
  const { size } = grid;
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const on = (bits >> i) & 1;
    if (i < 6) grid.dark[i * size + 8] = on;
    else if (i === 6) grid.dark[7 * size + 8] = on;
    else if (i === 7) grid.dark[8 * size + 8] = on;
    else if (i === 8) grid.dark[8 * size + 7] = on;
    else grid.dark[8 * size + (14 - i)] = on;

    if (i < 8) grid.dark[8 * size + (size - 1 - i)] = on;
    else grid.dark[(size - 15 + i) * size + 8] = on;
  }
}

/** Both copies of the version block: a 6×3 corner and its mirror image. */
function drawVersion(grid: Grid, version: number): void {
  if (version < 7) return;
  const { size } = grid;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const on = (bits >> i) & 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    grid.dark[b * size + a] = on;
    grid.dark[a * size + b] = on;
  }
}

/** The 1:1:1:3:1:1 run a finder makes, plus the four light modules beside it. */
const FINDER_RUN = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];

/**
 * The four penalty rules, summed. They exist to pick the mask that makes the
 * symbol least confusing to a scanner, so each one prices a specific way of
 * being confusing: a long straight run reads as an edge, a solid block starves
 * the scanner of the alternation it counts by, a finder-shaped run in the data
 * sends it hunting in the wrong place, and a symbol that is mostly one colour
 * has little contrast left for a camera to threshold.
 */
function penalty(grid: Grid): number {
  const { size, dark } = grid;
  const at = (r: number, c: number) => dark[r * size + c];
  let score = 0;

  // Rule 1 — five or more same-colour modules in a line cost 3, plus 1 for
  // every module past the fifth.
  for (let i = 0; i < size; i++) {
    for (const line of [(j: number) => at(i, j), (j: number) => at(j, i)]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (line(j) === line(j - 1)) { run++; continue; }
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2 — every 2×2 block of one colour costs 3. Overlapping blocks each
  // count, so a large solid field is priced by its area, not its perimeter.
  for (let r = 0; r + 1 < size; r++) {
    for (let c = 0; c + 1 < size; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  // Rule 3 — a finder-shaped run with four light modules on either side costs
  // 40, in rows and in columns, in both directions.
  const finderLike = (get: (j: number) => number): number => {
    let hits = 0;
    for (let j = 0; j + 11 <= size; j++) {
      let forward = true;
      let backward = true;
      for (let k = 0; k < 11; k++) {
        const v = get(j + k);
        if (v !== FINDER_RUN[k]) forward = false;
        if (v !== FINDER_RUN[10 - k]) backward = false;
      }
      if (forward || backward) hits++;
    }
    return hits * 40;
  };
  for (let i = 0; i < size; i++) {
    score += finderLike((j) => at(i, j));
    score += finderLike((j) => at(j, i));
  }

  // Rule 4 — 10 for every 5 % the dark share strays from half.
  let darkCount = 0;
  for (let i = 0; i < dark.length; i++) darkCount += dark[i];
  score += Math.floor(Math.abs((darkCount * 100) / (size * size) - 50) / 5) * 10;

  return score;
}

/* ── the public surface ──────────────────────────────────────────────────── */

export type QrMatrix = {
  /** 1 through 10. */
  version: number;
  /** Modules per side, quiet zone excluded. Always 4 × version + 17. */
  size: number;
  /** The mask pattern the penalty rules chose, 0 through 7. */
  mask: number;
  /** Row-major, one byte per module: 1 dark, 0 light. */
  modules: Uint8Array;
};

/**
 * Encode text as a QR symbol. Throws rather than degrade: an empty symbol and
 * a truncated URL both scan cleanly and both lie about what they carry, which
 * is worse for the person holding the camera than no code at all.
 *
 * The type guard is deliberate even though TypeScript rules it out. This is
 * shared code, and a value that reached it from the renderer over IPC has only
 * whatever shape the main process already checked.
 */
export function qrMatrix(text: string): QrMatrix {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('QR: refusing to encode an empty string — the scan would carry nothing.');
  }
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (bytes.length <= capacity(v)) { version = v; break; }
  }
  if (version === 0) {
    throw new Error(
      `QR: ${bytes.length} bytes does not fit version ${MAX_VERSION} at level M, `
      + `which carries ${QR_MAX_BYTES}.`);
  }

  const size = version * 4 + 17;
  const grid: Grid = { size, dark: new Uint8Array(size * size), fixed: new Uint8Array(size * size) };
  drawFunctionPatterns(grid, version);
  drawVersion(grid, version);
  drawData(grid, codewords(bytes, version));

  // Score all eight masks against the same grid, undoing each before the next.
  // The format strip has to be written for each candidate: it is part of the
  // symbol the penalty rules are judging.
  let mask = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let m = 0; m < 8; m++) {
    applyMask(grid, m);
    drawFormat(grid, m);
    const score = penalty(grid);
    if (score < best) { best = score; mask = m; }
    applyMask(grid, m);
  }
  applyMask(grid, mask);
  drawFormat(grid, mask);

  return { version, size, mask, modules: grid.dark };
}

/**
 * The same symbol as an SVG element: one path of horizontal runs over a light
 * plate, in a viewBox, so the caller sizes it in CSS.
 *
 * The two colours are literal and stay literal. A QR code must be dark on
 * light to scan reliably, so this must not follow the theme; a symbol that
 * inverts in dark mode is one a good many readers quietly refuse. The default
 * margin is the four-module quiet zone the standard requires — pass a smaller
 * one only if the surrounding layout supplies that clearance itself.
 *
 * No caller text reaches the output, so the string is safe to inject as
 * markup. It is also marked aria-hidden: a QR code is unusable to anyone who
 * cannot point a camera at it, and reading a pairing token aloud helps nobody.
 * Show the URL as selectable text beside it.
 */
export function qrSvg(text: string, opts?: { margin?: number }): string {
  const margin = opts?.margin ?? 4;
  if (!Number.isInteger(margin) || margin < 0 || margin > 16) {
    throw new Error(`QR: margin must be a whole number of modules from 0 to 16, not ${String(margin)}.`);
  }

  const { size, modules } = qrMatrix(text);
  const side = size + margin * 2;

  // One subpath per horizontal run of dark modules. Runs rather than one
  // rectangle per module keeps the path an order of magnitude shorter, and
  // every subpath is wound the same way so the default fill rule never punches
  // a hole where two rectangles touch.
  let d = '';
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!modules[r * size + c]) { c++; continue; }
      let len = 1;
      while (c + len < size && modules[r * size + c + len]) len++;
      d += `M${c + margin} ${r + margin}h${len}v1h-${len}z`;
      c += len;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" `
    + 'shape-rendering="crispEdges" aria-hidden="true">'
    + `<rect width="${side}" height="${side}" fill="#ffffff"/>`
    + `<path fill="#000000" d="${d}"/></svg>`;
}
