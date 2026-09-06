import type { MobileViewId } from '../../../../shared/mobile-nav';
import type { MobileSection } from '../sections';

/**
 * The Manage hub: what this Mac starts on a timer while nobody is watching it,
 * and the one button that stops it.
 *
 * A schedule is the only work in Wanigan that runs unattended, so it is the
 * only work an operator away from the desk cannot already reach — a session has
 * a terminal on the Agent screen, a run has the person who started it. Before
 * this screen, switching off a nightly fan-out meant going home.
 *
 * Four facts per row, and the fourth is the one this screen is for. Its name,
 * its cron in English, when it next fires — and how the last fire *actually*
 * ended, which is three or four different answers rather than one. A schedule
 * that has never fired, one whose last fire failed, one that was skipped
 * because the previous fire was still in the queue, and one Wanigan dispatched
 * and then never heard about again are four different facts about this Mac, and
 * the Schedules summary on the desktop used to render the last of those as "all
 * clear". A phone repeating that would be worse: it is the surface someone
 * checks precisely because they cannot see the Mac.
 *
 * Pause and resume are the only writes. Editing a cron and deleting a schedule
 * are Mac decisions — an expression is edited against a prompt this screen does
 * not show, and a delete throws away the run history that is the only audit of
 * unattended work there is. Pausing is reversible from the same button.
 */

/**
 * The screen this hub is composed into.
 *
 * Named once, as a MobileViewId, so that pointing it at a different destination
 * is one line and a type error if that destination does not exist. Today it is
 * Runs: shared/mobile-nav.ts has no 'manage' destination, and Runs is the entry
 * that already narrows the desktop's Schedules tab — its published hint is
 * "headless runs, and the schedules that start them without you". Sending this
 * markup to a view id the record does not contain would compose it into
 * nothing, which is a blank tab behind a live nav row: the same lie as an empty
 * fleet on a sleeping Mac.
 */
const MANAGE_VIEW: MobileViewId = 'runs';

/**
 * Typed with the slot held apart, the way device.ts does, because 'manage' is
 * not in MobileSectionSlot yet — registering this screen widens that union,
 * imports this module into MOBILE_SECTIONS, and has shell.ts ask for the markup
 * with sectionMarkup('manage'). A cast to the current union would have compiled
 * and then composed the screen into no slot at all.
 */
type ManageSection = Omit<MobileSection, 'slot'> & { slot: 'manage' };

