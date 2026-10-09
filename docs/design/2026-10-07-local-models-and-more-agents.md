# Local models, and more agents

7 October 2026. Agreed with the owner in conversation; this records what was
decided and how it is built.

## What the owner asked for

- Run agents on models that live on this Mac, through **modules**: each module
  is one model (Qwen first), says which agent it works with and what it needs,
  and says honestly whether that pairing has been proven.
- It is **optional**. Without LM Studio (or Ollama, or NVIDIA PAIR) Wanigan is
  exactly what it was. Nothing downloads until the owner clicks, and the size is
  shown before anything is fetched.
- **LM Studio** is the runtime Wanigan downloads and runs through. Ollama and
  NVIDIA PAIR are detected when running, and their models are offered, but
  Wanigan does not download through them.
- A local model is chosen in the **New session** picker, and a project can
  **default** to one.
- The first module: **Qwen3-Coder 30B (A3B) with Claude Code**.
- Gemini (Google DeepMind) and Grok (xAI) become agents Wanigan can run, beside
  Claude Code and Codex.

## Local models

### A module is data

`src/shared/local-models.ts` holds the modules. A module names:

- the model as LM Studio knows it (`qwen/qwen3-coder-30b`), its format (MLX)
  and its measured download size (17.19 GB);
- the agent it runs under (`claude`) and the context it is loaded with;
- whether the pairing is **proven** (a real turn with a tool call, read back,
  on a named date and CLI version) or **not yet proven**. A module is not
  marked proven until Wanigan has run it end to end.

Models found on a local server that no module describes are offered too,
labelled "not proven with this agent".

### A local model is a model value

The session's model is `local/<runtime>/<model id>`, for example
`local/lmstudio/qwen/qwen3-coder-30b`. It is stored where any model is
(`sessions.model`), so resuming and carrying a conversation on keep it, as they
keep any model. At launch the core turns it into the CLI's own settings:

- **Claude Code:** `ANTHROPIC_BASE_URL` at the runtime's Anthropic-compatible
  address, a placeholder `ANTHROPIC_AUTH_TOKEN`, the model as `--model` and as
  every default model variable (so helpers and subagents stay local), and the
  account's own credentials left out.
- **Codex:** `--oss --local-provider lmstudio|ollama -m <id>`.

Before launch the core checks the runtime is running and the model is there,
starts LM Studio's server if it is the runtime, and loads the model with the
module's context length. A missing model refuses with what to do, never a
silent fallback to a cloud model.

### What the owner sees

- **Settings › Local models:** whether LM Studio is installed and its server
  running (Start), each module with its agent, size and proven status, **Get**
  (a confirmation with the size, then progress you can cancel) and the other
  models found on LM Studio, Ollama or PAIR.
- **New session:** an "On this Mac" group in the model picker. A module not yet
  downloaded is listed with its size and a pointer to Settings.
- **A project's settings:** a default local model; the New session dialog
  starts on it.
- **A running session** says it is local, and which model. Local sessions have
  no usage limits and spend nothing.

## More agents: Gemini and Grok

Each becomes a provider beside `claude` and `codex`, launched in a real
terminal like them. What each can report to Wanigan (hooks handed over at
launch, never written into a project or the owner's own configuration), where
its conversations live and how it resumes are established by probing the
installed CLIs before anything is built; the findings are recorded in
`docs/research/`. Whatever a CLI cannot report is shown as unsupported rather
than guessed.

## How it is proven

- Unit tests over stand-ins: a stand-in `lms`, a stand-in local server, the
  launch arguments and environment each choice produces, the picker's list.
- The UI sweep and crawl in both themes, with screenshots looked at.
- End to end, for real and at no cost: Claude Code on Qwen3-Coder through LM
  Studio on this Mac, a turn with a tool call, its hooks driving the session's
  state, read back from Wanigan's own record.
- Gemini and Grok: everything up to sign-in on the real CLIs; a real model turn
  needs the owner's login and is reported as not yet run until it has been.
