import type { MobileViewId } from '../../../../shared/mobile-nav';
import type { MobileSection } from '../sections';

/**
 * The Manage hub: what this Mac is spending right now with nobody watching it,
 * what it will start on a timer later, and the two buttons that stop each.
 *
 * Two panels, in that order, because that is the order of the questions. A
 * headless run in flight is money leaving an account this minute; a schedule is
 * money that will leave one at 03:00. Before this screen, both of those were
 * things you could only reach by going home — a session has a terminal on the
 * Agent screen and a batch has the person who submitted it, but an unattended
 * fan-out has nobody, which is the point of it.
 *
 * The run panel's hard part is the cost line, and it is hard in a way that only
 * shows up here. A repository that has not finished has reported nothing, and a
 * repository whose CLI printed no cost reported nothing either; both are stored
 * as $0.00. The desktop already learned to say "no cost reported" rather than
 * "$0.00" for the second case. The first case is new to this screen, because
 * the desktop reads it beside a live table and a phone reads it as a headline —
 * so a run with three agents still burning tokens must never be captioned with
 * a confident total. It gets a floor and a sentence saying which repositories
 * have not answered yet.
 *
 * The cancel button's hard part is the sentence after the tap. `cancelHeadless`
 * on the Mac signals the agents and leaves the run 'canceling' while they wind
 * down; a repository whose agent is running closes itself out through its own
 * exit path. So the honest report of a successful cancel is "still stopping",
 * and this page says whichever of stopping and stopped the Mac actually reports
 * back. Claiming the run stopped the moment the tap landed would be the one
 * lie that matters here: somebody would put the phone down.
 *
 * Four facts per schedule below, and the fourth is the one that panel is for.
 * Its name, its cron in English, when it next fires — and how the last fire
 * *actually* ended, which is three or four different answers rather than one. A
 * schedule that has never fired, one whose last fire failed, one that was
 * skipped because the previous fire was still in the queue, and one Wanigan
 * dispatched and then never heard about again are four different facts about
 * this Mac, and the Schedules summary on the desktop used to render the last of
 * those as "all clear". A phone repeating that would be worse: it is the
 * surface someone checks precisely because they cannot see the Mac.
 *
 * What neither panel offers is deletion. Editing a cron and deleting a schedule
 * are Mac decisions — an expression is edited against a prompt this screen does
 * not show, and a delete throws away the run history that is the only audit of
 * unattended work there is. Deleting a run throws away the only record of what
 * it cost. Pausing and cancelling are the two writes here, and both leave the
 * evidence behind.
 */

