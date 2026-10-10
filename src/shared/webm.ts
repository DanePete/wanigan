// A WebM file written from encoded video frames, with no dependency: the live
// view's recordings are encoded by Chromium's own VP8 encoder (WebCodecs, in a
// hidden window of the main process) and put into a Matroska/WebM container
// here. Every frame keeps its own time, so a page that sat still for three
// seconds is one frame shown for three seconds, not fifteen copies of it.
// Plays in Chromium (Wanigan's own review), Chrome, Firefox, Edge and Safari on
// every desktop system. Pure: bytes in, bytes out.
//
// The layout is the one Chromium itself writes, minus what a player does not
// need: EBML header; Segment { SeekHead, Info (1 ms timestamps, Duration),
// Tracks (one video track), Clusters of SimpleBlocks, Cues (one per key frame) }.

export interface WebmChunk {
  /** The encoded frame. */
  data: Uint8Array;
  /** Milliseconds from the start. */
  at: number;
  /** A key frame (a cluster starts here, and a cue points at it). */
  key: boolean;
}

export interface WebmTrack {
  /** Matroska's codec id: V_VP8 or V_VP9. */
  codec: 'V_VP8' | 'V_VP9';
  width: number;
  height: number;
}

const ID = {
  EBML: 0x1a45dfa3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42f7, EBMLMaxIDLength: 0x42f2, EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  Info: 0x1549a966, TimestampScale: 0x2ad7b1, Duration: 0x4489, MuxingApp: 0x4d80, WritingApp: 0x5741,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5, TrackType: 0x83, FlagLacing: 0x9c, CodecID: 0x86,
  Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  Cluster: 0x1f43b675, Timestamp: 0xe7, SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1,
} as const;

/** An element id's own bytes (ids carry their length marker already). */
function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
}

/** A data size as an EBML variable-length integer, as short as it can be (all ones is reserved: "unknown"). */
function sizeBytes(n: number): number[] {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out = new Array<number>(len).fill(0);
      let v = n;
      for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
      out[0] = (out[0] as number) | (0x80 >> (len - 1));
      return out;
    }
  }
  throw new Error('An element too large for WebM.');
}

