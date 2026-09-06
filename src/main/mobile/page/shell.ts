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
 * The four states every screen owes the operator, and the rule that keeps ten
 * screens from becoming ten timers on a phone radio.
 *
 * Both problems are the same problem the fleet had. A screen that is still
 * reading, a screen whose read failed, a screen whose capability is switched
 * off at the Mac and a screen with genuinely nothing on it all used to arrive
 * as the same blank panel — and blank reads as broken, which is the worst
 * answer to give someone away from their desk. So there are four renderings,
 * deliberately distinguishable by glyph, wording, structure and role rather
 * than by colour alone: only the failed one carries a retry, only the reading
 * one is aria-busy, and only the off one names the setting that turns the
 * capability back on.
 *
 * ui.observed() and ui.fresh() are the guard rails around the other half of
 * that failure. 'Nothing is running' is a claim about the Mac, and the page may
 * only make it about a poll that actually returned — before the first success a
 * screen is still reading, and once the Mac goes quiet the same words have to
 * move into the past tense, which ui.empty() does for the caller.
 *
 * ui.watch() is the cadence. A screen's read is a fetch over a cellular radio,
 * and eighteen screens each holding their own interval would keep that radio
 * awake for seventeen panels nobody is looking at. The frame therefore owns the
 * question: a watcher runs when its view comes on screen and again on the
 * shared status poll, which already backs off towards a minute while the Mac is
 * quiet and already stops entirely while the page is in the background. There
 * is no second cadence to keep in step with the first.
 *
 * It is defined here, ahead of every screen's fragment in the same closure, so
 * a screen reaches it the way it reaches node() and ago() — by name, importing
 * nothing. The page ships as one script under one nonce; that is what a strict
 * CSP leaves us.
 */
function uiScript(): string {
  return `
      // ── the four states ────────────────────────────────────────────
      // Glyph before colour, and four different glyphs: on a phone in sunlight
      // the shape is the channel that survives. The set matches the desktop's
      // empty-state vocabulary in components/bits.tsx — ○ for a capability that
      // is off, ✕ for a read that failed, · for an absence — so the same state
      // looks the same on both surfaces. Reading gets the part-filled ring,
      // which is the one shape here that says 'under way' without moving.
      const UI_GLYPH = { reading: '◔', failed: '✕', off: '○', empty: '·' };
      const viewWatchers = [];
      let watchedView = '';
      // Set only if this page could not attach itself to the shared poll. A
      // screen that had quietly stopped refreshing would look exactly like a
      // calm one, so every box it draws says so instead.
      let viewTickFault = '';

      function uiBox(kind, claim, note) {
        const box = node('div', 'state state-' + kind);
        const glyph = node('span', 'state-glyph', UI_GLYPH[kind]);
        glyph.setAttribute('aria-hidden', 'true');
        const body = node('div', 'state-body');
        body.append(node('strong', 'state-claim', claim));
        if (note) body.append(node('span', 'state-note', note));
        box.append(glyph, body);
        if (viewTickFault) box.append(node('p', 'state-fault', viewTickFault));
        return box;
      }

      // On screen means both: the dashboard is up at all — before pairing it is
      // not, and a watcher that fetched then would only collect 401s — and this
      // is the view it is showing. The answer is read from the DOM rather than
      // from the router's variable, because what a watcher needs to know is
      // what the operator can actually see.
      function showingView() {
        if (dashboard.classList.contains('hidden')) return '';
        const shown = dashboard.querySelector('.view:not(.hidden)');
        return shown ? shown.dataset.view : '';
      }

      function runWatcher(watcher) {
        // A screen whose previous read has not come back yet does not start a
        // second one: a slow endpoint on a three-second tick would otherwise
        // pile requests onto a radio that is already the expensive part.
        if (watcher.busy) return Promise.resolve();
        watcher.busy = true;
        return Promise.resolve().then(() => watcher.load()).catch(() => {
          // The screen owns its own failure rendering through ui.failed(); what
          // this catch protects is the other screens, so one rejected read
          // cannot take the shared tick down with it.
        }).then(() => { watcher.busy = false; });
      }

      function refreshVisibleView() {
        if (document.hidden) return;
        const shown = showingView();
        viewWatchers.forEach((watcher) => { if (watcher.viewId === shown) void runWatcher(watcher); });
      }

      const ui = {
        // 'the working tree', 'this account's usage' — the noun phrase, exactly
        // as the desktop Reading primitive takes it, so the two surfaces say
        // the same sentence about the same read. No spinner: motion in this app
        // is a measurement, and 'still reading' has none.
        reading(what) {
          const box = uiBox('reading', 'Reading ' + what + '…', '');
          box.setAttribute('role', 'status');
          box.setAttribute('aria-busy', 'true');
          return box;
        },
        // The only state with an action in it. A failed read that drew an empty
        // box left the operator holding a phone with no way forward but a
        // reload, which also throws away every other screen's reading.
        failed(what, message, retry) {
          const box = uiBox('failed', 'Could not read ' + what + '.', message || 'Wanigan did not say why.');
          box.setAttribute('role', 'alert');
          if (typeof retry === 'function') {
            const again = node('button', 'secondary state-retry', 'Try again');
            again.type = 'button';
            again.addEventListener('click', () => { void retry(); });
            box.append(again);
          }
          return box;
        },
        // The sentence names the exact setting. 'This is unavailable' sends
        // someone hunting through Wanigan's preferences on a screen they are
        // not holding; 'Wanigan Settings → Phone monitor' is one place to look.
        off(title, sentence) { return uiBox('off', title, sentence); },
        // Call this only once observed() is true. Nothing has been established
        // about the Mac before the first poll returns, and 'nothing is running'
        // written from no reading at all is the empty fleet on a sleeping Mac
        // wearing a different screen's name.
        empty(claim, note) {
          const box = uiBox('empty', claim, note);
          if (ui.observed() && !ui.fresh()) {
            box.append(node('p', 'state-dated',
              'That reading is ' + ago(lastGoodAt) + ' old, so it may have changed since.'));
          }
          return box;
        },
        // Has any poll ever returned on this device, and is the current reading
        // live? Every claim a screen makes about the Mac has to pass these.
        observed() { return lastGoodAt > 0; },
        fresh() { return connectionState === 'connected'; },
        showing(viewId) { return showingView() === viewId; },
        // Register a screen's read. It runs when the screen comes on screen and
        // again on each poll that returns while it is still there — never while
        // another screen is up, and never while the page is in the background.
        // The returned function is that same read on demand: hand it to
        // ui.failed() as the retry, or call it after an action that changed
        // what the screen is showing.
        watch(viewId, load) {
          const watcher = { viewId: viewId, load: load, busy: false };
          viewWatchers.push(watcher);
          const refresh = () => runWatcher(watcher);
          if (showingView() === viewId) void refresh();
          return refresh;
        },
      };`;
}

