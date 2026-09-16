# Control, backup and retention repair captures

Before/after captures use the actual renderer in isolated Electron windows with synthetic services. They do not exercise production deletion or restore. The main-process smoke suite separately verifies real temporary backups/restores and cleanup eligibility.

| Surface | Before | After |
| --- | --- | --- |
| Completed verification | [Dark](before/control-completed-verify-dark.png) · [Light](before/control-completed-verify-light.png) | [Dark](after/control-completed-verify-dark.png) · [Light](after/control-completed-verify-light.png) |
| Manual attachment retention | [Dark](before/attachment-retention-dark.png) · [Light](before/attachment-retention-light.png) | [Dark](after/attachment-retention-dark.png) · [Light](after/attachment-retention-light.png) |
| Generated files in backups | [Dark](before/backup-artifacts-dark.png) · [Light](before/backup-artifacts-light.png) | [Dark](after/backup-artifacts-dark.png) · [Light](after/backup-artifacts-light.png) |
| Legacy backup inspection | [Dark](before/backup-legacy-dark.png) · [Light](before/backup-legacy-light.png) | [Dark](after/backup-legacy-dark.png) · [Light](after/backup-legacy-light.png) |

`scripts/probe-control-recovery.mjs` checks the completed-task rerun action, refusal without invented evidence and the exact task receiving the rerun. `scripts/probe-backup-retention.mjs` checks preview/save/selection, cancellation, measured cleanup output, surfaced errors and legacy-backup disclosure. Both scripts accept `--before` using the temporary saved baseline renderer; normal runs use the current build. They use Node 22.23.2.

Results are recorded in `after/control-verification.json` and `after/backup-retention-checks.json`. Screenshot fixtures do not substitute for the typed IPC and filesystem checks in the full suite.
