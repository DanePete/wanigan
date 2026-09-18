# Writing a Wanigan extension

A Wanigan extension is a bundle of **declarations** across surfaces that
already exist: MCP servers, skills, review gates, instructions. It is never a
place to load code. Nothing an extension ships runs inside Wanigan's process.
An extension that needs to compute something does it behind a protocol Wanigan
already speaks out of process — an MCP server, or a provider pack's v1
capability adapter.

That rule is the whole design, and it was chosen rather than conceded. An
extension host that loads JavaScript into the app hands its author the
operator's keychain, their session transcripts, every repository they have
opened and the renderer's IPC surface, and reviewing such an extension means
reviewing arbitrary code — which nobody does, for anything. An extension that
can only declare is reviewable by reading it. The install dialog can list every
command that will run on the machine and every host that will be reached,
because those are the only things an extension is able to ask for. This is what
makes installing a stranger's extension a decision a person can actually make.

## Why "extension" and not "plugin"

"Plugin" is taken. Wanigan's Plugins view reads Claude Code's plugins out of
`~/.claude` and shows them to you; those are Claude Code's, not Wanigan's, and
Wanigan does not install them. Two meanings of one word in one window is a
question nobody can answer from the screen, so the thing you are about to write
is an extension and the word plugin is left alone.

## Your first extension: save the one you already have

You do not have to start from this document. Wanigan can write your current
configuration out as an extension directory — the MCP servers you have already
added and trusted, your review commands, your skills — with **Save as
extension**. It produces a real directory with a real `wanigan-extension.json`
in it, marked with origin `export`, which you can open, edit, rename, commit to
a git repository and hand to somebody else.

This is the easiest way to make an extension and it needs no spec. Do that
first, read what it wrote, and come back here for the rules it was obeying.

## The manifest

One file, `wanigan-extension.json`, at the root of the extension directory.

```json
{
  "schemaVersion": 1,
  "id": "acme.figma",
  "label": "Figma",
  "version": "1.0.0",
  "description": "Figma design context for agents, plus a handoff skill.",
  "publisher": { "id": "acme", "name": "Acme", "url": "https://example.com" },
  "requires": { "wanigan": ">=0.1.0" },
  "credentials": [{ "id": "acme.figma", "label": "Figma personal access token",
                    "help": "Create one at figma.com → Settings → Personal access tokens." }],
  "provides": {
    "mcpServers": [{ "name": "figma", "transport": "stdio", "command": "npx",
                     "args": ["-y", "figma-mcp"], "scope": "global",
                     "env": { "FIGMA_TOKEN": { "source": "credential", "id": "acme.figma" } } }],
    "skills": [{ "name": "figma-handoff", "file": "skills/figma-handoff/SKILL.md" }],
    "gates": [{ "label": "Design tokens in sync", "commands": ["npm run tokens:check"] }],
    "instructions": [{ "scope": "project", "title": "Figma conventions", "file": "docs/figma.md" }]
  }
}
```

`schemaVersion` is `1`. `label` is what a person sees in the Extensions list;
`id` is what Wanigan stores rows against and what uninstall matches on.
`publisher` and `description` are shown at install so the operator knows who is
asking. `requires.wanigan` is the minimum Wanigan version — an extension that
names a version newer than the running app is refused with that as the reason,
rather than installed into an app that has no surface for half of it.

`credentials` declares the secrets the extension needs and nothing else. The
label and help text are what the operator reads when Wanigan asks for the
value. The value itself goes into Wanigan's encrypted credential store, which
is the OS keychain by way of Electron `safeStorage`; it is never written into
the extension directory, never shown back in a dialog, and never printed in a
consent screen. Consent shows the destination and the id, not the secret.

Everything under `provides` is optional. An extension that declares only an
MCP server is a normal extension.

### The naming rules, and what each one prevents

**Extension, publisher and credential ids** match
`^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`. Lowercase, starting with a letter,
segments joined by `.`, `_` or `-`. It is the same id shape provider packs use,
for the same reason: an id folds to a file name and a database key, and an id
containing a slash, a space or a leading dot is a row you cannot address and a
path you did not mean to write.

