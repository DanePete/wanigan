// Built on its own to out/renderer/live-page.js (electron.vite.config.ts): the
// script the live view injects into the owner's site. See live-page.ts, and
// live-page-goto.ts for the Go to launcher's part.
import { livePage } from './live-page';
import { livePageGoto } from './live-page-goto';

livePage();
livePageGoto();
