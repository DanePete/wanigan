import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGit } from './git';
import * as gh from './gh';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Offline contract tests for the gh-CLI PR integration. Resolution is pointed
 * at a directory of stub `gh` executables, so every honest state — missing,
 * unauthenticated, no PR, a PR with checks, hostile output — is exercised
 * through the real spawn path with no network and no GitHub account.
 */
export async function runGhSmoke(check: Check, say: Say): Promise<void> {
  say('── pull requests via gh · honest states, create, hardening');

  const probe = await runGit(os.tmpdir(), ['--version'], { timeout: 8_000 });
  if (!probe.ok) {
    check(false, 'git is available for the gh suite', probe.err);
    return;
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-gh-'));
  const binDir = path.join(base, 'bin');
  const emptyDir = path.join(base, 'empty');
  const repo = path.join(base, 'repo');
  const unborn = path.join(base, 'unborn');
  const plainDir = path.join(base, 'plain');
  const ghBin = path.join(binDir, 'gh');
  const argsFile = path.join(base, 'args.txt');
  const hitsFile = path.join(base, 'hits.txt');
  for (const d of [binDir, emptyDir, repo, unborn, plainDir]) fs.mkdirSync(d, { recursive: true });

  const git = async (cwd: string, ...args: string[]) => {
    const r = await runGit(cwd, args, { timeout: 15_000 });
    if (!r.ok) throw new Error(`git ${args[0]}: ${r.err}`);
    return r.out;
  };

  /**
   * One argv token per line, because `echo "$@"` flattens token boundaries —
   * and the boundary is the fact under test for `--flag=value` hardening.
   */
  const stub = (cases: { list?: string; auth?: string; create?: string }) => {
    fs.rmSync(argsFile, { force: true });
    fs.writeFileSync(ghBin, [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then echo "gh version 9.9.9-smoke (2026-01-01)"; exit 0; fi`,
      `for a in "$@"; do echo "$a" >> "${argsFile}"; done`,
      `case "$1 $2" in`,
      `  "pr list") ${cases.list ?? 'echo "[]"'} ;;`,
      `  "auth status") ${cases.auth ?? 'exit 0'} ;;`,
      `  "pr create") ${cases.create ?? 'echo "https://github.com/o/r/pull/1"'} ;;`,
      `  *) echo "unexpected: $@" >&2; exit 64 ;;`,
      'esac',
    ].join('\n') + '\n', { mode: 0o755 });
    fs.chmodSync(ghBin, 0o755);
    // Re-pointing resolution also clears the status cache between scenarios.
    gh.setGhSearchDirsForTest([binDir]);
  };
  const argLines = () => { try { return fs.readFileSync(argsFile, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

  try {
    await git(repo, 'init');
    await git(repo, 'checkout', '-b', 'feature-x');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'fixture\n');
    await git(repo, 'add', '-A');
    await git(repo, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@localhost', 'commit', '-m', 'Fix the flaky parser');
    await git(unborn, 'init');
    fs.mkdirSync(path.join(repo, 'pkg'));

    // ── states that never reach gh ─────────────────────────────────────
    gh.setGhSearchDirsForTest([emptyDir]);
    let r = await gh.prStatusReport(plainDir);
    check(r.status.kind === 'no-branch' && r.gh === null,
      'a directory that is not a repository reports no-branch before gh is even looked for', JSON.stringify(r.status));
    r = await gh.prStatusReport(unborn);
    check(r.status.kind === 'no-branch' && 'detail' in r.status && /no commits/i.test(r.status.detail),
      'an unborn repository says why there is nothing to have a PR for', JSON.stringify(r.status));
    r = await gh.prStatusReport(repo);
    check(r.status.kind === 'missing',
      'no gh on the search path is an honest missing, not an error', JSON.stringify(r.status));

    // ── no PR for the branch ───────────────────────────────────────────
    stub({ list: `echo "hit" >> "${hitsFile}"; echo "[]"` });
    r = await gh.prStatusReport(repo);
    check(r.status.kind === 'none' && r.status.branch === 'feature-x' && r.gh?.version === '9.9.9-smoke',
      'an empty gh answer is "no PR for this branch", with gh named and versioned', JSON.stringify(r));
    const listArgs = argLines();
    check(listArgs.includes('--head=feature-x') && listArgs.includes('--state=all'),
      'the list is scoped to the branch as one argv token', listArgs.join(' | '));

    // ── the cache: triggers cannot become spawns ───────────────────────
    await gh.prStatusReport(repo);
    check(fs.readFileSync(hitsFile, 'utf8').trim().split('\n').length === 1,
      'a second read inside the TTL answers from memory without spawning gh');
    await gh.prStatusReport(repo, true);
    check(fs.readFileSync(hitsFile, 'utf8').trim().split('\n').length === 2,
      'an explicit refresh busts the cache and asks again');

    // ── a real PR, checks summarised, draft preferred over merged ──────
    const prJson = JSON.stringify([
      { number: 7, title: 'Teach the parser draft state', state: 'OPEN', isDraft: true,
        url: 'https://github.com/o/r/pull/7', baseRefName: 'main', headRefName: 'feature-x',
        reviewDecision: 'CHANGES_REQUESTED', updatedAt: '2026-08-30T10:00:00Z',
        statusCheckRollup: [{ state: 'SUCCESS' }, { conclusion: 'FAILURE', status: 'COMPLETED' }, { status: 'IN_PROGRESS' }] },
      { number: 3, title: 'Older merged attempt', state: 'MERGED', isDraft: false,
        url: 'https://github.com/o/r/pull/3', baseRefName: 'main', headRefName: 'feature-x',
        reviewDecision: '', updatedAt: '2026-08-01T10:00:00Z', statusCheckRollup: [] },
    ]);
    stub({ list: `echo '${prJson}'` });
    r = await gh.prStatusReport(repo);
    const pr = r.status.kind === 'pr' ? r.status.pr : null;
    check(pr?.number === 7 && pr.state === 'draft',
      'the open draft outranks the newer-numbered merged PR and OPEN+isDraft reads as draft', JSON.stringify(r.status));
    check(pr?.checks?.pass === 1 && pr.checks.fail === 1 && pr.checks.pending === 1 && pr.checks.total === 3,
      'both rollup spellings (state and status/conclusion) land in one pass/fail/pending summary', JSON.stringify(pr?.checks));
    check(pr?.reviewDecision === 'changes_requested' && pr.url === 'https://github.com/o/r/pull/7' && pr.base === 'main',
      'review decision, base and the validated https URL survive the mapping');

    // ── hostile output does not become an OS action or a crash ─────────
    stub({ list: `echo '[{"number":9,"title":"x","state":"OPEN","isDraft":false,"url":"javascript:alert(1)","updatedAt":"junk"}]'` });
    r = await gh.prStatusReport(repo);
    const hostile = r.status.kind === 'pr' ? r.status.pr : null;
    check(hostile?.url === null && hostile.updatedAt === null && hostile.state === 'open',
      'a non-https URL and junk timestamp are dropped in main, never handed to the renderer', JSON.stringify(hostile));
    stub({ list: 'echo "this is not json"' });
    r = await gh.prStatusReport(repo);
    check(r.status.kind === 'error' && 'detail' in r.status && /not JSON/i.test(r.status.detail),
      'non-JSON from gh is an error state that says what happened');

    // ── failure classification asks auth as its own question ───────────
    stub({ list: 'echo "To get started with GitHub CLI, please run: gh auth login" >&2; exit 1', auth: 'exit 1' });
    r = await gh.prStatusReport(repo);
    check(r.status.kind === 'unauthenticated' && 'detail' in r.status && /gh auth login/.test(r.status.detail),
      'a failed list with failed auth reads as not signed in, with the fix named', JSON.stringify(r.status));
    stub({ list: 'echo "GraphQL: API rate limit exceeded" >&2; exit 1', auth: 'exit 0' });
    r = await gh.prStatusReport(repo);
    check(r.status.kind === 'error' && 'detail' in r.status && r.status.detail === 'GraphQL: API rate limit exceeded',
      'a failed list while signed in keeps gh\u2019s own first line as the reason', JSON.stringify(r.status));

    // ── a gh that never answers is killed and says so ──────────────────
    stub({ list: `/bin/sleep 5` });
    const slow = await gh.runGh(ghBin, repo, ['pr', 'list'], { timeout: 400 });
    check(!slow.ok && slow.killed,
      'a gh past its timeout is killed rather than left to hang the caller', JSON.stringify({ ok: slow.ok, killed: slow.killed }));

    // ── create: renderer input is validated at the boundary ────────────
    stub({});
    const throws = async (input: unknown, at = repo) => {
      try { await gh.createPr(at, input); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
    };
    check(/needs a title/.test((await throws({})) ?? ''), 'a create without a title is refused');
    check(/top out/.test((await throws({ title: 'x'.repeat(301) })) ?? ''), 'a 301-character title is refused with the limit named');
    check(/16 KiB/.test((await throws({ title: 'ok', body: 'y'.repeat(16 * 1024 + 1) })) ?? ''), 'a body past 16 KiB is refused');
    check(/does not look like a branch name/.test((await throws({ title: 'ok', base: '-evil' })) ?? ''), 'a leading-dash base cannot masquerade as a flag');
    check(/does not look like a branch name/.test((await throws({ title: 'ok', base: 'two words' })) ?? ''), 'whitespace in a base branch is refused');
    check(/subdirectory/.test((await throws({ title: 'ok' }, path.join(repo, 'pkg'))) ?? ''),
      'a subpath project is refused: a PR proposes the whole repository');
    check(/no commits yet/.test((await throws({ title: 'ok' }, unborn)) ?? ''), 'an unborn repository cannot open a PR and says why');

    // ── create: argv shape, NUL stripping, and the returned URL ────────
    stub({ create: 'echo "https://github.com/o/r/pull/42"' });
    const made = await gh.createPr(repo, { title: '  Fix\u0000 the \n\tflaky   parser  ', body: 'b\u0000ody', draft: true, base: 'main' });
    check(made.url === 'https://github.com/o/r/pull/42', 'a create returns the validated https URL gh printed', JSON.stringify(made));
    const createArgs = argLines();
    check(createArgs.includes('--title=Fix the flaky parser'),
      'the title is one argv token, NUL-stripped and whitespace-collapsed', createArgs.join(' | '));
    check(createArgs.includes('--body=body') && createArgs.includes('--draft')
      && createArgs.includes('--base=main') && createArgs.includes('--head=feature-x'),
      'body, draft, base and head all travel as their own hardened tokens', createArgs.join(' | '));

    stub({ create: 'echo "created, but no link today"' });
    const bare = await gh.createPr(repo, { title: 'ok' });
    check(bare.url === null && bare.detail === 'created, but no link today',
      'a create without a usable https URL reports url null instead of inventing one', JSON.stringify(bare));
    const bareArgs = argLines();
    check(bareArgs.includes('--body=') && !bareArgs.some((a) => a === '--draft' || a.startsWith('--base=')),
      'an empty body still travels explicitly, and absent options add no flags', bareArgs.join(' | '));

    stub({ create: 'echo "pull request create failed: GraphQL: something" >&2; exit 1' });
    const failed = await throws({ title: 'ok' });
    check(/GraphQL: something/.test(failed ?? ''), 'a failed create surfaces gh\u2019s own reason', failed);
  } catch (e) {
    check(false, `gh smoke threw: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    gh.setGhSearchDirsForTest(null);
    fs.rmSync(base, { recursive: true, force: true });
  }
}
