import fs from 'node:fs';
import path from 'node:path';
import { discoverSkills, refreshSkills } from './skills';
import { codexHomeForProject, codexSkillRows } from './context/codex-loader';
import { estimateTokens } from '../shared/tokens';
import { claudeSkillListingLine, withDisableModelInvocation } from '../shared/agent-frontmatter';
import { withImplicitInvocation } from '../shared/codex-loader';
import type { SkillListingReport, SkillListingRow } from '../shared/cost-types';

/**
 * What each harness puts in front of the model every turn about skills, and
 * the one switch that takes a skill out of that listing while leaving it
 * invocable by name.
 *
 * Claude Code reads `disable-model-invocation` in SKILL.md; Codex reads
 * `policy.allow_implicit_invocation` in the skill's `agents/openai.yaml`
 * (the shape Codex's own bundled skills ship, verified on disk under
 * ~/.codex/skills/.system). The token figures are estimates of the listing
 * line — name and description — and are labelled so.
 *
 * The switch is offered only for personal skills Wanigan itself applied. A
 * project skill is shared with everyone who clones the repository, so a change
 * to it is a proposal for the review inbox, not a button here; a personal skill
 * someone wrote by hand is theirs to edit, not Wanigan's.
 */

function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.wanigan-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, text, { mode: (() => { try { return fs.statSync(file).mode & 0o777; } catch { return 0o644; } })() });
  fs.renameSync(tmp, file);
}

/** `homeDir`/`codexHome` exist for the smoke suite, which must never touch the real home; IPC passes neither. */
type ListingOptions = { homeDir?: string; codexHome?: string };

export function skillListing(projectId: string | null, options: ListingOptions = {}): SkillListingReport {
  const catalogue = discoverSkills(projectId ?? undefined, { homeDir: options.homeDir });
  const claudeRows: SkillListingRow[] = catalogue.skills.map((skill) => {
    const listed = skill.invocable.model === false ? false : skill.invocable.model === true ? true : 'unknown';
    const personal = skill.source === 'user';
    const managed = skill.projection?.status === 'applied';
    return {
      harness: 'claude-code', name: skill.name, description: skill.description, path: skill.path, source: skill.source,
      listed, decidedBy: skill.invocable.decidedBy ? (skill.invocable.override ? 'skillOverrides' : 'disable-model-invocation') : 'default',
      personal, managed, toggle: personal && managed,
      estTokens: listed === false ? 0 : estimateTokens(claudeSkillListingLine(skill)),
    };
  });

  const home = options.codexHome ? { dir: options.codexHome } : codexHomeForProject(projectId);
  const projections = new Map(catalogue.agentSkills.map((skill) => [skill.path, skill.projection] as const));
  const codexRows: SkillListingRow[] = codexSkillRows(projectId, home.dir, options.homeDir).map((row) => {
    const personal = row.root === 'personal';
    const managed = projections.get(row.path)?.status === 'applied';
    return {
      harness: 'codex', name: row.name, description: row.description, path: row.path, source: row.root,
      listed: row.implicit === 'unknown' ? 'unknown' : row.listed,
      decidedBy: row.implicit === null ? 'default' : 'allow_implicit_invocation',
      personal, managed, toggle: personal && managed, estTokens: row.estTokens,
    };
  });

  const summary = (harness: 'claude-code' | 'codex', label: string, rows: SkillListingRow[]) => ({
    harness, label,
    listed: rows.filter((r) => r.listed === true).length,
    hidden: rows.filter((r) => r.listed === false).length,
    unknown: rows.filter((r) => r.listed === 'unknown').length,
    estTokens: rows.reduce((sum, r) => sum + r.estTokens, 0),
    rows,
  });

  return {
    providers: [summary('claude-code', 'Claude Code', claudeRows), summary('codex', 'Codex', codexRows)],
    codexHome: home.dir,
    note:
      'Token figures estimate each listed skill’s name and description, the part a harness shows the model every turn; ' +
      'the skill body loads only when the skill is used. A skill whose setting Wanigan cannot read is counted as listed.',
  };
}

export function setSkillModelInvocation(input: { projectId: string | null; harness: unknown; path: unknown; allow: unknown }, options: ListingOptions = {}): SkillListingReport {
  if (input.harness !== 'claude-code' && input.harness !== 'codex') throw new Error('Choose Claude Code or Codex.');
  if (typeof input.path !== 'string' || typeof input.allow !== 'boolean') throw new Error('That switch was not a skill and an on/off choice.');
  refreshSkills();
  const provider = skillListing(input.projectId, options).providers.find((p) => p.harness === input.harness);
  const row = provider?.rows.find((r) => r.path === input.path);
  if (!row) throw new Error('That skill is not in the current catalogue. Rescan and try again.');
  if (!row.personal) throw new Error('Project skills are shared with the repository; propose the change through the review inbox instead.');
  if (!row.managed) throw new Error('Wanigan only switches personal skills it applied itself. Edit this skill’s file directly.');

  if (input.harness === 'claude-code') {
    const text = fs.readFileSync(row.path, 'utf8');
    atomicWrite(row.path, withDisableModelInvocation(text, !input.allow));
  } else {
    const yaml = path.join(path.dirname(row.path), 'agents', 'openai.yaml');
    let existing = '';
    try { existing = fs.readFileSync(yaml, 'utf8'); } catch { /* a skill with no openai.yaml gets one holding only the policy */ }
    fs.mkdirSync(path.dirname(yaml), { recursive: true });
    if (existing) atomicWrite(yaml, withImplicitInvocation(existing, input.allow));
    else fs.writeFileSync(yaml, withImplicitInvocation('', input.allow), { mode: 0o644 });
  }
  refreshSkills();
  return skillListing(input.projectId, options);
}
