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

  const sections: string[] = [
    '---',
    `name: ${name}`,
    `description: ${yamlString(description)}`,
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

function stepsFromDetail(value: unknown): SkillStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): SkillStep[] => {
    if (!raw || typeof raw !== 'object') return [];
    const step = raw as Record<string, unknown>;
    const instruction = typeof step.instruction === 'string' ? step.instruction
      : typeof step.summary === 'string' ? step.summary : '';
    if (!instruction.trim()) return [];
    return [{
      title: typeof step.title === 'string' && step.title.trim() ? step.title : `Step ${step.index ?? ''}`.trim(),
      instruction,
      tool: typeof step.tool === 'string' ? step.tool : null,
    }];
  });
}

/** Forge only from repeated successful traces; one lucky run is not a skill. */
export function forgeSkillFromSignals(
  signals: LearningSignal[],
  input: Omit<ForgeSkillInput, 'steps'> & { steps?: SkillStep[] },
): ForgedSkill {
  const successful = signals.filter((signal) => signal.kind === 'tool-success' || signal.kind === 'session-success' || signal.kind === 'gate-passed');
  const tasks = new Set(successful.map((signal) => signal.taskHash ?? signal.sessionId).filter(Boolean));
  if (successful.length < 2 || tasks.size < 2) {
    throw new Error('Skill Forge needs successful evidence from at least two independent tasks or sessions.');
  }
  const steps = input.steps?.length ? input.steps : successful.flatMap((signal) => stepsFromDetail(signal.detail.steps));
  if (!steps.length) throw new Error('The successful signals do not contain a reusable ordered trace.');
  return forgeSkill({ ...input, steps });
}

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
