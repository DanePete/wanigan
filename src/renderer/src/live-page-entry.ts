// Built on its own to out/renderer/live-page.js (electron.vite.config.ts): the
// script the live view injects into the owner's site. See live-page.ts,
// live-page-goto.ts for the Go to launcher's part, and live-page-record.ts for
// Record's.
import { livePage } from './live-page';
import { livePageGoto } from './live-page-goto';
import { livePageRecord } from './live-page-record';

livePage();
livePageGoto();
livePageRecord();
