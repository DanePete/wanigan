import fs from 'node:fs';
import path from 'node:path';
import { createProjectionPreview } from './projections';
import { getCandidate } from './repository';
/* ── helper sweep · P4 cost ── */
// The content builders live in shared so test:shared can hold their bytes
// stable (src/shared/projection-content.test.ts).
import {
  canonicalSelectors, codexDirectoryScope, dominantEol, managedMarkdown as managedContent, pathRuleFrontmatter,
  skillBody as skillContent, slug, stripLeadingFrontmatter,
} from '../../shared/projection-content';
import type {
  ArtifactCompilation, ArtifactCompilerContext, KnowledgeCandidate, ProjectionSafety,
  ProviderArtifactCompiler,
} from './types';

const MAX_EXISTING_BYTES = 512 * 1024;

function reader(context: ArtifactCompilerContext): (file: string) => string | null {
  if (context.readExisting) return context.readExisting;
  return (file) => {
    let st: fs.Stats;
    try { st = fs.lstatSync(file); } catch { return null; }
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_EXISTING_BYTES) return null;
    const bytes = fs.readFileSync(file);
    return bytes.includes(0) ? null : bytes.toString('utf8');
  };
}

function managedMarkdown(existing: string | null, candidate: KnowledgeCandidate): string {
  return managedContent(existing, { key: candidate.itemId ?? candidate.id, title: candidate.title, proposedText: candidate.proposedText });
}

function skillBody(candidate: KnowledgeCandidate): string {
  return skillContent({ title: candidate.title, rationale: candidate.rationale, proposedText: candidate.proposedText });
}

function result(
  candidate: KnowledgeCandidate,
  context: ArtifactCompilerContext,
  adapterId: string,
  mode: ArtifactCompilation['mode'],
  reason: string,
  targetPath: string | null = null,
  targetFormat: string | null = null,
  proposedContent: string | null = null,
  nativeMemoryAccess: ArtifactCompilation['nativeMemoryAccess'] = 'read-only',
): ArtifactCompilation {
  void candidate;
  return {
    supported: mode !== 'unsupported', mode, providerId: context.providerId, adapterId,
    reason, targetPath, targetFormat, proposedContent, nativeMemoryAccess,
  };
}

function requireProjectRoot(context: ArtifactCompilerContext): string {
  if (!context.projectRoot || !path.isAbsolute(context.projectRoot)) {
    throw new Error('This artifact needs an absolute project root.');
  }
  return path.resolve(context.projectRoot);
}

function requireHomeDir(context: ArtifactCompilerContext): string {
  if (!path.isAbsolute(context.homeDir)) throw new Error('Personal artifacts need an absolute home directory.');
  return path.resolve(context.homeDir);
}

function internalDelivery(
  candidate: KnowledgeCandidate,
  context: ArtifactCompilerContext,
  adapterId: string,
): ArtifactCompilation | null {
  if (candidate.targetKind === 'memory' || candidate.targetKind === 'mission') {
    return result(
      candidate, context, adapterId, 'briefing',
      'Wanigan retrieves this canonical knowledge just in time. Provider-generated memory stays read-only.',
    );
  }
  // A project map is topology, not a sentence an agent can act on: the
  // briefing builder refuses the kind (INJECTABLE_KINDS), so reporting
  // 'briefing' here promised a delivery that never happens. No provider file
  // is honest either, so the answer is unsupported with the reason, and the
  // item stays retrievable in Wanigan's own views.
  if (candidate.targetKind === 'project-map') {
    return result(
      candidate, context, adapterId, 'unsupported',
      'A project map is never briefed and has no provider file; it stays retrievable in Wanigan only.',
    );
  }
  // `gate` and `eval` used to return 'wanigan-gate' and 'wanigan-eval' with a
  // sentence about compiling through Wanigan's policy gates and golden cases.
  // Both strings had zero consumers anywhere in the tree: neither kind is in
  // INJECTABLE_KINDS, so neither is ever briefed, and applyCandidateToProvider
  // throws on both -- so a claim routed here reached nothing at all, silently,
  // while the UI told the operator it had compiled to a review gate. There is
  // no gate engine and no eval runner. Falling through to the kind guards below
  // returns 'unsupported' with a reason, which is the truth, and the item stays
  // readable in Wanigan's own views. The kinds themselves survive in
  // KNOWLEDGE_KINDS so existing rows still read and list.
  return null;
}

