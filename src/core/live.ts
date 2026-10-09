// The live view's side in the core: where each project's local site is, what
// it runs on, the words the owner changes by hand in its templates, and (later)
// its helper, screenshots and Serve this card. Finding a site only reads the
// project's own files (.ddev, wp-config.php, package.json, .lando.yml);
// nothing here starts a process or reaches the network. A hand edit writes
// one file, only the owner's own, only where the words appear exactly once.
// Design: docs/design/2026-10-08-live-view.md.
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  LIVE_PLATFORMS, componentProps, ddevInfo, ddevPlatform, liveUrl,
  type DdevInfo, type LiveCandidate, type LiveComponent, type LiveEdit, type LiveFound, type LiveHelper, type LiveHelperPlan,
  type LiveParts, type LivePlatform, type LiveShot, type LiveSite,
} from '../shared/live.ts';
import { DRUPAL_HELPER_FILES, DRUPAL_HELPER_MARK, DRUPAL_HELPER_MODULE, DRUPAL_HELPER_VERSION } from './live-helper-drupal.ts';
import { WORDPRESS_HELPER_FILE, WORDPRESS_HELPER_MARK, WORDPRESS_HELPER_VERSION, wordpressHelper } from './live-helper-wordpress.ts';
import { cleanEnv, loginPath, which } from './environment.ts';
import { originOf } from '../shared/live-names.ts';
import { CoreError } from '../shared/protocol.ts';
import type { Board } from './board.ts';
import { readBoundedFile } from './bounded-file.ts';
import type { Ctx } from './context.ts';
import { names } from './safe-fs.ts';

const MAX_CONFIG = 256 * 1024;
/** A screenshot larger than this is not kept (a full page at 2x is a few megabytes). */
const MAX_SHOT = 24 * 1024 * 1024;
/** A card keeps its newest screenshots; older ones go. */
const MAX_SHOTS_A_CARD = 12;
/** A template larger than this is not a template a hand edit should rewrite. */
const MAX_TEMPLATE = 1024 * 1024;
const MAX_WORDS = 2_000;
const TEMPLATE_FILE = /\.(?:twig|php|html|htm)$/i;

interface SiteRow {
  project_id: string;
  url: string | null;
  platform: string | null;
  served_path: string | null;
  served_card: string | null;
  helper: string | null;
  token: string | null;
}

/** What the helper column holds: which helper, and which version. */
interface HelperRecord { kind: 'drupal' | 'wordpress'; version: number }

/** A ddev command may wait on a container starting: give it time, then give up and say so. */
const DDEV_TIMEOUT_MS = 180_000;
const DEV_KEYS = ['twig_debug', 'twig_cache_disable', 'disable_rendered_output_cache_bins'];

export class Live {
  private readonly ctx: Ctx;
  private readonly board: Board;
  /** Where screenshots are kept: the core's own data folder. */
  private readonly shotDir: string;
  /** Projects whose helper is being installed or removed: one at a time each. */
  private readonly busy = new Set<string>();

  constructor(ctx: Ctx, board: Board, dataDir: string) {
    this.ctx = ctx;
    this.board = board;
    this.shotDir = join(dataDir, 'live-shots');
  }

