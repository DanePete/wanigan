import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Cost, quota and context — the checks that need a real process: SQLite, real
 * git, the real telemetry receiver. The pure halves are in src/shared/*.test.ts.
 */

function scratchRepo(prefix: string) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'smoke@wanigan.test');
  git('config', 'user.name', 'Smoke');
  fs.writeFileSync(path.join(repo, 'README.md'), '# yield\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  return { repo, git };
}

export async function runSpendYieldSmoke(check: Check, say: Say): Promise<void> {
  say('── cost · spend yield: merged, discarded, still open, not recorded');
  const { repo, git } = scratchRepo('wanigan-yield-');
  const { db } = await import('./db');
  const { addProject, removeProject } = await import('./store');
  const worktrees = await import('./worktrees');
  const { spendYield } = await import('./spend-yield');
  const project = await addProject(repo);
  const made: string[] = [];
  try {
    const commitIn = (dir: string, file: string) => {
      fs.writeFileSync(path.join(dir, file), `${file}\n`);
      execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' });
      execFileSync('git', ['-C', dir, 'commit', '-qm', `add ${file}`], { stdio: 'pipe' });
    };
    const now = Date.now();
    const logSession = (id: string, worktree: string | null, cost: number, model = 'claude-fable-5') => {
      db().prepare(`INSERT INTO session_log (id, provider_id, project_id, project_path, project_name, model, started_at, worktree, title)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, 'claude', project.id, repo, project.name, model, now - 1000, worktree, `yield ${id}`);
      if (cost > 0) {
        db().prepare(`INSERT INTO session_api_events (session_id, at, kind, model, cost_usd, in_tokens, out_tokens)
          VALUES (?,?,?,?,?,?,?)`).run(id, now - 500, 'request', model, cost, 100, 10);
      }
    };

    // 1. Merged from Wanigan, then reverted on the base branch.
    const a = await worktrees.createWorktree(repo, 'merged work', 'yield-merge');
    made.push(a.path);
    commitIn(a.path, 'a.txt');
    commitIn(a.path, 'b.txt');
    const merged = await worktrees.mergeWorktree(a.path);
    const rowA = db().prepare('SELECT outcome, merge_sha, merge_target, outcome_commits, created_head FROM worktrees WHERE path = ?').get(a.path) as
      { outcome: string | null; merge_sha: string | null; merge_target: string | null; outcome_commits: number | null; created_head: string | null };
    check(merged.merged && rowA.outcome === 'merged' && rowA.merge_target === 'main' && rowA.outcome_commits === 2,
      'a merge from Wanigan records outcome merged, its target and the two commits it carried', rowA);
    check(rowA.merge_sha === git('rev-parse', 'main'), 'the recorded merge SHA is the commit the merge made on main', rowA.merge_sha);
    logSession('yield-merge', a.path, 2);

    await worktrees.removeWorktree(a.path, false);
    const afterRemove = db().prepare('SELECT outcome FROM worktrees WHERE path = ?').get(a.path) as { outcome: string };
    check(afterRemove.outcome === 'merged', 'removing a merged worktree afterwards does not overwrite the merge', afterRemove);

    let reverts = await worktrees.checkReverts();
    const notYet = db().prepare('SELECT reverted_by, revert_checked_at FROM worktrees WHERE path = ?').get(a.path) as { reverted_by: string | null; revert_checked_at: number | null };
    check(reverts === 1 && notYet.reverted_by === null && notYet.revert_checked_at !== null,
      'the lazy revert check asks git once and caches "not reverted" with a timestamp', { reverts, notYet });
    git('revert', '--no-edit', '-m', '1', rowA.merge_sha!);
    reverts = await worktrees.checkReverts();
    check(reverts === 0, 'a cached answer is not re-asked inside the recheck interval', reverts);
    db().prepare('UPDATE worktrees SET revert_checked_at = 0 WHERE path = ?').run(a.path);
    await worktrees.checkReverts();
    const reverted = db().prepare('SELECT reverted_by FROM worktrees WHERE path = ?').get(a.path) as { reverted_by: string | null };
    check(reverted.reverted_by === git('rev-parse', 'main'), 'once due again, the check finds the revert of the merge commit on main', reverted);

    // 2. Removed with nothing in it.
    const b = await worktrees.createWorktree(repo, 'nothing', 'yield-clean');
    made.push(b.path);
    await worktrees.removeWorktree(b.path, false);
    const rowB = db().prepare('SELECT outcome FROM worktrees WHERE path = ?').get(b.path) as { outcome: string | null };
    check(rowB.outcome === 'removed-clean', 'a worktree removed with no commits and no edits records removed-clean', rowB);
    logSession('yield-clean', b.path, 0.5);

    // 3. Removed with unmerged commits: discarded, branch kept.
    const c = await worktrees.createWorktree(repo, 'thrown away', 'yield-discard');
    made.push(c.path);
    commitIn(c.path, 'c.txt');
    await worktrees.removeWorktree(c.path, false);
    const rowC = db().prepare('SELECT outcome, outcome_commits FROM worktrees WHERE path = ?').get(c.path) as { outcome: string | null; outcome_commits: number | null };
    check(rowC.outcome === 'discarded' && rowC.outcome_commits === 1,
      'a worktree removed with an unmerged commit records discarded and the commit count', rowC);
    logSession('yield-discard', c.path, 1.25);

    // 4. Still open, and 5. a historical removal with no outcome, and 6. no worktree at all.
    const e = await worktrees.createWorktree(repo, 'in flight', 'yield-open');
    made.push(e.path);
    logSession('yield-open', e.path, 0.75);
    const f = await worktrees.createWorktree(repo, 'old', 'yield-historic');
    made.push(f.path);
    await worktrees.removeWorktree(f.path, false);
    db().prepare('UPDATE worktrees SET outcome = NULL WHERE path = ?').run(f.path);
    logSession('yield-historic', f.path, 0.1);
    logSession('yield-bare', null, 0.2);
    logSession('yield-unpriced', e.path, 0);

    const report = await spendYield(7, new Set(['yield-open']));
    const group = report.groups.find((g) => g.projectId === project.id && g.model === 'claude-fable-5');
    check(!!group, 'spend yield groups the scratch project by project and model', report.groups.map((g) => [g.projectName, g.model]));
    if (group) {
      check(group.merged.sessions === 1 && Math.abs(group.merged.costUsd - 2) < 1e-9 && group.reverted.sessions === 1,
        'the merged bucket carries the merged session’s cost and marks it reverted', JSON.stringify(group.merged));
      check(group.discarded.sessions === 1 && group.removedClean.sessions === 1,
        'discarded and removed-clean are separate buckets', { discarded: group.discarded, clean: group.removedClean });
      check(group.open.sessions === 2 && group.open.unpricedSessions === 1 && Math.abs(group.open.costUsd - 0.75) < 1e-9,
        'an unpriced session is counted in its bucket and never summed in as $0', JSON.stringify(group.open));
      check(group.notRecorded.historical === 1 && group.notRecorded.noWorktree === 1,
        'not recorded names a historical removal and a session with no worktree separately', group.notRecorded);
      check(group.costPerMergedCommit.status === 'observed' && Math.abs((group.costPerMergedCommit as { usdPerCommit: number }).usdPerCommit - 1) < 1e-9,
        'cost per merged commit is shown when the merged session is priced and the merge recorded its commits', JSON.stringify(group.costPerMergedCommit));
      check(report.detail['yield-open']?.live === true && report.detail['yield-merge']?.mergeSha === rowA.merge_sha,
        'drill-through detail carries liveness and the merge SHA per session', report.detail['yield-open']);
    }

    say('── cost · repository attributes from Claude Code telemetry');
    const otel = await import('./otel');
    await otel.startCollector();
    const env = otel.otelEnv('yield-merge');
    check(env.OTEL_METRICS_INCLUDE_REPOSITORY === '1', 'Claude sessions launch with OTEL_METRICS_INCLUDE_REPOSITORY=1', env.OTEL_METRICS_INCLUDE_REPOSITORY);
    const { recordVcsAttributes, vcsAttributesFor } = await import('./vcs-telemetry');
    recordVcsAttributes({
      resourceMetrics: [{
        resource: { attributes: [{ key: 'wanigan.session.id', value: { stringValue: 'yield-merge' } }] },
        scopeMetrics: [{ metrics: [{ name: 'claude_code.cost.usage', sum: { dataPoints: [{ asDouble: 0.1, attributes: [
          { key: 'vcs.repository.url.full', value: { stringValue: 'https://oauth2:tok@example.com/acme/app.git' } },
          { key: 'vcs.provider.name', value: { stringValue: 'github' } },
          { key: 'user.email', value: { stringValue: 'nobody@example.com' } },
        ] }] } }] }],
      }],
    });
    const attrs = vcsAttributesFor(['yield-merge']).get('yield-merge') ?? {};
    check(attrs['vcs.repository.url.full'] === 'https://example.com/acme/app.git' && attrs['vcs.provider.name'] === 'github' && !('user.email' in attrs),
      'vcs.* attributes are banked per session with URL credentials stripped and nothing else kept', attrs);
    const again = await spendYield(7, new Set());
    const withRepo = again.groups.find((g) => g.projectId === project.id && g.model === 'claude-fable-5');
    check(withRepo?.repositories.includes('https://example.com/acme/app.git') === true,
      'spend yield shows the repository the CLI itself reported beside the project', withRepo?.repositories);
  } finally {
    for (const p of made) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* scratch */ } }
    try { removeProject(project.id); } catch { /* scratch */ }
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

export async function runCodexLoaderSmoke(check: Check, say: Say): Promise<void> {
  say('── context · Codex loader budget, stale references, subagents');
  const { repo, git } = scratchRepo('wanigan-codex-loader-');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-codex-home-'));
  const home = path.join(fakeHome, '.codex');
  fs.mkdirSync(home, { recursive: true });
  const { addProject, removeProject } = await import('./store');
  const project = await addProject(repo);
  try {
    const loader = await import('./context/codex-loader');
    fs.mkdirSync(path.join(repo, 'pkg', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), `# root\n${'r'.repeat(90)}\n`);
    fs.writeFileSync(path.join(repo, 'pkg', 'AGENTS.override.md'), `# override\n${'o'.repeat(40)}\n`);
    fs.writeFileSync(path.join(repo, 'pkg', 'AGENTS.md'), 'shadowed\n');
    fs.writeFileSync(path.join(repo, 'pkg', 'deep', 'TEAM.md'), `# team\n${'t'.repeat(60)}\n`);
    fs.writeFileSync(path.join(home, 'config.toml'), [
      'model = "gpt-6-astra"',
      'project_doc_max_bytes = 180',
      'project_doc_fallback_filenames = ["TEAM.md"]',
      '[skills]',
      'max_context_tokens = 99999',
    ].join('\n'));
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6-astra', context_window: 272000 }] }));
    fs.mkdirSync(path.join(home, 'skills', '.system', 'hidden', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, 'skills', '.system', 'hidden', 'SKILL.md'), '---\nname: hidden\ndescription: never listed\n---\n');
    fs.writeFileSync(path.join(home, 'skills', '.system', 'hidden', 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
    fs.mkdirSync(path.join(home, 'skills', '.system', 'shown'), { recursive: true });
    fs.writeFileSync(path.join(home, 'skills', '.system', 'shown', 'SKILL.md'), '---\nname: shown\ndescription: listed every turn\n---\n');

    const config = loader.readCodexConfig(home);
    check(config.maxBytes === 180 && config.maxBytesFrom === 'config' && config.fallbacks.join() === 'TEAM.md' && config.skillsMaxTokens === 99999,
      'config.toml overrides for the byte budget, fallback names and skills budget are read', config);
    const { chain, root } = loader.chainForCwd(path.join(repo, 'pkg', 'deep'), config);
    check(root === fs.realpathSync(repo) || root === repo, 'the project root is the directory holding .git', root);
    check(chain.files.map((f) => f.name).join() === 'AGENTS.md,AGENTS.override.md,TEAM.md',
      'one file per directory, root first, the override winning over AGENTS.md and a fallback name read', chain.files.map((f) => f.name));
    const team = chain.files[2];
    check(team.status === 'truncated' && team.droppedRange !== null && team.droppedRange[1] === team.bytes && chain.loadedBytes === 180,
      'the file that crosses project_doc_max_bytes is cut, with the byte range that never loads', JSON.stringify(team));
    check(chain.files[1].shadows.includes('AGENTS.md'), 'the shadowed AGENTS.md beside an override is named', chain.files[1]);

    const rows = loader.codexSkillRows(null, home);
    const hidden = rows.find((r) => r.name === 'hidden');
    const shown = rows.find((r) => r.name === 'shown');
    check(hidden?.listed === false && hidden.implicit === false && shown?.listed === true && (shown?.estTokens ?? 0) > 0,
      'a skill whose openai.yaml sets allow_implicit_invocation: false is not counted in the listing estimate', { hidden, shown });

    const { budgetForCompiled } = await import('./learning-budget');
    const block = `<!-- wanigan:begin k -->\n${'x'.repeat(40)}\n<!-- wanigan:end k -->\n`;
    const verdict = budgetForCompiled({ projectId: null, codexHome: home, targetPath: path.join(repo, 'pkg', 'deep', 'AGENTS.md'),
      targetFormat: 'codex-agents', proposedContent: block, homeDir: fakeHome });
    check(verdict.applies && verdict.verdict === 'refuse' && /project_doc_max_bytes/.test(verdict.reason ?? ''),
      'a projection whose managed block would land past the cut is refused with the reason', JSON.stringify(verdict));
    const ok = budgetForCompiled({ projectId: null, codexHome: home, targetPath: path.join(home, 'AGENTS.md'), targetFormat: 'codex-agents',
      proposedContent: block, homeDir: fakeHome });
    check(ok.applies && ok.kind === 'user-instructions' && ok.verdict === 'ok',
      'the Codex home AGENTS.md is the user’s instructions and is not measured against the project budget', JSON.stringify(ok));

    const learningService = await import('./learning-service');
    const applySrc = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'learning-service.ts'), 'utf8');
    check(typeof learningService.applyCandidateToProvider === 'function' && /budgetForCompiled\(/.test(applySrc) && /verdict === 'refuse'/.test(applySrc),
      'the apply path itself calls the budget check and refuses on it, not only the inbox note');

    say('── context · stale references in CLAUDE.md and AGENTS.md');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'engine.ts'), 'export {};\n');
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), [
      '# Notes', 'Start in `src/engine.ts`, then `src/engin.ts` and `lib/gone/thing.md`.',
      'Never flag `https://example.com/a/b`, `~/.claude/x`, `$HOME/y`, `src/**/*.ts` or and/or `read/write`.',
      '```bash', 'git status && definitely-not-a-real-program-wanigan --x', '```',
    ].join('\n'));
    git('add', '-A'); git('commit', '-qm', 'docs');
    const { lintInstructionReferences } = await import('./context/reference-lint');
    const lint = await lintInstructionReferences(null, repo);
    const texts = lint.issues.map((i) => i.text).sort();
    check(texts.join() === 'definitely-not-a-real-program-wanigan,lib/gone/thing.md,src/engin.ts',
      'missing paths and a command not on PATH are flagged, and URLs, globs, ~/ and $VARS stay quiet', lint.issues);
    check(lint.issues.find((i) => i.text === 'src/engin.ts')?.suggestion === 'src/engine.ts',
      'a missing path carries a did-you-mean from git ls-files', lint.issues);

    say('── context · subagents that skip CLAUDE.md');
    fs.mkdirSync(path.join(repo, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'agents', 'lean.md'), '---\nname: lean\ndescription: takes everything from the prompt\nomitClaudeMd: true\n---\nBody.\n');
    fs.writeFileSync(path.join(repo, '.claude', 'agents', 'normal.md'), '---\nname: normal\ndescription: ordinary\n---\nBody.\n');
    const { agentDefinitions } = await import('./context/agent-definitions');
    const defs = await agentDefinitions(repo);
    const lean = defs.agents.find((a) => a.name === 'lean' && a.scope === 'project');
    const normal = defs.agents.find((a) => a.name === 'normal' && a.scope === 'project');
    check(lean?.omitClaudeMd === true && normal?.omitClaudeMd === false,
      'an agent with omitClaudeMd: true is marked, and one without is not', { lean, normal });
  } finally {
    try { removeProject(project.id); } catch { /* scratch */ }
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
}

