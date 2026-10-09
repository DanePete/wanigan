// A project's hosted environments (Dev, Test, Live) for the live view's
// tabs, and the parts of a page the owner told comparisons to ignore. Finding
// them only reads the project's own small files (Drush and WP-CLI aliases,
// ddev and Lando configs, a host's config, Stage File Proxy's origin, compose
// files and a README's tables); nothing here starts a process or reaches the
// network. The owner keeps, renames or adds them; only kept ones are tabs.
// Design: docs/design/2026-10-08-live-view.md ("Local and hosted").
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { COMPARE_WIDTHS } from '../shared/live-compare.ts';
import {
  MAX_ENVS, MAX_MASKS, composePairs, ddevPantheonProject, drush8Aliases, drushAliases, envName, envRank, envVariables, hostedUrl,
  landoPantheonSite, pantheonEnvs, pantheonSite, rankCandidates, readmeEnvs, stageFileProxy, wpCliAliases,
  type Found, type LiveEnv, type LiveEnvCandidate, type LiveEnvs, type LiveMask,
} from '../shared/live-envs.ts';
import { readDdevYaml, sameSite } from '../shared/live.ts';
import { CoreError } from '../shared/protocol.ts';
import type { Board } from './board.ts';
import { readBoundedFile } from './bounded-file.ts';
import type { Ctx } from './context.ts';
import { detect } from './live.ts';
import { names } from './safe-fs.ts';

const MAX_FILE = 256 * 1024;

interface EnvRow { id: string; name: string; url: string; found: string | null; position: number }
interface MaskRow { id: string; path: string | null; width: number; x: number; y: number; w: number; h: number; label: string | null }

export class LiveEnvironments {
  private readonly ctx: Ctx;
  private readonly board: Board;

  constructor(ctx: Ctx, board: Board) {
    this.ctx = ctx;
    this.board = board;
  }

  /** The environments the owner keeps (Dev, Test, Live order), what the project's files name besides, and the ignored areas. */
  list(projectId: unknown): LiveEnvs {
    const project = this.project(projectId);
    const envs = this.envs(project.id);
    const { root, local } = this.local(project);
    const found = detectEnvs(root);
    const hosts = local.flatMap((u) => { try { return [new URL(u).hostname]; } catch { return []; } });
    return {
      projectId: project.id,
      envs,
      candidates: rankCandidates(found, { hosts, urls: envs.map((e) => e.url) }),
      masks: this.masks(project.id),
    };
  }

