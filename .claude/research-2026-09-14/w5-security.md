# W5: Security, governance and safety for coding agents (14 Sep 2026)

**Labels:** [V] = primary source fetched or queried this session (GitHub Security Advisory API via `gh api`, vendor docs, spec, paper abstract). [S] = a search-result summary or secondary reporting. [B] = blocked. Dates are advisory publication dates.

## 0. Headlines
- **Four bug classes account for most 2025–26 CVEs in Claude Code, Cursor and Codex.** Each defeated a safety mechanism; none was an unguarded path.
  1. Repo config runs code, or loosens policy, before consent.
  2. Command-string allowlists get bypassed.
  3. Sandbox escapes: a sandboxed process plants a file that something unsandboxed later runs or follows.
  4. Data leaves through pre-approved hosts.
- **Vendors now concede the point.** Claude Code's docs say a Bash deny/ask rule "isn't a security boundary around the program". [V code.claude.com/docs/en/permissions]
- **Approval fatigue is measured.** "Claude Code users approve 93% of permission prompts." [V anthropic.com/engineering/claude-code-auto-mode, 2026-03-25]
  - Auto mode's false-positive rate is 0.4% (n=10,000 real calls).
  - Its false-negative rate is 17% on real overeager actions (n=52) and 5.7% on synthetic exfiltration (n=1,000).
  - An independent test on ambiguous-authorization scenarios found an 81.0% false-negative rate. [S arXiv 2604.04978]
- **Detectors lose to adaptive attackers.** Attacks succeed more than 90% of the time against Protect AI, PromptGuard and Model Armor, and 71% against PIGuard. [S arXiv 2510.09023, 2025-10-10]

## 1. Incident and CVE record

### 1a. Repo config runs before trust
- **Claude Code** [V GHSA; mechanisms for 59536 and 21852 are S from Check Point]
  - CVE-2025-59536 (2025-10-03): hooks and MCP entries in repo settings ran before the trust dialog.
  - CVE-2025-65099 (2025-11-19): the same class.
  - CVE-2026-21852 (2026-01-20): a repo `ANTHROPIC_BASE_URL` leaked the API key before trust.
  - CVE-2026-33068 (2026-03-18, fixed 2.1.53): a committed `permissions.defaultMode: bypassPermissions` skipped the trust dialog.
  - CVE-2026-40068 (2026-04-24, fixed 2.1.84): a git-worktree `commondir` spoofed a trusted path, so hooks ran.
