/**
 * The route table: every destination the shell can show, with the label the
 * rail prints, the group the palette and a future sidebar and menu bar sort it
 * under, and the shortcut that reaches it. Pure data with no closures, like
 * shared/palette.ts, so the main-process smoke suite can hold it to account
 * and the cheat sheet, the palette, the key handler and the tab titles all
 * read the same record rather than four copies that drift.
 *
 * Every destination, in ⌘1–9 order. `hint` is a sentence about what the
 * surface does, not a restatement of its label: the palette prints it under
 * the view's name, and "Explore view" told a newcomer nothing about which of
 * them held the thing they were looking for. The palette was once the only
 * route to the views the rail could not fit; SIDEBAR_GROUPS carries all
 * fifteen now, so the hint earns its keep by being searched rather than by
 * being the only description anywhere. It is matched, not just printed:
 * filterPalette tests the query against the title, the hint and the keywords
 * as one string, and surviving rows keep their order in this table rather than
 * being ranked. So a word left in a hint after the feature it named moved
 * somewhere else does not merely mislead a reader — it puts this view in the
 * results above the row that actually owns the thing they typed.
 */
export const TABS = [
  { id: 'sessions',  label: 'Sessions',  group: 'Work',    hint: 'Start and drive live agent terminals',                    keywords: 'agent terminal conversation interactive' },
  { id: 'fleet',     label: 'Fleet',     group: 'Work',    hint: 'Every session at once, and which ones need you',          keywords: 'monitor activity status' },
  { id: 'control',   label: 'Review',   group: 'Work',    hint: 'Goals — a contract, a task graph, evidence and your decision', keywords: 'control goals goal dockets tasks work graph' },
  { id: 'batches',   label: 'Batches',   group: 'Work',    hint: 'Fan one prompt across many inputs on the Batches API',    keywords: 'batch api bulk fan-out' },
  { id: 'insights',  label: 'Insights',  group: 'Explore', hint: 'Recorded spend and token usage',                          keywords: 'spend costs usage analytics' },
  { id: 'learning',  label: 'Learning',  group: 'Explore', hint: 'Knowledge items, the review inbox, and what agents get',  keywords: 'knowledge memory briefing inbox proposals' },
  { id: 'plugins',   label: 'Plugins',   group: 'Explore', hint: 'Installed plugins and marketplaces',                      keywords: 'extensions integrations' },
  { id: 'schedules', label: 'Schedules', group: 'Explore', hint: 'Recurring headless and batch runs',                       keywords: 'automation cron recurring' },
  { id: 'git',       label: 'Git',       group: 'Manage',  hint: 'History, working tree, branches, stashes and the review gate for one repository', keywords: 'commits diffs stashes review' },
  { id: 'runs',      label: 'Runs',      group: 'Manage',  hint: 'Headless runs — no terminal, output recorded',            keywords: 'headless fan-out automation' },
  { id: 'settings',  label: 'Settings',  group: 'Manage',  hint: 'Keys, provider packs, projects, privacy and backup',      keywords: 'preferences providers packs connections appearance' },
  { id: 'skills',    label: 'Skills',    group: 'Explore', hint: 'Browse every SKILL.md on this machine, or write one',     keywords: 'agent skills instructions workflows author write' },
  { id: 'context',   label: 'Context',   group: 'Explore', hint: 'Instructions, memory and configuration, per project',     keywords: 'instructions memory configuration' },
  // Scout reads allow-listed public sources and proposes product changes. It
  // shares no table, IPC namespace or scope control with Learning, and it was
  // only ever findable as a tab inside it.
  { id: 'scout',     label: 'Scout',     group: 'Explore', hint: 'Improvement proposals built from public sources you allow', keywords: 'improvement scout proposals ideas suggestions release notes research sources evidence' },
  // Past the digit row deliberately. ⌘1–9 read positionally out of this list,
  // so an entry inserted beside Insights would quietly move every shortcut
  // after it; Usage takes a named chord instead.
  { id: 'usage',     label: 'Usage',     group: 'Explore', hint: 'What is left on each account, and what you actually spent', keywords: 'usage limits quota remaining left rate limit weekly session plan account work personal model burn' },
  // The board reads the same tickets Control does, across every goal and
  // project at once, in columns. Control answers "how is this one goal going";
  // this answers "what is outstanding, and what am I doing about it today" —
  // which spans goals and is therefore a different surface, not a tab inside
  // one. Appended past the digit row for the reason stated above Usage.
  { id: 'board',     label: 'Board',     group: 'Work',    hint: 'Every ticket across every goal, in columns you can move and park', keywords: 'board kanban tickets ticket issues issue backlog triage jira column swimlane defer park later todo in progress blocked done' },
  { id: 'mission', label: 'Mission room', group: 'Work', hint: 'Your companion and a briefing across project spaces', keywords: 'home orb assistant companion chat overview spaces' },
] as const;

