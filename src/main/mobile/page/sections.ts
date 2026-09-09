import { ALERTS_SECTION } from './sections/alerts';
import { DEVICE_SECTION } from './sections/device';
import { GOALS_SECTION } from './sections/goals';
import { LEARNING_SECTION } from './sections/learning';
import { MANAGE_SECTION } from './sections/manage';
import { SCOUT_SECTION } from './sections/scout';
import { SKILLS_SECTION } from './sections/skills';
import { SPEND_SECTION } from './sections/spend';
import { CONSOLE_SECTION } from './sections/console';
import { FLEET_SECTION } from './sections/fleet';
import { GIT_SECTION } from './sections/git';
import { LAUNCH_SECTION } from './sections/launch';
import { RECENT_SECTION } from './sections/recent';

/**
 * The registry of screens the phone page is made of. A screen owns its markup,
 * its style and its script fragment together, so adding one is a new module
 * plus one line here rather than an edit in four places of a single template.
 *
 * What a screen does not own is the four states it can be in. shell.ts defines
 * a `ui` helper ahead of every fragment in the same closure, and a screen draws
 * its absences through it rather than inventing a box:
 *
 *   ui.reading(what)             still reading — `what` is the noun phrase the
 *                                desktop Reading primitive takes, so the two
 *                                surfaces say the same sentence about the same
 *                                read: ui.reading('the working tree').
 *   ui.failed(what, why, retry)  the read failed; `retry` becomes the button.
 *   ui.off(title, sentence)      the capability is off at the Mac, and the
 *                                sentence names the exact setting.
 *   ui.empty(claim, note)        there is genuinely nothing — only ever after
 *                                ui.observed(), because that claim is about the
 *                                Mac and a poll has to have established it.
 *   ui.observed() / ui.fresh()   has any poll returned, and is this one live.
 *   ui.watch(viewId, load)       register the screen's read. The frame runs it
 *                                when that view is on screen and again on each
 *                                poll that returns while it still is; it
 *                                returns the same read on demand, which is what
 *                                a retry button wants. A screen must not hold
 *                                an interval of its own — eighteen of those is
 *                                a phone radio kept awake for seventeen panels
 *                                nobody is looking at.
 */

/**
 * Where a section's markup lands. 'dashboard' fills the Fleet view and
 * 'controls' the remote-control block inside Agent; 'device' is its own screen,
 * which is why it is a slot rather than a second dashboard panel — it is about
 * this phone rather than about the Mac's fleet. 'git' is its own screen for a
 * sharper reason: it is the only slot whose routes put a file path on the wire,
 * and a slot of its own is what keeps that surface one grep away rather than
 * folded into a panel on a screen about something else.
 */
export type MobileSectionSlot =
  | 'dashboard' | 'controls' | 'device' | 'git' | 'spend' | 'manage'
  | 'goals' | 'learning' | 'scout';

export type MobileSection = {
  id: string;
  /**
   * The one DOM id this section's markup contributes. The smoke suite asserts
   * each appears exactly once in the served page, so a section that is dropped
   * or composed twice fails loudly instead of rendering a second console.
   */
  anchorId: string;
  slot: MobileSectionSlot;
  markup: string;
  style: string;
  script: string;
  wiring: string;
};

// Order is render order: the alert panel sits above the fleet on the Fleet
// screen — an alert below the session it is about is an alert you find after
// you did not need it — then the console, the launch form directly beneath it
// and the skill launcher last fill the remote-control slot on the Agent screen.
//
// The launch form used to come last, and on an iPhone that put "Start an agent"
// below the terminal AND below a list of every installed skill: two full screens
// of scrolling from the top of the Agent screen, which is indistinguishable from
// a phone that cannot start a session at all. It sits under the console now, and
// the Fleet screen — the one a phone opens on — carries a button that jumps
// straight to it.
export const MOBILE_SECTIONS: readonly MobileSection[] = [
  ALERTS_SECTION, FLEET_SECTION, CONSOLE_SECTION, LAUNCH_SECTION, RECENT_SECTION, SKILLS_SECTION, GIT_SECTION,
  SPEND_SECTION, MANAGE_SECTION, GOALS_SECTION, LEARNING_SECTION, SCOUT_SECTION, DEVICE_SECTION,
];

export const MOBILE_SECTION_ANCHORS: readonly string[] = MOBILE_SECTIONS.map((section) => section.anchorId);

function joined(parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join('\n');
}

export function sectionMarkup(slot: MobileSectionSlot): string {
  return joined(MOBILE_SECTIONS.filter((section) => section.slot === slot).map((section) => section.markup));
}

export function sectionStyle(): string {
  return joined(MOBILE_SECTIONS.map((section) => section.style));
}

export function sectionScript(): string {
  return joined(MOBILE_SECTIONS.map((section) => section.script));
}

export function sectionWiring(): string {
  return joined(MOBILE_SECTIONS.map((section) => section.wiring));
}
