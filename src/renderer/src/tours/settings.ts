// The tours of Settings, Accounts, Skills, MCP servers and Needs you (places settings, accounts, skills, mcp, needs): one per place, each a few stops through what the view
// does and what you can do there (types.ts says how a step is written).
import type { SettingsSection } from '../lib/router';
import type { Tour } from './types';
import { keys } from './types';

const section = (id: SettingsSection) => () => ({ name: 'settings' as const, section: id });

export const SETTINGS_TOURS: Tour[] = [
  {
    id: 'settings',
    name: 'Settings',
    intro: 'Everything worth a setting, one section at a time.',
    steps: [
      {
        target: 'settings-nav', side: 'right', title: 'Every section',
        body: (c) => `Wanigan’s own settings; your agents’ accounts, skills, MCP servers and local models; your phone and Jev. Each is in the palette too: ${keys(c, 'Mod', 'K')}, then its name.`,
      },
      {
        target: 'settings-theme', side: 'bottom', title: 'Light or dark', go: section('appearance'),
        body: 'Match the system, or keep one. It is kept on this computer.',
      },
      {
        target: 'settings-tours', side: 'bottom', title: 'Tours like this one', go: section('appearance'),
        body: 'Stop a view’s tour offering itself on your first visit, play the welcome tour again, or have every tour offer itself again.',
      },
      {
        target: 'settings-notify', side: 'bottom', title: 'Notifications', go: section('general'),
        body: 'Banners while Wanigan is in the background, alerts while it is in front: for everything, only permission requests and failures, or nothing.',
      },
      {
        target: 'settings-live', side: 'bottom', title: 'The live view', go: section('live'),
        body: 'Show each project’s local site inside Wanigan, for the kinds of site you choose. It opens the site you already run; nothing is installed or started.',
      },
      {
        target: 'settings-updates', side: 'bottom', title: 'Updates', go: section('updates'),
        body: 'Check for a new version now, or once a day. Wanigan asks GitHub’s public list of releases, and installs nothing by itself.',
      },
    ],
  },
  {
    id: 'accounts',
    name: 'Accounts',
    intro: 'Your agents’ sign-ins: which accounts there are, and who each is signed in as.',
    steps: [
      {
        target: 'accounts-list', side: 'bottom', title: 'Every account',
        body: 'Each is a folder your agent keeps its sign-in in. Its row says who it is signed in as, what its limits have left, and which projects use it.',
      },
      {
        target: 'accounts-signin', side: 'left', title: 'Sign in',
        body: 'Opens the agent in that account’s folder, in a terminal here, to sign in with your browser. It turns amber when a project uses an account that is signed out.',
      },
      {
        target: 'accounts-add', side: 'left', title: 'Another account',
        body: 'A new folder in your home for another sign-in, work and personal or a client’s. A project chooses its account in its own settings.',
      },
      {
        target: 'accounts-check', side: 'bottom', title: 'Check again',
        body: 'Asks each agent again who it is signed in as, and reads what its limits have left.',
      },
      {
        target: 'accounts-how', side: 'bottom', title: 'How this works',
        body: 'How a project picks its account, what each agent reads, and what switching one does, as a picture.',
      },
    ],
  },
  {
    id: 'skills',
    name: 'Skills',
    intro: 'Every skill your agents can see, by where it lives.',
    steps: [
      {
        target: 'skills-list', side: 'right', title: 'Every skill',
        body: 'Personal, project, plugin and synced skills, for each agent and account, with the folders that had none at the foot. Choose one to read it.',
      },
      {
        target: 'skills-detail', side: 'left', title: 'The one you chose',
        body: 'Its SKILL.md, who sees it, how to call it and where its folder is.',
      },
      {
        target: 'skills-copy', side: 'bottom', title: 'Copy or remove',
        body: 'Copy it into a project or your own skills after seeing every file it would write. Remove moves its folder to Wanigan’s trash.',
      },
      {
        target: 'skills-filter', side: 'bottom', title: 'One agent',
        body: 'Show only Claude Code’s, Codex’s or Gemini CLI’s skills.',
      },
      {
        target: 'skills-search', side: 'bottom', title: 'Find one',
        body: 'Type part of a name or a description. Esc clears it.',
      },
    ],
  },
  {
    id: 'mcp',
    name: 'MCP servers',
    intro: 'The tools your agents can reach, and a store of well-known ones.',
    steps: [
      {
        target: 'mcp-list', side: 'bottom', title: 'What each agent has',
        body: 'Read from each agent’s own settings, for every account and open project. Values that look like keys or tokens are never shown.',
      },
      {
        target: 'mcp-check', side: 'left', title: 'Check connections',
        body: 'Runs claude mcp list as that account, which starts each server to see whether it answers.',
      },
      {
        target: 'mcp-filter', side: 'bottom', title: 'One agent',
        body: 'Show only Claude Code’s, Codex’s or Gemini CLI’s servers.',
      },
      {
        target: 'mcp-tabs', side: 'bottom', title: 'The store',
        body: 'Well-known servers, with install commands checked against each publisher’s documentation. Adding one shows you the agent’s exact command first.',
      },
    ],
  },
  {
    id: 'needs',
    name: 'Needs you',
    intro: 'Everything that needs you, from every project, most urgent first.',
    steps: [
      {
        target: 'needs-queue', side: 'top', title: 'The queue',
        body: 'An agent stopped on a prompt comes first, then two sessions on one file, a usage limit, a review, a failure, a question, and turns worth a look.',
      },
      {
        target: 'needs-action', side: 'left', title: 'Its action, in place',
        body: 'Answer in terminal gives the terminal the keys, Review opens the card, Reply goes to the agent, and Dismiss puts a finished turn or a failure away.',
      },
      {
        target: 'needs-ready', side: 'top', title: 'Ready to work',
        body: 'With nothing to do, whether each agent is signed in and whether a project is open, read from what Wanigan already knows.',
      },
      {
        target: 'needs-orb', side: 'right', title: 'Wanigan',
        body: 'He shows how things are going: calm, busy, or alarmed while a session has failed. Play, beside him, opens his toys.',
      },
      {
        target: 'needs-how', side: 'left', title: 'How this works',
        body: (c) => `What lands here and why, with each kind’s count. G then N comes back here from anywhere; ${keys(c, 'Mod', 'K')} finds everything else.`,
      },
    ],
  },
];
