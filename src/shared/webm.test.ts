import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WEBM_IDS as ID, webm, webmChildren, type WebmChunk } from './webm.ts';

const one = (list: ReturnType<typeof webmChildren>, id: number) => {
  const found = list.find((e) => e.id === id);
  assert.ok(found, `no element ${id.toString(16)}`);
  return found;
};
const uintOf = (b: Uint8Array): number => b.reduce((n, x) => n * 256 + x, 0);

test('a WebM file holds every frame at its own time, key frames start clusters, and cues point at them', () => {
  const chunk = (at: number, key: boolean, n: number): WebmChunk => ({ at, key, data: Uint8Array.from({ length: n }, (_, i) => (i + at) % 251) });
  // A page that sat still for three seconds is one frame held for three seconds.
  const chunks = [chunk(0, true, 300), chunk(200, false, 40), chunk(400, false, 40), chunk(3_400, false, 40), chunk(5_000, true, 280), chunk(5_200, false, 30)];
  const file = webm({ codec: 'V_VP8', width: 640, height: 400 }, chunks, 6_000);
  const top = webmChildren(file);
  assert.deepEqual(top.map((e) => e.id), [ID.EBML, ID.Segment]);
  const header = webmChildren(one(top, ID.EBML).data);
  assert.equal(new TextDecoder().decode(one(header, ID.DocType).data), 'webm');
  const segment = one(top, ID.Segment);
  const parts = webmChildren(segment.data);
  assert.deepEqual(parts.map((e) => e.id), [ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cluster, ID.Cues]);

  const info = webmChildren(one(parts, ID.Info).data);
  assert.equal(uintOf(one(info, ID.TimestampScale).data), 1_000_000, 'milliseconds');
  const duration = one(info, ID.Duration).data;
  assert.equal(new DataView(duration.buffer, duration.byteOffset, 8).getFloat64(0), 6_000);
  const entry = webmChildren(one(webmChildren(one(parts, ID.Tracks).data), ID.TrackEntry).data);
  assert.equal(new TextDecoder().decode(one(entry, ID.CodecID).data), 'V_VP8');
  const video = webmChildren(one(entry, ID.Video).data);
  assert.deepEqual([uintOf(one(video, ID.PixelWidth).data), uintOf(one(video, ID.PixelHeight).data)], [640, 400]);

  // Every frame, in order, at its own time, with its bytes, and key where it was key.
  const blocks: { at: number; key: boolean; data: Uint8Array }[] = [];
  for (const cluster of parts.filter((p) => p.id === ID.Cluster)) {
    const inside = webmChildren(cluster.data);
    const base = uintOf(one(inside, ID.Timestamp).data);
    for (const b of inside.filter((e) => e.id === ID.SimpleBlock)) {
      assert.equal(b.data[0], 0x81, 'track 1');
      const view = new DataView(b.data.buffer, b.data.byteOffset);
      blocks.push({ at: base + view.getInt16(1), key: (b.data[3] as number) === 0x80, data: b.data.subarray(4) });
    }
  }
  assert.deepEqual(blocks.map((b) => [b.at, b.key, b.data.length]), chunks.map((c) => [c.at, c.key, c.data.length]));
  assert.deepEqual([...(blocks[3] as { data: Uint8Array }).data], [...(chunks[3] as WebmChunk).data]);

  // The seek head points at Info, Tracks and Cues; each cue at a cluster that begins with a key frame.
  const seeks = webmChildren(one(parts, ID.SeekHead).data).map((s) => webmChildren(s.data));
  const offsetOf = (id: number): number => (parts.find((p) => p.id === id) as { start: number }).start;
  for (const s of seeks) {
    const id = uintOf(one(s, ID.SeekID).data);
    assert.equal(uintOf(one(s, ID.SeekPosition).data), offsetOf(id), `seek to ${id.toString(16)}`);
  }
  const cues = webmChildren(one(parts, ID.Cues).data).map((c) => webmChildren(c.data));
  const clusters = parts.filter((p) => p.id === ID.Cluster);
  assert.deepEqual(cues.map((c) => uintOf(one(c, ID.CueTime).data)), [0, 5_000]);
  assert.deepEqual(cues.map((c) => uintOf(one(webmChildren(one(c, ID.CueTrackPositions).data), ID.CueClusterPosition).data)), clusters.map((c) => c.start));
});

test('a long still stretch starts a new cluster rather than overflow a block’s 16-bit time', () => {
  const file = webm({ codec: 'V_VP8', width: 2, height: 2 }, [{ at: 0, key: true, data: new Uint8Array(4) }, { at: 70_000, key: false, data: new Uint8Array(4) }], 80_000);
  const parts = webmChildren(webmChildren(file).find((e) => e.id === ID.Segment)!.data);
  assert.equal(parts.filter((p) => p.id === ID.Cluster).length, 2);
  assert.throws(() => webm({ codec: 'V_VP8', width: 2, height: 2 }, [{ at: 0, key: false, data: new Uint8Array(1) }], 10), /key frame/);
  assert.throws(() => webm({ codec: 'V_VP8', width: 2, height: 2 }, [], 10), /No frames/);
});
