# Relay delivery

Relay previously stopped at the human review decision. The requested workflow
continues through Git commit and deployment, using a command configured for each
project. This is a change to the existing Relay extension, not a new kind of
ordinary Goal task.

## Design

The existing Goal graph ends in Review. Its acceptance rules, checkout selection,
agent routing, and automatic dispatch depend on that boundary. Relay therefore
owns two additional persisted stages after Review: Commit and Deploy. They are
local operations with explicit operator actions; they are never dispatched to a
model or started by approval, polling, or autopilot.

New relays include delivery by default, with an opt-out at creation. Historical
relays keep their original endpoint until the operator adds delivery stages.
Configuring a deployment command saves a project preference; running it is a
separate decision. The command and timeout remain editable from Relay before the
work reaches deployment.

Commit previews name the accepted implementation checkout, revision, changed
files, message and any attribution trailers. A main-process token binds the
action to that preview. The action stages the listed changes, commits through
Wanigan's existing secret and attribution checks, and records the real revision.
A clean approved checkout offers an explicit action to record its existing HEAD.
Commit does not imply push. A failed commit can leave reviewed files staged;
evidence and recovery instructions must say so.

The commit panel offers **Reopen verification and review** before a commit has
been recorded. It preserves prior evidence, reopens the existing checks and
human review through Control, and turns autopilot off. This supplies the actual
recovery path after stale approval or a failed commit; it does not launch an
agent or treat a new passing check as a new human approval.

Deploy previews name the committed checkout, revision, exact saved command and
timeout. A configuration change or checkout edit invalidates the preview.
Attempts retain command output, exit status, timing, cancellation and errors.
An exit code of zero establishes successful command execution; it does not
independently establish remote rollout health. Cancellation stops local work;
external effects already performed by the command may remain.

The baseline dark/light captures are in
[`../visuals/relay-delivery-2026-09-19/before`](../visuals/relay-delivery-2026-09-19/before).
They were taken from the frozen renderer at commit `59e9c20`, before this feature.
Renderer fixtures are explicitly synthetic and do not establish main-process
execution or deployment claims.

## Verification

The main-process smoke extension uses temporary Git repositories, the actual
verification/approval boundary, real Git commits and harmless local shell
commands. It covers approval and preview freshness, new-file commits, existing
commits, command configuration changes, failures, explicit retries and process
cancellation. It also exercises competing relays sharing a checkout, a timed-out
command whose shell has already exited, crashed-owner recovery, and a commit
hook that changes the approved tree. No provider or deployment service is
contacted.

Verification passed with Node 22.23.2:

- `npm test`: all eight gates, including 539 shared tests, six asynchronous
  credential scenarios, and 2,375 main-process smoke assertions.
- `scripts/probe-relay-delivery.mjs`: nine UI groups with zero renderer errors,
  including recovery back to verification, explicit actions, stale reads,
  multiline commands, and narrow layouts.
- Existing Relay workspace, account and routing probes: 10 groups, 19
  assertions and 12 assertions respectively, with zero renderer errors.
- `git diff --check`: clean.

The [after captures and probe results](../visuals/relay-delivery-2026-09-19/after)
contain 26 dark/light screenshots. The fixtures and backend tests complement
one another; neither claims a real remote deployment occurred.

An already-running Git commit uses the existing guarded Git helper, which has
no cancellation handle. Emergency halt retains its checkout lock until the
helper settles and records interruption honestly; quitting warns that Git may
still finish. Deployment commands have separate process-group cancellation.
