// Built on its own to out/renderer/live-page.js (electron.vite.config.ts): the
// script the live view injects into the owner's site. See live-page.ts,
// live-page-goto.ts for the Go to launcher's part, live-page-record.ts for
// Record's, and live-page-say.ts for the site's own messages said Wanigan's way.
import { livePage } from './live-page';
import { livePageGoto } from './live-page-goto';
import { livePageRecord } from './live-page-record';
import { livePageSay } from './live-page-say';

livePage();
livePageGoto();
livePageRecord();
livePageSay();
