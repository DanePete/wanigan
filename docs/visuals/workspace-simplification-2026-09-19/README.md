# Workspace simplification

These captures use Wanigan's production renderer in an isolated Electron
profile with explicitly fictional records. They verify layout and renderer
interactions, not live agent execution. No real session input or check command
was sent. The JSON reports alongside the images record the checks and build
identity.

| Surface | Before | After |
| --- | --- | --- |
| Sessions, dark | [Before](before/sessions-1440x1000-dark.png) | [Organized sidebar](after/sessions-1440x1000-dark.png) · [Hidden sidebar](after/sessions-navigation-hidden-1440x1000-dark.png) |
| Sessions, light | [Before](before/sessions-1440x1000-light.png) | [Organized sidebar](after/sessions-1440x1000-light.png) · [Hidden sidebar](after/sessions-navigation-hidden-1440x1000-light.png) |
| Session review, dark | [Before](before/session-review-1440x1000-dark.png) | [Changes](after/session-review-1440x1000-dark.png) · [Checks & evidence](after/session-review-checks-1440x1000-dark.png) |
| Session review, light | [Before](before/session-review-1440x1000-light.png) | [Changes](after/session-review-1440x1000-light.png) · [Checks & evidence](after/session-review-checks-1440x1000-light.png) |
| Compact navigation | [Dark](before/navigation-960x560-dark.png) · [Light](before/navigation-960x560-light.png) | [Dark](after/navigation-960x560-dark.png) · [Light](after/navigation-960x560-light.png) |
| Command search | [Dark](before/command-palette-1440x1000-dark.png) · [Light](before/command-palette-1440x1000-light.png) | [Dark](after/command-palette-1440x1000-dark.png) · [Light](after/command-palette-1440x1000-light.png) |

In the 1440-pixel Sessions fixture, hiding navigation increases the terminal
width from 984 to 1192 pixels. The interaction probe checks that the same xterm
element and unsent composer draft survive that change. This measures usable
space, not productivity or agent performance.

[Audit and design decisions](../../workspace-simplification-2026-09-19.md)
· [Renderer verification](after/verification.json)
· [Existing navigation regression checks](navigation-regression/verification.json)