/** An unsigned integer in as few bytes as hold it; `width` fixes the byte count (a seek position must not change size). */
function uintBytes(n: number, width = 0): number[] {
  const out: number[] = [];
  for (let v = Math.floor(n); v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  if (!out.length) out.push(0);
  while (out.length < width) out.unshift(0);
  return out;
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

function el(id: number, ...children: Uint8Array[]): Uint8Array {
  const data = concat(children);
  return concat([Uint8Array.from([...idBytes(id), ...sizeBytes(data.length)]), data]);
}
const uint = (id: number, n: number, width = 0): Uint8Array => el(id, Uint8Array.from(uintBytes(n, width)));
const text = (id: number, s: string): Uint8Array => el(id, new TextEncoder().encode(s));
function float(id: number, n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n);
  return el(id, b);
}

/** One SimpleBlock: track 1, its time from the cluster's in milliseconds (a signed 16-bit), key or not. */
function simpleBlock(chunk: WebmChunk, clusterAt: number): Uint8Array {
  const head = new Uint8Array(4);
  head[0] = 0x81; // track 1, as a one-byte variable-length integer
  new DataView(head.buffer).setInt16(1, Math.round(chunk.at) - clusterAt);
  head[3] = chunk.key ? 0x80 : 0;
  return el(ID.SimpleBlock, head, chunk.data);
}

/** The longest a cluster may run: a SimpleBlock's time from its cluster's is a signed 16-bit count of milliseconds. */
const CLUSTER_MAX_MS = 30_000;

/**
 * A WebM file of `chunks` (in order, the first a key frame), `durationMs` long (at least to the last frame's time).
 * Throws on chunks it cannot hold: none, a first that is not a key frame, or times that go backwards.
 */
export function webm(track: WebmTrack, chunks: readonly WebmChunk[], durationMs: number): Uint8Array {
  if (!chunks.length) throw new Error('No frames to write.');
  if (!chunks[0]?.key) throw new Error('The first frame must be a key frame.');
  for (let i = 1; i < chunks.length; i++) if ((chunks[i] as WebmChunk).at < (chunks[i - 1] as WebmChunk).at) throw new Error('Frame times go backwards.');
  const last = chunks[chunks.length - 1] as WebmChunk;
  const duration = Math.max(durationMs, last.at + 1);

  const header = el(ID.EBML,
    uint(ID.EBMLVersion, 1), uint(ID.EBMLReadVersion, 1), uint(ID.EBMLMaxIDLength, 4), uint(ID.EBMLMaxSizeLength, 8),
    text(ID.DocType, 'webm'), uint(ID.DocTypeVersion, 4), uint(ID.DocTypeReadVersion, 2));
  const info = el(ID.Info, uint(ID.TimestampScale, 1_000_000), float(ID.Duration, duration), text(ID.MuxingApp, 'Wanigan'), text(ID.WritingApp, 'Wanigan'));
  const tracks = el(ID.Tracks, el(ID.TrackEntry,
    uint(ID.TrackNumber, 1), uint(ID.TrackUID, 1), uint(ID.TrackType, 1), uint(ID.FlagLacing, 0), text(ID.CodecID, track.codec),
    el(ID.Video, uint(ID.PixelWidth, track.width), uint(ID.PixelHeight, track.height))));

  // Clusters: a new one at each key frame, and before a block's time would not fit in 16 bits.
  const clusters: { at: number; key: boolean; bytes: Uint8Array }[] = [];
  let open: { at: number; key: boolean; blocks: Uint8Array[] } | null = null;
  const close = (): void => { if (open) clusters.push({ at: open.at, key: open.key, bytes: el(ID.Cluster, uint(ID.Timestamp, open.at), ...open.blocks) }); };
  for (const c of chunks) {
    const at = Math.round(c.at);
    if (!open || c.key || at - open.at >= CLUSTER_MAX_MS) {
      // A delta frame cannot start a cluster a player seeks to; it may continue one past the 16-bit limit only by
      // starting a new cluster, which a player reads in order, as it does every cluster.
      close();
      open = { at, key: c.key, blocks: [] };
    }
    open.blocks.push(simpleBlock(c, open.at));
  }
  close();

  // Where each part is, from the start of the Segment's data: the SeekHead has a fixed size (8-byte positions).
  const seekEntry = (id: number, position: number): Uint8Array => el(ID.Seek, el(ID.SeekID, Uint8Array.from(idBytes(id))), uint(ID.SeekPosition, position, 8));
  const seekSize = el(ID.SeekHead, seekEntry(ID.Info, 0), seekEntry(ID.Tracks, 0), seekEntry(ID.Cues, 0)).length;
  const infoAt = seekSize;
  const tracksAt = infoAt + info.length;
  let at = tracksAt + tracks.length;
  const cuePoints: Uint8Array[] = [];
  for (const cluster of clusters) {
    // Only clusters that start on a key frame are places to seek to.
    if (cluster.key) {
      cuePoints.push(el(ID.CuePoint, uint(ID.CueTime, cluster.at), el(ID.CueTrackPositions, uint(ID.CueTrack, 1), uint(ID.CueClusterPosition, at))));
    }
    at += cluster.bytes.length;
  }
  const cues = el(ID.Cues, ...cuePoints);
  const seekHead = el(ID.SeekHead, seekEntry(ID.Info, infoAt), seekEntry(ID.Tracks, tracksAt), seekEntry(ID.Cues, at));
  const segment = el(ID.Segment, seekHead, info, tracks, ...clusters.map((c) => c.bytes), cues);
  return concat([header, segment]);
}

/* ── reading one back: for the tests, and to check a file before it is kept ── */

export interface WebmElement { id: number; start: number; size: number; data: Uint8Array }

/** The elements at one level of `bytes`, in order. */
export function webmChildren(bytes: Uint8Array): WebmElement[] {
  const out: WebmElement[] = [];
  let i = 0;
  const vint = (keepMarker: boolean): number => {
    const first = bytes[i] as number;
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    if (len > 8) throw new Error('Not EBML.');
    let v = keepMarker ? first : first & (0xff >> len);
    for (let k = 1; k < len; k++) v = v * 256 + (bytes[i + k] as number);
    i += len;
    return v;
  };
  while (i < bytes.length) {
    const start = i;
    const id = vint(true);
    const size = vint(false);
    if (i + size > bytes.length) throw new Error('An element runs past the end.');
    out.push({ id, start, size, data: bytes.subarray(i, i + size) });
    i += size;
  }
  return out;
}

export const WEBM_IDS = ID;
