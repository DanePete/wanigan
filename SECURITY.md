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
the paired browser, and revocable from Settings. That credential, the random
ntfy topic, Wanigan's VAPID keypair and every Web Push subscription are
encrypted at rest through Electron's OS credential storage. If that storage
becomes unavailable or an existing blob cannot be decrypted, the listener and
both push senders pause instead of silently minting replacement credentials. A
Tailscale Serve mapping is configured and removed separately; disabling
Wanigan's listener does not remove that proxy.

Alerts are two independent channels, and both carry only the notification
title, project name, attention state and waiting time. Neither includes prompt
text, hook summaries, commands, paths, transcript content or terminal output.

Web Push alerts go to the installed Wanigan Remote app. The channel is enabled
by default and sends nothing until a device subscribes, which requires that
device to be already paired, a deliberate action on it, and its own
notification permission. The payload is encrypted to that device under RFC 8291
(`aes128gcm`, ECDH P-256, per-message ephemeral keys), so the push service
relays ciphertext; what it can observe is the subscription endpoint and the
time an alert was sent. A subscription's endpoint and keys are a capability to
place a notification on that device and are never returned over the API, to any
device, or to the renderer. Endpoints are validated as HTTPS before Wanigan
will POST to one. Forgetting a device stops sending to it but does not cancel
the browser's subscription, and that browser re-registers on its next launch;
replacing the VAPID keypair is the revocation that holds, because a
subscription is cryptographically bound to the key it was created with. A `404`
or `410` from the push service deletes the stored subscription.

Opt-in ntfy alerts disclose the same fields, in plaintext, to the configured
ntfy host. The host is included in Settings' egress report, as is every push
service host a device has actually subscribed through — read from the stored
subscriptions rather than assumed, because the destination is chosen by the
device's browser. Remote approval and arbitrary terminal input are
intentionally not implemented. Replacing the local ntfy topic does not revoke
the old topic at the configured ntfy service.

Opt-in paired iPad control additionally exposes the selected session's terminal
scrollback and allows a bounded launch/next-instruction/interrupt action,
limited to 20 actions a minute. Terminal output is not redacted and can contain
repository paths, prompt text, command output, or secrets printed by an agent;
pair only devices you trust. It cannot approve permissions, browse files,
change settings, or receive arbitrary PTY keystrokes.