export const MANAGE_SECTION: ManageSection = {
  id: 'manage',
  anchorId: 'manage',
  slot: 'manage',
  markup: `        <section id="manage" class="manage">
          <h2>Unattended work</h2>
          <p class="manage-lead">These start on this Mac on a timer, whether or not anyone is watching it. Times are read on the Mac, in the Mac's local time.</p>
          <div id="manage-list" class="manage-list"></div>
          <p id="manage-note" class="why manage-note" role="status"></p>
        </section>`,
  style: `    .manage > h2:first-child { margin-top:4px; }
    .manage-lead { color:var(--dim); font-size:12px; margin-bottom:10px; }
    .manage-list { display:grid; gap:9px; }
    .manage-row { display:grid; gap:6px; padding:14px; border:1px solid var(--line); border-radius:13px; background:linear-gradient(145deg,var(--panel),var(--panel-raised)); }
    .manage-row.paused { background:var(--panel); }
    .manage-row-top { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
    .manage-row-name { font-weight:720; min-width:0; overflow:hidden; text-overflow:ellipsis; }
    /* The word carries the state and the colour only repeats it, so a row still
       reads correctly in a screenshot, in sunlight, and to anyone who cannot
       tell the good token from the dim one. */
    .manage-state { flex:none; font-size:11px; font-weight:760; text-transform:uppercase; letter-spacing:.08em; color:var(--good); }
    .manage-row.paused .manage-state { color:var(--dim); }
    .manage-when { color:var(--dim); font-size:13px; }
    .manage-last { display:grid; grid-template-columns:auto minmax(0,1fr); gap:2px 8px; align-items:baseline; border-top:1px solid var(--line); padding-top:8px; }
    .manage-glyph { color:var(--faint); font-size:14px; }
    .manage-word { color:var(--ink); font-size:11px; font-weight:760; text-transform:uppercase; letter-spacing:.08em; }
    .manage-sentence,.manage-detail { grid-column:2; color:var(--dim); font-size:13px; }
    .manage-detail { color:var(--faint); font-size:12px; }
    .manage-last.failed .manage-glyph,.manage-last.failed .manage-word { color:var(--critical); }
    .manage-last.unknown .manage-glyph,.manage-last.unknown .manage-word { color:var(--serious); }
    .manage-last.ok .manage-glyph { color:var(--good); }
    .manage-act { justify-self:start; }
    .manage-row.armed { border-color:color-mix(in srgb,var(--critical) 55%,var(--line)); }
    .manage-confirm { color:var(--serious); font-size:12px; font-weight:700; }
    .manage-dated { color:var(--serious); font-size:12px; font-weight:700; margin-top:4px; }
    .manage-note { color:var(--dim); font-size:12px; }
    .manage-note:empty { display:none; }`,
  script: `
      const MANAGE_VIEW = ${JSON.stringify(MANAGE_VIEW)};
      // Long enough to read the sentence the second tap is confirming, short
      // enough that a tap now and a pocket tap later are never read as one
      // decision. The same window the Device screen arms its unpair with.
      const MANAGE_ARM_MS = 8000;
      // null until a read has returned. An empty array is a claim about the Mac
      // — 'it starts nothing on a timer' — and the two must not share a value.
      let manageRows = null;
      let manageReadAt = 0;
      let manageError = '';
      let manageNote = '';
      let manageBusy = false;
      let manageArmedId = '';
      let manageArmedAt = 0;
      let manageRefresh = () => {};

      // ago() answers how long since; this answers how long until. Deliberately
      // relative and never a wall clock: the cron is read in the Mac's local
      // time and this page is held in whatever timezone the operator is
      // standing in, so '03:00' beside 'next at 11:00' would look like a
      // contradiction rather than the same instant seen from two places.
      function manageUntil(at) {
        const seconds = Math.round((Number(at) - Date.now()) / 1000);
        if (seconds <= 0) return 'due now';
        if (seconds < 60) return 'in under a minute';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return 'in ' + minutes + 'm';
        const hours = Math.floor(minutes / 60);
        if (hours < 48) return 'in ' + hours + 'h ' + (minutes % 60) + 'm';
        return 'in ' + Math.floor(hours / 24) + ' days';
      }

      // Glyph and word together, before any colour. Seven outcomes because the
      // Mac records seven, and 'Never fired' is one of them: a schedule nothing
      // has ever run must not borrow the shape of one that succeeded.
      const MANAGE_LAST = {
        never: { glyph: '·', word: 'Never fired' },
        pending: { glyph: '◔', word: 'In flight' },
        ok: { glyph: '✓', word: 'Finished' },
        failed: { glyph: '✕', word: 'Failed' },
        skipped: { glyph: '↷', word: 'Skipped' },
        canceled: { glyph: '⊘', word: 'Cancelled' },
        unknown: { glyph: '?', word: 'Not observed' },
      };

      function manageLastSentence(last) {
        if (last.outcome === 'never') {
          return 'This has not fired yet, so there is no outcome to report.';
        }
        const when = last.at ? ago(last.at) + ' ago' : 'at a time nothing recorded';
        if (last.outcome === 'pending') {
          return 'Its last fire ' + when + ' is still queued or running, so how it ends is not recorded yet.';
        }
        if (last.outcome === 'ok') return 'Its last fire ' + when + ' finished without an error.';
        if (last.outcome === 'failed') return 'Its last fire ' + when + ' failed.';
        if (last.outcome === 'skipped') {
          return 'Its last fire ' + when + ' was skipped rather than stacked behind work still in the queue.';
        }
        if (last.outcome === 'canceled') return 'Its last fire ' + when + ' was cancelled before it started.';
        // The honest end of the list. reconcileFires() on the Mac writes this
        // when a fire was dispatched and nothing ever answered for it, and the
        // whole point of that status is that the absence of an answer must not
        // read as a good one.
        return 'Wanigan did not see how its fire ' + when + ' ended. That is neither a success nor a failure.';
      }

      function manageScopeWords(row) {
        if (row.scope === 'project') {
          return row.projectName
            ? 'in ' + row.projectName
            : 'in a repository Wanigan no longer has registered';
        }
        if (row.scope === 'all-projects') return 'across every registered repository';
        return 'with no repository named';
      }

      function manageKindWords(row) {
        if (row.kind === 'headless') return 'a headless run';
        if (row.kind === 'batch') return 'a batch re-submission';
        if (row.kind === 'session') return 'a session';
        return 'work of a kind this page does not recognise';
      }

      // A sentence of its own rather than a clause inside the kind, because a
      // relative clause in the middle collided with the repository and the
      // cron that follow it. 'session' rows are only in databases older builds
      // wrote: nothing is registered to run one, so a fire waits in the queue
      // for ever while the schedule looks healthy. The Mac disables such a row
      // the first time it comes due, and until then this is the difference
      // between a schedule that works and one that only looks like it.
      function manageCaveatWords(row) {
        if (row.kind === 'session') {
          return ' Nothing on this Mac is registered to run a session schedule, so a fire would wait in the queue rather than start anything.';
        }
        return '';
      }

      function manageWhenWords(row) {
        const what = 'Starts ' + manageKindWords(row) + ' ' + manageScopeWords(row) + ', ' + row.describe + '.'
          + manageCaveatWords(row);
        if (row.paused) return what + ' Paused, so nothing is armed.';
        if (row.nextAt) return what + ' Next ' + manageUntil(row.nextAt) + '.';
        // Enabled with no armed fire is the shape a cron that no longer matches
        // a real date leaves behind. Saying 'next: never' would read as a
        // setting; saying nothing would read as a schedule that works.
        return what + ' Nothing is armed, so this will not fire until it is edited on the Mac.';
      }

      function manageConfirmWords(row) {
        if (row.paused) {
          return 'Tap again to resume “' + row.name + '”. It arms again from now, ' + row.describe +
            '. Fires missed while it was paused are not caught up.';
        }
        return 'Tap again to pause “' + row.name + '”. Its next fire' +
          (row.nextAt ? ' ' + manageUntil(row.nextAt) : '') +
          ' will not happen, and any fire of its own still waiting in the queue is cancelled. Work already running is not stopped.';
      }

      function manageRow(row) {
        const armed = manageArmedId === row.id && Date.now() - manageArmedAt < MANAGE_ARM_MS;
        const card = node('div', 'manage-row' + (row.paused ? ' paused' : '') + (armed ? ' armed' : ''));
        const top = node('div', 'manage-row-top');
        top.append(node('div', 'manage-row-name', row.name),
          node('div', 'manage-state', row.paused ? '⏸ Paused' : '▸ Active'));
        card.append(top, node('p', 'manage-when', manageWhenWords(row)));

        // An outcome the table does not hold falls to 'Not observed' rather
        // than to a blank glyph beside a blank word. The shape is checked
        // rather than the key so an inherited hit — 'constructor', 'toString'
        // — resolves to the honest row too.
        const found = MANAGE_LAST[row.last.outcome];
        const shape = found && found.glyph ? found : MANAGE_LAST.unknown;
        const last = node('p', 'manage-last ' + row.last.outcome);
        const glyph = node('span', 'manage-glyph', shape.glyph);
        // The glyph is decoration to a screen reader; the word beside it is the
        // state, and reading out '✕' before it teaches nobody anything.
        glyph.setAttribute('aria-hidden', 'true');
        last.append(glyph, node('span', 'manage-word', shape.word),
          node('span', 'manage-sentence', manageLastSentence(row.last)));
        if (row.last.detail) last.append(node('span', 'manage-detail', row.last.detail));
        card.append(last);

        // No button at all rather than one that fails: pausing is a control
        // action, and the dispatcher refuses every control route while remote
        // control is off at the Mac. The panel above the list says so once.
        if (remoteControlEnabled) {
          const button = node('button', 'secondary manage-act',
            armed ? (row.paused ? 'Tap again to resume' : 'Tap again to pause')
              : (row.paused ? 'Resume' : 'Pause'));
          button.type = 'button';
          button.disabled = manageBusy;
          button.addEventListener('click', () => { void manageAct(row); });
          card.append(button);
          if (armed) card.append(node('p', 'manage-confirm', manageConfirmWords(row)));
        }
        return card;
      }

      function paintManage() {
        const host = byId('manage-list');
        const children = [];
        if (!remoteControlEnabled) {
          children.push(ui.off('This device can read these but not pause them.',
            'Enable remote control in Wanigan Settings → Phone monitor to pause or resume a schedule from here.'));
        }
        if (manageError) {
          children.push(ui.failed('the schedules on this Mac', manageError, () => manageRefresh()));
          // A failed refresh does not delete what the last good read said, but
          // it does stop it being a claim about now, so the rows below keep
          // their reading and lose their tense.
          if (manageRows && manageRows.length) {
            children.push(node('p', 'manage-dated',
              'The schedules below are the last reading, from ' + ago(manageReadAt) + ' ago.'));
          }
        } else if (manageRows === null) {
          children.push(ui.reading('the schedules on this Mac'));
        } else if (manageRows.length === 0) {
          children.push(ui.empty('This Mac starts nothing on a timer.',
            'Create a schedule in Wanigan on the Mac and it appears here on the next read.'));
        }
        if (manageRows) manageRows.forEach((row) => children.push(manageRow(row)));
        host.replaceChildren(...children);
        const note = byId('manage-note');
        // This screen repaints on every poll, and handing a node the sentence it
        // already holds makes VoiceOver read it out again.
        if (note.textContent !== manageNote) note.textContent = manageNote;
      }

      async function manageLoad() {
        // Hold still while a confirmation is armed. This screen refreshes on the
        // shared poll, and rebuilding a row under a thumb that is halfway
        // through a two-tap pause is how a deliberate action becomes a mis-tap
        // on a different schedule.
        if (manageArmedId && Date.now() - manageArmedAt < MANAGE_ARM_MS) return;
        try {
          const data = await api('api/schedules');
          manageRows = Array.isArray(data.schedules) ? data.schedules : [];
          manageReadAt = Date.now();
          manageError = '';
        } catch (failure) {
          manageError = failure instanceof Error ? failure.message : 'Wanigan did not say why.';
        }
        paintManage();
      }

      async function manageAct(row) {
        if (manageBusy) return;
        const armed = manageArmedId === row.id && Date.now() - manageArmedAt < MANAGE_ARM_MS;
        if (!armed) {
          // Two taps, and the second one names what stops. Pausing changes what
          // this Mac does while nobody is watching it, and a thumb finds a
          // button by accident on a screen it is scrolling past.
          manageArmedId = row.id;
          manageArmedAt = Date.now();
          manageNote = '';
          paintManage();
          setTimeout(() => {
            if (manageArmedId === row.id && Date.now() - manageArmedAt >= MANAGE_ARM_MS) {
              manageArmedId = '';
              paintManage();
            }
          }, MANAGE_ARM_MS + 200);
          return;
        }
        manageArmedId = '';
        manageBusy = true;
        manageNote = (row.paused ? 'Resuming “' : 'Pausing “') + row.name + '”…';
        paintManage();
        try {
          // The authorization header is re-stated because api() merges init over
          // its defaults rather than into them, so an init carrying headers of
          // its own replaces the one that holds the token.
          const result = await api('api/schedules', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem(KEY) },
            body: JSON.stringify({ action: row.paused ? 'resume' : 'pause', id: row.id }),
          });
          // What the Mac says came back, never what this page asked for. The
          // third branch is the one that matters: a 200 carrying no schedule is
          // not evidence of anything, and reading it as "active again" would be
          // this screen inventing the outcome it wanted.
          const paused = result && result.schedule ? result.schedule.paused === true : null;
          manageNote = paused === true
            ? '“' + row.name + '” is paused. Nothing is armed until you resume it.'
            : paused === false
              ? '“' + row.name + '” is active again.'
              : 'The Mac accepted that without saying what it did. The list is being read again.';
        } catch (failure) {
          manageNote = failure instanceof Error ? failure.message : 'Wanigan refused that change.';
        } finally {
          manageBusy = false;
          paintManage();
          void manageRefresh();
        }
      }`,
  wiring: `      // ui.watch is the whole cadence: the frame runs this read when the screen
      // comes on and again on each poll that returns while it is still there,
      // and never while another screen is up or the page is in the background.
      // An interval of this screen's own would be a second radio wake-up for a
      // panel nobody is looking at.
      manageRefresh = ui.watch(MANAGE_VIEW, manageLoad);
      paintManage();`,
};
