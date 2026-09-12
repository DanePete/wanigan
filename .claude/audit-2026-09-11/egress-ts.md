# egress.ts — 2 findings

## src/main/egress.ts:68 — [medium] privacy-report-accuracy  (CONFIRMED, sustained 3/3)

**Claim.** The egress report's "active now" column for api.z.ai, api.deepseek.com and api.x.ai is computed from the credential file only, so it prints a definite "no" for hosts that an env-provided provider key is actively sending every session request to.

**Evidence.**

```
egress.ts:66-81 `function glmKey() { try { return hasProviderKey('glm'); } … }` (same for deepseek/xai), feeding egress.ts:178-180 and the rows at :265 `when: 'Only when a Z.ai provider key is stored.', activeNow: glm` and :274 `'Only for sessions launched on the GLM provider, and only when a Z.ai key is stored.'`. The Anthropic helper immediately above gets it right, and says so: egress.ts:57-59 `/** Whether a Platform key is reachable at all — stored, or handed in by the shell. */` / `return getKey() !== null;`, with its row at :219 reading "Only when a Claude Platform key is stored or ANTHROPIC_API_KEY is set." The renderer turns the boolean into a flat claim: Settings.tsx:2079 `<Mark {...contactable(h.activeNow)} />` and :2034-2036 `: { glyph: '○', word: 'no', color: 'var(--text-faint)' }`.
```

**Failure.** With `WANIGAN_XAI_KEY` exported and no stored xAI file, a Grok session sends every request to api.x.ai (providers.ts env block via getProviderKey), while Privacy & data → "What leaves this machine" renders "○ no" in the active-now column for both api.x.ai rows and a `when` clause saying it happens "only while an xAI key is stored". The privacy panel states as observed fact that a host is not being contacted while it is.

**Fix.** Use the effective resolver in all three helpers — `getProviderKey('glm') !== null` etc. — and widen the three `when` strings to name the `WANIGAN_<ID>_KEY` override the way the Anthropic row names ANTHROPIC_API_KEY.

---

## src/main/egress.ts:335 — [medium] incomplete-disclosure  (PLAUSIBLE, sustained 2/3)

**Claim.** "What leaves this machine" states the only condition under which Wanigan reaches a provider's API host as a session running on that provider, but the learning phrasing pass reaches the same host on a five-minute timer with nobody present, and no row or clause on that table covers it.

**Evidence.**

```
src/main/egress.ts:330-341 — host `api.anthropic.com`, `by: 'agent'`, `purpose: 'Where the Claude Code CLI sends your prompts under its own login. Wanigan neither supplies nor sees that credential.'`, `when: 'Whenever a session runs on the Claude provider.'` (the GLM, DeepSeek and xAI rows at :273/:288/:302 are scoped to "sessions" the same way). Against that: learning-service.ts:1985-1994 `consolidationTimer = setInterval(() => { try { consolidate(undefined, 'timer'); } … void phrasePendingNominations()…`, and learning-model-assist.ts:492-505 resolves the CLI binary, builds argv and `env = headlessEnv(await shellPath(), def.env?.() ?? {}, accounts.launchEnv(account));` before spawning it. Settings renders that `when` string verbatim (Settings.tsx:2078 `<td className="dim" …>{h.when}</td>`) under the section hint "Every host Wanigan can open a connection to and why" (Settings.tsx:2044), and maps `by: 'agent'` to "the agent CLI" (Settings.tsx:2023).
```

**Failure.** Approve a profile for model-assisted phrasing and set a monthly ceiling in Learning → Context (Learning.tsx:2644-2800). Start no session at all. Every five minutes the timer runs `phrasePendingNominations()`, which spawns the provider CLI with the stored account environment and bills a real call. Settings → Privacy & data → "What leaves this machine" still says that host is reached only "Whenever a session runs on the Claude provider", attributes it to the agent CLI rather than to Wanigan, and the operator cannot find the traffic they are paying for on the one panel built to enumerate it.

**Fix.** Add a `by: 'wanigan'` row (or a second clause on each provider row) whose `when` names the real condition: "Also whenever model-assisted phrasing is on and a consolidation pass has a claimable cluster — an unattended call every 5 minutes at most, carrying operational counters and no transcript — and once per pricing probe", with `activeNow` read from the effective `learning.settings().allowModelAssistance`.

**Dissent (the verifier who refuted).** Three of the finding's load-bearing technical claims are wrong, and its stated reproduction does not reproduce.

1. The attribution claim is backwards. The finding treats `by: 'agent'` as a misattribution ("attributes it to the agent CLI rather than to Wanigan"). But the column is defined in the renderer as who opens the socket — src/renderer/src/views/Settings.tsx:2021 `/** Who opens the socket. An agent binary's own traffic is not Wanigan's to claim. */`, with `agent: 'the agent CLI'` at :2023. The phrasing pass does not fetch() anything: learning-model-assist.ts:484-505 resolves the CLI binary and `run(bin, argv, scratch, env)` spawns it (`import { spawn } from 'node:child_process'`, :1). The socket to api.anthropic.com is opened by the spawned Claude Code CLI process under its own login — `accounts.launchEnv()` supplies a config-dir selection, not a credential. So `by: 'agent'` is the correct value for this traffic by the table's own semantics, and the "purpose" sentence ("Wanigan neither supplies nor sees that credential") stays true of it.

2. "No row or clause on that table covers it" is false. The panel renders UNENUMERATED verbatim in a warning Callout (Settings.tsx:2097-2100, title "This is Wanigan's own traffic. It is not everything that leaves this machine."), whose first bullet is egress.ts:485 — "The agent CLI is a separate program with its own network behaviour. Wanigan spawns it and sets the variables below; it does not proxy that traffic and cannot enumerate it." A Wanigan-spawned agent-CLI call is precisely what that clause covers. The table's declared scope is narrower than the finding assumes: egress.ts:26 "enumerated by hand from `fetch(` in src/main", and PROVENANCE (egress.ts:494-498) flags the `agent` rows as the unmeasured exception — "named from the CLI's own documented endpoints rather than anything Wanigan observed, and reported as unknown rather than measured" — which is why that row carries `activeNow: null` with the comment at :337 ("Wanigan cannot read the CLI's own configuration"). Reading that row's prose as an exhaustive, binding enumeration of every Wanigan-initiated spawn asserts more precision than the row claims for itself, two paragraphs above a callout that says so.

3. The failure scenario does not fire. "Start no session at all" yields no signals, so learning-service.ts:1408-1410 (`listCandidates({status:['pending']}).filter(isUnauthoredNomination)`) returns an empty list and the loop body never executes — no spawn, no argv, no billed call. A phrasing call additionally requires signals carrying a providerId/backendId matching the consented profile (assessRouting refuses `no-attribution` and cross-provider at learning-model-assist.ts:284-300) and `phrasingEligibility` to pass (:1280-1310). So the spend is not "every five minutes with nobody present"; it is gated on evidence that only prior sessions on that same provider can create.

4. "The operator cannot find the traffic they are paying for" is false. Learning.tsx:2786-2796 prints `$X recorded this month across N call(s) read back ... averaging $Y a call`, and the consent preview at :2735-2745 shows the exact argv, the payload field list, the denied tools and the environment destination names before approval.

What survives is thin and not what was filed: the Claude row's `when` prose says "sessions" where a headless spawn also occurs — a looseness the GLM/DeepSeek/xAI rows share, and which the headless-run path (src/main/headless.ts, operator- and schedule-initiated) already has too, so it is not a gap unique to the phrasing pass. As a correctness finding it does not stand: the attribution is right, a clause does cover it, and the reproduction produces no call.

---