- **Codex CLI.** CVE-2025-61260 (CVSS 9.8, ≤0.23.0): a project `.env` and `.codex/config.toml` MCP entries ran at startup (Check Point). [S; not in openai/codex's GHSA list]
- **Cursor** [V GHSA]
  - CVE-2025-54136 "MCPoison": an approved MCP config could be swapped without a re-prompt.
  - CVE-2025-54135 "CurXecute": a prompt injection wrote MCP config files.
  - CVE-2025-64109: untrusted MCP config.
  - CVE-2025-54133 and CVE-2025-64106: the MCP deeplink hid its arguments, and its speedbump modal could be bypassed.
  - **CVE-2026-48124 (2026-05-21):** Cursor ran the workspace's `.claude/settings.local.json` hooks without approval. One harness executed another harness's config.
- **Copilot.** CVE-2025-53773: an injection made the agent write `"chat.tools.autoApprove": true` into `.vscode/settings.json`, giving RCE. Fixed Aug 2025. [S embracethered.com]
- **What would have stopped it:** decide trust before reading any config; pin approved configs by digest; treat config that is executed later as code.

### 1b. Allowlist bypasses [V GHSA unless marked]
- **Claude Code**
  - CVE-2025-54795 (echo), CVE-2025-58764 (rg), CVE-2025-64755 (sed)
  - CVE-2025-66032: `$IFS` and short flags.
  - CVE-2026-24887 (find), CVE-2026-24053 (zsh `>|`)
  - CVE-2026-25723 and CVE-2026-25722: writes into `.claude` via piped sed and via `cd`.
  - CVE-2025-59829 and CVE-2026-25724: deny rules bypassed via symlink.
- **Cursor**
  - CVE-2025-54131: backtick and `$()`.
  - CVE-2026-22708 (2026-01-14): shell built-ins poison env vars.
  - CVE-2026-31854 (2026-03-09): web-page injection plus an allowlist bypass gave RCE.
- **Gemini CLI** (Tracebit; fixed v0.1.14 on 2025-07-25): an injection in `GEMINI.md` chained a malicious command behind an allowlisted `grep`. [S]
- **The fail-closed pattern:** Codex splits shell chains only when they hold plain words and `&& || ; |`. Redirection, substitution, variables or globs make the whole invocation one command. [V learn.chatgpt.com/docs/agent-configuration/rules]

### 1c. Sandbox escapes (2026 wave) [V GHSA]
- **Claude Code**
  - CVE-2026-25725: a missing `settings.json` was writable from inside bubblewrap, so a SessionStart hook ran on the host.
  - CVE-2026-39861: the sandbox made a symlink, and the unsandboxed writer followed it.
  - CVE-2026-55607 (2026-06-25): a worktree named `.git` plus fsmonitor overwrote `~/.zshenv`.
  - sandbox-runtime CVE-2025-66479: no allowed domains meant no network sandbox.
- **Cursor**
  - CVE-2026-26268: the agent wrote `.git` hooks.
  - CVE-2026-50548 and CVE-2026-50549 (critical): an agent-controlled `working_directory`, and failed symlink canonicalization.
  - CVE-2026-73217 and CVE-2026-73218: a tampered venv and privileged containers.
- **Codex.** CVE-2025-59532 (fixed 0.39.0): a model-generated `cwd` became the writable root.
- **What would have stopped it:** fix roots at session start; realpath everything; make persistence files unwritable even inside the workspace.

### 1d. Exfiltration channels [V GHSA]
- CVE-2025-55284: a broad default allowlist allowed read-then-send.
- CVE-2026-24052: the WebFetch trusted-domain check used `startsWith()`, so `modelcontextprotocol.io.example.com` passed.
- **CVE-2026-54316 (2026-06-13):** pre-approved `huggingface.co` let download counters on attacker repos carry data.
- Cursor CVE-2025-54132 and CVE-2025-61589: Mermaid image fetches.
- A SOCKS5 null-byte bypass of Claude Code's network allowlist was fixed in sandbox-runtime 0.0.43. [S oddguan.com]
- **What would have stopped it:** any host that users can write to (GitHub, Hugging Face, npm) turns an allowlist into an exfiltration channel.

### 1e. MCP ecosystem [V GHSA]
- **mcp-remote** CVE-2025-6514 (critical): a crafted `authorization_endpoint` gave OS command injection. Fixed in 0.1.16.
- **Inspector:** CVE-2025-49596 (critical); CVE-2025-58444 (XSS leading to command execution).
- **Reference servers:** filesystem CVE-2025-53109/53110; git CVE-2025-68143/68144/68145.
- **SDKs:** TypeScript CVE-2025-66414 and Python CVE-2025-66416 left DNS-rebinding protection off for localhost servers; Python CVE-2026-59950 had no WebSocket Host/Origin check; Python CVE-2026-52869 didn't verify the principal.
- **github-mcp-server** CVE-2026-48529: cross-user client confusion.
- **Claude Code IDE extensions** CVE-2025-52882 (2025-06-23): the local websocket accepted connections from any origin. This is the same class as Wanigan's own loopback bus.
- Invariant's "toxic agent flow": a public issue leaked private repos. [S]

### 1f. Supply chain aimed at agents
- **Amazon Q VS Code 1.84.0** (CVE-2025-8217): an over-scoped CodeBuild GitHub token let an attacker commit code that shipped in a release and was designed to call the Q Developer CLI. It was inert only because of a syntax error. [V GHSA] Reports describe it as a wiper prompt. [S]
- **Nx "s1ngularity"** (CVE-2025-10894, 2025-08-26): a `pull_request_target` injection leaked an npm token, and the stealer "attempted to use local AI tools (like Claude and Gemini)". [V nx.dev postmortem] The bypass flags it used are reported by third parties only. [S]
- **Shai-Hulud 2.0** (21–24 Nov 2025): preinstall, TruffleHog harvesting, self-propagation with stolen npm tokens, runner persistence, home-directory wiper. About 25k+ repos affected. [S Datadog, Unit 42, Microsoft]
- **SANDWORM_MODE** (Socket, 2026-02-20): 19 typosquats that write a rogue MCP server into Claude Code, Claude Desktop, Cursor, Continue and Windsurf configs. Its tool descriptions tell the agent to read SSH/AWS/npm keys and `.env` and pass them as a parameter. [S]
- **ClawHub:** 341 of 2,857 skills were malicious, most installing the AMOS stealer (Jan–Feb 2026). [S]
- **Slopsquatting:** hallucinated packages appear in ≥5.2% of commercial-model output and 21.7% of open-source-model output; 205,474 unique names. [V arXiv 2406.10279, USENIX Sec 2025]
- **IDEsaster** (Dec 2025): 24 CVEs across 10+ AI IDEs. [S]
- **GitGuardian 2026:** Claude Code-assisted commits leaked secrets at 3.2%, against a 1.5% baseline. [S]

## 2. MCP security tooling
- **Snyk Agent Scan** (formerly Invariant mcp-scan; Invariant acquired June 2025): hashes tool descriptions ("tool pinning") to detect rug pulls, and uses an LLM classifier for poisoning. The CLI runs locally. [S]
- **MCP spec 2025-11-25, security best practices** [V modelcontextprotocol.io]
  - For local-server setup, the client **MUST** "Show the exact command that will be executed, without truncation" and require approval. It **SHOULD** sandbox the server and flag `sudo`, `rm -rf`, network use and SSH paths.
  - Authorization URLs: **MUST** be http(s) only, with http limited to loopback; **MUST** reject `javascript:`, `data:` and `file:`; **MUST NOT** be opened through a shell. This applies directly to Electron `shell.openExternal`.
  - SSRF: **SHOULD** block private ranges and 169.254/16.
  - Token passthrough is forbidden.
- **MCP spec 2026-07-28** [V blog.modelcontextprotocol.io]
  - Clients must validate RFC 9207 `iss`.
  - DCR is deprecated in favour of CIMD. DCR's `application_type` fixes localhost redirects for CLI clients. Credentials are bound to the issuer.
  - Stateless core with no session ID. HTTP+SSE is deprecated.
  - List results carry `ttlMs`/`cacheScope`, which makes a per-tool hash a natural pinning key.
  - **Roots, Sampling and Logging are deprecated.**
- **Docker MCP Gateway:** containerised servers, digest-pinned signed images, and `--block-secrets` payload interceptors. [S]
- **MCP Registry:** reverse-DNS namespaces verified against GitHub or a domain. That proves the publisher, not integrity or honest descriptions. [S]

## 3. Policy engines and approvals
- **Claude Code** [V docs]
  - Rules evaluate deny, then ask, then allow; a hook's "allow" can't override a deny or ask rule; a hook exiting with code 2 blocks first.
  - Locks: `disableBypassPermissionsMode`, `disableAutoMode`, `allowManagedPermissionRulesOnly`. Embedders can use the SDK `managedSettings` option.
  - "Protected paths" are never auto-approved outside bypass mode: `.git`, `.vscode`, `.husky`, `.devcontainer`, `.claude`, shell rc files, `.npmrc`, `.pre-commit-config.yaml`, `.mcp.json`, `.claude.json`, and others.
  - `rm` on critical paths can't be approved by a rule or a hook. `--restricted` stops the classifier approving protected-path writes.
- **Auto mode** [V]
  - The classifier sees user messages, tool calls and CLAUDE.md, but **not tool results**. A server-side probe screens tool results for injection, and the PostToolUse `classifierContext` field lets hooks annotate them.
  - It pauses after 3 consecutive or 20 total blocks. In `-p` runs without a prompt tool, the blocked action just doesn't run.
  - **Pro, Max and Team start in auto mode**; Enterprise and API-key sessions start in `default`. Classifier calls are billed on Enterprise and API accounts.
  - **Implication for Wanigan:**
    - A Claude session Wanigan launches may be classifier-gated unless Wanigan pins `--permission-mode`.
    - The ledger should record whether a human, a rule, a hook or the classifier approved each call, and never present classifier approval as human approval.
    - Billed classifier calls bear on the "don't silently spend tokens" rule.
- **Codex** [V]
  - `prefix_rule(pattern, decision, justification, match/not_match)`; the most restrictive match wins (forbidden, then prompt, then allow).
  - **`allow` means "Run the command outside the sandbox without prompting".**
  - Admins set policy in `requirements.toml`.
  - Defaults: a trusted repo gets `workspace-write` plus `on-request` with network off; an untrusted repo is `read-only`. `.git`, `.agents` and `.codex` stay read-only. `--yolo` means "No sandbox; no approvals".
- **Cedar:** AWS AgentCore Policy evaluates principal, tool and input at a gateway (GA Mar 2026). Cedar is open source and embeddable locally. [S]
- **dcg:** a Rust PreToolUse hook that unwraps heredocs and runs 50+ regex packs, with hooks for Claude Code, Codex, Gemini, Copilot and Cursor. [S]

## 4. Injection defence
- **Classifiers:** Prompt Guard 2 (86M and 22M models) runs locally; LlamaFirewall adds AlignmentCheck and CodeShield; Lakera went to Check Point. [S] All fall to adaptive attacks, so treat them as a signal, not a gate.
- **Architectures:**
  - Meta's "Rule of Two" (Oct 2025): hold at most two of untrusted input, private data and external action.
  - CaMeL: a privileged planner plus a quarantined parser.
  - FIDES: information-flow labels. [S]
  - Anthropic's classifier is a deployed quarantine: the judge never sees tool output. [V]
- **Deployable in a wrapper that doesn't own the loop:** session-level taint through hooks, advisory scanning of tool results, and passing taint in `classifierContext`. CaMeL and FIDES need the loop itself.

## 5. Secrets and exfiltration
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips provider and cloud credentials from Bash, hooks and MCP children. [S; the variable appears in claude-code issue #91020]
- Codex keeps network off by default and warns that "Prompt injection can cause the agent to fetch and follow untrusted instructions". [V]
- Local scanners (gitleaks, trufflehog) can check diffs. Shai-Hulud used TruffleHog as its harvester.

## 6. Accountability
- **Agent Trace** (Cursor RFC, 2026-01-29): per-line human/AI attribution in JSON, storage-agnostic. [S]
- **git-ai:** agent-reported line attribution stored in git notes, surviving rebase and squash; implements Agent Trace. [S]
- **Linux kernel:** AI must not add `Signed-off-by`; use `Assisted-by: AGENT:MODEL [TOOLS]`. [S docs.kernel.org]
- **Attestations:** in-toto, SLSA and Sigstore could carry this, but I found no adopted predicate for agent-produced changes. [S]
- **OWASP Agentic Top 10 2026** (2025-12-09): ASI01 Goal Hijack through ASI10 Rogue Agents. [S]
- **EU AI Act:**
  - GPAI duties have applied since 2025-08-02.
  - The Omnibus defers Annex III high-risk duties to 2027-12-02 and Annex I to 2028-08-02.
  - Art. 50 transparency applies from 2026-08-02, with 50(2) watermarking deferred to 2026-12-02.
  - Coding agents are rarely high-risk. [S Gibson Dunn, Travers Smith]
- **NIST:** CAISI RFI on agent security (2026-01-08); COSAiS agent overlays in development. [S]
- **SOC 2:** no AI-specific criteria; agent changes are audited as change management. [S]

---

## Top 12 capabilities, ranked by risk reduced per unit of effort

1. **Quarantine repo config before launch.** Hash `.claude/settings*.json` (hooks, env, `defaultMode`, base URLs), `.mcp.json`, `.codex/*`, `.env`, `.vscode/settings.json`, git hooks/fsmonitor and worktree `commondir`. Diff them, pin the digest, re-prompt on change, and watch user-level configs for drift.
   - *Threat:* CVE-2025-59536, CVE-2026-21852, CVE-2026-33068, CVE-2026-40068, CVE-2025-61260, MCPoison, SANDWORM.
   - *Local:* fully. *Cost:* low.
2. **Enable the harness's OS sandbox by trust level.** Network off for read-only and project levels; refuse bypass flags below trusted; never claim containment.
   - *Threat:* the allowlist-bypass class.
   - *Local:* yes. *Cost:* medium–high (network friction).
3. **Guard persistence surfaces.** Ask or deny on writes to the union of Claude's protected paths, Codex's `.git`/`.agents`/`.codex`, venv activate scripts and git `hooksPath` (realpath symlinks, parse redirect targets). Hash those files before and after each session and alert on any change, including writes made inside the sandbox.
   - *Threat:* CVE-2025-53773, CVE-2026-26268, CVE-2026-25725, CVE-2026-55607, CVE-2026-39861.
   - *Local:* yes. *Cost:* low–medium; legitimate `.vscode` edits need a per-session approval.
4. **Allowlist the launch environment.** Pass only declared variables, set the env-scrub flag, never take base URLs or keys from a repo `.env`, and grant keychain secrets per project.
   - *Threat:* env-harvesting injections, worms.
   - *Local:* yes. *Cost:* medium.
5. **Taint sessions and escalate egress.** After a web fetch, remote MCP output, reads outside the repo, or issue/PR text, step `curl`, `git push`, `gh`, `npm publish`, new-host WebFetch and MCP write tools up to ask. Headless sessions deny. Also pass the taint state to auto mode through `classifierContext`.
   - *Threat:* the lethal trifecta, CVE-2026-31854, toxic agent flows.
   - *Local:* Claude via Pre/PostToolUse hooks; other harnesses reported as unsupported until verified. *Cost:* medium, because only egress escalates.
6. **Apply exfiltration heuristics to tool arguments.** Flag user-writable hosts, high-entropy subdomains and queries, DNS tools, and prefix-only domain matches, as ask with a reason code.
   - *Threat:* CVE-2026-54316, CVE-2026-24052, CVE-2025-55284.
   - *Local:* yes. *Cost:* medium.
7. **Harden Wanigan's loopback listeners.** Validate Host/Origin, reject browser origins, compare tokens in constant time, and keep tokens out of child environments.
   - *Threat:* the DNS-rebinding CVEs, CVE-2025-52882.
   - *Local:* trivial. *Cost:* none.
8. **Guard package installs.** Ask on `npm/pnpm/yarn/bun add`, `npx`, `pip`/`uv` and `uvx` when the package isn't in the lockfile, doesn't exist, or is very new. Suggest `--ignore-scripts`.
   - *Threat:* slopsquatting, Shai-Hulud, s1ngularity, SANDWORM typosquats.
   - *Local:* the registry lookup is egress Wanigan makes itself, so make it opt-in and list it in the egress listing. *Cost:* low–medium.
9. **Scan the session diff for secrets** at Stop and at `git push` inside a session. Block the push in the policy, redact in the UI, and keep an allowlist file for fixtures.
   - *Threat:* the 3.2% vs 1.5% leak rate [S].
   - *Local:* yes, with a local gitleaks-class scanner. *Cost:* low–medium.
10. **Pin MCP tool definitions.** A stdio shim hashes command digest, tool name, description, inputSchema and annotations, quarantines on change, and shows the untruncated command as the spec requires. Optionally scan descriptions with Prompt Guard 2 22M, as a signal only.
    - *Threat:* MCPoison, McpInject tool poisoning, rug pulls.
    - *Local:* yes, medium effort (the shim). *Cost:* low.
11. **Hash-chain and sign the ledger.** Each entry commits to the previous entry's hash; the chain head is signed with an Ed25519 key in the keychain; exports ship with a verifier. External anchoring (Rekor, an RFC 3161 timestamp) is cloud, so make it opt-in.
    - *Threat:* after-the-fact tampering by malware or an agent with filesystem access; audit evidence (ISO 42001, SOC 2 change management).
    - *Local:* yes. *Cost:* none.
12. **Attribute commits (opt-in).** An `Assisted-by` trailer or Agent Trace notes, drawn from recorded evidence.
    - *Threat:* forensics, compliance.
    - *Local:* yes. *Cost:* social.

## Things I could not verify
- **Incident details**
  - CVE-2025-61260 specifics: not in openai/codex's GHSA list.
  - A Gemini CLI CVE id: gemini-cli has no published GHSAs.
  - The exact s1ngularity flags: the Nx postmortem omits them.
  - Counts for Shai-Hulud, SANDWORM, ClawHub and IDEsaster.
  - GitGuardian's 3.2%/1.5%: the report wasn't fetched.
  - The SOCKS5 null-byte bypass: no GHSA found.
  - The affected range for CVE-2026-40068.
- **Measurements**
  - The auto-mode stress-test and adaptive-attack figures come from search summaries.
  - I found no date for auto mode becoming the default; a third-party post says "August 14".
  - Whether CaMeL's quoted "67%" means tasks solved securely or attacks blocked.
- **Tooling**
  - `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` semantics.
  - Codex `.rules` syntax: the docs summary said TOML, other sources say Starlark.
  - Whether Snyk Agent Scan needs a cloud API.
  - Docker gateway flags; how registry namespaces are verified; Prompt Guard 2 benchmarks; dcg internals.
- **Governance**
  - The AgentCore GA date.
  - The Omnibus OJ citation: summaries name "Regulation (EU) 2026/1744, OJ 2026-07-24" but also say adoption was pending.
  - NIST and COSAiS details.
  - Any AICPA AI guidance.
  - The Agent Trace backers and the kernel document's date.
  - Any in-toto predicate for agent changes. Absence isn't proven.
- **Not researched:** whether Codex, Gemini or Copilot hooks can carry a pre-tool decision end to end; pnpm/npm minimum-release-age; Copilot CamoLeak; Anthropic's GTG-1002 report.
