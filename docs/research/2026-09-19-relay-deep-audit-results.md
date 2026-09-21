# Relay deep audit — execution results

Audit date: 2026-09-19. Revision: `324bca7f137198a78583ec9b8cb07cfd1c667c71`, branch `feat/routing-suggester`.

**Outcome: free audit completed with live-trial blockers. Relay does not yet know which account/model/tool combination is usable now, and the current evidence cannot establish a best-value route.** Executed probes reproduced billing, restore, process-ownership and availability defects. No paid audit request was admitted; the entire **$50 allowance remains unspent**. There were no coding trajectories or human acceptances, so cost per accepted result is undefined.

This executes the [saved plan](../superpowers/plans/2026-09-19-relay-deep-audit.md). The original plan and four coverage notes are preserved. No product/configuration edit, credential entry, installation, or production session launch/restart was performed. The existing application was inspected read-only; account-native metadata commands were used separately from destructive lab tests. No commit, deployment, purchase, subscription, top-up or new MCP connection was made.

## What the current accounts actually report

The [native Codex snapshot](relay-audit-2026-09-19/account-discovery.json) was fetched around **18:58 UTC**, using only `initialize`, `account/read` with `refreshToken:false`, `account/rateLimits/read`, and paginated `model/list`. No thread, turn, reset-credit consumption or inference was requested. These are time-stamped observations, not durable launch authorization. Account labels refer to Wanigan's entries; the audit did not prove that separate entries represent independent billing identities or quota pools.

| Account entry | Native authentication/plan result | Main weekly `codex` bucket | Provider-reported reset (UTC) | Limits of the observation |
| --- | --- | --- | --- | --- |
| Codex Personal | `chatgpt`, `pro` | 91% used; 9% remaining | Sep 26, 12:08:40 | Also returned `base_model_inference`, named `gpt-reserve`, at 0% used, reset Sep 26, 18:58:15. No model-to-bucket mapping was established. |
| Codex gamedev | `chatgpt`, `prolite` | 100% used; exhausted | Sep 26, 13:28:44 | Provider explicitly reports `rate_limit_reached`. No switching to evade that restriction was attempted. |
| Codex Temporary | `chatgpt`, `prolite` | 0% used; 100% remaining | Sep 26, 18:58:17 | This is reported allowance, not proof of successful coding or required-tool readiness. |
| Codex temp2 | No authenticated account returned | Quota read refused with authentication error | Unknown | Still returned the same five-model catalog as the signed-in accounts. |
| Claude Personal, Work, max5 | Native `auth status --json` reports signed in via `claude.ai`, subscription `max` | Current allowance unknown | Unknown | Native auth status does not establish fresh quota, models, credit/overage settings or execution. Stored Personal/Work quota readings are dated Sep 16, around 00:29 UTC. |

The three authenticated Codex quota responses reported `hasCredits:false`, balance `0`, and `spendControlReached:false`. That last flag is **not** a hard billing cap or proof of allowance: gamedev reports exhausted quota alongside it. No subscription tokens were converted into invented API dollars.

