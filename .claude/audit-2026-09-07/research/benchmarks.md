# Coding-agent benchmarks an operator can run locally (as of 2026-09-07)

Research task: benchmarks-howto, for the Wanigan audit. Read-only; nothing in the repository was changed.

Verification labels: **[primary]** = read on the vendor's own site, docs, paper or repository; **[secondary]** = read on someone else's page; **[unverified]** = reported by a search summary only, not read on a page. Every source carries the date it was published or last updated where the page said so; "fetched 2026-09-07" otherwise.

GitHub blob URLs returned HTTP 403 to WebFetch, so repository contents were read through `gh api repos/.../contents/...` (base64-decoded). Those are still primary sources.

---

## 0. Summary table

| Benchmark | Measures | Tasks + grader public? | Bring-your-own-agent (Claude Code / Codex CLI)? | Docker | Cost signal recorded by harness | Per-task cost (frontier) |
|---|---|---|---|---|---|---|
| SWE-bench Verified | Resolve a real GitHub issue in a Python repo; FAIL_TO_PASS + PASS_TO_PASS tests | Yes (HF dataset + harness) | Yes: mini-swe-agent (`mini-extra swebench`) or SWE-agent produce `preds.json`; official harness grades the patch. No built-in Claude Code / Codex driver. | Yes; prebuilt images are x86_64, arm64 "experimental" | mini-swe-agent: per-call LiteLLM cost, `cost_limit` | No primary figure found |
| SWE-bench Lite | 300-task subset of the above | Yes | Same | Same | Same | No primary figure found |
| SWE-bench Pro (public) | 731 long-horizon issues, 11 repos, 4 language classes | Yes (HF `ScaleAI/SWE-bench_Pro`, `swe_bench_pro_eval.py`) | SWE-agent (primary) or mini-swe-agent | Yes; prebuilt `jefzda/sweap-images` per instance | Same as above | No primary figure found |
| Terminal-Bench 2.0 / 2.1 | 89 terminal tasks with tests; reward 0/1 (or named metrics) | Yes (Harbor Hub dataset; tasks include tests) | **Yes, natively**: Harbor has `-a claude-code`, `-a codex` (and ~40 other installed-agent adapters) | Yes (local Docker) or Daytona/Modal/etc. | `TrialResult.agent_result`: `n_input_tokens`, `n_cache_tokens`, `n_output_tokens`, `cost_usd` | Leaderboard has COST/TOKENS columns; values not retrievable (JS-rendered) |
| Aider polyglot | 225 Exercism exercises in 6 languages, 2 attempts | Yes (`Aider-AI/polyglot-benchmark`) | No: it benchmarks a *model* through aider's own edit loop, not an external CLI agent | Yes (`benchmark/docker.sh`) | `total_cost`, `seconds_per_case` in stats YAML | gpt-5 (high): $29.08 for all 225 = ~$0.13/exercise (2025-11-20 leaderboard) |
| LiveCodeBench | Competitive-programming problems; pass@1 on hidden tests | Yes | No: model-API completions only | No | None | n/a |
| METR time horizon | 228 tasks (HCAST, RE-Bench, SWAA + new) with human baselines; 50%/80% horizon | **Partly**: 31 example tasks public; the suite is not | Inspect + METR Task Bridge; agent scaffold is METR's | Yes (prebuilt task images) | Not documented | Not documented |
| FrontierCode 1.1 | Mergeability of a patch on a real issue: blocker criteria + weighted rubric | **No**: tasks, tests and rubrics withheld; access for model creators | Cognition runs it, through Claude Code, Codex, mini-SWE-agent and Devin harnesses | n/a | Cognition publishes avg cost/task | $1.09–$10.53 per task (Devin Fusion post, data 2026-08-07) |

---

## 1. SWE-bench Verified / Lite / Pro

### What it measures
A model or agent receives a repository at `base_commit` plus a `problem_statement`, and must produce a patch. The harness applies the patch, runs the `FAIL_TO_PASS` tests (must now pass) and `PASS_TO_PASS` tests (must still pass). Score = % resolved.

