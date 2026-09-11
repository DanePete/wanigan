# Wanigan — agent guide

This is the one instruction file for this repository, and every agent reads it.
Codex, Copilot, Cursor, Gemini, Jules, Zed and the rest read `AGENTS.md`
natively; Claude Code does not, so `CLAUDE.md` is a single `@AGENTS.md` import
plus the handful of notes that are true only of Claude Code. Put shared rules
here. A rule that lands in one file and not the other is a rule half the agents
working in this repository have never seen.

There used to be two near-identical copies of this file kept in step by hand,
and they drifted 49 lines apart — including one contradiction about whether
model-assisted consolidation was connected, which is the rule that governs
spending money. A find-and-replace across the copy also invented directories
that do not exist (`.Codex/skills/`, `.Codex/rules/`) and deleted the Claude
half of two mappings. One file cannot do that.

Wanigan is a local-first Electron control surface for coding agents. It starts
real CLI sessions, records their operational evidence, and lets one operator
review work across repositories. Preserve that premise: do not replace a real
agent interaction with a simulation, and do not present an estimate or a guess
as observed fact.

## Working in this repository

- Use Node `22.23.2` from `.nvmrc`. Node 16 cannot build this project; use
  `nvm use` before `npm` commands.
- Run `npm test` before handing off a code change. It is eight steps in order:
  `typecheck`, `test:shared`, `test:renderer-style`, `test:dead-code`,
  `test:lint`, `test:package-hooks`, `test:local-install`, then the offline
  main-process `smoke` suite. `test:shared`
  is plain `node --test` over `src/shared`, which is pure by construction: it
  answers in under a second, so a contract belongs there rather than in the
  thirty-second suite whenever it needs no process. `test:dead-code` is knip over
  the entry points in `knip.json`: it fails on an unused file, an unused
  dependency, or one that is imported but never declared — the last being how
  `@electron/asar` stayed a transitive dependency of electron-builder while two
  suites in `npm test` required it directly. Over-exports are excluded from the
  gate as a backlog rather than a regression; `npm run dead-code:all` lists
  them. `test:lint` is ESLint, and it is not a style tool — formatting is
  settled by review and the renderer's structural rules belong to the style
  gate. Every rule it runs catches something `strict` and the style gate cannot
  see, and the type-aware half is the point: `no-floating-promises` needs the
  checker, and a `void somePromise()` that loses its `void` and its `.catch`
  swallows the rejection. `eslint-suppressions.json` is its baseline and obeys
  the same rule as every other one here — ESLint fails a new violation, and also
  fails a suppression whose violation has since been fixed, so the only edit is
  downward. `npm run lint:debt` ranks what is left; `npm run lint:prune` takes
  fixed entries off the books. CI runs the same eight, splitting
  the two macOS packaging suites onto a macOS runner. Run `git diff --check` for
  documentation and UI changes too.
- Renderer UI is built from the shared frame and primitives, and the style gate
  (`scripts/check-renderer-style.cjs`) enforces it. A new view roots on `.pane`
  with `PageHead`, and composes `SectionHead`, `Chip`, `Segmented`, `Mark`,
  `Pill`, `Stat`, `Note`, `EmptyState`, `Reading`, `Explainer` and `Hint` from
  `src/renderer/src/components/bits.tsx` rather than adding a new `*-card`,
  `*-head` or `*-chip` class family. No `<style>` in TSX: rules go in
  `src/renderer/src/styles/<surface>.css`, which declares no colour and spells no
  font size, padding or duration as a literal — those come from the tokens in
  `index.css` and `motion.css`. The gate's baselines are debts that only ratchet
  down. Every `<input>`, `<select>` and `<textarea>` carries an accessible
  name — `aria-label`, an `id` a `<label for>` points at, or the `<label>` it
  sits inside; a `<span className="label">` above the box names it for sighted
  readers only, and the gate holds that count at zero. A UI change ships with
  before and after screenshots of the affected view in both themes.
