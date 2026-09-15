# Git and Settings · Accountability

Three changes make Wanigan's own record harder to get wrong: a check for secrets
before a commit or push, a policy ledger that shows tampering, and Assisted-by
trailers built from recorded sessions.

## Secrets caught before they leave

Pressing **Commit** or **Push** in the Git view now runs a scan first:

- A commit scans `git diff --cached`. Stage all & commit scans the tracked working tree against HEAD.
- A push scans every commit it would publish. With an upstream, that is `@{upstream}..HEAD`. Without one, it is the commits since the merge base with `origin/<branch>`. On a first push, it is the commits that no origin branch has.

Each commit's patch is scanned separately, so a secret added in one commit and
removed in the next is still found. The scan reads added lines only and places
each finding at its file and new line number.

A finding appears as `file:line`, the rule that matched, and the line with the
value masked. The action stays blocked until someone presses **Commit anyway**
or **Push anyway**.

The check is enforced in the main process, not only on screen. The commit and
push handlers scan again. They go past a finding only when the request carries
the digest of the findings as they are now. That digest is a hash of every
finding and a per-process keyed fingerprint of each value. So a secret staged
after the list was drawn produces a new digest, and the action is refused
again. The phone's commit route refuses outright and says a phone cannot
acknowledge a possible secret. Its answer carries no path or excerpt, only a
count.

The rules favour precision over recall:

- **Key shapes:** PEM private-key blocks, AWS key IDs, GitHub (`ghp_`, `gho_`, `ghs_`, `ghu_`, `github_pat_`), Slack `xox*`, Stripe `sk_live_`, Google `AIza`, Anthropic `sk-ant-`, OpenAI `sk-proj-`, and npm `npm_`.
- **Assignments:** `password`/`secret`/`token = "…"` counts only when the value is long, mixed and high-entropy.

A clean result says what was read and that it is not proof. A line marked
`wanigan:allow-secret` is not reported, and the report counts how many lines
were skipped this way.

## A policy ledger that shows tampering

An additive migration adds `prev_hash` and `hash` to `policy_ledger`. Each insert
stores `sha256(prev_hash + canonical JSON of the recorded fields)`. It computes
this inside a transaction that takes the write lock first, so two processes
cannot fork the chain.

The head is signed with an Ed25519 key. The key is made on first use and its
private half is encrypted by the OS keychain in Wanigan's user-data directory.
Signing never covers over evidence: if the stored head no longer matches, the
next write leaves that head in place.

Settings › Projects & safety › Trust and the policy ledger shows one of these
results. **Verify now** checks again.

| Result | Meaning |
|---|---|
| ✓ Chain verified through N records · head signed | Every chained record recomputes and links, and the signed head still matches |
| ✕ Chain broken | Names the first record that fails, with its tool and time, and whether it was edited, removed or inserted, or lost its hash. Only earlier records count as verified |
| ✕ Head does not match | The chain recomputes, but not to the head that was signed. Recomputing every hash after an edit causes this |
| ◑ Verified, unsigned | The chain recomputes, but no head signature could be checked, and the reason is given |
| ? Not verified | The check itself failed. Nothing from an earlier check stays on screen |

Records written before the migration are counted as "before the chain began".
They are never counted as verified.

An export now includes each row's `prev_hash` and `hash`. It ends with a signed
record, and that record includes the app's own verdict at export time, so an
export of a rewritten ledger cannot pass as clean.
`node scripts/verify-ledger.mjs <file> --fingerprint <hex>` checks an export
offline with `node:crypto`.

## Assisted-by trailers

The **Commit attribution** setting is off by default. When it is on, a commit
from the Git view ends with one `Assisted-by: <harness> (<model>)` line for each
distinct harness and model among recorded sessions. A session counts only if
Wanigan started it, it worked in this checkout, and it ran after the commit this
one follows.

The commit box shows the exact lines first, and the label says where they come
from. Main derives the list again when you commit. If it differs from the list
on screen, the commit is refused.

## Screenshots

| | Dark | Light |
|---|---|---|
| Before · commit box | ![](before/commit-box-dark.png) | ![](before/commit-box-light.png) |
| After · Assisted-by preview | ![](after/trailer-preview-dark.png) | ![](after/trailer-preview-light.png) |
| After · commit blocked by findings | ![](after/commit-blocked-dark.png) | ![](after/commit-blocked-light.png) |
| Before · push confirmation | ![](before/push-confirm-dark.png) | ![](before/push-confirm-light.png) |
| After · push blocked by findings | ![](after/push-blocked-dark.png) | ![](after/push-blocked-light.png) |
| Before · ledger | ![](before/ledger-dark.png) | ![](before/ledger-light.png) |
| After · chain verified, head signed | ![](after/ledger-verified-dark.png) | ![](after/ledger-verified-light.png) |
| After · chain broken | ![](after/ledger-broken-dark.png) | ![](after/ledger-broken-light.png) |

`scripts/probe-accountability.mjs` rendered these in isolated Electron with
synthetic git, policy and prefs. The before images come from `dba7528` in a
detached worktree and the after images from this change, with the same
fixtures. Each directory's `verification.json` lists the checks that ran.

The probe also covers these states, without screenshots:

- a clean scan, and a scan that failed
- the setting off, and trailers that cannot be worked out
- a head mismatch, and a chain check that failed

The main-process behaviour runs against real repositories, a real bare remote, a
real pre-chain database and the offline verifier as its own process in
`src/main/smoke17.ts`.
