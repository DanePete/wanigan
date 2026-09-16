# W3: Isolation, sandboxing and execution environments for coding agents (as of 2026-09-14)

Labels: **[V]** primary source · **[S]** second-hand · **[B]** blocked or unverified, nothing invented · **[L]** observed on this Mac (macOS 26.5.2, Claude Code 2.1.270, codex-cli 0.154.0). Lines starting "→" are analysis for Wanigan.

## 1. OS-level sandboxes inside agent CLIs

### Claude Code Bash sandbox and sandbox-runtime (srt)
- **How it works.** The OS enforces a filesystem and network boundary on every Bash command and its children. macOS uses Seatbelt, with nothing to install. Linux and WSL2 use bubblewrap plus socat, with optional seccomp to block Unix sockets. Network traffic goes through a proxy outside the sandbox. No domain is allowed in advance; the first use of a host prompts. [V] https://code.claude.com/docs/en/sandboxing
- **Defaults.**
  - Writes: the working directory, `--add-dir` directories, and the session `$TMPDIR`.
  - Reads: the whole machine, **including `~/.ssh` and `~/.aws`**, unless denied.
  - Linked worktrees: sandboxed commands may write the main repo's shared `.git`, except `hooks/` and `config`. [V] → A Wanigan session can move main-repo refs.
- **Protected paths** that `allowWrite` can't unlock: `.claude` settings, skills, agents, commands and hooks; `.mcp.json`; shell rc files; `.gitconfig`; `.vscode`; `.git/hooks|config`; bare-repo files (`HEAD`, `objects`, `refs`); most of `~/.claude`. [V]
- **Settings under `sandbox.*`.** [V]
  - `failIfUnavailable`: without it, a sandbox that can't start **warns and runs commands unsandboxed**.
  - `allowUnsandboxedCommands:false`: removes the `dangerouslyDisableSandbox` retry.
  - Also: `excludedCommands`, `filesystem.{allowWrite,denyWrite,denyRead,allowRead,disabled}`, `network.{allowedDomains,deniedDomains,strictAllowlist,allowUnixSockets,httpProxyPort,socksProxyPort,tlsTerminate}`, `credentials.*`, `allowAppleEvents`, `enableWeakerNestedSandbox`.
- **Setting it per session.** `claude --settings '{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false}}'`. The risky keys are honored from user settings, managed settings or `--settings`, but **ignored from a repo's `.claude/settings*.json`**: `filesystem.disabled`, `mask`, `tlsTerminate`, `strictAllowlist`, `allowAppleEvents`. [V] → This matches Wanigan's inject-from-user-data model.
- **Scope.** Bash only. MCP servers and command hooks "run unconstrained on the host". Commands typed at the `!` prompt run unsandboxed, except in background sessions. [V] https://code.claude.com/docs/en/sandbox-environments
- **srt wraps the whole process**, including tools, MCP servers and hooks: `npx @anthropic-ai/sandbox-runtime claude`, configured by `~/.srt-settings.json`. Network is denied by default. With no valid settings it still starts ("Don't take a clean start as proof your settings loaded"). Status: "beta research preview"; v0.0.76 on 2026-09-10; Apache-2.0. [V] https://github.com/anthropic-experimental/sandbox-runtime
- **Documented caveats.** [V]
  - No TLS inspection, so domain fronting can bypass the allowlist.
  - A broad allowed domain such as `github.com` is an exfiltration path.
  - Allowing `docker.sock` escapes the sandbox.
  - `allowAppleEvents` "removes code-execution isolation".
  - Go CLIs fail TLS under Seatbelt.
- **Evidence.** A blocked command's result names the denied path or host. srt documents `log stream --predicate 'process == "sandbox-exec"'` for watching violations. [V]
- **[L] Nested Seatbelt fails.** A `sandbox-exec` inside another fails with `sandbox_apply: Operation not permitted` (exit 71) whenever the outer profile has any deny rule (tested: network, file-write, file-read). Only a bare `(allow default)` outer profile nests. → A CLI wrapped in an outer profile probably loses its inner sandbox. I did not test a CLI running under srt.
- **Known escapes.**
  - **CVE-2025-66479 (srt).** `allowedDomains: []` disabled the proxy, so the strictest setting allowed everything. Affected Claude Code 2.0.24–2.0.54; fixed 2.0.55 (2025-11-26). [V, researcher write-up] https://oddguan.com/blog/second-time-same-sandbox-anthropic-claude-code-network-allowlist-bypass-data-exfiltration/
  - **SOCKS5 null byte.** `evil.com\x00.google.com` passed a JS `endsWith` check, then libc resolved `evil.com`. Affected 2.0.24–2.1.89; fixed 2.1.90 (2026-04-01). No CVE and no changelog note. [V, same write-up]
  - **CVE-2026-55607.** A worktree named `.git`, plus a symlink and git fsmonitor, could overwrite `~/.zshenv` and run code outside Seatbelt. Affected 2.1.38–2.1.162; fixed 2.1.163; published 2026-07-24; CVSS 8.8. [V] https://advisories.gitlab.com/npm/@anthropic-ai/claude-code/CVE-2026-55607/
  - **CVE-2026-21852.** Repo settings could set `ANTHROPIC_BASE_URL`, and requests fired before the trust prompt. [S]