export async function runSkillListingSmoke(check: Check, say: Say): Promise<void> {
  say('── skills · listing cost and the manual-only switch');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-skill-home-'));
  const codexHome = path.join(fakeHome, '.codex');
  const { repo } = scratchRepo('wanigan-skill-listing-');
  const { db } = await import('./db');
  const { addProject, removeProject } = await import('./store');
  const project = await addProject(repo);
  const ids: string[] = [];
  try {
    const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    const claudePersonal = path.join(fakeHome, '.claude', 'skills', 'tidy', 'SKILL.md');
    const codexPersonal = path.join(fakeHome, '.agents', 'skills', 'lean', 'SKILL.md');
    const handWritten = path.join(fakeHome, '.agents', 'skills', 'mine', 'SKILL.md');
    const projectSkill = path.join(repo, '.claude', 'skills', 'shared', 'SKILL.md');
    write(claudePersonal, '---\nname: tidy\ndescription: tidy the imports before a commit\n---\nBody.\n');
    write(codexPersonal, '---\nname: lean\ndescription: keep a diff small\n---\nBody.\n');
    write(handWritten, '---\nname: mine\ndescription: written by hand\n---\nBody.\n');
    write(projectSkill, '---\nname: shared\ndescription: the team skill\n---\nBody.\n');
    fs.mkdirSync(codexHome, { recursive: true });
    const project2 = (target: string, format: string, provider: string) => {
      const id = `proj_smoke_${Math.random().toString(36).slice(2, 10)}`;
      ids.push(id);
      db().prepare(`INSERT INTO knowledge_projections (id, provider_id, adapter_id, scope, target_path, target_format, proposed_content, status, created_at, applied_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, provider, provider, 'personal', target, format, 'x', 'applied', Date.now(), Date.now());
    };
    project2(claudePersonal, 'claude-skill', 'claude-code');
    project2(codexPersonal, 'agent-skill', 'codex');

    const listing = await import('./skill-listing');
    const { refreshSkills } = await import('./skills');
    refreshSkills();
    const opts = { homeDir: fakeHome, codexHome };
    const report = listing.skillListing(project.id, opts);
    const claude = report.providers.find((p) => p.harness === 'claude-code')!;
    const codex = report.providers.find((p) => p.harness === 'codex')!;
    const tidy = claude.rows.find((r) => r.path === claudePersonal);
    const shared = claude.rows.find((r) => r.path === projectSkill);
    const lean = codex.rows.find((r) => r.path === codexPersonal);
    const mine = codex.rows.find((r) => r.path === handWritten);
    check(tidy?.toggle === true && shared?.toggle === false && lean?.toggle === true && mine?.toggle === false,
      'the switch is offered only for personal skills Wanigan applied, never for a project or hand-written skill', { tidy, shared, lean, mine });
    check(claude.estTokens > 0 && codex.estTokens > 0, 'each harness reports an estimated listing cost', { claude: claude.estTokens, codex: codex.estTokens });

    let refused = '';
    try { listing.setSkillModelInvocation({ projectId: project.id, harness: 'claude-code', path: projectSkill, allow: false }, opts); }
    catch (e) { refused = e instanceof Error ? e.message : String(e); }
    check(/review inbox/.test(refused) && !fs.readFileSync(projectSkill, 'utf8').includes('disable-model-invocation'),
      'a project skill is refused with a pointer to the review inbox and its file is untouched', refused);

    const afterCodex = listing.setSkillModelInvocation({ projectId: project.id, harness: 'codex', path: codexPersonal, allow: false }, opts);
    const yaml = fs.readFileSync(path.join(path.dirname(codexPersonal), 'agents', 'openai.yaml'), 'utf8');
    const leanAfter = afterCodex.providers.find((p) => p.harness === 'codex')!.rows.find((r) => r.path === codexPersonal);
    check(/allow_implicit_invocation: false/.test(yaml) && leanAfter?.listed === false && leanAfter.estTokens === 0,
      'making a Codex skill manual-only writes policy.allow_implicit_invocation: false and drops it from the listing estimate', { yaml, leanAfter });

    const afterClaude = listing.setSkillModelInvocation({ projectId: project.id, harness: 'claude-code', path: claudePersonal, allow: false }, opts);
    const tidyAfter = afterClaude.providers.find((p) => p.harness === 'claude-code')!.rows.find((r) => r.path === claudePersonal);
    check(/disable-model-invocation: true/.test(fs.readFileSync(claudePersonal, 'utf8')) && tidyAfter?.listed === false,
      'making a Claude Code skill manual-only sets disable-model-invocation: true in its frontmatter', tidyAfter);
  } finally {
    for (const id of ids) db().prepare('DELETE FROM knowledge_projections WHERE id = ?').run(id);
    try { removeProject(project.id); } catch { /* scratch */ }
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
    try { (await import('./skills')).refreshSkills(); } catch { /* cache only */ }
  }
}

export async function runCodexCreditsSmoke(check: Check, say: Say): Promise<void> {
  say('── cost · Codex plan sessions in credits (estimate)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-credits-'));
  const { db } = await import('./db');
  const id = `credits-smoke-${Date.now()}`;
  try {
    const credits = await import('./codex-credits');
    const rollout = path.join(dir, 'rollout.jsonl');
    // A rollout big enough to cross the 1 MiB read chunk, with the tier line after the boundary.
    const filler = `{"type":"event_msg","payload":{"type":"agent_message","message":"${'x'.repeat(1000)}"}}\n`;
    fs.writeFileSync(rollout, [
      '{"type":"turn_context","payload":{"cwd":"/r","model":"gpt-5.6-sol"}}\n',
      filler.repeat(1200),
      '{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-5.6-sol","service_tier":"priority"}}}\n',
    ].join(''));
    const settings = credits.rolloutSettings(rollout);
    check(settings.models.join() === 'gpt-5.6-sol' && settings.tiers.join() === 'priority',
      'the model and the service tier are read from a rollout across read-chunk boundaries', settings);

    db().prepare(`INSERT INTO session_log (id, conversation_id, provider_id, harness_id, project_path, project_name, model, started_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, '01a0952f-0000-7000-8000-000000000000', 'codex', 'codex', dir, 'credits', 'gpt-6-astra', Date.now());
    const report = credits.codexCredits(7);
    const row = report.sessions.find((s) => s.sessionId === id);
    check(!!row && row.estimate.status === 'no-rate' && /No token counts/.test(row.estimate.status === 'no-rate' ? row.estimate.reason : ''),
      'a Codex session whose thread has no recorded counters gets no estimate, with the reason', row);
    check(report.rateCard.readOn === '14 Sep 2026' && report.rateCard.fastMultiplier === 2.5,
      'the report carries the rate card’s source date and Fast multiplier for the label', report.rateCard);
  } finally {
    db().prepare('DELETE FROM session_log WHERE id = ?').run(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function runCacheWarmthSmoke(check: Check, say: Say): Promise<void> {
  say('── composer · warn before a cold-cache send');
  const { db } = await import('./db');
  const ids = [`warm-claude-${Date.now()}`, `warm-codex-${Date.now()}`];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-warmth-'));
  const prior = process.env.CLAUDE_CODE_PROMPT_CACHE_TTL;
  try {
    const now = Date.now();
    db().prepare(`INSERT INTO session_log (id, provider_id, harness_id, backend_id, project_path, project_name, started_at) VALUES (?,?,?,?,?,?,?)`)
      .run(ids[0], 'claude', 'claude-code', 'anthropic', dir, 'warmth', now - 3 * 3600_000);
    db().prepare(`INSERT INTO session_log (id, provider_id, harness_id, project_path, project_name, started_at) VALUES (?,?,?,?,?,?)`)
      .run(ids[1], 'codex', 'codex', dir, 'warmth', now - 3 * 3600_000);
    db().prepare(`INSERT INTO session_api_events (session_id, at, kind, model, cost_usd, in_tokens, out_tokens, cache_read, cache_write) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(ids[0], now - 70 * 60_000, 'request', 'claude-fable-5', 0.5, 12, 400, 118_000, 2_000);
    db().prepare(`INSERT INTO session_events (session_id, at, event) VALUES (?,?,?)`).run(ids[0], now - 68 * 60_000, 'Stop');

    const { cacheWarmth } = await import('./cache-warmth');
    const { coldCacheNote } = await import('../shared/cache-warmth');
    process.env.CLAUDE_CODE_PROMPT_CACHE_TTL = '1h';
    const facts = cacheWarmth(ids[0]);
    check(facts.supported && facts.lastTurnEndedAt === now - 68 * 60_000 && facts.contextTokens === 120_012 && facts.ttl.basis === 'pinned-env',
      'a Claude session reports its last Stop, the last request’s input and cache tokens, and a lifetime pinned by the environment', facts);
    const note = coldCacheNote({ now, lastTurnEndedAt: facts.lastTurnEndedAt, ttl: facts.ttl, contextTokens: facts.contextTokens });
    check(note?.text.startsWith('Idle 68 min: this message likely re-reads ~120,012 tokens without cache') === true,
      'the composer note names the idle time and the re-read size, as an estimate', note);
    delete process.env.CLAUDE_CODE_PROMPT_CACHE_TTL;
    const inferred = cacheWarmth(ids[0]);
    check(inferred.ttl.basis !== 'pinned-env', 'without the pin the lifetime is inferred and says so', inferred.ttl);
    const codex = cacheWarmth(ids[1]);
    check(!codex.supported, 'a Codex session gets no cache note rather than a guessed lifetime', codex.reason);
    const composerSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'renderer', 'src', 'components', 'Composer.tsx'), 'utf8');
    check(/<ColdCacheNote sessionId=\{sessionId\}/.test(composerSrc) && !/ColdCacheNote[^\n]*disabled/.test(composerSrc),
      'the composer mounts the note and nothing about it gates the send button');
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CODE_PROMPT_CACHE_TTL; else process.env.CLAUDE_CODE_PROMPT_CACHE_TTL = prior;
    for (const id of ids) {
      db().prepare('DELETE FROM session_log WHERE id = ?').run(id);
      db().prepare('DELETE FROM session_api_events WHERE session_id = ?').run(id);
      db().prepare('DELETE FROM session_events WHERE session_id = ?').run(id);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function runCostCausesSmoke(check: Check, say: Say): Promise<void> {
  say('── cost · cost by cause');
  const { db } = await import('./db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-causes-'));
  const stamp = Date.now();
  const session = `causes-${stamp}`;
  const conversation = `c0ffee00-0000-4000-8000-${String(stamp).slice(-12).padStart(12, '0')}`;
  const serverId = `mcp_causes_${stamp}`;
  try {
    const now = Date.now();
    db().prepare(`INSERT INTO session_log (id, conversation_id, provider_id, harness_id, project_path, project_name, started_at, title)
      VALUES (?,?,?,?,?,?,?,?)`).run(session, conversation, 'claude', 'claude-code', dir, 'causes', now - 3600_000, 'cause study');
    const usage = db().prepare(`INSERT INTO claude_usage_events (request_key, at, model, cwd, session_id, sidechain, in_tokens, out_tokens, cache_read, cache_write_5m, cache_write_1h)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    usage.run(`${stamp}|a`, now - 40 * 60_000, 'claude-fable-5', dir, conversation, 0, 10, 10, 20_000, 1_000, 0);
    usage.run(`${stamp}|b`, now - 39 * 60_000, 'claude-fable-5', dir, conversation, 0, 10, 10, 21_000, 0, 0);
    usage.run(`${stamp}|c`, now - 10 * 60_000, 'claude-fable-5', dir, conversation, 0, 10, 10, 0, 0, 30_000);
    const ev = db().prepare('INSERT INTO session_events (session_id, at, event, tool_name, paths_json) VALUES (?,?,?,?,?)');
    const file = path.join(dir, 'src', 'big.ts');
    for (let i = 0; i < 4; i++) ev.run(session, now - (30 - i) * 60_000, 'PostToolUse', 'Read', JSON.stringify([file]));
    ev.run(session, now - 20 * 60_000, 'PostToolUse', 'Edit', JSON.stringify([file]));
    ev.run(session, now - 19 * 60_000, 'PostToolUse', 'Read', JSON.stringify([file]));
    db().prepare('INSERT INTO mcp_servers (id, project_id, name, transport, command, enabled, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(serverId, null, `quiet-${stamp}`, 'stdio', 'true', 1, now - 30 * 24 * 3600_000);
    const stored = path.join(dir, `${session}.jsonl`);
    fs.writeFileSync(stored, [
      JSON.stringify({ type: 'assistant', version: '2.1.271', message: { diagnostics: { cache_miss_reason: { type: 'tools_changed', cache_missed_input_tokens: 4100 } } } }),
      JSON.stringify({ type: 'assistant', version: '2.1.271', message: { diagnostics: { cache_miss_reason: { type: 'tools_changed' } } } }),
      JSON.stringify({ type: 'assistant', version: '2.1.271', message: { content: [] } }),
    ].join('\n'));
    db().prepare('INSERT INTO transcripts (session_id, source_path, stored_path, archived_at) VALUES (?,?,?,?)').run(session, stored, stored, now);

    const { costCauses } = await import('./cost-causes');
    const report = costCauses(7, 14, new Set([session]));
    const mine = report.idle.conversations.find((c) => c.conversation === conversation);
    check(mine?.gaps === 1 && mine.cappedTokens === 21_000 && mine.uncappedTokens === 30_000 && mine.sessionId === session,
      'an idle-gap cache write is attributed, capped at the previous request’s footprint, with the uncapped bound and the session named', mine);
    const read = report.reads.rows.find((r) => r.sessionId === session);
    check(read?.reads === 4 && read.path === file && read.live === true,
      'a file read four times before an edit is flagged as a repeated read, and the read after the edit starts a new run', read);
    check(report.mcp.unused.some((s) => s.id === serverId && s.lastCalledAt === null),
      'an enabled MCP server with no calls in the window is listed as never called', report.mcp.unused.map((s) => s.name));
    check(report.cacheMiss.recorded && report.cacheMiss.types.find((t) => t.type === 'tools_changed')?.count === 2 && (report.cacheMiss.missedTokens ?? 0) >= 4100,
      'cache-miss reasons are counted by type from the session’s archived transcript', report.cacheMiss);
  } finally {
    db().prepare('DELETE FROM session_log WHERE id = ?').run(session);
    db().prepare('DELETE FROM claude_usage_events WHERE session_id = ?').run(conversation);
    db().prepare('DELETE FROM session_events WHERE session_id = ?').run(session);
    db().prepare('DELETE FROM mcp_servers WHERE id = ?').run(serverId);
    db().prepare('DELETE FROM transcripts WHERE session_id = ?').run(session);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
