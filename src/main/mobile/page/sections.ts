import { ALERTS_SECTION } from './sections/alerts';
import { CONSOLE_SECTION } from './sections/console';
import { FLEET_SECTION } from './sections/fleet';
import { LAUNCH_SECTION } from './sections/launch';

/**
 * The registry of screens the phone page is made of. A screen owns its markup,
 * its style and its script fragment together, so adding one is a new module
 * plus one line here rather than an edit in four places of a single template.
 */

/**
 * Where in the frame a section's markup is composed. The two slots predate the
 * phone's navigation and the shell now places each into a named screen from
 * shared/mobile-nav.ts: 'dashboard' fills the Fleet view, 'controls' fills the
 * remote-control block inside the Agent view. The names are kept because they
 * describe the *frame* — the control slot is still the part that only exists
 * when remote control is separately enabled, which is a different question from
 * which screen it appears on.
 */
export type MobileSectionSlot = 'dashboard' | 'controls';

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
// you did not need it — then the console and the launch form fill the
// remote-control slot on the Agent screen.
export const MOBILE_SECTIONS: readonly MobileSection[] = [
  ALERTS_SECTION, FLEET_SECTION, CONSOLE_SECTION, LAUNCH_SECTION,
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
