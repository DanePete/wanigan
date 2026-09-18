import { demoViews } from './view-module.ts';
import { VIEWS, type Tab } from './view-registry.ts';

export type DemoState = { on: boolean; source: 'fictional' | 'live' };

/**
 * Only surfaces with authored fixtures are available in the sample workspace.
 *
 * Derived from `VIEWS`'s own `demo` field rather than hand-listed a second
 * time: a view whose fixtures ship marks itself `demo: true` in
 * `view-registry.ts`, and this is that set, read back. The order below is now
 * `VIEWS` order rather than this table's old hand-listed order, which is not a
 * behaviour change — this table's only consumer, `App.tsx`, only ever tests
 * membership (`DEMO_VIEWS.includes(tab)`), never position.
 */
export const DEMO_VIEWS: readonly Tab[] = demoViews(VIEWS);
export const DEMO_UNAVAILABLE = 'This action is unavailable in the read-only demo. Return to your workspace to use it.';

/** Authored preparation prompts; choosing one never dispatches work. */
export const DEMO_PROMPTS = [
  {
    id: 'cart-fix', label: 'Fix a cart bug', target: 'Coding agent · Northstar Storefront',
    text: 'Find why removing the last item leaves the cart total unchanged. Add a regression test, fix it, and run the tests.',
  },
  {
    id: 'checkout-accessibility', label: 'Improve checkout accessibility', target: 'Coding agent · Northstar Storefront',
    text: 'Make checkout usable with a keyboard. Give every field a clear label and show validation beside the relevant field.',
  },
  {
    id: 'checkout-guide', label: 'Document the checkout flow', target: 'Coding agent · Fieldnotes',
    text: 'Write a short guide explaining the sample checkout flow. Use only behavior supported by this project.',
  },
  {
    id: 'session-attention', label: 'Review sessions needing attention', target: 'Wanigan companion · Demo workspace',
    text: 'Which sessions need my attention, and where should I look first?',
  },
  {
    id: 'account-headroom', label: 'Compare account headroom', target: 'Wanigan companion · Demo workspace',
    text: 'Which demo account has more room left in its current usage window? Include the reset times.',
  },
] as const;
export type DemoPromptId = typeof DEMO_PROMPTS[number]['id'];
