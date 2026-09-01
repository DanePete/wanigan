import fs from 'node:fs';
import path from 'node:path';
import { db } from './db';
import { repoState, scopeOf, type RepoState } from './git';
import type { Project } from '../shared/types';

type ProjectRow = { id: string; path: string; name: string; branch: string | null; added_at: number };

const toProject = (r: ProjectRow): Project => ({
  id: r.id, path: r.path, name: r.name, branch: r.branch, addedAt: r.added_at,
});

function rows(): ProjectRow[] {
  return db().prepare('SELECT * FROM projects ORDER BY name').all() as ProjectRow[];
}

/**
 * The project list is shared: a PTY agent session and a batch run both target a
 * repo, and there is exactly one list of repos.
 */
export function listProjects(): Project[] {
  // A directory that is not there right now is not the same thing as a project
  // the user removed. An unmounted external disk, a network share that has not
  // come back after sleep, or a checkout being moved all read as "missing" for
  // a moment — and this is a READ, called on every poll and every window focus.
  // Deleting here also cascaded: work_dockets.project_id is ON DELETE CASCADE
  // (db.ts), so one absent path took the project's whole Control record with
  // it, silently and with no undo. Absent rows are hidden until the path is
  // back; removing a project stays an explicit action (removeProject).
  return rows().filter((r) => fs.existsSync(r.path)).map(toProject);
}

/**
 * A project that is registered but not on disk right now.
 *
 * Hiding those rows is correct — nothing can run in a directory that is not
 * mounted — but hiding them *silently* means a project the operator added is
 * simply not there, with no way to tell that from having imagined adding it.
 * The renderer needs the count to say so; the paths are here so it can say
 * which.
 */
export type UnavailableProject = { id: string; name: string; path: string };

export function unavailableProjects(): UnavailableProject[] {
  return rows().filter((r) => !fs.existsSync(r.path))
    .map((r) => ({ id: r.id, name: r.name, path: r.path }));
}

/** Both halves from one pass, for a caller that is about to render the list. */
export function listProjectsDetailed(): { projects: Project[]; unavailable: UnavailableProject[] } {
  const all = rows();
  const live: Project[] = [];
  const unavailable: UnavailableProject[] = [];
  for (const r of all) {
    if (fs.existsSync(r.path)) live.push(toProject(r));
    else unavailable.push({ id: r.id, name: r.name, path: r.path });
  }
  return { projects: live, unavailable };
}

/**
 * Wanigan projects are whole repositories.
 *
 * git answers for the entire repository from anywhere inside it, so a project
 * registered at `monorepo/packages/web` gave every git surface the whole
 * monorepo: its dirty files listed under one package's name, and a Discard
 * button that reached all of them. Nothing about a subdirectory makes that
 * scoped, and `path` is UNIQUE, so three packages of one repo also became
 * three projects of one repo.
 *
 * Refusing at the point of choosing is the honest version of that: it names
 * the repository root, which is the thing to add instead. A directory that is
 * not in a repository at all is still a perfectly good project — plenty of
 * useful work is not versioned.
 */
async function assertWholeRepo(abs: string): Promise<void> {
  const scope = await scopeOf(abs);
  if (!scope || !scope.sub) return;
  throw new Error(
    `${path.basename(abs)} is the subdirectory ${scope.sub} of the git repository at ${scope.repoRoot}. ` +
    `Wanigan projects are whole repositories — git commits, discards and pushes act on all of one, ` +
    `so a project scoped to one directory could not honestly offer them. Add ${scope.repoRoot} instead.`,
  );
}

export async function addProject(dir: string): Promise<Project> {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error(`No such directory: ${abs}`);
  const existing = db().prepare('SELECT * FROM projects WHERE path = ?').get(abs) as { id: string } | undefined;
  if (existing) return listProjects().find((p) => p.id === existing.id)!;
  await assertWholeRepo(abs);

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

/**
 * The branch name, or null when there is not one to show.
 *
 * Null is a display answer, not a diagnosis: it covers a fresh `git init` with
 * no commits, a detached checkout and a git that could not answer at all.
 * `projectRepo` is the one to ask when the difference matters — and it does,
 * because the renderer reads a null branch as "not a git repo" and hides
 * worktree isolation on the strength of it.
 */
export async function gitBranch(dir: string): Promise<string | null> {
  const state = await repoState(dir);
  return state.kind === 'branch' ? state.branch : null;
}

/**
 * Why a project shows no branch. Read live, because every answer here can
 * change without Wanigan doing anything: a commit lands, a disk mounts, a
 * network share comes back.
 */
export async function projectRepo(id: string): Promise<RepoState | null> {
  const project = projectById(id);
  return project ? repoState(project.path) : null;
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
