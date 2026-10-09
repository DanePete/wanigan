// The story the video tells: its chapters and every caption, in one place.
// The recording marks the moment each caption belongs to; the edit draws it
// there. Change a word here and re-run the edit; no re-recording needed.
//
// Voice: plain, short sentences, the problem first. No hype, no slogans.
// A caption has `text`, and may have `demo` (said instead when the footage is
// the demo's) or `real`. Keep each under about 90 characters: it has to be read
// on a phone, muted, while the screen moves.

export const CHAPTERS = [
  { id: 'a', tag: 'The problem' },
  { id: 'b', tag: 'Cards' },
  { id: 'c', tag: 'A session' },
  { id: 'd', tag: 'The work' },
  { id: 'e', tag: 'Review' },
  { id: 'f', tag: 'Git' },
  { id: 'g', tag: 'Open source' },
];

export const CAPTIONS = {
  a1: { text: 'I run Claude Code and Codex in a lot of terminals at once.' },
  a2: { text: 'I lose track of which one is waiting on me, and what each one actually finished.' },
  a3: { text: 'Wanigan 2 puts that work on a board, one per project.' },

  b1: { text: 'Work starts as a card: what to build, and what counts as done.' },
  b2: {
    text: 'Jev, TypeSafe’s fast decision model, reads each new card in under a second.',
    demo: 'Jev, TypeSafe’s fast decision model, reads each new card. Here it is the demo’s stand-in.',
  },
  b3: { text: 'It suggests what to do with the card and how much it matters.' },
  b4: { text: 'Jev is optional. Each project picks: Off, Reads, or Reads and accepts.' },
  b4off: { text: 'Jev is optional. Without a TypeSafe key, new cards simply wait for you.' },
  b5: { text: 'Agents can’t take a card from the Inbox. You accept it to Ready.' },

  c1: { text: 'Start a session on the card, and pick the agent: Claude Code or Codex.' },
  c2: {
    text: 'Then the model and the effort. It runs the real CLI, on your own account.',
    demo: 'Then the model and the effort. In the demo, the agents are stand-ins.',
  },
  c3: { text: 'The session takes the card, and the card moves to Working.' },
  c4: { text: 'Codex takes another card, on its own branch.' },

  d0: { text: 'Each agent starts briefed: its card, the criteria, and the board’s commands.' },
  d1: { text: 'The agent works in a real terminal. It keeps going if you close the window.' },
  d2: { text: 'Every live session, side by side.' },
  d3: { text: 'When an agent stops to ask permission, Needs you says so, across every project.' },
  d4: { text: 'You see the exact command, and answer it in the terminal.' },
  d5: {
    text: 'When it’s done, the agent submits the card for review, with evidence.',
    demo: 'When an agent is done, it submits its card for review, with evidence.',
  },

  e1: { text: 'Nothing reaches Review without evidence.' },
  e2: { text: 'Ask Claude to check the work against each criterion. It quotes the files.' },
  e3: { text: 'Wanigan checks every quote against the file. The review is advice.' },
  e4: { text: 'Only you approve. The card moves to Done.' },

  f1: { text: 'Then the change itself, file by file.' },
  f2: { text: 'Stage it, commit it, read the history, and push.' },
};

/** The title card, and the end card. */
export const TITLE = {
  eyebrow: 'Wanigan 2',
  title: 'A desk for coding agents.',
  sub: 'Claude Code and Codex, on a board, with one place that says what needs you.',
};

export const END = {
  eyebrow: 'Wanigan 2',
  title: 'Open source, MIT.',
  sub: 'It runs on your Mac, with the Claude Code and Codex you already use.',
  link: 'github.com/DanePete/wanigan',
};

/** A caption's words for footage from a take recorded in `mode`. */
export function captionText(id, mode) {
  const c = CAPTIONS[id];
  if (!c) throw new Error(`no caption ${id} in story.mjs`);
  return c[mode] ?? c.text;
}
