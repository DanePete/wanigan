import fs from 'node:fs';
import path from 'node:path';
import { runGit } from '../git';
import { shellPath } from '../providers';
import { markInstructionPathsServable, resolveInstructions } from './instructions';
import { chainForCwd, codexHomeForProject, readCodexConfig } from './codex-loader';
import { didYouMean, extractReferences } from '../../shared/instruction-lint';
import type { ReferenceIssue, ReferenceLintReport } from '../../shared/cost-types';

/**
 * Stale references in the instruction files a session in this project reads:
 * the CLAUDE.md chain Claude Code resolves and the AGENTS.md chain Codex does.
 *
 * Only files inside the project are read. A path in ~/.claude/CLAUDE.md is
 * relative to whatever repository the user happens to be in, so checking it
 * against this one would report every personal note as broken.
 *
 * A path counts as present when it exists relative to the file that names it
 * or to the repository root. A command counts as present when its program is
 * on the login-shell PATH Wanigan launches agents with, or in the project's
 * node_modules/.bin. Nothing is run.
 */

const MAX_FILE_BYTES = 512 * 1024;
const MAX_ISSUES = 200;

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function trackedFiles(root: string): Promise<string[] | null> {
  const r = await runGit(root, ['ls-files', '-z'], { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
  if (!r.ok) return null;
  return r.out.split('\0').filter(Boolean).slice(0, 200_000);
}

function executableIn(dir: string, program: string): boolean {
  try {
    fs.accessSync(path.join(dir, program), fs.constants.X_OK);
    return fs.statSync(path.join(dir, program)).isFile();
  } catch { return false; }
}

export async function lintInstructionReferences(projectId: string | null, projectPath: string): Promise<ReferenceLintReport> {
  const root = path.resolve(projectPath);
  const files = new Map<string, 'claude-code' | 'codex' | 'both'>();
  try {
    for (const file of resolveInstructions(root).files) {
      if (file.exists && !file.excludedBy && !file.duplicate && inside(root, file.path)) files.set(file.path, 'claude-code');
    }
  } catch { /* an unreadable chain leaves the Codex half */ }
  try {
    const home = codexHomeForProject(projectId);
    const { chain } = chainForCwd(root, readCodexConfig(home.dir));
    for (const file of chain.files) {
      if (!inside(root, file.path) || file.status === 'blank') continue;
      files.set(file.path, files.has(file.path) ? 'both' : 'codex');
    }
  } catch { /* the Claude half stands alone */ }

  const tracked = await trackedFiles(root);
  const trackedSet = new Set(tracked ?? []);
  const pathDirs = (await shellPath()).split(':').filter(Boolean);
  pathDirs.push(path.join(root, 'node_modules', '.bin'));
  const onPath = new Map<string, boolean>();

  const issues: ReferenceIssue[] = [];
  const rows: ReferenceLintReport['files'] = [];
  for (const [file, harness] of [...files].sort((a, b) => a[0].localeCompare(b[0]))) {
    let text = '';
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch { continue; }
    const refs = extractReferences(text);
    rows.push({ path: file, harness, references: refs.length });
    const seen = new Set<string>();
    for (const ref of refs) {
      const key = `${ref.kind}:${ref.kind === 'command' ? ref.program : ref.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (ref.kind === 'path') {
        const relFromRoot = path.normalize(ref.text);
        const candidates = [path.resolve(path.dirname(file), ref.text), path.resolve(root, ref.text)];
        if (candidates.some((c) => fs.existsSync(c))) continue;
        // Tracked but not checked out (sparse checkout) is still present.
        if (trackedSet.has(relFromRoot.split(path.sep).join('/'))) continue;
        issues.push({ file, line: ref.line, kind: 'path', text: ref.text, suggestion: tracked ? didYouMean(relFromRoot.split(path.sep).join('/'), tracked) : null });
      } else {
        let found = onPath.get(ref.program);
        if (found === undefined) {
          found = pathDirs.some((dir) => executableIn(dir, ref.program));
          onPath.set(ref.program, found);
        }
        if (!found) issues.push({ file, line: ref.line, kind: 'command', text: ref.program, suggestion: null });
      }
      if (issues.length >= MAX_ISSUES) break;
    }
    if (issues.length >= MAX_ISSUES) break;
  }

  markInstructionPathsServable(rows.map((row) => row.path));
  return {
    files: rows,
    issues,
    tracked: tracked !== null,
    note:
      'Backticked paths are checked relative to the file and to the repository root; shell-fenced commands against the ' +
      'login-shell PATH agents launch with. URLs, globs, ~/ paths, $VARIABLES, <placeholders> and two-word spans like ' +
      '"and/or" are never flagged. Files outside the project are not read.',
  };
}
