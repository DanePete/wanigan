# Existing-feature audit repairs

Implemented the 16 defects and manual attachment-retention flow identified in the [audit](2026-09-15-existing-feature-audit.md). Changes preserve the pre-existing working tree and use the existing main/preload/renderer boundaries. No agent workload, provider request, production restore or production cleanup was run during implementation.

| Audit item | Implemented behavior | Main sources |
| --- | --- | --- |
| F01 · mobile freshness | Commit readings bind visible Git status to content, index and HEAD evidence. Unavailable comparisons refuse commits. Gate status uses persisted checkout and recipe evidence, including after restart. | [Mobile Git](../../src/main/mobile/git.ts), [review](../../src/main/review.ts) |
| F02 · branch verification | Shared verification refuses multiple distinct implementation checkouts before starting work. Approval rejects legacy ambiguous proofs and requires a current passing check for every implementation checkout. | [Control](../../src/main/control.ts) |
| F03 · generated-output backups | Format 2 includes nested session attachment files and generated outputs, with inventories and hashes. Restore verifies staged copies, preserves replaced artifacts, and rebases structured stored paths. Format 1 remains readable. | [Backup](../../src/main/backup.ts), [file verification](../../src/main/backup-files.ts) |
| F04 · isolated transcripts | Exit archival uses the effective worktree; transcript lookup also consults the recorded worktree. Exact/fallback provenance remains visible. | [Sessions](../../src/main/sessions.ts), [transcripts](../../src/main/transcripts.ts) |
| F05 · terminal replay | Snapshot arrival and xterm parsing are separate states. Post-snapshot output reaches the terminal while replay-generated outbound replies remain suppressed. | [Replay state](../../src/shared/terminal-replay.ts), [TerminalPane](../../src/renderer/src/components/TerminalPane.tsx) |
| F06 · schedule overlap | A durable fire owns work through child completion. Handoff passes its exact fire identity; reconciliation recovers recorded terminal outcomes and releases orphaned ownership. | [Schedule](../../src/main/schedule.ts), [headless execution](../../src/main/headless.ts) |
| F07 · stale-proof recovery | Completed verification offers “Rerun review gate”; the rerun updates that task's proof binding without weakening final approval. | [Control view](../../src/renderer/src/views/Control.tsx) |
| F08 · backup loss warning | Review starts, completions and recipe updates advance the evidence clock. The UI no longer treats a maximum timestamp as proof of complete database equivalence. | [Backup](../../src/main/backup.ts), [Settings](../../src/renderer/src/views/Settings.tsx) |
| F09 · signal exits | The normalized exit code is used consistently for live metadata, durable session history and exit broadcasts. | [Sessions](../../src/main/sessions.ts) |
| F10 · Codex account scope | The renderer sends session identity. Main resolves the frozen account and refuses missing or incompatible identity instead of using the current default. | [Main IPC](../../src/main/index.ts), [preload](../../src/preload/index.ts), [App](../../src/renderer/src/App.tsx) |
| F11 · MCP argument expansion | Templates are parsed into argv before project-path expansion. Spaces and literal quotes remain inside the intended argument, consistently in preview and launch. | [MCP registry](../../src/main/mcp/registry.ts) |
| F12 · queue cancellation | Canceling queued autopilot work synchronizes the owning task and clears its dispatch marker. Canceled tasks require deliberate reopen; the armed sweep does not immediately recreate canceled work. Legacy orphaned markers are reconciled. | [Queue](../../src/main/queue.ts), [Control](../../src/main/control.ts) |
| F13 · skill attribution | Attribution requires the session's provider, actual scope/root, matching applied content and unambiguous item identity. Namespaced, modified or ambiguous matches remain unattributed. | [Learning service](../../src/main/learning-service.ts) |
| F14 · plugin read failures | Failed or malformed installed-list responses carry an unavailable/error note, preserving the local-scan fallback. Only observed installed records determine enablement. | [Plugins](../../src/main/plugins.ts) |
| F15 · context provenance | Fallback readings are labeled unconfirmed and do not create selected-session pressure. Tooltips distinguish reported/assumed windows and include reading provenance. | [Status formatting](../../src/shared/provider-status.ts), [App](../../src/renderer/src/App.tsx) |
| F16 · repeated clock hour | Cron calculation advances real instants and never returns a past fire. Repeated wall-clock minutes fire once; spring gaps preserve the existing late-fire behavior. | [Cron](../../src/shared/cron.ts) |
| U01 · manual retention | Settings provides a saved age window, read-only preview, session selection, native confirmation and measured results. Main rechecks eligibility and pins the exact file receipt across confirmation. | [Attachment storage](../../src/renderer/src/components/AttachmentStorage.tsx), [attachments](../../src/main/attachments.ts) |

