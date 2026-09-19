# Prompt improvement visual evidence

`before/` captures the renderer before prompt improvement, with the same fictional
fixture data and drafts used by `after/`. Both light and dark themes cover Orb,
Sessions, new sessions, Relay, goal ideas, planning answers, goal objectives, acceptance checks, task
instructions, repository runs, attempt sets, and schedule prompts.

These are the actual built renderer in an isolated Electron profile. Every
project, session, account, model, saved planning conversation, and rewrite result
is fictional bridge fixture data. No real agent, provider, session write, task
launch, schedule mutation, or paid model request runs in this probe. The screenshots
and `verification.json` establish renderer layout and interaction behavior only;
main-process and IPC behavior are checked separately by the repository tests.

Reproduce with Node 22.23.2:

```sh
WANIGAN_RENDERER_ROOT=/path/to/frozen/before/renderer node scripts/probe-prompt-improve.mjs --before
npm run build
node scripts/probe-prompt-improve.mjs
```

The probe refuses send and launch actions, records prompt-improvement requests,
and checks that preparing or applying a suggestion never sends a prompt. After
checks cover empty and oversized drafts, missing credentials, enable/disable,
editable preview and clarification questions, failure, cancellation, a draft
changed during a request, a project changed during a request, focus restoration,
nested session-launch shortcuts, and a 720px preview.

Validation: all eight `npm test` stages passed in an isolated feature copy based
on `78983ff`, including 2,533 smoke assertions. The combined workspace run was
blocked by lint errors in unrelated concurrent
`docs/shots/relay-live-2026-09-19/` runners. After the dialog width correction, the
renderer style gate and production build passed again. SDK requests were
exercised offline and the smoke suite verified real SQLite behavior; no paid
model call ran. The final renderer probe passed 29 checks with zero page errors,
producing 38 after screenshots alongside 26 baseline screenshots.
