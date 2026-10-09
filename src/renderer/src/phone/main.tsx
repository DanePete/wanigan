// The phone page's entry: the shared tokens and parts, `window.wanigan` over
// the gateway, and the service worker that shows notifications.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '../styles/tokens.css';
import '../styles/base.css';
import '../styles/parts.css';
import '../styles/controls.css';
import '../styles/phone.css';
import '../lib/theme';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PhoneLink } from './bridge';
import { PhoneApp } from './PhoneApp';

// Opened as /wanigan without its slash: the service worker's scope is /wanigan/, so move under it.
if (!location.pathname.endsWith('/')) location.replace(`${location.pathname}/${location.search}${location.hash}`);

const link = new PhoneLink();
window.wanigan = link.bridge();
if (link.paired) void link.connect();
// Only for notifications; it caches nothing. Not on every browser (or over plain HTTP).
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('phone-sw.js').catch(() => {});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <PhoneApp link={link} />
  </StrictMode>,
);