export type Tab = (typeof TABS)[number]['id'];

/**
 * The icon each destination wears in the sidebar. Data, not decoration: it is
 * the second way to find a row at a glance, and it never replaces the word
 * beside it — a sidebar of glyphs alone is a quiz. Names match the small
 * inline set in components/bits.tsx.
 */
export const TAB_ICONS = {
  mission: 'compass',
  sessions: 'terminal',
  fleet: 'grid',
  control: 'target',
  batches: 'layers',
  insights: 'chart',
  learning: 'brain',
  plugins: 'plug',
  schedules: 'clock',
  git: 'branch',
  runs: 'play',
  settings: 'sliders',
  skills: 'book',
  context: 'file-text',
  scout: 'compass',
  usage: 'gauge',
  board: 'columns',
} as const satisfies Record<Tab, string>;

/** The order the sidebar lists destinations in, grouped by the job they serve. */
export const SIDEBAR_GROUPS: readonly { group: string; tabs: readonly Tab[] }[] = [
  { group: 'Work', tabs: ['mission', 'sessions', 'fleet', 'board', 'control', 'batches'] },
  { group: 'Explore', tabs: ['insights', 'usage', 'learning', 'scout', 'skills', 'context', 'plugins'] },
  { group: 'Manage', tabs: ['git', 'runs', 'schedules', 'settings'] },
];

/** How many leading TABS entries the digit row reaches: ⌘1 through ⌘9. */
export const DIGIT_ROUTES = 9;

/**
 * The direct routes, written out once so the rail, the palette, the cheat
 * sheet and the key handler cannot drift apart. ⌘1–9 follow the first nine
 * TABS entries and ⌘0 takes Runs; the surfaces past the digit row get named
 * chords rather than a blank shortcut column that implies they cannot be
 * reached at all. `aria` is the aria-keyshortcuts string, and it is also what
 * the key handler matches against, so a published chord is a working chord.
 */
export const TAB_SHORTCUTS: Record<Tab, { label: string; aria: string }> = {
  mission:   { label: '⌘⇧H', aria: 'Meta+Shift+H Control+Shift+H' },
  sessions:  { label: '⌘1', aria: 'Meta+1 Control+1' },
  fleet:     { label: '⌘2', aria: 'Meta+2 Control+2' },
  control:   { label: '⌘3', aria: 'Meta+3 Control+3' },
  batches:   { label: '⌘4', aria: 'Meta+4 Control+4' },
  insights:  { label: '⌘5', aria: 'Meta+5 Control+5' },
  learning:  { label: '⌘6', aria: 'Meta+6 Control+6' },
  plugins:   { label: '⌘7', aria: 'Meta+7 Control+7' },
  schedules: { label: '⌘8', aria: 'Meta+8 Control+8' },
  git:       { label: '⌘9', aria: 'Meta+9 Control+9' },
  runs:      { label: '⌘0', aria: 'Meta+0 Control+0' },
  settings:  { label: '⌘,', aria: 'Meta+, Control+,' },
  skills:    { label: '⌘⇧S', aria: 'Meta+Shift+S Control+Shift+S' },
  context:   { label: '⌘⇧C', aria: 'Meta+Shift+C Control+Shift+C' },
  usage:     { label: '⌘⇧U', aria: 'Meta+Shift+U Control+Shift+U' },
  // I for Improvement Scout — S and C are taken. On macOS, the platform this
  // ships to, ⌘⇧I is free: the inspector is ⌥⌘I there.
  scout:     { label: '⌘⇧I', aria: 'Meta+Shift+I Control+Shift+I' },
  // B for Board. Free on macOS, and the digit row is full.
  board:     { label: '⌘⇧B', aria: 'Meta+Shift+B Control+Shift+B' },
};

/**
 * The view rows of the cheat sheet, in the order a reader expects: the digit
 * row, ⌘0, ⌘, and then the named chords. Derived from the tables above so a
 * route added to TABS appears here in the same change, which is the promise
 * the sheet's header makes.
 */
export const VIEW_SHORTCUT_ORDER: readonly Tab[] = [
  ...TABS.slice(0, DIGIT_ROUTES).map((item) => item.id),
  'runs', 'settings', 'skills', 'context', 'scout', 'usage', 'board', 'mission',
];

export function labelForTab(id: Tab): string {
  return TABS.find((item) => item.id === id)?.label ?? id;
}