- **Later hardening.** Refuses symlinked `.claude/worktrees` (v2.1.212). Skips the repo's own git filter drivers, "because a filter driver is a shell command" (v2.1.247). [V] https://code.claude.com/docs/en/worktrees

### Codex CLI
- **Modes and platforms.** Sandbox modes: `read-only`, `workspace-write` (default), `danger-full-access`. Approvals: `on-request`, `never`, or a granular table; `untrusted` is "no longer supported as a selectable policy". Seatbelt on macOS; the first `bwrap` on `PATH` on Linux; a native Windows sandbox. [V] https://learn.chatgpt.com/docs/sandboxing
- **Protected paths.** Inside writable roots, `.git` (including resolved gitdir pointers), `.agents/` and `.codex/` stay read-only. [V] https://learn.chatgpt.com/docs/agent-approvals-security
- **Network.** [V, same page]
  - Enable with `[sandbox_workspace_write] network_access=true`.
  - Domain filtering also needs `[features.network_proxy] enabled=true, domains={"host"="allow"|"deny"}`; the proxy "does not grant network access by itself".
  - Deny wins. `*.example.com` excludes the apex; `**.example.com` includes it.
  - `allow_local_binding=false` blocks loopback and private ranges by default.
  - Profiles: `[permissions.<name>]` with `extends=":workspace"`.
  - Test with `codex sandbox macos`. Admins enforce via `requirements.toml` (`allowed_sandbox_modes`, `allowed_approval_policies`).
- **Per-session flags [L].** `-s`, `-a`, `-c key=value`, `-p/--profile`, `--add-dir`, `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`.
- **Known escapes.**
  - CVE-2025-59532: a model-generated working directory became the writable root; 0.2.0–0.38.0; fixed 0.39.0. [S] https://github.com/advisories/GHSA-w5fx-fh39-j5rw
  - The safe-command allowlist trusted `git show` by name; fixed 0.95.0. [S, Pillar Security]

### Gemini CLI
- **Enabling.** `-s`, `GEMINI_SANDBOX=true|docker|podman|sandbox-exec|runsc|lxc`, or `tools.sandbox`. [V] https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md
- **macOS profiles**, chosen with `SEATBELT_PROFILE`: `permissive-open` is the default (writes restricted, **network open**); also `permissive-proxied`, `restrictive-open|proxied`, `strict-open|proxied`.
- **Containers and Linux.** Custom images via `GEMINI_SANDBOX_IMAGE` and `.gemini/sandbox.Dockerfile`. gVisor and LXC are Linux-only.
- **Known findings.** Pillar reported a reachable Docker socket and a Seatbelt denylist bypass; Google downgraded both as "difficult to exploit". [S]

### Cursor
- **Design.** Chose Seatbelt over App Sandbox, containers and VMs; Seatbelt was "deprecated in 2016, but is still used by … Chrome". Linux uses Landlock, seccomp and an overlay; Windows uses WSL2. Sandboxed agents "stop 40% less often". [V] https://cursor.com/blog/agent-sandboxing (2026-02-18)
- **`sandbox.json`.** [V] https://cursor.com/docs/reference/sandbox
  - Mode: `type` = `workspace_readwrite`, `workspace_readonly` or `insecure_none`.
  - Paths: `additionalReadwritePaths`, `additionalReadonlyPaths`, `disableTmpWrite`, `enableSharedBuildCache`.
  - Network: `networkPolicy{default:"deny",allow,deny}` with CIDR. `*.example.com` **includes** the apex. RFC1918, `127.x` and metadata endpoints are blocked by default.
  - Always protected: `.cursor/*.json`, `.claude/*.json`, `.vscode/**`, `.git/hooks/**`, `.git/config`.
- **Known escapes.** CVE-2026-48124 (a `.claude` hook config led to unsandboxed execution), a virtualenv-interpreter edit, and a fsmonitor bypass; all fixed in 3.0.0. [S]

