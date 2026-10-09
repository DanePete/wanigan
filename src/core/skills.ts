// Every skill an agent can see, read from the folders each agent itself reads
// (see src/shared/skills.ts for where those are, and how that was verified).
// Reading is free and silent. Writing happens only on the owner's click: a copy
// is planned first, shown file by file, and applied only if nothing changed in
// between; a removal moves the folder to Wanigan's trash.
import { createHash } from 'node:crypto';
import {
  closeSync, constants as fsc, fchmodSync, fstatSync, lstatSync, mkdirSync, opendirSync, openSync, readSync as fsReadSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync,
  type Stats,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { CoreError } from '../shared/protocol.ts';
import {
  SKILL_NAME, firstProse, frontmatterText, parseFrontmatter,
  type Skill, type SkillAgent, type SkillCopyPlan, type SkillGroup, type SkillRead, type SkillSource, type SkillTarget, type SkillsListing,
} from '../shared/skills.ts';
import type { Accounts } from './accounts.ts';
import type { Board } from './board.ts';
import type { Ctx } from './context.ts';
import { readBoundedFile } from './bounded-file.ts';
import { ConfigReadBudget, ConfigReadRefused, configReadLimits, type ConfigReadLimits } from './config-read.ts';
import { configAccount, configAccounts, configProjects, type ConfigAccount } from './config-roots.ts';
import { installedPlugins, isMissingFile, readClaudeConfig, syncedBucket } from './claude-files.ts';
import { assertInside, display, ensureDir, isLink, moveToTrash, within } from './safe-fs.ts';

const MAX_SKILL_MD = 512 * 1024;
const MAX_COPY_FILES = 1_000;
const MAX_COPY_BYTES = 25 * 1024 * 1024;
const WALK_LIMIT = 4_000;
const SKIP_ON_COPY = new Set(['.DS_Store', '.git']);

/** A folder skills are read from, and what anything found there means. */
interface Root {
  group: Omit<SkillGroup, 'skills'>;
  dir: string;
  /** Writes and removals under this root must stay inside here. */
  anchor: string;
  /** Claude reads one level of folders; Codex walks into subfolders. */
  deep: boolean;
  skip: ReadonlySet<string>;
  removable: boolean;
  accountIds: string[] | 'all';
  projectIds: string[] | 'all';
  plugin: { key: string; name: string; enabled: boolean | null } | null;
}

interface Found { skill: Skill; root: Root; file: string }

export interface SkillsOptions {
  home: string;
  dataDir: string;
  limits?: Partial<ConfigReadLimits>;
}

export class Skills {
  private readonly ctx: Ctx;
  private readonly board: Board;
  private readonly home: string;
  private readonly trash: string;
  private readonly limits: Readonly<ConfigReadLimits>;

  constructor(ctx: Ctx, _accounts: Accounts, board: Board, options: SkillsOptions) {
    this.ctx = ctx;
    this.board = board;
    this.home = options.home;
    this.trash = join(options.dataDir, 'trash', 'skills');
    this.limits = configReadLimits(options.limits);
  }

  list(): SkillsListing {
    const { found, empty, notes } = this.scan(new ConfigReadBudget(this.limits));
    const groups = new Map<string, SkillGroup>();
    for (const f of found) {
      const g = groups.get(f.root.group.id) ?? { ...f.root.group, skills: [] };
      g.skills.push(f.skill);
      groups.set(g.id, g);
    }
    for (const g of groups.values()) g.skills.sort((a, b) => a.name.localeCompare(b.name));
    return {
      groups: [...groups.values()],
      empty,
      notes: [
        'Claude Code’s built-in skills live inside the app itself and are not listed.',
        'Codex’s built-in skills (in each account’s skills/.system) and skills from Codex plugins are not listed.',
        ...notes,
      ],
    };
  }

  read(id: string): SkillRead {
    const budget = new ConfigReadBudget(this.limits);
    const { skill, root, file } = this.find(id, budget);
    const real = this.realFile(root, skill, file);
    budget.take('files');
    const fd = openRead(real);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new CoreError('refused', 'This SKILL.md is not a regular file.');
      const size = Math.min(st.size, MAX_SKILL_MD);
      budget.take('bytes', size);
      const buf = Buffer.alloc(size);
      const n = readSync(fd, buf);
      return { skill, text: buf.subarray(0, n).toString('utf8'), truncated: st.size > MAX_SKILL_MD };
    } finally {
      closeQuietly(fd);
    }
  }

  /**
   * Copy a skill's folder into a project or into the owner's own skills.
   * With `preview`, nothing is written: the plan says exactly what would be.
   * Otherwise the plan is rebuilt and must match the one the owner saw.
   */
  copy(id: string, to: SkillTarget, options: { preview?: boolean; planId?: string; overwrite?: boolean }): { plan: SkillCopyPlan; done: boolean } {
    const budget = new ConfigReadBudget(this.limits);
    const { skill, root } = this.find(id, budget);
    const target = this.target(to, budget);
    const name = skill.dir.split(sep).pop() ?? '';
    if (!SKILL_NAME.test(name)) throw new CoreError('refused', `“${name}” is not a folder name Wanigan will write.`);
    const dest = join(target.root, name);
    assertInside(target.anchor, dest, 'That destination');
    const source = sourceDirectory(root, skill.dir);
    if (realOrSelf(dest) === source) throw new CoreError('refused', 'The skill is already there.');
    const walk = walkForCopy(source);
    if (walk.files.length > MAX_COPY_FILES || walk.bytes > MAX_COPY_BYTES) {
      throw new CoreError('refused', `This skill is too big to copy here (${walk.files.length} files, ${Math.round(walk.bytes / 1024)} KB).`);
    }
    const replaces = existing(dest, budget);
    const fingerprint = createHash('sha256').update(JSON.stringify({
      source, dest, files: walk.files.map((f) => [f.path, f.bytes, f.mode & 0o777, createHash('sha256').update(f.contents).digest('hex')]),
      dirs: walk.dirs, skipped: walk.skipped, replaces,
    })).digest('hex').slice(0, 24);
    const plan: SkillCopyPlan = {
      planId: fingerprint,
      skillId: id,
      name,
      dest,
      displayDest: display(dest, this.home),
      files: walk.files.map((f) => ({ path: f.path, bytes: f.bytes })),
      skipped: walk.skipped,
      totalBytes: walk.bytes,
      replaces,
      inProject: target.projectId !== null,
    };
    if (options.preview) return { plan, done: false };
    if (options.planId !== plan.planId) throw new CoreError('conflict', 'The skill or its destination changed since you looked. Review the copy again.');
    if (replaces && !options.overwrite) throw new CoreError('conflict', `${plan.displayDest} already exists. Replace it?`);

    ensureDir(target.anchor, target.root, 'That destination');
    if (replaces) moveToTrash(dest, this.trash, this.ctx.now());
    mkdirSync(dest);
    try {
      for (const d of walk.dirs) mkdirSync(join(dest, d));
      for (const f of walk.files) {
        const out = join(dest, f.path);
        const fd = openSync(out, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
        try {
          writeFileSync(fd, f.contents);
          fchmodSync(fd, f.mode & 0o777);
        } finally { closeSync(fd); }
      }
    } catch (error) {
      rmSync(dest, { recursive: true, force: true });
      throw new CoreError('internal', `The copy failed and was undone: ${(error as Error).message}`);
    }
    if (target.projectId) {
      this.board.log({ projectId: target.projectId, actor: 'owner', verb: 'copied a skill into the project', detail: `${name} → ${plan.displayDest}` });
    }
    this.ctx.emit('skills', {});
    return { plan, done: true };
  }

  /** Move a skill the owner manages by hand to Wanigan's trash. A linked folder loses only its link. */
  remove(id: string): { removed: string; keptAt: string | null } {
    const budget = new ConfigReadBudget(this.limits);
    const { skill, root } = this.find(id, budget);
    if (!skill.removable || !root.removable) {
      throw new CoreError('refused', skill.source === 'plugin'
        ? 'This skill belongs to a plugin. Remove the plugin in Claude Code (/plugin) instead.'
        : 'Wanigan only removes skills from your own and your projects’ skill folders.');
    }
    if (!within(root.dir, skill.dir) || skill.dir === root.dir) throw new CoreError('refused', 'That folder is not inside its skills folder.');
    assertInside(root.anchor, join(skill.dir, '..'), 'That skill');
    const keptAt = moveToTrash(skill.dir, this.trash, this.ctx.now());
    if (root.group.projectId) {
      this.board.log({ projectId: root.group.projectId, actor: 'owner', verb: 'removed a skill from the project', detail: skill.displayDir });
    }
    this.ctx.emit('skills', {});
    return { removed: skill.displayDir, keptAt: display(keptAt, this.home) };
  }

  /* ── reading ─────────────────────────────────────────────────────────── */

  private find(id: string, budget: ConfigReadBudget): Found {
    if (typeof id !== 'string' || !id) throw new CoreError('invalid', 'Which skill?');
    const hit = this.scan(budget).found.find((f) => f.skill.id === id);
    if (!hit) throw new CoreError('not_found', 'That skill is no longer there.');
    return hit;
  }

  /** SKILL.md as a regular file inside its own folder, or a refusal. */
  private realFile(root: Root, skill: Skill, file: string): string {
    const directory = sourceDirectory(root, skill.dir);
    let real: string;
    try { real = realpathSync(root.plugin ? join(directory, 'SKILL.md') : file); } catch { throw new CoreError('not_found', 'SKILL.md is gone.'); }
    if (!within(directory, real)) throw new CoreError('refused', 'This SKILL.md links outside its folder. Wanigan will not read it.');
    if (!statSync(real).isFile()) throw new CoreError('refused', 'This SKILL.md is not a regular file.');
    return real;
  }

  private scan(budget: ConfigReadBudget): { found: Found[]; empty: SkillsListing['empty']; notes: string[] } {
    const roots = this.roots(budget);
    const found: Found[] = [];
    const empty: SkillsListing['empty'] = [];
    const notes = new Set<string>();
    const unsafePlugin = (): void => { notes.add('Some plugin skill directories could not be read safely and were not listed.'); };
    const seen = new Set<string>();
    for (const root of roots) {
      if (root.plugin) {
        try { if (!pluginDirectory(root, root.dir)) continue; }
        catch (error) { if (error instanceof ConfigReadRefused) throw error; unsafePlugin(); continue; }
      }
      // Two names for one folder (a link, or two accounts on one folder) are read once.
      const real = realOrSelf(root.dir);
      const key = `${root.group.agent}:${real}:${root.plugin?.key ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const before = found.length;
      for (const dir of skillDirs(root, unsafePlugin, budget)) {
        const skill = this.readSkill(root, dir, unsafePlugin, budget);
        if (skill) found.push(skill);
      }
      if (found.length === before && !root.plugin && root.group.source !== 'synced') {
        empty.push({ agent: root.group.agent, where: root.group.projectId ? `${root.group.title}/${root.group.where}` : root.group.where });
      }
    }
    return { found, empty, notes: [...notes] };
  }

  private readSkill(root: Root, dir: string, unsafePlugin: () => void, budget: ConfigReadBudget): Found | null {
    const file = join(dir, 'SKILL.md');
    let directory: string;
    let head = '';
    let unreadable: string | null = null;
    budget.take('files');
    try {
      directory = sourceDirectory(root, dir);
      const real = realpathSync(root.plugin ? join(directory, 'SKILL.md') : file);
      // Listing reads frontmatter too: apply the reader's boundary before opening
      // the file, not only when the owner opens the skill's full text.
      if (!within(directory, real)) unreadable = 'SKILL.md links outside its folder; Wanigan will not read it.';
      else {
        const fd = openRead(real);
        try {
          const st = fstatSync(fd);
          if (!st.isFile()) return null;
          const size = Math.min(st.size, 64 * 1024);
          budget.take('bytes', size);
          const buf = Buffer.alloc(size);
          head = buf.subarray(0, readSync(fd, buf)).toString('utf8');
        } finally {
          closeQuietly(fd);
        }
      }
    } catch (error) {
      if (error instanceof ConfigReadRefused) throw error;
      if (root.plugin) unsafePlugin();
      return null;
    }
    const { data, body } = parseFrontmatter(head);
    budget.value(data);
    const folder = dir.split(sep).pop() ?? '';
    const named = frontmatterText(data, 'name');
    // Claude calls a personal or project skill by its folder; plugins and synced skills by their declared name.
    const name = (root.group.source === 'plugin' || root.group.source === 'synced' || root.group.agent === 'codex') ? (named || folder) : folder;
    const linked = isLink(dir);
    const size = measure(root.plugin ? directory : linked ? realOrSelf(dir) : dir, budget);
    const agent = root.group.agent;
    const skill: Skill = {
      id: createHash('sha256').update(`${agent}\0${root.plugin?.key ?? ''}\0${file}`).digest('base64url').slice(0, 22),
      name,
      description: unreadable ?? (frontmatterText(data, 'description') || firstProse(body) || 'No description.'),
      agent,
      source: root.group.source,
      invoke: agent !== 'claude' ? null
        : root.plugin ? `/${root.plugin.name}:${name}`
          : root.group.source === 'synced' ? null : `/${name}`,
      dir,
      displayDir: display(dir, this.home),
      linkedTo: linked ? safeReadlink(dir) : null,
      plugin: root.plugin?.key ?? null,
      enabled: root.plugin?.enabled ?? null,
      accountIds: root.accountIds,
      projectIds: root.projectIds,
      bytes: size.bytes,
      files: size.files,
      modified: size.modified,
      removable: root.removable && within(root.dir, dir) && dir !== root.dir,
    };
    return { skill, root, file };
  }

  /** Every folder each agent reads skills from, for every account and open project. */
  private roots(budget: ConfigReadBudget): Root[] {
    const accounts = configAccounts(this.ctx.db, budget);
    const projects = configProjects(this.ctx.db, budget);
    const roots: Root[] = [];
    const addRoot = (root: Root): void => { budget.take('items'); roots.push(root); };
    const claude = accounts.filter((a) => a.provider === 'claude');
    const codex = accounts.filter((a) => a.provider === 'codex');
    const none = new Set<string>();

    // Claude Code: each account's own, then each project's, then what plugins and claude.ai add.
    for (const a of claude) {
      const config = this.configDir(a);
      addRoot(this.root({
        agent: 'claude', source: 'personal', title: 'Personal', account: a.label, dir: join(config, 'skills'), anchor: config,
        accountIds: [a.id], projectIds: 'all', removable: true, skip: new Set(['synced']),
      }));
    }
    for (const p of projects) {
      addRoot(this.root({
        agent: 'claude', source: 'project', title: p.name, account: null, projectId: p.id, dir: join(p.path, '.claude', 'skills'), anchor: p.path,
        accountIds: 'all', projectIds: [p.id], removable: true, skip: none, where: '.claude/skills',
      }));
    }
    for (const a of claude) {
      const config = this.configDir(a);
      for (const p of installedPlugins(config, budget)) {
        for (const dir of p.skillDirs) {
          addRoot({
            ...this.root({
              agent: 'claude', source: 'plugin', title: 'Plugins', account: a.label, dir, anchor: p.root,
              accountIds: [a.id], projectIds: 'all', removable: false, skip: none,
              note: 'Installed and updated by Claude Code. Manage them with /plugin.',
              groupKey: `plugins:${config}`, where: display(join(config, 'plugins'), this.home),
            }),
            plugin: { key: p.key, name: p.name, enabled: p.enabled },
          });
        }
      }
    }
    for (const a of claude) {
      const config = this.configDir(a);
      const bucket = syncedBucket(this.globalConfig(a, budget));
      if (!bucket) continue;
      addRoot(this.root({
        agent: 'claude', source: 'synced', title: 'Synced from claude.ai', account: a.label, dir: join(config, 'skills', 'synced', bucket), anchor: config,
        accountIds: [a.id], projectIds: 'all', removable: false, skip: none, where: display(join(config, 'skills', 'synced'), this.home),
        note: 'Kept in step with your claude.ai account by Claude Code. Change them there.',
      }));
    }

    addRoot(this.root({
      agent: 'codex', source: 'personal', title: 'Personal', account: 'every Codex account', dir: join(this.home, '.agents', 'skills'), anchor: this.home,
      accountIds: 'all', projectIds: 'all', removable: true, skip: none, deep: true,
    }));
    for (const a of codex) {
      const home = a.configDir ?? join(this.home, '.codex');
      addRoot(this.root({
        agent: 'codex', source: 'personal', title: 'Personal', account: a.label, dir: join(home, 'skills'), anchor: home,
        accountIds: [a.id], projectIds: 'all', removable: true, skip: none, deep: true,
      }));
    }
    for (const p of projects) {
      for (const folder of ['.agents', '.codex']) {
        addRoot(this.root({
          agent: 'codex', source: 'project', title: p.name, account: null, projectId: p.id, dir: join(p.path, folder, 'skills'), anchor: p.path,
          accountIds: 'all', projectIds: [p.id], removable: true, skip: none, deep: true, where: `${folder}/skills`,
        }));
      }
    }
    return roots;
  }

  private root(r: {
    agent: SkillAgent; source: SkillSource; title: string; account: string | null; projectId?: string; dir: string; anchor: string;
    accountIds: string[] | 'all'; projectIds: string[] | 'all'; removable: boolean; skip: ReadonlySet<string>;
    note?: string; deep?: boolean; groupKey?: string; where?: string;
  }): Root {
    return {
      group: {
        id: createHash('sha256').update(`${r.agent}\0${r.groupKey ?? r.dir}`).digest('base64url').slice(0, 16),
        agent: r.agent, source: r.source, title: r.title, account: r.account, projectId: r.projectId ?? null,
        where: r.where ?? display(r.dir, this.home), note: r.note ?? null,
      },
      dir: r.dir, anchor: r.anchor, deep: r.deep ?? false, skip: r.skip, removable: r.removable,
      accountIds: r.accountIds, projectIds: r.projectIds, plugin: null,
    };
  }

  private configDir(account: ConfigAccount): string {
    return account.configDir ?? join(this.home, '.claude');
  }

  /** Claude Code's state file for an account (see claude-files.ts). */
  private globalConfig(account: ConfigAccount, budget: ConfigReadBudget): Record<string, unknown> | null {
    return readClaudeConfig(account.configDir, this.home, budget);
  }

  /** Where a copy lands, and the folder it may not leave. */
  private target(to: SkillTarget, budget: ConfigReadBudget): { root: string; anchor: string; projectId: string | null } {
    if (!to || typeof to !== 'object') throw new CoreError('invalid', 'Copy it where?');
    const agent = to.agent;
    if (agent !== 'claude' && agent !== 'codex') throw new CoreError('invalid', 'Copy it for which agent?');
    if (to.projectId) {
      const project = configProjects(this.ctx.db, budget, String(to.projectId), true)[0];
      if (!project) throw new CoreError('not_found', 'No such project.');
      return { root: join(project.path, agent === 'claude' ? '.claude' : '.agents', 'skills'), anchor: project.path, projectId: project.id };
    }
    if (agent === 'codex') return { root: join(this.home, '.agents', 'skills'), anchor: this.home, projectId: null };
    const account = to.accountId
      ? configAccount(this.ctx.db, budget, String(to.accountId))
      : configAccounts(this.ctx.db, budget).find((a) => a.provider === 'claude' && a.isDefault);
    if (!account || account.provider !== 'claude') throw new CoreError('invalid', 'Copy it into which Claude account?');
    const config = this.configDir(account);
    return { root: join(config, 'skills'), anchor: config, projectId: null };
  }
}

/* ── folders ───────────────────────────────────────────────────────────── */

/** Plugin aliases stay within their installed root; this is not an atomic filesystem transaction. */
function pluginDirectory(root: Root, dir: string): string | null {
  try {
    if (!within(root.anchor, dir) || realpathSync(root.anchor) !== root.anchor) throw new Error('Changed plugin root.');
    const real = realpathSync(dir);
    if (!within(root.anchor, real)) throw new Error('Outside plugin directory.');
    if (!statSync(real).isDirectory()) return null;
    return real;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && isMissingFile(dir, root.anchor)) return null;
    throw new CoreError('refused', 'This plugin skill directory could not be read safely.');
  }
}

/** Carry the checked canonical source into each read/copy rather than reopening its alias. */
function sourceDirectory(root: Root, dir: string): string {
  if (!root.plugin) return realpathSync(dir);
  const real = pluginDirectory(root, dir);
  if (!real) throw new CoreError('refused', 'This plugin skill directory could not be read safely.');
  return real;
}

/** The skill folders under a root: one level for Claude, any depth for Codex. A folder that is itself a skill is one. */
function skillDirs(root: Root, unsafePlugin: () => void, budget: ConfigReadBudget): string[] {
  if (root.plugin) {
    const out: string[] = [];
    try {
      const real = pluginDirectory(root, root.dir);
      if (!real) return out;
      // A plugin may point straight at one skill's folder. Enumerate the checked
      // canonical directory, not an alias that may now point somewhere else.
      if (pluginSkillFile(real)) return [root.dir];
      for (const name of budget.names(real, true)) {
        if (name.startsWith('.') || root.skip.has(name)) continue;
        try {
          const st = lstatSync(join(real, name));
          if (!st.isDirectory() && !st.isSymbolicLink()) continue;
          const path = join(root.dir, name), child = pluginDirectory(root, path);
          if (child && pluginSkillFile(child)) out.push(path);
        } catch (error) { if (error instanceof ConfigReadRefused) throw error; unsafePlugin(); }
      }
    } catch (error) { if (error instanceof ConfigReadRefused) throw error; unsafePlugin(); }
    return out;
  }
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    for (const name of budget.names(dir)) {
      if (name.startsWith('.') || root.skip.has(name)) continue;
      const path = join(dir, name);
      if (!isDirOrLinkToDir(path)) continue;
      if (isFile(join(path, 'SKILL.md'))) { out.push(path); continue; }
      if (root.deep && depth < 5 && !isLink(path)) visit(path, depth + 1);
    }
  };
  visit(root.dir, 0);
  return out;
}

function pluginSkillFile(dir: string): boolean {
  try { return statSync(join(dir, 'SKILL.md')).isFile(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function measure(dir: string, budget: ConfigReadBudget): { bytes: number; files: number; modified: number } {
  let bytes = 0;
  let files = 0;
  let modified = 0;
  let seen = 0;
  const visit = (d: string, depth: number): void => {
    for (const name of budget.names(d)) {
      if (++seen > WALK_LIMIT) return;
      const path = join(d, name);
      let st: Stats;
      try { st = lstatSync(path); } catch { continue; }
      if (st.isDirectory()) { if (depth < 8) visit(path, depth + 1); continue; }
      if (!st.isFile()) continue;
      files++;
      bytes += st.size;
      modified = Math.max(modified, st.mtimeMs);
    }
  };
  visit(dir, 0);
  return { bytes, files, modified: Math.round(modified) };
}

interface CopyWalk {
  dirs: string[];
  files: { path: string; bytes: number; mode: number; contents: Buffer }[];
  skipped: { path: string; why: string }[];
  bytes: number;
}

/** Capture what a copy would write, within limits. Internal links are skipped, never followed deliberately. */
function walkForCopy(source: string): CopyWalk {
  const walk: CopyWalk = { dirs: [], files: [], skipped: [], bytes: 0 };
  let entries = 0;
  const directories: { path: string; dev: number; ino: number }[] = [];
  const checkDirectories = (): void => {
    // Detect replaced ancestors around each capture. Path checks cannot exclude
    // an external writer swapping and restoring a directory between syscalls.
    for (const expected of directories) {
      const current = lstatSync(expected.path);
      if (!current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino
        || realpathSync(expected.path) !== expected.path) {
        throw new CoreError('refused', 'The skill directory changed while it was being read. Review the copy again.');
      }
    }
  };
  const copyNames = (path: string): string[] => {
    const dir = opendirSync(path);
    const out: string[] = [];
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++entries > WALK_LIMIT) throw new CoreError('refused', 'This skill has too many entries to copy here.');
        out.push(entry.name);
      }
    } finally { dir.closeSync(); }
    return out.sort();
  };
  const visit = (dir: string, depth: number, identity: Stats): void => {
    directories.push({ path: dir, dev: identity.dev, ino: identity.ino });
    checkDirectories();
    const children = copyNames(dir);
    checkDirectories();
    for (const name of children) {
      checkDirectories();
      const path = join(dir, name);
      const rel = relative(source, path);
      if (SKIP_ON_COPY.has(name)) { walk.skipped.push({ path: rel, why: name === '.git' ? 'git data' : 'Finder file' }); continue; }
      const st = lstatSync(path);
      if (st.isSymbolicLink()) { walk.skipped.push({ path: rel, why: 'a link' }); continue; }
      if (st.isDirectory()) {
        if (depth >= 8) { walk.skipped.push({ path: rel, why: 'too deep' }); continue; }
        walk.dirs.push(rel);
        visit(path, depth + 1, st);
        continue;
      }
      if (!st.isFile()) { walk.skipped.push({ path: rel, why: 'not a regular file' }); continue; }
      if (walk.files.length >= MAX_COPY_FILES || st.size > MAX_COPY_BYTES - walk.bytes) {
        throw new CoreError('refused', 'This skill is too big to copy here.');
      }
      let contents: Buffer;
      checkDirectories();
      try { contents = readBoundedFile(path, MAX_COPY_BYTES - walk.bytes); }
      catch (error) { throw new CoreError('refused', `Cannot copy ${rel}: ${(error as Error).message}`); }
      checkDirectories();
      walk.files.push({ path: rel, bytes: contents.length, mode: st.mode, contents });
      walk.bytes += contents.length;
    }
    checkDirectories();
    directories.pop();
  };
  try { visit(source, 0, lstatSync(source)); }
  catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError('refused', `Cannot read the skill for copying: ${(error as Error).message}`);
  }
  return walk;
}

function existing(path: string, budget: ConfigReadBudget): SkillCopyPlan['replaces'] {
  let st: Stats;
  try { st = lstatSync(path); } catch { return null; }
  if (st.isSymbolicLink()) return { files: 0, linkedTo: safeReadlink(path) };
  return { files: st.isDirectory() ? measure(path, budget).files : 1, linkedTo: null };
}

function realOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function safeReadlink(path: string): string | null {
  try { return readlinkSync(path); } catch { return null; }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function isDirOrLinkToDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function openRead(file: string): number {
  return openSync(file, fsc.O_RDONLY | (fsc.O_NONBLOCK ?? 0));
}

function readSync(fd: number, buf: Buffer): number {
  return fsReadSync(fd, buf, 0, buf.length, 0);
}

function closeQuietly(fd: number): void {
  try { closeSync(fd); } catch { /* already closed */ }
}
