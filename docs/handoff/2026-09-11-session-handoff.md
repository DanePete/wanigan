# Handoff — 11 September 2026

State of `feat/xai-grok-provider` at `ab3b3ce`. Written for whoever picks this
up next, session or person.

## Where things stand

| | |
|---|---|
| Branch | `feat/xai-grok-provider`, **19 commits ahead of `origin/main`** |
| HEAD | `ab3b3ce` |
| CI | green — `CI` and `Hygiene` both pass |
| `npm test` | **eight** steps, ~48s, 1617 assertions, 0 failures |
| Working tree | **35 modified files, uncommitted, not mine** |
| Installed app | `/Applications/Wanigan.app` rebuilt and running as of 15:35 |

## Read this first

**1. The working tree is not yours.** Thirty-five files carry other agents'
in-flight work, including `tsconfig.node.json` and `tsconfig.web.json`. Do not
`git add .`. `AGENTS.md` is explicit: preserve existing working-tree changes,
never reset or checkout unrelated work. When you need one line out of a dirty
file, filter the patch and `git apply --cached` it — that is how `ab3b3ce`
committed a single line of `smoke3.ts` while leaving thirteen other lines of
somebody else's work exactly where they were.

**2. A green `npm test` locally does not mean a green HEAD.** `npm test` reads
the working tree; CI reads the commit. Two half-applied changes were committed
without their other half, and the uncommitted halves masked both locally. CI was
red for **eleven consecutive runs**, `7597d47` through `77bc6ea`, and the second
failure hid the first:

- `7597d47` renamed `useOf` → `usageOf` in `Settings.tsx`, but the string
  `smoke3.ts` asserts on stayed the old name. Typecheck was still clean here;
  the failure was in smoke. (Verified: that commit typechecks.)
- `d7689c3` then dropped the `onAddProject` prop from the `NewSessionDialog`
  call site in `Sessions.tsx` while the component still required it. From there
  CI died at step one, so **the smoke suite stopped running on this branch
  entirely** — and the older smoke failure became invisible until typecheck was
  fixed. (Verified: `7597d47` typechecks clean, `d7689c3` does not.)

To check HEAD honestly, use a detached worktree rather than trusting a local
run:

```bash
W=/tmp/verify-head
git worktree add --detach "$W" HEAD
ln -s "$PWD/node_modules" "$W/node_modules"
(cd "$W" && npm run typecheck && npm run test:lint)
git worktree remove --force "$W"
```

**3. Nothing in this session's CI work is live on `main` yet.** CodeQL and
Scorecard only trigger on `main`. Until this branch merges, they have never run.

## What changed this session

Seven commits, `f3e0d50..ab3b3ce`. Two of them are other people's work I only
finished.

**`f3e0d50` — Recent says what a conversation was about.** 5 of 49 conversations
had a name; the rest rendered as their project folder. Claude Code already
writes an `ai-title` record into its own transcript and both harnesses record
the first prompt, so this is a read, not a write — no model is asked anything
and nothing is summarised. 47 of 49 named, measured against the real database.
Pure parsing in `src/shared/session-title.ts` (fast lane), file handling and
cache in `src/main/transcripts.ts`, batched Codex resolution in
`codexRolloutFiles`. `titleSource` says whether a name is the operator's, the
agent's, or the first question, and the row tooltip says so out loud.

Exact matches only, deliberately: `transcriptPathFor` falls back to the newest
transcript in a project when an id is gone, which would caption an old
conversation with a newer one's title. A smoke check pins this with two named
transcripts sitting in the directory the unnamed one would have borrowed from.

`npm run probe:recent` runs the app against a **copy** of the real database and
asserts geometry, not just text. It caught two defects review could not: rows
wrapping to three lines, and the row's text getting 153px of 231 because pin,
settle and forget held 71px permanently.

**`0804a67` — knip.** `@electron/asar` was required by two suites inside
`npm test` while nothing declared it; it resolved only as a transitive
dependency of electron-builder. `@xterm/addon-search` was declared and never
imported.

**`e591ce9` — ESLint.** There was no linter at all. Found a `ReferenceError` in
`scripts/shots-browser.mjs` (`browser.close(); server.close()` where neither name
exists — `openRenderer` returns `{ page, close }`), plus two `eslint-disable`
directives naming a rule typescript-eslint renamed in v8, so both had silently
stopped disabling anything.

**`9d77a7a` — CodeQL, Hygiene, Scorecard, `CODE_OF_CONDUCT.md`.** shellcheck
found three real bugs before its own workflow existed: two `cd` without
`|| exit`, and a `find | xargs stat` that breaks on paths containing spaces.

**`22225ff`, `ab3b3ce`** — the two half-applied changes above. Not mine; both
fixes were already sitting uncommitted in the working tree and only needed
committing. `ab3b3ce` staged one line out of a file carrying thirteen other
lines of somebody's in-flight work.

**`77bc6ea` — pinned shellcheck.** See *Version drift* below.

## The gates, and how to work with them

`npm test` is now: `typecheck`, `test:shared`, `test:renderer-style`,
`test:dead-code`, `test:lint`, `test:package-hooks`, `test:local-install`,
`smoke`.

**`test:dead-code`** is knip, configured in `knip.json`. It gates unused files,
unused dependencies and undeclared imports — all clean. **Over-exports are
excluded**: 212 symbols are `export`ed but referenced only inside their own file.
That is public surface, not dead code, and `noUnusedLocals` structurally cannot
see it. `npm run dead-code:all` lists them.