### Lessons across vendors
- **The recurring escape.** Pillar Security (BleepingComputer, 2026-07-20): "The agent stays inside the box … It just writes a file that a trusted tool outside the box later runs, loads, or scans." [S] https://www.bleepingcomputer.com/news/security/cursor-codex-gemini-cli-antigravity-hit-by-sandbox-escapes/
- **CVE-2026-82533 (DeepSeek Harness)**, disclosed 2026-09-08, CVSS 9.4. The filesystem was confined but the network was open. A sandboxed `curl` hit the harness's local API, which trusted the `Host` header, and set the session to `danger-full-access` with no approval event. [V, researcher write-up] https://www.ox.security/blog/cve-2026-82533-deepseek-harness-ai-agent-sandbox-escape/
- → Wildcards mean different things per vendor (`*.` excludes the apex in Codex, includes it in Cursor). A policy compiler must translate rules, not copy strings.

## 2. Container and VM isolation per run (local)
- **Docker Sandboxes (`sbx`).** [V] https://docs.docker.com/ai/sandboxes/ (architecture/, security/)
  - A microVM per sandbox with its own kernel and Docker Engine; the agent has sudo inside.
  - Outbound TCP goes through a host proxy; UDP and ICMP are blocked.
  - "API keys are injected into HTTP headers by the host-side proxy. Credential values never enter the VM."
  - Workspaces: direct mount at the same path (virtiofs), mountless, or clone (host repo read-only at `/run/sandbox/source`).
  - The docs admit: direct mode lets the agent plant git hooks or `package.json` scripts; local stdio MCP servers run on the host; a shared skills store crosses sandboxes; the default allowlist includes `*.googleapis.com`.
  - The CLI is free.
  - Unverified: named presets [S]; which hypervisor runs on macOS [B].
- **Apple `container`.** [V] https://github.com/apple/container (and `docs/technical-overview.md`)
  - Each container runs in its own VM (Virtualization.framework, vmnet). Requires Apple silicon; targets macOS 26.
  - On macOS 15, containers can't reach each other.
  - Memory freed inside the guest isn't returned to the host.
  - 1.4.1 (2026-09-09) fixed symlink and Unix-socket-path vulnerabilities.
- **Lima.** Apache-2.0, CNCF Incubating. v2.0.0 (2025-11-06) added pluggable drivers, krunkit GPU and experimental MCP ("can be now used as a sandbox for AI agents"). Latest: v2.3.0-beta.0 (2026-09-01). [V] https://github.com/lima-vm/lima/releases
- **Tart.** macOS and Linux VMs on Virtualization.framework; 2.37.0 (2026-09-09). **Licensed FSL-1.1-ALv2**, which is not OSI. [V] https://github.com/cirruslabs/tart
- **Sculptor (Imbue).** v0.47.0 (2026-09-08). [V] https://github.com/imbue-ai/sculptor
  - Workspaces are now **git worktrees by default**.
  - Containers moved to an experimental "Custom Backend Command" (Docker, SSH or VM).
  - The macOS Keychain login is unreachable in containers; the fix is `claude setup-token` plus `CLAUDE_CODE_OAUTH_TOKEN`.
- **Dagger container-use.** An MCP server giving each agent a container on its own branch. "Experimental"; last release v0.4.2 (2025-08-19). [V] https://github.com/dagger/container-use
- **agent-deck Docker sandbox.** Copying the macOS Keychain Claude login "would fork the host's OAuth refresh chain and log the host out". [V] https://github.com/asheshgoplani/agent-deck
- **Claude devcontainer.** A default-deny iptables allowlist. The CLI refuses `--dangerously-skip-permissions` as root. [V]
- **Unverified.** Firecracker needs Linux KVM [S, not re-fetched]. OrbStack [B].

## 3. Worktree lifecycle ergonomics
- **Claude Code.** [V] https://code.claude.com/docs/en/worktrees
  - `--worktree <name>` creates `.claude/worktrees/<name>`.
  - `.worktreeinclude` copies files that match **and** are gitignored.
  - `WorktreeCreate`/`WorktreeRemove` hooks replace the git logic.
  - Holds `git worktree lock` while running, with a marker so cleanup never deletes user worktrees.
- **Conductor.** [V] https://www.conductor.build/docs/reference/scripts
  - Config: `.conductor/settings.toml`, which replaced `conductor.json`.
  - Scripts `setup`/`run`/`archive`; `CONDUCTOR_PORT` is a **10-port block**; `CONDUCTOR_ROOT_PATH` and `CONDUCTOR_WORKSPACE_NAME` are provided.
  - Stop sends SIGHUP, then SIGKILL after 200 ms.
