# Helper sweep · P6 everyday conveniences

Produced by `scripts/probe-helper-p6-ux.mjs` against the built renderer in plain
Chromium with the preload bridge stubbed (`scripts/renderer-harness.mjs`). The
shots show layout, wording and focus in both themes. They say nothing about IPC,
the database, PTYs or the clipboard; `src/main/smoke35.ts` covers those.

`before/` is the same probe run with `--before` against a build of
`feat/helper-sweep` at `ad18786`, asserting only that each view rendered.
`after/` asserts the new element on screen, that it is not clipped, and what it
does. Each run writes `verification.json` with every assertion.

| File | Scenario |
| --- | --- |
| `session-tabs-tags-*` | Tag chips on session tabs; the tab's ⋯ menu with tags, colours and section |
| `recent-sections-*` | Recent: pinned, two sections with named move buttons, tag filter, a row's organise panel |
| `fleet-tags-*` | Fleet roster tags and the tag filter narrowing it |
| `terminal-path-menu-*` | Right-click on `src/Checkout.php:42`: code rail at line 42, Reveal in Finder, Copy path |
| `terminal-outside-root-*` | Right-click on `/etc/hosts`: not actionable, with main's reason |
| `code-reader-line-*` | The code reader opened from the terminal link, line 42 marked |
| `code-rail-popout-*` | The side panel's "Open in new window" |
| `code-rail-window-*` | The standalone code rail view (`?view=code-rail&session=…`) |
| `status-copy-menu-*` | The status bar's copy menu: last response, conversation ID |
| `side-question-claude-*` | `/btw` side question with its label and one-line field |
| `side-question-codex-*` | `/side` for Codex, typed alone |
| `palette-shortcuts-*` | `?` in the command palette narrowing to every binding |
| `transcript-reader-*` | Copy as Markdown, Quote selection, and a mermaid block shown as labelled source |

`before/` has no counterpart for the four scenarios that cannot happen without
the feature: the outside-root menu, the reader opened at a line, the Codex side
question and the rail window.
