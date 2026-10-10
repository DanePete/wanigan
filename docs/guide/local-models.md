# Models on this Mac

Running Claude Code on a model that lives on your own Mac, through LM Studio, Ollama or NVIDIA PAIR. Back to the [README](../../README.md).

Claude Code can run on a model that lives on your Mac, through
[LM Studio](https://lmstudio.ai): prompts and code go to it, not to a model
provider, and no plan's limits apply. It is optional. Without LM Studio,
Wanigan works exactly as it does, and nothing is downloaded until you choose.

- **Settings › Local models** shows whether LM Studio is installed and its
  server running, and the models Wanigan knows how to run. The first is
  **Qwen3-Coder 30B** with Claude Code (17.2 GB, MLX). **Get** shows the size
  before anything is fetched, checks there is room (Wanigan keeps 10 GB of the
  disk free), shows progress and can be stopped; it carries on where it stopped.
- **New session** offers these models under **On this Mac**. A project's
  settings can make one the model its new sessions start on.
- Starting a session starts LM Studio's server if it is off (on whichever port
  it chooses) and loads the model with room for an agent's instructions and
  tools. A model that is not there refuses to start; nothing falls back to a
  cloud model. Claude Code is told to send Anthropic no telemetry either.
- Models a running **Ollama** (or **NVIDIA PAIR**, at Ollama's address) has are
  offered too, with Claude Code or Codex. Wanigan does not download through them.

Each model says whether its pairing with an agent has been proven: a real turn
with a tool call, read back from Wanigan's own record by
`npm run local:check`. A model not yet proven may not use tools
reliably.
