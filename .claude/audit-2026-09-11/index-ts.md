# index.ts — 3 findings

## src/main/index.ts:2079 — [high] correctness  (CONFIRMED, sustained 3/3)

**Claim.** `key:provider` answers presence from the credential file alone (`hasProviderKey`) while every consumer that actually uses the credential reads it through `getProviderKey`, where `WANIGAN_<ID>_KEY` wins — so with that documented env hatch in use the GLM/DeepSeek/xAI panels state the opposite of what the same process does.

**Evidence.**

```
src/main/index.ts:2076-2082 `handle('key:provider', (rawId: string) => { … return { present: hasProviderKey(id), fingerprint: providerKeyFingerprint(id) }; });` with keys.ts:236-237 `return fs.existsSync(providerKeyFile(id));`. The launch path disagrees: keys.ts:241-243 `// An explicit env var still wins, for CI and scripted runs.` / `const fromEnv = process.env[\`WANIGAN_${id.toUpperCase()}_KEY\`]; if (fromEnv) return fromEnv;`, used by providers.ts:282 `const key = getProviderKey('glm'); if (!key) return {};` and by providers.ts:450 `return [...ids].filter((id) => !getProviderKey(id));`. docs/provider-packs.md:220-221 calls it supported and explicit: "`WANIGAN_<ID>_KEY`, with the id uppercased verbatim, wins over anything stored." The Anthropic sibling handles exactly this case (index.ts:2055-2058 `present: hasKey() || Boolean(process.env.ANTHROPIC_API_KEY)`, `fromEnv: …`), and `ProviderKeyStatus` (Settings.tsx:22) has no `fromEnv` field at all.
```

**Failure.** `export WANIGAN_GLM_KEY=…` with nothing stored: GLM sessions launch and authenticate (providers.ts:282 sets `ANTHROPIC_AUTH_TOKEN` from it) and the new-session dialog asks for nothing (providers.ts:450), yet Settings.tsx:922 renders "No Z.ai Coding Plan key stored. GLM sessions cannot authenticate until you add one." and withholds Verify/Remove. Worse after the operator "fixes" it by pasting a key: `setProvider` verifies and stores the pasted key, but `glmVerify()` (Settings.tsx:546/555) and `providerKeyFingerprint` both resolve through `getProviderKey`, so the panel then shows the env key's fingerprint and reports the env key's verification result — if the exported key is expired the panel shows a red failure for a key that was just verified and stored, and Remove (clearProviderKey, file only) cannot remove the credential the sessions are actually using.

**Fix.** Make `key:provider` report effective presence the way `key:status` does — `present: hasProviderKey(id) || Boolean(process.env[\`WANIGAN_${id.toUpperCase()}_KEY\`])` plus a `fromEnv` flag — and render the env case in the three panels with the same precedence note the Claude panel uses at Settings.tsx:815-821.

---

## src/main/index.ts:919 — [low] silent-drop  (CONFIRMED, sustained 3/3)

**Claim.** Hook events from headless fan-out runs are dropped before they can become learning signals, because the listener resolves the session through the interactive-session map only — so a headless run can be counted at the Briefed station and can never be counted at the Observed station, and no surface says so.

**Evidence.**

```
src/main/index.ts:919-920 `const s = listSessions().find((x) => x.id === e.sessionId); try { learning.observeSessionEvent(e, s); }`; src/main/sessions.ts:490-492 `export function listSessions(): Session[] { return [...sessions.values()].map((s) => s.meta)… }` — the live PTY map, which never holds a headless row; learning-service.ts:1851 `if (!learningSettings().enabled || !session) return null;`. Yet headless.ts:984 `let hookSettings: string | null = takesHooks && hooksOn ? writeHookSettings(hookId, cwd, { providerId: def.id, … query: cfg.prompt }) : null;` registers a learning briefing context under a synthetic id (`hookSessionId(runId, projectId)`), and headless consumes the capsule (headless.ts:1029). Neither learning-service.ts nor src/main/learning/ mentions headless anywhere, so nothing records this as a decision.
```

**Failure.** Run a 12-repository Claude fan-out with the hook bus on. Its tool events are stored in `session_events` and feed the Insights tool statistics and the MCP call counter, and its briefings are recorded and counted at PipelineSpine's "Briefed · served" station (Learning.tsx:636). `observeSessionEvent` returns null for every one of those events, so "Observed · signals · last 30d" reads 0 for the same window, and the chart caption (Learning.tsx:1028-1030) explains the zero only in terms of Claude-versus-Codex event granularity.

**Fix.** Resolve the session for learning from the same record headless already has — pass the frozen project/provider/backend context registered at headless.ts:984-990 into `observeSessionEvent` instead of requiring a live `Session` — or, if excluding unattended runs is deliberate, say it in one comment at index.ts:919 and in the SignalsPerDay caption.

---

## src/main/index.ts:2013 — [low] trust-boundary  (CONFIRMED, sustained 3/3)

**Claim.** `checkpoints:removeRepo` hands the renderer's path straight to git and only confines the repository afterwards, so a git command runs with an arbitrary directory as its working tree before any managed-root check.

**Evidence.**

```
src/main/index.ts:2013-2014 `handle('checkpoints:removeRepo', (projectPath: string, apply: boolean) => checkpoints.removeRepoCheckpoints(String(projectPath), apply === true));` — no `assertManagedRoot`, unlike every path-taking handler around it (index.ts:2199-2216, e.g. `handle('worktrees:remove', (p, force) => worktrees.removeWorktree(assertManagedRoot(p, 'That worktree'), force))`, whose comment says "that leaves every worktree on the machine in range of a channel name"). In src/main/checkpoints.ts:493-496 the order is: `const top = await runGit(projectPath, ['rev-parse', '--show-toplevel'], …); … assertManagedRoot(root, 'That repository');` — the spawn precedes the guard, and runGit (git.ts:129) runs `git -C <projectPath> …`.
```

**Failure.** A call such as `checkpoints.removeRepo('/Users/dane/some-other-clone', false)` spawns `git -C /Users/dane/some-other-clone rev-parse --show-toplevel` against a repository Wanigan does not manage, reading that repository's `.git/config` (including any `include.path` it names). The two distinct error strings — "That folder is not a git repository" vs "That repository is outside every project…" — also let a caller enumerate which arbitrary filesystem paths are git repositories.

**Fix.** Confine first: `checkpoints.removeRepoCheckpoints(assertManagedRoot(projectPath, 'That repository'), apply === true)`, and keep the existing post-`rev-parse` assertion as defence in depth.

---
