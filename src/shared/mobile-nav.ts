import type { Tab } from './routes';

/**
 * What the paired phone can reach, and what it deliberately cannot.
 *
 * The phone is a *narrowing* of the desktop taxonomy in shared/routes.ts, not a
 * second taxonomy that happens to look similar. Every entry below names the
 * desktop destinations it stands in for, and every desktop destination that has
 * no phone surface is listed in MOBILE_ABSENT with the sentence the Device
 * screen prints. The smoke suite holds those two lists to `TABS`: a new desktop
 * view that appears in neither fails the build. That is the point. The failure
 * mode this prevents is not an ugly menu — it is a phone that quietly stops
 * being a view of the same product, where the operator's mental map of Wanigan
 * depends on which screen they are holding.
 *
 * Narrowing is not renaming. Insights and Usage become one Spend screen because
 * away from the desk the question is a single one — what has this cost me and
 * how much is left — and Runs covers Schedules because a recurring run is a run
 * you did not start by hand. Where no honest narrowing exists, the destination
 * is absent with a reason rather than a stub that pretends.
 *
 * Pure data with no closures, like shared/routes.ts and shared/palette.ts, so
 * the offline main-process suite can read it directly.
 */

export type MobileViewId =
  | 'fleet' | 'agent' | 'goals' | 'batches' | 'runs'
  | 'spend' | 'learning' | 'scout'
  | 'git' | 'device';

export type MobileNavGroup = 'Work' | 'Explore' | 'Manage';

/**
 * Glyph names, matching the Lucide set the desktop sidebar draws from so the
 * two surfaces label the same destination with the same picture. `phone` has no
 * desktop counterpart because no desktop row is about the device you are
 * holding. The page's own copies of these paths live in mobile/page/nav.ts —
 * the phone page is hand-built HTML and cannot import a React component.
 */
export type MobileNavIcon =
  | 'grid' | 'terminal' | 'target' | 'layers' | 'play'
  | 'gauge' | 'brain' | 'compass' | 'branch' | 'phone';

export type MobileNavEntry = {
  id: MobileViewId;
  label: string;
  group: MobileNavGroup;
  /**
   * True for the destinations the thumb bar holds. Exactly four carry it: the
   * bar has five slots and the fifth is More, which opens the sheet holding
   * everything. A fifth `bar: true` would silently push a destination out of
   * the bar and out of the sheet at once, so the count is asserted.
   */
  bar: boolean;
  icon: MobileNavIcon;
  /**
   * What this screen shows, as a noun phrase. It is a subtitle in the sheet and
   * the rail, and the unbuilt screens print it verbatim after "it will show" —
   * so it has to describe the surface rather than restate its label.
   */
  hint: string;
  /**
   * The desktop destinations this screen narrows. Empty for `device` alone,
   * which is about this phone rather than about a desktop screen.
   */
  narrows: readonly Tab[];
};

/** Nav order: the order the sheet and the iPad rail list destinations in. */
export const MOBILE_VIEWS: readonly MobileNavEntry[] = [
  { id: 'fleet',    label: 'Fleet',    group: 'Work',    bar: true,  icon: 'grid',     hint: 'every session at once, and which ones need you',                      narrows: ['fleet'] },
  { id: 'agent',    label: 'Agent',    group: 'Work',    bar: true,  icon: 'terminal', hint: "one agent's terminal, and the next thing you tell it",                narrows: ['sessions'] },
  { id: 'goals',    label: 'Goals',    group: 'Work',    bar: false, icon: 'target',   hint: "a goal's contract, its task graph, and the decision waiting on you",  narrows: ['control'] },
  { id: 'batches',  label: 'Batches',  group: 'Work',    bar: false, icon: 'layers',   hint: 'one prompt fanned across many inputs, and what came back',            narrows: ['batches'] },
  { id: 'runs',     label: 'Runs',     group: 'Work',    bar: false, icon: 'play',     hint: 'headless runs, and the schedules that start them without you',        narrows: ['runs', 'schedules'] },
  // Spend wears the gauge rather than the chart: the reading that gets checked
  // from a phone is how close an account is to its limit, not the shape of last
  // week's curve.
  { id: 'spend',    label: 'Spend',    group: 'Explore', bar: true,  icon: 'gauge',    hint: 'what the fleet has cost, and what is left on each account',           narrows: ['insights', 'usage'] },
  { id: 'learning', label: 'Learning', group: 'Explore', bar: false, icon: 'brain',    hint: 'what Wanigan has learned, and what is waiting for your review',       narrows: ['learning'] },
  { id: 'scout',    label: 'Scout',    group: 'Explore', bar: false, icon: 'compass',  hint: 'improvement proposals built from public sources you allow',           narrows: ['scout'] },
  { id: 'git',      label: 'Git',      group: 'Manage',  bar: true,  icon: 'branch',   hint: 'the working tree, the branch, and the review gate for one repository', narrows: ['git'] },
  { id: 'device',   label: 'Device',   group: 'Manage',  bar: false, icon: 'phone',    hint: "this phone's pairing and notifications, and what it cannot do",       narrows: [] },
];

export type MobileAbsentView = {
  tab: Tab;
  /**
   * Printed verbatim on the Device screen, under the destination's name. The
   * name is not repeated here: the Device screen reads it from the route table
   * with labelForTab(), so renaming a desktop view renames it on the phone in
   * the same change rather than leaving two surfaces calling one screen two
   * things. This field carries only what the route table cannot — why the Mac
   * is the right place for it.
   */
  reason: string;
};

/**
 * The desktop destinations with no phone surface, on purpose. Each reason names
 * why the Mac is the right place for it, because "not on the phone" without a
 * reason reads as an unfinished build rather than a decision — and three of the
 * four are consent decisions Wanigan is only willing to take at the machine
 * that holds the credentials.
 */
export const MOBILE_ABSENT: readonly MobileAbsentView[] = [
  { tab: 'skills', reason: 'Writing and editing a skill is work against a repository, so the Skills screen stays on the Mac. Typing one you already have into a live agent is on the Agent screen.' },
  { tab: 'context', reason: 'Instructions, memory and configuration are edited against a working tree, which this device does not have.' },
  { tab: 'plugins', reason: 'Installing or trusting a plugin is a consent decision Wanigan only takes at the Mac.' },
  { tab: 'settings', reason: 'Keys, provider packs and privacy controls stay on the Mac. This phone is paired to Wanigan; it does not configure it.' },
];

/** Where a phone with no remembered route starts. */
export const MOBILE_DEFAULT_VIEW: MobileViewId = 'fleet';

/** The four thumb slots, in bar order; the fifth slot is More. */
export const MOBILE_BAR_VIEWS: readonly MobileNavEntry[] = MOBILE_VIEWS.filter((view) => view.bar);

/** Nav order, folded into the three groups the sheet and the rail print. */
export const MOBILE_NAV_GROUPS: readonly { group: MobileNavGroup; views: readonly MobileNavEntry[] }[] =
  (['Work', 'Explore', 'Manage'] as const).map((group) => ({
    group,
    views: MOBILE_VIEWS.filter((view) => view.group === group),
  }));

export function mobileViewLabel(id: MobileViewId): string {
  return MOBILE_VIEWS.find((view) => view.id === id)?.label ?? id;
}