**Versions** are `major.minor.patch`, three integers. Not `v1.0`, not
`1.0.0-beta.2`. The version is how Wanigan tells an update from a reinstall and
prints "1.0.0 → 1.1.0" in the dialog; a version it cannot order is a version it
cannot say anything true about.

**An MCP server name** matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. The name is
not cosmetic: it becomes part of the tool id the agent sees, `mcp__<name>__<tool>`,
and the key in the generated MCP config. A space or a dot produces a server the
agent can list and never call, which looks like a broken server and is actually
a broken name.

**A credential id must be the extension's own id, or begin with the extension's
id and a dot.** `acme.figma` may declare `acme.figma` and `acme.figma.admin`.
It may not declare `initech.stripe`. The credential store is one flat id space,
so without this rule a manifest could name somebody else's credential, put it
in an environment variable of its own choosing, and hand it to a host of its
own choosing. The leak there is not that a key exists — it is the rename.
Provider packs refuse the same thing at validation, and extensions inherit the
rule rather than reinventing it.

**Environment destinations may not be loader or injection variables**, and may
not be Wanigan's own namespace. Refused: `NODE_OPTIONS`, `NODE_PATH`,
`LD_PRELOAD` and anything else starting `LD_`, `DYLD_*`, `PYTHONPATH`,
`PYTHONSTARTUP`, `BASH_ENV`, `ENV`, `RUBYOPT`, `PERL5OPT`,
`JAVA_TOOL_OPTIONS`, `DOTNET_STARTUP_HOOKS`, `PROMPT_COMMAND` and their
relatives, plus `WANIGAN_*`, `OTEL_*` and `ELECTRON_*`. The first group turns
"set an environment variable for this server" into "run my code inside whatever
that server's command happened to be" — the extension model's one promise,
undone by a config field. The second group is Wanigan's own controls: telemetry
destinations and privacy settings are not an extension's to set. This refuses
known shapes. It is not proof that every other variable name is harmless.

**`file` paths are relative to the extension directory and may not contain
`..`.** The installer resolves the real path and checks that it is still inside
the directory, so a symlink pointing at `~/.ssh/id_ed25519` is refused rather
than read, copied and published as a skill.

### There is deliberately no denylist on MCP commands

Provider packs refuse `sh`, `node`, `python`, `npx` and the rest as launch
executables, because a provider manifest is supposed to name an installed agent
CLI and a shell in that slot is unsigned glue. MCP servers are the opposite
case. `npx -y some-mcp`, `node ./server.js` and `python -m mcp_server` are what
real MCP servers are; a denylist would refuse nearly all of them, and the
authors of the rest would learn to write a two-line wrapper script that gets
past it. A control that teaches people to route around it has made things
worse, and it would let Wanigan claim a safety it does not have.

The honest control is the consent screen. It shows the exact command and every
argument, one per line and never joined — because a single argument containing
a space reading as two is the one distinction a reviewer of a command line has
to be able to make — plus every environment destination and every credential
the server will be handed. Trust is then pinned to the sha256 of the manifest
bytes. You approve a specific command line, not a category.

## What installing actually does today

Installing an extension **applies MCP servers only.**

Skills, gates and instructions are parsed, validated, counted and listed on the
extension's card with `applied: false` and a note naming exactly what they
still need. They are not silently dropped, and they are never counted as
installed.

- **Gates** run shell commands on the operator's machine. A gate becomes a
  project review recipe, and Wanigan already asks before a review recipe is
  saved — the consent sits where the capability is made, because the text is
  written once and run many times, from `review:run` and from a goal's verify
  task. Routing extension gates through that existing question is the work that
  is not done yet; inventing a second, quieter path for them is the thing not
  to do.
- **Skills and instructions** are files in someone's home directory or
  repository. Wanigan writes provider files through one projection path that
  records the base hash of what was there, applies atomically and only inside
  an explicit root, and can undo only while the applied hash still matches.
  Extension-supplied skills and instructions have to go through that path, and
  do not yet.

Partial support is reported rather than faked because the alternative is worse
in both directions. An extension that quietly dropped its three non-MCP
declarations would leave you debugging a skill that was never written. An
extension that claimed to install a gate by writing commands into a project
without asking would be running a stranger's shell commands on the strength of
a JSON file. The card tells you which of your four declarations is live, and
the note tells you why the other three are not.

## The authoring loop