/**
 * The screen this hub is composed into.
 *
 * Named once, as a MobileViewId, so that pointing it at a different destination
 * is one line and a type error if that destination does not exist. Today it is
 * Runs: shared/mobile-nav.ts has no 'manage' destination, and Runs is the entry
 * that already narrows the desktop's Runs and Schedules tabs — its published
 * hint is "headless runs, and the schedules that start them without you", which
 * is exactly the two panels below. Sending this markup to a view id the record
 * does not contain would compose it into nothing, which is a blank tab behind a
 * live nav row: the same lie as an empty fleet on a sleeping Mac.
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
  markup: `        <section id="runs-live" class="runs">
          <h2>Running now</h2>
          <p class="runs-lead">Fan-outs this Mac is running with nobody at the keyboard. Cancelling asks their agents to quit; it does not undo what they have already written.</p>
          <div id="runs-list" class="runs-list"></div>
          <p id="runs-note" class="why runs-note" role="status"></p>
        </section>
        <section id="manage" class="manage">
          <h2>Unattended work</h2>
          <p class="manage-lead">These start on this Mac on a timer, whether or not anyone is watching it. Times are read on the Mac, in the Mac's local time.</p>
          <div id="manage-list" class="manage-list"></div>
          <p id="manage-note" class="why manage-note" role="status"></p>
        </section>`,
  style: `    .runs > h2:first-child { margin-top:4px; }
    .runs-lead { color:var(--dim); font-size:12px; margin-bottom:10px; }
    .runs-list { display:grid; gap:9px; }
    .runs-row { display:grid; gap:6px; padding:14px; border:1px solid var(--line); border-radius:13px; background:linear-gradient(145deg,var(--panel),var(--panel-raised)); }
    .runs-row-top { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
    .runs-row-name { font-weight:720; min-width:0; overflow:hidden; text-overflow:ellipsis; }
    /* The word carries the state and the colour only repeats it, so a row still
       reads correctly in a screenshot, in sunlight, and to anyone who cannot
       tell the good token from the serious one. */
    .runs-state { flex:none; display:flex; align-items:baseline; gap:5px; font-size:11px; font-weight:760; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); }
    .runs-glyph { font-size:13px; }
    .runs-row.submitting .runs-state,.runs-row.in_progress .runs-state { color:var(--good); }
    .runs-row.canceling .runs-state { color:var(--serious); }
    .runs-row.failed .runs-state { color:var(--critical); }
    .runs-meta { color:var(--dim); font-size:13px; }
    .runs-sub { color:var(--faint); font-size:12px; }
    .runs-cost { display:grid; gap:2px; border-top:1px solid var(--line); padding-top:9px; }
    .runs-cost-value { font-size:clamp(19px,5vw,25px); letter-spacing:-.03em; font-variant-numeric:tabular-nums; }
    .runs-cost-label { color:var(--faint); font-size:10px; text-transform:uppercase; letter-spacing:.06em; }
    .runs-cost-words { color:var(--dim); font-size:12px; margin-top:4px; }
    .runs-act { justify-self:start; }
    .runs-row.armed { border-color:color-mix(in srgb,var(--critical) 55%,var(--line)); }
    .runs-confirm { color:var(--serious); font-size:12px; font-weight:700; }
    .runs-dated { color:var(--serious); font-size:12px; font-weight:700; margin-top:4px; }
    .runs-note { color:var(--dim); font-size:12px; }
    .runs-note:empty { display:none; }
    .manage-lead { color:var(--dim); font-size:12px; margin-bottom:10px; }
    .manage-list { display:grid; gap:9px; }
    .manage-row { display:grid; gap:6px; padding:14px; border:1px solid var(--line); border-radius:13px; background:linear-gradient(145deg,var(--panel),var(--panel-raised)); }
    .manage-row.paused { background:var(--panel); }
    .manage-row-top { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
    .manage-row-name { font-weight:720; min-width:0; overflow:hidden; text-overflow:ellipsis; }
    /* Same rule as the panel above: the word carries the state, the colour only
       repeats it. */
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
      // decision. The same window the Device screen arms its unpair with, and
      // both panels on this screen use it.
      const MANAGE_ARM_MS = 8000;

      /* ── running now ─────────────────────────────────────────────────── */

      // null until a read has returned. An empty array is a claim about the Mac
      // — 'nothing is running unattended' — and the two must not share a value.
      let runsRows = null;
      let runsLatest = null;
      let runsTruncated = false;
      let runsReadAt = 0;
      let runsError = '';
      let runsNote = '';
      let runsBusy = false;
      let runsArmedId = '';
      let runsArmedAt = 0;
      let runsRefresh = () => {};

      // Glyph and word together, before any colour. 'Stopping' is its own word
      // rather than a variety of finished, because a run whose agents are still
      // winding down is a run that is still spending — and that distinction is
      // the reason this panel exists rather than a status dot.
      const RUNS_STATE = {
        submitting: { glyph: '◔', word: 'Starting' },
        in_progress: { glyph: '▸', word: 'Running' },
        canceling: { glyph: '⊘', word: 'Stopping' },
        ended: { glyph: '✓', word: 'Finished' },
        failed: { glyph: '✕', word: 'Failed' },
        unknown: { glyph: '?', word: 'Not recognised' },
      };

      // The shape is checked rather than the key, so an inherited hit —
      // 'constructor', 'toString' — resolves to the honest row too. The key
      // comes back with it because it also drives the row's class, and a class
      // taken from an unchecked wire value is a second way for the same bad
      // string to reach the page.
      function runsShape(status) {
        const found = RUNS_STATE[status];
        if (found && found.glyph) return { key: status, glyph: found.glyph, word: found.word };
        return { key: 'unknown', glyph: RUNS_STATE.unknown.glyph, word: RUNS_STATE.unknown.word };
      }

      function runsPlural(value, one, many) {
        const n = Math.max(0, Number(value) || 0);
        return n + ' ' + (n === 1 ? one : many);
      }

      function runsOpenPhrase(row) {
        return row.open === 1 ? 'the one repository still running'
          : 'each of the ' + row.open + ' repositories still running';
      }

      // Has any repository finished at all? The Mac's costStatus is computed
      // over the repositories that have, and it says 'reported' for a run where
      // none of them has — true of the empty set, and a caption that would put
      // a confident '$0.00' beside agents that are spending money right now.
      // Nothing else on the wire distinguishes that case, so it is counted here
      // from the outcome buckets, which only a finished repository lands in.
      function runsNothingFinished(row) {
        return (Number(row.succeeded) || 0) + (Number(row.failed) || 0) + (Number(row.blocked) || 0) === 0;
      }

      // The strongest claim on this panel sits on its least complete number, so
      // the number is what gets qualified. A repository whose CLI named no cost
      // is stored as $0.00 and a repository still running has named nothing at
      // all; neither of those is a repository that was free, and this is exactly
      // the screen someone would act on the difference from.
      function runsCostValue(row) {
        if (row.costStatus === 'unreported' || runsNothingFinished(row)) return 'Not reported';
        return (row.costStatus === 'partial' || !row.costFinal ? '≥ ' : '') + dollars(row.costUsd);
      }

      function runsCostWords(row) {
        if (runsNothingFinished(row)) {
          return row.costFinal
            ? 'No repository finished and named a cost, so there is no figure to show.'
            : 'No repository has finished yet, so nothing has named a cost. That is not the same as nothing having been spent.';
        }
        if (row.costStatus === 'unreported') {
          return row.costFinal
            ? 'No repository named a cost, so there is no figure to show. That is not the same as this run having been free.'
            : 'Nothing has named a cost yet. That is not the same as nothing having been spent.';
        }
        if (row.costStatus === 'partial') {
          return row.costFinal
            ? 'A floor: some repositories finished without naming a cost.'
            : 'A floor: some repositories finished without naming a cost, and ' + runsOpenPhrase(row) + ' has not answered yet.';
        }
        if (!row.costFinal) {
          return 'What the finished repositories reported. ' +
            (row.open === 1 ? 'The one still running has not' : 'The ' + row.open + ' still running have not') +
            ' reported anything, and will not until their agents exit.';
        }
        return 'CLI-reported; never estimated.';
      }

      function runsPastWords(row) {
        if (row.status === 'ended') return 'finished';
        if (row.status === 'failed') return 'failed';
        if (runsShape(row.status).key === 'unknown') {
          return 'was last recorded in a state this page does not recognise';
        }
        return 'was last recorded as ' + runsShape(row.status).word.toLowerCase();
      }

      // Two different silences. A Mac that has run twenty fan-outs this week and
      // one that has never run a single one both have nothing in flight, and a
      // screen that renders them identically is the empty fleet on a sleeping
      // Mac wearing another screen's name.
      function runsIdleWords() {
        if (!runsLatest) return 'No headless run has been started on this Mac yet.';
        const when = runsLatest.endedAt ? ago(runsLatest.endedAt) + ' ago' : 'at a time nothing recorded';
        return 'The last one, “' + runsLatest.name + '”, ' + runsPastWords(runsLatest) + ' ' + when +
          ' · ' + runsCostValue(runsLatest) + '.';
      }

      function runsConfirmWords(row) {
        return 'Tap again to cancel “' + row.name + '”. Wanigan signals the agent in ' + runsOpenPhrase(row) +
          ', and kills any that will not quit. What they have already written to a worktree stays where it is —' +
          ' nothing is undone, and the run is not stopped until those agents are gone.';
      }

      // What the Mac says came back, never what this page asked for. The middle
      // branch is the one this panel turns on: cancelHeadless signals the agents
      // and leaves the run 'canceling' while they wind down, so a tap that
      // reported 'stopped' would be the page inventing the outcome it wanted —
      // and the operator who believed it would put the phone down over a run
      // that is still spending.
      function runsOutcomeWords(row, result) {
        const after = result && result.run ? result.run : null;
        const reached = 'Wanigan reached ' + runsPlural(result && result.reached, 'repository', 'repositories') + '.';
        if (!after) return 'The Mac accepted that without saying what it did. The list is being read again.';
        if (after.open > 0 || after.status === 'canceling') {
          return reached + ' “' + row.name + '” is still stopping: the agents have been asked to quit, and the run' +
            ' is not closed until they are gone.';
        }
        return reached + ' “' + row.name + '” has stopped.';
      }

      function runsRow(row) {
        const armed = runsArmedId === row.id && Date.now() - runsArmedAt < MANAGE_ARM_MS;
        const shape = runsShape(row.status);
        const card = node('div', 'runs-row ' + shape.key + (armed ? ' armed' : ''));
        const top = node('div', 'runs-row-top');
        const state = node('div', 'runs-state');
        const glyph = node('span', 'runs-glyph', shape.glyph);
        // The glyph is decoration to a screen reader; the word beside it is the
        // state, and reading out '⊘' before it teaches nobody anything.
        glyph.setAttribute('aria-hidden', 'true');
        state.append(glyph, node('span', '', shape.word));
        top.append(node('div', 'runs-row-name', row.name), state);
        card.append(top,
          node('p', 'runs-meta', number(row.succeeded) + ' passed · ' + number(row.failed) + ' failed · ' +
            number(row.blocked) + ' blocked · ' + number(row.open) + ' open'),
          node('p', 'runs-sub', 'Started ' + ago(row.startedAt) + ' ago · ' + row.model + ' · ' +
            runsPlural(row.filesChanged, 'file', 'files') + ' changed'));

        const cost = node('div', 'runs-cost');
        cost.append(node('span', 'runs-cost-value', runsCostValue(row)),
          node('span', 'runs-cost-label', 'Cost so far'),
          node('p', 'runs-cost-words', runsCostWords(row)));
        card.append(cost);

        // No button at all rather than one that fails: cancelling is a control
        // action, and the dispatcher refuses every control route while remote
        // control is off at the Mac. The panel above the list says so once.
        if (remoteControlEnabled && row.cancelable) {
          const button = node('button', 'secondary runs-act', armed ? 'Tap again to cancel' : 'Cancel run');
          button.type = 'button';
          button.disabled = runsBusy;
          button.addEventListener('click', () => { void runsAct(row); });
          card.append(button);
          if (armed) card.append(node('p', 'runs-confirm', runsConfirmWords(row)));
        } else if (row.status === 'canceling') {
          // A sentence rather than a disabled button. This run has already been
          // asked to stop, and offering the tap again would invite the reading
          // that the first one did not take.
          card.append(node('p', 'runs-confirm',
            'Already stopping. Wanigan is waiting for the agents to go; the run closes when they do.'));
        }
        return card;
      }

      function paintRuns() {
        const host = byId('runs-list');
        const children = [];
        if (runsError) {
          children.push(ui.failed('what this Mac is running', runsError, () => runsRefresh()));
          // A failed refresh does not delete what the last good read said, but
          // it does stop it being a claim about now, so the rows below keep
          // their reading and lose their tense.
          if (runsRows && runsRows.length) {
            children.push(node('p', 'runs-dated',
              'The runs below are the last reading, from ' + ago(runsReadAt) + ' ago.'));
          }
        } else if (runsRows === null) {
          children.push(ui.reading('what this Mac is running'));
        } else if (runsRows.length === 0) {
          children.push(ui.empty('Nothing is running unattended right now.', runsIdleWords()));
        }
        // Only when it would actually matter. The schedules panel below already
        // carries the standing 'this device can read but not change' notice, and
        // repeating it over an empty list would be two boxes saying one thing.
        if (!remoteControlEnabled && runsRows && runsRows.some((row) => row.cancelable)) {
          children.push(ui.off('This device can see this run but not stop it.',
            'Enable remote control in Wanigan Settings → Phone monitor to cancel a run from here.'));
        }
        if (runsRows) runsRows.forEach((row) => children.push(runsRow(row)));
        if (runsTruncated) {
          children.push(node('p', 'runs-dated',
            'More runs are in flight than this screen lists. Open Wanigan on the Mac to see all of them.'));
        }
        host.replaceChildren(...children);
        const note = byId('runs-note');
        // This screen repaints on every poll, and handing a node the sentence it
        // already holds makes VoiceOver read it out again.
        if (note.textContent !== runsNote) note.textContent = runsNote;
      }

      async function runsLoad() {
        // Hold still while a confirmation is armed, for the reason the panel
        // below holds still: rebuilding a row under a thumb halfway through a
        // two-tap cancel is how a deliberate action becomes a mis-tap on a
        // different run.
        if (runsArmedId && Date.now() - runsArmedAt < MANAGE_ARM_MS) return;
        try {
          const data = await api('api/runs');
          runsRows = Array.isArray(data.runs) ? data.runs : [];
          runsLatest = data.latest && typeof data.latest === 'object' ? data.latest : null;
          runsTruncated = data.truncated === true;
          runsReadAt = Date.now();
          runsError = '';
        } catch (failure) {
          runsError = failure instanceof Error ? failure.message : 'Wanigan did not say why.';
        }
        paintRuns();
      }

      async function runsAct(row) {
        if (runsBusy) return;
        const armed = runsArmedId === row.id && Date.now() - runsArmedAt < MANAGE_ARM_MS;
        if (!armed) {
          // Two taps, and the second one names what stops. Cancelling ends work
          // the operator paid for and may still want, and a thumb finds a button
          // by accident on a screen it is scrolling past.
          runsArmedId = row.id;
          runsArmedAt = Date.now();
          runsNote = '';
          paintRuns();
          setTimeout(() => {
            if (runsArmedId === row.id && Date.now() - runsArmedAt >= MANAGE_ARM_MS) {
              runsArmedId = '';
              paintRuns();
            }
          }, MANAGE_ARM_MS + 200);
          return;
        }
        runsArmedId = '';
        runsBusy = true;
        runsNote = 'Cancelling “' + row.name + '”…';
        paintRuns();
        try {
          // The authorization header is re-stated because api() merges init over
          // its defaults rather than into them, so an init carrying headers of
          // its own replaces the one that holds the token.
          const result = await api('api/runs', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem(KEY) },
            body: JSON.stringify({ action: 'cancel', id: row.id }),
          });
          runsNote = runsOutcomeWords(row, result);
        } catch (failure) {
          runsNote = failure instanceof Error ? failure.message : 'Wanigan refused that cancellation.';
        } finally {
          runsBusy = false;
          paintRuns();
          void runsRefresh();
        }
      }

      /* ── unattended work ─────────────────────────────────────────────── */

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
  wiring: `      // ui.watch is the whole cadence: the frame runs these reads when the
      // screen comes on and again on each poll that returns while it is still
      // there, and never while another screen is up or the page is in the
      // background. An interval of this screen's own would be a second radio
      // wake-up for a panel nobody is looking at. Two watchers rather than one
      // because the two panels answer on two routes with two scopes, and a
      // failed schedule read must not blank the runs that are spending money.
      runsRefresh = ui.watch(MANAGE_VIEW, runsLoad);
      manageRefresh = ui.watch(MANAGE_VIEW, manageLoad);
      paintRuns();
      paintManage();`,
};