### Sizes [primary]
- Full: 2,294 tasks; Verified: 500; Lite: 300 (swebench.com, fetched 2026-09-07). Lite has 300 test + 23 dev instances chosen by filters (no images/links/PR references, >=40-word statements, single-file gold patches with <=3 hunks, no error-message asserts) "to reduce evaluation costs while maintaining benchmark quality" (swebench.com/lite.html, fetched 2026-09-07).
- Verified: "500 problems" (swebench.com harness reference). OpenAI's announcement page returned HTTP 403, so its creation story (professional-annotator screening) is not re-verified here.
- Pro public set: 731 rows on HF `ScaleAI/SWE-bench_Pro`, 11 repos (NodeBB, qutebrowser, Ansible, OpenLibrary, Teleport, Navidrome ...), 4 language classes, columns include `dockerhub_tag`, `fail_to_pass`, `pass_to_pass`, `interface`, `requirements` (HF page, fetched 2026-09-07). The paper (arXiv 2509.16941) describes 1,865 problems across 41 repos split into public (11 repos), held-out (12) and commercial (18) [primary, abstract read via search excerpt only, treat the split counts as **unverified** here].

### Harness and Docker [primary]
- Official: `python -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Verified --predictions_path <preds> --max_workers N --run_id <id> [--instance_ids ...]`; the newer CLI form on the README is `swebench eval verified -p <path_to_predictions> --run-id <run_id> -j <num_workers>` (github.com/SWE-bench/SWE-bench README, fetched 2026-09-07).
- Requirements as stated: "Storage: At least 120GB free space (for any cache level); Memory: At least 16GB RAM recommended; CPU: 8+ cores recommended" (swebench.com/SWE-bench/reference/harness/). Cache levels: `base`, `env` (default), `instance` (~2TB, fastest).
- Apple silicon: "Support for `arm64` machines is experimental." and "On an M-series Mac or another ARM-based system, use `--task-repo` so the images are built locally with Docker Buildx." (README).
- mini-swe-agent's runner hardcodes the image name `docker.io/swebench/sweb.eval.x86_64.{id}:latest` (src/minisweagent/run/benchmarks/swebench.py line 75, read via gh api 2026-09-07) and the docs say "docker containers for Linux assume an x86 Linux architecture; you might not be able to run them on other architectures" (mini-swe-agent.com/latest/usage/swebench/). On a Mac this means Rosetta/QEMU emulation of x86 images or a local Buildx rebuild; neither is fast.
- Epoch AI (post dated 2025-07-10) ran all 500 Verified tasks, agent plus grading, in 62–73 minutes on one **32-core / 128 GB** VM using its own slimmed image registry (30 GiB for the 500 Verified images, 67 GiB for all 2,290) with a 300,000-token per-sample cap. That is the fastest published figure and it is not a Mac number.

### Bring-your-own-agent path [primary]
- mini-swe-agent: `pip install mini-swe-agent`, then
  `mini-extra swebench --model anthropic/claude-sonnet-4-5-20250929 --subset verified --split test --workers 4` with `--slice '0:5'` or `--filter <regex>` to take a subset, `--environment-class docker|singularity|...`, `-o <dir>`. Single instance: `mini-extra swebench-single --subset verified --split test -m <model> -i sympy__sympy-15599`. Output is `preds.json` plus per-instance `.traj.json`. (mini-swe-agent.com/latest/usage/swebench/, fetched 2026-09-07.)