Every Codex entry returned `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and `gpt-5.5`. The first three declared low through ultra effort; Luna low through max; 5.5 low through xhigh. These are native catalog results only. The unauthenticated temp2 result is a concrete negative control against treating catalog success as authenticated model access. The documented account, quota and model methods are separate interfaces. [Official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).

Claude probing matched [Wanigan's account environment rules](../../src/main/accounts.ts#L414). An initial audit invocation explicitly setting the default `CLAUDE_CONFIG_DIR` incorrectly reported Personal as signed out; correcting the probe to leave that variable unset returned signed in. The incorrect observation was superseded, not reported as an account failure. `claude -p /usage` was not executed because this audit did not establish that the installed CLI handles that print-mode invocation without inference. Remaining allowance and overage controls therefore stay unknown.

### Connections and tools

Evidence: [connection inventory](relay-audit-2026-09-19/connection-inventory.json), [native authentication/MCP inventory](relay-audit-2026-09-19/auth-and-mcp.json), and direct inspection of the installed Wanigan UI.

| Surface | Observed state | What it does not establish |
| --- | --- | --- |
| OpenRouter manual profile | Enabled; installed Codex found; no saved key, environment-key notice, or Remove key control in Relay. No `provider-openrouter.bin`; shell OpenRouter key variables absent. | No authenticated account catalog, key cap, wallet, hosted tool loop, upstream identity or invoice. The profile correctly remains generic/manual/unpriced. |
| Wanigan external MCP registry | Zero configured rows. | This does not mean Wanigan lacks its own session MCP server, or that native harness configuration is empty. |
| Codex Personal native MCP | 13 configured servers, 12 enabled. Seven HTTP servers report `not_logged_in`: Atlassian, Cloudflare, Cloudflare Observability, Figma, GitHub, GitLab, Marker.io. DigitalOcean reports `bearer_token`. Five stdio entries report auth status `unsupported`, including one disabled computer-use entry. | Saved auth metadata is not a successful handshake, current tool list, tool-call permission or tool-loop conformance. `unsupported` here describes auth reporting, not proof that a server cannot work. |
| Other three Codex entries | Native configured MCP list is empty. | Temporary's larger reported allowance cannot automatically substitute for Personal when a task needs Personal's configured tools. |
| Official OpenRouter MCP | Absent from the inspected Wanigan and native Codex registries and unavailable in this assistant's callable tool inventory. | No connection, OAuth consent, tools/list or billable test-inference call was attempted. Claude-native MCP configuration was not inventoried. |
| Other hosted providers | Installed UI reports no GLM, DeepSeek or xAI key. Claude Platform and TypeSafe encrypted credential files exist. | File/key presence is not authentication, remaining credit, a hard cap or permission to count unknown bills as zero. No secrets were extracted into artifacts. |

OpenRouter onboarding is needed only if this lane is pursued after the blockers are addressed: sign in or create an account, create a dedicated capped key on [OpenRouter's key page](https://openrouter.ai/settings/keys), and enter it in **Relay → New relay → Compare hosted model prices → OpenRouter API key → Save key**. Do not paste it into chat. Reconcile the audit ledger before choosing its cap; a saved key is still untested. The official [OpenRouter MCP service](https://openrouter.ai/blog/announcements/openrouter-mcp-server/) is distinct from this manual connection. Its OAuth/tool-readiness integration needs a supported Wanigan-owned path; no global or project CLI configuration was rewritten to work around that gap.

## Verification and evidence boundaries

The [environment manifest](relay-audit-2026-09-19/environment.json) records the independent disposable clone, private APFS dependency copy, userData and provider-pack roots. Source and lab dependency sample inodes differ. Native versions were Node `22.23.2`, Electron `44.3.0`, Codex `0.155.1`, Claude Code `2.1.278`, macOS `26.5.2`.

Installed `out/main/index.js`, `out/preload/index.js` and renderer `index.html` hashes exactly match the audit build. [Installed provenance](relay-audit-2026-09-19/installed-provenance.json) records both hashes. This identifies those artifacts; it does not claim that every installed asset/native helper was revalidated. No new package was built or installed.

| Verification | Actual result | Scope |
| --- | --- | --- |
| `npm test` in pinned clone | First seven stages passed. Initial eighth stage aborted before smoke startup with macOS `_RegisterApplication`/SIGABRT under the sandbox. | [Original log](relay-audit-2026-09-19/baseline/npm-test.txt). The original command exited 6, so it is not presented as one successful uninterrupted run. |
| Same-revision `npm run smoke` with native launch permission | Exit 0; **2,620 passed, 0 failed**. | [Smoke log](relay-audit-2026-09-19/baseline/smoke-native.txt). All eight gate stages consequently have passing execution evidence; no product change was needed. |
| Required `npm run probe:terminal` | Exit 0; five replay checks passed. | [Terminal log](relay-audit-2026-09-19/baseline/terminal-replay.txt): real Electron/xterm with synthetic history and recorded output, not an actual agent PTY. |
| Discovery audit | Eight fixture groups; 27 existing pure contracts passed. | Production readers/parsers with replaced process/network/account collaborators. |
| Cost/routing audit | 50 observation cases; 69 pure contracts passed. | Includes real loopback HTTP/SQLite ingestion, substituted provider faults and final-guard collaborators. Cases assert observed defects as well as passing controls. |
| Runtime audit | 19 scenario records checked; all 17 fixture PIDs absent at cleanup. | Real Git, SQLite, APFS and local processes, with substituted accessors/runner/settings. No full-app crash guarantee inferred. |
| Both-theme renderer audit | Original optional probe failed on an obsolete accessible label. A disposable copy updated four selectors only; exit 0, zero renderer errors. | [Original failure](relay-audit-2026-09-19/baseline/relay-renderer.txt), [current-label run](relay-audit-2026-09-19/baseline/relay-renderer-current-labels.txt), [exact selector changes](relay-audit-2026-09-19/baseline/renderer-selector-adjustments.json), [fixture result](relay-audit-2026-09-19/renderer/verification.json). No application code or assertion was changed. |

The renderer audit exercised keyboard stage inspection, stale/delayed selection, project switching, rejection, draft/focus restoration, account inheritance, preview invalidation and account-read failure. It retained 24 baseline screenshots, including [dark composer](relay-audit-2026-09-19/renderer/create-overrides-dark.png), [light composer](relay-audit-2026-09-19/renderer/create-overrides-light.png), [dark stage view](relay-audit-2026-09-19/renderer/standard-dark.png), and [light review](relay-audit-2026-09-19/renderer/review-light.png). These four were visually inspected. They are fixture baseline views, not before/after evidence of a shipped UI fix. Live quota/exhaustion/tool-readiness explanations cannot be certified because those joins are missing.

## Findings that change the next step

Each linked lane report includes exact entrypoints, steps, controls, source/artifact hashes, owning module and unexecuted boundaries. Severity is scoped to the demonstrated boundary, not extrapolated to a paid production incident.

| Priority | Reproduced finding | Why it matters |
| --- | --- | --- |
| P0 | **CR-01:** later activity can retain `reported` status from an earlier, smaller cost export; guard permits the next action before delayed cost arrives. | Incomplete within-session billing can pass admission. This combines reader/pure-guard evidence with a separate Control meter fixture, not a paid end-to-end launch. |
| P0 | **CR-04:** timeout-after-submission and HTTP-error JEV fixtures leave no usage/attempt row. | An ambiguous request cannot be reconciled from a durable request record; no actual vendor charge is alleged. |
| P0 accounting boundary | **CR-02:** replayed OTLP deltas/logs are added again. **CR-03:** explicit zero-cost datapoints disappear. | False spend and false unknowns corrupt budgets and any economic comparison. |
| P0 restore boundary | **RT-01/02:** apply deletes a newly created post-preview file and succeeds while an external writer keeps editing. | The applied change set need not be the reviewed set; success does not establish a stable restored tree. Safety undo recovered the new file in the control. |
| P0 process boundary | **RT-03/04:** detached review children survive owner death, recovery claims they stopped, and two module owners can run overlapping review commands. | Database status is not process-death evidence. The full supported multi-app reachability of the overlap remains unproved. |
| P0 recovery boundary | **RT-06:** a real expired queue lease permits a second fixture writer while the original survives. | Lease expiry alone is insufficient. Production headless terminal-row refusal is an existing mitigation; duplicate paid production work was **not** demonstrated. |
| P1 | **RT-05:** the initial asynchronous checkpoint can capture the child's first edit rather than pre-agent dirty bytes. | Advertised pre-edit recovery needs an actual barrier; this does not certify native hooks. |
| P1/P2 | **DISC-01–06:** default-account probe mismatch, global/unpaginated model cache, lost/rounded buckets, stale reset/cache evidence, backend identity cache, Claude provider-age/timezone loss. | Discovery must be bound to the same identity and freshness semantics used by launch before it can authorize a route. |

Detailed reports: [discovery](2026-09-19-relay-audit-execution-discovery.md), [cost and routing](2026-09-19-relay-audit-execution-cost-routing.md), [runtime and review](2026-09-19-relay-audit-execution-runtime.md).

Passing controls matter too: tested pause/halt/budget/profile/route-account/ownership changes refused launch; Manual previews made zero JEV requests; receipt reuse, mutation and expiry protections held; private dependency preparation refused unsafe links/failures without shared fallback; stale/unsupported verification did not establish a current pass. Those controls should survive the fixes.

## Coverage and live-lane disposition

Every top-level P0 boundary has executed module/process evidence or an explicit remaining blocker in the lane reports. This is **not** a statement that all P0 criteria passed.

| Planned phase/boundary | Disposition |
| --- | --- |
| Isolated baseline and ledger | Complete. Private roots recorded before test mutations; empty ledger persisted before any possible paid admission. |
| Account/model/quota/MCP discovery | Native Codex/account/auth/config snapshots plus offline fault cases executed. Claude live quota, OpenRouter authentication/caps and actual MCP handshakes remain unverified for the reasons above. |
| P0 spend completeness and admission | Executed with four reproduced accounting findings. No global cross-provider reservation exists in the tested product path; the separate audit ledger stayed authoritative. |
| P0 process death/queue/review | Real owner death, real lease expiry, competing owners and survivor writes executed. Full production Electron shutdown/reopen, native PTY ownership and production headless reconciliation require an isolated credential-free launch fixture through the complete lifecycle. The module harness cannot establish that guarantee. |
| P0 private dependencies | Real APFS/link controls and injected clone/ENOSPC refusal executed. Real cross-volume/full-disk behavior needs a disposable bounded filesystem; filling the shared host disk would not be an acceptable fixture. |
| P0 checkpoint restore | Changed preview, active external writer, symlink target, missing checkout, safety-failure and undo cases executed. Mid-apply ancestor-symlink replacement and real storage exhaustion need explicit race barriers/disposable storage and remain unexecuted. |
| Small paid conformance | Not admitted. JEV unresolved-liability accounting, incomplete execution-cost coverage, absent OpenRouter key, and missing verified hard trajectory bounds fail prerequisites. |
| Controlled Relay coding pilot | Blocked before task creation/launch. No synthetic substitute was counted as a Relay coding trial; no tests or human review gate was weakened. |
| Recovery/closeout | Module-level database recovery and fixture cleanup executed. No new app build/install was proposed. Full-app crash/reopen/native-hook and paid cancellation/billing observations remain named blockers. Ledger reconciled at zero initiated paid requests. |

Native credential replacement inside an unchanged account ID, default/project-account races, remote MCP cancellation/auth expiry/tool-list changes, actual provider 402/429 recovery, native first-prompt/modal/hook behavior and full app graceful-quit process termination remain specifically unverified. Catalog/config presence and passing transport fixtures do not close them. No paid run was needed to reproduce the blocking findings.

## Economics and budget closeout

The [durable ledger](relay-audit-2026-09-19/spending-ledger.json) contains the single $50 ceiling, allocations, zero admitted requests, and reasons each live lane was declined. Confirmed audit API/tool charges: **$0**. Pending audit liabilities: **none**. Active reservations: **$0**. Remaining authorization: **$50**. This records requests initiated for the audit, not unrelated account spending or an invented dollar valuation of the assistant conversation.

| Measure | Result |
| --- | --- |
| Complete Manual/Auto coding trajectories | 0 / 0 |
| Human-accepted task results | 0 |
| Total API cost per accepted result | Undefined; denominator is zero |
| First-pass success, repair cost, accepted results/hour | Not measured |
| Cheapest/best-quality model or policy | Not established |
| Causal token/cost savings | No claim |

Fresh unauthenticated OpenRouter metadata returned 447 catalog rows. The [public snapshot](relay-audit-2026-09-19/discovery/public-openrouter.json) retains six tool-declaring DeepSeek, Qwen, Mistral and GLM candidates plus two endpoint responses. Conditional pricing is preserved. These are hosted candidates, not a verified open-weight/license list or measured winners; the [discovery report](2026-09-19-relay-audit-execution-discovery.md) gives the exact IDs and source URLs. Six successful metadata GETs, including one corrected sanitization repeat, made no inference requests.

Public hosted-model prices can shortlist candidates, but cannot overcome missing account access, tools, attributable bills or accepted outcomes. A larger quota reading does not alone make an account the best route.

## Ordered implementation backlog

1. **Request liability and metering:** persist an attempt/reservation before dispatch; retain ambiguous failures; reconcile actual requests/exports with identities and complete coverage; preserve explicit zero and handle duplicate/temporality correctly. Recheck total settled plus pending plus reserved liability at final admission. Keep provider controls separate from a global audit ceiling.
2. **Restore and process ownership:** bind apply to the reviewed tree/action fingerprint, handle active writers, capture pre-edit state before launch, and track/reconcile process groups across quit/crash. Preserve private dependencies, safety undo and current verification limits.
3. **Usable account eligibility:** use the same resolved account environment as launch; bind catalogs to identity/credential generation, paginate them, preserve quota buckets and fractional values, expose source age/reset/unknowns, and recheck queued decisions. Do not infer shared/independent pools from model names or labels.
4. **Tool readiness and connections:** separate saved configuration, authentication, discovered tools and verified calling support for each account/harness. Add the missing external MCP/OAuth readiness extension point and account-filtered OpenRouter metadata before claiming an automatic hosted route.
5. **Selection and economics:** join eligibility, price/allowance/budget, observed task outcomes and latency into Auto while preserving Manual's zero-suggestion path and cost/quality preference. Run the smallest bounded conformance and paired accepted-result pilot only after the relevant blockers are fixed; record repairs and paid review against the original trajectory.
6. **Audit maintenance:** update the optional renderer probe's obsolete labels in a separate scoped change and add durable regression cases at the actual failing boundaries. Do not count this audit's temporary selector copy as a product fix.

Implement through declared extensions and retain required trust-module reasons. Any nonurgent change on an unconverted surface needs the separate behavior-preserving conversion commit required by AGENTS.md. This audit did not invoke the urgent-fix escape or modify the debt ledger.
