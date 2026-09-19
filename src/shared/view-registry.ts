import type { ViewArea, ViewModule } from './view-module.ts';

/**
 * Every destination Wanigan can show, declared once.
 *
 * A view used to reach this app through seven hand-edits in five files: a row
 * in `TABS`, a glyph in `TAB_ICONS`, a chord in `TAB_SHORTCUTS`, a slot in a
 * `SPACE_AREAS` row, a branch in `projectScopeFor`, a narrowing or an absence
 * in `mobile-nav.ts`, and a case in `App.tsx`. Six of the seven failed silently
 * when missed. This is the record those tables collapsed into, and
 * `view-module.ts` holds the derivations that turn it back into each of them;
 * `routes.ts`, `spaces.ts` and `demo.ts` now read those derivations rather than
 * keeping their own copies, and `mobile-nav.ts` reads two of the three (see its
 * own header for the one hand-kept list and why). The seventh — the case in
 * `App.tsx` that actually renders a view — is the one this conversion does not
 * reach, and it still fails silently when missed.
 *
 * It is a transcription, not a redesign. Every string below is copied from the
 * table that owns it today — punctuation, apostrophes and em dashes included —
 * so the change that puts the app on this registry reads as a move rather than
 * as new behaviour. Two things that were previously unwritten are now written:
 * `projectScope` spells out the `workspace` answer `projectScopeFor` used to
 * give by falling off the end of its branches, and `digit` names the nine
 * ⌘1–⌘9 holders that were until now simply the first nine elements of an array.
 *
 * What it deliberately does not change is order. `VIEWS` is in `TABS` order,
 * because that is the order the palette prints its results in and the order the
 * digit row was read positionally out of. The app carries a *second* order that
 * is not this one — the order the sidebar lists destinations within an area —
 * and that order still lives where it always did, in `VIEW_AREAS[].tabs`. One
 * array cannot be in two orders at once, so `areaTabs()` derives a sidebar that
 * is the right set of rows in the wrong sequence; the sidebar must keep reading
 * `VIEW_AREAS[].tabs`. `view-registry.test.ts` pins that divergence. Collapsing
 * the two orders into one is a decision about what the sidebar and the palette
 * should look like, which is not a decision a transcription gets to make.
 *
 * `VIEW_SHORTCUT_ORDER`'s hand-listed tail had drifted from `TABS` by the time
 * this registry was first written — pinned as a finding rather than fixed,
 * because a transcription does not get to make that call either. Once
 * `routes.ts` derives the cheat-sheet order from `digit` instead of hand-listing
 * a tail, there is nothing left to drift: the derivation resolves the finding
 * by construction. That is the one behaviour change this file's conversion to
 * a derived table makes, and it is a fix, not a transcription.
 *
 * This is not the extension manifest. A third-party extension declares itself
 * over surfaces that already exist and never loads code; everything here is
 * first-party code, and keeping the two apart is why a stranger's bundle is
 * installable at all.
 */
