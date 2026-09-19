# OpenRouter manual connection

The optional OpenRouter connection launches the installed `codex` executable
with invocation-scoped custom Responses configuration. It does not write a
repository file or change global Codex settings. The connection is experimental:
Wanigan has not observed a hosted coding run, tool round trip or bill for it.

Save an OpenRouter key explicitly in the connection controls, or provide
`WANIGAN_OPENROUTER_KEY` to Wanigan. Saved keys use the existing OS-backed
encrypted credential store. An environment value takes precedence, so removing
the stored key does not remove an environment override. Saving, removing and
reading status make no network request; a key marked present has not been
authenticated against OpenRouter.

Choose **OpenRouter · experimental manual connection** and enter an exact
`provider/model-id` for a manual session. Model selection is required. Avoid
routing aliases such as `openrouter/auto`: this connection does not resolve or
attest the upstream provider. The selected text reaches `--model` unchanged as
an argument. Codex receives the first prompt as one positional argument after
`--`, which avoids relying on a timed terminal paste. Ordinary terminal input
remains available after launch.

The fixed custom provider uses `https://openrouter.ai/api/v1` and Responses,
reads `OPENROUTER_API_KEY` from the launch environment, disables WebSockets and
automatic transport retries, and requests workspace-write sandboxing with
on-request approval. It uses `env_key` rather than a shell-based authentication
helper. OpenRouter documents that this configuration can leave Codex without
model metadata; an unknown-model warning is not evidence that a model has been
tested. Codex's existing user/project configuration still applies.

Wanigan treats the profile as a generic manual terminal. It declares no resume,
headless execution, hooks, telemetry, effort control or semantic memory support.
The catalog's endpoint prices remain explicit workload estimates. This direct
CLI path neither pins OpenRouter's selected upstream endpoint nor records a
generation ID or actual provider bill, so its spend is unpriced and automatic
paid progress is unavailable. A future promotion needs recorded end-to-end
protocol evidence and attributable cost, not just a valid public model listing.

Primary configuration references: [OpenRouter's Codex guide](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli)
and [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference).
The local CLI inspected during implementation was Codex 0.155.1; checking its
help and offline argv fixtures did not make a hosted inference request.
