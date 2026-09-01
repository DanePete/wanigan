import fs from 'node:fs';
import path from 'node:path';
import { createProjectionPreview } from './projections';
import { getCandidate } from './repository';
import type {
  ArtifactCompilation, ArtifactCompilerContext, KnowledgeCandidate, ProjectionSafety,
  ProviderArtifactCompiler,
} from './types';

const MAX_EXISTING_BYTES = 512 * 1024;

function slug(value: string): string {
  const result = value.normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return result || 'wanigan-skill';
}

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

function dominantEol(existing: string | null): '\n' | '\r\n' {
  if (!existing) return '\n';
  const crlf = (existing.match(/\r\n/g) ?? []).length;
  const lf = (existing.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

function stripLeadingFrontmatter(existing: string | null): string | null {
  if (existing == null) return null;
  const match = /^---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n)*/.exec(existing);
  return match ? existing.slice(match[0].length) : existing;
}

function managedMarkdown(existing: string | null, candidate: KnowledgeCandidate): string {
  const key = candidate.itemId ?? candidate.id;
  const begin = `<!-- wanigan:begin ${key} -->`;
  const end = `<!-- wanigan:end ${key} -->`;
  // Splicing LF into a CRLF file leaves mixed endings that trip whitespace
  // checks, so the block adopts the surrounding file's dominant ending.
  const eol = dominantEol(existing);
  const body = candidate.proposedText
    .replaceAll('<!-- wanigan:begin', '<!-- wanigan-user:begin')
    .replaceAll('<!-- wanigan:end', '<!-- wanigan-user:end')
    .trim().replace(/\r?\n/g, eol);
  const block = `${begin}${eol}## ${candidate.title}${eol}${eol}${body}${eol}${end}`;
  const source = (existing ?? '').trimEnd();
  const start = source.indexOf(begin);
  const finish = start === -1 ? -1 : source.indexOf(end, start + begin.length);
  if (start !== -1 && finish !== -1) {
    return `${source.slice(0, start)}${block}${source.slice(finish + end.length)}`.trimEnd() + eol;
  }
  return source ? `${source}${eol}${eol}${block}${eol}` : `${block}${eol}`;
}

function skillBody(candidate: KnowledgeCandidate): string {
  const content = candidate.proposedText.trim();
  if (content.startsWith('---\n')) return `${content}\n`;
  return `---\nname: ${slug(candidate.title)}\ndescription: ${JSON.stringify(candidate.rationale.slice(0, 500))}\n---\n\n# ${candidate.title}\n\n${content}\n`;
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
  if (candidate.targetKind === 'memory' || candidate.targetKind === 'mission' || candidate.targetKind === 'project-map') {
    return result(
      candidate, context, adapterId, 'briefing',
      'Wanigan retrieves this canonical knowledge just in time. Provider-generated memory stays read-only.',
    );
  }
  if (candidate.targetKind === 'gate') {
    return result(candidate, context, adapterId, 'wanigan-gate', 'Compile through Wanigan policy/review gates, not a guessed provider file.');
  }
  if (candidate.targetKind === 'eval') {
    return result(candidate, context, adapterId, 'wanigan-eval', 'Store as a Wanigan golden case/evaluation shared by providers.');
  }
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
    const selectors = (candidate.pathScope ?? '').split(/[\n,]/).map((v) => v.trim()).filter(Boolean);
    if (!selectors.length) return result(candidate, context, adapterId, 'unsupported', 'Claude path rules require at least one path selector.');
    // Claude Code honors `paths:` frontmatter only as the first bytes of the
    // rule file; buried anywhere else the rule silently loads for every path.
    // The frontmatter therefore precedes the managed block, and any prior
    // leading frontmatter is replaced — one file cannot carry two scopes.
    const existing = stripLeadingFrontmatter(reader(context)(target));
    const eol = dominantEol(existing);
    const frontmatter = `---${eol}paths:${eol}${selectors.map((v) => `  - ${JSON.stringify(v)}`).join(eol)}${eol}---${eol}${eol}`;
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

function codexDirectoryScope(scope: string): string | null {
  const selectors = scope.split(/[\n,]/).map((v) => v.trim().replace(/^\.\//, '')).filter(Boolean);
  if (selectors.length !== 1) return null;
  const selector = selectors[0].replaceAll('\\', '/');
  if (/[*?\[]/.test(selector.replace(/\/\*\*\/?$/, ''))) return null;
  if (!selector.endsWith('/**')) return null;
  const dir = selector.slice(0, -3).replace(/\/$/, '');
  const normalized = path.posix.normalize(dir);
  return normalized && normalized !== '..' && !normalized.startsWith('../') && !path.isAbsolute(normalized)
    ? normalized : null;
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
