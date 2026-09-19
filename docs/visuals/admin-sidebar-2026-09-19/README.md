# Admin-bar sidebar return

The dock redesign removed the upper-left sidebar opener. Restored a labeled
**Sidebar** button beside Wanigan; **Tools** remains available in the dock.
Both use the existing navigation state and shortcut. The header remains the
stable focus fallback when navigation closes.

Before screenshots use the renderer from `703c46c`. All screenshots use the
production renderer with fictional bridge records.
They do not show live accounts, sessions, or provider results.

| State | Light | Dark |
| --- | --- | --- |
| Before, 1440×960 | [Before](before/closed-1440x960-light.png) | [Before](before/closed-1440x960-dark.png) |
| After, 1440×960 | [After](after/closed-1440x960-light.png) | [After](after/closed-1440x960-dark.png) |
| Before, minimum native 900×560 | [Before](before/closed-900x560-light.png) | [Before](before/closed-900x560-dark.png) |
| After, minimum native 900×560 | [After](after/closed-900x560-light.png) | [After](after/closed-900x560-dark.png) |
| Open, desktop | [After](after/open-desktop-light.png) | [After](after/open-desktop-dark.png) |

`node scripts/probe-admin-sidebar.mjs` failed against the frozen previous
renderer because the admin bar had zero sidebar openers. It passes against
the correction: desktop visibility, open/closed preference across reloads,
both openers, focus return, keyboard shortcut, and compact drawer behavior.
Seven viewport sizes from 460 to 1440 pixels have no document overflow or
overlapping header groups. The label stays visible at native window sizes;
at 720 pixels and below the named panel icon remains visible.

The existing navigation-return and isolated Electron dock probes also pass.
Their reports and screenshots are in `navigation-return/` and `dock/`.
The footer remains 64 pixels tall, or 56 in short windows.

The full `npm test` suite passed, including 2,701 smoke checks and the execution
recovery suites. `git diff --check` passed.