  /**
   * Keep an environment, or rename or readdress one (`id`). https only, no
   * credentials, never the local site; names and addresses are each the
   * project's once. Where the address was found is the core's to say, from
   * the project's files, never the caller's.
   */
  set(projectId: unknown, params: { id?: unknown; name?: unknown; url?: unknown }): LiveEnvs {
    const project = this.project(projectId);
    const name = envName(params.name);
    if (name.refused !== null) throw new CoreError('invalid', name.refused);
    const url = hostedUrl(params.url);
    if (url.refused !== null) throw new CoreError('invalid', url.refused);
    const envs = this.envs(project.id);
    const id = params.id === undefined || params.id === null ? null : String(params.id);
    if (id && !envs.some((e) => e.id === id)) throw new CoreError('not_found', 'No such environment.');
    const others = envs.filter((e) => e.id !== id);
    if (others.some((e) => e.name.toLowerCase() === name.name.toLowerCase())) throw new CoreError('invalid', `There is already an environment called ${name.name}.`);
    const same = others.find((e) => e.url === url.url);
    if (same) throw new CoreError('invalid', `${same.name} already has that address.`);
    const { root, local } = this.local(project);
    if (local.some((u) => sameSite(u, url.url))) throw new CoreError('invalid', 'That is the local site’s own address: it is the Local tab.');
    const candidate = detectEnvs(root).find((c) => c.url === url.url);
    const found = candidate ? `${candidate.file}: ${candidate.why}` : null;
    if (id) {
      this.ctx.db.prepare('UPDATE live_envs SET name = ?, url = ?, found = CASE WHEN url = ? THEN found ELSE ? END WHERE id = ? AND project_id = ?')
        .run(name.name, url.url, url.url, found, id, project.id);
    } else {
      if (envs.length >= MAX_ENVS) throw new CoreError('refused', `A project keeps up to ${MAX_ENVS} environments.`);
      const position = (this.ctx.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM live_envs WHERE project_id = ?').get(project.id) as { n: number }).n;
      this.ctx.db.prepare('INSERT INTO live_envs (id, project_id, name, url, found, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), project.id, name.name, url.url, found, position, this.ctx.now());
    }
    this.ctx.emit('liveSite', { projectId: project.id });
    return this.list(project.id);
  }

  remove(projectId: unknown, id: unknown): LiveEnvs {
    const project = this.project(projectId);
    const gone = this.ctx.db.prepare('DELETE FROM live_envs WHERE id = ? AND project_id = ?').run(String(id ?? ''), project.id);
    if (!gone.changes) throw new CoreError('not_found', 'No such environment.');
    this.ctx.emit('liveSite', { projectId: project.id });
    return this.list(project.id);
  }

  /** Ignore a part of the page in comparisons: on one page (its path) or every page, at one width. */
  mask(projectId: unknown, params: { path?: unknown; width?: unknown; rect?: unknown; label?: unknown }): LiveEnvs {
    const project = this.project(projectId);
    const path = params.path === null || params.path === undefined ? null : typeof params.path === 'string' && /^\/[^\u0000-\u001f]{0,999}$/.test(params.path) ? params.path : undefined;
    if (path === undefined) throw new CoreError('invalid', 'The page must be a path that begins with a slash, or every page.');
    if (!(COMPARE_WIDTHS as readonly unknown[]).includes(params.width)) throw new CoreError('invalid', `The width must be one of ${COMPARE_WIDTHS.join(', ')}.`);
    const r = params.rect && typeof params.rect === 'object' ? params.rect as Record<string, unknown> : {};
    const n = (v: unknown, min: number): number | null => (Number.isInteger(v) && (v as number) >= min && (v as number) <= 20_000 ? v as number : null);
    const [x, y, w, h] = [n(r.x, 0), n(r.y, 0), n(r.width, 1), n(r.height, 1)];
    if (x === null || y === null || w === null || h === null) throw new CoreError('invalid', 'An area is whole pixels: x, y, width and height.');
    const label = typeof params.label === 'string' ? params.label.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || null : null;
    const count = (this.ctx.db.prepare('SELECT COUNT(*) AS n FROM live_masks WHERE project_id = ?').get(project.id) as { n: number }).n;
    if (count >= MAX_MASKS) throw new CoreError('refused', `A site keeps up to ${MAX_MASKS} ignored areas. Remove some first.`);
    this.ctx.db.prepare('INSERT INTO live_masks (id, project_id, path, width, x, y, w, h, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), project.id, path, params.width as number, x, y, w, h, label, this.ctx.now());
    this.ctx.emit('liveSite', { projectId: project.id });
    return this.list(project.id);
  }

  unmask(projectId: unknown, id: unknown): LiveEnvs {
    const project = this.project(projectId);
    const gone = this.ctx.db.prepare('DELETE FROM live_masks WHERE id = ? AND project_id = ?').run(String(id ?? ''), project.id);
    if (!gone.changes) throw new CoreError('not_found', 'No such ignored area.');
    this.ctx.emit('liveSite', { projectId: project.id });
    return this.list(project.id);
  }

  private envs(projectId: string): LiveEnv[] {
    const rows = this.ctx.db.prepare('SELECT id, name, url, found, position FROM live_envs WHERE project_id = ? ORDER BY position').all(projectId) as EnvRow[];
    return rows.sort((a, b) => envRank(a.name) - envRank(b.name) || a.position - b.position).map((r) => ({ id: r.id, name: r.name, url: r.url, found: r.found }));
  }

  private masks(projectId: string): LiveMask[] {
    const rows = this.ctx.db.prepare('SELECT id, path, width, x, y, w, h, label FROM live_masks WHERE project_id = ? ORDER BY created_at, rowid').all(projectId) as MaskRow[];
    return rows.map((r) => ({ id: r.id, path: r.path, width: r.width, rect: { x: r.x, y: r.y, width: r.w, height: r.h }, label: r.label }));
  }

  /** The folder the local site serves, and the local site's own addresses (chosen and found). */
  private local(project: { id: string; path: string }): { root: string; local: string[] } {
    const row = this.ctx.db.prepare('SELECT url, served_path FROM live_sites WHERE project_id = ?').get(project.id) as { url: string | null; served_path: string | null } | undefined;
    const root = row?.served_path ?? project.path;
    return { root, local: [...(row?.url ? [row.url] : []), ...detect(root).candidates.map((c) => c.url)] };
  }

  private project(id: unknown): { id: string; path: string } {
    if (typeof id !== 'string' || !id) throw new CoreError('invalid', 'Which project?');
    const project = this.board.listProjects(new Map()).find((p) => p.id === id);
    if (!project) throw new CoreError('not_found', 'No such project.');
    return { id: project.id, path: project.path };
  }
}

/* ── finding them in the project's files ───────────────────────────────── */

function readText(path: string): string | null {
  try { return readBoundedFile(path, MAX_FILE).toString('utf8'); } catch { return null; }
}

/**
 * Every hosted environment the project's own files name, each with the file
 * it is in. Reads small files only, never .env files (they hold secrets), and
 * follows no links out of the project.
 */
export function detectEnvs(root: string): LiveEnvCandidate[] {
  const out: LiveEnvCandidate[] = [];
  const add = (file: string, found: readonly Found[]): void => { for (const f of found) out.push({ ...f, file }); };
  const read = (file: string): string | null => readText(join(root, file));

  // Drush site aliases (9+, YAML), then Drush 8's PHP aliases where Drupal 7 sites keep them.
  for (const name of names(join(root, 'drush', 'sites')).filter((n) => /\.site\.ya?ml$/.test(n)).slice(0, 20)) {
    const file = `drush/sites/${name}`;
    const text = read(file);
    if (text) add(file, drushAliases(text, file));
  }
  const ddevFiles = names(join(root, '.ddev')).filter((n) => n === 'config.yaml' || /^config\.[A-Za-z0-9_.-]+\.yaml$/.test(n));
  const ddev = ddevFiles.map((n) => ({ file: `.ddev/${n}`, yaml: readDdevYaml(read(`.ddev/${n}`) ?? '') }));
  const docroots = [...new Set(['', ...ddev.map((d) => (typeof d.yaml.docroot === 'string' ? d.yaml.docroot.replace(/^\/+|\/+$/g, '') : '')), 'web', 'docroot', 'public', 'html'])];
  for (const dir of ['drush', 'sites/all/drush', ...docroots.filter(Boolean).map((d) => `${d}/sites/all/drush`)]) {
    for (const name of names(join(root, dir)).filter((n) => /\.aliases\.drushrc\.php$/.test(n)).slice(0, 20)) {
      const text = read(`${dir}/${name}`);
      if (text) add(`${dir}/${name}`, drush8Aliases(text));
    }
  }

  // WP-CLI aliases.
  for (const file of ['wp-cli.yml', 'wp-cli.local.yml']) {
    const text = read(file);
    if (text) add(file, wpCliAliases(text));
  }

  // Pantheon: the host's own config file says the site is there; its name comes from ddev's provider, Lando or a variable.
  const variables = ddev.flatMap((d) => (Array.isArray(d.yaml.web_environment) ? d.yaml.web_environment.map((v) => ({ file: d.file, v })) : []));
  const pantheonFile = ['pantheon.yml', 'pantheon.upstream.yml'].find((f) => existsSync(join(root, f))) ?? null;
  const provider = ddevPantheonProject(read('.ddev/providers/pantheon.yaml') ?? '');
  const lando = landoPantheonSite(read('.lando.yml') ?? '');
  const named = variables.map(({ file, v }) => ({ file, site: pantheonSite(/^(?:PANTHEON_SITE|TERMINUS_SITE)=(.+)$/.exec(v)?.[1]) })).find((x) => x.site);
  const ddevName = ddev.map((d) => d.yaml.name).find((n): n is string => typeof n === 'string' && !!pantheonSite(n)) ?? null;
  if (provider) add('.ddev/providers/pantheon.yaml', pantheonEnvs(provider, 'project in ddev’s Pantheon provider'));
  else if (lando) add('.lando.yml', pantheonEnvs(lando, 'site in Lando’s Pantheon recipe'));
  else if (named?.site) add(named.file, pantheonEnvs(named.site, `PANTHEON_SITE in ${named.file}`));
  else if (pantheonFile && ddevName) add(pantheonFile, pantheonEnvs(ddevName, `${pantheonFile} is here; the name is the ddev project’s, taken to be the Pantheon site’s, so check it`));

  // Stage File Proxy's origin: in settings files, or exported configuration.
  for (const dir of docroots) {
    const sites = join(dir, 'sites');
    for (const site of names(join(root, sites)).slice(0, 40)) {
      for (const name of names(join(root, sites, site)).filter((n) => /^settings[A-Za-z0-9_.-]*\.php$/.test(n)).slice(0, 10)) {
        const file = `${sites}/${site}/${name}`.replace(/^\/+/, '');
        const text = read(file);
        if (text?.includes('stage_file_proxy')) add(file, stageFileProxy(text, false));
      }
    }
  }
  for (const dir of names(join(root, 'config')).slice(0, 20)) {
    const file = `config/${dir}/stage_file_proxy.settings.yml`;
    const text = read(file);
    if (text) add(file, stageFileProxy(text, true));
  }

  // Variables that name an environment's address: ddev's web_environment, then compose files.
  for (const d of ddev) {
    const list = Array.isArray(d.yaml.web_environment) ? d.yaml.web_environment : [];
    add(d.file, envVariables(list, d.file));
  }
  for (const file of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const text = read(file);
    if (text) add(file, envVariables(composePairs(text), file));
  }

  // A README, where it is structured (tables and lists that begin with an environment's name).
  const readme = ['README.md', 'readme.md', 'Readme.md', 'README'].find((f) => existsSync(join(root, f)));
  if (readme) {
    const text = read(readme);
    if (text) add(readme, readmeEnvs(text));
  }
  return out;
}
