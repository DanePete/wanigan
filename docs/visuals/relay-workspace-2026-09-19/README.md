# Relay workspace visual review · 2026-09-19

The active relay now leads with its recorded stage, the next action, and inspectable evidence. Creating another relay is a separate composer. A direct relay draws its three recorded stages instead of placing their data in a fixed five-stage diagram. Unknown forecast cost remains unpriced.

## Compare

| View | Before | After |
| --- | --- | --- |
| Standard relay, dark | [Before](before/standard-dark.png) | [After](after/standard-dark.png) |
| Standard relay, light | [Before](before/standard-light.png) | [After](after/standard-light.png) |
| Direct relay, dark | [Before](before/direct-dark.png) | [After](after/direct-dark.png) |
| Direct relay, light | [Before](before/direct-light.png) | [After](after/direct-light.png) |
| Empty composer, dark | [Before](before/empty-dark.png) | [After](after/empty-dark.png) |
| Empty composer, light | [Before](before/empty-light.png) | [After](after/empty-light.png) |
| 900px layout, dark | [Before](before/narrow-dark.png) | [After](after/narrow-dark.png) |
| 900px layout, light | [Before](before/narrow-light.png) | [After](after/narrow-light.png) |
| Real Electron, no project, dark | [Before](before/real-empty-dark.png) | [After](after/real-empty-dark.png) |
| Real Electron, no project, light | [Before](before/real-empty-light.png) | [After](after/real-empty-light.png) |

Additional after views: [720px navigator](after/narrow-720-light.png), [stage inspection](after/verify-details-dark.png), [review decisions](after/review-light.png), [recorded rejection](after/rejected-dark.png), [composer](after/create-light.png), [expanded route overrides](after/create-overrides-dark.png), and [reduced motion](after/reduced-motion-light.png). Each has a corresponding other-theme image.

The original standard fixture deliberately has a known duration and an unknown total price. Its before image shows the defect directly: the action copy says `$0.00` while the forecast cost is `—`. The after action and forecast both say unpriced.

## Verification

The coordinated shared-tree `npm test` passed on 19 September 2026 under
Node 22.23.2: all eight gates, 533 shared tests, six asynchronous credential
scenarios, and 2,341 Electron smoke assertions with zero failures. The fresh
production build and `git diff --check` also passed.

`node scripts/probe-relay-workspace.mjs --electron` exercises:

- The initial action fits the desktop viewport; opening and inspecting a relay does not mutate it.
- Stage buttons support keyboard inspection and returning to the current stage. Direct relays have exactly three matching stage labels and vessels.
- Reduced motion selects the still tier and disables content entrance animation. The 900px and 720px layouts fit without page overflow. The selected stage remains fully visible in the horizontal navigator, including keyboard Home/End navigation.
- Session changes establish a new grain baseline. Newly recorded activity settles once; a count that falls and rises does not replay old grains.
- A late relay read cannot replace a newer selection. Pending and failed selections expose no previous relay actions. Failed reads can be retried. A delayed list from another project cannot overwrite the current project.
- A recorded rejection displays its final outcome without offering a generic reopen action.
- Canceling creation restores focus and retains the draft. Changing route overrides clears the old suggestion. Pending preview and creation lock the relay picker.
- Creating records the chosen relay account, per-stage override, and explicit opt-out from inheritance. It does not call session start. Account lookup failure prevents creation until a successful explicit retry.

The updated account compatibility probe checks relay-level and per-stage account serialization in both themes. The suggestion compatibility probe checks accepted suggestions, below-threshold suggestions, omitted stages, and confidence indicators in both themes.

The fixture's completed verification stage includes a passing proof, and only agent stages carry synthetic tool completions. All fixture paths, titles, account labels, and evidence are generic examples.

## Scope and reproduction

Real empty screenshots use the built Electron application, its real preload bridge, and a temporary isolated user-data directory that is removed afterward. No session launch, routing suggestion, or model request was performed in that application. Earlier navigation attempts ran before the shell was ready; awaiting `.app-header` before using the Relay shortcut resolved the capture problem.

The requested real-Electron capture is a required check: a launch or capture failure records `passed: false` in `real-electron.json` and fails the probe, including `--electron-only`. The final capture records `passed: true`.

Populated screenshots and interaction checks use the real built renderer in Chromium with a synthetic preload bridge. They establish DOM behavior and layout, not provider execution, IPC validation, persistence, or a successful agent workflow. The main probe uses the simple water tier and the still tier; it does not claim a GPU fluid simulation was exercised. An unavailable WebGPU adapter warning from the unrelated orb is excluded from renderer-error counts.

```sh
nvm use
npm run build
node scripts/probe-relay-workspace.mjs --electron
node scripts/probe-relay-account.mjs --out docs/visuals/relay-workspace-2026-09-19/compatibility-account
node scripts/probe-relay-guess.mjs --out docs/visuals/relay-workspace-2026-09-19/compatibility-guess
```

`--before` captures the baseline from the renderer currently built in `out/`; it must be run before building a changed renderer. `--electron --electron-only` captures only the isolated real application. Structured results live in [after/verification.json](after/verification.json) and [after/real-electron.json](after/real-electron.json). The repository's `npm test` gate remains separate from these visual probes.
