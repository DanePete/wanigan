import type { MobileViewId } from '../../../../shared/mobile-nav';
import type { MobileSection } from '../sections';

/**
 * The review inbox: the proposals Wanigan is waiting on a person for, and the
 * two decisions a person can honestly take from a phone.
 *
 * This is the one Learning surface that belongs away from the desk. Everything
 * else on the desktop's Learning screen is work against a repository — editing
 * the sentence an agent will be told for months, compiling a proposal into a
 * skill file, projecting one into CLAUDE.md — and none of it is a thing to do
 * one-handed on a train. What is left is the queue itself, which is also the
 * part that stalls everything behind it while nobody is at the machine.
 *
 * So the screen is built around one refusal: it will not let a decision be
 * taken on a card that does not show the evidence. A proposal here arrives with
 * its claim in full, the reasoning that produced it, and what it cites; where
 * the Mac could not hand over one of those — a claim longer than the wire
 * carries, a path scope that names the machine, a cited observation that is no
 * longer in the database — the card says so in place of its Approve button, and
 * main refuses that approval too. Tapping approve on a proposal you cannot see
 * is rubber-stamping, and a phone is exactly where that would happen.
 *
 * Rejecting is deliberately not held to the same bar. A proposal you cannot see
 * enough of is one you are entitled to throw out; the decision stays in the
 * audit history and the Mac can reopen it. Holding both directions would leave
 * the queue growing with precisely the proposals nobody can clear.
 *
 * Two sentences on this screen exist to stop a specific false impression. The
 * first is the provenance line at the foot: these proposals were produced by
 * counting repeated observations and phrasing them from fixed templates, and no
 * model read any of them — model-assisted consolidation is not connected in
 * this build, and a screen that let someone infer a model had reviewed their
 * work would be claiming a capability Wanigan does not have. The second is what
 * an approval reports. The desktop's Approve button reviews and promotes in one
 * action; this one records the review and stops, so the outcome says that
 * nothing has been written into knowledge or into a file yet rather than
 * letting the operator believe the job is finished.
 */

/**
 * The screen this panel is composed into. Named once as a MobileViewId so a
 * typo is a type error rather than markup composed into nothing — a live nav
 * row that opens a blank panel, which is the same lie as an empty fleet on a
 * sleeping Mac. Unlike the Manage hub, this one maps exactly: the record in
 * shared/mobile-nav.ts already carries a Learning destination whose published
 * hint is "what Wanigan has learned, and what is waiting for your review".
 */
const LEARNING_VIEW: MobileViewId = 'learning';

/**
 * Typed with the slot held apart, the way spend.ts and manage.ts are, because
 * 'learning' is not in MobileSectionSlot yet — registering this screen widens
 * that union, imports this module into MOBILE_SECTIONS, and has shell.ts ask
 * for the markup with sectionMarkup('learning'). A cast to the current union
 * would have compiled and then composed the screen into no slot at all.
 */
type LearningSection = Omit<MobileSection, 'slot'> & { slot: 'learning' };

