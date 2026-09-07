import fs from 'node:fs';
import path from 'node:path';
import type {
  ForgeSkillInput, ForgedSkill, LearningSignal, SkillDiagnostic, SkillStep,
} from './types';
import { estimateTokens, uniqueStrings } from './util';

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!SKILL_NAME.test(name) || name.length > 64) {
    throw new Error('Skill name must be 1–64 lowercase letters, numbers, or single hyphens.');
  }
  return name;
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, ' ').trim());
}

/**
 * The combined cap the skill listing applies to `description` + `when_to_use`.
 *
 * Documented as 1,536 characters "to reduce context usage". Named here because
 * two fields are written against it and a number spelled twice is a number that
 * drifts.
 */
const SKILL_LISTING_BUDGET = 1_536;

export function forgeSkill(input: ForgeSkillInput): ForgedSkill {
  const name = validName(input.name);
  const description = input.description.trim();
  const trigger = input.trigger.trim();
  if (!description || description.length > 1_024) throw new Error('Skill description must be 1–1,024 characters.');
  if (!trigger) throw new Error('Skill trigger is required.');
  if (!input.steps.length) throw new Error('A skill needs at least one workflow step.');
  if (!input.verification.length) throw new Error('A skill needs deterministic verification.');
  const steps = input.steps.slice(0, 50).map((step, index) => normalizeStep(step, index));
  const allowedTools = uniqueStrings(input.allowedTools ?? [], 50);
  const providerIds = uniqueStrings(input.providerIds ?? [], 50);

  // `when_to_use` is a real frontmatter field, and it is the one that decides
  // whether the skill is ever loaded: the docs say it is "appended to
  // description in the skill listing", which is the text an agent reads while
  // choosing. The trigger used to exist only as the "## When to use" section
  // below — inside the body, which an agent sees only after it has already
  // decided to load the skill. The prose stays too, for whoever opens the file.
  //
  // The listing truncates description + when_to_use at 1,536 characters
  // together, so the second field is given what the first leaves rather than a
  // fixed cap of its own; past that the trigger would be silently cut off in
  // the one place it had to survive.
  const triggerBudget = Math.max(0, SKILL_LISTING_BUDGET - description.length);
  const listedTrigger = trigger.length > triggerBudget ? trigger.slice(0, triggerBudget).trimEnd() : trigger;

  const sections: string[] = [
    '---',
    `name: ${name}`,
    `description: ${yamlString(description)}`,
    ...(listedTrigger ? [`when_to_use: ${yamlString(listedTrigger)}`] : []),
    '---',
    '',
    `# ${titleCase(name)}`,
    '',
    '## When to use',
    '',
    trigger,
  ];
  if (input.inputs?.length) {
    sections.push('', '## Inputs', '', ...input.inputs.map((value) => `- ${value.trim()}`).filter((value) => value !== '- '));
  }
  sections.push('', '## Workflow', '');
  for (const [index, step] of steps.entries()) {
    sections.push(`${index + 1}. **${step.title}** — ${step.instruction}${step.tool ? ` Use \`${step.tool}\`.` : ''}`);
  }
  if (input.safety?.length) {
    sections.push('', '## Safety', '', ...input.safety.map((value) => `- ${value.trim()}`).filter((value) => value !== '- '));
  }
  sections.push('', '## Verification', '', ...input.verification.map((value) => `- ${value.trim()}`).filter((value) => value !== '- '), '');
  const skillMd = sections.join('\n');
  return { name, scope: input.scope, skillMd, allowedTools, providerIds, estimatedTokens: estimateTokens(skillMd) };
}

function normalizeStep(step: SkillStep, index: number): SkillStep {
  const title = step.title.trim();
  const instruction = step.instruction.trim();
  if (!title || !instruction) throw new Error(`Skill step ${index + 1} needs a title and instruction.`);
  return { title, instruction, tool: step.tool?.trim() || null };
}

function titleCase(name: string): string {
  return name.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ');
}

/**
 * `stepsFromDetail` and `forgeSkillFromSignals` used to live here: mine a skill
 * out of repeated successful traces. Both had zero callers, and were never
 * going to have one, for two independent reasons.
 *
 * They select the exact class of observation `claimPossible` exists to exclude
 * -- a repeated success carries no claim, and asking anything to phrase one
 * buys confident invention rather than a lesson. And they read
 * `signal.detail.steps`, an ordered trace of what the agent did, which is a
 * transcript: the thing `learning_signals` is specified to hold bounded
 * summaries and citations instead of. No producer ever wrote that field, so the
 * function would have thrown on the first call it never received.
 *
 * A skill still reaches disk two ways, and both start with a person: the Skill
 * Forge in the Skills view, and Teach Wanigan with Kind = Skill seed.
 */

function frontmatter(skillMd: string): { values: Record<string, string>; endLine: number } {
  if (!skillMd.startsWith('---\n')) return { values: {}, endLine: 0 };
  const lines = skillMd.split('\n');
  const values: Record<string, string> = {};
  let endLine = 0;
  for (let i = 1; i < Math.min(lines.length, 100); i++) {
    if (lines[i].trim() === '---') { endLine = i + 1; break; }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (match) values[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return { values, endLine };
}

export interface SkillDoctorOptions {
  root?: string | null;
  knownSkills?: { name: string; description: string }[];
}

export function doctorSkill(skillMd: string, options: SkillDoctorOptions = {}): SkillDiagnostic[] {
  const diagnostics: SkillDiagnostic[] = [];
  const lines = skillMd.split('\n');
  const fm = frontmatter(skillMd);
  if (!fm.endLine) diagnostics.push({ code: 'missing-frontmatter', severity: 'error', message: 'SKILL.md needs YAML frontmatter.' });
  const name = fm.values.name ?? '';
  const description = fm.values.description ?? '';
  if (!SKILL_NAME.test(name) || name.length > 64) diagnostics.push({ code: 'invalid-name', severity: 'error', message: 'Frontmatter name is missing or invalid.' });
  if (!description) diagnostics.push({ code: 'missing-description', severity: 'error', message: 'A trigger-rich description is required.' });
  else {
    if (description.length > 1_024) diagnostics.push({ code: 'long-description', severity: 'warning', message: 'Description exceeds 1,024 characters.' });
    if (!/\b(use|when|for|after|before|whenever)\b/i.test(description)) {
      diagnostics.push({ code: 'weak-trigger', severity: 'warning', message: 'Description does not say when the skill should trigger.' });
    }
  }
  if (lines.length > 500) diagnostics.push({ code: 'oversized-main', severity: 'warning', message: 'SKILL.md is over 500 lines; move detail into references or scripts.' });
  if (!/^##?\s+(verification|verify|validation|done|completion)\b/im.test(skillMd)) {
    diagnostics.push({ code: 'missing-verification', severity: 'error', message: 'Skill has no explicit verification section.' });
  }
  if (/\brm\s+-rf\b|\bsudo\b|curl\s+[^\n|]+\|\s*(?:sh|bash|zsh)\b/i.test(skillMd)) {
    diagnostics.push({ code: 'dangerous-command', severity: 'error', message: 'Skill contains a destructive or unverified privileged command.' });
  }
  const references = [...skillMd.matchAll(/(?:\]\(|`)((?:references|scripts|assets)\/[^)`\s]+)[)`]?/g)].map((m) => m[1]);
  if (options.root) {
    for (const reference of uniqueStrings(references)) {
      const target = path.resolve(options.root, reference);
      const rel = path.relative(path.resolve(options.root), target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        diagnostics.push({ code: 'escaping-reference', severity: 'error', message: `Reference escapes the skill directory: ${reference}` });
      } else if (!fs.existsSync(target)) {
        diagnostics.push({ code: 'dead-reference', severity: 'warning', message: `Referenced helper does not exist: ${reference}` });
      }
    }
  }
  for (const other of options.knownSkills ?? []) {
    if (other.name === name) continue;
    const overlap = jaccard(triggerTerms(description), triggerTerms(other.description));
    if (overlap >= 0.7) {
      diagnostics.push({ code: 'overlapping-trigger', severity: 'warning', message: `Trigger substantially overlaps skill "${other.name}" (${Math.round(overlap * 100)}%).` });
    }
  }
  return diagnostics;
}

function triggerTerms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((word) => !['when', 'with', 'that', 'this', 'from', 'into', 'your', 'skill', 'using'].includes(word)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / (a.size + b.size - intersection);
}