**`test:lint`** is ESLint, and deliberately not a style tool — formatting is
settled by review and the renderer's structural rules belong to the style gate.
`eslint-suppressions.json` holds **73 real findings across 36 files**. ESLint
enforces the ratchet both ways by itself: a new violation fails, and a
suppression whose violation has been fixed fails too until you run
`npm run lint:prune`. `npm run lint:debt` ranks what is left.

Four entries in that baseline are worth a look rather than a sweep:

| Where | What |
|---|---|
| `src/main/index.ts` ×2 | `app.whenReady().then(async …)` floats — bootstrap rejection with no handler |
| `src/main/sessions.ts` | floating `.finally()` on worktree cleanup |
| `src/renderer/src/components/bits.tsx` | floating promise |
| `scripts/install-local-macos.cjs` | `throw` inside `finally`; deliberate and commented, but if the try block also threw, the original `installError` is lost |

The other 36 are `react-hooks/exhaustive-deps` — the stale-closure class already
hit by hand in `HandoverBubble`, which needed a ref to keep `showing` current.

## Open items, ranked

**1. Branch protection on `main` is not set.** I was blocked from applying it
(repo-settings mutation). It is the single biggest OpenSSF Scorecard lever, and
the badge will read low until it is on — that is a real signal, not a glitch.
Configured below so you are never locked out (`enforce_admins: false`) and can
self-merge (`0` approvals). Only the two contexts that actually report on `main`
today are required; requiring Hygiene or CodeQL before they have ever run there
could deadlock a merge.

```bash
gh api -X PUT repos/DanePete/wanigan/branches/main/protection --input - <<'JSON'
{"required_status_checks":{"strict":true,"contexts":["typecheck + smoke","macOS packaging suites"]},
 "enforce_admins":false,
 "required_pull_request_reviews":{"required_approving_review_count":0,"dismiss_stale_reviews":true,"require_code_owner_reviews":false},
 "restrictions":null,"allow_force_pushes":false,"allow_deletions":false,
 "required_linear_history":true,"required_conversation_resolution":true}
JSON
```

**2. Merge this branch to `main`.** Nineteen commits, and CodeQL and Scorecard
do not run until it lands. Deliberately not done unasked — it is a big call on a
public repo.

**3. ~~`conduct@deadnorth.io` must exist.~~ Resolved.** `CODE_OF_CONDUCT.md`
now points at `support@deadnorth.io`, which already exists — no new alias
needed. The domain also serves `security@deadnorth.io` for `SECURITY.md`.

**4. Not started, in rough value order:** the 22 circular import chains in
`src/main` (`sessions → mcp/registry → mcp/server → batch/index → batch/poll →
notify → mobile → control → sessions`); the 212 over-exports; the 36
`exhaustive-deps` findings. None is urgent; all three are legibility costs a new
contributor pays.

## Things already measured — do not redo these

- **No secrets in history.** gitleaks scanned 167 commits; the 28 findings
  were examined individually and every one is a fixture: a key whose body reads
  `smokekeymaterial`, jwt.io's published example token, sequential placeholders,
  and SHA-256 content hashes in the visual-regression manifests.
- **No Electron vulnerability.** Electronegativity reports nothing real;
  `contextIsolation`, `sandbox: true`, `nodeIntegration: false`, `webSecurity`
  and `allowRunningInsecureContent: false` are all set correctly, and
  `openExternal` is protocol-checked in main.
- **`npm audit`: 0 vulnerabilities.**
- **Codex sessions contribute 0 rows to Recent on this machine** — all 33 have
  no conversation id, and `pastSessions()` excludes rows without one. The Codex
  title path is still implemented and smoke-tested; it just has nothing to do
  here.

## Traps worth knowing

**Allowlists by value, not by path.** The first `.gitleaks.toml` scoped its
exception to `src/main/smoke*.ts`. Tested with a real-shaped GitHub token
planted inside `smoke3.ts`, it sailed through. It now matches the four literal
fixture strings instead, so a real credential fails wherever it is committed.
Both directions are verified; re-run that control if you touch the file.

**Version drift makes a linter stop being a gate.** Hygiene passed locally and
failed its first CI run: the runner's shellcheck predates 0.11.0, which moved
SC2002 out of its defaults. actionlint, gitleaks and shellcheck are now all
downloaded at pinned versions in `.github/workflows/hygiene.yml`, and dependabot
watches the action versions.

**Redirection order.** `tr -d 'v \n' < .nvmrc 2>/dev/null` is the obvious
rewrite of `cat .nvmrc | tr …` and it is wrong — bash reports the missing file
on the still-unredirected stderr. `2>/dev/null` has to come first. These scripts
handle a missing `.nvmrc` silently by leaving `WANT` empty.

**ESLint 9 does not read `.gitignore`.** Three gitignored bundles at the repo
root accounted for 2,446 of the first run's 4,303 problems. `includeIgnoreFile`
handles it.

**`node:test` returns promises.** 54 of 58 `no-floating-promises` hits were
top-level `test()` calls the runner itself awaits. `allowForKnownSafeCalls`
removes them; recording them would have been recording noise as debt.

**A PNG is not proof.** `probe:recent` passed every content assertion while each
row silently wrapped to three lines. Open the screenshot yourself — the
assertions only cover failures you already thought of.

## Commands

```bash
nvm use                      # Node 22.23.2; Node 16 cannot build this
npm test                     # all eight gates, ~48s
npm run lint:debt            # what the linter is holding its nose about
npm run lint:prune           # take fixed suppressions off the books
npm run dead-code:all        # including the 212 over-exports
npm run probe:recent         # Recent names, against a copy of the real database
npm run dist:mac:arm64:install   # rebuild and install; refuses while the app runs
```
