// The tours of Sessions, a session, Running and History (places sessions, session, running, history): one per place, each a few stops through what the view
// does and what you can do there (types.ts says how a step is written).
import { WATCH_MAX } from '@shared/watch';
import type { Tour } from './types';
import { keys } from './types';

export const SESSIONS_TOURS: Tour[] = [
  {
    id: 'sessions',
    name: 'Sessions',
    intro: 'The agents working in this project, and the ones that have finished.',
    steps: [
      {
        target: 'sessions-list', side: 'top', title: 'Every session here',
        body: 'Live sessions first, then the ones that ended, each with its card, its agent and how long it ran. Choose one to open its terminal.',
      },
      {
        target: 'sessions-filter', side: 'bottom', title: 'Find one',
        body: 'Type part of a title, a card’s key or an agent’s name to narrow the list. Esc clears it.',
      },
      {
        target: 'sessions-new', side: 'bottom', title: 'Start a session',
        body: (c) => `${keys(c, 'Mod', 'T')} starts Claude Code, Codex, Gemini CLI or your shell in this project’s folder, on a card or on its own.`,
      },
      {
        target: 'sessions-history', side: 'bottom', title: 'Every conversation',
        body: (c) => `History (${keys(c, 'Mod', 'Shift', 'T')}) has every conversation in this folder, including ones from VS Code or another terminal, ready to read or resume.`,
      },
    ],
  },
  {
    id: 'session',
    name: 'a session',
    intro: 'One agent at work: its terminal, your messages to it, and what it has done.',
    steps: [
      {
        target: 'session-terminal', side: 'right', title: 'Its terminal',
        body: 'The session’s real terminal: type into it as you would anywhere. It runs in Wanigan’s core, so closing the window stops nothing.',
      },
      {
        target: 'session-composer', side: 'top', title: 'Message the agent',
        body: (c) => `Enter sends, Shift+Enter starts a new line; while the agent is busy, a message waits until it is idle. ${keys(c, 'Mod', 'Shift', 'M')} moves between here and the terminal.`,
      },
      {
        target: 'session-attach', side: 'top', title: 'Images and files',
        body: 'Paste or drop them on the terminal or here, or pick them with the paperclip: they wait as chips and go with your next message.',
      },
      {
        target: 'session-panel', side: 'left', title: 'Turns and details',
        body: (c) => `What the agent did each turn and what git saw it change, with the last turn’s undo; then its account, model, tokens and limits. ${keys(c, 'Mod', 'Shift', 'D')} shows or hides it.`,
      },
      {
        target: 'session-limit', side: 'bottom', title: 'Out of its limit',
        body: 'Carry the conversation on under another account with room, or wait for the reset. A Codex conversation stays in its own account.',
      },
      {
        target: 'session-stop', side: 'bottom', title: 'Stopping',
        body: 'Stop asks once, then ends the session. Its output stays here, and an agent’s conversation can be resumed later.',
      },
    ],
  },
  {
    id: 'running',
    name: 'Running',
    intro: 'Every live session in every project, and what each needs from you.',
    steps: [
      {
        target: 'running-list', side: 'top', title: 'Every live session',
        body: 'Grouped by project. They run in Wanigan’s core, not this window: close it and they keep going, and this is where to find them again.',
      },
      {
        target: 'running-actions', side: 'left', title: 'Its action, in place',
        body: 'A session that needs you shows its answer in amber: a permission to answer in its terminal, a question on its card, or a limit to carry on past.',
      },
      {
        target: 'running-pin', side: 'left', title: 'Pin to watch',
        body: `Pins choose which sessions Watch shows, up to ${WATCH_MAX}. With none pinned, it shows the ones that need you most, then the most recently active.`,
      },
      {
        target: 'running-layout', side: 'bottom', title: 'List or Watch',
        body: `Watch shows up to ${WATCH_MAX} live terminals at once, each scaled to fit. Click one, or press Enter on it, to type into it; Esc gives the keys back.`,
      },
      {
        target: 'running-new', side: 'bottom', title: 'Start another',
        body: (c) => `${keys(c, 'Mod', 'T')} starts a session in any project, from anywhere.`,
      },
    ],
  },
  {
    id: 'history',
    name: 'History',
    intro: 'Every earlier conversation in this folder, wherever it ran.',
    steps: [
      {
        target: 'history-list', side: 'top', title: 'Every conversation',
        body: 'Claude Code and Codex conversations in this folder, newest first, whether they ran here, in VS Code or in another terminal.',
      },
      {
        target: 'history-search', side: 'bottom', title: 'Search',
        body: 'Looks in titles, first prompts and branches, past the newest 500 the list shows.',
      },
      {
        target: 'history-row', side: 'bottom', title: 'Read one',
        body: 'Choose a conversation to read it beside the list. While it is open, Up and Down read the next and the one before; Esc closes it.',
      },
      {
        target: 'history-resume', side: 'left', title: 'Resume',
        body: 'Carries the conversation on in a new live session here. The whole conversation is sent again, which uses part of the account’s limits; a session still running just opens.',
      },
    ],
  },
];
