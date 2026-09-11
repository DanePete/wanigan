# Settings workspace · desktop redesign

Settings now uses a fixed category directory beside one continuous preferences
surface. All seven categories remain mounted, so switching categories preserves
unfinished forms and each category's scroll position. This continues the
[desktop direction](../desktop-workspaces/README.md).

The directory searches the same section index as the command palette. Search
results and section shortcuts lead to the exact section and move keyboard focus
there. Category tabs retain arrow keys, Home/End, and roving focus. At a narrower
desktop width the directory becomes a horizontally scrollable tab row.

Agents starts with installed runtimes and accounts, followed by packs and keys.
General guidance and detailed credential instructions use disclosures. Existing
validation, explicit saves, trust controls, and action confirmations remain in
their original handlers.

Appearance has three miniature window previews for System, Light, and Dark,
using the existing theme persistence callback. The chooser shows a pending save,
disables its choices while saving, and reports a failure while the app restores
the previous theme. Motion choices are compact, with one brief category reveal,
press feedback, and appearance selection feedback. Off and system Reduce Motion
remove that movement; Full is the existing explicit override.

## Screenshots

| Category | Before | After |
| --- | --- | --- |
| Agents | [Dark](before/agents-dark.png), [light](before/agents-light.png) | [Dark](after/agents-dark.png), [light](after/agents-light.png) |
| Projects & safety | [Dark](before/projects-dark.png), [light](before/projects-light.png) | [Dark](after/projects-dark.png), [light](after/projects-light.png) |
| Automation | [Dark](before/automation-dark.png), [light](before/automation-light.png) | [Dark](after/automation-dark.png), [light](after/automation-light.png) |
| Connections | [Dark](before/connections-dark.png), [light](before/connections-light.png) | [Dark](after/connections-dark.png), [light](after/connections-light.png) |
| Privacy & data | [Dark](before/privacy-dark.png), [light](before/privacy-light.png) | [Dark](after/privacy-dark.png), [light](after/privacy-light.png) |
| Backup | [Dark](before/backup-dark.png), [light](before/backup-light.png) | [Dark](after/backup-dark.png), [light](after/backup-light.png) |
| App | [Dark](before/app-dark.png), [light](before/app-light.png) | [Dark](after/app-dark.png), [light](after/app-light.png) |

Each category also has `after/<category>-narrow-<theme>.png` at an 820px desktop
window width. These are captures of the actual renderer in isolated Electron,
with synthetic services. They are layout and interaction evidence, not claims
about real account availability, agent performance, or production persistence.
The original before captures override the rendered palette independently of the
stored theme choice; the after captures keep those two values in agreement.

## Verification

`node scripts/probe-settings-workspace.mjs` records seven behaviour groups in
[verification.json](after/verification.json): category visibility, draft and
explicit-save behaviour, exact search destinations and scroll retention,
keyboard navigation, theme saves and rollback, reduced motion, and narrow
desktop layout. The final run recorded no renderer errors or horizontal panel
overflow across all seven categories in both themes. The account fixture is an
explicit empty list, so an unknown placeholder cannot invent a default account.

The required `npm test` passed all five stages, including **1,541 offline smoke
assertions**. The old source assertion for the removed private section-link
class was retired; the renderer probe verifies the destination and focus of the
replacement shared buttons. `git diff --check` passed.

No live agents, credentials, user repositories, model calls, or production
preferences are used by the probe. The existing demo workspace changes in the
working tree were preserved; demo-mode research was stopped when the task
returned to the redesign.

Both Mac architectures were packaged and passed strict sealed signature,
ASAR-integrity, hardened-fuse and executable PTY-helper verification. The arm64
bundle was installed into `/Applications/Wanigan.app` and relaunched. Its archive
hash matches the verified build. Native accessibility and screenshot inspection
confirmed the new Settings directory, the Agents category with real records,
and the App appearance controls. The app was left on Settings → App.

[Package and installation evidence](build-verification.json) records the hashes
and the native observations. Native inspection did not change theme, motion,
accounts, credentials or demo mode; save and rollback tests used only fixtures.