- Cost: every model call goes through `litellm.cost_calculator.completion_cost(...)`; a zero/unknown price raises unless `MSWEA_COST_TRACKING=ignore_errors`; totals accumulate in `GLOBAL_MODEL_STATS`, capped by `cost_limit` / `MSWEA_GLOBAL_COST_LIMIT` (src/minisweagent/models/litellm_model.py lines 33–126, read via gh api). So cost is **priced by LiteLLM's table**, not reported by the provider.
- Grading: run the official harness locally, or `sb-cli submit swe-bench_verified test --predictions_path preds.json --run_id <id>` for cloud grading ("Results typically arrive within 20 minutes regardless of instance count").
- SWE-bench Pro used SWE-agent as its primary scaffold and later added mini-swe-agent "with results comparable to SWE-Agent for Sonnet 4.5" (scaleapi/SWE-bench_Pro-os README, fetched 2026-09-07). Its eval script example uses `--num_workers=100`.
- **There is no official Claude Code or Codex CLI driver for SWE-bench.** To benchmark those CLIs you either (a) write a loop that starts the container, runs `claude -p` / `codex exec` inside it, `git diff`s the result into `preds.json`, or (b) use Harbor, which has a SWE-bench adapter in its dataset registry (Harbor's adapters page lists SWE-bench-family datasets; the count and version were not read on a primary page, so **[unverified]**).
- The "bash only" leaderboard on swebench.com evaluates every LM through mini-swe-agent with no tools other than bash, as the model-to-model comparison (mini-swe-agent.com, fetched 2026-09-07). Reported score: ">74% on SWE-bench verified" with Gemini 3 Pro [primary].

### Per-task cost and time
- No primary per-task cost figure for a frontier model on Verified was found. Search summaries quote "$0.25 per resolved task" (Grok 4.3) and similar; those are third-party blog numbers and are **[unverified]**.
- Time: Epoch's ~8 s/task is amortised across 32 cores; a single Mac with `--workers 4` under x86 emulation will be one to two orders of magnitude slower per task. No primary Mac timing exists.

### Comparing with leaderboards
Leaderboards report % resolved on the fixed split, with trajectories and logs required for submission via `sb-cli` or the submissions repo. Model-only comparison uses the "bash only" (mini-swe-agent) board. A local subset (e.g. 50 of 500) is not comparable to a leaderboard row unless you also report which instance ids ran; sampled subsets have wide confidence intervals (50 tasks: +/-14 points at 95% for p~0.5).

---

## 2. Terminal-Bench 2.0 / 2.1 and Harbor

### What it measures [primary]
"89 tasks in computer terminal environments inspired by problems from real workflows", each with a unique environment, human-written solution and tests; "frontier models and agents score less than 65%" (arXiv 2601.11868, submitted 2026-01-17). Harbor Hub lists the dataset at 89 tasks with `harbor run -d terminal-bench/terminal-bench-2` (hub.harborframework.com, fetched 2026-09-07).

### Versions [primary]
- 2.1 fixed 28 tasks: 9 for Docker-image drift ("External dependencies"), 8 for insufficient resource budgets, the rest for misspecification (e.g. `query-optimize`); no task removed; dataset id `terminal-bench-2-1` (tbench.ai/news/terminal-bench-2-1, fetched 2026-09-07; page carries no date).
- tbench.ai's "how to run" doc now targets **Terminal-Bench 4.0**: `uv tool install 'harbor[modal]'` and `harbor run -d terminal-bench/terminal-bench@4.0.0 -e modal -a claude-code -m anthropic/claude-sonnet-5 -k 5`, with the note "Terminal-Bench contains tasks that require GPUs, so you need to run it with a sandbox that has GPU access" (tbench.ai/docs/run-terminal-bench-2-0, fetched 2026-09-07). So 4.0 is not fully local on a Mac; 2.0/2.1 are.
- Leaderboard rule of five trials per task (`-k 5`) with no timeout/resource overrides: reported by a search summary, the docs page 404'd -> **[unverified]**. The tbench.ai leaderboard page does show columns RANK, MODEL, AGENT, RESOLUTION RATE, COST, TOKENS [primary].

### Harness [primary]
- Install: `uv tool install harbor` or `pip install harbor`. Quickstart: `export ANTHROPIC_API_KEY=...; harbor run --dataset terminal-bench@2.0 --agent claude-code --model anthropic/claude-opus-4-1 --n-concurrent 4` (github.com/harbor-framework/harbor README, fetched 2026-09-07).
- Environments: local Docker, Daytona, Modal, LangSmith, Blaxel, Novita Sandbox, Tensorlake via `--env`.
- Built-in agents (docs/agents page): Terminus-2, Claude Code, Copilot CLI, Codex CLI, Gemini CLI, Grok Build, OpenHands, Antigravity SDK, Mini-SWE-Agent, fx, MCode, fx-dev; `harbor agent schema <name>` prints options. The repository's `src/harbor/agents/installed/` holds ~40 adapters including `claude_code.py`, `codex.py`, `gemini_cli.py`, `copilot_cli.py`, `cursor_cli.py`, `mini_swe_agent.py`, `aider.py`, `goose.py`, `devin.py`, `kimi_cli.py`, `hermes.py`, `junie.py` (listing via gh api, 2026-09-07).
- Claude Code adapter (`claude_code.py`): installs with `npm install -g @anthropic-ai/claude-code[@version]` or the `downloads.claude.ai/.../bootstrap.sh` installer; API key env `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, base URL `ANTHROPIC_BASE_URL`; sets `ANTHROPIC_MODEL=<model>`; runs with `--output-format=stream-json --print` and takes the authoritative cost from the final `{"type":"result", ..., "total_cost_usd": <float>}` line; if that event is missing it estimates from per-step usage with LiteLLM (lines 109–117, 191, 442–444, 477, 944–995).
- Codex adapter (`codex.py`): installs Node 22 via nvm then `npm install -g @openai/codex[@version]`; reads `last_token_usage` (`input_tokens`, `output_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `reasoning_output_tokens`, `total_tokens`) from Codex's session log (lines 343–369, 519–528). Codex reports **tokens, not dollars**; Harbor's `cost_usd` for Codex is therefore an estimate or `None` (which is consistent with Wanigan's own note in `src/main/headless.ts:280`: "Codex has no budget flag of its own and reports no cost").
- Output schema (`src/harbor/models/trial/result.py` and `models/agent/context.py`): `TrialResult { task_name, trial_name, trial_uri, task_checksum, agent_result: AgentContext{n_input_tokens, n_cache_tokens, n_output_tokens, cost_usd, rollout_details, metadata}, verifier_result, exception_info, started_at, finished_at, environment_setup/agent_setup/agent_execution/verifier: TimingInfo{started_at, finished_at} }`. Every trial writes its own `result.json`; the job writes an aggregate `result.json`; `harbor view` renders them. **This is exactly the paired-metric tuple the operational question asks for (pass/fail via reward, cost, tokens, wall time), produced natively for Claude Code and Codex.**
- Adapter guidance requires pinned agent versions on both sides (e.g. `codex@0.1.0`) and dated model ids (e.g. `claude-sonnet-4-5-20250929`) for parity runs (harborframework.com/docs/datasets/adapters, fetched 2026-09-07).

### Cost, time, infra
- Infra: Docker Desktop on the Mac; tasks are built from Dockerfiles (arm64 builds work where the base images have arm64 variants, which is most but not all). `--n-concurrent 4` is the README's local example.
- Cost: not published on a page I could read. Leaderboard COST column exists. Budget from first principles: a 2.0 task allows the agent a long session; frontier-model runs of the 89 tasks x 5 trials are hundreds of dollars, not tens. Treat as **unknown** until one trial is run.

### Comparing with leaderboards
Resolution rate = mean reward over `k` trials x 89 tasks on the exact dataset version. Local runs are comparable only at `-k 5`, same version tag, no timeout overrides.

---

## 3. Aider polyglot

- 225 Exercism exercises across C++, Go, Java, JavaScript, Python and Rust, "the most difficult 225 exercises out of the 697"; two attempts, the second after seeing unit-test output (aider.chat/2024/12/21/polyglot.html; aider.chat/docs/leaderboards/, last updated 2025-11-20) [primary].
- Setup: clone aider, `mkdir tmp.benchmarks`, clone `Aider-AI/polyglot-benchmark` into it, `./benchmark/docker_build.sh`, `./benchmark/docker.sh`, `pip install -e .[dev]`, then `./benchmark/benchmark.py <run-name> --model <model> --edit-format diff --threads 10 --exercises-dir polyglot-benchmark`; `--num-tests`, `--keywords`, `--read-model-settings` narrow the run. Report: `./benchmark/benchmark.py --stats tmp.benchmarks/<dir>` emits YAML with `pass_rate_1`, `pass_rate_2`, `total_cost`, `seconds_per_case`, `test_cases: 225`, `commit_hash`, `num_malformed_responses` (github.com/Aider-AI/aider benchmark/README.md, fetched 2026-09-07) [primary].
- Safety: "benchmarking harness will be taking code written by an LLM and executing it without any human review" — hence Docker.
- Cost: leaderboard column is the total for all 225: gpt-5 (high) 88.0% at $29.08; gpt-5 (medium) 86.7% at $17.69; o3-pro (high) 84.9% at $146.32; Gemini 2.5 Pro (32k think) 83.1% at $49.88; gpt-5 (low) 81.3% at $10.37 [primary, 2025-11-20]. A 50-exercise slice therefore costs ~$2–$33 depending on the model. The leaderboard has not been updated for the 2026 model generation.
- Applicability: it benchmarks a **model inside aider**. It cannot benchmark Claude Code or Codex CLI as agents without replacing aider's loop, which changes what is measured.

---

## 4. LiveCodeBench

- Contamination-aware competitive-programming benchmark; problems collected continuously from LeetCode, AtCoder and Codeforces with publication dates so you can score a window that post-dates a model's cutoff (arXiv 2403.07974, submitted 2024-03-12) [primary]. Four scenarios: code generation, self-repair, test-output prediction, code execution (github.com/LiveCodeBench/LiveCodeBench) [primary].
- Run: `python -m lcb_runner.runner.main --model <name> --scenario codegeneration --evaluate` with `--release_version release_v1..v6`, `--start_date/--end_date`, `--n` (default 10), `--temperature` (default 0.2), `--multiprocess` for API models, vLLM for open weights; metrics pass@1 and pass@5 using an APPS-derived checker; the default "lite" test sets are pruned, `--not_fast` uses the originals [primary].
- release_v6 = 1,055 problems, May 2023–Apr 2025 (Kaggle/llm-stats, **secondary**; the official leaderboard page is JS-rendered and returned only "Loading...").
- **Model-API completions only**; no agent or CLI path. Not usable for "one task across N provider profiles" without a wrapper that would make the result incomparable with the leaderboard.

---

## 5. METR time-horizon tasks

- Time Horizon 1.1 (metr.org, 2026-01-29) [primary]: 228 tasks (up from 170), 31 of 8+ hours (only 5 of those with measured human baselines), 73 added, 15 removed, 53 updated; sources HCAST, RE-Bench, SWAA and new HCAST tasks; evaluated on the Inspect framework (moved from Vivaria); horizon = logistic fit of success vs human task duration, reported at 50% (and 80%) with bootstrap CIs over task families, tasks and runs. Reported 50% horizons include Claude Opus 4.5 320 min, GPT-5 214 min, o3 121 min. The time-horizons page was updated 2026-05-08 (Claude Mythos Preview added) but the values are graph-only.
- Public availability [primary]: `github.com/METR/public-tasks` contains **31 example tasks across 10 families** plus summaries of 186 more; METR Task Standard format; run with the METR Inspect Task Bridge: `inspect eval mtb/bridge -T image_tag="${IMAGE_REPOSITORY}:clone_game-0.5.4"` against prebuilt images, or build with `mtb-build --env-file secrets.env --platform PLATFORM --push -r YOUR_REGISTRY ./clone_game`. MIT-licensed with a request not to publish solutions; four tasks forbid training use. `github.com/METR/eval-analysis-public` is analysis-only (`runs.jsonl`, `dvc repro`).
- Consequence: an operator can run the 31 public tasks through Inspect with their own scaffold, but cannot reproduce a time-horizon number, and there is no Claude Code / Codex adapter in the bridge (none seen; **unverified** absence).

---

## 6. FrontierCode (Cognition)

### What it is [primary]
- Introduced 2026-06-08 (cognition.com/blog/frontier-code): 150 tasks from 36 open-source repositories, authored by 20+ maintainers at "more than 40 hours per task"; tiers Extended (150), Main (100 hardest), Diamond (50). "Not currently planned to release publicly to avoid contamination"; evaluation access is offered to model creators.
- Scoring: a solution must satisfy every "blocker" criterion (mergeability) or scores zero; a passing solution earns the weighted aggregate of the rubric items it satisfies. Criteria cover behavioral correctness, regression safety, mechanical cleanliness, test quality, scope discipline, code quality. Each model runs 5 times at every available reasoning effort; the average is reported and the best effort shown. Epoch describes this as "mean@5 aggregation against a weighted rubric" and says it re-publishes Cognition's numbers rather than running independently (epoch.ai/benchmarks/frontiercode, fetched 2026-09-07).
- 1.1 (2026-07-07, cognition.com/blog/frontier-code-1.1): explicit internet-use guidelines (documentation lookup is fair; anything solution-bearing is not) plus programmatic detection of references to upstream PRs and mirrors; all 1,000+ blocker criteria audited and 75 "overly strict" ones demoted to non-blocker; Diamond deprecated as too noisy at low solve rates. The leaderboard changelog adds that from 2026-08-06 runs found consulting solution-bearing sources are scored zero.
- "1.1 Extended" therefore means: methodology revision 1.1, scored on all 150 tasks (not the 100-task Main).
- Harnesses used per Epoch: Claude Code, Codex, mini-SWE-agent and Devin. **Nobody outside Cognition (and model creators it grants access) can run it**; the leaderboard page is JS-rendered and its table could not be read.
- Secondary snapshot (benchlm.ai, page updated 2026-09-04): GPT-6 Astra 64.5, Claude Opus 5 63.6, Grok 4.6 61.3, GPT-5.6 Sol 60.6, GPT-5.6 Terra 55.8, GPT-5.6 Luna 55.1 — these differ from the Devin Fusion post's table (different date, different model set) and are **not** verified.

### Devin Fusion post (cognition.com/blog/devin-fusion, published 2026-06-29, data updated 2026-08-07) [primary, all read on the page]
- Architecture: "Run two parallel agents: one with a frontier model, the other with a more cost-effective 'sidekick' model", each with "their own persistent, cached contexts"; the main agent "should delegate and monitor, while making the significant decisions: the plan, the interpretation of ambiguity, the final review".
- Routing: "lightweight classifiers during task execution" signal model switches; "switching the model during context compaction" uses the cache miss that compaction already triggers.
- FrontierCode 1.1 Extended, score / avg cost per task: Fable 5 (xhigh) 64.9 / $10.53; Opus 5 (medium) 63.6 / $3.51; Devin Fusion 63.1 / $1.35; GPT-5.6 Sol (high) 58.7 / $3.41; Kimi K3 58.2 / $3.12; Grok 4.5 (high) 56.6 / $1.09.
- "41% cost reduction" for Fusion with Fable 5 vs pure Fable 5; "88% of their merged PRs were driven entirely by the automated Fusion router" internally.
- Per-task examples: a JavaScript refactor with a slow test run delegated at 62% lower cost ($3.55 -> $1.37) at no quality loss; a React/Redux feature whose judgment was the deliverable dropped to a score of 27 when delegated.
- The page summary also carried a note reading "Fable 5 access suspended as of June 12, 2026"; the context of that line was not clear from the extract and it is reported here only as text seen, not as an established fact.
- What this means for the operational question: Cognition's per-task costs ($1–$10) are the only primary frontier-model per-task cost figures on a mergeability-grade benchmark found in this pass, and they come with the caveat that the tasks are 40-hour-authored, hard, and unrunnable by third parties.

---

## 7. Cost / time / infra estimates for a 50-task subset

Only figures with a source are multiplied; everything else is stated as unknown.

| Benchmark | 50-task cost (frontier) | Wall time on a Mac | Infra |
|---|---|---|---|
| Aider polyglot | ~$2.3 (gpt-5 low) to ~$33 (o3-pro) pro rata from the 225-exercise totals; 2026 models not on the board | `seconds_per_case` is reported per run; with `--threads 10` a 50-case slice is tens of minutes | Docker Desktop, one container |
| SWE-bench Verified via mini-swe-agent | Unknown from primary sources; LiteLLM prices each call, so the run tells you | Images are x86_64; expect emulation or a local Buildx rebuild per instance; Epoch's 8 s/task needs a 32-core x86 box | Docker Desktop, 120 GB free recommended, 16 GB RAM |
| SWE-bench Pro public | Unknown; same mechanism | Same as above with larger repos | Prebuilt `jefzda/sweap-images` (architecture not stated) |
| Terminal-Bench 2.1 (50 of 89) | Unknown; Harbor records `cost_usd` per trial | `--n-concurrent 4`; many tasks have long timeouts; hours per trial-set | Docker Desktop; arm64 builds for most tasks; GPU tasks only in 4.0 |
| METR public tasks (31 max) | Unknown | Per task, via Inspect | Docker + Inspect + task bridge |
| LiveCodeBench | Model-API only | Minutes | Python; no Docker |
| FrontierCode | Not runnable | n/a | n/a |

Statistical note: 50 tasks at a ~50% solve rate gives a 95% CI of roughly +/-14 points on a single trial, which is wider than most published gaps between adjacent leaderboard rows. Pairing (same task, both profiles) and repeating (`-k 5`) shrink the variance of the *difference* far more than adding tasks does.

---

## 8. The operational question: one task across N provider profiles, cheapest credible path

### Recommendation
Use **Harbor with a local Docker environment and a task written in Harbor's task format** (or a single Terminal-Bench 2.1 task by name). Run it once per provider profile with `-k 5`, pinned agent versions and dated model ids, and read each trial's `result.json`. That yields, natively and for both Claude Code and Codex CLI:

- pass/fail: `verifier_result` reward (0/1 or named metrics in `reward.json`),
- cost: `agent_result.cost_usd` (authoritative `total_cost_usd` for Claude Code; token-derived estimate or `None` for Codex),
- tokens: `n_input_tokens`, `n_cache_tokens`, `n_output_tokens`,
- wall time: `agent_execution.started_at/finished_at`, separately from `environment_setup`, `agent_setup` and `verifier`.

Command shape (from the README quickstart, adapted): `harbor run -d <dataset-or-path> -t <task> -a claude-code -m anthropic/<dated-model> -k 5 --n-concurrent 2`, then the same with `-a codex -m openai/<model>`, then `harbor view`. Task filtering flags (`-t`) were not read on a primary page and are **unverified**; `harbor run --help` will settle them.

Why this is the cheapest credible option:
1. Marginal cost is exactly N profiles x 5 trials x one task's agent spend; no leaderboard-size run is needed for a paired comparison.
2. The grader is a test you wrote, so pass/fail is not a model's opinion.
3. The adapters already handle install, credentials and usage parsing for the two CLIs Wanigan launches, and the same job format is what the Terminal-Bench leaderboard consumes, so a later full run is comparable.

Caveats to state on the result, not hide:
- Codex cost is a price-table estimate; label it as such (Wanigan already refuses to invent this: `headless.ts:1244` logs "reported no cost. Recorded as $0.00, not estimated.").
- Claude Code's `total_cost_usd` is the CLI's own accounting; under a subscription it is a notional price, not a bill.
- A subset score is not a leaderboard score; report instance ids and version tags.

### What Wanigan already has, and the gap
- `HeadlessConfig` (`src/shared/types.ts:936–952`) fans one prompt out **across projects** with one `providerId`, `model`, `effort`, `maxBudgetUsd`, `timeoutMs` and `isolate` (a worktree per repo). Rows record `costUsd`, `costReported`, `durationMs`, `exitCode`, `filesChanged` (`types.ts:965–987`); the runner parses Claude's `total_cost_usd`/usage from `--output-format json` and takes Codex's `exec --json` tokens (`src/main/headless.ts:280–311, 372–388`).
- `evals.createPair(name, a, b)` (`src/preload/index.ts:543`) pairs two runs that differ in exactly one config field ("createPair throws when more than one config field differs", `src/renderer/src/views/Batches.tsx:2146–2152`), which is the right discipline for a paired comparison.
- `learning_experiments` (`src/main/learning/experiments.ts`, `assertFixedControls`) pins provider, model, effort and commit between baseline and candidate, and CLAUDE.md states the registry "does not launch workloads".
- Gap for "one task across N profiles": (1) the fan-out axis is projects, not profiles — N profiles means N separate headless runs of the same prompt on the same repo@commit, then N-1 pairs; (2) there is no verifier step after the agent exits, so pass/fail is absent; (3) no repeat count `k`; (4) tokens are aggregated per run, not per row (`headless.ts:1330`). The smallest honest addition is an "experiment run" that takes {repo, commit, prompt, verifier command, k} x [profiles], launches the existing headless rows in isolated worktrees, runs the verifier in each worktree, and records per-row pass, cost + `cost_reported`, tokens and duration as `artifact_metrics` on the experiment. Alternatively, shell out to Harbor and ingest its `result.json` files, which avoids re-implementing the adapters but adds a Python/uv dependency and a second source of truth.

---

## 9. Sources (date = page date where stated, else fetch date 2026-09-07)

Primary
- https://cognition.com/blog/devin-fusion — 2026-06-29, data updated 2026-08-07
- https://cognition.com/blog/frontier-code — 2026-06-08
- https://cognition.com/blog/frontier-code-1.1 — 2026-07-07
- https://cognition.com/frontiercode — leaderboard (JS-rendered; methodology and changelog text only)
- https://arxiv.org/abs/2601.11868 — Terminal-Bench paper, 2026-01-17
- https://www.tbench.ai/news/terminal-bench-2-1 ; https://www.tbench.ai/news/announcement-2-0 ; https://www.tbench.ai/docs/run-terminal-bench-2-0 (now describes 4.0) ; https://www.tbench.ai/leaderboard/terminal-bench/2.0
- https://hub.harborframework.com/datasets/terminal-bench/terminal-bench-2
- https://github.com/harbor-framework/harbor (README); `src/harbor/agents/installed/{claude_code,codex}.py`, `src/harbor/models/trial/result.py`, `src/harbor/models/agent/context.py` via gh api
- https://www.harborframework.com/docs/agents ; https://www.harborframework.com/docs/datasets/adapters
- https://github.com/SWE-agent/mini-swe-agent (README); https://mini-swe-agent.com/latest/ ; https://mini-swe-agent.com/latest/usage/swebench/ ; `src/minisweagent/models/litellm_model.py`, `src/minisweagent/run/benchmarks/swebench.py` via gh api
- https://github.com/SWE-bench/SWE-bench (README) ; https://www.swebench.com/ ; https://www.swebench.com/lite.html ; https://www.swebench.com/SWE-bench/reference/harness/
- https://github.com/scaleapi/SWE-bench_Pro-os ; https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro
- https://github.com/Aider-AI/aider/blob/main/benchmark/README.md ; https://aider.chat/docs/leaderboards/ (2025-11-20)
- https://github.com/LiveCodeBench/LiveCodeBench ; https://arxiv.org/abs/2403.07974 (2024-03-12)
- https://metr.org/blog/2026-1-29-time-horizon-1-1/ (2026-01-29) ; https://metr.org/time-horizons/ (updated 2026-05-08) ; https://github.com/METR/public-tasks ; https://github.com/METR/eval-analysis-public
- https://epoch.ai/latest/swebench-docker (2025-07-10) ; https://epoch.ai/benchmarks/frontiercode

Secondary / blocked
- https://benchlm.ai/benchmarks/frontiercode11extended (2026-09-04) — secondary
- Kaggle / llm-stats LiveCodeBench v6 pages — secondary (1,055 problems)
- https://openai.com/index/introducing-swe-bench-verified/ — HTTP 403
- https://www.harborframework.com/docs/jobs , /docs/quickstart ; https://www.tbench.ai/docs/submitting-to-leaderboard , /docs/leaderboard — HTTP 404
- https://livecodebench.github.io/leaderboard.html — JS-rendered, no data
