import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db } from './db';
import { skillBody } from './skills';
import { computeSkillSurface, surfaceCanonical, surfaceDelta, type SkillFile, type SkillSurface } from '../shared/skill-surface';
import type { SkillSurfaceView } from '../shared/types';

/**
 * The capability lock for skills: compute a skill's surface from its files,
 * store it, and compare it with the surface a person last approved.
 *
 * A path arrives from the renderer, so it is validated the way the reading pane
 * validates it — skillBody refuses anything outside a known skills directory —
 * before a single other file in that directory is read. Reads are bounded by
 * file count, per-file size and total bytes, never follow a symlink out of the
 * skill's directory, and skip binaries; what was skipped is part of the surface.
 *
 * One approval is automatic, and it is narrow: a SKILL.md that Wanigan's own
 * compiler wrote, whose bytes still hash to what was applied, is recorded as
 * approved as projected — its content was approved in the review inbox before
 * it was written. Any growth after that asks like any other skill.
 */

const MAX_FILES = 200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv']);

function readSkillFiles(dir: string): { files: SkillFile[]; skipped: string[] } {
  const files: SkillFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  let realDir: string;
  try { realDir = fs.realpathSync(dir); } catch { return { files, skipped: ['(the skill directory could not be read)'] }; }
  const walk = (abs: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(abs, e.name);
      const rel = path.relative(realDir, full);
      if (e.isSymbolicLink()) { skipped.push(`${rel} (symlink)`); continue; }
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (files.length >= MAX_FILES) { skipped.push(rel); continue; }
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.size > MAX_FILE_BYTES || total + st.size > MAX_TOTAL_BYTES) { skipped.push(rel); continue; }
      let buf: Buffer;
      try { buf = fs.readFileSync(full); } catch { skipped.push(rel); continue; }
      if (buf.includes(0)) { skipped.push(rel); continue; }
      total += st.size;
      files.push({ path: rel, text: buf.toString('utf8') });
    }
  };
  walk(realDir, 0);
  return { files, skipped };
}

function digestOf(surface: SkillSurface): string {
  return createHash('sha256').update(surfaceCanonical(surface)).digest('hex');
}

function projectedHash(skillPath: string): string | null {
  try {
    const row = db().prepare(`SELECT applied_hash FROM knowledge_projections
      WHERE target_path = ? AND status = 'applied' AND target_format IN ('claude-skill', 'agent-skill')
      ORDER BY applied_at DESC LIMIT 1`).get(skillPath) as { applied_hash: string | null } | undefined;
    return row?.applied_hash ?? null;
  } catch { return null; }
}

type Row = { skill_path: string; digest: string; surface_json: string; computed_at: number; approved_digest: string | null; approved_surface_json: string | null; approved_at: number | null };

function parseSurface(json: string | null): SkillSurface | null {
  if (!json) return null;
  try { return JSON.parse(json) as SkillSurface; } catch { return null; }
}

/** Compute, store and compare one skill's surface. Throws for a path outside every skills directory. */
export function skillSurface(skillPath: string): SkillSurfaceView {
  const body = skillBody(skillPath);
  const real = fs.realpathSync(skillPath);
  const { files, skipped } = readSkillFiles(path.dirname(real));
  const surface = computeSkillSurface(files, skipped);
  const digest = digestOf(surface);
  const now = Date.now();
  const name = path.basename(path.dirname(real));
  db().prepare(`INSERT INTO skill_surfaces (skill_path, name, digest, surface_json, computed_at) VALUES (?,?,?,?,?)
    ON CONFLICT(skill_path) DO UPDATE SET name=excluded.name, digest=excluded.digest, surface_json=excluded.surface_json, computed_at=excluded.computed_at`)
    .run(skillPath, name, digest, JSON.stringify(surface), now);
  let row = db().prepare('SELECT * FROM skill_surfaces WHERE skill_path = ?').get(skillPath) as Row;

  let how: 'person' | 'projected' = 'person';
  if (!row.approved_digest) {
    const applied = projectedHash(skillPath);
    const mdHash = createHash('sha256').update(body.text).digest('hex');
    if (applied && !body.truncated && applied === mdHash) {
      db().prepare("UPDATE skill_surfaces SET approved_digest = ?, approved_surface_json = ?, approved_at = ? WHERE skill_path = ?")
        .run(digest, JSON.stringify({ ...surface, approvedAs: 'projected' }), now, skillPath);
      row = db().prepare('SELECT * FROM skill_surfaces WHERE skill_path = ?').get(skillPath) as Row;
    }
  }
  const approvedSurface = parseSurface(row.approved_surface_json);
  if ((approvedSurface as (SkillSurface & { approvedAs?: string }) | null)?.approvedAs === 'projected') how = 'projected';
  return {
    skillPath,
    digest,
    computedAt: now,
    surface,
    approved: row.approved_digest && row.approved_at ? { digest: row.approved_digest, at: row.approved_at, how } : null,
    delta: surfaceDelta(approvedSurface, surface),
  };
}

/**
 * Record that a person approved the surface they were shown. The digest must be
 * the one computed now: a skill that changed between showing and clicking is
 * shown again rather than approved unseen.
 */
export function approveSkillSurface(skillPath: string, digest: string): SkillSurfaceView {
  const current = skillSurface(skillPath);
  if (typeof digest !== 'string' || digest !== current.digest) {
    throw new Error('This skill changed after its surface was shown, so it was not approved. Read the new surface and approve it again.');
  }
  db().prepare('UPDATE skill_surfaces SET approved_digest = ?, approved_surface_json = ?, approved_at = ? WHERE skill_path = ?')
    .run(current.digest, JSON.stringify(current.surface), Date.now(), skillPath);
  return skillSurface(skillPath);
}
