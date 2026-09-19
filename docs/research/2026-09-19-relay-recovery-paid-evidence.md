# Recovery: verify the evidence behind paid-request accounting

Continuation of the approved recovery scope on `feat/routing-suggester`, after the original recovery implementation and the concurrent `cc64311` accounting-outcome commit. No account eligibility behavior changes in this follow-up. Node 22.23.2; offline fixtures only; $0 provider spend and the full original $50 allowance remains unspent.

## Problem and resulting behavior

Review reproduced a case where `accountForPaidOperation` accepted a nonexistent owner row and Recovery then omitted the request solely because its outcome string said `metered`. The regression test failed with `true !== false`. An accounting label is not the recorded evidence required to let restore discard current history.

Required Usage now binds the receipt, response metadata, allowed owner identity and bounded accounting fields with an evidence hash. The additive `evidence_hash` column leaves original receipts intact. Recovery recomputes the binding before treating the operation as accounted for. A missing, changed, unreadable, malformed or mismatched owner remains unresolved. A duplicated provider request ID cannot account for multiple attempts. A change after Review preview invalidates that preview and keeps the checkout claim. Migrations do not manufacture bindings for older outcome rows: those remain unresolved until a supported evidence path exists.

The two supported owner links remain Improve prompt and learning model assistance. Improve prompt must have its recorded model and valid input/output/cache-read meters; a missing price remains a separate owner-level blocker. Learning must have a finalized run with a finite nonnegative reported cost, and its receipt remains labelled `reported-estimate`. The CLI runner rejects nonzero exits, signals and truncated output even if partial stdout contains a plausible cost. Normal process completion alone is insufficient.

The SDK response observer is also isolated from transport failure. Failure to open/write the bookkeeping database or an observer exception leaves the receipt unresolved but returns the original received response. It cannot masquerade as a network failure and induce another paid SDK retry. Actual transport failures still reject and preserve every attempt's receipt.

## Provider statements and limits

Anthropic states that failed requests are not charged, while a client disconnect or timeout during a request that would succeed remains chargeable. The HTTP-error classification is an inference from that statement, not a provider-issued zero-dollar bill. This implementation retains the explicit `not-charged-provider-stated` label, requires a provider request ID and a 400–599 response on a direct, unredirected `https://api.anthropic.com` request. Intermediary/redirected errors do not inherit that statement. [Anthropic billing help](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage), [request IDs and errors](https://platform.claude.com/docs/en/api/errors).

Successful headers without complete recorded owner evidence, cut responses, ambiguous request IDs, transport failures and timeouts remain unresolved. No timeout or acknowledgement clears a receipt. No estimated cost is rewritten as billed spend. Accounting outcomes remove only this particular financial-uncertainty blocker; they do not authorize execution, release a checkout, resume a restored generation or reconcile historical spending.

Companion, legacy interviews, batch submission and dry-run samples still lack supported successful-response owner links. Raw catalog, credential-validation, pricing, Scout and push transports remain outside this specific paid-submission boundary. Cross-generation liability merging, generic orphan recovery and post-restore spending reconciliation remain unsupported. Existing Storage crash/participant/generation protections are unchanged.

## Verification

Focused checks use real SQLite, the production evidence/Recovery code, and synthetic transports. They cover positive metering and provider-stated failure controls; missing/changed/deleted owners; duplicate response IDs; legacy unbound outcome rows; intermediary errors; observation failure without retransmission; and stale Recovery previews. The new learning test executes the actual private runner with harmless local Node children for successful, nonzero, signaled and oversized-output cases, plus refusal before spawn during maintenance. It does not run a provider.

Final verification on 2026-09-19, all exit 0:

| Command / boundary | Result |
| --- | --- |
| `npm test` | All eight gates; 2,703 smoke assertions, no failures |
| Recovery inspection | 17 tests, including changed/deleted owner evidence and stale-preview refusal |
| Storage maintenance | 15 adversarial process scenarios |
| Native Backup | Six Electron processes: v1/v2 restore/reopen and failed swap/reopen refusal |
| Learning runner | Five cases: complete exit, nonzero exit, signal, oversized output and refusal before spawn |
| `npm run build` | Passed; existing bundle-size advisory only |
| `npm run probe:terminal` | Five replay checks |
| `node scripts/probe-recovery-native.mjs` | Seven real-main/preload/PTY and maintenance checks with a synthetic CLI |
| `node scripts/probe-recovery.mjs` | Three renderer checks, both themes, no page errors |
| `git diff --check` | Passed |

The current [dark](../visuals/relay-recovery-completion-2026-09-19/after/recovery-dark.png) and [light](../visuals/relay-recovery-completion-2026-09-19/after/recovery-light.png) Recovery screenshots were visually inspected; Backup, release preview and restored-inspection captures were regenerated in the same run. [Renderer provenance and checks](../visuals/relay-recovery-completion-2026-09-19/after/verification.json). The existing before captures are preserved. This follow-up changes accounting evidence and refusal text, not renderer layout; synthetic screenshot data does not prove native accounting behavior.

Full-suite log: `/private/tmp/wanigan-recovery-final-npm-test.log`; build, terminal, native and UI logs share the `/private/tmp/wanigan-recovery-final-` prefix. An initial sandboxed full run passed the first seven gates but could not launch native smoke (exit 6); the complete rerun with native-launch permission passed. During this session another session committed the original pending accounting work as `cc64311`, then the bounded native-probe wrapper as `d10ee29`; both were preserved, without rewriting those commits.

Keychain-isolation fixes remain in place: temporary roots, mock Keychain arguments and the native lifecycle probe's explicit unavailable encryption facade. Production sessions, credentials, provider packs, data and scheduler registration are outside the fixtures. No paid provider was used.
