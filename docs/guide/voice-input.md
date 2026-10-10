# Voice input

Speaking instead of typing, turned into text on this computer: the mic, the model, the keys and narration. Back to the [README](../../README.md).

Speak instead of typing, in the boxes you write in: a note about a part of
your site, a snap's or a recording's explanation, a message to an agent
session, Talk to Wanigan, the Request tab's hook search. It works the same on
macOS, Windows and Linux, and speech becomes text **on this computer**: the
audio never leaves it, no model is called over the network, and nothing goes
to an agent until you send it.

- **The mic** beside a box listens while it is pressed (water fill, a ring
  that follows your voice), shows the words heard so far above itself, and
  puts each sentence in at the caret as ordinary text once you pause: edit it,
  or undo it with ⌘Z (Ctrl+Z). **⌘⇧M** (Ctrl+Shift+M) starts or stops it from
  the box you are typing in; **hold ⌘⇧H** (Ctrl+Shift+H) to talk until you let
  go. Both are on the shortcut sheet under Voice input.
- **The model is downloaded once, when you ask.** The first press offers it
  with its size and source: Fast is Whisper base (80 MB, about a second a
  sentence), Accurate is Whisper small (252 MB, about three and a half seconds,
  better with noise and languages other than English), both from Hugging Face,
  each file pinned to a commit and checked against its SHA-256, kept in
  Wanigan's data and removable in **Settings › Voice**. A stopped download
  carries on where it stopped. After that, voice works offline.
- **Silence and noise are not words.** Whisper invents "you" and "thank you"
  for silence; a detector keeps silence and steady noise from ever reaching it.
- **Settings › Voice**: the model, the language (Detect, or yours: naming it
  helps), Narrate recordings, the keys, and what your OS says of the
  microphone.
- **Narration.** In the live editor, the **Voice** tool (after Snap and Record)
  narrates a recording: what you say goes into its step log, each line at the
  moment you said it, and an agent gets it with the key frames. With **Narrate
  recordings** on, every recording narrates from its start to its stop.
- **The microphone.** macOS asks once (System Settings › Privacy & Security ›
  Microphone turns it back on); Windows needs "Let desktop apps access your
  microphone" in Settings › Privacy & security › Microphone; Linux asks
  nothing. If it cannot listen, the mic says why and what to do, with a
  button to the OS's page where there is one. Only Wanigan's own window may
  use the microphone; a site in the live view never can.

How it is built and why (four engines measured in 19 languages):
[docs/design/2026-10-10-voice-input.md](../design/2026-10-10-voice-input.md).
