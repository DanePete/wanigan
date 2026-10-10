// The tours of the live editor (place live): one per place, each a few stops through what the view
// does and what you can do there (types.ts says how a step is written). Each stop points at a
// data-tour name in components/Live.tsx and components/live/Dock.tsx; the live page steps aside
// while a tour shows, as it does for any overlay, so the canvas can be pointed at.
import { keys, type Tour } from './types';

export const LIVE_TOURS: Tour[] = [{
  id: 'live',
  name: 'Live',
  intro: 'Your local site, edited where it shows: choose a part on the page, change it, and make it real in the site.',
  steps: [
    {
      title: 'The live editor',
      body: (c) => `The project’s local site, shown here and reloaded as the agents edit. Choose a part, change it on the page, and make it real in the site; the address goes to any page (${keys(c, 'Shift', 'Space')}).`,
    },
    {
      target: 'live-tools', side: 'bottom', title: 'Tools',
      body: (c) => `Select a part on the page (P), type on its words (E), try a style or move it (M). Snap (${keys(c, 'Shift', 'S')}) and Record (${keys(c, 'Shift', 'R')}) hand what you see straight to an agent, starting one when none is running.`,
    },
    {
      target: 'live-structure', side: 'right', title: 'Structure',
      body: 'Layers is what the page is made of, named as the site names it; Add places what the site’s library offers; Pages lists the site’s pages to go to.',
    },
    {
      target: 'live-canvas', side: 'left', title: 'The page itself',
      body: 'Your local site, reloaded as the agents edit. The chosen part is outlined with its name, and its action bar (Style, Move, Take out, Ask an agent) floats above it.',
    },
    {
      target: 'live-inspector', side: 'left', title: 'The chosen part',
      body: 'Its design, what made it (files, hooks, cache, cost) and its data, with every way to change it under Edit, and Tell an agent: a note that goes straight to an agent. Esc clears the choice.',
    },
    {
      target: 'live-edits', side: 'bottom', title: 'Edits, then Make real',
      body: (c) => `What you change waits in Wanigan’s layer, shown on the page, until you make it real in the site; Verify checks the site renders it as designed. Edits (${keys(c, 'Shift', 'E')}) lists every one.`,
    },
    {
      target: 'live-dock', side: 'top', title: 'The dock',
      body: (c) => `Notes for an agent, what the page reports, the request behind it, its DevTools and your code, beneath the page: closed until you open one here (${keys(c, 'Shift', '[')} and ${keys(c, 'Shift', ']')} step through them).`,
    },
  ],
}];