## Preservation and compatibility

- Cleanup remains manual and disabled by default. New staged session files record their original content hash. Referenced files, generated or changed files, live sessions, recent resume chains and older files without an original content hash are kept. Newly arriving files are never added to an approved deletion list. A changed receipt requires another preview.
- Format 1 backups do not contain session artifacts; restoring one retains the destination's existing attachment tree and the UI discloses the omission. Format 2 restores the included tree and moves the previous one aside with the previous database and transcripts.
- Backup copies reject links, special files, malformed/traversing manifest paths, altered bytes and files observed changing during a copy. Raw conversation text remains original evidence: absolute paths embedded in old prose are not rewritten during migration, even though structured archive and attachment paths are rebased.
- Multi-checkout integration is not synthesized. Separate checks can establish current evidence for individual branches; testing their combined result still requires an integrated checkout. Mobile content comparisons also do not lock out concurrent filesystem writers, and ignored files remain outside the documented checkout fingerprint.
- The current shell hides the mounted header usage badge. F10/F15 correct its component and API behavior without changing that layout. Its exposed-badge screenshots are explicitly labeled component fixtures.

## Regression coverage

The required `npm test` command covers typechecking, shared tests, renderer style, dead-code analysis, lint, package hooks, local installation fixtures and the offline main-process smoke suite.

Final verification on 2026-09-15: `npm test` exited successfully with all eight gates passing, including 75 shared tests and 1,716 smoke assertions (zero failures). The final backup/retention UI probe passed all four checks with no renderer errors. Before/after screenshots cover both themes; the final retention screenshots were visually inspected. `git diff --check` also passed.

Added focused coverage includes:

- [Control smoke](../../src/main/smoke-audit-control.ts): ambiguous and uncovered branches, historical proof refusal, completed-verifier rerun, queue cancellation, durable schedule ownership and exact fire identity.
- [Integration smoke](../../src/main/smoke-audit-integrations.ts): same-status content changes, index/HEAD changes, persisted gate freshness and scope, immediate running receipts, MCP argv, skill attribution and plugin failures.
- [Backup smoke](../../src/main/smoke-audit-backup.ts): generated output, tampered files, path traversal, links, legacy manifests, review clocks, content-pinned cleanup, a real temporary restore, preserved replaced artifacts and relocated structured paths. This phase runs last because restore closes the database.
- [Cron tests](../../src/shared/cron.test.ts), [replay tests](../../src/shared/terminal-replay.test.ts), and [context tests](../../src/shared/provider-status.test.ts) cover pure contracts. Existing session smoke now covers isolated archives and normalized exit wiring.
- The real-xterm probe exercises post-snapshot input ordering and reply suppression. Separate current-source fixtures validated main's selected-account routing and signal persistence without provider calls.

UI evidence uses isolated Electron or offline mobile fixtures. Both themes are recorded for [Control, backup and retention](../visuals/existing-feature-fixes-2026-09-15/README.md), [session evidence](../visuals/session-evidence-2026-09-15/README.md), and [mobile freshness](../visuals/audit-fixes-mobile-2026-09-15/README.md). Synthetic screenshot data is distinct from the real Git/SQLite/filesystem smoke checks.

## Integration with remote work

The subsequent push found 15 newer commits on `origin/main` through `7ec7e49`. Their features were merged with these repairs, including rebindable shortcuts, worktree setup, stop-triggered verification, pinned attempts, review feedback, GitHub intake, publish checks and observed telemetry.

The two attachment-retention implementations had incompatible consent behavior. The merged application retains selected, confirmed manual cleanup and the remote measured-result record; saving an age window does not activate automatic deletion. The duplicate timer and unconfirmed legacy deletion channel were removed. Exact scheduled-fire identity is passed separately from a pinned attempt, and new gate consumers must respect checkout freshness before presenting a passing result.

Merged verification: the complete `npm test` command passed all eight gates with 349 shared tests and 2,162 smoke assertions, zero failures. The new attempt regression finishes two trials whose successful commands change the checkout; neither counts as a verified pass. Five isolated renderer probes passed 25 checks with no errors, refreshed after screenshots in both themes, and retained the original before images. Scoped probe lint and staged whitespace checks passed.
