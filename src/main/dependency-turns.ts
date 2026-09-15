import { runGit } from './git';
import { listCheckpoints } from './checkpoints';
import { shellCommands } from './shell-results';
import { readManifest, type DepChange, type DepEntry, type ManifestKind, type ManifestRead } from '../shared/dependencies';
import { attributeDependencyChanges, type DepTurnAttribution, type ManifestPoint } from '../shared/dependency-turns';

/**
 * The git half of "which turn added this package": each manifest the review
 * found changed, read at every per-turn checkpoint the session captured.
 *
 * Checkpoints are commits under refs/wanigan/checkpoints/<session>, so a
 * reading is `git ls-tree` for the blob a snapshot holds at the manifest's
 * path and `git cat-file` for the bytes. Both run in the session's own
 * checkout with argv arrays through git.ts, so `ls-tree` resolves the path
 * against the checkout's place in its repository exactly as the review's
 * `git diff --relative` did. Nothing is written. One `ls-tree` per distinct
 * snapshot covers every manifest at once, and a blob is parsed once however
 * many snapshots share it — a session of forty turns that touched package.json
 * twice reads it three times, not eighty.
 */

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const OBJECT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** Snapshot reads run a few at a time; a long session must not start a hundred gits at once. */
const PARALLEL = 6;

/** Parsed blobs by object id and reader. An object id names its bytes forever, so this never goes stale. */
const blobReads = new Map<string, ManifestRead>();
const BLOB_CACHE_MAX = 400;

export type ManifestForTurns = {
  path: string;
  kind: ManifestKind;
  base: DepEntry[];
  now: DepEntry[];
  changes: DepChange[];
};

type Snapshot = { blobs: Map<string, string> } | { unreadable: string };

async function inBatches<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += PARALLEL) out.push(...await Promise.all(items.slice(i, i + PARALLEL).map(fn)));
  return out;
}

/** Which blob each manifest path holds in one snapshot. A path absent from the snapshot is absent from the map. */
async function snapshotBlobs(root: string, commit: string, paths: readonly string[]): Promise<Snapshot> {
  if (!OBJECT.test(commit)) return { unreadable: 'the snapshot has no commit id' };
  const r = await runGit(root, ['ls-tree', '-z', commit, '--', ...paths], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (!r.ok) return { unreadable: `git could not read the snapshot: ${r.err.split('\n')[0] || 'ls-tree failed'}` };
  const blobs = new Map<string, string>();
  for (const row of r.out.split('\0')) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(row);
    if (m) blobs.set(m[2], m[1]);
  }
  return { blobs };
}

async function readBlob(root: string, oid: string, kind: ManifestKind): Promise<ManifestRead> {
  const key = `${oid}:${kind}`;
  const hit = blobReads.get(key);
  if (hit) return hit;
  const size = await runGit(root, ['cat-file', '-s', oid], { timeout: 8_000, maxBuffer: 1024 });
  const bytes = size.ok ? Number(size.out.trim()) : NaN;
  let read: ManifestRead;
  if (!Number.isFinite(bytes)) read = { ok: false, reason: 'git could not read this version of the file' };
  else if (bytes > MAX_MANIFEST_BYTES) read = { ok: false, reason: `this version is over ${MAX_MANIFEST_BYTES / 1024 / 1024} MB` };
  else {
    const blob = await runGit(root, ['cat-file', 'blob', oid], { timeout: 15_000, maxBuffer: MAX_MANIFEST_BYTES + 1024 });
    read = blob.ok ? readManifest(kind, blob.out) : { ok: false, reason: 'git could not read this version of the file' };
  }
  if (blobReads.size >= BLOB_CACHE_MAX) blobReads.delete(blobReads.keys().next().value as string);
  blobReads.set(key, read);
  return read;
}

/**
 * One attribution per change, per manifest path. A session with no checkpoint
 * gets "no checkpoints recorded" on every row rather than an empty map, so the
 * renderer never has to tell "not computed" from "nothing to say".
 */
export async function dependencyTurnAttributions(input: {
  sessionId: string;
  root: string;
  manifests: readonly ManifestForTurns[];
  hooksRecorded: boolean;
}): Promise<Record<string, DepTurnAttribution[]>> {
  const out: Record<string, DepTurnAttribution[]> = {};
  const wanted = input.manifests.filter((m) => m.changes.length > 0);
  if (!wanted.length) return out;
  // Capture order, not turn order: a restore's pre-revert snapshot belongs where it was taken.
  const rows = listCheckpoints(input.sessionId).filter((r) => r.commitHash && r.status !== 'failed')
    .sort((a, b) => a.at - b.at || a.id - b.id);
  const commits = [...new Set(rows.map((r) => r.commitHash as string))];
  const paths = wanted.map((m) => m.path);
  const snapshots = new Map<string, Snapshot>();
  const read = await inBatches(commits, (commit) => snapshotBlobs(input.root, commit, paths));
  commits.forEach((commit, i) => snapshots.set(commit, read[i]));

  const commands = input.hooksRecorded
    ? shellCommands(input.sessionId).map((c) => ({ at: c.at, command: c.command, ok: c.ok, exitCode: c.exitCode }))
    : [];

  for (const manifest of wanted) {
    const points: ManifestPoint[] = [{ source: 'base', checkpointId: null, turn: null, kind: null, at: null, entries: manifest.base, unreadable: null }];
    for (const row of rows) {
      const snap = snapshots.get(row.commitHash as string);
      const point: ManifestPoint = { source: 'checkpoint', checkpointId: row.id, turn: row.turn, kind: row.kind, at: row.at, entries: null, unreadable: null };
      if (!snap || 'unreadable' in snap) point.unreadable = snap && 'unreadable' in snap ? snap.unreadable : 'the snapshot was not read';
      else {
        const oid = snap.blobs.get(manifest.path);
        // Absent from the snapshot is an empty manifest, the same rule the
        // review applies to a side of the diff where the file does not exist.
        const parsed = oid ? await readBlob(input.root, oid, manifest.kind) : readManifest(manifest.kind, null);
        if (parsed.ok) point.entries = parsed.entries;
        else point.unreadable = parsed.reason;
      }
      points.push(point);
    }
    points.push({ source: 'working-tree', checkpointId: null, turn: null, kind: null, at: null, entries: manifest.now, unreadable: null });
    out[manifest.path] = attributeDependencyChanges({ changes: manifest.changes, points, commands, hooksRecorded: input.hooksRecorded });
  }
  return out;
}
