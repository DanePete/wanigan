# Security policy

Please report vulnerabilities privately to security@deadnorth.io. Do not open a public issue for a suspected vulnerability or include proof-of-concept exploit details in one.

Include the Wanigan version, macOS version, a minimal reproduction, and whether the issue requires a malicious repository, MCP server, plugin, or renderer content. We will acknowledge reports within five business days and coordinate disclosure after a fix is available.

Wanigan deliberately runs coding agents with access to local repositories. Its trust levels and policy ledger are defence in depth, not a substitute for OS-level containment.

## Phone monitor boundary

Phone monitoring is off by default. Its dashboard is a separate HTTP service
bound to `127.0.0.1`; none of Wanigan's hook, telemetry, MCP, renderer IPC,
transcripts or file APIs are exposed. Monitoring alone is read-only; the
separate paired-control opt-in described below is not. A private reverse proxy
such as Tailscale Serve is required to carry it off the machine. Fleet data is
behind a random bearer credential passed in the pairing URL fragment, stored by
the paired browser, and revocable from Settings. The credential and the random
ntfy topic are encrypted at rest through Electron's OS credential storage. If
that storage becomes unavailable or an existing blob cannot be decrypted, the
listener and push sender pause instead of silently minting replacement
credentials. A Tailscale Serve mapping is configured and removed separately;
disabling Wanigan's listener does not remove that proxy.

Opt-in ntfy alerts disclose their title, project name, attention state
and waiting time to the configured ntfy host. They do not include prompt text,
hook summaries, commands, paths, transcript content or terminal output. The
configured host is included in Settings' egress report. Remote approval and
arbitrary terminal input are intentionally not implemented. Replacing the
local ntfy topic does not revoke the old topic at the configured ntfy service.

Opt-in paired iPad control additionally exposes the selected session's terminal
scrollback and allows a bounded launch/next-instruction/interrupt action,
limited to 20 actions a minute. Terminal output is not redacted and can contain
repository paths, prompt text, command output, or secrets printed by an agent;
pair only devices you trust. It cannot approve permissions, browse files,
change settings, or receive arbitrary PTY keystrokes.
