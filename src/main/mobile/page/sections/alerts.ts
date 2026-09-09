import type { MobileSection } from '../sections';

/**
 * Whether the operator will actually be told, and the one channel that works
 * without any setup at all.
 *
 * A phone showing a calm fleet and a phone whose alerts have been failing for
 * two days look identical, and only one of them is safe to walk away from. So
 * this screen says which of the two it is in words, from the alert state
 * /api/status now carries, and raises its own notice while the page is open —
 * the one signal that needs no subscription, no server and no permission
 * prompt.
 *
 * The notice is still not a notification, and the distinction still matters.
 * Wanigan does now deliver a real background notification, through Web Push to
 * this app once it is installed to the Home Screen and switched on from the
 * Device screen — but that is a thing the operator has to have done, on this
 * device, and this panel has no way to know whether they did. So it goes on
 * describing exactly what an open page can do, and points at the screen that
 * knows the rest.
 */
export const ALERTS_SECTION: MobileSection = {
  id: 'alerts',
  anchorId: 'alerts',
  slot: 'dashboard',
  markup: `      <section id="alerts" class="alerts">
        <div id="alert-attention" class="notice alert-attention hidden" role="status">
          <strong id="alert-attention-claim"></strong>
          <div id="alert-attention-list" class="alert-list"></div>
        </div>
        <p id="alert-path" class="alert-path">Wanigan has not said yet whether it can alert you.</p>
        <p id="alert-reach" class="alert-reach">This notice and the count in the tab title need this page open on screen. Anything that has to reach you with it closed is a notification, which Wanigan sends to this app once you switch it on under Device — or to the ntfy app, if that is how you have it set up.</p>
      </section>`,
  style: `    .alerts { display:grid; gap:7px; margin:2px 0 14px; }
    .alert-attention { border-color:color-mix(in srgb,var(--critical) 50%,var(--line)); }
    .alert-list { display:grid; gap:3px; margin-top:7px; font-variant-numeric:tabular-nums; }
    .alert-row { color:var(--dim); font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .alert-path { color:var(--dim); font-size:12px; }
    .alert-path.wrong { color:var(--serious); font-weight:700; }
    .alert-reach { color:var(--faint); font-size:11px; }`,
  script: `
      let alertRows = [];
      let alertPath = null;
      let alertListKey = '';
      let alertFault = '';

      function alertWords(id, value) {
        // Rewriting a live region with the same sentence every three seconds
        // makes VoiceOver read it out again, so touch the node only when the
        // words actually changed.
        const target = byId(id);
        if (target.textContent !== value) target.textContent = value;
      }

      function alertNeeds(session) {
        const kind = session && session.attention ? session.attention.kind : '';
        return kind === 'permission' || kind === 'error' || kind === 'finished';
      }

      function alertSummary(rows) {
        const counted = { permission: 0, error: 0, finished: 0 };
        rows.forEach((row) => { counted[row.attention.kind] += 1; });
        const parts = [];
        // Noun phrases rather than verbs: the same words have to read correctly
        // after 'needs you now' and after 'when the Mac last answered'.
        if (counted.permission) parts.push(counted.permission + ' waiting for approval');
        if (counted.error) parts.push(counted.error + (counted.error === 1 ? ' stopped on an error' : ' stopped on errors'));
        if (counted.finished) parts.push(counted.finished + ' finished');
        return parts.join(', ');
      }

      function alertRowText(row) {
        return (row.title || row.projectName || 'Agent session') + ' · ' +
          (row.attention.label || row.attention.kind) + ' · ' + ago(row.attention.since);
      }

      // Every branch is something the Mac reported about the outbound path. The
      // page never says an alert was delivered: a push service or an ntfy
      // server accepting the publication is the last event Wanigan observes,
      // and what the device did with it afterwards is not reported back to
      // anyone.
      function alertChannelWords() {
        const on = alertPath && alertPath.channels ? alertPath.channels : null;
        if (!on) return 'an alert channel';
        if (on.webPush && on.ntfy) return 'the Wanigan app and ntfy';
        if (on.webPush) return 'the Wanigan app';
        if (on.ntfy) return 'ntfy';
        return 'an alert channel';
      }

      function alertPathSentence() {
        if (alertFault) return alertFault;
        const state = alertPath;
        if (!state) return 'Wanigan has not said yet whether it can alert you.';
        if (!state.enabled) return 'Off · every alert channel is switched off, so nothing reaches this device while this page is closed. Wanigan Settings → Phone monitor on the Mac is where they are switched back on.';
        if (!state.ready) return 'Not working · ' + (state.blocked || 'Wanigan did not say why.');
        if (state.lastOutcome === 'failed') {
          const why = state.lastReason || 'no reason was recorded';
          // The reason usually already names the status it came back with, and
          // 'failed (HTTP 403): ntfy returned HTTP 403' reads as two failures.
          const code = state.lastHttpStatus && why.indexOf('HTTP ' + state.lastHttpStatus) < 0
            ? ' (HTTP ' + state.lastHttpStatus + ')' : '';
          return 'Failing · the last alert failed ' + ago(state.lastAt) + ' ago' + code + ': ' + why +
            (state.retryable ? ' — Wanigan will try the next one.' : ' — Wanigan will not retry until that is fixed.');
        }
        if (state.lastOutcome === 'sent') return 'On · the last alert was accepted ' + ago(state.lastAt) + ' ago through ' + alertChannelWords() + '. Whether a device showed it is not reported back.';
        if (state.lastOutcome === 'skipped') return 'On · the last alert was not sent, because alerts were switched off when it happened.';
        return 'On · Wanigan can alert you through ' + alertChannelWords() + ', and nothing has needed one yet. A test send from Wanigan Settings is what proves it end to end.';
      }

      // 'fresh' is passed in rather than read from connectionState, because
      // poll() calls render() before setConnection('connected'): a panel that
      // asked the connection machine during a render would read the *previous*
      // state and caption the very first reading of a live Mac with 'when the
      // Mac last answered 0s ago', beside a header saying Live. A snapshot
      // being rendered is current by definition; only the timer repaint below
      // has to ask whether it still is.
      function paintAlerts(fresh) {
        byId('alert-attention').classList.toggle('hidden', alertRows.length === 0);
        if (!alertRows.length) alertListKey = '';
        else {
          const summary = alertSummary(alertRows);
          alertWords('alert-attention-claim', fresh
            ? 'Needs you now: ' + summary + '.'
            : 'When the Mac last answered ' + ago(lastGoodAt) + ' ago: ' + summary + '.');
          const lines = alertRows.slice(0, 6).map(alertRowText);
          if (alertRows.length > lines.length) lines.push('and ' + (alertRows.length - lines.length) + ' more');
          const key = lines.join(' | ');
          if (key !== alertListKey) {
            alertListKey = key;
            byId('alert-attention-list').replaceChildren(...lines.map((line) => node('div', 'alert-row', line)));
          }
        }
        // A count in the tab title is the only alert that survives this page
        // being on another screen or behind another tab. It is not a
        // notification, and it stops claiming a number the moment the Mac stops
        // answering.
        const title = (alertRows.length && fresh ? '(' + alertRows.length + ') ' : '') + 'Wanigan Mobile';
        if (document.title !== title) document.title = title;
        alertWords('alert-path', alertPathSentence());
        byId('alert-path').classList.toggle('wrong',
          Boolean(alertPath) && (alertPath.ready !== true || alertPath.lastOutcome === 'failed'));
      }

      function renderAlerts(snapshot) {
        const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
        alertRows = sessions.filter(alertNeeds);
        alertPath = snapshot.alerts || null;
        paintAlerts(true);
      }`,
  wiring: `      try {
        // The shared render() calls each screen's renderer by name, and that
        // list was written before this screen existed; a section owns its own
        // module and nothing in the shared script. Extend the binding from here
        // instead. If a later refactor makes render() unassignable this throws,
        // and the panel then says so — a screen that quietly stopped watching
        // would be the exact silent failure it exists to end.
        const renderWithoutAlerts = render;
        render = (snapshot) => { renderWithoutAlerts(snapshot); renderAlerts(snapshot); };
      } catch (ignored) {
        alertFault = 'This page could not attach its alert panel, so it is not watching anything. Reload it.';
        paintAlerts(false);
      }
      // 'Needs you now' written twenty minutes ago is a claim about a fleet
      // nobody has heard from since, so the panel is re-worded on the same
      // cadence the connection label is aged on.
      setInterval(() => { if (!document.hidden) paintAlerts(connectionState === 'connected'); }, 15000);`,
};
