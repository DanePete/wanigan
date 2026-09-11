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
}