export const VIEWS = [
  {
    id: 'sessions', label: 'Sessions', icon: 'terminal', area: 'work',
    hint: 'Start and drive live agent terminals',
    keywords: 'agent terminal conversation interactive',
    projectScope: 'optional',
    shortcut: { label: '⌘1', aria: 'Meta+1 Control+1' },
    phone: { narrowedBy: 'agent' },
    demo: true, digit: true,
  },
  {
    id: 'fleet', label: 'Fleet', icon: 'grid', area: 'fleet',
    hint: 'Every session at once, and which ones need you',
    keywords: 'monitor activity status',
    projectScope: 'workspace',
    shortcut: { label: '⌘2', aria: 'Meta+2 Control+2' },
    phone: { narrowedBy: 'fleet' },
    demo: true, digit: true,
  },
  {
    id: 'control', label: 'Goals', icon: 'target', area: 'work',
    hint: 'Goals — a contract, a task graph, evidence and your decision',
    keywords: 'control goals goal review dockets tasks work graph',
    projectScope: 'workspace',
    shortcut: { label: '⌘3', aria: 'Meta+3 Control+3' },
    phone: { narrowedBy: 'goals' },
    demo: false, digit: true,
  },
  {
    id: 'batches', label: 'Batches', icon: 'layers', area: 'automation',
    hint: 'Fan one prompt across many inputs on the Batches API',
    keywords: 'batch api bulk fan-out',
    projectScope: 'workspace',
    shortcut: { label: '⌘4', aria: 'Meta+4 Control+4' },
    phone: { narrowedBy: 'batches' },
    demo: false, digit: true,
  },
  {
    id: 'insights', label: 'Insights', icon: 'chart', area: 'fleet',
    hint: 'Recorded spend and token usage',
    keywords: 'spend costs usage analytics',
    projectScope: 'workspace',
    shortcut: { label: '⌘5', aria: 'Meta+5 Control+5' },
    phone: { narrowedBy: 'spend' },
    demo: false, digit: true,
  },
  {
    id: 'learning', label: 'Learning', icon: 'brain', area: 'knowledge',
    hint: 'Knowledge items, the review inbox, and what agents get',
    keywords: 'knowledge memory briefing inbox proposals',
    projectScope: 'workspace',
    shortcut: { label: '⌘6', aria: 'Meta+6 Control+6' },
    phone: { narrowedBy: 'learning' },
    demo: false, digit: true,
  },
  {
    id: 'plugins', label: 'Plugins', icon: 'plug', area: 'settings',
    hint: 'Claude Code’s own plugins and marketplaces, read from this machine',
    keywords: 'claude code marketplace integrations',
    projectScope: 'workspace',
    shortcut: { label: '⌘7', aria: 'Meta+7 Control+7' },
    phone: { absent: 'Installing or trusting a plugin is a consent decision Wanigan only takes at the Mac.' },
    demo: false, digit: true,
  },
  {
    id: 'schedules', label: 'Schedules', icon: 'clock', area: 'automation',
    hint: 'Recurring headless and batch runs',
    keywords: 'automation cron recurring',
    projectScope: 'workspace',
    shortcut: { label: '⌘8', aria: 'Meta+8 Control+8' },
    phone: { narrowedBy: 'runs' },
    demo: false, digit: true,
  },
  {
    id: 'git', label: 'Changes', icon: 'branch', area: 'work',
    hint: 'History, working tree, branches, stashes and the review gate for one repository',
    keywords: 'git changes commits diffs stashes review',
    projectScope: 'required',
    shortcut: { label: '⌘9', aria: 'Meta+9 Control+9' },
    phone: { narrowedBy: 'git' },
    demo: false, digit: true,
  },
  {
    id: 'runs', label: 'Runs', icon: 'play', area: 'automation',
    hint: 'Headless runs — no terminal, output recorded',
    keywords: 'headless fan-out automation',
    projectScope: 'workspace',
    shortcut: { label: '⌘0', aria: 'Meta+0 Control+0' },
    phone: { narrowedBy: 'runs' },
    demo: false, digit: false,
  },
  {
    id: 'settings', label: 'Settings', icon: 'sliders', area: 'settings',
    hint: 'Keys, provider packs, projects, privacy and backup',
    keywords: 'preferences providers packs connections appearance',
    projectScope: 'workspace',
    shortcut: { label: '⌘,', aria: 'Meta+, Control+,' },
    phone: { absent: 'Keys, provider packs and privacy controls stay on the Mac. This phone is paired to Wanigan; it does not configure it.' },
    demo: true, digit: false,
  },
  {
    id: 'skills', label: 'Skills', icon: 'book', area: 'knowledge',
    hint: 'Browse every SKILL.md on this machine, or write one',
    keywords: 'agent skills instructions workflows author write',
    projectScope: 'workspace',
    shortcut: { label: '⌘⇧S', aria: 'Meta+Shift+S Control+Shift+S' },
    phone: { absent: 'Writing and editing a skill is work against a repository, so the Skills screen stays on the Mac. Typing one you already have into a live agent is on the Agent screen.' },
    demo: false, digit: false,
  },
  {
    id: 'context', label: 'Context', icon: 'file-text', area: 'knowledge',
    hint: 'Instructions, memory and configuration, per project',
    keywords: 'instructions memory configuration',
    projectScope: 'required',
    shortcut: { label: '⌘⇧C', aria: 'Meta+Shift+C Control+Shift+C' },
    phone: { absent: 'Instructions, memory and configuration are edited against a working tree, which this device does not have.' },
    demo: false, digit: false,
  },
  // Scout reads allow-listed public sources and proposes product changes. It
  // shares no table, IPC namespace or scope control with Learning, and it was
  // only ever findable as a tab inside it.
  //
  // I for Improvement Scout — S and C are taken. On macOS, the platform this
  // ships to, ⌘⇧I is free: the inspector is ⌥⌘I there.
  {
    id: 'scout', label: 'Scout', icon: 'compass', area: 'knowledge',
    hint: 'Improvement proposals built from public sources you allow',
    keywords: 'improvement scout proposals ideas suggestions release notes research sources evidence',
    projectScope: 'workspace',
    shortcut: { label: '⌘⇧I', aria: 'Meta+Shift+I Control+Shift+I' },
    phone: { narrowedBy: 'scout' },
    demo: false, digit: false,
  },
  // Past the digit row deliberately. ⌘1–9 read positionally out of this list,
  // so an entry inserted beside Insights would quietly move every shortcut
  // after it; Usage takes a named chord instead.
  //
  // That positional reading is what `digit` replaces: the row below says no in
  // a field rather than by sitting far enough down the array, and ten claimants
  // is now an error naming all ten instead of a chord that silently vanishes.
  // The decision the comment records is unchanged — only how it is enforced.
  {
    id: 'usage', label: 'Usage', icon: 'gauge', area: 'fleet',
    hint: 'What is left on each account, and what you actually spent',
    keywords: 'usage limits quota remaining left rate limit weekly session plan account work personal model burn',
    projectScope: 'workspace',
    shortcut: { label: '⌘⇧U', aria: 'Meta+Shift+U Control+Shift+U' },
    phone: { narrowedBy: 'spend' },
    demo: true, digit: false,
  },
  // The board reads the same tickets Control does, across every goal and
  // project at once, in columns. Control answers "how is this one goal going";
  // this answers "what is outstanding, and what am I doing about it today" —
  // which spans goals and is therefore a different surface, not a tab inside
  // one. Appended past the digit row for the reason stated above Usage.
  //
  // B for Board. Free on macOS, and the digit row is full.
  {
    id: 'board', label: 'Board', icon: 'columns', area: 'work',
    hint: 'Every ticket across every goal, in columns, to start, retry or park',
    keywords: 'board kanban tickets ticket issues issue backlog triage jira column swimlane defer park later todo in progress blocked done',
    projectScope: 'optional',
    shortcut: { label: '⌘⇧B', aria: 'Meta+Shift+B Control+Shift+B' },
    phone: { narrowedBy: 'goals' },
    demo: false, digit: false,
  },
  {
    id: 'mission', label: 'Home', icon: 'compass', area: 'mission',
    hint: 'Your companion and a briefing across project spaces',
    keywords: 'home mission room orb assistant companion chat overview spaces',
    projectScope: 'optional',
    shortcut: { label: '⌘⇧H', aria: 'Meta+Shift+H Control+Shift+H' },
    phone: { absent: 'The companion conversation and its live 3D scene stay on the Mac. This phone reads project and session status through Fleet and Projects.' },
    demo: true, digit: false,
  },
  // Wanigan's own installable bundles — MCP servers, skills, gates and
  // instructions somebody declared and somebody else installs. Deliberately a
  // different word from the Plugins row above, which reads Claude Code's
  // plugins out of ~/.claude: those are installed by Claude Code's own CLI and
  // are not ours to enable. One word for both would make the two rows
  // unanswerable from the sidebar, and the keywords below are why searching
  // "plugin" still finds this one.
  //
  // E for Extensions. X reads as "close" on every other surface in this app.
  {
    id: 'extensions', label: 'Extensions', icon: 'plug', area: 'settings',
    hint: 'Install MCP servers and skills as one bundle, or package your own',
    keywords: 'extension plugin marketplace shop install mcp figma bundle author publish',
    projectScope: 'workspace',
    shortcut: { label: '⌘⇧E', aria: 'Meta+Shift+E Control+Shift+E' },
    phone: { absent: 'Installing an extension means reading a folder the operator chose and approving the exact commands, hosts and credentials it declares. Both halves belong at the Mac: this phone has no folder to pick, and a consent screen answered on a small screen away from the desk is the one place Wanigan will not take that decision.' },
    demo: false, digit: false,
  },
  // Past the digit row, like every destination added since it filled. The
  // sidebar draws the AREA's glyph, so a route icon is a name the type and
  // the smoke suite check, not a picture anyone sees: 'layers' for the
  // stacked phases.
  {
    id: 'relay', label: 'Relay', icon: 'layers', area: 'work',
    hint: 'One intent, from planning through review, commit and deployment',
    keywords: 'relay pipeline stages phases plan estimate implement verify review commit deploy deployment handoff sluice forecast route model effort',
    projectScope: 'required',
    // R for Relay. Free on macOS, and the digit row is full.
    shortcut: { label: '⌘⇧R', aria: 'Meta+Shift+R Control+Shift+R' },
    phone: { absent: 'A relay is watched, not driven, and its three decisions — the plan, the forecast and the verdict — are recorded on the Mac where its sessions run. The phone sees each phase as a task under Goals instead.' },
    demo: false, digit: false,
  },
] as const satisfies readonly ViewModule[];

