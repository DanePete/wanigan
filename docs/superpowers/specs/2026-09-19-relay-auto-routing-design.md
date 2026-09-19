# Relay model and effort choice

Approved direction: adapt the researched JEV routing patterns into Relay,
preserve the actual selected route through execution, and count failed attempts
when evaluating cost. The operator additionally chose both Auto/Manual selection
and a cost-versus-quality preference on 2026-09-19.

## Operator contract

- Auto uses the already-enabled JEV integration, with Lower cost (default),
  Balanced, or Higher quality as an explicit preference. It never enables a
  credential or paid capability silently. Unavailable advice uses declared
  profile defaults with an explanation.
- Manual uses the profile defaults or explicit per-stage model/effort overrides.
  It makes no JEV call and does not narrow the pipeline automatically.
- Both controls reach main through typed preload inputs, are validated before
  spending or writing, and are recorded with route decisions. Invalid operator
  model/effort choices remain errors. Tests and human review are unchanged.
- A preference expresses an objective, not a measured savings claim or a
  reduced acceptance standard. Routing remains inside the selected profile.

## Decision and execution

Use a single bounded JEV batch for model choice and model-specific supported
effort choices. Read effort only for the selected model; weak/malformed advice
falls back conservatively. Keep operator intent as the only semantic state;
do not send code, diffs, tool output, or cross-backend semantic memory.

Persist the resolved model, effort, account, and permission mode that launch
actually uses. Autopilot respects stage pins. A correction reuses its verified
owned checkout and refuses a missing checkout instead of silently starting over.
Recheck budget and meter coverage at automatic dispatch. CLI supervision is a
stop/dispatch boundary, not an exact maximum invoice guarantee.

## Outcome evidence

Keep attempt-level identities and review observations instead of overwriting
failed history. Derive accepted-result cost from every linked attempt, preserve
unknown costs, and do not credit models on deterministic/human-only stages.
Keep effort and route changes distinct. Existing legacy observations remain
available but are not treated as repaired/calibrated history.

Observed operational outcomes may inform later route recommendations only with
their sample counts, comparability, and missing-meter limits intact. New model
trials, automatic paid exploration, and training a router are outside this change.

## Modules and validation

Convert Control's migration/IPC ownership into a required module before any
behavior changes, in its own commit. Relay and usage already have modules.
Add shared contract tests and real SQLite smoke coverage at the execution and
metering seams, using mocked external process boundaries. Capture the composer
before/after in both themes and verify the actual UI payloads. Run `npm test`,
the required smoke suite, and `git diff --check` before handoff.
