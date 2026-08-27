import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Project } from '../shared/types';

const exec = promisify(execFile);

type Data = { projects: Project[] };

function file(): string {
  return path.join(app.getPath('userData'), 'foreman.json');
}

function read(): Data {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')) as Data; }
  catch { return { projects: [] }; }
}

function write(d: Data) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(d, null, 2));
}

export function listProjects(): Project[] {
  // Drop anything that has been moved or deleted since it was added, so the
  // sidebar never offers a session that cannot start.
  const d = read();
  const live = d.projects.filter((p) => fs.existsSync(p.path));
  if (live.length !== d.projects.length) write({ projects: live });
  return live;
}

export async function addProject(dir: string): Promise<Project> {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error(`No such directory: ${abs}`);
  const d = read();
  const existing = d.projects.find((p) => p.path === abs);
  if (existing) return existing;

  const project: Project = {
    id: `prj_${Math.random().toString(36).slice(2, 10)}`,
    path: abs,
    name: path.basename(abs),
    branch: await gitBranch(abs),
    addedAt: Date.now(),
  };
  d.projects.push(project);
  write(d);
  return project;
}

export function removeProject(id: string) {
  const d = read();
  write({ projects: d.projects.filter((p) => p.id !== id) });
}

export function projectById(id: string): Project | undefined {
  return read().projects.find((p) => p.id === id);
}

export async function gitBranch(dir: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 4000 });
    const b = stdout.trim();
    return b && b !== 'HEAD' ? b : null;
  } catch { return null; }
}

/** Refresh branch for every project — cheap, and branches move constantly. */
export async function refreshBranches(): Promise<Project[]> {
  const d = read();
  await Promise.all(d.projects.map(async (p) => { p.branch = await gitBranch(p.path); }));
  write(d);
  return d.projects;
}
