import { getSetting, setSetting } from './settings';
import { projectById } from './store';
import {
  normaliseTemplates, parseStoredTemplates, renderBranch, renderTitle,
  type NamingInput, type NamingTemplates,
} from '../shared/naming-templates';
import type { Project } from '../shared/types';

/**
 * Per-project naming templates, stored in Wanigan's settings table — never in
 * the repository — and applied where sessions.ts derives a title and cuts a
 * worktree branch. See shared/naming-templates.ts for the rules.
 */

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

function key(projectId: string): string {
  return `naming.${projectId}`;
}

export function namingTemplates(projectId: unknown): NamingTemplates {
  if (typeof projectId !== 'string' || !ID.test(projectId)) return { title: null, branch: null };
  return parseStoredTemplates(getSetting(key(projectId), '') || null);
}

export function setNamingTemplates(projectId: unknown, input: unknown): NamingTemplates {
  if (typeof projectId !== 'string' || !ID.test(projectId) || !projectById(projectId)) throw new Error('Choose a project first.');
  const t = normaliseTemplates(input);
  setSetting(key(projectId), t.title === null && t.branch === null ? '' : JSON.stringify(t));
  return t;
}

function inputFor(project: Project, prompt: string | null, sessionId: string): NamingInput {
  return { prompt, projectName: project.name, projectBranch: project.branch, sessionId, now: Date.now() };
}

/** The derived title for a launch prompt, through the project's template when it has one. */
export function launchTitle(project: Project, prompt: string | null, sessionId: string): string | null {
  return renderTitle(namingTemplates(project.id).title, inputFor(project, prompt, sessionId));
}

/** The worktree branch for a launch, or null to keep worktrees.ts's own default. */
export function launchBranch(project: Project, prompt: string | null, sessionId: string): string | null {
  const template = namingTemplates(project.id).branch;
  return template ? renderBranch(template, inputFor(project, prompt, sessionId)) : null;
}
