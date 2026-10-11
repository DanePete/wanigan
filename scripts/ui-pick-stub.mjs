// A stand-in for the live view with one part, the demo module's pay button
// (web/modules/custom/northstar_checkout in the demo's Northstar), picked on
// request: the editor sweep opens its template from the live view, and the
// control crawl presses the live view's Code key on it. Test-only; never
// shipped. window.__liveCalls says what the page was asked to do.
export const PICK_STUB = `(() => {
  const region = {
    index: 0, file: 'modules/custom/northstar_checkout/templates/northstar-pay-button.html.twig', entity: null, block: null, view: null, element: null,
    component: null, piece: null, hook: 'northstar_pay_button', field: null, suggestions: ['northstar-pay-button'], parent: null, order: 0,
    rect: { x: 40, y: 40, width: 220, height: 48 },
  };
  const listeners = new Set();
  window.__liveCalls = [];
  const state = { projectId: null, url: 'https://northstar.example.test/checkout/7/pay', title: 'Pay', loading: false, canGoBack: false, canGoForward: false, error: null, logged: 0 };
  const answers = {
    show: async (projectId) => { state.projectId = projectId; setTimeout(() => { for (const l of listeners) l({ ...state }); }, 50); return true; },
    bounds: () => {}, hide: async () => {}, cover: async () => null, go: async () => true,
    // What the page was asked to do after an edit: the sweep reads these.
    reload: async (hard) => { window.__liveCalls.push(hard ? 'reload-hard' : 'reload'); }, css: async () => { window.__liveCalls.push('css'); return 1; }, restyled: async () => [], settled: async () => 0,
    back: async () => {}, forward: async () => {}, open: async () => {},
    // The page's DevTools, quiet: this stand-in draws no page to inspect.
    devtoolsShow: async () => 'closed', devtoolsBounds: () => {}, devtoolsHide: async () => null, devtoolsClose: async () => {}, devtoolsDetach: async () => false, devtoolsInspect: async () => false, onDevtools: () => () => {}, reveal: async () => null,
    scan: async () => [region], outline: async () => 1, clear: async () => {}, cancelPick: async () => {},
    choose: async () => ({ url: state.url, selector: 'button.pay-button', tag: 'button', text: 'Pay', own: 'Pay', classes: ['pay-button'], rect: region.rect, style: {}, regions: [region] }),
    pick: async () => ({ url: state.url, selector: 'button.pay-button', tag: 'button', text: 'Pay', own: null, classes: ['pay-button'], rect: region.rect, style: {}, regions: [region] }),
    capture: async () => null, problems: async () => [], mutations: async () => 0, picked: async () => null,
    helperChanged: async () => null, helperSave: async () => ({ ok: false, error: 'no helper', label: null }),
    hasScript: async () => true,
    onState: (l) => { listeners.add(l); return () => listeners.delete(l); },
  };
  window.wanigan.live = answers;
})();`;
