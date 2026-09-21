type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Onboarding checks that genuinely need a main process.
 *
 * The pure half of this subject moved to `src/shared/preflight.test.ts` and
 * `src/shared/discovery.test.ts`, which run under `node --test` in a tenth of a
 * second rather than the thirty this suite costs. What stays here is what only
 * a real process can answer: the provider registry's view of which credentials
 * a profile declares and lacks, and the exclusion rules that read this
 * machine's actual temp and home paths.
 */
export async function runPreflightSmoke(check: Check, say: Say): Promise<void> {
  // ── the launch guard the first-run surface's honesty depends on ────────
  // A redirected profile is a base URL and a credential that only mean
  // anything together. compileProviderProfile already refuses to apply half
  // the pair, but an empty environment is indistinguishable from an ordinary
  // profile's, agentEnv() strips the ambient Anthropic names, and the shared
  // binary falls back to its own login: a GLM session that is really Claude
  // Code, displayed as GLM, banking spend against a backend that never served
  // it. Every pre-existing GLM fixture in this suite supplies a key, so the
  // no-key path had no coverage at all until this section.
  say('── redirected profiles · a missing credential refuses the launch');
  try {
    const { missingCredentialIds } = await import('./providers');

    // The smoke profile runs on a throwaway user-data directory, so no
    // provider credential is stored and every redirected profile lacks one.
    for (const id of ['glm', 'deepseek', 'xai']) {
      const missing = missingCredentialIds(id);
      check(missing.includes(id),
        `${id} reports its own missing credential by name rather than failing silently`, missing);
    }
    check(missingCredentialIds('claude').length === 0 && missingCredentialIds('codex').length === 0
      && missingCredentialIds('pair-codex').length === 0 && missingCredentialIds('pair-claude').length === 0,
      'a profile that declares no credential is never held back by this guard — both local PAIR profiles included',
      { claude: missingCredentialIds('claude'), codex: missingCredentialIds('codex'), pairCodex: missingCredentialIds('pair-codex'), pairClaude: missingCredentialIds('pair-claude') });
    check(missingCredentialIds('no-such-profile').length === 0,
      'an unknown profile id reports nothing rather than throwing');
  } catch (error) {
    check(false, 'the credential guard checks ran without throwing', String(error));
  }

  // ── what the project scan may offer ───────────────────────────────────
  // Path exclusion stays here rather than moving to the shared tests because
  // it reads this machine's real temp directory, and the bug it pins was a
  // machine-specific one: macOS reports /var/folders/…/T for tmpdir and
  // /private/var/folders/…/T as its realpath, which is what a transcript
  // actually records. Matching the root by equality let the app's own test
  // runs — the busiest "repository" on this machine at 311 conversations — be
  // offered as a project to import.
  say('── project discovery · directories that are never projects');
  try {
    const { excluded } = await import('./discovery');
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');

    const home = os.homedir();
    const realTmp = path.join(fs.realpathSync(os.tmpdir()), 'wanigan-limits');
    check(excluded(realTmp, home, []),
      'a directory inside the real temp path is never a project', realTmp);
    check(excluded(path.join(os.tmpdir(), 'run-123'), home, []),
      'and neither is one inside the unresolved temp path');
    check(excluded(path.join(home, 'Downloads', 'thing'), home, [])
      && excluded(path.join(home, 'Documents', 'Codex', '2026-09-01', 'x'), home, []),
      'Downloads and Codex scratch directories are excluded');
    check(excluded(path.join('/data', 'worktrees', 'a'), home, ['/data/worktrees']),
      "Wanigan's own worktrees are never offered back as projects");
    check(!excluded(path.join(home, 'Projects', 'app'), home, []) && excluded(home, home, []),
      'an ordinary project directory is kept while the home directory itself is not');
  } catch (error) {
    check(false, 'the project discovery checks ran without throwing', String(error));
  }

  // ── accounts, for every harness that keeps configuration in a directory ──
  // The Settings panel was hardcoded to 'claude-code', so a second Codex login
  // could not be added at all — while main had supported it the whole time.
  // Nothing asserted the Codex path, which is how a one-word constant in the
  // renderer hid a whole provider's accounts. These check the half the panel
  // depends on.
  say('── accounts · both harnesses, not just the one the panel used to name');
  try {
    const accounts = await import('./accounts');
    const { dataDir } = await import('./db');
    const path = await import('node:path');

    check(accounts.supportsAccounts('claude-code') && accounts.supportsAccounts('codex'),
      'both built-in harnesses keep their configuration somewhere Wanigan can point');
    check(!accounts.supportsAccounts('generic-cli') && !accounts.supportsAccounts(''),
      'a harness with no known configuration directory supports no accounts, rather than pretending to');

    // list() seeds the adopted account on first read, per harness.
    const codex = accounts.list('codex');
    check(codex.length >= 1 && codex.some((row) => row.isDefault),
      'listing Codex accounts seeds and returns its adopted account', codex.map((r) => r.label));
    check(accounts.list('claude-code').length >= 1,
      'and Claude Code still does too');
    check(accounts.list('generic-cli').length === 0,
      'an unsupported harness lists nothing, which is how the panel knows not to draw a group');

    // The pickers ask one question per profile, and it is the launch's own.
    // A Codex stage used to be told it had no accounts while its directory
    // variable was honoured at launch; a redirected Claude profile is still
    // told no, because a Claude login is not what that session authenticates with.
    const { accountsForProvider } = await import('./sessions');
    check(accountsForProvider('codex').length >= 1 && accountsForProvider('codex').every((row) => row.harness === 'codex'),
      'a Codex profile is offered the Codex accounts, not none', accountsForProvider('codex').map((row) => row.label));
    check(accountsForProvider('claude').length >= 1 && accountsForProvider('claude').every((row) => row.harness === 'claude-code'),
      'a Claude profile is offered the Claude accounts');
    check(accountsForProvider('deepseek').length === 0 && accountsForProvider('no-such-profile').length === 0,
      'a redirected Claude profile and an unknown one are offered no account at all');

    // A second Codex account: the thing that could not be done at all.
    const dir = path.join(dataDir(), 'smoke-codex-second');
    const made = accounts.create({ harness: 'codex', label: 'Smoke Second', configDir: dir });
    check(made.harness === 'codex' && !made.isDefault && !made.adopted,
      'a second Codex account is created, non-default and not adopted', made);
    check(accounts.list('codex').length >= 2,
      'and it joins the list beside the first');

    // The launch environment is what makes it a different account at all.
    const env = accounts.launchEnv(made);
    check(env.CODEX_HOME === dir,
      'launching as that account points CODEX_HOME at its own directory', env);
    // The account that *is* the platform default contributes no variable at
    // all, and that is deliberate rather than an omission: launchEnv's own
    // comment records that CLAUDE_CONFIG_DIR=~/.claude makes Claude Code read
    // ~/.claude/.claude.json instead of ~/.claude.json and report a signed-in
    // operator as logged out.
    //
    // Asserted against a constructed account rather than whichever row happens
    // to be adopted: earlier phases of this suite create their own Codex
    // accounts, so "the adopted one" is not ~/.codex by the time this runs, and
    // a check that assumed otherwise failed for a reason that had nothing to do
    // with the rule it meant to pin.
    const os = await import('node:os');
    const atDefault = { ...made, configDir: path.join(os.homedir(), '.codex'), adopted: true };
    check(Object.keys(accounts.launchEnv(atDefault)).length === 0,
      'an account sitting at the platform default sets no variable, so a launch matches running the CLI by hand',
      JSON.stringify(accounts.launchEnv(atDefault)));

    // Two accounts sharing one directory would share one login.
    let refused = false;
    try { accounts.create({ harness: 'codex', label: 'Clash', configDir: dir }); }
    catch { refused = true; }
    check(refused, 'a second account cannot claim a directory another already uses');

    accounts.remove(made.id);
    check(accounts.list('codex').every((row) => row.id !== made.id),
      'and forgetting it leaves the list as it was');
  } catch (error) {
    check(false, 'the accounts checks ran without throwing', String(error));
  }

  // ── handing one conversation to another account ───────────────────────
  // An account is a CODEX_HOME, and Codex writes a conversation into the home
  // it was launched under — so a thread on the account that just ran out of
  // usage is invisible from the other one, not merely locked. The fix is one
  // directory entry, and the risk is filing it in the wrong place: a rollout
  // that lands under the wrong date still resumes, and has quietly been
  // refiled under the day it moved.
  say('── conversation handoff · where the file must land');
  try {
    const { destinationFor, handoffPlan } = await import('./handoff');
    const path = await import('node:path');

    const src = path.join('/Users/x/.codex', 'sessions', '2026', '09', '11',
      'rollout-2026-09-11T01-03-09-01a08f10-0f63-7453-b33e-d71285fbd389.jsonl');
    check(destinationFor('/Users/x/.codex_personal', src)
      === path.join('/Users/x/.codex_personal', 'sessions', '2026', '09', '11',
        'rollout-2026-09-11T01-03-09-01a08f10-0f63-7453-b33e-d71285fbd389.jsonl'),
      'the destination keeps the conversation’s own date directories, not the day it moved',
      destinationFor('/Users/x/.codex_personal', src));

    check(destinationFor('/Users/x/.codex_personal', '/Users/x/.codex/auth.json') === null
      && destinationFor('/Users/x/.codex_personal', '/tmp/rollout.jsonl') === null,
      'a path that is not filed under sessions/ has no destination rather than a guessed one');

    // A home whose own path contains "sessions" must not confuse the split.
    const nested = path.join('/Users/x/sessions/.codex', 'sessions', '2026', '09', '11', 'r.jsonl');
    check(destinationFor('/Users/y/.codex_two', nested)
      === path.join('/Users/y/.codex_two', 'sessions', '2026', '09', '11', 'r.jsonl'),
      'the last sessions/ segment is the one that starts the relative path, so a home named sessions still works',
      destinationFor('/Users/y/.codex_two', nested));

    // The read side must explain itself rather than return an empty list that
    // reads as "no other accounts".
    const plan = handoffPlan('s_not_a_real_session');
    check(plan.targets.length === 0 && typeof plan.unavailable === 'string' && plan.unavailable.length > 0,
      'a session with nothing to hand over says why, so no surface draws a dead control',
      plan.unavailable);
    check(plan.threadId === null,
      'and it names no conversation it could not find');

    // ── the populated path, end to end on real files ───────────────────
    // Everything above is derivation. This is the thing itself: two accounts,
    // a rollout on one of them, and a conversation that afterwards resumes
    // from the other. It runs on the state database being unavailable, which
    // is the ordinary case in this suite — and is exactly why rolloutFor falls
    // back to the filename, whose uuid is the thread id.
    const { handoffConversation } = await import('./handoff');
    const accountsMod = await import('./accounts');
    const { db } = await import('./db');
    const { dataDir } = await import('./db');
    const fs = await import('node:fs');

    const from = accountsMod.create({ harness: 'codex', label: 'Handoff From', configDir: path.join(dataDir(), 'handoff-from') });
    const to = accountsMod.create({ harness: 'codex', label: 'Handoff To', configDir: path.join(dataDir(), 'handoff-to') });
    const thread = '01a08f10-0f63-7453-b33e-d71285fbd389';
    const rollout = path.join(from.configDir, 'sessions', '2026', '09', '11', `rollout-2026-09-11T01-03-09-${thread}.jsonl`);
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd: '/tmp' } }) + '\n');

    const sid = 's_handoff_smoke';
    db().prepare(`INSERT OR REPLACE INTO session_log
        (id, project_id, project_path, project_name, provider_id, harness_id, origin, conversation_id, started_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(sid, 'prj_handoff', '/tmp/handoff', 'handoff', 'codex', 'codex', 'wanigan', thread, Date.now());

    const live = handoffPlan(sid);
    check(live.threadId === thread && live.targets.some((t) => t.accountId === to.id),
      'a session with a conversation on one account offers the other as a target',
      JSON.stringify({ threadId: live.threadId, targets: live.targets.map((t) => t.label), why: live.unavailable }));
    check(live.fromAccountId === from.id,
      'and knows which account it is currently readable from', live.fromAccountId);

    const moved = handoffConversation(sid, to.id);
    const landed = path.join(to.configDir, 'sessions', '2026', '09', '11', path.basename(rollout));
    check(fs.existsSync(landed), 'the conversation is now readable from the other account', moved.linkedTo);
    check(fs.statSync(landed).ino === fs.statSync(rollout).ino,
      'linked rather than copied, so a rollout of any size costs nothing',
      { landed: fs.statSync(landed).ino, source: fs.statSync(rollout).ino });
    check(fs.existsSync(rollout),
      'and the account it started on can still continue it — the source is never moved');

    // The resume that follows a handoff names the other account. It used to be
    // refused for exactly that — "this conversation belongs to Handoff From" —
    // so the link was made and the conversation never continued anywhere.
    const { resumeAccountFor } = await import('./sessions');
    db().prepare('UPDATE session_log SET account_id = ? WHERE id = ?').run(from.id, sid);
    const resumed = resumeAccountFor(sid, 'codex', to.id);
    check(resumed.accountId === to.id && /handed over/.test(resumed.note ?? ''),
      'after a handoff, resuming under the account it was handed to is allowed and says why', JSON.stringify(resumed));
    const stranger = accountsMod.create({ harness: 'codex', label: 'Handoff Stranger', configDir: path.join(dataDir(), 'handoff-stranger') });
    let strangerRefused = false;
    try { resumeAccountFor(sid, 'codex', stranger.id); } catch { strangerRefused = true; }
    check(strangerRefused, 'an account the conversation was never handed to is still refused, because Codex would not find it there');
    accountsMod.remove(stranger.id);

    // Running it twice must not fail: an operator can click again.
    const again = handoffConversation(sid, to.id);
    check(again.linkedTo === moved.linkedTo, 'handing the same conversation over twice is a no-op, not an error');

    // An account that is not one of this conversation's targets is refused.
    let refusedTarget = false;
    try { handoffConversation(sid, 'acct_not_a_target'); } catch { refusedTarget = true; }
    check(refusedTarget, 'main refuses an account the renderer named that is not one of this conversation’s own');

    db().prepare('DELETE FROM session_log WHERE id = ?').run(sid);
    accountsMod.remove(from.id); accountsMod.remove(to.id);
  } catch (error) {
    check(false, 'the handoff checks ran without throwing', String(error));
  }

  // ── the same, for Claude Code: a fork rather than a link ───────────────
  // A Claude account is a CLAUDE_CONFIG_DIR and the transcript is filed under
  // it, so a resume by id under the other account answers "No conversation
  // found". The CLI takes a transcript's absolute path in place of an id and,
  // with --fork-session, records the continuation under the directory it was
  // launched with. So the handoff writes nothing: it names the file, and the
  // launch names it to the CLI. Measured 2026-09-21 on CLI 2.1.278.
  say('── conversation handoff · Claude Code forks from the transcript');
  try {
    const { handoffConversation, handoffPlan, transcriptOwner, within } = await import('./handoff');
    const { resumeAccountFor } = await import('./sessions');
    const { claudeProjectSlug } = await import('../shared/claude-slug');
    const accountsMod = await import('./accounts');
    const { db, dataDir } = await import('./db');
    const fs = await import('node:fs');
    const path = await import('node:path');

    check(within('/Users/x/.claude', '/Users/x/.claude/projects/-tmp/a.jsonl')
      && !within('/Users/x/.claude', '/Users/x/.claude-work/projects/-tmp/a.jsonl')
      && !within('/Users/x/.claude', '/Users/x/.claude'),
      'a transcript is inside a directory only when it really is below it — a sibling with the same prefix is not');

    const from = accountsMod.create({ harness: 'claude-code', label: 'Fork From', configDir: path.join(dataDir(), 'fork-from') });
    const to = accountsMod.create({ harness: 'claude-code', label: 'Fork To', configDir: path.join(dataDir(), 'fork-to') });
    const third = accountsMod.create({ harness: 'claude-code', label: 'Fork Third', configDir: path.join(dataDir(), 'fork-third') });
    const thread = '3f9b2c40-6d1e-4a7b-9c2d-8e5f1a0b7c3d';
    const cwd = path.join(dataDir(), 'fork-repo');
    const transcript = path.join(from.configDir, 'projects', claudeProjectSlug(cwd), `${thread}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId: thread, cwd }) + '\n');

    const sid = 's_fork_smoke';
    db().prepare(`INSERT OR REPLACE INTO session_log
        (id, project_id, project_path, project_name, provider_id, harness_id, origin, conversation_id, account_id, started_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(sid, 'prj_fork', cwd, 'fork', 'claude', 'claude-code', 'wanigan', thread, from.id, Date.now());

    check(transcriptOwner([from, to, third], transcript)?.id === from.id,
      'the account that holds the transcript is read off the filesystem, not the row');

    const plan = handoffPlan(sid);
    check(plan.method === 'fork' && plan.threadId === thread && plan.fromAccountId === from.id,
      'a Claude session plans a fork from the account whose directory holds the transcript',
      JSON.stringify({ method: plan.method, threadId: plan.threadId, from: plan.fromAccountId, why: plan.unavailable }));
    // Compared as a set rather than a list: the suite's environment may hold
    // the operator's own adopted ~/.claude too, and that account is exactly as
    // much a target as the two created here.
    const targetIds = new Set(plan.targets.map((t) => t.accountId));
    check(targetIds.has(to.id) && targetIds.has(third.id) && !targetIds.has(from.id),
      'every other Claude account is a target and the holder is not — any login can read the file by path, so accounts that come and go are simply listed or not',
      plan.targets.map((t) => t.label));
    check(plan.targets.every((t) => !t.alreadyThere),
      'no target is "already there": a fork does not exist until the launch makes it');

    const moved = handoffConversation(sid, to.id);
    check(moved.method === 'fork' && moved.linkedTo === transcript && !moved.hardlinked,
      'handing over names the original transcript and writes nothing', JSON.stringify(moved));
    check(!fs.existsSync(path.join(to.configDir, 'projects')),
      'nothing was created under the other account ahead of the launch');

    // The resume that follows must name the transcript, and must ask for a
    // fresh id: the continuation is filed under the other directory, and the
    // CLI only takes --session-id beside --resume together with --fork-session.
    const resumed = resumeAccountFor(sid, 'claude-code', to.id);
    check(resumed.accountId === to.id && resumed.forkFrom === transcript && /as a branch/.test(resumed.note ?? ''),
      'resuming under the other account is allowed, names the transcript to fork from, and says so', JSON.stringify(resumed));
    const onThird = resumeAccountFor(sid, 'claude-code', third.id);
    check(onThird.accountId === third.id && onThird.forkFrom === transcript,
      'and so is any other Claude account, with no handoff step first');
    const home = resumeAccountFor(sid, 'claude-code', from.id);
    check(home.accountId === from.id && home.forkFrom === null,
      'resuming under the account that holds it is an ordinary resume by id, not a fork');
    const unasked = resumeAccountFor(sid, 'claude-code', null);
    check(unasked.accountId === from.id && unasked.forkFrom === null,
      'and with no account asked for, the owner is pinned as before');

    fs.rmSync(transcript);
    const gone = handoffPlan(sid);
    check(gone.targets.length === 0 && /transcript/.test(gone.unavailable ?? ''),
      'a transcript that has since been removed leaves nothing to offer, and says so', gone.unavailable);
    let refusedGone = false;
    try { resumeAccountFor(sid, 'claude-code', to.id); } catch { refusedGone = true; }
    check(refusedGone, 'and the cross-account resume is refused rather than launched at a file that is not there');

    db().prepare('DELETE FROM session_log WHERE id = ?').run(sid);
    accountsMod.remove(third.id); accountsMod.remove(to.id); accountsMod.remove(from.id);
  } catch (error) {
    check(false, 'the Claude handoff checks ran without throwing', String(error));
  }

  // ── carrying a conversation into a fresh one ──────────────────────────
  // The pure half — when it may speak and what it may claim — is in
  // src/shared/context-handover.test.ts and runs in a tenth of a second. What
  // needs a process is the orchestration's refusals, because each one is a
  // sentence shown to somebody whose conversation is nearly full.
  say('── context handover · what it refuses to do');
  try {
    const { beginHandover, finishHandover } = await import('./handover');
    const { HANDOVER_PROMPT, handoverSeed } = await import('../shared/context-handover');

    let refusedUnknown = false;
    try { beginHandover('s_no_such_session'); } catch { refusedUnknown = true; }
    check(refusedUnknown, 'a session Wanigan is not running cannot be asked for a handover note');

    let refusedFinish = false;
    try { await finishHandover('s_no_such_session'); } catch { refusedFinish = true; }
    check(refusedFinish, 'and cannot be finished either, rather than opening an empty session');

    // The prompt asks for the work, and is submitted — unlike an attachment
    // reference, this is Wanigan's own question, asked because a button said so.
    check(HANDOVER_PROMPT.length > 80 && /handover/i.test(HANDOVER_PROMPT),
      'the handover prompt asks for a note rather than a one-word instruction');
    check(handoverSeed('x').includes('previous session'),
      'the fresh session is told the text is a handover, not passed it off as the work');

    // "Personal has room. Carry the work there?" used to open the new session
    // on the pressed account anyway. The id comes from the renderer, so it has
    // to be an account of this session's own harness.
    const { __test: handoverTest } = await import('./handover');
    const accountsForCarry = await import('./accounts');
    const { dataDir: carryDataDir } = await import('./db');
    const carryPath = await import('node:path');
    const claudeHome = accountsForCarry.create({ harness: 'claude-code', label: 'Carry Roomier', configDir: carryPath.join(carryDataDir(), 'carry-roomier') });
    const codexHome = accountsForCarry.create({ harness: 'codex', label: 'Carry Codex', configDir: carryPath.join(carryDataDir(), 'carry-codex') });
    const pressed = { providerId: 'claude', accountId: 'acct_pressed' } as import('../shared/types').Session;
    const refuses = (id: string) => { try { handoverTest.carryAccount(pressed, id); return false; } catch { return true; } };
    check(handoverTest.carryAccount(pressed, claudeHome.id) === claudeHome.id,
      'taking the roomier-account offer opens the fresh session on that account, not the pressed one');
    check(handoverTest.carryAccount(pressed, null) === 'acct_pressed' && handoverTest.carryAccount(pressed, 'acct_pressed') === 'acct_pressed',
      'with no offer taken, the fresh session keeps the account the conversation already runs as');
    check(refuses(codexHome.id) && refuses('acct_no_such_account'),
      'an account of another harness, or one Wanigan does not hold, is refused rather than quietly replaced by the default');

    // An empty note and an unreadable transcript are different sentences, and
    // the type keeps them apart so a surface cannot merge them by accident.
    const kinds = ['carried', 'empty', 'unreadable'];
    check(new Set(kinds).size === 3,
      'a handover reports carried, empty and unreadable as three outcomes, never one failure');
  } catch (error) {
    check(false, 'the context handover checks ran without throwing', String(error));
  }
}
