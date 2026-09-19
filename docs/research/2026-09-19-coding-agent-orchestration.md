# Coding-agent orchestration patterns for Relay

Researched 2026-09-19 using primary documentation, maintained GitHub code, and
an authors' research paper. This is an architectural comparison, not a live
benchmark or a recommendation to replace Wanigan's real CLI sessions. GitHub
`main` and documentation links describe what was inspected on this date and may
change. Proposed Relay adaptations below are design inferences, not measured
savings.

## 1. Aider: separate solution design from file editing when useful

Aider's architect mode sends the task to a model that proposes a solution, then
to an editor model that produces file edits. Models can differ or be identical.
The documentation explicitly says this adds a request and can increase cost and
latency. Therefore, a planner/editor split is a candidate policy to measure,
not an automatic saving. [Chat modes](https://aider.chat/docs/usage/modes.html)

Its implementation gives the editor the architect's output, resets the editor's
chat messages, and carries accumulated cost into and back out of that editor.
This provides a concrete, small handoff contract rather than an unbounded
conversation between agents. [Architect coder source](https://github.com/Aider-AI/aider/blob/main/aider/coders/architect_coder.py)

Aider can lint edited files automatically and run an explicitly configured test
command after edits. A nonzero command exit returns actionable failure to the
editing loop. [Linting and testing](https://aider.chat/docs/usage/lint-test.html)

**Evidence strength:** the September 2024 article reports 85% on Aider's then
code-editing benchmark for particular architect/editor pairs. This is a dated,
first-party benchmark result, not evidence of current cheapest models or
cost per accepted Wanigan change. [Original experiment](https://aider.chat/2024/09/26/architect.html)

**Reuse in Relay:** retain an explicit accepted plan plus bounded implementation
instructions; choose a more capable planner only when task uncertainty justifies
it. Measure direct implementation against planner-plus-editor, counting both
calls, retries and review. Run deterministic checks before buying another model
opinion. Keep the patch checkout intact across that feedback loop.

## 2. mini-SWE-agent: small execution loop, explicit limits and durable failure accounting

The current `DefaultAgent` checks step, accumulated-cost and wall-clock limits
before each model call. It records spend after the response, saves its trajectory
in the loop's `finally` block, and retains structured exit reasons. It also charges
cost attached to malformed responses that raise `FormatError`, and bounds
consecutive format failures. Because cost arrives after a call, its threshold
can be exceeded by that call; this is a stopping threshold, not a guaranteed
maximum invoice. [Agent source](https://github.com/SWE-agent/mini-swe-agent/blob/main/src/minisweagent/agents/default.py)

This accounting detail fixes an actual reported defect: parse failures were
billed but invisible to the agent's local budget, even while global cost stats
were correct. The issue is closed, and the current source contains the recovery
path. [Issue #914](https://github.com/SWE-agent/mini-swe-agent/issues/914)

The documented control loop distinguishes task submission, limit exhaustion,
format errors and interruption. Submission is an execution status; it is not an
independent test verdict. [Control flow](https://mini-swe-agent.com/latest/advanced/control_flow/)

**Evidence strength:** executable reference implementation and a documented
accounting regression. No claim here that mini-SWE-agent is universally cheapest,
or that its self-submission should replace Wanigan's gate.

**Reuse in Relay:** put the last budget/eligibility check directly before the next
spending boundary; meter failed and unusable responses too; persist each attempt
and its exit reason. Distinguish provider failure, malformed output, failed
verification, requested changes, cancellation and acceptance. Keep cumulative
spend independent of node reopening or route upgrades. For CLI harnesses without
per-call control, expose the actual weaker enforcement boundary instead of
promising this SDK's per-call stopping behavior.

## 3. OpenHands SDK: separate routing, execution, evidence and refinement

The SDK separates agents/conversations from tools, workspaces and the agent
server. Its applications consume those interfaces. This is a relevant reference
for Wanigan's extension-first rule: coordination policy should depend on a small
execution contract, not be spread across renderer, queue and session launch.
[Architecture](https://docs.openhands.dev/sdk/arch/overview),
[GitHub repository](https://github.com/OpenHands/software-agent-sdk)

Its routing guide provides a rule-based multimodal router and an extensible router
class. The example selects a text model for text and a multimodal model for
images; it does not establish an empirically optimal general coding router.
[Model routing](https://docs.openhands.dev/sdk/guides/llm-routing)

Metrics identify LLM usage by purpose and aggregate costs across the main agent
and auxiliary models, including context condensation. Individual call cost/token
records remain available. This is useful for tracking JEV routing, implementation,
review, and other paid assistance in the same accepted-result total without
confusing their distinct roles.
[Metrics](https://docs.openhands.dev/sdk/guides/metrics)

The refinement example uses separate implementation and critique conversations
in one retained workspace, forwards prior critique, and caps iterations. Its
stopping score is generated by a model, so its threshold is not equivalent to a
passed test suite or human acceptance. Reuse the bounded same-workspace feedback
loop while retaining Wanigan's independently checked gate.
[Refinement guide](https://docs.openhands.dev/sdk/guides/iterative-refinement),
[Executable example](https://github.com/OpenHands/software-agent-sdk/blob/main/examples/01_standalone_sdk/31_iterative_refinement.py)

The authors' MLSys 2026 paper describes immutable agent configuration and an
append-only event log with replay. It reports system-attributable failures falling
from 78 to 30 per 1,000 conversations during a 15-day parallel V0/V1 rollout.
This is operational evidence in their deployment, not a randomized test of route
quality or cost savings transferable to Wanigan. Their testing approach separates
cheap mocked checks, scheduled live integration checks and expensive benchmark
runs. [Paper, sections 4.2 and 5](https://arxiv.org/html/2511.03690v2)

**Reuse in Relay:** freeze the actual launch specification; append route changes,
attempts, gate results and spend as distinct records; derive the current workflow
from that history. Keep local tests fast and deterministic, then use deliberately
authorized, capped live evaluations for real provider behavior. Saving history
cannot preserve a running Wanigan PTY across a full quit.

## Design decision for JEV + coding LLMs

The strongest combined pattern is a bounded controller around real agent sessions:

1. Classify the task and identify missing context; retain uncertainty.
2. Filter available routes by capabilities, explicit permissions, account and
   budget policy before comparing cost.
3. Choose direct work or a planner/editor split from evidence for comparable
   tasks. JEV can supply an advisory classification; recorded acceptance and
   complete spend determine whether the policy is economical.
4. Launch the pinned route into the owned checkout, preserving it for retries.
5. Run deterministic verification. Return concise failures with a retry cap.
6. Escalate only when the expected remaining cost and quality justify another
   attempt; do not replay the same failing attempt indefinitely.
7. Keep independent review and human acceptance. Record every attempt and the
   total cost of the accepted result, including routing and auxiliary calls.

These steps are a proposed adaptation. None of the inspected systems proves that
adding a classifier, planner, critic, or parallel agent always reduces total
cost. Each extra model has to repay its own cost by reducing failure, rework, or
unnecessary expensive work on the user's actual tasks.

For an authorized paired pilot, hold task, starting commit, acceptance checks and
harness fixed. Compare the current baseline with a candidate policy on the same
tasks; report acceptance rate, all-attempt dollars per accepted result, time,
retry count and unpriced-call coverage. Also report spend on ultimately rejected
work so failures cannot disappear from the comparison. A cheaper result that
misses the acceptance checks does not win.
