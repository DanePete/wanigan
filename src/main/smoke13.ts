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
    check(missingCredentialIds('claude').length === 0 && missingCredentialIds('codex').length === 0,
      'a profile that declares no credential is never held back by this guard',
      { claude: missingCredentialIds('claude'), codex: missingCredentialIds('codex') });
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
  } catch (error) {
    check(false, 'the handoff checks ran without throwing', String(error));
  }
}
