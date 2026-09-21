# Relay automation visual evidence

Captured from real, built Electron windows with temporary user data, the real typed preload API and a separate temporary provider-pack directory. Motion was disabled for capture. No agent was started, no key was saved, no pack was trusted and no model inference was requested.

The before build is the isolated session-module conversion, before the automation behavior changes. The after build contains the automation, price explorer and experimental OpenRouter connection. Each view was captured in light and dark themes at the same window size.

| Surface | Before | After |
| --- | --- | --- |
| Relay composer | [Light](before/relay-light.png), [dark](before/relay-dark.png) | [Light](after/relay-light.png), [dark](after/relay-dark.png) |
| Automation allowance and create action | Part of the old composer above | [Light](after/relay-actions-light.png), [dark](after/relay-actions-dark.png) |
| Public price comparison setup | New feature | [Light](after/prices-setup-light.png), [dark](after/prices-setup-dark.png) |
| Bounded, scrollable hosting comparison | New feature | [Light](after/prices-light.png), [dark](after/prices-dark.png) |
| Manual OpenRouter connection | New feature | [Light](after/openrouter-light.png), [dark](after/openrouter-dark.png) |
| Installed runtimes | [Light](before/settings-light.png), [dark](before/settings-dark.png) | [Light](after/settings-light.png), [dark](after/settings-dark.png) |
| Manifest consent | [Light](before/manifest-light.png), [dark](before/manifest-dark.png) | [Light](after/manifest-light.png), [dark](after/manifest-dark.png) |

The manifest is an untrusted visual fixture. The after fixture declares the new initial-prompt template so its exact argv is visible in consent; no trust button was pressed. The $3 allowance in the composer is a filled form, not authorization for a launched task.

[Public metadata verification](after/verification.json) records the live catalogue source, fetch time and content hash; endpoint comparisons; persistence of the daily-refresh preference; and renderer errors. The isolated run enabled the preference, read it back and disabled it. The prices are published estimates for a 50,000-input / 5,000-output-token request, not measured coding cost or evidence of quality. Daily discovery is separate from eligibility for automatic execution.

Visual review covers readable controls and focus states, both themes, the creation action, scrolling price rows and the connection disclosure. Automated execution tests use offline provider/PTY fixtures; hosted OpenRouter coding and actual billed cost remain unverified.