function claudeCompile(candidate: KnowledgeCandidate, context: ArtifactCompilerContext): ArtifactCompilation {
  const adapterId = 'claude-code';
  const internal = internalDelivery(candidate, context, adapterId);
  if (internal) return internal;

  if (candidate.targetKind === 'skill') {
    const base = candidate.scope === 'personal'
      ? path.join(requireHomeDir(context), '.claude', 'skills')
      : path.join(requireProjectRoot(context), '.claude', 'skills');
    const target = path.join(base, slug(candidate.title), 'SKILL.md');
    return result(candidate, context, adapterId, 'file', 'Claude Code supports personal and project skills.', target, 'claude-skill', skillBody(candidate));
  }

  if (candidate.targetKind !== 'instruction' && candidate.targetKind !== 'rule') {
    return result(candidate, context, adapterId, 'unsupported', `Claude compiler has no honest mapping for ${candidate.targetKind}.`);
  }

  let target: string;
  if (candidate.scope === 'personal') {
    target = path.join(requireHomeDir(context), '.claude', 'CLAUDE.md');
  } else if (candidate.scope === 'path') {
    const root = requireProjectRoot(context);
    target = path.join(root, '.claude', 'rules', `${slug(candidate.title)}.md`);
    const selectors = canonicalSelectors(candidate.pathScope);
    if (!selectors.length) return result(candidate, context, adapterId, 'unsupported', 'Claude path rules require at least one path selector.');
    // Claude Code honors `paths:` frontmatter only as the first bytes of the
    // rule file; buried anywhere else the rule silently loads for every path.
    // The frontmatter therefore precedes the managed block, and any prior
    // leading frontmatter is replaced — one file cannot carry two scopes.
    const existing = stripLeadingFrontmatter(reader(context)(target));
    const eol = dominantEol(existing);
    const frontmatter = pathRuleFrontmatter(selectors, eol);
    return result(
      candidate, context, adapterId, 'file', 'Compiled to Claude Code native scoped instructions.',
      target, 'claude-path-rule', frontmatter + managedMarkdown(existing, candidate),
    );
  } else {
    target = path.join(requireProjectRoot(context), 'CLAUDE.md');
  }
  const existing = reader(context)(target);
  return result(candidate, context, adapterId, 'file', 'Compiled to Claude Code native scoped instructions.', target, 'claude-instructions', managedMarkdown(existing, candidate));
}

function codexCompile(candidate: KnowledgeCandidate, context: ArtifactCompilerContext): ArtifactCompilation {
  const adapterId = 'codex';
  const internal = internalDelivery(candidate, context, adapterId);
  if (internal) return internal;

  if (candidate.targetKind === 'skill') {
    const base = candidate.scope === 'personal'
      ? path.join(requireHomeDir(context), '.agents', 'skills')
      : path.join(requireProjectRoot(context), '.agents', 'skills');
    const target = path.join(base, slug(candidate.title), 'SKILL.md');
    return result(candidate, context, adapterId, 'file', 'Codex supports personal and project Agent Skills.', target, 'agent-skill', skillBody(candidate));
  }

  if (candidate.targetKind !== 'instruction' && candidate.targetKind !== 'rule') {
    return result(candidate, context, adapterId, 'unsupported', `Codex compiler has no honest mapping for ${candidate.targetKind}.`);
  }

  let target: string;
  if (candidate.scope === 'personal') {
    target = path.join(requireHomeDir(context), '.codex', 'AGENTS.md');
  } else if (candidate.scope === 'path') {
    const dir = codexDirectoryScope(candidate.pathScope ?? '');
    if (!dir) {
      return result(
        candidate, context, adapterId, 'unsupported',
        'Codex nested AGENTS.md can express directory scope, but not this file glob. Keep it in Wanigan retrieval instead of broadening it silently.',
      );
    }
    target = path.join(requireProjectRoot(context), dir, 'AGENTS.md');
  } else {
    target = path.join(requireProjectRoot(context), 'AGENTS.md');
  }
  const existing = reader(context)(target);
  return result(candidate, context, adapterId, 'file', 'Compiled to Codex native AGENTS.md instructions.', target, 'codex-agents', managedMarkdown(existing, candidate));
}

export const CLAUDE_ARTIFACT_COMPILER: ProviderArtifactCompiler = {
  adapterId: 'claude-code',
  nativeMemoryAccess: 'read-only',
  compile: claudeCompile,
};

export const CODEX_ARTIFACT_COMPILER: ProviderArtifactCompiler = {
  adapterId: 'codex',
  nativeMemoryAccess: 'read-only',
  compile: codexCompile,
};

export const BUILTIN_ARTIFACT_COMPILERS: readonly ProviderArtifactCompiler[] = [
  CLAUDE_ARTIFACT_COMPILER,
  CODEX_ARTIFACT_COMPILER,
];

export function compileCandidate(
  candidateId: string,
  compiler: ProviderArtifactCompiler,
  context: ArtifactCompilerContext,
): ArtifactCompilation {
  const candidate = getCandidate(candidateId);
  if (!candidate) throw new Error('Learning candidate not found.');
  return compiler.compile(candidate, context);
}

/** Compiles and stores a preview; it never applies the generated file. */
export function compileCandidateProjection(
  candidateId: string,
  compiler: ProviderArtifactCompiler,
  context: ArtifactCompilerContext,
  safety?: Omit<ProjectionSafety, 'actor'>,
) {
  const candidate = getCandidate(candidateId);
  if (!candidate) throw new Error('Learning candidate not found.');
  const compiled = compiler.compile(candidate, context);
  if (!compiled.supported || compiled.mode !== 'file' || !compiled.targetPath || compiled.proposedContent == null || !compiled.targetFormat) {
    return { compiled, projection: null };
  }
  const projection = createProjectionPreview({
    candidateId: candidate.id,
    itemId: candidate.itemId,
    providerId: compiled.providerId,
    adapterId: compiled.adapterId,
    scope: candidate.scope,
    projectId: candidate.projectId,
    targetPath: compiled.targetPath,
    targetFormat: compiled.targetFormat,
    proposedContent: compiled.proposedContent,
  }, safety);
  return { compiled, projection };
}