- Keep Electron's trust boundary intact: privileged work belongs in
  `src/main/`, the renderer reaches it only through typed preload APIs, and all
  renderer input is untrusted until validated in the main process.
- Do not write generated settings, hooks, MCP configuration, or memory for any
  harness into a user's repository just to make a session work. Wanigan owns and
  injects its runtime configuration from its user-data directory.
- Preserve existing working-tree changes. Inspect the diff before editing and
  never reset, checkout, or reformat unrelated work.

## Skills

Skills are reusable, task-scoped operating procedures; they are not a dumping
ground for project facts.

1. Before beginning a non-trivial task, check whether an applicable skill is
   already available and follow its `SKILL.md` in full.
2. Create a project skill only when a workflow recurs, needs ordered safety
   checks, or has supporting templates/scripts. Put it in your own harness's
   project skill directory — `.claude/skills/<skill-name>/SKILL.md` for Claude
   Code, `.agents/skills/<skill-name>/SKILL.md` for Codex and the other Agent
   Skills readers — with a short frontmatter description, explicit trigger,
   inputs, safe steps, verification, and boundaries.
3. Keep a skill narrow and composable. Prefer links to authoritative project
   docs or helper files over copying a large manual into `SKILL.md`.
4. Put a broadly personal workflow in the user skill directory, not this
   repository. Put project-specific workflows here so collaborators get the
   same behavior.
5. When a skill becomes inaccurate, fix or remove it in the same change that
   changes the workflow. An obsolete skill is worse than no skill because it
   gives confident bad instructions.

## Memory

Auto-memory is for durable, high-value knowledge learned while working on this
project. Treat it as a compact index, not a transcript.

- Remember stable architecture facts, non-obvious invariants, confirmed
  commands, and user preferences that will materially improve a later task.
- Do **not** remember secrets, API keys, tokens, private attachment contents,
  raw logs, temporary task status, unverified claims, or speculative TODOs.
- Keep `MEMORY.md` as concise pointers to topic files. Every harness loads a
  bounded prefix of it and silently drops the rest, so an index that outgrows
  that prefix is an index whose tail no session has ever seen. Claude Code's
  exact limit is in `CLAUDE.md`; do not assume another harness shares it.
- Put substantial durable detail in focused topic files and link it from the
  index. Prune or correct a memory when the code, dependency, or decision it
  describes changes.
- Promote a repeatable procedure from memory into a skill. Promote an always-on
  repository rule into this file. Leave one-off investigation notes in the task
  or an issue, not long-term memory.

## Product-specific guardrails

- A live PTY/agent process cannot survive a full Wanigan quit. Never promise
  that an application update will preserve a live session; saved projects,
  transcripts, and settings are different from a running terminal.
- The SQLite database and recorded evidence are the source of truth. Make
  migrations additive and preserve compatibility with existing user data.
- Keep external side effects explicit: validate URLs and IPC senders, require
  deliberate user action for destructive git or filesystem operations, and do
  not silently spend tokens or fan out work.
- Prefer an honest unsupported state to an invented integration. In particular,
  do not imply that a provider supports hooks, telemetry, resume, MCP, or batch
  execution until Wanigan has verified support end to end.

## Compound learning engine

- `learning_signals` contains bounded operational summaries and citations, not
  copied prompts, responses, attachments, web pages, or raw transcripts.
- Treat `knowledge_items` plus `knowledge_versions` as the canonical,
  provider-neutral source of truth. Provider instruction and skill files are
  reversible projections of that record, never a second canonical database.
- Keep provider/profile/backend ids opaque strings. Semantic model assistance
  may inspect content only through the same backend that first processed it,
  and only when the signal opted in. Cross-provider operational counts are fine;
  cross-backend semantic content is not.
