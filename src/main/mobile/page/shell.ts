import {
  mobileViewsMarkup, navBarMarkup, navRailMarkup, navScript, navSheetMarkup, navStyle, navWiring,
} from './nav';
import { mobileScript } from './script';
import { sectionMarkup, sectionScript, sectionStyle, sectionWiring } from './sections';
import { mobileStyle } from './style';

/**
 * The Agent screen: the remote-control block, and the sentence that stands in
 * its place when there is no console to show. A screen that is simply empty
 * cannot be told apart from one that is broken, and this one is empty for two
 * different reasons with two different fixes — the opt-in is off at the Mac, or
 * this device has not reached the Mac yet. The server already knows which of
 * those is true at render time, so the first paint says the true one and
 * syncAgentNotice() keeps it true afterwards.
 */
function agentView(remoteControl: boolean): string {
  const claim = remoteControl ? 'The agent console has not opened yet.' : 'Remote control is off.';
  const note = remoteControl
    ? 'It opens as soon as this device reaches the Mac and reads the sessions it is running.'
    : 'Enable it in Wanigan Settings → Phone monitor to open a terminal, send a message, or interrupt a turn from this device.';
  return `        <h2>Agent console</h2>
        <div id="agent-locked" class="notice"><strong id="agent-locked-claim">${claim}</strong><span id="agent-locked-note">${note}</span></div>
        <section id="controls" class="controls hidden">
${sectionMarkup('controls')}
          <div id="control-result" class="control-result" role="status"></div>
        </section>`;
}

/**
 * The frame. It owns the parts of the page that belong to no single screen —
 * the head, the header, the pairing and error notices, the navigation, the
 * container the ten screens are composed into, and the footer — and nothing
 * else.
 *
 * Only Fleet and Agent are built; mobileViewsMarkup fills the other eight from
 * the record in shared/mobile-nav.ts with a sentence naming what will be there.
 */
export function mobileShell(nonce: string, appearance: string, remoteControl: boolean): string {
  return `<!doctype html>
<html lang="en" data-theme="${appearance}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="mobile-web-app-capable" content="yes">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="apple-touch-icon" href="icon.svg">
  <title>Wanigan Mobile</title>
  <style nonce="${nonce}">
${[mobileStyle(), navStyle(), sectionStyle()].join('\n')}
  </style>
</head>
<body>
${navRailMarkup()}
  <main>
    <header>
      <div><div id="mode-label" class="eyebrow">${remoteControl ? 'Private remote control' : 'Private fleet monitor'}</div><h1 id="host">Wanigan</h1></div>
      <div class="connection"><span id="dot" class="dot"></span><span id="connection">Connecting…</span></div>
    </header>
    <section id="pair" class="notice hidden"><strong>This Wanigan app is not paired yet.</strong><p style="margin-top:6px">On the Mac, open Wanigan Settings → Phone monitor and type its ten-character pairing code here.</p><form id="pair-form" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><input id="pair-token" aria-label="Pairing code" autocomplete="one-time-code" autocapitalize="characters" placeholder="Pairing code" maxlength="12" style="flex:1;min-width:220px"><button>Pair this app</button></form></section>
    <section id="error" class="notice hidden"><strong id="error-title">Could not read Wanigan.</strong><span id="error-text">The next poll will retry.</span><p id="error-why" class="why"></p></section>
    <section id="dashboard" class="hidden">
${mobileViewsMarkup({ fleet: sectionMarkup('dashboard'), agent: agentView(remoteControl) })}
    </section>
    <footer id="updated">No fleet data yet.</footer>
  </main>
${navBarMarkup()}
${navSheetMarkup()}
  <script nonce="${nonce}">
${mobileScript(remoteControl, {
    script: [navScript(), sectionScript()].join('\n'),
    wiring: [navWiring(), sectionWiring()].join('\n'),
  })}
  </script>
</body>
</html>`;
}
