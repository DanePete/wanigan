import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from './db';
import type { Project } from '../shared/types';

const exec = promisify(execFile);

/**
 * The project list is shared: a PTY agent session and a batch run both target a
 * repo, and there is exactly one list of repos.
 */
export function listProjects(): Project[] {
  const rows = db().prepare('SELECT * FROM projects ORDER BY name').all() as {
    id: string; path: string; name: string; branch: string | null; added_at: number;
  }[];
  const live = rows.filter((r) => fs.existsSync(r.path));
  if (live.length !== rows.length) {
    const gone = rows.filter((r) => !fs.existsSync(r.path)).map((r) => r.id);
    const stmt = db().prepare('DELETE FROM projects WHERE id = ?');
    for (const id of gone) stmt.run(id);
  }
  return live.map((r) => ({ id: r.id, path: r.path, name: r.name, branch: r.branch, addedAt: r.added_at }));
}

export async function addProject(dir: string): Promise<Project> {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error(`No such directory: ${abs}`);
  const existing = db().prepare('SELECT * FROM projects WHERE path = ?').get(abs) as { id: string } | undefined;
  if (existing) return listProjects().find((p) => p.id === existing.id)!;

  const project: Project = {
    id: `prj_${Math.random().toString(36).slice(2, 10)}`,
    path: abs,
    name: path.basename(abs),
    branch: await gitBranch(abs),
    addedAt: Date.now(),
  };
  db().prepare('INSERT INTO projects (id, path, name, branch, added_at) VALUES (?,?,?,?,?)')
    .run(project.id, project.path, project.name, project.branch, project.addedAt);
  return project;
}

export function removeProject(id: string) {
  db().prepare('DELETE FROM projects WHERE id = ?').run(id);
}

export function projectById(id: string): Project | undefined {
  return listProjects().find((p) => p.id === id);
}

export async function gitBranch(dir: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 4000 });
    const b = stdout.trim();
    return b && b !== 'HEAD' ? b : null;
  } catch { return null; }
}

export async function refreshBranches(): Promise<Project[]> {
  const projects = listProjects();
  const stmt = db().prepare('UPDATE projects SET branch = ? WHERE id = ?');
  await Promise.all(projects.map(async (p) => {
    p.branch = await gitBranch(p.path);
    stmt.run(p.branch, p.id);
  }));
  return projects;
}