/**
 * The areas, carried here so the registry validates against itself rather than
 * against a table in another file. `label` is the string the palette prints as
 * a destination's group and the sidebar prints as a heading — derived from the
 * area now, so the two can no longer disagree. `icon` is the sidebar's glyph
 * for that heading; it lived only on `SPACE_AREAS` before this conversion, and
 * moved here for the same reason `label` already had: `spaces.ts` now reads
 * this row back rather than keeping its own copy.
 *
 * `tabs` is the sidebar's order within an area, and it is the second order this
 * file carries. It is not `VIEWS` order and is not derivable from it: Work
 * groups the session, task board, goal and change views together without
 * moving any established keyboard shortcut. `SPACE_AREAS` reads this array
 * under its old name; there is no separate presentation table to keep in step.
 */
export const VIEW_AREAS = [
  { id: 'mission', label: 'Home', description: 'Your work at a glance', icon: 'compass', tabs: ['mission'] },
  { id: 'work', label: 'Work', description: 'Sessions, goals and changes', icon: 'terminal', tabs: ['sessions', 'board', 'control', 'relay', 'git'] },
  { id: 'fleet', label: 'Monitor', description: 'Activity, limits and spend', icon: 'grid', tabs: ['fleet', 'usage', 'insights'] },
  { id: 'knowledge', label: 'Knowledge', description: 'Memory, skills and context', icon: 'brain', tabs: ['learning', 'skills', 'context', 'scout'] },
  { id: 'automation', label: 'Automation', description: 'Runs, schedules and batches', icon: 'clock', tabs: ['runs', 'schedules', 'batches'] },
  { id: 'settings', label: 'Manage', description: 'Settings and integrations', icon: 'sliders', tabs: ['settings', 'extensions', 'plugins'] },
] as const satisfies readonly ViewArea[];

/** The route id union, derived rather than typed a second time. */
export type Tab = (typeof VIEWS)[number]['id'];
