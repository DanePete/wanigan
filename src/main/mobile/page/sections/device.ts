import { MOBILE_ABSENT } from '../../../../shared/mobile-nav';
import { labelForTab } from '../../../../shared/routes';
import type { MobileSection } from '../sections';

/**
 * The screen about the device you are holding, rather than about the fleet it
 * is watching. It is this phone's settings screen, and the settings it has are
 * the phone's own: what this device can do, how it is paired, what an alert to
 * it can actually be, and what it deliberately cannot change.
 *
 * It answers four questions the rest of the page leaves the operator to infer.
 * What is this connection actually doing — including that the poll steps itself
 * out towards a minute while the Mac is asleep, which is the difference between
 * "checking twenty times a minute" and "checking once". What is this device
 * allowed to do, from what Wanigan reported rather than from what the page
 * hopes. Whether anything will reach this phone once the page is closed, from
 * the alert path's own last attempt rather than from the fact that it is
 * switched on — a phone showing a calm fleet and a phone whose alerts have been
 * failing for two days look identical, and only one of them is safe to walk
 * away from. And which desktop surfaces are deliberately not here: an operator
 * who opens the sheet, finds no Settings and no Skills, and is told nothing has
 * to decide for themselves whether that is a decision or an unfinished build.
 *
 * That last section is the only place the product's shape is stated from the
 * phone's side, so it states it once and properly: a pairing token is proof a
 * device may read this fleet, not consent to spend money or widen what Wanigan
 * may do, which is why the switches are read here and changed at the Mac and
 * why four desktop screens have no phone version at all.
 *
 * Everything it shows already crosses on /api/status or lives in this browser,
 * so it adds no route and puts nothing new on the wire — no path, no process
 * id, no ntfy topic. The alert state is the case worth naming: the phone is
 * told whether the path works and how the last publish ended, never the topic
 * or the server that make it work, and the two sentences it does print
 * (`blocked` and `lastReason`) have had every URL and the topic itself stripped
 * out of them twice before they reach here — once where the result is retained
 * in mobile/push.ts, once at the wire in mobile/snapshot.ts. Unpairing is local
 * for the same family of reasons: a device can forget its own token, and
 * revoking that token for every device is a rotation at the Mac.
 *
 * It draws no ui.reading/failed/off/empty box, and that is not an oversight.
 * Those four are renderings of an absence, and this screen has none: every row
 * on it has an answer before the first poll returns and a different, honestly
 * dated answer after the Mac goes quiet. What it does take from the frame is
 * the cadence — ui.watch() rather than a timer of its own — and ui.fresh(), so
 * "now" means the same thing here as on every other screen.
 */

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The absent four, rendered from the record at build time rather than by the
 * page's script. They are a property of this build, not of this connection, so
 * they have to be readable on a phone that has never reached the Mac — which is
 * exactly when an operator is most likely to be wondering why a screen they
 * expected is missing.
 */
const ABSENT_ROWS = MOBILE_ABSENT.map((entry) => `            <div class="device-item">
              <strong>${esc(labelForTab(entry.tab))}</strong>
              <span>${esc(entry.reason)}</span>
            </div>`).join('\n');

/**
 * Typed against MobileSection with the slot held apart, because 'device' is not
 * in MobileSectionSlot yet — registering this screen widens that union, imports
 * this module and adds one line to MOBILE_SECTIONS, and shell.ts asks for the
 * markup with sectionMarkup('device'). A cast to the current union would have
 * compiled and then composed the screen into no slot at all, which is a blank
 * tab: the same lie as an empty fleet on a sleeping Mac.
 */
type DeviceSection = Omit<MobileSection, 'slot'> & { slot: 'device' };

