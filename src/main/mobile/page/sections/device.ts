import { MOBILE_ABSENT } from '../../../../shared/mobile-nav';
import { labelForTab } from '../../../../shared/routes';
import type { MobileSection } from '../sections';

/**
 * The screen about the device you are holding, rather than about the fleet it
 * is watching.
 *
 * It answers three questions the rest of the page leaves the operator to infer.
 * What is this connection actually doing — including that the poll steps itself
 * out towards a minute while the Mac is asleep, which is the difference between
 * "checking twenty times a minute" and "checking once". What is this device
 * allowed to do, from what Wanigan reported rather than from what the page
 * hopes. And which desktop surfaces are deliberately not here: an operator who
 * opens the sheet, finds no Settings and no Skills, and is told nothing has to
 * decide for themselves whether that is a decision or an unfinished build.
 * Naming the absent four with a reason each is the point of the screen.
 *
 * Everything it shows already crosses on /api/status or lives in this browser,
 * so it adds no route and puts nothing new on the wire — no path, no process
 * id, no ntfy topic. Unpairing is local for the same reason: a device can
 * forget its own token, and revoking that token for every device is a rotation
 * at the Mac.
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
const ABSENT_ROWS = MOBILE_ABSENT.map((entry) => `            <div class="device-absent-row">
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

          <h2>What stays on the Mac</h2>
          <p class="device-lead">These Wanigan screens have no phone version, on purpose. Each is here with its reason, so a gap in the menu is a decision you can read rather than one you have to guess at.</p>
          <div class="device-absent">
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
    .device-lead { color:var(--dim); font-size:12px; margin-bottom:10px; }
    .device-absent { display:grid; gap:9px; }
    .device-absent-row { padding:14px; border:1px solid var(--line); border-radius:13px; background:var(--panel); }
    .device-absent-row strong { display:block; color:var(--ink); margin-bottom:3px; }
    .device-absent-row span { color:var(--dim); font-size:13px; }
    .device-unpair.armed { border-color:color-mix(in srgb,var(--critical) 55%,var(--line)); }
    .device-unpair button { margin-top:13px; }
    .device-unpair-note:empty { display:none; }`,
  script: `
      let deviceHost = '';
      let deviceVersion = '';
      let deviceAlerts = null;
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

      // What this device gets once the page is closed, framed as a property of
      // the device rather than of the outbound path — the alert panel on the
      // Fleet screen owns that path's own report. The last branch is the one
      // that matters: Wanigan publishes to a topic, and which devices are
      // subscribed to that topic is not something it can observe, so this screen
      // must not turn 'the publish succeeded' into 'your phone was told'.
      function deviceAlertRow() {
        const name = 'Reach you with this page closed';
        const state = deviceAlerts;
        if (!state) return deviceRow(name, 'unknown', 'Not known', 'Wanigan has not said yet whether it can alert you.');
        if (!state.enabled) {
          return deviceRow(name, 'cannot', 'No',
            'Phone alerts are switched off at the Mac, so nothing reaches this device once this page is closed.');
        }
        if (!state.ready) {
          return deviceRow(name, 'unknown', 'Not working',
            'Alerts are on, but Wanigan cannot publish one right now. The alert panel on the Fleet screen carries the reason it gave.');
        }
        return deviceRow(name, 'can', 'Through ntfy',
          'Wanigan publishes to your ntfy topic and the ntfy app is what shows the alert. Whether this device is subscribed to that topic is not something Wanigan can see from here, and this page cannot notify you by itself once it is closed.');
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
        byId('device-can').replaceChildren(deviceWatchRow(), deviceDriveRow(), deviceAlertRow());
      }

      // Store only. The paint is left to applyFreshness below, which poll()
      // calls immediately after this one: render() runs before
      // setConnection('connected'), so a screen that painted from here would
      // caption the first good reading of a live Mac in the past tense.
      function deviceReadFrom(snapshot) {
        deviceHost = String(snapshot.host || '');
        deviceVersion = String(snapshot.version || '');
        deviceAlerts = snapshot.alerts || null;
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
