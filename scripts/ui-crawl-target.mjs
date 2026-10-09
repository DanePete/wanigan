// Resolve the observed control on every Playwright retry.
// React may replace the marked node while an asynchronous query completes.
import { selectors } from 'playwright-core';

await selectors.register('crawl', () => ({
  query(root, selector) {
    const [scope, signature] = JSON.parse(selector);
    const found = window.__crawl.target(scope, signature);
    return found && root.contains(found) ? found : null;
  },
  queryAll(root, selector) {
    const found = this.query(root, selector);
    return found ? [found] : [];
  },
}));

export function crawlTarget(page, scope, signature) {
  return page.locator(`crawl=${JSON.stringify([scope, signature])}`);
}
