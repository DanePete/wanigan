import { mobileShell } from './page/shell';
import { MOBILE_ICON_PNG_PATH, dashboardIconPng } from './page/icon';

export { MOBILE_SECTION_ANCHORS } from './page/sections';
export { MOBILE_ICON_PNG_PATH, dashboardIconPng } from './page/icon';

/**
 * Everything the paired browser receives. The shell composes the frame, the
 * shared style and script, and one module per screen; nothing here reads
 * settings or fleet state, so the page can be built and diffed without a
 * running app.
 */

export function dashboardHtml(nonce: string, appearance: string, remoteControl: boolean): string {
  return mobileShell(nonce, appearance, remoteControl);
}

export function dashboardManifest(appearance: string): string {
  const light = appearance === 'light';
  return JSON.stringify({
    name: 'Wanigan Remote',
    short_name: 'Wanigan',
    display: 'standalone',
    start_url: './',
    background_color: light ? '#f8f3ea' : '#14100d',
    theme_color: light ? '#f8f3ea' : '#14100d',
    // The PNG comes first because it is the one every platform can use. Safari
    // takes neither an SVG touch icon nor an SVG manifest icon, and an install
    // that falls back to a page thumbnail is also a notification that arrives
    // under a page thumbnail — the icon and the alert are the same asset here.
    icons: [
      { src: MOBILE_ICON_PNG_PATH.slice(1), sizes: '180x180', type: 'image/png', purpose: 'any' },
      { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
    ],
  });
}

export function dashboardIcon(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="42" fill="#11151c"/><path d="M45 46h102v100H45z" fill="#e1a651"/><path d="M61 68h70v16H61zm0 30h70v16H61zm0 30h45v16H61z" fill="#17110a"/></svg>';
}