/**
 * Attaching the frame's two watchers: the one that notices which screen is on,
 * and the one that notices the Mac answered.
 *
 * render() is called once per poll that came back, which makes it the honest
 * tick — it already carries the backoff, the pairing gate and the
 * page-in-background gate, and a timer of our own would carry none of them.
 * Extending it from the wiring is the same move alerts.ts makes for the same
 * reason: a section owns its module and nothing in the shared script.
 */
function uiWiring(): string {
  return `      try {
        const renderWithoutViews = render;
        render = (snapshot) => { renderWithoutViews(snapshot); refreshVisibleView(); };
      } catch (ignored) {
        // If a later refactor makes render() unassignable, every watched screen
        // still refreshes when you open it — the observer below is independent
        // — but it stops following the Mac. Say that in the panels rather than
        // letting a screen go quietly out of date.
        viewTickFault = 'This page could not follow the Mac, so this screen only updates when you open it. Reload it.';
      }
      // Which screen is on is a DOM fact, so it is read as one. Watching the
      // container rather than calling into the router keeps the rule true for
      // every way a view can change — a tab, the sheet, a back swipe, the
      // dashboard appearing at all once pairing succeeds.
      new MutationObserver(() => {
        const shown = showingView();
        if (shown === watchedView) return;
        watchedView = shown;
        refreshVisibleView();
      }).observe(dashboard, { attributes: true, attributeFilter: ['class'], subtree: true });`;
}

/**
 * The frame. It owns the parts of the page that belong to no single screen —
 * the head, the header, the pairing and error notices, the navigation, the
 * container the ten screens are composed into, and the footer — and nothing
 * else.
 *
 * Fleet, Agent, Git and Device are built; mobileViewsMarkup fills the other six
 * from the record in shared/mobile-nav.ts with a sentence naming what will be
 * there.
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
${mobileViewsMarkup({ fleet: sectionMarkup('dashboard'), agent: agentView(remoteControl), git: sectionMarkup('git'), spend: sectionMarkup('spend'), runs: sectionMarkup('manage'),
    goals: sectionMarkup('goals'), learning: sectionMarkup('learning'), scout: sectionMarkup('scout'), device: sectionMarkup('device') })}
    </section>
    <footer id="updated">No fleet data yet.</footer>
  </main>
${navBarMarkup()}
${navSheetMarkup()}
  <script nonce="${nonce}">
${mobileScript(remoteControl, {
    // The shared states come first in both halves: every screen's fragment is
    // free to call ui.* by the time its own code runs, and the frame's two
    // watchers are attached before any screen registers a read with them.
    script: [uiScript(), navScript(), sectionScript()].join('\n'),
    wiring: [uiWiring(), navWiring(), sectionWiring()].join('\n'),
  })}
  </script>
</body>
</html>`;
}