  /**
   * Keep a screenshot of a card's page. A session's first before is the only
   * one kept (what the page was like before it worked); a new after replaces
   * that session's last. A card keeps its newest few.
   */
  saveShot(params: { cardId?: unknown; sessionId?: unknown; kind?: unknown; url?: unknown; data?: unknown; width?: unknown; height?: unknown }): LiveShot | null {
    const card = this.board.card(String(params.cardId ?? ''));
    const sessionId = typeof params.sessionId === 'string' && params.sessionId ? params.sessionId : null;
    const kind = params.kind === 'before' || params.kind === 'after' ? params.kind : null;
    const url = liveUrl(params.url);
    const size = (v: unknown): number | null => (Number.isInteger(v) && (v as number) > 0 && (v as number) <= 20_000 ? v as number : null);
    const width = size(params.width);
    const height = size(params.height);
    if (!kind || !url || !width || !height || typeof params.data !== 'string') throw new CoreError('invalid', 'A screenshot needs a kind, the page, its size and the image.');
    const png = Buffer.from(params.data, 'base64');
    if (png.length < 8 || png.length > MAX_SHOT || png.readUInt32BE(0) !== 0x89504e47) throw new CoreError('invalid', 'That is not a PNG Wanigan keeps.');
    if (sessionId && !this.ctx.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) throw new CoreError('not_found', 'No such session.');
    if (kind === 'before' && sessionId && this.ctx.db.prepare("SELECT 1 FROM live_shots WHERE card_id = ? AND session_id = ? AND kind = 'before'").get(card.id, sessionId)) return null;
    const replaced = kind === 'after' && sessionId
      ? this.ctx.db.prepare("SELECT id, file FROM live_shots WHERE card_id = ? AND session_id = ? AND kind = 'after'").all(card.id, sessionId) as { id: string; file: string }[]
      : [];
    mkdirSync(this.shotDir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const file = `${id}.png`;
    writeFileSync(join(this.shotDir, file), png, { mode: 0o600 });
    this.ctx.db.prepare(`INSERT INTO live_shots (id, card_id, session_id, kind, url, file, width, height, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, card.id, sessionId, kind, url, file, width, height, this.ctx.now());
    const old = this.ctx.db.prepare('SELECT id, file FROM live_shots WHERE card_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?').all(card.id, MAX_SHOTS_A_CARD) as { id: string; file: string }[];
    for (const gone of [...replaced, ...old.filter((o) => o.id !== id)]) this.dropShot(gone);
    this.ctx.emit('liveShots', { cardId: card.id });
    return this.shots(card.id).find((s) => s.id === id) ?? null;
  }

  shots(cardId: string): LiveShot[] {
    const card = this.board.card(cardId);
    const rows = this.ctx.db.prepare('SELECT id, card_id, session_id, kind, url, width, height, created_at FROM live_shots WHERE card_id = ? ORDER BY created_at, rowid')
      .all(card.id) as { id: string; card_id: string; session_id: string | null; kind: 'before' | 'after'; url: string; width: number; height: number; created_at: number }[];
    return rows.map((r) => ({ id: r.id, cardId: r.card_id, sessionId: r.session_id, kind: r.kind, url: r.url, width: r.width, height: r.height, createdAt: r.created_at }));
  }

  shotImage(id: string): { data: string } {
    const row = this.ctx.db.prepare('SELECT file FROM live_shots WHERE id = ?').get(id) as { file: string } | undefined;
    if (!row) throw new CoreError('not_found', 'No such screenshot.');
    try {
      return { data: readBoundedFile(join(this.shotDir, basename(row.file)), MAX_SHOT).toString('base64') };
    } catch {
      throw new CoreError('not_found', 'That screenshot’s file is gone.');
    }
  }

  page(cardId: string): { url: string | null } {
    const card = this.board.card(cardId);
    const row = this.ctx.db.prepare('SELECT url FROM live_pages WHERE card_id = ?').get(card.id) as { url: string } | undefined;
    return { url: row?.url ?? null };
  }

  setPage(cardId: string, raw: unknown): { url: string | null } {
    const card = this.board.card(cardId);
    if (raw === null) {
      this.ctx.db.prepare('DELETE FROM live_pages WHERE card_id = ?').run(card.id);
      return { url: null };
    }
    const url = liveUrl(raw);
    if (!url) throw new CoreError('invalid', 'That is not an http or https address.');
    this.ctx.db.prepare(`INSERT INTO live_pages (card_id, url, set_by, set_at) VALUES (?, ?, 'owner', ?)
      ON CONFLICT(card_id) DO UPDATE SET url = excluded.url, set_by = excluded.set_by, set_at = excluded.set_at`).run(card.id, url, this.ctx.now());
    return { url };
  }

  private dropShot(shot: { id: string; file: string }): void {
    this.ctx.db.prepare('DELETE FROM live_shots WHERE id = ?').run(shot.id);
    rmSync(join(this.shotDir, basename(shot.file)), { force: true });
  }

  /** A project's site: what the owner chose, and what Wanigan can find in its folder. */
  site(projectId: string): LiveSite {
    const project = this.project(projectId);
    const row = this.row(project.id);
    const found = detect(project.path);
    const platform = (row?.platform as LivePlatform | null) ?? null;
    const record = helperRecord(row?.helper ?? null);
    const latest = record?.kind === 'wordpress' ? WORDPRESS_HELPER_VERSION : DRUPAL_HELPER_VERSION;
    const helper: LiveHelper | null = record ? { kind: record.kind, version: record.version, outdated: record.version < latest } : null;
    const root = row?.served_path ?? project.path;
    return {
      projectId: project.id,
      url: row?.url ?? null,
      platform,
      servedPath: row?.served_path ?? null,
      servedCard: row?.served_card ?? null,
      candidates: found.candidates,
      ddev: found.ddev,
      helper,
      helperPlan: platform === 'drupal' ? this.drupalPlan(root) : platform === 'wordpress' ? wordpressPlan(root) : null,
      token: helper ? row?.token ?? null : null,
    };
  }

  /** Choose the address the view opens (null forgets it), and what the site runs on. */
  setSite(projectId: string, params: { url: unknown; platform?: unknown }): LiveSite {
    const project = this.project(projectId);
    const url = params.url === null ? null : liveUrl(params.url);
    if (params.url !== null && !url) throw new CoreError('invalid', 'That is not an http or https address Wanigan can open.');
    let platform: LivePlatform | null = null;
    if (url) {
      if (params.platform === undefined || params.platform === null) {
        platform = this.site(project.id).candidates.find((c) => c.url === url)?.platform ?? guessPlatform(project.path);
      } else if ((LIVE_PLATFORMS as readonly unknown[]).includes(params.platform)) {
        platform = params.platform as LivePlatform;
      } else {
        throw new CoreError('invalid', 'The platform must be drupal, wordpress or site.');
      }
    }
    this.ctx.db.prepare(`INSERT INTO live_sites (project_id, url, platform, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET url = excluded.url, platform = excluded.platform, updated_at = excluded.updated_at`)
      .run(project.id, url, platform, this.ctx.now());
    this.ctx.emit('liveSite', { projectId: project.id });
    return this.site(project.id);
  }

  /**
   * Write the Drupal helper into the site and switch it on with ddev: the
   * module folder (kept out of git by .git/info/exclude), its token in
   * Drupal's state, and Twig development mode (debug on, caches off). The
   * development settings it found are kept in Drupal's own state the first
   * time, so removing the helper puts them back whichever Wanigan removes it.
   */
  async installHelper(projectId: string): Promise<LiveSite> {
    const project = this.project(projectId);
    const row = this.row(project.id);
    if (row?.platform === 'wordpress') return this.installWordpress(project.id, row.served_path ?? project.path);
    if (row?.platform !== 'drupal') throw new CoreError('refused', 'The helper is for Drupal and WordPress sites: choose which this site runs on first.');
    const root = row.served_path ?? project.path;
    const plan = this.drupalPlan(root);
    if (plan.refused) throw new CoreError('refused', plan.refused);
    return this.exclusive(project.id, async () => {
      const ddev = await ddevCommand();
      const existing = join(plan.folder, `${DRUPAL_HELPER_MODULE}.info.yml`);
      if (existsSync(plan.folder) && !(readText(existing) ?? '').startsWith(DRUPAL_HELPER_MARK)) {
        throw new CoreError('refused', `${plan.folder} already exists and Wanigan did not write it. Nothing was changed.`);
      }
      for (const [file, text] of Object.entries(DRUPAL_HELPER_FILES)) {
        const path = join(plan.folder, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      }
      await excludeFromGit(root, plan.folder);
      const token = randomBytes(24).toString('hex');
      await ddev.run(root, ['drush', 'state:set', 'wanigan_live.token', token]);
      await ddev.run(root, ['drush', 'pm:install', DRUPAL_HELPER_MODULE, '-y']);
      await ddev.run(root, ['drush', 'php:eval', DEV_ON]);
      await ddev.run(root, ['drush', 'cache:rebuild']);
      const record: HelperRecord = { kind: 'drupal', version: DRUPAL_HELPER_VERSION };
      this.ctx.db.prepare('UPDATE live_sites SET helper = ?, token = ?, updated_at = ? WHERE project_id = ?').run(JSON.stringify(record), token, this.ctx.now(), project.id);
      this.ctx.emit('liveSite', { projectId: project.id });
      return this.site(project.id);
    });
  }

  /** Switch the helper off and remove what installing it wrote, putting the development settings back as they were. */
  async removeHelper(projectId: string): Promise<LiveSite> {
    const project = this.project(projectId);
    const row = this.row(project.id);
    const record = helperRecord(row?.helper ?? null);
    if (!row || !record) throw new CoreError('refused', 'There is no helper to remove.');
    const root = row.served_path ?? project.path;
    if (record.kind === 'wordpress') return this.removeWordpress(project.id, root);
    const plan = this.drupalPlan(root);
    return this.exclusive(project.id, async () => {
      const ddev = await ddevCommand();
      await ddev.run(root, ['drush', 'pm:uninstall', DRUPAL_HELPER_MODULE, '-y']).catch((error: Error) => {
        // Already gone from Drupal (the database was replaced): nothing left to switch off.
        if (!/not installed|is not enabled|Unable to uninstall/i.test(error.message)) throw error;
      });
      await ddev.run(root, ['drush', 'state:delete', 'wanigan_live.token']);
      await ddev.run(root, ['drush', 'php:eval', DEV_BACK]);
      await ddev.run(root, ['drush', 'cache:rebuild']);
      if ((readText(join(plan.folder, `${DRUPAL_HELPER_MODULE}.info.yml`)) ?? '').startsWith(DRUPAL_HELPER_MARK)) rmSync(plan.folder, { recursive: true, force: true });
      await excludeFromGit(root, plan.folder, false);
      this.ctx.db.prepare('UPDATE live_sites SET helper = NULL, token = NULL, updated_at = ? WHERE project_id = ?').run(this.ctx.now(), project.id);
      this.ctx.emit('liveSite', { projectId: project.id });
      return this.site(project.id);
    });
  }

  /**
   * The WordPress helper is one must-use plugin file: WordPress loads it by
   * itself, so installing writes the file (its token inside) and the exclude
   * line, and runs nothing.
   */
  private installWordpress(projectId: string, root: string): Promise<LiveSite> {
    const plan = wordpressPlan(root);
    if (plan.refused) throw new CoreError('refused', plan.refused);
    return this.exclusive(projectId, async () => {
      const file = join(plan.folder, WORDPRESS_HELPER_FILE);
      if (existsSync(file) && !(readText(file) ?? '').includes(WORDPRESS_HELPER_MARK)) {
        throw new CoreError('refused', `${file} already exists and Wanigan did not write it. Nothing was changed.`);
      }
      const token = randomBytes(24).toString('hex');
      mkdirSync(plan.folder, { recursive: true });
      // Where WordPress sits in the project, so the trace names files from the project's root.
      writeFileSync(file, wordpressHelper(token, relative(root, dirname(dirname(plan.folder))).split(sep).join('/')));
      await excludeFromGit(root, file, true, false);
      const record: HelperRecord = { kind: 'wordpress', version: WORDPRESS_HELPER_VERSION };
      this.ctx.db.prepare('UPDATE live_sites SET helper = ?, token = ?, updated_at = ? WHERE project_id = ?').run(JSON.stringify(record), token, this.ctx.now(), projectId);
      this.ctx.emit('liveSite', { projectId });
      return this.site(projectId);
    });
  }

  private removeWordpress(projectId: string, root: string): Promise<LiveSite> {
    const plan = wordpressPlan(root);
    return this.exclusive(projectId, async () => {
      const file = join(plan.folder, WORDPRESS_HELPER_FILE);
      if ((readText(file) ?? '').includes(WORDPRESS_HELPER_MARK)) rmSync(file, { force: true });
      await excludeFromGit(root, file, false, false);
      this.ctx.db.prepare('UPDATE live_sites SET helper = NULL, token = NULL, updated_at = ? WHERE project_id = ?').run(this.ctx.now(), projectId);
      this.ctx.emit('liveSite', { projectId });
      return this.site(projectId);
    });
  }

  private async exclusive<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    if (this.busy.has(projectId)) throw new CoreError('refused', 'The helper is already being installed or removed. Wait for that to finish.');
    this.busy.add(projectId);
    try { return await work(); } finally { this.busy.delete(projectId); }
  }

  /** What installing the Drupal helper writes and runs in a folder, or why it cannot. */
  private drupalPlan(root: string): LiveHelperPlan {
    const ddev = detect(root).ddev;
    const docroot = findDocroot(root, ddev?.docroot ?? null);
    const folder = join(docroot ?? join(root, 'web'), 'modules', 'custom', DRUPAL_HELPER_MODULE);
    return {
      kind: 'drupal',
      folder,
      files: Object.keys(DRUPAL_HELPER_FILES),
      exclude: `/${relative(root, folder).split(sep).join('/')}/`,
      runs: [
        'ddev drush state:set wanigan_live.token …',
        `ddev drush pm:install ${DRUPAL_HELPER_MODULE} -y`,
        'ddev drush php:eval (Twig development mode on: debug, no Twig or render caching)',
        'ddev drush cache:rebuild',
      ],
      refused: !docroot ? 'Wanigan cannot find Drupal in this project (no core/lib/Drupal.php under web/, docroot/ or the folder itself).'
        : !ddev ? 'Wanigan installs the helper with ddev, and this project has no .ddev folder. (Lando and other setups are not supported yet.)'
          : null,
    };
  }

  /** The site's docroot and its components: what an edit to a component's folder should outline. */
  parts(projectId: string): LiveParts {
    const project = this.project(projectId);
    const row = this.row(project.id);
    const root = row?.served_path ?? project.path;
    const docroot = findDocroot(root, detect(root).ddev?.docroot ?? null);
    return { docroot, components: docroot ? findComponents(docroot) : [] };
  }

  /** Where some words on the page are in one of the site's templates. */
  findText(projectId: string, file: unknown, text: unknown): LiveFound {
    const { path, refused } = this.template(projectId, file);
    const words = wordsOf(text);
    if (!path) return { path: '', count: 0, line: null, refused: refused ?? 'That template is not in this project.' };
    const content = readText(path, MAX_TEMPLATE);
    if (content === null) return { path, count: 0, line: null, refused: 'Wanigan could not read that template.' };
    const found = matches(content, words);
    const line = found[0] ? lineAt(content, found[0].index) : null;
    const why = !found.length ? 'Those words are not written in this template: they come from content, configuration or a variable.'
      : refused ?? (found.length > 1 ? `Those words are in this template ${found.length} times, so Wanigan cannot tell which one you changed.` : null);
    return { path, count: found.length, line, refused: why };
  }

  /** Replace words in the owner's own template, when they appear there exactly once. */
  saveText(projectId: string, file: unknown, before: unknown, after: unknown): LiveEdit {
    const found = this.findText(projectId, file, before);
    if (found.refused) throw new CoreError('refused', found.refused);
    const next = wordsOf(after);
    if (!next) throw new CoreError('invalid', 'The new words are empty.');
    const content = readText(found.path, MAX_TEMPLATE) as string;
    const match = matches(content, wordsOf(before))[0] as RegExpExecArray;
    // Inside Twig or PHP code the words are a string literal: written as they are (the engine escapes them), and a
    // quote or brace would end the string early, so those are refused rather than written.
    const code = inCode(content, match.index);
    if (code && /['"\\{}]/.test(next)) {
      throw new CoreError('refused', `Those words are a string in the template’s ${code} code, and the new ones have a quote or a brace that would break it. Ask an agent to make this change.`);
    }
    const replacement = code ? next : escapeHtml(next);
    const updated = content.slice(0, match.index) + replacement + content.slice(match.index + match[0].length);
    writeAtomic(found.path, updated);
    const edit = {
      id: randomUUID(), project_id: projectId, path: found.path, offset: match.index, line: found.line ?? 1,
      before_text: match[0], after_text: replacement, before_hash: hash(content), after_hash: hash(updated), created_at: this.ctx.now(),
    };
    this.ctx.db.prepare(`INSERT INTO live_edits (id, project_id, path, offset, line, before_text, after_text, before_hash, after_hash, created_at)
      VALUES (@id, @project_id, @path, @offset, @line, @before_text, @after_text, @before_hash, @after_hash, @created_at)`).run(edit);
    this.ctx.emit('liveEdits', { projectId });
    return this.edit(edit.id);
  }

  edits(projectId: string): LiveEdit[] {
    const project = this.project(projectId);
    const rows = this.ctx.db.prepare('SELECT id FROM live_edits WHERE project_id = ? ORDER BY created_at DESC LIMIT 20').all(project.id) as { id: string }[];
    return rows.map((r) => this.edit(r.id));
  }

  /** Put back exactly what a hand edit replaced, if nothing has changed the file since. */
  revert(id: string): LiveEdit {
    const row = this.editRow(id);
    if (row.reverted_at) throw new CoreError('refused', 'That edit was already put back.');
    const content = readText(row.path, MAX_TEMPLATE);
    if (content === null || hash(content) !== row.after_hash) {
      throw new CoreError('refused', 'The template has changed since that edit, so putting the old words back could undo other work. Change it by hand or ask an agent.');
    }
    const restored = content.slice(0, row.offset) + row.before_text + content.slice(row.offset + row.after_text.length);
    if (hash(restored) !== row.before_hash) throw new CoreError('refused', 'Putting the old words back would not give the file it had. Nothing was changed.');
    writeAtomic(row.path, restored);
    this.ctx.db.prepare('UPDATE live_edits SET reverted_at = ? WHERE id = ?').run(this.ctx.now(), id);
    this.ctx.emit('liveEdits', { projectId: row.project_id });
    return this.edit(id);
  }

  private editRow(id: string): EditRow {
    const row = this.ctx.db.prepare('SELECT * FROM live_edits WHERE id = ?').get(id) as EditRow | undefined;
    if (!row) throw new CoreError('not_found', 'No such edit.');
    return row;
  }

  private edit(id: string): LiveEdit {
    const row = this.editRow(id);
    const content = row.reverted_at ? null : readText(row.path, MAX_TEMPLATE);
    return {
      id: row.id, projectId: row.project_id, path: row.path, line: row.line,
      before: unescapeHtml(row.before_text).replace(/\s+/g, ' ').trim(), after: unescapeHtml(row.after_text),
      createdAt: row.created_at, revertedAt: row.reverted_at, revertable: content !== null && hash(content) === row.after_hash,
    };
  }

  /**
   * A template of the site, by the path Drupal names it with (relative to the
   * docroot): its absolute path when it is a template file inside the project,
   * and why a hand edit may not change it (someone else's code).
   */
  private template(projectId: string, file: unknown): { path: string | null; refused: string | null } {
    if (typeof file !== 'string' || !file || file.length > 1_000 || !TEMPLATE_FILE.test(file) || file.includes('\0')) return { path: null, refused: null };
    const project = this.project(projectId);
    const row = this.row(project.id);
    const root = row?.served_path ?? project.path;
    const docroot = findDocroot(root, detect(root).ddev?.docroot ?? null) ?? root;
    let path: string;
    let base: string;
    try {
      path = realpathSync(resolve(docroot, file));
      base = realpathSync(root);
    } catch {
      return { path: null, refused: null };
    }
    const inside = relative(base, path);
    if (!inside || inside.startsWith('..') || inside.startsWith(sep)) return { path: null, refused: null };
    // A WordPress theme's own path cannot say whether it is the owner's or a parent theme's (origin null): it is in
    // the owner's project folder, and a revert puts it back, so it may be changed.
    const origin = originOf(file);
    return {
      path,
      refused: origin === 'yours' || origin === null ? null
        : origin === 'core' ? 'That template is Drupal core’s. Override it in your theme instead (the part’s details say how).'
          : 'That template belongs to a contributed project. Override it in your theme instead (the part’s details say how).',
    };
  }

  private row(projectId: string): SiteRow | undefined {
    return this.ctx.db.prepare('SELECT project_id, url, platform, served_path, served_card, helper, token FROM live_sites WHERE project_id = ?').get(projectId) as SiteRow | undefined;
  }

  private project(id: unknown): { id: string; path: string } {
    if (typeof id !== 'string' || !id) throw new CoreError('invalid', 'Which project?');
    const project = this.board.listProjects(new Map()).find((p) => p.id === id);
    if (!project) throw new CoreError('not_found', 'No such project.');
    return { id: project.id, path: project.path };
  }
}

interface EditRow {
  id: string; project_id: string; path: string; offset: number; line: number;
  before_text: string; after_text: string; before_hash: string; after_hash: string; created_at: number; reverted_at: number | null;
}

/* ── the helper ────────────────────────────────────────────────────────── */

/** Where WordPress is in a project: the folder holding wp-content (the ddev docroot, or one of the usual ones). */
function wordpressRoot(root: string): string | null {
  const named = detect(root).ddev?.docroot ?? null;
  for (const dir of [...new Set([named ?? '', '', 'web', 'public', 'wp', 'htdocs'])]) {
    const at = dir ? join(root, dir) : root;
    if (existsSync(join(at, 'wp-content')) && (existsSync(join(at, 'wp-includes')) || existsSync(join(at, 'wp-config.php')))) return at;
  }
  return null;
}

/** What installing the WordPress helper writes, or why it cannot. */
function wordpressPlan(root: string): LiveHelperPlan {
  const wp = wordpressRoot(root);
  const folder = join(wp ?? root, 'wp-content', 'mu-plugins');
  return {
    kind: 'wordpress',
    folder,
    files: [WORDPRESS_HELPER_FILE],
    exclude: `/${relative(root, join(folder, WORDPRESS_HELPER_FILE)).split(sep).join('/')}`,
    runs: [],
    refused: wp ? null : 'Wanigan cannot find WordPress in this project (no wp-content beside wp-includes or wp-config.php).',
  };
}

function helperRecord(raw: string | null): HelperRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<HelperRecord>;
    return (value.kind === 'drupal' || value.kind === 'wordpress') && typeof value.version === 'number' ? value as HelperRecord : null;
  } catch {
    return null;
  }
}

/** ddev, found on the login shell's PATH, and a way to run it in a project folder. */
async function ddevCommand(): Promise<{ run(cwd: string, args: string[]): Promise<string> }> {
  const path = await loginPath();
  const bin = which('ddev', path);
  if (!bin) throw new CoreError('refused', 'ddev is not installed (or not on your shell’s PATH), and the helper is installed with it.');
  return {
    run: (cwd, args) => new Promise((done, fail) => {
      execFile(bin, args, { cwd, env: { ...cleanEnv(process.env), PATH: path }, timeout: DDEV_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (!error) { done(String(stdout)); return; }
        const said = `${stderr || stdout || error.message}`.trim().split('\n').slice(-4).join(' ').slice(0, 600);
        const shown = args[0] === 'drush' && args[1] === 'state:set' ? 'ddev drush state:set wanigan_live.token …' : `ddev ${args.join(' ')}`;
        fail(new CoreError('refused', `${shown} failed: ${said}${/not running|stopped|start the project/i.test(said) ? ' Start the site (ddev start) and try again.' : ''}`));
      });
    }),
  };
}

const DEV_LIST = `[${DEV_KEYS.map((k) => `'${k}'`).join(', ')}]`;

/**
 * PHP that switches Twig development mode on as core's own form saves it,
 * keeping the settings it found in state the first time (a second install
 * must not take the helper's own settings for the site's).
 */
const DEV_ON = `$kv = \\Drupal::keyValue('development_settings'); $state = \\Drupal::state();`
  + ` if ($state->get('wanigan_live.dev_before') === NULL) { $state->set('wanigan_live.dev_before', $kv->getMultiple(${DEV_LIST})); }`
  + ` $kv->setMultiple([${DEV_KEYS.map((k) => `'${k}' => TRUE`).join(', ')}]); \\Drupal::service('kernel')->invalidateContainer();`;

/** PHP that puts the development settings back as the first install found them, and forgets them. */
const DEV_BACK = `$kv = \\Drupal::keyValue('development_settings'); $state = \\Drupal::state(); $before = (array) $state->get('wanigan_live.dev_before', []);`
  + ` $kv->deleteMultiple(${DEV_LIST}); $keep = array_intersect_key($before, array_flip(${DEV_LIST})); if ($keep) { $kv->setMultiple($keep); }`
  + ` $state->delete('wanigan_live.dev_before'); \\Drupal::service('kernel')->invalidateContainer();`;

/**
 * Keep a folder (or one file) out of git with the repository's own exclude
 * file (never .gitignore, which is the project's): add its line, or take it out again.
 * A project that is not a git repository has nothing to exclude it from.
 */
export function excludeFromGit(root: string, folder: string, add = true, isFolder = true): Promise<void> {
  return new Promise((done) => {
    execFile('git', ['rev-parse', '--show-toplevel', '--git-path', 'info/exclude'], { cwd: root, timeout: 10_000 }, (error, stdout) => {
      if (error) { done(); return; }
      const [top, excludeRaw] = String(stdout).trim().split('\n');
      if (!top || !excludeRaw) { done(); return; }
      const exclude = isAbsolute(excludeRaw) ? excludeRaw : join(root, excludeRaw);
      // Git names its top folder by its real path; the project's may come through a symlink (/var is /private/var).
      let real = root;
      try { real = realpathSync(root); } catch { /* the folder as given */ }
      const line = `/${join(relative(top, real), relative(root, folder)).split(sep).join('/')}${isFolder ? '/' : ''}`;
      const note = '# Wanigan’s live view helper (development only)';
      const now = readText(exclude) ?? '';
      if (add && !now.split('\n').includes(line)) {
        mkdirSync(dirname(exclude), { recursive: true });
        appendFileSync(exclude, `${now && !now.endsWith('\n') ? '\n' : ''}${note}\n${line}\n`);
      } else if (!add && now.includes(line)) {
        writeFileSync(exclude, now.split('\n').filter((l) => l !== line && l !== note).join('\n'));
      }
      done();
    });
  });
}

/* ── words in a template ───────────────────────────────────────────────── */

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const NAMED: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', nbsp: '\u00a0', hellip: '…', amp: '&' };
const unescapeHtml = (s: string): string => s.replace(/&(?:#(\d+)|([a-z]+));/gi, (m, n: string | undefined, name: string | undefined) =>
  n ? String.fromCodePoint(Number(n)) : NAMED[(name ?? '').toLowerCase()] ?? m);

function wordsOf(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_WORDS);
}

/**
 * Every place the words are written in a template, as the page shows them:
 * any run of whitespace in the file matches a space, and the few entities a
 * template writes for punctuation match the character they show.
 */
function matches(content: string, words: string): RegExpExecArray[] {
  if (!words) return [];
  const ENTITY: Record<string, string> = { '&': '&(?:amp;)?', '<': '(?:<|&lt;)', '>': '(?:>|&gt;)', '"': '(?:"|&quot;)', "'": "(?:'|&#0?39;|&apos;)", '’': '(?:’|&rsquo;)', '“': '(?:“|&ldquo;)', '”': '(?:”|&rdquo;)', '—': '(?:—|&mdash;)', '–': '(?:–|&ndash;)', '\u00a0': '(?:\u00a0|&nbsp;)' };
  const pattern = words.split(' ').map((w) => [...w].map((ch) => ENTITY[ch] ?? ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')).join('\\s+');
  const re = new RegExp(`(?<![\\w])${pattern}(?![\\w])`, 'g');
  const out: RegExpExecArray[] = [];
  for (let m = re.exec(content); m && out.length < 50; m = re.exec(content)) out.push(m);
  return out;
}

/** Whether a place in a template is inside Twig's `{{ }}` / `{% %}` or PHP's `<?php ?>`: which one, or null for markup. */
function inCode(content: string, index: number): 'Twig' | 'PHP' | null {
  const before = content.slice(0, index);
  const twig = Math.max(before.lastIndexOf('{{'), before.lastIndexOf('{%'));
  if (twig >= 0 && Math.max(before.lastIndexOf('}}'), before.lastIndexOf('%}')) < twig) return 'Twig';
  const php = before.lastIndexOf('<?');
  if (php >= 0 && before.lastIndexOf('?>') < php) return 'PHP';
  return null;
}

const lineAt = (content: string, index: number): number => content.slice(0, index).split('\n').length;

function writeAtomic(path: string, text: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.wanigan-${process.pid}`);
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/* ── finding a site in a folder ────────────────────────────────────────── */

function readText(path: string, max = MAX_CONFIG): string | null {
  try { return readBoundedFile(path, max).toString('utf8'); } catch { return null; }
}

/** What a project folder says about its local site. Reads only, and only small files. */
export function detect(root: string): { candidates: LiveCandidate[]; ddev: DdevInfo | null } {
  const candidates: LiveCandidate[] = [];
  const add = (c: LiveCandidate): void => { if (!candidates.some((x) => x.url === c.url)) candidates.push(c); };

  const ddevDir = join(root, '.ddev');
  const ddevFiles = names(ddevDir).filter((n) => n === 'config.yaml' || /^config\.[A-Za-z0-9_.-]+\.yaml$/.test(n))
    .flatMap((name) => {
      const text = readText(join(ddevDir, name));
      return text === null ? [] : [{ name, text }];
    });
  const ddev = ddevFiles.some((f) => f.name === 'config.yaml') ? ddevInfo(ddevFiles) : null;
  if (ddev) {
    const platform = ddev.type ? ddevPlatform(ddev.type) : guessPlatform(root);
    add({ url: ddev.url, platform, source: 'ddev', why: `ddev project “${ddev.name}” (${ddev.type || 'no type'}) in .ddev/config.yaml` });
    for (const host of ddev.hostnames.slice(1)) add({ url: `https://${host}/`, platform, source: 'ddev', why: 'an extra hostname in the ddev config' });
  }

  const docroots = [...new Set(['', ddev?.docroot ?? '', 'web', 'docroot', 'public'].filter((d) => d !== undefined))];
  for (const dir of docroots) {
    const config = readText(join(root, dir, 'wp-config.php'));
    if (!config) continue;
    for (const name of ['WP_HOME', 'WP_SITEURL']) {
      const m = new RegExp(`define\\(\\s*['"]${name}['"]\\s*,\\s*['"]([^'"]+)['"]`).exec(config);
      const url = m ? liveUrl(m[1]) : null;
      if (url && !url.includes('$')) add({ url, platform: 'wordpress', source: 'wordpress', why: `${name} in ${dir ? `${dir}/` : ''}wp-config.php` });
    }
  }

  const pkg = readText(join(root, 'package.json'));
  if (pkg) {
    try {
      const scripts = (JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts ?? {};
      const dev = typeof scripts.dev === 'string' ? scripts.dev : typeof scripts.start === 'string' ? scripts.start : '';
      const port = devPort(dev);
      if (port) add({ url: `http://localhost:${port}/`, platform: 'site', source: 'package', why: `the dev script in package.json (${dev.slice(0, 60)})` });
    } catch { /* not JSON: nothing to find */ }
  }

  const lando = readText(join(root, '.lando.yml'));
  const landoName = lando ? /^name:\s*['"]?([A-Za-z0-9-]+)['"]?\s*$/m.exec(lando)?.[1] : undefined;
  if (landoName) add({ url: `https://${landoName}.lndo.site/`, platform: guessPlatform(root), source: 'lando', why: 'name in .lando.yml' });

  return { candidates, ddev };
}

/** The port a dev script listens on: an explicit --port, or the tool's own default. */
export function devPort(script: string): number | null {
  const explicit = /(?:--port[ =]|\s-p\s+)(\d{2,5})\b/.exec(script);
  if (explicit) return Number(explicit[1]);
  if (/\bvite\b/.test(script)) return 5173;
  if (/\bastro\s+dev\b/.test(script)) return 4321;
  if (/\b(next|nuxt|nuxi)\s+dev\b|\breact-scripts\s+start\b|\bremix\s+dev\b/.test(script)) return 3000;
  if (/\bng\s+serve\b/.test(script)) return 4200;
  if (/\bsvelte-kit\s+dev\b/.test(script)) return 5173;
  return null;
}

/** What a folder runs on, from the files only Drupal or WordPress have. */
export function guessPlatform(root: string): LivePlatform {
  for (const dir of ['', 'web', 'docroot', 'public']) {
    if (existsSync(join(root, dir, 'core', 'lib', 'Drupal.php'))) return 'drupal';
    if (existsSync(join(root, dir, 'wp-includes', 'version.php')) || existsSync(join(root, dir, 'wp-config.php'))) return 'wordpress';
  }
  return 'site';
}

/* ── a Drupal site's own parts ─────────────────────────────────────────── */

/** Where a Drupal site's core lives: the docroot ddev names, else web/, docroot/, or the folder itself. */
export function findDocroot(root: string, named: string | null): string | null {
  for (const dir of [...new Set([named ?? '', 'web', 'docroot', 'public', ''])]) {
    const candidate = dir ? join(root, dir) : root;
    if (existsSync(join(candidate, 'core', 'lib', 'Drupal.php'))) return candidate;
  }
  return null;
}

const SKIP = new Set(['node_modules', 'vendor', 'tests', 'test', '.git', 'files', 'dist', 'build']);
const MAX_DIRS = 4_000;
const MAX_DEPTH = 7;

/**
 * Every single-directory component under the site's themes, modules and
 * profiles: `<provider>/…/components/<name>/<name>.component.yml`. Its id is
 * the provider's machine name (the nearest folder with a `<folder>.info.yml`)
 * and the component's folder name, as core's data-component-id writes it.
 * Test modules are left out. Bounded: a runaway tree stops the walk, it does
 * not stall the core.
 */
export function findComponents(docroot: string): LiveComponent[] {
  const out: LiveComponent[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || visited++ > MAX_DIRS) return;
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const yml = entries.find((e) => e.isFile() && e.name === `${basename(dir)}.component.yml`);
    if (yml && basename(dirname(dir)) === 'components') {
      const provider = providerOf(dirname(dirname(dir)));
      if (provider) {
        const meta = readText(join(dir, yml.name)) ?? '';
        const field = (key: string): string => /^(['"]?)(.*)\1$/.exec((new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(meta)?.[1] ?? '').trim())?.[2] ?? '';
        out.push({
          id: `${provider}:${basename(dir)}`,
          name: field('name') || basename(dir),
          description: field('description'),
          dir,
          files: entries.filter((e) => e.isFile()).map((e) => e.name).sort(),
          props: componentProps(meta),
        });
      }
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) walk(join(dir, e.name), depth + 1);
    }
  };
  for (const top of ['themes', 'modules', 'profiles']) walk(join(docroot, top), 0);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** The machine name of the extension a folder belongs to: the nearest folder (it or above) holding `<folder>.info.yml`. */
function providerOf(dir: string): string | null {
  for (let d = dir, i = 0; i < 6 && d.length > 1; d = dirname(d), i++) {
    if (existsSync(join(d, `${basename(d)}.info.yml`))) return basename(d);
  }
  return null;
}
