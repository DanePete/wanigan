# Community Jev routing: what Relay can reuse

Checked 2026-09-19 through fresh web searches, canonical GitHub READMEs,
implementation files where retrievable, and linked evaluation documentation.
Six directly relevant projects are examined below. No project was installed,
cloned, executed, or given credentials. Reported benchmark results belong to
their authors; source inspection here is not reproduction.

The useful work already exists in pieces: conservative route policy,
threshold calibration, bounded supervision, and paired outcome evaluation.
None of the reviewed evidence establishes that adding Jev to Relay will reduce
the total cost of accepted changes at unchanged quality.

## The six projects

### 1. `gargpratyush/jev-router`: conservative routing policy

This now wraps both Claude Code and Codex with a loopback proxy. One fresh-turn
decision selects an exact available model; continuations retain their route.
Its README says only the user's prompt text reaches TypeSafe, and documents
temporary local records containing complete routing exchanges. It depends on
private CLI request formats and rewrites requests, so its transport is a poor
fit for Wanigan's declared provider contracts. The reviewed README supplies
compatibility tests, not an end-to-end savings/quality study.
[Repository](https://github.com/gargpratyush/jev-router).

The inspected policy prevents low-confidence downgrades, caps uncertain
upgrades, and avoids downgrades above a context-size threshold. **An earlier
Wanigan note overstated its availability guarantee:** `clampToAvailable()`
prefers upward movement but does fall downward if no stronger allowed tier
exists. Relay should preserve its stricter declared-choice behavior.
[Policy source](https://github.com/gargpratyush/jev-router/blob/master/src/policy.mjs).
Its 0.3 confidence and 20,000-token cache thresholds are configurable heuristics,
not portable calibration results. The ten generic complexity labels also
deserve replacement with concrete task rubrics before reuse.
[Configuration source](https://github.com/gargpratyush/jev-router/blob/master/src/config.mjs).

### 2. `abhixhek/jevcal`: calibrate decisions and detect drift

Takes question definitions and labeled JSONL examples, measures Jev, fits
thresholds on one split, and checks them on held-out rows. Conservative mode
requires a 95% lower confidence bound; a lock records policy/evidence, and CI
can detect reduced accuracy, coverage, or model-version drift. Teacher LLM
labels are explicitly distinguished from ground truth. Its README demo is
simulated, not a Jev performance result. The author reports live integration
checks, while LLM labeling/fallback tests use stubs.

This is the closest reusable design for Relay's uncalibrated thresholds.
Use acceptance-check outcomes and reviewed labels, preserve question/model
versions, and replay already recorded probabilities before funding new calls.
Do not send repository evidence to an LLM teacher or Jev by default: the tool
accepts whatever semantic content its dataset contains. It does not enforce
Wanigan's backend/consent boundaries. Python CLI installation and its runtime
cascade are optional; the experiment/lock structure is the valuable part.
[Repository and documented workflow](https://github.com/abhixhek/jevcal).

### 3. `JoacoMarc/jev-harness-router`: decomposition and bounded latency

Uses one batch for tool Nouls, skill Choice plus gates, and a difficulty Score;
code derives model tier and effort. Catalog order defines an abstract
capability ladder. It has deterministic shortcuts, a cache, a deadline, and
heuristic fallback. The author reports 54 labeled routing fixtures: skill
accuracy 94.4% versus 81.5% for keywords, but exact-tier accuracy falls from
64.8% to 53.7%. Those labels are expectations about routes, not executed code
outcomes. Thresholds are fitted to those fixtures; no separate held-out result
is shown in the reviewed README.

Its `calibrate` command measures **network latency**, not decision calibration.
The README recognizes hostile message content and enforces tool-risk floors
in code. Probability floors still cannot serve as authorization. Reuse
catalog-driven questions, explicit fallback provenance, and cold/warm latency
measurement; do not import tool permission decisions or unvalidated tier/effort
thresholds. This is a standalone TypeScript router/chat harness using provider
API keys, rather than Wanigan's existing CLI sessions.
[Repository, algorithm, and benchmark](https://github.com/JoacoMarc/jev-harness-router).

### 4. `thruwire/foreman`: bounded supervision with lifecycle policy

A concurrent Python supervisor observes a real Codex worker, asks nine Nouls,
and lets deterministic policy steer, stop, retry, verify, finish, or escalate.
Its Jev state includes job text, bounded diffs, worker output, Git state, and
events. Those are potentially hostile and cross the backend boundary; bounding
them does not establish trust. Its event timeline and grace periods are useful
ideas, but importing its observation pipeline would violate Relay's current
intent-only Jev boundary. [Repository](https://github.com/thruwire/foreman).

Source confirms that verification may be considered resolved solely because
`needs_verification` is below threshold. Relay must keep its mandatory
verification/review checks. The finite retry/worker limits and post-steering
grace period are reusable independently of that policy.
[Policy source](https://github.com/thruwire/foreman/blob/main/src/foreman/policy.py).
The author explicitly disclaims demonstrated gains in success, cost, latency,
calibration, and correctness; the deterministic simulation proves software
structure, with live service behavior requiring a separate run.
[Evidence boundaries](https://github.com/thruwire/foreman/blob/main/docs/what-foreman-proves.md).

### 5. `bestagentkits/jev-skillful`: retrieval evidence and outcome methodology

Discovers installed capabilities, uses BM25/quota shortlisting, then asks a
Choice including abstention plus candidate Nouls. Cache identity includes
prompt and catalogue identity; a bounded hook injects limited advice.
Descriptions are model input, so installed metadata requires the same
untrusted-content scrutiny as provider manifests. Installation modifies host
hooks/extensions; that integration should not be imported into user
repositories by Wanigan.

The author reports 67 development and 22 holdout fixtures, with holdout
retrieval recall 0.600 against a 0.90 target. Better downstream scoring cannot
recover a candidate already lost by retrieval. Its README clearly says its
task-outcome benchmark has **not run** and live Codex injection remains
unverified there. [Repository](https://github.com/bestagentkits/jev-skillful).

The valuable part is the proposed paired evaluation: reset both arms to the
same commit/environment, verify initial failures, run deterministic acceptance
checks, and report rescued **and harmed** tasks. Its control-failure screening
targets capability-bound tasks; Relay would also need an unfiltered deployment
sample to avoid mistaking that selected sample for overall performance.
[Outcome benchmark protocol](https://github.com/bestagentkits/jev-skillful/blob/main/docs/bench.md).

### 6. `DECRUX9812/typesafe-skill-router`: advisory skill routing

An opt-in Hermes plugin uses a wide pass over skill chunks, then reranks a
shortlist and checks the selected skill's own fit. It can abstain; failures
preserve the underlying turn. It sends current request text, skill names,
descriptions, and shortlisted SKILL.md excerpts, while excluding conversation
history/tool output. Thus it is relatively bounded but still accepts skill
content that may contain steering instructions.

Its four-turn live-use log deliberately includes a miss and a wrong suggestion;
it is not an outcome benchmark. The reported larger effectiveness result is
TypeSafe's experiment, not this plugin's. Reuse winner-specific suitability
gating and reversible advisory delivery if Relay later routes skills. This
does not solve cheapest-model selection. Its Python standard-library plugin
lives in Hermes home configuration, a separate installation surface from
Wanigan-owned runtime configuration.
[Repository and algorithm](https://github.com/DECRUX9812/typesafe-skill-router).

## License and maintenance snapshot

All six canonical repository pages expose an MIT license. Preserve attribution
if copying implementation. At inspection, GitHub showed the following small
histories; these counts establish a snapshot, not ongoing maintenance or
production maturity.

| Repository | Visible commits | Installation surface |
| --- | ---: | --- |
| [jev-router](https://github.com/gargpratyush/jev-router) | 48 | Node global CLI; proxy; user skill/settings integration |
| [jevcal](https://github.com/abhixhek/jevcal) | 4 | Python package from Git; datasets, cache, reports |
| [jev-harness-router](https://github.com/JoacoMarc/jev-harness-router) | 7 | Node/TypeScript standalone router and chat harness |
| [foreman](https://github.com/thruwire/foreman) | 6 | Python runtime; Codex subprocess; local event/state files |
| [jev-skillful](https://github.com/bestagentkits/jev-skillful) | 15 | Node CLI and installed host hooks/extensions |
| [typesafe-skill-router](https://github.com/DECRUX9812/typesafe-skill-router) | 2 | Hermes plugin and home configuration |

## Top three reuse recommendations for Relay

1. **Copy the calibration/evidence structure from jevcal.** Record the exact
   request policy/model/candidate snapshot and link it to accepted outcomes.
   Fit thresholds on training data and validate on a held-out set. Keep
   unresolved routes on the existing conservative default.
2. **Adapt jev-router's asymmetric policy as a pure module.** Require stronger
   evidence for cheaper-model or lower-effort moves, and account for switching
   costs where observable. Preserve operator overrides, declared capabilities,
   budgets, and mandatory checks. Do not adopt its HTTP proxy or downward
   availability fallback.
3. **Borrow jev-skillful's paired outcome evaluation before claiming savings.**
   Compare total metered cost per accepted change, retries, elapsed time, and
   harmed/rescued cases on the same task/commit. Keep routing-label accuracy,
   model confidence, and final engineering outcomes as separate measurements.

These are recommendations from inspection, not proven gains. TypeSafe itself
requires domain-specific threshold evaluation and documents that hostile state
can influence Jev. Keep numeric budget policy and trust gates in code.
[Confidence](https://docs.typesafe.ai/confidence),
[Jev limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).