- Model-assisted consolidation is connected, and its three gates are the
  contract: consent pinned to a profile fingerprint, routing to the backend
  that produced the signals on a declared protocol, and metering read from
  recorded runs. A harness that reports no usage is proven unmetered by its own
  call and refused by name; an unpriced call is recorded as unpriced and never
  totalled as spend. `learningSettings().allowModelAssistance` is stored intent
  only -- `learning-service.settings()` ANDs it with those gates, and that is
  the accessor every surface must read. It phrases nothing but unauthored
  nominations, and only where a claim can exist.
- `claimPossible()` decides both what Wanigan will pay a model to phrase and
  what it will interrupt a person to review. Keep it one predicate: an inbox row
  nobody can action is the same defect as a billed call nobody can use. A
  repeated success carries no claim, so it is consumed rather than nominated.
- Preserve the hybrid automation boundary: only reversible personal `memory`
  with high confidence and at least two independent evidence sources/tasks may
  auto-promote. Project/path artifacts, skills, instructions, rules, gates,
  settings and global procedures always go through the review inbox.
- Compile one approved candidate independently for each requested provider.
  Claude project skills live under `.claude/skills/`; Codex/Agent Skills under
  `.agents/skills/`. Personal skills use those provider directories below the
  real home directory. Do not make one provider's generated artifact the input
  to another provider's compiler.
- Claude instructions project to `CLAUDE.md` or `.claude/rules/`; Codex
  instructions project to `AGENTS.md` or a nested directory `AGENTS.md`. If a
  scope has no faithful mapping, return `unsupported` instead of broadening it.
  Provider-generated/native memory is read-only.
- A projection must preserve its base hash, proposed bytes and prior contents;
  apply atomically only inside explicit roots and undo only when the applied
  hash still matches. Never auto-commit a learned projection.
- Validate citations immediately before briefing retrieval. Quarantine stale,
  missing, changed or out-of-root evidence before it reaches session context.
  Keep briefings query-scoped and inside their configured token budget.
- Do not call token savings causal unless a controlled experiment fixes the
  provider, model, effort and commit and ingests paired metrics. The current A/B
  registry does not launch workloads; a manually closed run remains an estimate.
  Mixed evidence inherits the weakest label.

## Provider packs

- A provider profile is the composition of a harness, model backend and launch
  configuration. Route behavior by declared harness/headless/capabilities, not
  by hardcoded profile ids such as `claude`, `codex`, or `glm`.
- Manifests are untrusted data. Validate size, ids, paths, fields and capability
  declarations in the main process, and compile launch values to `argv` entries
  without invoking a shell. Local manifests may name a dedicated installed CLI,
  never an absolute executable or pack-local fallback binary. Reject known
  shells/interpreters as defense in depth, but do not present a command-name
  denylist as proof that an unfamiliar executable is safe. Consent must display
  every base, version, help, launch-field and resume argv template plus every
  environment destination/source/literal/fallback (credential values remain
  redacted). Refuse loader/preload and Wanigan/privacy-control environment
  overrides; automatic probes receive only a minimal credential-free environment.
- Local manifests need explicit trust for the exact manifest digest. Optional
  executable adapters need separate approval for the inspected executable
  digest; trusting one must not trust the other. Adapter protocol v1 is a
  credential-free, time/output-bounded capability probe. Execute an owner-only
  staged copy made from the verified descriptor, terminate it on every error,
  intersect claims with both Wanigan's wiring and the frozen profile contract,
  and never describe the process boundary as OS-sandboxed or contained. V1
  adapters are self-contained probes and do not choose the session executable.
- Namespace local backend identities by pack id. A local pack cannot inherit a
  built-in or another pack's semantic memory by reusing its declared backend id.
  Local Claude/Codex harness claims require a separately trusted adapter; a
  manifest without one is generic-terminal only.
- Disabling or uninstalling a pack blocks new launches but does not reinterpret
  a live session. Keep the frozen pack/profile/backend/harness snapshot until it
  exits, defer removal while that profile is active, and preserve session
  history, credentials, knowledge, evidence and projections afterward.