- **Superset.** [V] https://docs.superset.sh/setup-teardown-scripts
  - `.superset/config.json` defines `setup`, `teardown` and `run`.
  - **`~/.superset/projects/<repo>/config.json` overrides the repo's config.** Ports are detected per workspace.
  - → That per-machine override outside the repo is the pattern Wanigan needs.
- **Emdash.** Worktree per task and SSH remotes. It "installs marker-tagged entries in the agent's user-level config", the opposite of Wanigan's injection. [V] https://github.com/generalaction/emdash
- **worktrunk** (v0.77.0, 2026-09-08). [V] https://worktrunk.dev/step/
  - Hooks; a `hash_port` filter gives each worktree its own port.
  - `wt step copy-ignored` reflinks gitignored files on APFS, btrfs and XFS.
  - Vendor figures: 14 GB in 20 s instead of 2 min, with about zero extra disk; a Rust `target/` build drops from ~68 s to ~3 s.
  - Virtualenvs "cannot be copied safely".
- **APFS clones and pnpm.** `cp -c` uses clonefile(2), falling back to copyfile(2) [L] `man cp`. pnpm's `packageImportMethod: auto` tries cloning before hardlinking on macOS. [V] https://github.com/pnpm/pnpm.io/blob/main/docs/settings/node-modules.md → Hardlinked stores let a sandboxed agent change the shared store.
- **A database per worktree.** A schema per branch, a Compose project per worktree, or `worktreepg`. [S only]

## 4. Remote execution and session survival
- **Claude Desktop over SSH.** [V] https://code.claude.com/docs/en/desktop
  - Installs Claude Code on the remote (Linux or macOS); the terminal pane is local-only.
  - `sshHostAllowlist` is managed-only and doesn't restrict `ssh` run from Bash.
  - Behavior on disconnect: [B].
- **Zed.** The UI is local; language servers and terminals run remotely. Each SSH connection starts or reconnects to the remote daemon in `~/.zed_server`. [V] https://zed.dev/docs/remote-development
- **Survival mechanisms**
  - **tmux.** claude-squad (AGPL-3.0, v1.0.20 on 2026-08-20) and agent-deck (v1.16.10 on 2026-09-13). [V] https://github.com/smtg-ai/claude-squad
  - **Superset `pty-daemon`.** [V] https://github.com/superset-sh/superset (`packages/pty-daemon/README.md`, `apps/desktop/docs/HOST_SERVICE_LIFECYCLE.md`)
    - Spawned `detached: true`; it outlives Electron quit and auto-update, and the next launch adopts it.
    - An fd-handoff keeps the same shell PIDs across daemon upgrades.
    - Auth is only the socket's 0600 mode.
    - Output lives in a 64 KB in-memory buffer; bytes produced while nothing is attached are dropped.
  - **Claude Code supervisor.** `claude agents --json`, `claude attach`, `claude daemon status`. Sessions survive closing the terminal and sleep; "Shutting down still stops running sessions". [V] https://code.claude.com/docs/en/agent-view
  - → Wanigan's no-survival guardrail is a product choice, not a technical limit. The cost is the evidence gap.

## 5. Secrets handling
- **Claude `sandbox.credentials`.** [V]
  - `deny` blocks reading a file or unsets an env var; no scope can remove a deny.
  - `mask` gives the command a placeholder, and the proxy swaps in the real value only for `injectHosts`. It needs the experimental `tlsTerminate`, and re-signs AWS SigV4.
  - **On macOS, masking a file acts as `deny`.**
  - No built-in deny list.
  - `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` strips credentials from subprocesses; the exact list is [B].
- **Proxy injection elsewhere.**
  - Docker sbx [V].
  - iron-proxy (Apache-2.0): TLS-decrypting egress proxy with built-in DNS and default-deny. Workloads hold proxy tokens that are swapped for real secrets at egress. [V] https://github.com/paradigmxyz/iron-proxy
- **1Password Environments local `.env`.** Served through a named pipe, never on disk. After unlocking, "every process can read it until you lock 1Password". [V] https://www.1password.dev/environments/local-env-file `op run` puts secrets into the child's environment [S], so the agent holds them.
- **Recurring blocker.** The Claude login lives in the macOS Keychain, which containers and VMs can't use. [V]

## 6. Network egress control
- **Built-in allowlists.** [V]
  - Claude/srt: filters by hostname, no TLS inspection; srt blocks loopback, link-local and metadata ranges.
  - Codex: managed proxy.
  - Cursor: `networkPolicy`.
  - Gemini: `*-proxied` profiles.
  - Docker sbx: UDP and ICMP blocked.
