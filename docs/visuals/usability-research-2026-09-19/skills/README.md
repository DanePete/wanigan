# Skills: agent coverage and supported actions

These are isolated Electron captures of the production renderer with fictional
skills, sessions, files, and installation receipts. No real agent receives text,
no file is installed, and no model is called. The baseline uses the frozen
`6fd50c7` renderer; both phases use the same fixture data.

| State | Before | After |
| --- | --- | --- |
| Library | [Dark](before/library-dark.png) · [Light](before/library-light.png) | [Dark](after/library-dark.png) · [Light](after/library-light.png) |
| Selected workflow | [Dark](before/reader-dark.png) · [Light](before/reader-light.png) | [Dark](after/reader-dark.png) · [Light](after/reader-light.png) |
| Source directories | [Dark](before/sources-dark.png) · [Light](before/sources-light.png) | [Dark](after/sources-dark.png) · [Light](after/sources-light.png) |
| Skill writer | [Dark](before/writer-dark.png) · [Light](before/writer-light.png) | [Dark](after/writer-dark.png) · [Light](after/writer-light.png) |
| Codex file | Omitted from the baseline library | [Dark](after/codex-file-dark.png) · [Light](after/codex-file-light.png) |

The after directory also covers filters, missing and truncated files, stale scans,
partial installation, empty state, and compact layouts. Its
[verification record](after/verification.json) contains nine grouped interaction
checks and the renderer index hash. Screenshots were visually inspected in both
themes. The checks establish fixture behavior, not measured usability gains or
real provider support beyond the existing main-process implementation.

Reproduce with Node 22.23.2:

```sh
WANIGAN_RENDERER_ROOT=/private/tmp/wanigan-usability-before-20260919/renderer WANIGAN_SKILLS_CAPTURE_OUTPUT=docs/visuals/usability-research-2026-09-19/skills/before node scripts/probe-skills-workspace.mjs --baseline
WANIGAN_SKILLS_CAPTURE_OUTPUT=docs/visuals/usability-research-2026-09-19/skills/after node scripts/probe-skills-workspace.mjs
```

The three pure tests in `src/shared/skill-catalogue.test.ts` separately cover
frozen harness, session state, same-project scope, stale scans, and known manual
invocation restrictions. Main re-reads and validates the actual session and skill
immediately before typing; the renderer check is explanatory preflight only.
