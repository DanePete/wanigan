# Not done yet

Everything not done yet, or not yet seen working end to end. Wanigan 2 is a beta and a work in progress. Back to the [README](../../README.md).

- Voice input has been seen transcribing in its built worker (a utilityProcess)
  and through the real app's ports on macOS (Apple silicon), but not yet with a
  real microphone: the test machine's agent session could not open even
  Chromium's fake audio device, and the tests never open a microphone. It has
  not yet been run on Windows, Linux or an Intel Mac, though nothing in it is
  specific to one: the engine is the same WebAssembly file everywhere.
- The earlier development report records real AI review, Draft with Claude,
  Talk to Wanigan and an image attached to a reply in the 7 October 2026
  scenario (Claude Code 2.1.292, Codex 0.155.1). The independent review did not
  repeat those model turns; `npm run scenario -- --spend` runs them again.
- Codex's usage limit is read from its own rollout, where Codex records the
  failed turn; no hook or notification says so. Proven with the stand-in
  Codex, and seen from the real 0.155.1 against a stand-in model provider's
  429 (`scripts/codex-hooks-probe.ts --turns`), but not yet from a real account
  hitting a real limit: the server's reply, which carries the reset, is shaped
  from Codex's source. A Codex session without its hooks does not know its
  rollout, so there its limit, a failed turn and Esc are not seen, and it reads
  working until its next prompt.
- A Codex conversation continues only in the account it lives in. Codex
  resumes only a thread in its own CODEX_HOME (`codex resume <path>` is
  refused). A copy or link of the rollout in another account does load the
  history with no model call, but leaves one thread id in two accounts, which
  History refuses to choose between, and whether that account accepts the
  first one's encrypted reasoning is unknown without spending a turn.
- Codex's hooks reported a real turn in the scenario run (SessionStart,
  UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop); OSC 9
  stays on as the fallback. Codex reports nothing until its first turn begins,
  so its composer refuses until lifecycle evidence arrives. Answer startup
  questions and send the first message in the terminal; use the composer for
  later turns.
- Replying to Codex from Needs you needs its hooks: a Codex session read only
  from its OSC 9 notifications (they say a turn ended, never that one began)
  is answered in its terminal, and says so. With its hooks, the reply was
  proven with the stand-in Codex, and Codex 0.155.1 was seen firing its
  start-of-turn hook for a pasted message against a stand-in model provider;
  a reply to a real Codex model turn from Needs you has not been run.
- Gemini CLI: proven with the installed 0.46 up to its first hook (folder trust
  answered, the hook through the relay, its conversation id learnt); a real
  model turn needs a Gemini login and has not been run. Its usage limit and
  token count were proven with the installed CLI against a fake Gemini API on
  this Mac (`scripts/gemini-fake-api-check.ts`); a real account's limit and a
  real model's usage numbers have not been seen. Its MCP servers and skills are
  listed, added and copied by Gemini's own rules, and Gemini itself, pointed at
  Wanigan's Gemini home, lists and connects to them; none has been used in a
  real turn, the store's Gemini commands are Wanigan's translations (not
  checked against each publisher), and the MCP view has no connection check
  for Gemini. Wanigan's own live view server is handed to it too.
- Grok Build: not yet an agent. Its installer was not run (it verifies nothing
  it downloads); what its binary says is in the research note, and its hook
  events are translated and tested, waiting for it to be installed and seen
  running.
- Codex asks you to approve each `wanigan` command its agent runs: its sandbox
  does not let it reach Wanigan's socket, and widening that sandbox is your
  call, not something Wanigan does for you.
- Remote Control and Codex's token counts follow what the CLIs' binaries show;
  neither was run against a real model.
- Live view: proven by hand on the owner's own local Drupal and WordPress
  sites and, in the real app driven by a script, on the two demo sites (moves,
  taking out with Undo, the component library and its pictures, part identity,
  a helper set up by another Wanigan); not by the UI sweeps, which have no view
  to lay over a page and fake the helper's answers with made-up data (they show
  its not-running and certificate states with a stand-in ddev). Telling a
  site that is not running from a certificate problem, and Start it, are
  tested against ddev 1.25's JSON and a stand-in ddev; a real `ddev start` from
  the app has not been run, and ddev's wording when Docker is not running was
  read from its binary, not seen. Not built yet: Serve this card (switching which checkout ddev
  serves), a component's props form, the design layer making words typed on a
  WordPress page real (the window still sends them to a save only the Drupal
  helper answers), and Canvas pieces by their own ids. The WordPress helper's
  newer edits (formatted and nested words, one block written alone, bound
  words, synced patterns and their overrides, template words, navigation
  labels, widgets without REST instances, media alt, a term's name) and the
  words a classic theme's template files write are tested under a stand-in
  WordPress only: none has been saved on a real site yet, nor an
  edited block opened in the block editor to see it called valid. The Drupal helper's Layout Builder moves, and
  reordering a field with several items, have not been run against a real
  site. Retyped words saved on WordPress (a title, a menu link's text) are
  tested with stand-in pages, traces and a stand-in site, not yet seen against
  a running WordPress. On Drupal, words saved inside formatted text, to
  configuration (block titles, the site's name and slogan, a view's words, a
  field's label), to a menu link, through a Layout Builder layout and through
  the page holding a paragraph are tested with a stand-in Drupal, not yet seen
  against a running one (nor what
  CKEditor 5 does to a stored text the next time it opens it). Agents' looks at it
  (`wanigan mcp`): tested with a real core and a stand-in app; each CLI seen
  connecting and listing the tools, as [the live view guide](live-view.md#what-each-agent-gets-and-what-has-been-seen-working) says, not yet seen calling one in a
  real turn.
- Local and Live: finding environments, keeping them, the lining-up and
  difference maths and the viewer (with two pictures the UI sweep draws) are
  tested. Opening a real hosted site in its tab and taking both pictures in the
  app's hidden windows have not been seen end to end yet.
- On your phone: proven in a phone-sized browser against the real phone
  gateway, with a stand-in Tailscale. A real phone through a real Tailscale
  address, and a notification arriving on one, have not been seen yet: a Mac
  cannot open its own Tailscale Serve address, so that needs a second device.