export const DEVICE_SECTION: DeviceSection = {
  id: 'device',
  anchorId: 'device',
  slot: 'device',
  markup: `        <section id="device" class="device">
          <h2>This connection</h2>
          <div class="notice device-link">
            <strong id="device-link-claim">This device has not reached Wanigan yet.</strong>
            <div class="device-facts">
              <div class="device-fact"><span>Mac</span><strong id="device-host">Not read yet</strong></div>
              <div class="device-fact"><span>Wanigan</span><strong id="device-version">Not read yet</strong></div>
              <div class="device-fact"><span>Last answered</span><strong id="device-seen">Never on this device</strong></div>
              <div class="device-fact"><span>Asking</span><strong id="device-poll">every 3 seconds</strong></div>
            </div>
            <p id="device-poll-note" class="why"></p>
          </div>

          <h2>What this device can do</h2>
          <div id="device-can" class="device-can"></div>

          <h2>Alerts to this device</h2>
          <div id="device-push" class="notice device-push">
            <strong id="device-push-claim">Checking whether this device can be alerted.</strong>
            <p id="device-push-why" class="why"></p>
            <button id="device-push-act" type="button" class="secondary hidden"></button>
          </div>
          <div id="device-alert-row" class="device-can"></div>
          <div class="notice device-alert-note">
            <strong>What an alert can actually be on this device.</strong>
            <div class="device-facts">
              <div class="device-fact"><span>Last attempt</span><strong id="device-alert-last">Not read yet</strong></div>
              <div class="device-fact"><span>This page</span><strong id="device-alert-mode">Not read yet</strong></div>
            </div>
            <p class="why">With alerts on, the Mac sends a notification to this device through your browser's push service, encrypted so that only this device can read it — the service carries it and cannot see what it says. It arrives with this app closed and the screen locked, which is the whole point of it. While the page is open it also raises the notice at the top of Fleet and puts a count in the tab title, and those two work whether or not you switch anything on. On iPhone and iPad the notification needs this app added to the Home Screen: iOS delivers Web Push to an installed web app and to nothing else, so the button above says so rather than asking for a permission that would not be honoured.</p>
          </div>

          <h2>Stop everything</h2>
          <div id="device-halt-panel" class="notice device-halt">
            <strong>Halt the whole fleet from here.</strong>
            <span>Kills every agent, stops the queue and the schedules, and disarms unattended dispatch. Nothing starts again until it is cleared at the Mac — including from this device, because deciding the danger has passed is not something to do from a lock screen. Working trees are left exactly as the agents left them.</span>
            <button id="device-halt" type="button" class="secondary">Halt everything</button>
            <p id="device-halt-note" class="why device-halt-note" role="status"></p>
          </div>

          <h2>What stays on the Mac</h2>
          <p class="device-lead">This phone holds a pairing token. That is proof a device may read this fleet — it is not consent to spend money, to trust a plugin, or to widen what Wanigan is allowed to do, and a token lifted off a lost phone must not be able to do those things either. So the switches below are read here and changed only at the Mac, and the screens under them have no phone version at all.</p>
          <div class="device-list">
            <div class="device-item">
              <strong>Remote control</strong>
              <span>Whether this device may type into a session at all, rather than only watch one. Wanigan Settings → Phone monitor.</span>
            </div>
            <div class="device-item">
              <strong>Phone alerts</strong>
              <span>Whether the Mac sends at all, on either channel, and the ntfy server and topic it publishes to. None of that ever crosses to this device — it is told whether the path works, and nothing that would let it, or anyone else holding this token, subscribe in its place. The one alert setting this device owns is the switch above, because it is the only one whose consent belongs to the device. Wanigan Settings → Phone monitor.</span>
            </div>
            <div class="device-item">
              <strong>Repository review</strong>
              <span>Whether the Git screen may read which files changed and what changed in them, run that project's saved review gate, and commit what git already tracks. It is the one thing that puts a file path on this wire, and the only one that writes to a repository — never adding an untracked file, and never pushing — so it is off on every install and every upgrade, and switching the agent console on does not switch it on.</span>
            </div>
            <div class="device-item">
              <strong>The pairing link</strong>
              <span>Rotating it revokes every paired device at once, this one included. That is the only way to take a lost phone's access away, and only the Mac can do it.</span>
            </div>
          </div>
          <p class="device-lead">These Wanigan screens have no phone version, on purpose. Each is here with its reason, so a gap in the menu is a decision you can read rather than one you have to guess at.</p>
          <div class="device-list">
${ABSENT_ROWS}
          </div>

          <h2>Unpair this device</h2>
          <div id="device-unpair-panel" class="notice device-unpair">
            <strong>Unpairing forgets the pairing token stored in this browser.</strong>
            <span>It does not revoke that token on the Mac. The pairing link keeps working, this device can pair again with it, and any other device already holding it is untouched.</span>
            <p class="why">To revoke the token everywhere, rotate the pairing link in Wanigan Settings → Phone monitor. That is a different action, and only the Mac can take it.</p>
            <button id="device-unpair" type="button" class="secondary">Unpair this device</button>
            <p id="device-unpair-note" class="why device-unpair-note" role="status"></p>
          </div>
        </section>`,
  style: `    .device > h2:first-child { margin-top:4px; }
    .device-facts { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin-top:12px; }
    .device-fact { display:grid; gap:2px; min-width:0; }
    .device-fact span { color:var(--faint); font-size:10px; text-transform:uppercase; letter-spacing:.06em; }
    .device-fact strong { display:block; margin:0; color:var(--ink); font-size:14px; font-variant-numeric:tabular-nums; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .device-can { display:grid; gap:9px; }
    .device-row { display:grid; gap:4px; padding:14px; border:1px solid var(--line); border-radius:13px; background:linear-gradient(145deg,var(--panel),var(--panel-raised)); }
    .device-row-top { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
    .device-row-name { font-weight:720; }
    .device-row-state { flex:none; font-size:11px; font-weight:760; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); }
    .device-row.can .device-row-state { color:var(--good); }
    .device-row.cannot .device-row-state { color:var(--dim); }
    .device-row.unknown .device-row-state { color:var(--serious); }
    .device-row p { color:var(--dim); font-size:13px; }
    .device-alert-note { margin-top:9px; }
    .device-push { display:grid; gap:7px; margin-bottom:9px; }
    .device-push.on { border-color:color-mix(in srgb,var(--good) 45%,var(--line)); }
    .device-push.wrong { border-color:color-mix(in srgb,var(--serious) 50%,var(--line)); }
    .device-push .why:empty { display:none; }
    .device-push button { justify-self:start; margin-top:4px; }
    .device-push button.hidden { display:none; }
    .device-lead { color:var(--dim); font-size:12px; margin-bottom:10px; }
    .device-list + .device-lead { margin-top:18px; }
    .device-list { display:grid; gap:9px; }
    .device-item { padding:14px; border:1px solid var(--line); border-radius:13px; background:var(--panel); }
    .device-item strong { display:block; color:var(--ink); margin-bottom:3px; }
    .device-item span { color:var(--dim); font-size:13px; }
    .device-halt { display:grid; gap:7px; }
    .device-halt.armed { border-color:var(--critical); }
    .device-halt button { justify-self:start; margin-top:4px; }
    .device-halt-note:empty { display:none; }
    .device-unpair.armed { border-color:color-mix(in srgb,var(--critical) 55%,var(--line)); }
    .device-unpair button { margin-top:13px; }
    .device-unpair-note:empty { display:none; }`,
  script: `
      let deviceHost = '';
      let deviceVersion = '';
      let deviceAlerts = null;
      let deviceGeneratedAt = 0;
      let deviceFault = '';
      let deviceArmedAt = 0;
      const DEVICE_ARM_MS = 8000;

      function deviceWords(id, value) {
        // The same reason the alert panel does it: this screen is repainted on
        // every poll, and handing a node the sentence it already holds makes
        // VoiceOver read it out again.
        const target = byId(id);
        if (target.textContent !== value) target.textContent = value;
      }

      // The interval the page will actually wait, not the one it would prefer.
      // poll() doubles pollDelay towards POLL_SLOW_MS on every failure, so a
      // screen that printed the nominal three seconds would tell an operator on
      // a train that Wanigan is checking twenty times a minute while it is in
      // fact checking once. This screen exists to say what is true of this
      // connection, and the nominal number is not.
      function devicePollWords(ms) {
        const seconds = Math.max(1, Math.round(Number(ms) / 1000));
        if (seconds < 60) return 'every ' + seconds + ' seconds';
        const minutes = Math.round(seconds / 60);
        return 'every ' + minutes + (minutes === 1 ? ' minute' : ' minutes');
      }

      function deviceRow(name, tone, stateWord, sentence) {
        const row = node('div', 'device-row ' + tone);
        const top = node('div', 'device-row-top');
        // The word carries the state and the colour only repeats it, so a row
        // still reads correctly in a screenshot, in sunlight, and to someone
        // who cannot tell the good token from the dim one.
        top.append(node('div', 'device-row-name', name), node('div', 'device-row-state', stateWord));
        row.append(top, node('p', '', sentence));
        return row;
      }

      // Every capability sentence has to survive being read twenty minutes
      // after the Mac went quiet, so the past-tense half is written once here
      // rather than guessed at in each branch. Before the first poll returns the
      // honest anchor is the page load itself: the Mac served these bytes, so
      // the flag baked into them was true at that moment and at no other.
      function deviceAsOf() {
        return ui.observed() ? 'when the Mac last answered ' + ago(lastGoodAt) + ' ago' : 'when Wanigan served this page';
      }

      function deviceWatchRow() {
        if (ui.fresh()) {
          return deviceRow('Watch the fleet', 'can', 'Yes',
            'This device is paired and reading the fleet ' + devicePollWords(pollDelay) +
            '. It receives session status, spend and token counts — never a file path, a process id or a transcript.');
        }
        if (ui.observed()) {
          return deviceRow('Watch the fleet', 'unknown', 'Not now',
            'It last read the fleet ' + ago(lastGoodAt) + ' ago and the Mac has not answered since, so the Fleet screen is showing that reading rather than the fleet right now.');
        }
        return deviceRow('Watch the fleet', 'unknown', 'Not yet',
          'Nothing has been heard from the Mac on this device, so there is no fleet reading to show. That is usually the pairing token or the private tunnel in front of Wanigan rather than the Mac being asleep.');
      }

      function deviceDriveRow() {
        const fresh = ui.fresh();
        if (remoteControlEnabled) {
          return deviceRow('Drive a session', fresh ? 'can' : 'unknown', fresh ? 'Yes' : 'Was on',
            'Remote control ' + (fresh ? 'is on at the Mac' : 'was on ' + deviceAsOf()) +
            ', so this device can open a terminal, interrupt a turn, and type into the session — a message, or one of the arrow, Enter and Escape keys a waiting prompt needs. That is how a permission prompt gets answered from here: by typing the same answer you would type at the Mac.');
        }
        return deviceRow('Drive a session', 'cannot', 'No',
          'Remote control ' + (fresh ? 'is off at the Mac' : 'was off ' + deviceAsOf()) +
          ', so this device can only watch. Turn it on in Wanigan Settings → Phone monitor.');
      }

      // How long ago the alert was attempted, without ever subtracting one
      // machine's clock from another's.
      //
      // lastAt is stamped by the Mac and everything else dated on this screen is
      // stamped here, so Date.now() - lastAt would print however far the two
      // clocks disagree as an age — and it fails in the direction that matters,
      // because a Mac running a few minutes ahead makes a publish that failed an
      // hour ago read as 'just now'. Both differences below are taken inside a
      // single clock: how long before that reading the attempt happened, on the
      // Mac, plus how long ago that reading arrived, here. Their sum is the age
      // whatever the clocks think of each other.
      function deviceAlertAge(at) {
        if (!at || !deviceGeneratedAt || !lastGoodAt) return null;
        return Math.max(0, deviceGeneratedAt - at) + Math.max(0, Date.now() - lastGoodAt);
      }

      function deviceAlertAgo(at) {
        const age = deviceAlertAge(at);
        return age === null ? '' : ago(Date.now() - age) + ' ago';
      }

      // The reason usually already names the status it came back with, and
      // 'failed (HTTP 403): ntfy returned HTTP 403' reads as two failures.
      function deviceAlertFailure(state) {
        // The trailing full stop goes because this string is always followed by
        // the clause saying whether Wanigan will try again, and 'within 8
        // seconds. — Wanigan will try the next one' reads as a typo. Done with
        // endsWith rather than a regex on purpose: this fragment is a template
        // literal, which eats a lone backslash, so /\\.$/ written here reaches
        // the browser as /.$/ and quietly truncates every reason by one
        // character — 'HTTP 403' served as 'HTTP 40'.
        const raw = state.lastReason || 'no reason was recorded';
        const why = raw.endsWith('.') ? raw.slice(0, -1) : raw;
        const code = state.lastHttpStatus && why.indexOf('HTTP ' + state.lastHttpStatus) < 0
          ? ' (HTTP ' + state.lastHttpStatus + ')' : '';
        return code + ': ' + why;
      }

      // What this device gets once the page is closed, framed as a property of
      // the device rather than of the outbound path — the alert panel on the
      // Fleet screen owns that path's own report. Every branch below is read
      // from the state the Mac sent: a path that is switched on and has been
      // rejected for two days is a different answer from one that is switched on
      // and working, and a screen that stopped at 'enabled' would have given
      // both of them the same one. The last branch is the one that matters:
      // Wanigan publishes to a topic, and which devices are subscribed to that
      // topic is not something it can observe, so this screen must not turn 'the
      // publish succeeded' into 'your phone was told'.
      function deviceAlertRow() {
        const name = 'Reach you with this page closed';
        const state = deviceAlerts;
        if (!state) {
          return deviceRow(name, 'unknown', 'Not known',
            'Wanigan has not said yet whether it can alert you. That answer arrives with the first reading rather than being assumed here.');
        }
        // Whether the path is switched on is a fact about the Mac, so it moves
        // into the past tense the moment the Mac stops answering — the same rule
        // the drive row above follows. What the last publish did is already
        // past, and stays in the tense it happened in.
        const fresh = ui.fresh();
        if (!state.enabled) {
          return deviceRow(name, 'cannot', 'No',
            'Phone alerts ' + (fresh ? 'are switched off at the Mac' : 'were switched off ' + deviceAsOf()) +
            ', so nothing reaches this device once this page is closed. Wanigan Settings → Phone monitor is where they are switched back on.');
        }
        if (!state.ready) {
          return deviceRow(name, 'unknown', 'Not working',
            (fresh ? 'Alerts are on, but Wanigan cannot publish one right now' : 'Alerts were on, but Wanigan could not publish one ' + deviceAsOf()) +
            ': ' + (state.blocked || 'it did not say why.'));
        }
        const when = deviceAlertAgo(state.lastAt);
        if (state.lastOutcome === 'failed') {
          return deviceRow(name, 'unknown', 'Failing',
            'The last alert did not get through' + (when ? ' ' + when : '') +
            deviceAlertFailure(state) +
            (state.retryable ? ' — Wanigan will try the next one by itself.' : ' — Wanigan will not try again until that is fixed.'));
        }
        // Which channel carried it, named from what the Mac reported rather
        // than assumed. The two are not interchangeable to somebody standing
        // here: 'the Wanigan app' is a notification this device either did or
        // did not agree to receive, and 'ntfy' is a separate app that has to be
        // installed and subscribed before the word means anything at all.
        const channels = state.channels || { webPush: false, ntfy: false };
        const via = channels.webPush && channels.ntfy ? 'App and ntfy'
          : channels.webPush ? 'Through the app'
            : channels.ntfy ? 'Through ntfy' : 'On';
        if (state.lastOutcome === 'sent') {
          return deviceRow(name, 'can', via,
            'An alert was accepted' + (when ? ' ' + when : '') +
            '. Whether this device showed it is not reported back: Wanigan hands the notification to a push service and never hears what became of it.');
        }
        if (state.lastOutcome === 'skipped') {
          return deviceRow(name, 'can', via,
            'The last alert' + (when ? ' ' + when : '') +
            ' was not sent, because alerts were switched off at the moment it happened. Nothing has been sent since.');
        }
        return deviceRow(name, 'can', via,
          (fresh ? 'Wanigan can send an alert' : 'Wanigan could send an alert ' + deviceAsOf()) +
          ', and nothing has needed one yet, so this path has not been proved end to end from this device. A test send from Wanigan Settings → Phone monitor is what proves it.');
      }

      // Dated from the reading, and worded from the outcome the Mac reported.
      // 'None yet' is the one value here that is a claim rather than a
      // measurement, and it is only ever printed for lastOutcome 'none', which
      // is what the Mac says when it has never attempted a publish at all.
      function deviceAlertLast(state) {
        if (!state) return 'Not read yet';
        if (state.lastOutcome === 'none') return 'None yet';
        const word = state.lastOutcome === 'sent' ? 'Sent'
          : state.lastOutcome === 'failed' ? 'Failed' : 'Skipped';
        const when = deviceAlertAgo(state.lastAt);
        return when ? word + ' ' + when : word + ' · not dated';
      }

      // Whether this page is running as an installed Home Screen app is a fact
      // about this browser, so it is asked of this browser rather than inferred
      // from the user agent. It matters next to the sentence below it: the
      // answer to 'would installing it fix my alerts' is no either way, and an
      // operator who has already installed it deserves to see the page say so
      // about the app they are actually holding. A browser that can be asked
      // neither question is told it is not known rather than assumed to be a
      // tab.
      function deviceDisplayWords() {
        if (navigator.standalone === true) return 'Home Screen app';
        try {
          if (window.matchMedia('(display-mode: standalone)').matches) return 'Home Screen app';
          if (window.matchMedia('(display-mode: browser)').matches) return 'Browser tab';
        } catch (ignored) { /* a browser with no matchMedia cannot be asked */ }
        return navigator.standalone === false ? 'Browser tab' : 'Not known';
      }

      function paintDevice() {
        const fresh = ui.fresh();
        deviceWords('device-link-claim', deviceFault || (fresh
          ? 'Paired, and reading this Mac now.'
          : ui.observed()
            ? 'Paired, but the Mac stopped answering ' + ago(lastGoodAt) + ' ago.'
            : 'This device has not reached Wanigan yet.'));
        // 'Last answered' is measured from when the bytes arrived here, not from
        // the snapshot's generatedAt. That field is the Mac's clock, and
        // subtracting it from this device's turns a couple of minutes of skew
        // into a staleness that never happened.
        deviceWords('device-host', deviceHost || 'Not read yet');
        deviceWords('device-version', deviceVersion || (ui.observed() ? 'Not reported' : 'Not read yet'));
        deviceWords('device-seen', ui.observed() ? ago(lastGoodAt) + ' ago' : 'Never on this device');
        deviceWords('device-poll', devicePollWords(pollDelay));
        deviceWords('device-poll-note', pollDelay > POLL_FAST_MS
          ? 'That is the backed-off interval, not the usual one. A phone retrying a sleeping Mac ' + devicePollWords(POLL_FAST_MS) +
            ' spends radio and battery for nothing, so the wait doubles towards ' + devicePollWords(POLL_SLOW_MS) +
            ' and drops straight back on the first answer. Bringing this page to the front asks again immediately.'
          : 'Bringing this page back to the front asks again immediately, and the wait doubles towards ' + devicePollWords(POLL_SLOW_MS) + ' for as long as the Mac is not answering.');
        byId('device-can').replaceChildren(deviceWatchRow(), deviceDriveRow());
        byId('device-alert-row').replaceChildren(deviceAlertRow());
        deviceWords('device-alert-last', deviceAlertLast(deviceAlerts));
        deviceWords('device-alert-mode', deviceDisplayWords());
        paintPush();
      }

      // Store only. The paint is left to applyFreshness below, which poll()
      // calls immediately after this one: render() runs before
      // setConnection('connected'), so a screen that painted from here would
      // caption the first good reading of a live Mac in the past tense.
      function deviceReadFrom(snapshot) {
        deviceHost = String(snapshot.host || '');
        deviceVersion = String(snapshot.version || '');
        deviceAlerts = snapshot.alerts || null;
        // Kept for deviceAlertAge() alone: it is the Mac's own clock at the
        // moment it read the alert path, which is the only thing lastAt can
        // honestly be subtracted from.
        deviceGeneratedAt = Number(snapshot.generatedAt) || 0;
      }

      // ── alerts to this device ────────────────────────────────────
      // Web Push, and the three facts that shape every branch below.
      //
      // iOS delivers a web app's notification only to an app that has been
      // added to the Home Screen. In a Safari tab there is no push at all, so
      // the button is not offered there — asking for a permission that cannot
      // be honoured produces a device that looks subscribed and never buzzes,
      // which is worse than saying no.
      //
      // Notification.requestPermission() is honoured only inside a user
      // gesture. That is why the call below is the first statement of the tap
      // and everything else is awaited after it: one await before it and Safari
      // refuses, silently, with a promise that resolves to 'default'.
      //
      // A subscription is bound to the key it was created with. When the Mac
      // rotates that key every subscription on every device stops working, and
      // nothing tells the device — so the key is remembered here and compared
      // on every open, and a mismatch is repaired by subscribing again rather
      // than reported as a fault the operator has to understand.
      const PUSH_KEY = 'wanigan.mobile.pushkey';
      const PUSH_WANTED = 'wanigan.mobile.pushon';
      // This device's own name for itself, generated once and kept. Safari
      // rotates a Home Screen app's push endpoint on its own — a subscription
      // that goes inactive after a week or two, or comes back as a completely
      // different one after a restart, is the common report — and without a
      // stable id the Mac saw each rotation as a *new device*. One phone became
      // eight rows, seven of them dead, and the cap then evicted the operator's
      // iPad to make room for the eighth copy of their phone.
      const PUSH_CLIENT = 'wanigan.mobile.pushclient';
      let pushState = 'unknown';
      let pushWhy = '';
      let pushBusy = false;

      function pushRemember(name, value) {
        // Safari in a private window throws on write rather than returning.
        try { if (value === null) localStorage.removeItem(name); else localStorage.setItem(name, value); }
        catch (ignored) { /* the preference is a convenience, not state the page needs */ }
      }
      function pushRecall(name) {
        try { return localStorage.getItem(name) || ''; } catch (ignored) { return ''; }
      }

      function pushClientId() {
        let id = pushRecall(PUSH_CLIENT);
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
          // randomUUID is not available on every browser this page has to run
          // in, and this value only has to be unique among one operator's
          // devices — it is not a credential and proves nothing.
          id = 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36);
          pushRemember(PUSH_CLIENT, id);
        }
        return id;
      }

      function pushSupported() {
        return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
      }

      // Asked of the browser rather than inferred from the user agent, the same
      // way deviceDisplayWords() does it, and for a sharper reason here: this
      // decides whether a button appears at all.
      function pushInstalled() {
        if (navigator.standalone === true) return true;
        try { return window.matchMedia('(display-mode: standalone)').matches; } catch (ignored) { return false; }
      }

      // base64url in, bytes out. applicationServerKey takes a string in current
      // browsers and a BufferSource in the ones that shipped Web Push first;
      // the array satisfies both.
      function pushBytes(value) {
        const padded = value.replace(/-/g, '+').replace(/_/g, '/');
        // Three '=' and not four. base64url drops the padding, and a length
        // ending 87 characters — which is exactly what a 65-byte P-256 point
        // encodes to, so it is every key this ever sees — needs one '=' back.
        // A four-character source string here adds two, and a real atob refuses
        // the result outright: "The string to be decoded is not correctly
        // encoded". Node's Buffer.from(s, 'base64') accepts it, which is why a
        // round-trip test written against that shim went green on the broken
        // version and only a browser ever failed.
        const raw = atob(padded + '==='.slice((padded.length + 3) % 4));
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
      }

      function pushKeyText(subscription, name) {
        const raw = subscription.getKey(name);
        if (!raw) return '';
        const bytes = new Uint8Array(raw);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      }

      // What this device calls itself in the Mac's device list. Deliberately a
      // category rather than anything that identifies the hardware: it exists so
      // an operator can tell 'iPhone' from 'iPad' when forgetting one, and a
      // full user-agent string on the Mac's screen would be a fingerprint kept
      // for no reason. iPadOS reports itself as a Macintosh, so the touch count
      // is what tells the two apart.
      function pushLabel() {
        const ua = navigator.userAgent || '';
        if (/iPad/.test(ua)) return 'iPad';
        if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'iPad';
        if (/iPhone/.test(ua)) return 'iPhone';
        if (/Android/.test(ua)) return 'Android device';
        if (/Macintosh/.test(ua)) return 'Mac';
        return 'Paired device';
      }

      function pushPost(path, payload) {
        return api(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem(KEY) },
          body: JSON.stringify(payload),
        });
      }

      /**
       * Bring this device's subscription in line with the Mac's.
       *
       * The interactive flag is the difference between a tap and a page load. A tap may
       * ask for permission and create a subscription; a load may only repair one
       * that already exists, because silently subscribing a device whose
       * operator switched alerts off — permission stays granted after they do —
       * would undo the one action this screen offers.
       */
      async function pushSync(interactive) {
        if (pushBusy) return;
        if (!pushSupported()) { pushState = 'unsupported'; paintDevice(); return; }
        if (!pushInstalled()) { pushState = 'not-installed'; paintDevice(); return; }
        if (!interactive && pushRecall(PUSH_WANTED) !== '1') { pushState = 'off'; paintDevice(); return; }

        // Before any await. See the note at the top of this block.
        const asking = interactive && Notification.permission === 'default'
          ? Notification.requestPermission()
          : null;

        pushBusy = true;
        pushWhy = '';
        paintDevice();
        try {
          if (asking) {
            const answer = await asking;
            if (answer !== 'granted') { pushState = 'denied'; return; }
          }
          if (Notification.permission !== 'granted') {
            pushState = Notification.permission === 'denied' ? 'denied' : 'off';
            return;
          }

          const registration = await navigator.serviceWorker.ready;
          const answer = await api('api/push/key');
          const key = String(answer.key || '');
          if (!key) throw new Error('Wanigan did not send a push key.');

          let subscription = await registration.pushManager.getSubscription();
          if (subscription && pushRecall(PUSH_KEY) !== key) {
            // Bound to a key the Mac no longer signs with. It cannot be
            // repaired, only replaced.
            try { await subscription.unsubscribe(); } catch (ignored) { /* already gone */ }
            subscription = null;
          }
          if (!subscription) {
            subscription = await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: pushBytes(key),
            });
          }

          await pushPost('api/push/subscribe', {
            endpoint: subscription.endpoint,
            keys: { p256dh: pushKeyText(subscription, 'p256dh'), auth: pushKeyText(subscription, 'auth') },
            label: pushLabel(),
            clientId: pushClientId(),
          });
          pushRemember(PUSH_KEY, key);
          pushRemember(PUSH_WANTED, '1');
          pushState = answer.enabled === false ? 'muted' : 'on';
        } catch (error) {
          pushState = 'error';
          pushWhy = error && error.message ? String(error.message) : 'The subscription did not go through.';
        } finally {
          pushBusy = false;
          paintDevice();
          // The alert path's own report is part of the next reading, and the
          // operator has just changed it. Waiting out the poll interval to see
          // the row agree with the button is how a working feature reads broken.
          void poll();
        }
      }

      /** Stop alerts to this device: tell the Mac first, then drop the subscription. */
      async function pushStop() {
        if (pushBusy || !pushSupported()) return;
        pushBusy = true;
        pushWhy = '';
        paintDevice();
        try {
          const registration = await navigator.serviceWorker.ready;
          const subscription = await registration.pushManager.getSubscription();
          if (subscription) {
            // The Mac is told before the browser forgets, because the endpoint
            // is the only name the Mac knows this device by — unsubscribing
            // first would leave a row nothing can ever match or remove.
            try { await pushPost('api/push/forget', { endpoint: subscription.endpoint }); }
            catch (ignored) { /* the row may already be gone; the local half still has to happen */ }
            try { await subscription.unsubscribe(); } catch (ignored) { /* already gone */ }
          }
          pushRemember(PUSH_WANTED, '0');
          pushRemember(PUSH_KEY, null);
          pushState = 'off';
        } catch (error) {
          pushState = 'error';
          pushWhy = error && error.message ? String(error.message) : 'This device could not be unsubscribed.';
        } finally {
          pushBusy = false;
          paintDevice();
          void poll();
        }
      }

      // One row of copy per state: the claim, the explanation, and what the
      // button does. Every one of them says what this device gets, because the
      // question the operator is asking on this screen is never 'what is the
      // state machine doing' — it is 'will my phone buzz'.
      function pushCopy() {
        if (pushBusy) return { claim: 'Working…', why: '', act: '', tone: '' };
        const remote = deviceAlerts && deviceAlerts.webPush ? deviceAlerts.webPush : null;
        switch (pushState) {
          case 'unsupported':
            return {
              claim: 'This browser cannot receive alerts.',
              why: 'It does not support Web Push, so nothing can reach it once this page is closed. On iPhone and iPad that means Safari; other browsers on iOS cannot do it at all.',
              act: '', tone: 'wrong',
            };
          case 'not-installed':
            return {
              claim: 'Add Wanigan to the Home Screen first.',
              why: 'iOS delivers a web app’s notification only to an installed app, never to a tab. Tap Share, then Add to Home Screen, and open Wanigan from the icon — this screen will offer the switch there.',
              act: '', tone: 'wrong',
            };
          case 'denied':
            return {
              claim: 'Notifications are blocked for this app.',
              why: 'The permission was declined, and only the device can give it back: open Settings → Notifications → Wanigan on this device and allow them, then come back here.',
              act: 'Try again', tone: 'wrong',
            };
          case 'error':
            return {
              claim: 'Alerts to this device did not switch on.',
              why: pushWhy,
              act: 'Try again', tone: 'wrong',
            };
          case 'muted':
            return {
              claim: 'This device is subscribed, but the Mac is not sending.',
              why: 'The subscription went through and Wanigan has it. Alerts to the Wanigan app are switched off in Wanigan Settings → Phone monitor, so nothing will be sent until they are switched back on there.',
              act: 'Stop alerts to this device', tone: 'wrong',
            };
          case 'on':
            return {
              claim: 'Alerts to this device are on.',
              why: 'Wanigan will notify this device when an agent is waiting for approval, stops on an error, or finishes a turn — with this app closed and the screen locked.'
                + (remote && remote.devices > 1 ? ' ' + remote.devices + ' devices are subscribed in all.' : ''),
              act: 'Stop alerts to this device', tone: 'on',
            };
          case 'off':
            return {
              claim: 'Alerts to this device are off.',
              why: 'Nothing reaches this device once this page is closed. Switching them on asks for notification permission once, and then Wanigan sends the same three states it shows on the Fleet screen.',
              act: 'Send alerts to this device', tone: '',
            };
          default:
            return { claim: 'Checking whether this device can be alerted.', why: '', act: '', tone: '' };
        }
      }

      function paintPush() {
        const copy = pushCopy();
        deviceWords('device-push-claim', copy.claim);
        deviceWords('device-push-why', copy.why);
        const button = byId('device-push-act');
        button.classList.toggle('hidden', !copy.act);
        if (copy.act && button.textContent !== copy.act) button.textContent = copy.act;
        button.disabled = pushBusy;
        const panel = byId('device-push');
        panel.classList.toggle('on', copy.tone === 'on');
        panel.classList.toggle('wrong', copy.tone === 'wrong');
      }

      // Two taps, like Unpair below and for a stronger reason: this one ends
      // every agent on the Mac. The arm expires, so a tap now and a pocket tap
      // later are never read as one decision.
      let haltArmedAt = 0;
      let haltBusy = false;

      function haltDisarm() {
        haltArmedAt = 0;
        byId('device-halt').textContent = 'Halt everything';
        byId('device-halt-panel').classList.remove('armed');
      }

      async function haltPull() {
        haltBusy = true;
        byId('device-halt').disabled = true;
        byId('device-halt').textContent = 'Stopping…';
        try {
          const result = await pushPost('api/halt', { reason: 'Stopped from a paired device.' });
          const counted = (result.stopped || [])
            .filter((row) => row && row.stopped > 0)
            .map((row) => row.stopped + ' ' + row.name)
            .join(', ');
          deviceWords('device-halt-note', 'Halted. ' + (counted || 'Nothing was running') +
            '. Nothing will start until it is cleared at the Mac.');
        } catch (error) {
          deviceWords('device-halt-note', 'The halt did not go through: ' +
            (error && error.message ? String(error.message) : 'the Mac did not answer.') +
            ' Nothing was stopped.');
        } finally {
          haltBusy = false;
          haltDisarm();
          byId('device-halt').disabled = false;
          void poll();
        }
      }

      function deviceDisarm() {
        deviceArmedAt = 0;
        byId('device-unpair').textContent = 'Unpair this device';
        byId('device-unpair-panel').classList.remove('armed');
      }`,
  wiring: `      try {
        // Two extensions of the shared script, because a section owns its own
        // module and nothing inside script.ts. render() is where the snapshot
        // is, and applyFreshness() is the tick: it runs on every poll outcome
        // through setConnection(), and again on the shared fifteen-second timer
        // while the Mac is quiet — which is the only moment 'last answered 2m
        // ago' needs redrawing. That is why this screen holds no interval of
        // its own; a second cadence would be a phone radio kept awake to
        // recompute a sentence the page is already recomputing.
        const renderBeforeDevice = render;
        render = (snapshot) => { renderBeforeDevice(snapshot); deviceReadFrom(snapshot); };
        const freshnessBeforeDevice = applyFreshness;
        applyFreshness = () => { freshnessBeforeDevice(); paintDevice(); };
      } catch (ignored) {
        // A screen that had quietly stopped following the Mac looks exactly
        // like a calm one, and this is the screen whose whole job is saying
        // what is true of this connection. Say it is frozen instead.
        deviceFault = 'This screen could not attach to the poll, so nothing below is being updated. Reload the page.';
      }
      // Opening this screen after twenty minutes away must not show the numbers
      // it was left with. It reads nothing over the network — the load is a
      // repaint — but ui.watch is how the frame tells a screen it is on.
      ui.watch('device', () => { paintDevice(); });
      byId('device-halt').addEventListener('click', () => {
        if (haltBusy) return;
        if (Date.now() - haltArmedAt > DEVICE_ARM_MS) {
          haltArmedAt = Date.now();
          byId('device-halt').textContent = 'Tap again to halt everything';
          byId('device-halt-panel').classList.add('armed');
          deviceWords('device-halt-note', 'This kills every agent on the Mac and stops the queue, the schedules and unattended dispatch. Only the Mac can start things again.');
          setTimeout(() => { if (Date.now() - haltArmedAt >= DEVICE_ARM_MS) haltDisarm(); }, DEVICE_ARM_MS + 200);
          return;
        }
        void haltPull();
      });
      byId('device-push-act').addEventListener('click', () => {
        // Deliberately not two-tap like Unpair below. That button destroys a
        // pairing the operator may not be able to re-create from where they are
        // standing; this one subscribes or unsubscribes a device, and both
        // directions are one tap away from being undone.
        if (pushState === 'on' || pushState === 'muted') { void pushStop(); return; }
        void pushSync(true);
      });
      // On open rather than on load: a subscription that the Mac lost, or one
      // bound to a key it has since rotated, is repaired here without the
      // operator being told anything happened. It is a no-op unless this device
      // was switched on, which is what keeps it from undoing a deliberate off.
      void pushSync(false);
      byId('device-unpair').addEventListener('click', () => {
        // Two taps. A thumb finds this button by accident on a screen it is
        // scrolling past, and a pairing link is not something you can re-scan
        // from a train. The arm expires, so a tap now and a pocket tap later
        // are never read as one decision.
        if (Date.now() - deviceArmedAt > DEVICE_ARM_MS) {
          deviceArmedAt = Date.now();
          byId('device-unpair').textContent = 'Tap again to unpair';
          byId('device-unpair-panel').classList.add('armed');
          deviceWords('device-unpair-note', 'This forgets the token in this browser only. The Mac is not told, and the pairing link keeps working.');
          setTimeout(() => { if (Date.now() - deviceArmedAt >= DEVICE_ARM_MS) deviceDisarm(); }, DEVICE_ARM_MS + 200);
          return;
        }
        deviceDisarm();
        localStorage.removeItem(KEY);
        deviceWords('device-unpair-note', 'Unpaired. This browser has forgotten the token; the Mac still holds it. Enter a pairing code, or open the pairing link again, to come back.');
        // poll() is what turns a missing token into the pairing form, and that
        // form is above this screen — so go to it, rather than leaving the
        // operator looking at a panel the next tick is about to hide.
        window.scrollTo(0, 0);
        void poll();
      });
      paintDevice();`,
};