Wanigan's CLI runs the app binary headlessly — `better-sqlite3` is compiled
against Electron's V8 ABI, so a plain `node` script cannot load it.

```
npm run cli -- extension-init <dir>        # write a skeleton extension
npm run cli -- extension-validate <dir>    # every error, not the first
npm run cli -- extension-preview <dir>     # the exact consent screen
```

`extension-validate` prints every error it found, not the first, because
fixing a manifest one round-trip per mistake is how people give up.

`extension-preview` is the one to run before you publish anything. It prints
the consent screen a user will be shown at install, generated by the same
function the app renders — the same lines, in the same order, with the same
clipping. You read "this will run `npx -y figma-mcp` with your Figma personal
access token" in your own terminal, about your own extension, before anyone
else reads it about theirs. If that sentence is more alarming than you expected
your extension to be, that is information you wanted while you could still
change the manifest.

The validator, the installer and the install dialog all read one definition of
what a valid extension is, in `src/shared/extension-manifest.ts`. Three copies
would be three answers to a question that has to have one.

## Install, trust and updates

Trust is pinned to the sha256 of the manifest bytes.

Wanigan inspects the directory, shows the consent screen, and — when the
operator accepts — installs while passing back the digest that was displayed.
If the manifest changed between the dialog opening and the button being
clicked, the digest no longer matches and the install is refused instead of
proceeding with a manifest nobody saw. The dialog is drawn by the renderer, and
a renderer that has been compromised can simply decline to draw it; the digest
check is what makes that decline fail closed.

An edited manifest is an untrusted manifest. Change a command, add an argument,
add a credential, fix a typo in the description — the bytes change, the digest
changes, and the extension shows `needs-trust` until the operator approves it
again. There is no partial re-approval, because a diff between two manifests is
not the question; what will run on the machine is.

Updating is installing a newer version of the same id. It is a fresh consent
screen with fresh bytes and a fresh digest, and the dialog says update rather
than install because Wanigan already has the installed version to compare.

## Uninstall

Uninstalling removes only the rows the extension owns **whose live shape still
matches what it installed.**

A row you have edited since — you changed the arguments, added an environment
variable, moved it from global to one project — is kept, counted, and named on
screen as kept. Wanigan will not silently revert your own change.

This is not politeness. An uninstall that quietly reverts edits is an uninstall
people stop performing, and an extension nobody dares uninstall is worse than
one they never installed. Ownership is recorded per artifact at install time
for exactly this: without attribution, removing an extension is a guess about
which rows were its, and a guess here deletes somebody's working MCP server.

If you want a kept row gone, delete it yourself from the surface that owns it.
Wanigan names each one so you know what is left.

## Publishing

An extension is a directory in a git repository. That is the distribution
mechanism.

Wanigan has no hosted registry, no marketplace, no search, and no update feed.
There is no `wanigan install acme.figma`. People get your extension by cloning
or downloading the repository and pointing Wanigan at the directory, and they
get your update by pulling and installing again. Put the extension at the
repository root, or in a subdirectory with the path in your README; both work,
because the install takes a directory.

Version your manifest honestly, keep a changelog if the extension does anything
anyone might need to bisect, and remember that every install is a consent
screen someone read. Publish the extension you would approve.

## What Wanigan promises, and what it does not

Wanigan promises to validate the manifest's shape, to show you everything the
extension declares before anything is installed, to pin that approval to the
exact bytes you saw, to name every declaration it could not apply, and to keep
your edits when you uninstall.

Wanigan does not review what a server does once it runs. An MCP server is a
process on your machine, started by your agent's CLI, with whatever credential
you gave it and whatever network access your machine has. Wanigan can tell you
that `npx -y figma-mcp` will be executed and that your Figma token will be in
its environment. It cannot tell you what `figma-mcp` does with that token, it
does not audit the package, and the package can change under the same command
line at the next `npx` run. The process boundary here is not a sandbox and is
not described as one.

So: approve a command you would run by hand, from a publisher you would give a
token to. The consent screen exists to make that judgement possible, not to
make it unnecessary.

## A worked example

`examples/extensions/figma-handoff/` is the manifest in this document as a
complete, valid extension directory: a manifest, a skill, and the instructions
file the manifest points at. Copy it, change the ids, and run
`extension-preview` on it.
