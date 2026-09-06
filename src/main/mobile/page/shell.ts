import { mobileScript } from './script';
import { sectionMarkup, sectionScript, sectionStyle, sectionWiring } from './sections';
import { mobileStyle } from './style';

/**
 * The frame. It owns the parts of the page that belong to no single screen —
 * the head, the header, the pairing and error notices, the two nesting
 * containers screens are composed into, and the footer — and nothing else.
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
${[mobileStyle(), sectionStyle()].join('\n')}
  </style>
</head>
<body>
  <main>
    <header>
      <div><div id="mode-label" class="eyebrow">${remoteControl ? 'Private remote control' : 'Private fleet monitor'}</div><h1 id="host">Wanigan</h1></div>
      <div class="connection"><span id="dot" class="dot"></span><span id="connection">Connecting…</span></div>
    </header>
    <section id="pair" class="notice hidden"><strong>This Wanigan app is not paired yet.</strong><p style="margin-top:6px">On the Mac, open Wanigan Settings → Phone monitor and type its ten-character pairing code here.</p><form id="pair-form" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><input id="pair-token" aria-label="Pairing code" autocomplete="one-time-code" autocapitalize="characters" placeholder="Pairing code" maxlength="12" style="flex:1;min-width:220px"><button>Pair this app</button></form></section>
    <section id="error" class="notice hidden"><strong id="error-title">Could not read Wanigan.</strong><span id="error-text">The next poll will retry.</span><p id="error-why" class="why"></p></section>
    <section id="dashboard" class="hidden">
${sectionMarkup('dashboard')}
      <section id="controls" class="controls hidden">
        <h2>Agent console</h2>
${sectionMarkup('controls')}
        <div id="control-result" class="control-result" role="status"></div>
      </section>
    </section>
    <footer id="updated">No fleet data yet.</footer>
  </main>
  <script nonce="${nonce}">
${mobileScript(remoteControl, { script: sectionScript(), wiring: sectionWiring() })}
  </script>
</body>
</html>`;
}
