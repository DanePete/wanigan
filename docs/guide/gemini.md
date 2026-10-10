# Gemini CLI

How Gemini CLI runs in Wanigan, what is copied into its home, and what it does not report. Back to the [README](../../README.md).

Gemini CLI runs in a terminal like Claude Code and Codex, and reports its turns,
its tools and what it asks you through hooks. Gemini takes hooks only from its
own settings, so Wanigan keeps a Gemini home in its data folder
(`GEMINI_CLI_HOME`) holding Wanigan's hooks; your own `~/.gemini` is never
written. Your sign-in stays where Gemini keeps it. As each session starts,
your chosen sign-in method, trusted folders and MCP servers are copied in, but
only servers holding nothing that could be a credential: a key written into a
server's settings keeps it out (the MCP view says so; write it as `$NAME` from
your environment to use it). Your own skills (`~/.gemini/skills` and
`~/.agents/skills`) are linked in, so Gemini reads them where they are. The Skills and MCP views list Gemini's with
each project's `.gemini/skills`, `.agents/skills` and `.gemini/settings.json`,
and add or copy to them on your click. Your own Gemini extensions and global
`GEMINI.md` live in your home and are not loaded there.

- In a folder Gemini has not been told to trust, it asks first, and loads no
  hooks until you answer; Needs you shows it as not yet started.
- The composer works from Gemini's second message: its first screen may ask you
  to sign in or to trust the folder, so the first message goes in its terminal.
- Nothing reports a refused permission or a cancel; its window title going back
  to Ready does, and Wanigan reads it.
- Nothing reports its usage limit either: Gemini draws a dialog (keep trying,
  switch model, or stop). Wanigan reads that dialog's exact words in a turn, so
  the session shows as limited, with the reset Gemini printed, and Needs you
  sends you to its terminal. Stopping keeps it limited until the next prompt.
  It is screen text: if Gemini rewords it, Wanigan misses it.
- Its tokens are counted from its own chat file, the one its hook names inside
  Wanigan's Gemini home: each reply once, cached input apart, thoughts as
  output.

What was proven and how is in
[docs/research/2026-10-07-gemini-and-grok.md](../research/2026-10-07-gemini-and-grok.md).
