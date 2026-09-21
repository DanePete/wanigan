# Relay composer: who runs each stage

Before and after, both themes, of the relay composer with the Build stage's
form open. Taken with `scripts/renderer-harness.mjs` against a stubbed bridge
on 2026-09-21, so they prove layout, type scale and palette and nothing about
IPC: the assistants, accounts and models shown are the harness's fixtures.

| | Dark | Light |
|---|---|---|
| Before | [before-dark.png](before-dark.png) | [before-light.png](before-light.png) |
| After | [after-dark.png](after-dark.png) | [after-light.png](after-light.png) |

Before: one assistant for the whole relay, and per stage a model and an effort
typed as free text under a "coding assistant default" placeholder. No account
per stage unless the relay had one, and no stage where a second assistant
could clean up after the first.

After: the rail is the form. Every stage is on it, the two that run no model
say what runs them, and each agent stage carries the assistant, account and
model it will run on in words — with a form beneath that offers only what that
assistant declares. The clean-up stage is one checkbox. Three presets fill the
common shapes.
