// The welcome tour: played once, on the first launch, through the things worth
// knowing on day one. Replayed from the palette (Welcome tour) and Settings.
import type { Route } from '../lib/router';
import type { Tour, TourContext } from './types';
import { keys } from './types';

/** The project bar's stops: stay in the project shown, else open one, else (no project yet) pass them over. */
const toAProject = (c: TourContext): Route | null | undefined =>
  (c.projectKey ? undefined : c.firstProjectKey ? { name: 'project', projectKey: c.firstProjectKey, view: 'board' } : null);

export const WELCOME: Tour = {
  id: 'welcome',
  name: 'Wanigan',
  intro: 'The things worth knowing on day one.',
  steps: [
    {
      title: 'Welcome to Wanigan',
      body: 'Wanigan runs your coding agents in real terminals, keeps each project’s work on a board, and lets you change the project’s local site in place. A few stops, about a minute; Esc ends the tour at any time.',
    },
    {
      target: 'rail-projects', side: 'right', title: 'Your projects',
      body: (c) => `Each open project is a tile, and + opens another folder. An amber dot on a tile means something there needs you; a blue one, agents are working. ${keys(c, 'Mod', '1')} to ${keys(c, 'Mod', '9')} jumps to one.`,
    },
    {
      target: 'rail-needs', side: 'right', title: 'Needs you',
      body: 'Every question and permission from every agent, in one queue, the most urgent first. Answer them here, without opening each session.',
    },
    {
      target: 'rail-sessions', side: 'right', title: 'Sessions',
      body: 'Every running session in every project: Claude Code, Codex or your shell, each in a real terminal. They keep running when you close the window, and Watch shows them side by side.',
    },
    {
      target: 'project-views', side: 'bottom', title: 'One place for each job',
      go: toAProject,
      body: 'Board for the work, Sessions for its agents, Changes for git, Code for the files, Live for the site. History, Decisions, Activity and List are under ···, and G then a letter goes to each.',
    },
    {
      target: 'project-live', side: 'bottom', title: 'Change the site in place', go: toAProject,
      body: 'Live shows the project’s local site. Pick a part, type on the page or try a style: edits wait in a layer until you make them real through the site’s own core, and then Wanigan checks the page matches.',
    },
    {
      target: 'rail-search', side: 'right', title: 'Find anything',
      body: (c) => `${keys(c, 'Mod', 'K')} finds any project, card, session, page of a site or command, with its key. ? lists every shortcut.`,
    },
    {
      target: 'status-tour', side: 'top', title: 'A tour for every view',
      body: 'Each view has a short tour of its own. It offers itself the first time you open the view, and the compass here plays it again whenever you like.',
    },
  ],
};
