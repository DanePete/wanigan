# Relay: more accepted work for the money

This implements the approved [cost and throughput roadmap](../../research/2026-09-19-relay-cost-throughput-roadmap.md). The objective is total cost per accepted result, including retries and review. Token prices and JEV confidence are inputs, not evidence that a model will deliver a correct change.

## Ownership and sequence

1. Convert sessions, worktrees and checkpoints into required modules without changing behavior. Commit this separately before changing those surfaces.
2. Make automatic spending use one budget/coverage rule. Preserve cached token buckets and distinguish per-attempt evidence from resumed conversation totals. Preserve unfinished checkouts and require private dependencies for mutating Relay work.
3. Add an optional model-economics module: bounded public catalogue discovery, exact decimal prices, endpoint capabilities, durable freshness and daily refresh. Module-owned maintenance handles free metadata independently of paid queue lanes.
4. Reuse main-owned preview receipts when creating an unchanged Relay. Bind to validated inputs, profile fingerprints, offered models and policy; expire and bound the cache. Never accept renderer-supplied suggestions as evidence.
5. Expose routine automation and its allowance in the Relay composer. Existing Control owns dispatch, leases, completion gates and stop conditions. Human acceptance, commits and deployment remain explicit actions.
6. Connect additional backends through declared provider profiles and runtime configuration, preserving the harness trust boundary. Published model support is distinguished from an observed successful coding run. A missing credential or unverified protocol is shown as unavailable.

## Routing and cost

Discovery may cover the entire public catalogue; automatic execution may use only configured, eligible profiles. Capability constraints precede numerical ranking. Unknown rates, unsupported effort, conditional pricing and stale data cannot become a claim of cheapest execution. Manual model and effort choices remain exact. Subscription quota and API dollars remain separate.

The implementation does not train a success predictor from uncalibrated JEV confidence or propagate a final human verdict as independent success observations for every stage. Operational receipts retain provenance so a future controlled evaluation can measure accepted results per dollar.

## User experience

The composer keeps the outcome first, then Auto/manual model choice, cost-quality preference, and automatic progress with an explicit dollar allowance. Advanced public price comparison is expandable. Explain missing evidence and stopped automation in plain language. Do not ask the user to configure internal queue machinery.

## Verification

Use pure shared tests for budget, pricing, eligibility and receipt lifetime rules. Use offline main-process tests for IPC validation, module ownership, migrations, actual route receipt reuse, private dependency behavior and checkout retention. Run the full repository `npm test` gate and `git diff --check`. Capture the real isolated Electron composer before and after in both themes. Provider protocol fixtures prove parsing and constraints only; live hosted coding quality remains unverified until an explicitly funded real run records evidence.
