# Relay automation

Relay can advance routine work while keeping the project’s checks and the final review decision explicit.

## Use it

1. Choose a project and configure its review commands in **Git → Review gate**.
2. In **Relay**, describe the outcome. Keep **Choose for me**, or choose models and effort yourself.
3. Turn on **Advance automatically until final review** and enter an agent spending limit. **Create and start relay** authorizes the work.
4. Review the final diff and evidence. Approve, request changes, or reject. Git commit and deployment remain separate actions.

For an existing relay, open **Automatic progress settings** to enable, pause or change the allowance. Pausing prevents future automatic actions; a running agent or command continues until interrupted separately.

An accepted plan advances after its agent’s recorded stop. A plan proposal or permission prompt still waits for the operator. Implementation advances only after the current checkout passes the configured review commands. Relay runs verification directly, without paying another model to launch the same commands. A failed verifier stops with evidence. Automatic failure prompts are bounded and recheck the task, stop event, allowance and current session before submission.

## What the allowance means

The allowance stops **new automatic agent turns** when reported agent spend reaches the limit, or when earlier sessions have missing/partial dollar coverage. No previous sessions is a known zero; an unmetered session is not free. Free verification can still run when dollar usage is unknown or the limit has been reached.

This is not a provider-enforced billing cap. An already running turn can exceed it. Model suggestions are recorded separately as estimates. Subscription quota, published token-price estimates and recorded agent dollars are different quantities.

Previewing model choices may call JEV when enabled. Creating an unchanged relay reuses that main-owned decision for up to 15 minutes. Changed inputs, profiles, credentials or policy invalidate the receipt without silently making another suggestion call. A receipt can create only one relay. Automatic verification is omitted from model-selection questions because no model will run that stage.

## Compare prices and connect OpenRouter

**Compare hosted model prices** reads a saved public catalogue. **Get model prices / Refresh prices** contacts OpenRouter without a credential or model call. Add up to 12 models to a comparison, then refresh to retrieve their hosting details. **Keep prices current daily** enables recurring metadata refresh.

Comparison uses the same sample request, exact decimal published rates, cache usage and endpoint capability checks. Unknown prices remain unknown; stale data, unhandled conditional prices, unavailable endpoints or unsupported controls do not qualify as eligible. Estimates exclude the charges named in each row. A catalogue entry is not proof of coding quality or harness compatibility.

The optional [OpenRouter manual connection](openrouter-connection.md) uses the actual installed Codex CLI. Save a key securely, then choose the OpenRouter profile in **New session** and enter an exact model ID. Saving the key does not authenticate or launch a paid test. This experimental connection does not yet report verified billed cost or qualify for automatic progress.

## Evidence and recovery

- Frozen attempt records preserve input, output, cache-read and cache-write observations. Missing buckets remain unknown.
- Resumed Codex conversation totals are not added repeatedly as new attempt usage. Attempt deltas require trustworthy, non-overlapping boundaries.
- Goal checkouts are retained for retries and review, even when the working tree is clean. Remove them deliberately when no longer needed.
- Implementation sessions use private dependency copies. If isolation cannot be established, launch refuses; it never falls back to a shared dependency link.
- Codex receives supported initial prompts as literal argv entries. The remaining interactive path checks the current output state and stops when a modal or manual input intervenes.

These changes remove specific sources of waste and expose better evidence. They do not yet establish a measured savings percentage, a calibrated success predictor, or that a particular hosted model is the cheapest route to an accepted change. Those claims require funded, representative runs with complete outcomes.

## Implementation verification

On September 19, 2026, `npm test` passed all eight repository gates under Node 22.23.2, including 2,620 offline main-process checks with zero failures. Session reliability coverage includes the reproduced Codex failure-paste regression, actual worktree isolation and retention, and refusal before spawning when authorization changes. `git diff --check` passed.

[Before/after UI evidence](visuals/relay-automation/README.md) covers both themes and a real, isolated Electron public-price lookup. No paid OpenRouter run or savings experiment was performed. The local build was verified; this change does not install or replace a running application.
