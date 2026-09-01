# Provider packs — field reference

A provider pack is a JSON manifest that teaches Wanigan how to launch a CLI
agent. It is data, not code: `src/main/provider-packs.ts` validates it and
compiles it into an argument array, and nothing in a manifest is ever handed to
a shell. Packs that genuinely need code ship an optional capability-probe
adapter, which is trusted separately from the manifest.

Read [the ceiling](#the-ceiling) first if you are deciding whether to write one.

## Where a pack lives

| Platform | Root |
|---|---|
| macOS | `~/Library/Application Support/wanigan/provider-packs/` |
| Windows | `%APPDATA%\wanigan\provider-packs\` |
| Other | `$XDG_CONFIG_HOME/wanigan/provider-packs/`, else `~/.config/wanigan/provider-packs/` |

`WANIGAN_PROVIDER_PACKS_DIR` overrides the root; it is read once at startup.

Two layouts are discovered:

- a **directory** named exactly the pack id, containing `provider-pack.json`;
- a stand-alone **`<pack-id>.json`** file at the root.

The manifest `id` must equal the directory or file name. Symbolic links are
refused at both levels, entries beginning with `.` are skipped, at most 200
entries are inspected, and a manifest above 256 KiB is rejected before it is
parsed. A stand-alone JSON file has no private directory, so it can carry
neither an adapter nor any pack-relative path.

**Learning → Providers → Refresh packs** re-reads the root.

## Identifier rules

| Where | Pattern | Cap |
|---|---|---|
| pack `id`, profile `id`, `backend.id`, `publisher.id`, credential `id` | `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$` | 100 |
| launch-field `id`, capability id | `^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$` | 64 |
| environment destination name | `^[A-Za-z_][A-Za-z0-9_]*$` | — |

Names, labels and ids are trimmed and rejected if empty. Every string in a
manifest, argv entries included, is rejected if it contains a NUL byte or a
line break. Any single validation error makes the whole pack `invalid`; there
is no partial load.

## Top-level manifest

| Field | Required | Notes |
|---|---|---|
| `schemaVersion` | yes | must be the number `1` |
| `id` | yes | must match the directory or file name |
| `label` | yes | ≤ 100 chars, shown in the UI |
| `version` | yes | ≤ 100 chars, opaque string, frozen onto live sessions |
| `description` | no | ≤ 2,000 chars |
| `publisher` | no | `{ id, name, url? }`; `url` must be `http:` or `https:` |
| `adapter` | no | see [Adapter protocol v1](#adapter-protocol-v1) |
| `profiles` | yes | 1–100 entries, ids unique within the pack and across all installed packs |

## Profile

| Field | Required | Notes |
|---|---|---|
| `id` | yes | becomes the provider id the rest of Wanigan routes on |
| `label` | yes | ≤ 100 chars |
| `description` | no | ≤ 2,000 chars |
| `harness` | yes | `claude-code` · `codex` · `generic-cli` |
| `backend` | yes | `{ id, label, description?, baseUrl? }` |
| `command` | yes | see below |
| `launchFields` | no | ≤ 100, ids unique |
| `resume` | no | `{ conversationArgs, continueArgs }` |
| `environment` | no | ≤ 100 destinations |
| `capabilities` | no | ≤ 200 declarations |
| `headless` | no | `claude-json` · `codex-json` · `none` (default `none`) |

Cross-field rules, all enforced at validation:

- `generic-cli` must declare `headless: "none"` or omit it.
- `claude-code` may not declare `codex-json`; `codex` may not declare
  `claude-json`.
- A **local** profile whose harness is not `generic-cli` requires an adapter in
  the same manifest. A manifest without one is generic-terminal only.

`backend.id` is namespaced for local packs. A local profile's effective backend
identity is `<packId>:<backend.id>`, so writing `"id": "anthropic"` cannot
inherit the built-in Claude backend's semantic memory.

## `command`

| Field | Notes |
|---|---|
| `bin` | **required.** An installed command name only. Absolute paths and anything containing `/` or `\` are rejected, as are shells and general-purpose interpreters (`sh`, `bash`, `zsh`, `pwsh`, `node`, `deno`, `bun`, `python*`, `ruby`, `perl`, `php`, `osascript`, `env`, `xargs`, `npx`, `busybox`, …). ≤ 1,000 chars |
| `baseArgs` | ≤ 100 argv entries, prepended to every launch |
| `versionArgs` | ≤ 20; defaults to `["--version"]` |
| `helpArgs` | ≤ 20; defaults to `["--help"]`. Wanigan runs it automatically during discovery, as it does `versionArgs` |
| `fallbackPaths` | ≤ 100. **Refused for local packs** — declaring any makes the pack `invalid`. Built-ins use it for things like `{home}/.claude/local/claude` |
| `editorExtensions` | ≤ 20 × `{ prefix, executablePaths }` (≤ 20 paths each) |

The command-name denylist is defense in depth, not proof that an unfamiliar
executable is safe. It stops a manifest turning a general-purpose interpreter
into unsigned executable glue; it says nothing about the CLI you install.

`editorExtensions` handles agents that ship inside an editor extension rather
than on `PATH`. Wanigan scans the `extensions` directory under `~/.vscode`,
`~/.vscode-insiders`, `~/.cursor` and `~/.windsurf` for directories
starting with `prefix`, newest-first, and resolves each `executablePaths` entry
inside the matched directory. A path that resolves outside it is dropped.

Both `executablePaths` and `fallbackPaths` substitute `{home}`, `{packDir}`,
`{arch}` and `{platform}`.

## `launchFields`

Each field becomes one control in the launch form and compiles to argv entries.

| Field | Notes |
|---|---|
| `id` | field-id pattern, ≤ 64. `model`, `effort` and `permissionMode` also populate the `supports` flags the existing UI reads |
| `label` | ≤ 100 |
| `description` | ≤ 2,000 |
| `kind` | `text` · `select` · `boolean` |
| `required` | boolean. A required field with no value throws at launch |
| `defaultValue` | string for `text`/`select`, boolean for `boolean` |
| `placeholder` | ≤ 200, text fields |
| `choices` | `select` only; 1–100 × `{ value, label, description? }`, values unique, each ≤ 200 |
| `allowCustom` | `select` only. Unless it is exactly `true`, a value outside `choices` is refused at launch |
| `argv` | `text`/`select`. ≤ 20 entries, at least one containing `{value}` |
| `trueArgv` / `falseArgv` | `boolean` only. ≤ 20 entries each |

Every array entry is **one** argv element, capped at 4,096 characters. `{value}` is
substituted by string replacement into that single element, so a value can never
split into a second argument or become a command. `argv` on a boolean field, or
`trueArgv`/`falseArgv` on a non-boolean one, is a validation error.

```json
{ "id": "model", "label": "Model", "kind": "text", "argv": ["--model", "{value}"] }
```

## `resume`

```json
"resume": {
  "conversationArgs": ["--resume", "{conversationId}"],
  "continueArgs": ["--continue"]
}
```

≤ 20 entries each. `conversationArgs` is used when Wanigan has a conversation id
to hand back, `continueArgs` when it does not. `{conversationId}` is substituted
per entry. Declaring `resume` at all is what sets `supports.resume`.

## `environment`

A map from the destination variable name to one source.

| `source` | Shape | Value |
|---|---|---|
| `literal` | `{ "source": "literal", "value": "…" }` | the literal string, ≤ 4,096 characters |
| `process` | `{ "source": "process", "name": "VAR", "fallback": "…" }` | Wanigan's own process environment, else `fallback` |
| `credential` | `{ "source": "credential", "id": "…" }` | Wanigan's OS-keychain provider credential store; `id` defaults to the profile id |

Rules that matter:

- **Refused destinations.** Anything that can inject code or override Wanigan's
  own controls: `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `DYLD_*`, `PYTHON*`,
  `RUBYOPT`, `PERL5*`, `BASH_ENV`, `ENV`, `ZDOTDIR`, `JAVA_TOOL_OPTIONS`,
  `CLASSPATH`, `GCONV_PATH`, `QT_PLUGIN_PATH`, `DOTNET_STARTUP_HOOKS`,
  `PROMPT_COMMAND` and the rest of that family, plus every name beginning
  `LD_`, `DYLD_`, `NIX_LD`, `CORECLR_`, `COR_`, `WANIGAN_`, `OTEL_`,
  `ELECTRON_`, `CHROME_` or `VSCODE_`. Declaring one is a validation error, not
  a silent drop.
- **A missing credential empties the whole map.** If any `credential` source
  resolves to nothing, the profile contributes `{}` rather than a partial
  environment — a base URL and its token are one atomic configuration, and
  shipping the redirect without the credential is how a shared harness ends up
  authenticating to an unintended account with ambient credentials.
- Empty and undefined values are dropped from the compiled map.
- Consent shows every destination, source, literal and fallback before a pack
  can be enabled. Stored credential *values* stay redacted.

## `capabilities`

A map of capability id to one of four states:

| State | Meaning |
|---|---|
| `supported` | the profile claims it. For a built-in pack this permits the harness default; it never manufactures support the harness lacks |
| `unsupported` | fail closed |
| `unknown` | fail closed |
| `probe` | defer to a trusted adapter. **Only this state lets an adapter answer** |

### The vocabulary Wanigan consumes

Seven ids map onto the `ProviderCapabilities` record that the rest of the app
reads:

| Capability id | Boolean | What it actually gates |
|---|---|---|
| `hooks` | `hooks` | injecting `--settings <generated file>` — the hook bus, and with it the timeline, attention queue and policy gate |
| `mcp` | `mcp` | injecting `--mcp-config <generated file>` |
| `policy` | `policy` | a headless run in a repo that is not Trusted is refused without it |
| `headless.json` | `headlessJson` | whether the profile appears in Runs at all, and whether a headless run may start |
| `telemetry` | `telemetry` | **reported only.** The OTLP exporter environment follows the Settings toggle, not this flag |
| `transcript` | `transcript` | **reported only** at present |
| `resume.named` | `namedResume` | **reported only**; resume argv comes from the `resume` block |

Three more ids are declared by the built-in packs and read by nothing today:
`skills`, `instructions.project`, `memory.native`.

**Any other id validates cleanly and does nothing.** `capabilities` is an open
string map by design — an unrecognised id is not an error and is not a feature.
Do not read a declaration back as evidence that Wanigan wired something.

There is also a derived `probed` boolean, which is not declarable. It is true
for a built-in profile whose `--help` was inspected, or for any profile whose
trusted adapter probe succeeded. A local profile with `probed: false` gets no
hook injection, no MCP config, and no attachment `--add-dir` flags, and cannot
start a headless run.

## Adapter protocol v1

An adapter is a bounded capability probe. It does not choose, wrap or replace
the session executable, and it has no session-control authority.

```json
"adapter": { "kind": "process", "protocolVersion": 1, "executable": "bin/probe", "args": [] }
```

`executable` is resolved relative to the pack directory and must stay inside it;
`args` is ≤ 100 argv entries. The file must be a regular, non-symlink,
executable file of at most 128 MB, and the pack must be a directory pack.

What a probe run does, in order:

1. Re-read the approved file, verify it is still a regular non-symlink
   executable, and recompute its SHA-256 against the trusted digest.
2. Copy those exact bytes into a fresh `0700` temp directory, re-verify the
   staged copy's digest, and spawn **the staged copy** with `shell: false`,
   `detached` off Windows, and `cwd` set to the directory that holds the
   approved adapter — `<pack>/bin` for the example above, not the pack root.
3. Pass a credential-free environment: `PATH`, `HOME`, `USER`, `LOGNAME`,
   `TMPDIR`, `LANG`, `LC_ALL`, `SHELL`, plus
   `WANIGAN_PROVIDER_ADAPTER_PROTOCOL=1`. No API keys, no Electron environment.
4. Write one NDJSON request to stdin and close it.
5. Enforce the bounds: 5 s wall clock, 256 KiB stdout, 64 KiB stderr, exit code
   0, and **exactly one** non-empty stdout line. Any breach kills the process
   group with `SIGKILL`, removes the staging directory, and fails closed.

Request:

```json
{"protocolVersion":1,"id":"probe","method":"probe",
 "params":{"profileId":"…","packId":"…","harness":"…","backendId":"…","command":"…"}}
```

Response — one line, then exit 0:

```json
{"protocolVersion":1,"id":"probe","ok":true,
 "result":{"capabilities":{"hooks":true,"headlessJson":true},"note":"optional, ≤1000 chars"}}
```

Capability keys accepted in `result.capabilities` are `hooks`, `telemetry`,
`mcp`, `policy`, `transcript`, `namedResume`, `headlessJson`, booleans only.
An answer is kept only when **both** filters pass:

- the manifest declared that capability as exactly `probe`; and
- Wanigan can actually wire it for this profile — `hooks`, `mcp`, `policy` and
  `transcript` require harness `claude-code`; `headlessJson` requires a
  non-`none` `headless` on a `claude-code` or `codex` harness; `namedResume`
  requires a `resume` block.

Anything else the adapter asserts is discarded silently, because a probe can
prove the provider side of a contract but cannot manufacture Wanigan wiring
that does not exist.

A v1 adapter must be **self-contained**. Sibling files are not copied into
staging, so an adapter that reads its own neighbours will fail there.

The adapter process boundary is **not** an OS sandbox and not containment. It
is a digest-pinned, time-bounded, output-bounded, credential-free spawn of code
you approved. Treat approving one as installing software.

## Trust

Discovery is not installation consent.

1. A newly seen or newly changed local manifest is `needs-trust` and cannot
   launch anything.
2. `trustManifest` records the **exact** manifest SHA-256 you reviewed, and
   leaves the pack disabled.
3. If the pack has an adapter, `trustAdapter` records the adapter's digest
   separately. Trusting one never trusts the other.
4. Only then does enabling succeed, and only while both digests still match.

Editing one byte of an enabled manifest returns it to `needs-trust`, which is
what stops an enabled pack silently changing its argv. Consent must display
every base, version, help, launch-field and resume argv template and every
environment destination, source, literal and fallback before you approve it.
Automatic version and help probes run with a minimal credential-free
environment. Upgrading the external CLI a pack names is a separate trust class
that Wanigan does not observe.

Statuses a pack can hold: `enabled`, `disabled`, `needs-trust`,
`pending-removal`, `invalid`, `removed`.

Disabling blocks new launches and reinterprets nothing. Uninstall does the same
immediately, defers the filesystem move while a live session still holds one of
its profiles, then moves the pack to Wanigan's recoverable `.trash`. Session
history, credentials, knowledge, evidence and projections survive; cleaning
those up is a separate, previewable decision.

## The ceiling

Be clear-eyed about what a third-party pack reaches today.

- **Every declared capability of a local pack starts `false`**, regardless of
  what the manifest says. The declaration cannot turn a claim into support.
- A local pack that is not `generic-cli` is `invalid` without an adapter, and
  an adapter needs its own digest approval.
- `hooks`, `mcp`, `policy` and `transcript` additionally require harness
  `claude-code` — the wiring is Claude-shaped, and a probe cannot widen it.
- So a manifest-only third-party pack today is **a well-configured terminal**:
  a real PTY, a real CLI, launch fields, resume, environment and credential
  wiring, process exit reported. No hook timeline, no attention states beyond
  exit, no policy gate, no MCP injection, no headless fan-out, no attachment
  directory.

That is the honest boundary. It is not a roadmap statement, and nothing in the
UI should imply more.

## A minimal working example

An installed, authenticated `gemini` CLI exposed as an attended generic
terminal — no invented hooks, no adapter:

```json
{
  "schemaVersion": 1,
  "id": "local.gemini",
  "label": "Gemini CLI",
  "version": "1",
  "profiles": [{
    "id": "gemini-local",
    "label": "Gemini CLI",
    "harness": "generic-cli",
    "backend": { "id": "google-gemini", "label": "Google Gemini" },
    "command": { "bin": "gemini", "versionArgs": ["--version"], "helpArgs": ["--help"] },
    "launchFields": [
      { "id": "model", "label": "Model", "kind": "text", "argv": ["--model", "{value}"] }
    ],
    "capabilities": { "hooks": "unsupported", "headless.json": "unsupported" },
    "headless": "none"
  }]
}
```

Save it as `~/Library/Application Support/wanigan/provider-packs/local.gemini/provider-pack.json`,
choose **Learning → Providers → Refresh packs**, review the digest, trust it,
then enable it.
