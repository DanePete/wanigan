// The skills methods. Owner-only (see ACCESS); every path is resolved by the
// core from its own listing, never taken from the caller.
import { CoreError } from '../shared/protocol.ts';
import type { SkillTarget } from '../shared/skills.ts';
import type { Handlers } from './handlers.ts';
import type { Skills } from './skills.ts';

type SkillMethods = 'skills.list' | 'skills.read' | 'skills.copy' | 'skills.remove';

export function skillsHandlers(skills: Skills): Pick<Handlers, SkillMethods> {
  return {
    'skills.list': () => skills.list(),
    'skills.read': (p) => skills.read(id(p.id)),
    'skills.copy': (p) => skills.copy(id(p.id), target(p.to), {
      preview: p.preview === true,
      planId: typeof p.planId === 'string' ? p.planId : undefined,
      overwrite: p.overwrite === true,
    }),
    'skills.remove': (p) => skills.remove(id(p.id)),
  };
}

function id(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 64) throw new CoreError('invalid', 'Which skill?');
  return v;
}

function target(v: unknown): SkillTarget {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new CoreError('invalid', 'Copy it where?');
  const t = v as Record<string, unknown>;
  if (t.agent !== 'claude' && t.agent !== 'codex' && t.agent !== 'gemini') throw new CoreError('invalid', 'Copy it for which agent?');
  const optional = (x: unknown, what: string): string | null => {
    if (x === undefined || x === null || x === '') return null;
    if (typeof x !== 'string') throw new CoreError('invalid', `Which ${what}?`);
    return x;
  };
  return { agent: t.agent, projectId: optional(t.projectId, 'project'), accountId: optional(t.accountId, 'account') };
}
