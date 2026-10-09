# Security

## Reporting a problem

Please don't open a public issue for a security problem. Report it privately
from this repository's **Security** tab › **Report a vulnerability**, with the
steps to reproduce it and your macOS, Claude Code and Codex versions.

Wanigan 2 is in beta and maintained by one person. You'll get a reply as soon as
I can, and credit in the fix if you want it.

## What Wanigan protects

- **The core is local.** It listens on a Unix socket in a data folder only your
  user can open (mode `0700`), and the socket itself is `0600`.
- **Phone access is optional.** Off by default, it starts a separate HTTP
  gateway on `127.0.0.1:47832` when enabled. Its optional Tailscale mount
  exposes `/wanigan` over HTTPS on your private network. The setting persists
  across core restarts.
  A single-use pairing code grants a device token; phone methods have an
  explicit allowlist, and acting requires that phone's **Can act** permission.
  Account list metadata is readable; account changes, settings, Git, keys and
  pairing management are not available to phones. Forgetting a phone blocks
  token authentication and closes its event streams. After reading an RPC body,
  the gateway rechecks the current token and Can act permission immediately
  before dispatch. A held request cannot retain permission revoked while its
  body arrived. Work already dispatched may continue after revocation.
- **Every caller has a token.** The window holds the owner's token. Each session
  gets its own, and the `wanigan` command in that session can act only as that
  session, inside its project, using the methods marked `session` in
  `ACCESS` in `src/shared/protocol.ts`. The owner and paired phones allowed to
  act can approve a card; an agent session cannot.
- **The window is untrusted.** It reaches the core only through
  `window.wanigan`, can call only owner methods, and the core validates what it
  sends.
- **Keys stay put.** A TypeSafe key for Jev is saved readable by your user only
  and is never sent back to the window. Account discovery checks filenames;
  sign-in checks ask each CLI who is signed in, without reading or copying
  Claude Code or Codex sign-in credential files.
  Gemini setup reads the owner's Gemini settings and trusted-folder metadata
  and never writes back to them. Into Wanigan's own Gemini home it copies the
  selected sign-in method, the trusted folders, the MCP servers that hold
  nothing that could be a credential (every `env` and header value an
  environment-variable reference such as `$TOKEN`, nothing key-like in a
  command line, address or other setting; when in doubt a server is left out
  and the MCP view says why, without the value), the names in `mcp.allowed`,
  `mcp.excluded` and the servers switched off; and it links to the owner's
  skill folders. It does not copy Gemini credential files or any value that
  looks like a key, token or password.
  MCP configuration values are read for the owner's display. Owned fixtures
  verify masking of literal fallback values in arguments, environment values,
  headers, HTTP targets and CLI diagnostics, including the tested one-layer
  encoded targets. Masking remains heuristic: unrecognized forms and encodings
  can remain visible. Do not rely on this display as a universal secret filter.
- **Plugin data paths are checked in the core.** Selected plugin manifests,
  MCP JSON and Skills directories are checked against the installed plugin
  root before reads or enumeration. Unsafe selected data remains unknown or
  is omitted with a note; healthy peers remain. Deliberate personal/project
  links are supported. Canonical checks do not provide an atomic filesystem
  transaction or exclusion of arbitrary concurrent writers.
- **Permission prompts show what is really asked.** The exact command, with
  hidden and lookalike characters spelled out. The decision is still yours.

## What it does not protect

- **Agents run as you.** Claude Code, Codex and Gemini CLI have your permissions, as
  in your own terminal. Wanigan watches and records them; it does not sandbox
  them.
- **A phone allowed to act can run work as you.** It can start sessions and
  type into terminals. Protect the paired device and your Tailscale access;
  the method allowlist is not a sandbox for commands sent to a terminal.
- **Anything already running as your user** can read Wanigan's data folder and
  talk to its core. Wanigan is not a boundary against your own account.
- **The app is not notarized.** A build you make yourself is signed ad hoc on
  your Mac. Build from source you have read, or check a download against its
  published SHA-256.
