// The tours of Changes, Code, Decisions and Activity (places changes, code, decisions, activity): one per place, each a
// few stops through what the view does and what you can do there (types.ts says how a step is written). A stop whose
// part is put away (the files' panel closed, no file open) is passed over.
import type { Tour } from './types';
import { keys } from './types';

export const CHANGES_TOURS: Tour[] = [
  {
    id: 'changes',
    name: 'Changes',
    intro: 'Where an agent’s work becomes a commit, and leaves for the remote.',
    steps: [
      {
        target: 'changes-tabs', side: 'bottom', title: 'Four parts',
        body: 'The working tree, the history, the branches and the stashes of this checkout. Pull, push and stash in the toolbar work from any of them.',
      },
      {
        target: 'changes-branch', side: 'bottom', title: 'Where you are',
        body: (c) => `The branch checked out, and how far it is ahead of or behind its upstream. Its menu moves to a card’s own worktree, switches branch (${keys(c, 'Mod', 'B')}) or makes a new one (${keys(c, 'Mod', 'Shift', 'B')}).`,
      },
      {
        target: 'changes-files', side: 'right', title: 'What changed',
        body: 'Conflicted, staged, changed and untracked files, each with the session that changed it. Tick a file to stage it, or press S on the one you are reading.',
      },
      {
        target: 'changes-diff', side: 'left', title: 'Read the diff',
        body: 'Every file in one scroll. J and K move between files and V marks one viewed; a line’s number leaves a note for the agent. Stage a hunk, or pick lines and stage only those.',
      },
      {
        target: 'changes-commit', side: 'right', title: 'Commit',
        body: (c) => `A summary and a description, then ${keys(c, 'Mod', 'Enter')}. The staged changes are checked for secrets first, and a finding stops the commit until you have read it.`,
      },
      {
        target: 'changes-remote', side: 'bottom', title: 'Pull and push',
        body: (c) => `Pull only fast-forwards. Push (${keys(c, 'Mod', 'Alt', 'P')}) shows which commits go where, after a second check for secrets; Wanigan never force-pushes.`,
      },
      {
        target: 'changes-how', side: 'bottom', title: 'How this works',
        body: 'From an agent’s edit to a push, with what Wanigan refuses on the way, as a picture with this checkout’s numbers.',
      },
    ],
  },
  {
    id: 'code',
    name: 'Code',
    intro: 'The project’s files, and an editor that writes only what you saw.',
    steps: [
      {
        target: 'code-files', side: 'right', title: 'The project’s files',
        body: 'Folders open as you go. The arrows walk them, typing jumps to a name, and Enter opens a file. Installed code is quieter, and opens read-only.',
      },
      {
        target: 'code-open', side: 'bottom', title: 'Open any file',
        body: (c) => `${keys(c, 'Mod', 'P')} finds a file by a few letters of its name or path, from anywhere in the project; add :42 to go to a line.`,
      },
      {
        target: 'code-tabs', side: 'bottom', title: 'Open files',
        body: 'Each file you open keeps its place and its undo here, even while you are in another view. A dot marks unsaved changes, and closing one of those asks first.',
      },
      {
        target: 'code-editor', side: 'left', title: 'The text',
        body: (c) => `${keys(c, 'Mod', 'S')} saves, but only over the version you opened: if anything changed it since, the two open side by side to merge. The breadcrumbs above name where the cursor is.`,
      },
      {
        target: 'code-how', side: 'bottom', title: 'How this works',
        body: 'What the editor opens, what it will not edit and why, and how the live view follows a save.',
      },
    ],
  },
  {
    id: 'decisions',
    name: 'Decisions',
    intro: 'The rules every session that starts in this project is told.',
    steps: [
      {
        target: 'decisions-list', side: 'bottom', title: 'The rules in force',
        body: 'Every session that starts here is told these, with their detail. J and K, or the arrows, move through them.',
      },
      {
        target: 'decisions-reader', side: 'left', title: 'Read one',
        body: 'The decision in full, and when it was recorded and changed. Edit it, or withdraw it so the sessions that start from now on are not told it.',
      },
      {
        target: 'decisions-filter', side: 'bottom', title: 'Find one',
        body: 'Type a few words to narrow the list to the decisions that hold them.',
      },
      {
        target: 'decisions-new', side: 'bottom', title: 'New decision',
        body: 'A rule in a sentence, and why. It reaches the next session that starts here; sessions already running were told the rules when they started.',
      },
    ],
  },
  {
    id: 'activity',
    name: 'Activity',
    intro: 'Everything you and your agents did in this project, newest first.',
    steps: [
      {
        target: 'activity-list', side: 'bottom', title: 'What happened',
        body: 'Cards moved, sessions started and ended, commits and pushes, files saved: by day, newest first. J and K, or the arrows, move through it.',
      },
      {
        target: 'activity-filter', side: 'bottom', title: 'Narrow it',
        body: 'Only what you did, or only what the agents did; type a word, a file or a card’s key.',
      },
      {
        target: 'activity-reader', side: 'left', title: 'Read an entry',
        body: 'When it happened, who did it and the detail in full, with its card and its session a click away.',
      },
      {
        target: 'activity-card', side: 'left', title: 'Its card',
        body: 'An entry about a card carries its key: a click opens the card beside the list.',
      },
    ],
  },
];