- **"Offline" settings.** Claude `strictAllowlist`; Codex `network_access=false` by default. [V]
- **Standalone tools.** iron-proxy [V]; coder/boundary (transparent proxy, Linux namespaces, Linux-only) [V] https://github.com/coder/boundary; Pipelock [S].
- **Failure modes observed.** An empty allowlist that meant allow-all; a parser mismatch (null byte); domain fronting; allowed services used for exfiltration; loopback control planes; `docker.sock`.

## Top 10 isolation/environment capabilities for a local-first desktop control surface

1. **Compile each trust level into each harness's own sandbox, per session.**
   - Why: the OS boundary covers child processes and scripts, which a PreToolUse hook reading command text can't see.
   - How: Claude `--settings` with `failIfUnavailable:true` and `allowUnsandboxedCommands:false`; Codex `-s/-a/-c`; Gemini `SEATBELT_PROFILE`; srt for generic CLIs.
   - macOS feasibility: high, with no repo writes.
   - Main risk: silent fallback to no sandbox; three Claude escapes in 8 months; Bash-only scope.
2. **Harden Wanigan's control plane against sandboxed children.**
   - Why: CVE-2026-82533 escalated through a loopback API.
   - How: a 0600 Unix socket plus a per-session secret, tested from inside each sandbox.
   - macOS feasibility: high.
   - Main risk: allowing `localhost` for dev servers reopens it.
3. **Flag risky leftover files and run git safely.**
   - Why: this is the escape pattern across all vendors. Flag diffs touching fsmonitor, hooks, `.vscode/tasks.json`, `.claude/*.json`, `.mcp.json`, virtualenvs or `package.json` scripts before merge.
   - How: run Wanigan's git with fsmonitor, hooks and filter drivers disabled, and check whether main-branch refs moved.
   - macOS feasibility: high.
   - Main risk: an incomplete list, and alert fatigue.
4. **A per-session network policy that denies loopback and private ranges.**
   - Why: exfiltration is the main remaining risk.
   - macOS feasibility: high via harness proxies.
   - Main risk: domain fronting, broad domains, differing wildcard rules, and WebFetch/MCP bypassing the Bash proxy.
5. **Keep credentials out of sessions by default.**
   - How: scrub the environment, deny `~/.ssh` and `~/.aws`, and mask only where a tool must log in.
   - macOS feasibility: medium, because masking a file acts as deny.
   - Main risk: trusting a TLS-decrypting CA, and `.env` copies spreading secrets.
6. **Bootstrap worktrees cheaply from user-data config.**
   - How: honor `.worktreeinclude`, use clonefile copies and pnpm clones, give each worktree a port block, and keep per-machine scripts.
   - macOS feasibility: high on APFS.
   - Main risk: caches with absolute paths, and stale build output.
7. **Record what the sandbox blocked in the ledger.**
   - Why: denied paths and hosts are observed facts.
   - macOS feasibility: medium.
   - Main risk: mapping log events to sessions, and volume.
8. **Wrap the whole CLI process for sessions with MCP servers or hooks.**
   - macOS feasibility: medium.
   - Main risk: [L] nested Seatbelt fails, so choose one layer; srt is beta.
9. **An optional VM backend for untrusted repos** (Apple `container`, Docker sbx, Lima).
   - macOS feasibility: medium; needs Apple silicon, and macOS 26 for `container`.
   - Main risk: Keychain OAuth, disk and memory growth, and per-harness verification.
10. **A detached session host (tmux or a PTY daemon), locally and over SSH.**
    - macOS feasibility: medium.
    - Main risk: conflicts with the current guardrail, dropped output while detached, and orphaned processes.

## Things I could not verify
- Docker sbx: its macOS hypervisor, named presets and keychain store.
- How harnesses behave under srt on macOS (only raw nesting was tested).
- How srt forces traffic through its proxy.
- The exact list `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` strips.
- What Claude Desktop SSH sessions do on disconnect.
- Superset's remote-access design.
- OrbStack.
- Tart's concurrent-VM limits.
- Firecracker (not re-fetched).
- Full advisories for CVE-2025-59532, CVE-2026-21852 and CVE-2026-48124.
- Pipelock.
- Codex `-c` syntax for nested tables, and `CODEX_HOME`.
- Gemini strict-Seatbelt PR #22832.
- worktreepg.
- Sculptor's original pairing-sync design.
- Apple `container` startup times.