export const LEARNING_SECTION: LearningSection = {
  id: 'learning',
  anchorId: 'learning',
  slot: 'learning',
  markup: `        <section id="learning" class="learning">
          <h2>Waiting for your decision</h2>
          <p class="learning-lead">What Wanigan proposes to remember, and nothing it has acted on. A proposal changes no agent, no session and no file until you decide on it.</p>
          <div id="learning-list" class="learning-list"></div>
          <p id="learning-note" class="why learning-note" role="status"></p>
          <p id="learning-provenance" class="learning-provenance"></p>
        </section>`,
  style: `    .learning > h2:first-child { margin-top:4px; }
    .learning-lead { color:var(--dim); font-size:12px; margin-bottom:10px; }
    .learning-list { display:grid; gap:9px; }
    .learning-card { display:grid; gap:8px; padding:14px; min-width:0; }
    .learning-top { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
    .learning-title { font-weight:720; min-width:0; }
    /* The word carries the state and the colour only repeats it, so a card
       still reads correctly in a screenshot and in sunlight. */
    .learning-state { flex:none; display:flex; align-items:baseline; gap:5px; font-size:11px; font-weight:760; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); }
    .learning-glyph { font-size:13px; }
    .learning-where { color:var(--faint); font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
    .learning-claim { border-left:2px solid var(--line); padding-left:10px; font-size:14px; line-height:1.5; }
    .learning-why { color:var(--dim); font-size:12px; line-height:1.5; }
    .learning-cut { color:var(--serious); font-size:12px; font-weight:700; }
    .learning-proof { display:flex; flex-wrap:wrap; gap:4px 12px; color:var(--dim); font-size:12px; font-variant-numeric:tabular-nums; }
    .learning-proof b { color:var(--ink); }
    .learning-cites { color:var(--dim); font-size:12px; }
    .learning-cites.wrong { color:var(--serious); font-weight:700; }
    .learning-signals { display:grid; gap:6px; border-top:1px solid var(--line); padding-top:9px; }
    .learning-signal { display:grid; gap:2px; min-width:0; }
    .learning-signal-kind { color:var(--faint); font-size:10px; text-transform:uppercase; letter-spacing:.06em; }
    .learning-signal-text { font-size:12px; color:var(--dim); }
    .learning-conflicts { border:1px solid color-mix(in srgb,var(--serious) 45%,var(--line)); border-radius:9px; padding:10px; display:grid; gap:4px; }
    .learning-conflicts strong { font-size:12px; }
    .learning-conflicts p { color:var(--dim); font-size:12px; }
    .learning-acts { display:flex; gap:8px; flex-wrap:wrap; }
    .learning-act { flex:1; min-width:140px; }
    .learning-card.armed { border-color:color-mix(in srgb,var(--accent) 55%,var(--line)); }
    .learning-confirm { color:var(--serious); font-size:12px; font-weight:700; }
    .learning-blocked,.learning-locked { color:var(--dim); font-size:12px; }
    .learning-dated { color:var(--serious); font-size:12px; font-weight:700; }
    .learning-note { color:var(--dim); font-size:12px; }
    .learning-note:empty { display:none; }
    .learning-provenance { color:var(--faint); font-size:11px; line-height:1.5; margin-top:12px; }
    .learning-provenance:empty { display:none; }`,
  script: `
      const LEARNING_VIEW = ${JSON.stringify(LEARNING_VIEW)};
      // Long enough to read the sentence the second tap is confirming, short
      // enough that a tap now and a pocket tap later are never read as one
      // decision. The same window the Manage hub and the Device screen arm
      // their two-tap actions with.
      const LEARNING_ARM_MS = 8000;

      // null until a read has returned. An empty proposal list is a claim about
      // the Mac — 'nothing is waiting for you' — and the two must not share a
      // value: a queue nobody has read yet and an empty queue are the two
      // states this screen exists to keep apart.
      let learnPayload = null;
      let learnReadAt = 0;
      let learnError = '';
      let learnNote = '';
      let learnBusy = false;
      // The armed action, as id + the verb: two buttons on one card, and a
      // confirmation armed on one of them must never be spent by the other.
      let learnArmed = '';
      let learnArmedAt = 0;
      let learnRefresh = () => {};

      function learnPlural(value, one, many) {
        const n = Math.max(0, Number(value) || 0);
        return n + ' ' + (n === 1 ? one : many);
      }

      // The desktop's rendering, to two decimals, with the same three words
      // beside it. It is a rule over the count of independent tasks — not a
      // measurement and not a model's opinion — and printing it as a bare
      // percentage would let it read as one.
      function learnConfidence(value) {
        return Math.max(0, Math.min(1, Number(value) || 0)).toFixed(2);
      }

      // What an approval would become, and where it would apply. The path
      // branch is the one that matters: Wanigan does not send a phone a
      // selector that names a location on the Mac, and a card that simply left
      // the scope out would look like a proposal that applies everywhere.
      function learnWhereWords(row) {
        if (row.scope === 'personal') return row.targetKind + ' · yours, across every repository';
        if (row.scope === 'project') {
          return row.targetKind + ' · ' + (row.projectName || 'a repository whose record is gone');
        }
        if (row.pathWithheld) return row.targetKind + ' · a path this device is not shown';
        return row.targetKind + ' · ' + row.pathSelector;
      }

      // Whether the evidence behind this claim can still be produced. 'checked'
      // is its own answer and never collapses into the others: a proposal whose
      // citations this device did not verify is not a proposal whose citations
      // verified.
      function learnCiteWords(row) {
        const cites = row.citations || {};
        if (!cites.checked) {
          return 'Cites ' + learnPlural(cites.named, 'observation', 'observations') +
            ' — more than this device checks, so none of them has been confirmed to still exist.';
        }
        if (!cites.named) return 'Nothing is cited on this proposal.';
        if (cites.found >= cites.named) {
          return 'All ' + learnPlural(cites.named, 'cited observation is', 'cited observations are') +
            ' still on the Mac.';
        }
        const gone = cites.named - cites.found;
        return gone + ' of the ' + cites.named + ' cited observations ' + (gone === 1 ? 'is' : 'are') +
          ' no longer on the Mac, so that part of the evidence cannot be checked from here.';
      }

      function learnCitesWrong(row) {
        const cites = row.citations || {};
        return !cites.checked || !cites.named || cites.found < cites.named;
      }

      // Glyph and word together, before any colour. A proposal a person snoozed
      // and a fresh observation woke is a different fact from one nobody has
      // ever looked at, and the wake reason is stored precisely so this can say
      // which — rather than inferring it from a status flip.
      function learnStateShape(row) {
        return row.wake ? { glyph: '↻', word: 'Observed again' } : { glyph: '·', word: 'Waiting' };
      }

      function learnWakeWords(row) {
        return 'You deferred this once. It came back because the same pattern was observed again: ' +
          learnPlural(row.wake.newSignals, 'new observation', 'new observations') + ' across ' +
          learnPlural(row.wake.newTasks, 'new independent task', 'new independent tasks') + '.';
      }

      function learnConfirmWords(row, action) {
        if (action === 'approve') {
          return 'Tap again to approve “' + row.title + '”. Wanigan records the approval and stops there:' +
            ' nothing is written into knowledge, into a skill, or into any repository file until that is' +
            ' done at the Mac.';
        }
        return 'Tap again to reject “' + row.title + '”. It stops waiting, the decision stays in its audit' +
          ' history, and the Mac can reopen it.';
      }

      // What the Mac says it now records, never what this page asked for. The
      // approved branch is the one this screen turns on: approving here is the
      // review and not the promotion, and a sentence implying the knowledge had
      // been written would leave someone believing a job was finished that
      // nobody has started.
      function learnOutcomeWords(row, result) {
        const status = result && typeof result.status === 'string' ? result.status : '';
        if (status === 'approved') {
          return '“' + row.title + '” is approved. Nothing has been written into knowledge or into a file' +
            ' yet — writing it in is a step at the Mac.';
        }
        if (status === 'rejected') {
          return '“' + row.title + '” is rejected. The decision stays in its audit history, and the Mac' +
            ' can reopen it.';
        }
        if (status) return 'The Mac now records “' + row.title + '” as ' + status + '.';
        return 'The Mac accepted that without saying what it did. The list is being read again.';
      }

      function learnSignalRow(citation) {
        const wrap = node('div', 'learning-signal');
        wrap.append(node('span', 'learning-signal-kind', citation.kind + ' · ' + ago(citation.at) + ' ago'),
          node('span', 'learning-signal-text',
            citation.summary + (citation.redacted ? ' (redacted before it was stored)' : '')));
        return wrap;
      }

      function learnCard(row) {
        const armedApprove = learnArmed === row.id + '·approve' && Date.now() - learnArmedAt < LEARNING_ARM_MS;
        const armedReject = learnArmed === row.id + '·reject' && Date.now() - learnArmedAt < LEARNING_ARM_MS;
        const card = node('article', 'card learning-card' + (armedApprove || armedReject ? ' armed' : ''));
        const shape = learnStateShape(row);
        const top = node('div', 'learning-top');
        const state = node('div', 'learning-state');
        const glyph = node('span', 'learning-glyph', shape.glyph);
        // The glyph is decoration to a screen reader; the word beside it is the
        // state, and reading out '↻' before it teaches nobody anything.
        glyph.setAttribute('aria-hidden', 'true');
        state.append(glyph, node('span', '', shape.word));
        top.append(node('div', 'learning-title', row.title), state);
        card.append(top, node('p', 'learning-where', learnWhereWords(row)));

        card.append(node('p', 'learning-claim', row.claim));
        if (!row.claimComplete) {
          card.append(node('p', 'learning-cut',
            'That is only the first part of the proposal. The rest is longer than this device is shown.'));
        }
        card.append(node('p', 'learning-why', row.rationale));
        if (!row.rationaleComplete) {
          card.append(node('p', 'learning-cut', 'The reasoning is longer than this device is shown.'));
        }
        if (row.wake) card.append(node('p', 'learning-why', learnWakeWords(row)));

        const proof = node('div', 'learning-proof');
        [[row.evidenceCount, 'observation', 'observations'], [row.taskCount, 'independent task', 'independent tasks']]
          .forEach((entry) => {
            const span = node('span', '');
            span.append(node('b', '', number(entry[0])), document.createTextNode(' ' +
              (Math.max(0, Number(entry[0]) || 0) === 1 ? entry[1] : entry[2])));
            proof.append(span);
          });
        const conf = node('span', '');
        conf.append(node('b', '', learnConfidence(row.confidence)),
          document.createTextNode(' confidence · rule-derived'));
        proof.append(conf);
        card.append(proof);

        const cites = node('p', 'learning-cites' + (learnCitesWrong(row) ? ' wrong' : ''), learnCiteWords(row));
        card.append(cites);
        if (Array.isArray(row.shown) && row.shown.length) {
          const list = node('div', 'learning-signals');
          list.append(...row.shown.map(learnSignalRow));
          card.append(list);
        }

        if (Array.isArray(row.conflicts) && row.conflicts.length) {
          const box = node('div', 'learning-conflicts');
          box.append(node('strong', '', 'Conflicts with knowledge Wanigan already holds'));
          row.conflicts.forEach((conflict) => {
            box.append(node('p', '', conflict.relation + ': ' + conflict.title + ' — ' + conflict.reason));
          });
          card.append(box);
        }

        // No button at all rather than one that fails: deciding is a control
        // action, and the dispatcher refuses every control route while remote
        // control is off at the Mac.
        if (!remoteControlEnabled) {
          card.append(node('p', 'learning-locked',
            'Reading this queue is all a monitor can do. Enable remote control in Wanigan Settings →' +
            ' Phone monitor to approve or reject from this device.'));
          return card;
        }

        const acts = node('div', 'learning-acts');
        if (row.approvable) {
          const approve = node('button', 'learning-act', armedApprove ? 'Tap again to approve' : 'Approve');
          approve.type = 'button';
          approve.disabled = learnBusy;
          approve.addEventListener('click', () => { void learnAct(row, 'approve'); });
          acts.append(approve);
        }
        const reject = node('button', 'secondary learning-act', armedReject ? 'Tap again to reject' : 'Reject');
        reject.type = 'button';
        reject.disabled = learnBusy;
        reject.addEventListener('click', () => { void learnAct(row, 'reject'); });
        acts.append(reject);
        card.append(acts);

        // The reason stands where the button would have been, because a
        // proposal with no Approve and no explanation reads as a broken card
        // rather than as one this device is not entitled to approve.
        if (!row.approvable && row.approveBlocked) {
          card.append(node('p', 'learning-blocked', row.approveBlocked));
        }
        if (armedApprove) card.append(node('p', 'learning-confirm', learnConfirmWords(row, 'approve')));
        if (armedReject) card.append(node('p', 'learning-confirm', learnConfirmWords(row, 'reject')));
        return card;
      }

      // Said once, at the foot, from what the Mac reported rather than from a
      // constant: nothing here was read by a model. If a metered consolidator
      // ever is connected, this prints nothing rather than going on claiming a
      // provenance it can no longer establish — the page must never be the
      // reason someone believes their work was read by a model, in either
      // direction. (Worded around the phrase on purpose: the assertion that
      // enforces this scans the whole composed script and is deliberately
      // blind to comments, so prose describing the ban would trip the ban.)
      function learnProvenanceWords() {
        if (!learnPayload || learnPayload.enabled !== true) return '';
        if (learnPayload.modelAssisted === true) return '';
        return 'Wanigan wrote these by counting repeated observations and phrasing them from fixed' +
          ' templates. No model read them. Editing a proposal, turning one into a skill, and writing one' +
          ' into a repository file are all done at the Mac.';
      }

      function paintLearning() {
        const host = byId('learning-list');
        const children = [];
        if (learnError) {
          children.push(ui.failed('the review inbox', learnError, () => learnRefresh()));
          // A failed refresh does not delete what the last good read said, but
          // it does stop it being a claim about now, so the proposals below
          // keep their reading and lose their tense.
          if (learnPayload && learnPayload.proposals && learnPayload.proposals.length) {
            children.push(node('p', 'learning-dated',
              'The proposals below are the last reading, from ' + ago(learnReadAt) + ' ago.'));
          }
        } else if (!learnPayload) {
          children.push(ui.reading('the review inbox'));
        } else if (learnPayload.enabled !== true) {
          children.push(ui.off('Learning is switched off.',
            'Wanigan is recording nothing and proposing nothing until it is switched back on, in Wanigan →' +
            ' Learning → Context on the Mac. Nothing already stored was deleted.'));
        } else if (!learnPayload.proposals.length) {
          children.push(ui.empty('Nothing is waiting for your decision.',
            'Wanigan proposes something only after it has observed the same thing more than once across' +
            ' independent tasks. Proposals you snoozed are not counted here: they come back by themselves' +
            ' when that pattern is observed again.'));
        }
        if (learnPayload && learnPayload.proposals) {
          learnPayload.proposals.forEach((row) => children.push(learnCard(row)));
          const more = Math.max(0, Number(learnPayload.waiting) - learnPayload.proposals.length);
          if (more > 0) {
            children.push(node('p', 'learning-blocked',
              'Showing the ' + learnPayload.proposals.length + ' most recently updated of ' +
              (learnPayload.waitingIsFloor ? 'at least ' : '') + learnPayload.waiting +
              ' waiting. The rest are on the Mac.'));
          }
        }
        host.replaceChildren(...children);
        // This screen repaints on every poll, and handing a node the sentence
        // it already holds makes VoiceOver read it out again.
        const note = byId('learning-note');
        if (note.textContent !== learnNote) note.textContent = learnNote;
        const provenance = byId('learning-provenance');
        const words = learnProvenanceWords();
        if (provenance.textContent !== words) provenance.textContent = words;
      }

      async function learnLoad() {
        // Hold still while a confirmation is armed. This screen refreshes on
        // the shared poll, and rebuilding a card under a thumb that is halfway
        // through a two-tap approval is how a deliberate decision becomes a
        // mis-tap on a different proposal.
        if (learnArmed && Date.now() - learnArmedAt < LEARNING_ARM_MS) return;
        try {
          const data = await api('api/learning');
          data.proposals = Array.isArray(data.proposals) ? data.proposals : [];
          learnPayload = data;
          learnReadAt = Date.now();
          learnError = '';
        } catch (failure) {
          learnError = failure instanceof Error ? failure.message : 'Wanigan did not say why.';
        }
        paintLearning();
      }

      async function learnAct(row, action) {
        if (learnBusy) return;
        const key = row.id + '·' + action;
        if (learnArmed !== key || Date.now() - learnArmedAt >= LEARNING_ARM_MS) {
          // Two taps, and the second one names what happens. A decision here
          // changes what Wanigan will tell agents about this work, and a thumb
          // finds a button by accident on a screen it is scrolling past.
          learnArmed = key;
          learnArmedAt = Date.now();
          learnNote = '';
          paintLearning();
          setTimeout(() => {
            if (learnArmed === key && Date.now() - learnArmedAt >= LEARNING_ARM_MS) {
              learnArmed = '';
              paintLearning();
            }
          }, LEARNING_ARM_MS + 200);
          return;
        }
        learnArmed = '';
        learnBusy = true;
        learnNote = (action === 'approve' ? 'Approving “' : 'Rejecting “') + row.title + '”…';
        paintLearning();
        try {
          // The authorization header is re-stated because api() merges init
          // over its defaults rather than into them, so an init carrying
          // headers of its own replaces the one that holds the token.
          const result = await api('api/learning', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem(KEY) },
            body: JSON.stringify({ action: action, id: row.id }),
          });
          learnNote = learnOutcomeWords(row, result);
        } catch (failure) {
          learnNote = failure instanceof Error ? failure.message : 'Wanigan refused that decision.';
        } finally {
          learnBusy = false;
          paintLearning();
          void learnRefresh();
        }
      }`,
  wiring: `      // Guarded because every line below needs this screen's markup to have
      // been composed into the frame, and one section's wiring runs in the same
      // closure as every other section's. A registry edit that dropped this
      // screen would otherwise take the whole page down on the first null —
      // a phone showing nothing at all rather than one screen fewer. The smoke
      // suite's anchor sweep is what catches the drop itself.
      if (byId('learning-list')) {
        paintLearning();
        // The frame owns the cadence. This screen holds no interval of its own:
        // its read runs when the screen comes on and again on each poll that
        // returns while it still is, which is also what makes the retry button
        // above the same read rather than a second one.
        learnRefresh = ui.watch(LEARNING_VIEW, learnLoad);
      }`,
};
