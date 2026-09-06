import type { MobileSection } from '../sections';

/**
 * Goals: one goal's contract, the shape of its task graph, the evidence
 * recorded against it, and the one decision only a person can make. Two levels
 * — the goals this Mac is carrying, then one of them opened.
 *
 * Reading, plus one decision. Starting a task, arming unattended dispatch and
 * setting a cap stay at the Mac: each spends money or a working tree. The
 * terminal review is the exception, and it is the exception because of what
 * blocks without it — a fanned-out goal finishes its implement tasks, passes
 * its gate, and then waits on a human verdict that only exists at one desk. The
 * lead paragraph says which of those this screen offers, in the served markup
 * rather than in a release note, so it is readable before any read succeeds and
 * on a device that has never reached the Mac.
 *
 * The decision block is built around one rule: **the gate result is in front of
 * the decision.** Approving work without seeing whether the project's own
 * checks passed is the failure this screen exists to prevent, so the gate state
 * — passed, failed with the verification task named, or never run — sits
 * immediately above the buttons, and the buttons stay live either way. An
 * operator may have a good reason to approve a goal whose gate nobody ran; what
 * they may not have is a screen that hid it. Making a state visible is this
 * app's job, and making a choice impossible is not.
 *
 * The four things this screen exists to get right, all of which the desktop
 * already gets right and a smaller screen must not undo:
 *
 *  - **'blocked' is two situations.** A task whose prerequisite failed and a
 *    task whose prerequisite has not finished both read 'blocked' in the record,
 *    and the operator's next move differs: reopen that task, or wait. So each
 *    task names what it waits on with each of those statuses beside it, and says
 *    which of the two situations is holding it. The words come from the Mac;
 *    this screen does not invent a second vocabulary for them.
 *  - **No base commit is an absence, not a diagnosis.** A goal recorded without
 *    one says exactly that. Naming a cause — no repository, no commit yet, a git
 *    read that failed — would be this device guessing between three it cannot
 *    tell apart.
 *  - **Spend is only what a provider reported.** The figure beside a cap is
 *    printed with how much of the goal it actually covers, in the desktop's own
 *    sentences, because a cap enforced against a partly reported total is a
 *    weaker ceiling than the number makes it look.
 *  - **A gate nobody ran is not a gate that passed.** 'Not run' is its own
 *    state with its own words, never a quiet absence rendered as calm. The Mac
 *    is the authority on the rest: it re-reads those proofs when the decision
 *    arrives and refuses an approval whose verification is unproven, and the
 *    sentence the operator reads then is the Mac's, not this screen's guess at
 *    it.
 *
 * No file path arrives here. A task's claim path is project-relative and would
 * have been safe to send, but the Git screen is the only surface Wanigan sends a
 * path to and it says so in its own bytes; a task therefore reports that it
 * declares or holds a claim, and the path stays on the Mac. Worktrees, session
 * ids and provider conversation ids are not on this wire at all.
 *
 * Cadence is the frame's, through ui.watch, with a floor on top of it. A goals
 * read is a database read per goal for what it has spent, and the fleet's
 * three-second tick is not the right interval for twenty of those; twelve
 * seconds is still faster than anyone can read a task graph.
 */
/**
 * The annotation is `Omit<MobileSection, 'slot'>` with the slot re-added as a
 * literal because this screen brings its own slot with it: 'goals' joins
 * MobileSectionSlot in ../sections in the same change that registers this
 * module. Written as a plain `MobileSection` it would not compile until that
 * line landed, and the literal type is what makes it assignable the moment it
 * does — a widened `string` would fail the registry instead. Once the union
 * carries 'goals', this can become `: MobileSection` like its neighbours.
 */
export const GOALS_SECTION: Omit<MobileSection, 'slot'> & { slot: 'goals' } = {
  id: 'goals',
  anchorId: 'goals',
  slot: 'goals',
  markup: `        <section id="goals" class="goals">
          <h2>Goals</h2>
          <p class="goal-lead">A goal is the contract a piece of agent work is held to: what it is for, what it has to satisfy, the task graph that gets it there, and the evidence recorded along the way. This device reads it, and — with remote control on — records the one human decision at the end of it, with the review gate result in front of you. Starting a task, arming unattended dispatch and setting a spend cap are decisions Wanigan only takes at the Mac. A task's claimed file path is not sent here either — paths cross to this phone on the Git screen and nowhere else.</p>
          <div id="goal-body" class="goal-body"></div>
        </section>`,
  style: `    .goals > h2:first-child { margin-top:4px; }
    .goal-lead { color:var(--dim); font-size:12px; margin-bottom:12px; }
    .goal-list { display:grid; gap:9px; }
    .goal-row { display:grid; gap:6px; width:100%; padding:14px; text-align:left; border:1px solid var(--line); border-radius:13px; background:linear-gradient(145deg,var(--panel),var(--panel-raised)); color:var(--ink); font-weight:400; }
    button.goal-row { touch-action:manipulation; }
    button.goal-row:active { transform:scale(.985); border-color:var(--accent); }
    .goal-row-top { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
    .goal-name { font-weight:720; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .goal-tag { flex:none; display:inline-flex; align-items:center; gap:5px; border:1px solid currentColor; border-radius:999px; padding:2px 8px; font-size:11px; font-weight:760; }
    .goal-tag[data-tone="alert"] { color:var(--critical); background:var(--critical-soft); }
    .goal-tag[data-tone="serious"] { color:var(--serious); background:var(--panel-raised); }
    .goal-tag[data-tone="ok"] { color:var(--good); background:var(--good-soft); }
    .goal-tag[data-tone="quiet"] { color:var(--dim); background:var(--panel-raised); }
    .goal-meta { display:flex; flex-wrap:wrap; gap:4px 12px; color:var(--dim); font-size:12px; font-variant-numeric:tabular-nums; }
    .goal-open-hint { color:var(--accent); font-size:11px; font-weight:700; }
    .goal-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px; }
    .goal-head-name { font-weight:760; font-size:17px; letter-spacing:-.02em; min-width:0; }
    .goal-head-meta { margin-bottom:12px; }
    .goal-sub { margin:18px 0 6px; font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:.12em; font-weight:760; }
    .goal-prose { font-size:14px; overflow-wrap:anywhere; }
    .goal-omitted { display:block; color:var(--serious); font-size:11px; font-weight:700; margin-top:4px; }
    .goal-checks { margin:6px 0 0; padding-left:20px; display:grid; gap:5px; color:var(--dim); font-size:13px; }
    .goal-card { border:1px solid var(--line); border-radius:13px; background:linear-gradient(145deg,var(--panel),var(--panel-raised)); padding:14px; display:grid; gap:8px; }
    .goal-card-top { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .goal-card-title { font-weight:760; }
    .goal-reading { color:var(--dim); font-size:12px; }
    .goal-tasks { display:grid; gap:9px; }
    .goal-task { display:grid; gap:6px; padding:13px; border:1px solid var(--line); border-radius:12px; background:var(--panel); }
    .goal-task-top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .goal-kind { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.1em; font-weight:760; }
    .goal-task-title { font-weight:720; min-width:0; overflow-wrap:anywhere; }
    .goal-waits { display:flex; flex-wrap:wrap; align-items:center; gap:5px 8px; color:var(--dim); font-size:12px; }
    .goal-hold { color:var(--serious); font-size:12px; font-weight:700; }
    .goal-instructions { color:var(--dim); font-size:13px; overflow-wrap:anywhere; }
    .goal-evidence { display:grid; gap:7px; }
    .goal-record { display:grid; gap:3px; padding:11px 13px; border:1px solid var(--line); border-radius:11px; background:var(--panel); }
    .goal-record-top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .goal-record-text { font-size:13px; overflow-wrap:anywhere; }
    .goal-mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .goal-note { color:var(--serious); font-size:12px; font-weight:700; margin-top:9px; }
    .goal-asof { color:var(--faint); font-size:11px; margin-top:11px; }
    .goal-pointer { color:var(--serious); font-size:12px; font-weight:700; margin-bottom:10px; }
    /* The gate block. It sits inside the decision card, directly above the
       buttons, because a gate result an operator has to scroll for is a gate
       result they decide without. */
    .goal-gate { display:grid; gap:6px; border:1px solid var(--line); border-radius:11px; background:var(--panel); padding:12px; }
    .goal-gate.failed { border-color:color-mix(in srgb,var(--critical) 45%,var(--line)); }
    .goal-gate.partial,.goal-gate.not-run,.goal-gate.no-verification { border-color:color-mix(in srgb,var(--serious) 40%,var(--line)); }
    .goal-gate-top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .goal-gate-reading { color:var(--dim); font-size:13px; }
    .goal-gate-rows { display:grid; gap:5px; border-top:1px solid var(--line); padding-top:8px; }
    .goal-gate-row { display:flex; align-items:baseline; gap:5px 8px; flex-wrap:wrap; font-size:13px; }
    .goal-gate-row-title { font-weight:700; min-width:0; overflow-wrap:anywhere; }
    .goal-gate-row-sub { color:var(--dim); font-size:12px; overflow-wrap:anywhere; }
    .goal-decide { display:grid; gap:10px; border:1px solid var(--line); border-radius:13px; background:linear-gradient(145deg,var(--panel),var(--panel-raised)); padding:14px; }
    .goal-decide.armed { border-color:color-mix(in srgb,var(--critical) 55%,var(--line)); }
    .goal-decide-title { font-weight:760; }
    .goal-decide-writes { color:var(--dim); font-size:12px; }
    .goal-decide-preview { color:var(--faint); font-size:12px; overflow-wrap:anywhere; }
    .goal-decide-acts { display:flex; flex-wrap:wrap; gap:8px; }
    .goal-decide-acts button { flex:1 1 auto; }
    button.goal-decide-danger { border-color:color-mix(in srgb,var(--critical) 55%,var(--line)); }
    .goal-decide-confirm { color:var(--serious); font-size:12px; font-weight:700; }
    .goal-decide-result { font-size:13px; }
    .goal-decide-result:empty { display:none; }
    @media (min-width:900px) { .goal-list { grid-template-columns:repeat(2,minmax(0,1fr)); } }`,
  script: `
      // The floor under the shared tick. Each goal in the list costs the Mac a
      // spend aggregate over that goal's sessions, on the same synchronous
      // database handle that serves the live sessions, so following the fleet's
      // three-second poll would spend the main thread on a screen whose answer
      // changes when a person decides something.
      const GOAL_MIN_MS = 12000;
      // Glyph, word, then colour — the same glyphs the desktop draws for these
      // statuses, so one state does not wear two faces across the two surfaces.
      const GOAL_STATE = {
        draft: { glyph: '○', word: 'Draft', tone: 'quiet' },
        executing: { glyph: '▸', word: 'Executing', tone: 'quiet' },
        review: { glyph: '?', word: 'Review', tone: 'serious' },
        accepted: { glyph: '✓', word: 'Accepted', tone: 'ok' },
        rejected: { glyph: '✕', word: 'Rejected', tone: 'alert' },
        blocked: { glyph: '■', word: 'Blocked', tone: 'alert' },
        unknown: { glyph: '·', word: 'Recorded state this screen cannot name', tone: 'quiet' },
      };
      const GOAL_TASK_STATE = {
        pending: { glyph: '○', word: 'Pending', tone: 'quiet' },
        ready: { glyph: '◦', word: 'Ready', tone: 'serious' },
        running: { glyph: '▸', word: 'Running', tone: 'quiet' },
        completed: { glyph: '✓', word: 'Completed', tone: 'ok' },
        failed: { glyph: '✕', word: 'Failed', tone: 'alert' },
        canceled: { glyph: '⊘', word: 'Canceled', tone: 'alert' },
        blocked: { glyph: '■', word: 'Blocked', tone: 'alert' },
        unknown: { glyph: '·', word: 'Recorded state this screen cannot name', tone: 'quiet' },
      };
      const GOAL_KIND = { plan: 'Plan', implement: 'Implement', verify: 'Verify', review: 'Review' };
      // The two situations behind one word. The Mac reports 'blocked' for a task
      // whose prerequisite failed and for one whose prerequisite has not
      // finished, and the next move is different in each: reopen that task at
      // the Mac, or wait. A screen that printed 'blocked' alone would leave the
      // operator unable to tell an accident from an ordinary queue.
      const GOAL_HOLD = {
        'prerequisite-failed': 'Held by a prerequisite that failed or was canceled. Nothing below it moves until that task is reopened at the Mac.',
        // No 'nothing is wrong' here, however much it wants to be written: a
        // prerequisite that has not finished may itself be held by a failure
        // further up, and this sentence cannot see that. The line above names
        // each prerequisite with its own status, which is where that shows.
        'prerequisite-unfinished': 'Waiting on a prerequisite that has not finished. Each one is named above with the status it is in.',
      };
      // Autopilot's own three words, not the goal's. Reusing the goal-status
      // table here would have printed 'Executing' over a goal nobody is
      // dispatching and 'Blocked' over one that merely stopped itself, which are
      // two different facts wearing one label.
      const GOAL_DISPATCH_STATE = {
        armed: { glyph: '▸', word: 'Armed', tone: 'serious' },
        halted: { glyph: '■', word: 'Halted', tone: 'serious' },
        off: { glyph: '○', word: 'Off', tone: 'quiet' },
        unknown: { glyph: '○', word: 'Off', tone: 'quiet' },
      };
      const GOAL_SPEND_STATE = {
        reported: { glyph: '✓', word: 'all reported', tone: 'ok' },
        partial: { glyph: '?', word: 'partly reported', tone: 'serious' },
        unreported: { glyph: '?', word: 'nothing reported', tone: 'serious' },
        none: { glyph: '○', word: 'no session yet', tone: 'quiet' },
      };
      // The desktop's own sentences, word for word. The reading is the whole
      // point of the field: a cap counted against a partly reported total is a
      // weaker ceiling than the number beside it looks.
      const GOAL_SPEND_READING = {
        reported: 'Every session this goal has launched reported its cost, so the figure beside the cap is the whole of it.',
        partial: 'Some of this goal\\u2019s sessions reported no cost. The cap is enforced against the part that was reported, which makes it a weaker ceiling than it looks.',
        unreported: 'No session on this goal has reported a cost. Nothing has been counted against the cap — which is not the same as nothing having been spent.',
        none: 'No session has been launched for this goal yet, so there is nothing to count against the cap.',
      };
      const GOAL_PROOF_STATE = {
        recorded: { glyph: '•', word: 'Recorded', tone: 'ok' },
        passed: { glyph: '✓', word: 'Passed', tone: 'ok' },
        failed: { glyph: '✕', word: 'Failed', tone: 'alert' },
        unknown: { glyph: '·', word: 'Recorded state this screen cannot name', tone: 'quiet' },
      };
      // The record's own words. 'test' is what the review gate writes, and
      // relabelling it 'Review gate' here would be this screen naming a source
      // the row does not name.
      const GOAL_PROOF_KIND = {
        plan: 'Plan', test: 'Test', diff: 'Diff', review: 'Review', decision: 'Decision',
        unknown: 'Evidence',
      };

      // How long a tapped verdict stays armed before it forgets itself. A
      // decision moves a goal and files evidence against every agent that
      // worked on it, so it takes two deliberate taps like a cancellation does,
      // and the second one names what it writes.
      const GOAL_ARM_MS = 6000;
      // Five states, because the Mac reports five, and 'not run' is the one
      // that must never wear the shape of a pass. 'No verification task' is not
      // a missing reading either: it is a graph the Mac will refuse to approve.
      const GOAL_GATE_STATE = {
        passed: { glyph: '✓', word: 'Gate passed', tone: 'ok' },
        failed: { glyph: '✕', word: 'Gate failed', tone: 'alert' },
        partial: { glyph: '?', word: 'Gate incomplete', tone: 'serious' },
        'not-run': { glyph: '·', word: 'Gate not run', tone: 'quiet' },
        'no-verification': { glyph: '·', word: 'No verification task', tone: 'serious' },
        unknown: { glyph: '·', word: 'Recorded state this screen cannot name', tone: 'quiet' },
      };
      const GOAL_GATE_READING = {
        passed: 'Every verification task on this goal has a passing result from the project\\u2019s review gate, and it is the latest result recorded for each of them.',
        failed: 'The review gate failed. The verification task it failed on is named below, with the Mac\\u2019s own sentence about that run.',
        partial: 'Some verification tasks have a passing gate result and the rest have none. The unproven ones are named below.',
        // Never 'the gate has not failed', which is what an absence quietly
        // reads as. Nothing here says the project's checks pass or fail.
        'not-run': 'No review gate result is recorded against this goal. That is not a pass and not a failure \\u2014 it is nobody having run the project\\u2019s checks.',
        'no-verification': 'This goal has no verification task, so it has no gate result to have. The Mac refuses an approval on a goal without one; requesting changes or rejecting still works.',
        unknown: 'The Mac recorded a gate state this screen cannot name.',
      };
      const GOAL_GATE_TASK = {
        passed: { glyph: '✓', word: 'Passed', tone: 'ok' },
        failed: { glyph: '✕', word: 'Failed', tone: 'alert' },
        'not-run': { glyph: '·', word: 'Not run', tone: 'quiet' },
        unknown: { glyph: '·', word: 'Recorded state this screen cannot name', tone: 'quiet' },
      };
      const GOAL_VERDICT = {
        approve: { label: 'Approve', className: '' },
        request_changes: { label: 'Request changes', className: 'secondary' },
        reject: { label: 'Reject', className: 'secondary goal-decide-danger' },
      };
      // What each verdict actually writes, and where. Read off completeNode in
      // the Mac's control plane rather than off the button's label: a
      // decision closes the review task, files a record in the proof bundle
      // below, and writes one accepted/not-accepted row per task that ran for
      // the outcome router that ranks models. None of that is obvious from the
      // word 'Approve', and all of it is durable.
      const GOAL_DECIDE_WRITES = {
        approve: 'Approve records the review task as completed with your note, files a decision record in this goal\\u2019s proof bundle, marks every task that ran as accepted for the model outcome router, and re-derives this goal\\u2019s status from its tasks.',
        request_changes: 'Request changes records the review task as failed with your note, files a decision record, marks every task that ran as not accepted for the model outcome router, and leaves this goal blocked until someone reopens the review at the Mac.',
        reject: 'Reject records the review task as failed with your note, files a decision record, marks every task that ran as not accepted for the model outcome router, and records this goal itself as rejected.',
      };
      // The two writes all three share, kept out of the three sentences above so
      // they stay readable on a phone.
      const GOAL_DECIDE_ALWAYS = 'All three also stamp the task\\u2019s end time and release any file claim it was holding. Nothing is committed, pushed or applied to a repository by a decision.';

      // Empty means the list of goals; set means that one goal, and it is part
      // of what the throttled re-read asks for, so an open goal refreshes itself
      // rather than freezing at the moment it was opened while its tasks run on.
      let goalOpenId = '';
      let goalOpenName = '';
      let goalReadAt = 0;
      let goalPainted = false;

      // The decision block's own state. The note is held here rather than read
      // off the field, because this screen repaints itself every twelve seconds
      // and a note typed into a node that is about to be replaced is a note the
      // operator watches disappear.
      let goalDecideNote = '';
      let goalDecideArmed = '';
      let goalDecideArmedAt = 0;
      let goalDecideBusy = false;
      let goalDecideResult = '';
      // Set only when the Mac refused because remote control was switched off
      // between painting this screen and tapping it. It is a different answer
      // from a refusal about the goal, and it gets ui.off's box and the setting
      // by name rather than a sentence in a result line.
      let goalDecideOff = false;

      function goalBody() { return byId('goal-body'); }

      function goalAsOfWords() {
        return 'Wanigan was asked ' + ago(goalReadAt) + ' ago. This screen re-reads while it is open, ' +
          'at most every ' + Math.round(GOAL_MIN_MS / 1000) + ' seconds.';
      }

      // Repainted rather than rebuilt on a throttled tick: the reading itself is
      // unchanged, but 'asked 4s ago' stops being true on its own, and a screen
      // that keeps saying it is making a claim nothing checked.
      function goalTouchAsOf() {
        const line = goalBody().querySelector('.goal-asof');
        if (line) line.textContent = goalAsOfWords();
      }

      function goalTag(table, key) {
        const spec = table[key] || table.unknown;
        const tag = node('span', 'goal-tag');
        const glyph = node('span', '', spec.glyph);
        glyph.setAttribute('aria-hidden', 'true');
        tag.append(glyph, node('span', '', spec.word));
        tag.setAttribute('data-tone', spec.tone);
        return tag;
      }

      // A bounded piece of prose, with what stayed behind named underneath it.
      // The Mac counts the characters it did not send; printing the count is
      // what keeps a paragraph that was cut from reading like one that ended.
      function goalProse(part, className) {
        const block = node('p', className || 'goal-prose', (part && part.text) || '');
        if (part && part.omitted > 0) {
          block.append(node('span', 'goal-omitted',
            number(part.omitted) + ' more characters stayed on the Mac.'));
        }
        return block;
      }

      function goalSpendWords(spend) {
        const parts = [];
        parts.push(spend.capUsd === null ? 'no cap set' : dollars(spend.capUsd) + ' cap');
        parts.push(dollars(spend.spendUsd) + ' reported');
        return parts.join(' · ');
      }

      function goalRow(goal) {
        const row = node('button', 'goal-row');
        row.type = 'button';
        row.addEventListener('click', () => goalOpen(goal.id, goal.title));
        const top = node('div', 'goal-row-top');
        top.append(node('div', 'goal-name', goal.title || 'Untitled goal'), goalTag(GOAL_STATE, goal.status));
        row.append(top);
        const meta = node('div', 'goal-meta');
        meta.append(node('span', '', goal.projectName || 'Unknown project'));
        meta.append(node('span', '', goal.risk + ' risk'));
        meta.append(node('span', '', 'updated ' + ago(goal.updatedAt) + ' ago'));
        row.append(meta);
        const spend = goal.spend || {};
        // Only a goal that is dispatching on its own, or has stopped itself,
        // gets a money line on the list. On every other row it would be a figure
        // about work a person is starting one task at a time, which is not the
        // question this list is scrolled for.
        if (spend.armed || spend.halted) {
          const line = node('div', 'goal-meta');
          line.append(node('span', '', spend.armed ? 'Dispatching on its own' : 'Autopilot stopped itself'));
          line.append(node('span', 'goal-mono', goalSpendWords(spend)));
          row.append(line);
        }
        row.append(node('div', 'goal-open-hint', 'Tap for the contract and the task graph'));
        return row;
      }

      function goalPaintList(data) {
        const goals = Array.isArray(data.goals) ? data.goals : [];
        if (!goals.length) {
          goalBody().replaceChildren(ui.empty('No goals are recorded on this Mac.',
            'A goal is written in Wanigan at the Mac, with its objective and the checks it has to pass. This screen reads them.'));
          return;
        }
        const list = node('div', 'goal-list');
        goals.forEach((goal) => list.append(goalRow(goal)));
        const parts = [list];
        if (data.truncated) {
          parts.push(node('p', 'goal-note',
            'These are the ' + number(goals.length) + ' most recently updated goals. Older ones are on the Mac.'));
        }
        parts.push(node('p', 'goal-asof', goalAsOfWords()));
        goalBody().replaceChildren(...parts);
      }

      function goalWaitsLine(task) {
        const line = node('div', 'goal-waits');
        line.append(node('span', '', 'Waits on'));
        (task.waitsOn || []).forEach((prereq, index) => {
          if (index > 0) line.append(node('span', '', '·'));
          line.append(node('span', '', prereq.title));
          line.append(goalTag(GOAL_TASK_STATE, prereq.status));
        });
        // Both absences are named rather than folded into one hedge: a
        // prerequisite too many to send and a prerequisite this goal no longer
        // lists are different facts, and only the second one is a broken graph.
        if (task.waitsOnOmitted > 0) {
          line.append(node('span', '', 'and ' + number(task.waitsOnOmitted) + ' more not sent to this device'));
        }
        if (task.waitsOnUnlisted > 0) {
          line.append(node('span', '', 'and ' + number(task.waitsOnUnlisted) +
            ' this goal no longer lists, which the Mac counts as unfinished'));
        }
        return line;
      }

      function goalClaimWords(task) {
        if (task.holdsClaim) return 'Holding a file claim while it runs.';
        if (task.declaresClaim) return 'Declares a file claim to take when it starts.';
        return '';
      }

      function goalTaskCard(task) {
        const card = node('article', 'goal-task');
        const top = node('div', 'goal-task-top');
        top.append(goalTag(GOAL_TASK_STATE, task.status));
        top.append(node('span', 'goal-kind', GOAL_KIND[task.kind] || task.kind));
        top.append(node('span', 'goal-task-title', task.title || 'Untitled task'));
        card.append(top);
        if ((task.waitsOn && task.waitsOn.length) || task.waitsOnOmitted > 0 || task.waitsOnUnlisted > 0) {
          card.append(goalWaitsLine(task));
        }
        // The sentence only appears when the Mac could say which situation this
        // is. A task recorded as blocked with every prerequisite complete is a
        // fact about the row rather than about the graph, and this screen prints
        // the word without inventing a cause for it.
        if (GOAL_HOLD[task.hold]) card.append(node('p', 'goal-hold', GOAL_HOLD[task.hold]));
        card.append(goalProse(task.instructions, 'goal-instructions'));
        const meta = node('div', 'goal-meta');
        if (task.providerId) meta.append(node('span', '', task.providerId + (task.model ? ' · ' + task.model : '')));
        if (task.startedAt) meta.append(node('span', '', 'started ' + ago(task.startedAt) + ' ago'));
        if (task.endedAt) meta.append(node('span', '', 'ended ' + ago(task.endedAt) + ' ago'));
        const claim = goalClaimWords(task);
        if (claim) meta.append(node('span', '', claim));
        if (meta.childNodes.length) card.append(meta);
        if (task.detail) card.append(goalProse(task.detail, 'goal-instructions'));
        return card;
      }

      function goalDispatchCard(auto) {
        const card = node('div', 'goal-card');
        const top = node('div', 'goal-card-top');
        top.append(node('span', 'goal-card-title', 'Unattended dispatch'));
        top.append(goalTag(GOAL_DISPATCH_STATE, auto.armed ? 'armed' : auto.halted ? 'halted' : 'off'));
        card.append(top);
        card.append(node('p', 'goal-reading', auto.armed
          ? 'Wanigan is starting this goal\\u2019s ready tasks on its own' +
            (auto.providerId ? ' with ' + auto.providerId : '') + (auto.model ? ' · ' + auto.model : '') +
            ', without asking again. A Review task is never dispatched.'
          : 'Nothing is dispatched on its own. Every task here waits for someone at the Mac to start it.'));
        const facts = node('div', 'goal-meta');
        facts.append(node('span', 'goal-mono', goalSpendWords(auto)));
        facts.append(goalTag(GOAL_SPEND_STATE, auto.spendStatus));
        card.append(facts);
        card.append(node('p', 'goal-reading', GOAL_SPEND_READING[auto.spendStatus] || ''));
        // The halt outlives a re-arm on purpose, so an armed goal that stopped
        // itself once still says why. It is recorded evidence, not the result of
        // something anyone just did on this device.
        if (auto.haltedReason) {
          const stop = node('p', 'goal-hold', (auto.armed ? 'Last automatic stop' : 'Autopilot stopped') +
            (auto.haltedAt ? ' ' + ago(auto.haltedAt) + ' ago' : '') + ': ');
          stop.append(node('span', '', auto.haltedReason.text));
          if (auto.haltedReason.omitted > 0) {
            stop.append(node('span', 'goal-omitted',
              number(auto.haltedReason.omitted) + ' more characters stayed on the Mac.'));
          }
          card.append(stop);
        }
        return card;
      }

      // One record — a proof or a checkpoint — with its own status tag when it
      // has one. A checkpoint has no status in the record, so it is drawn
      // without a tag rather than borrowing a proof's: a green 'recorded' mark
      // on a saved checkpoint would be this screen inventing a state the Mac
      // never wrote.
      function goalRecordRow(table, tag, title, part, extra) {
        const row = node('div', 'goal-record');
        const top = node('div', 'goal-record-top');
        if (table) top.append(goalTag(table, tag));
        if (title) top.append(node('span', 'goal-kind', title));
        if (top.childNodes.length) row.append(top);
        row.append(goalProse(part, 'goal-record-text'));
        if (extra) row.append(node('div', 'goal-meta', extra));
        return row;
      }

      function goalEvidence(data) {
        const parts = [];
        parts.push(node('h3', 'goal-sub', 'Proof bundle'));
        const proofs = Array.isArray(data.proofs) ? data.proofs : [];
        if (!proofs.length) {
          parts.push(ui.empty('No evidence has been recorded against this goal.',
            'A review gate result is required before verification can pass, and the record of one appears here.'));
        } else {
          const list = node('div', 'goal-evidence');
          proofs.forEach((proof) => list.append(goalRecordRow(GOAL_PROOF_STATE, proof.status,
            (GOAL_PROOF_KIND[proof.kind] || 'Evidence') + (proof.taskTitle ? ' · ' + proof.taskTitle : ''),
            proof.summary, ago(proof.createdAt) + ' ago')));
          parts.push(list);
          if (data.proofsOmitted > 0) {
            parts.push(node('p', 'goal-note', number(data.proofsOmitted) +
              ' older records are on the Mac and were not sent to this device.'));
          }
        }
        parts.push(node('h3', 'goal-sub', 'Continuity'));
        const points = Array.isArray(data.checkpoints) ? data.checkpoints : [];
        if (!points.length) {
          parts.push(ui.empty('No checkpoint has been saved.',
            'A checkpoint records the repository point, and the provider thread when there is one, before a handoff or an interruption.'));
        } else {
          const list = node('div', 'goal-evidence');
          points.forEach((point) => {
            const meta = [];
            if (point.repoCommit) meta.push('commit ' + point.repoCommit.slice(0, 10));
            // Whether a thread was recorded, never which one. The id identifies
            // a provider conversation and would be of no use on a screen that
            // cannot open it.
            meta.push(point.thread ? 'a provider thread was recorded' : 'no provider thread recorded');
            meta.push(ago(point.createdAt) + ' ago');
            list.append(goalRecordRow(null, '', point.taskTitle || '', point.note, meta.join(' · ')));
          });
          parts.push(list);
          if (data.checkpointsOmitted > 0) {
            parts.push(node('p', 'goal-note', number(data.checkpointsOmitted) +
              ' older checkpoints are on the Mac and were not sent to this device.'));
          }
        }
        return parts;
      }

      /* ── the gate result, and the decision it sits in front of ────────── */

      // The last painted goal and the node the decision block lives in, so a
      // tap can rebuild that block alone. Repainting the whole goal to arm a
      // button would throw away the operator's half-typed note and the scroll
      // position they reached it from.
      let goalDecideData = null;
      let goalDecideHost = null;

      function goalDecideReset() {
        goalDecideNote = '';
        goalDecideArmed = '';
        goalDecideArmedAt = 0;
        goalDecideResult = '';
        goalDecideOff = false;
        goalDecideData = null;
        goalDecideHost = null;
      }

      function goalDecideArmedNow() {
        return goalDecideArmed && Date.now() - goalDecideArmedAt < GOAL_ARM_MS;
      }

      // Whether the screen must hold still. A re-read arriving under a thumb
      // halfway through a two-tap decision is how a deliberate act becomes a
      // mis-tap, and one arriving mid-sentence takes the note with it. The
      // as-of line keeps ticking either way, so a held screen never claims a
      // freshness it does not have.
      function goalDecideHolding() {
        if (goalDecideBusy || goalDecideArmedNow()) return true;
        return !!(goalDecideHost && document.activeElement && goalDecideHost.contains(document.activeElement));
      }

      // The composed note, exactly as the Mac will store it. The prefix is the
      // one place a decision can say it was made from a phone: the record has
      // no column for the device, and inventing one would change the shape of a
      // stored row for a fact that fits in the note ../control already writes.
      function goalDecideNoteWords() {
        const typed = goalDecideNote.trim();
        return typed ? 'From the paired phone: ' + typed : 'Recorded from the paired phone.';
      }

      function goalGateBlock(gate) {
        const state = gate && gate.state ? gate.state : 'unknown';
        const box = node('div', 'goal-gate ' + state);
        const top = node('div', 'goal-gate-top');
        top.append(goalTag(GOAL_GATE_STATE, state));
        if (gate && gate.lastRunAt) top.append(node('span', 'goal-gate-row-sub', 'last run ' + ago(gate.lastRunAt) + ' ago'));
        box.append(top);
        box.append(node('p', 'goal-gate-reading', GOAL_GATE_READING[state] || GOAL_GATE_READING.unknown));
        const tasks = gate && Array.isArray(gate.tasks) ? gate.tasks : [];
        if (tasks.length) {
          const rows = node('div', 'goal-gate-rows');
          tasks.forEach((task) => {
            const row = node('div', 'goal-gate-row');
            row.append(goalTag(GOAL_GATE_TASK, task.result));
            row.append(node('span', 'goal-gate-row-title', task.taskTitle));
            if (task.ranAt) row.append(node('span', 'goal-gate-row-sub', ago(task.ranAt) + ' ago'));
            // The Mac's own sentence about that run — 'Review gate failed after
            // 2 command(s).' This screen does not name the command that failed,
            // because the record it is reading does not carry one.
            if (task.summary && task.summary.text) row.append(node('span', 'goal-gate-row-sub', task.summary.text));
            rows.append(row);
          });
          box.append(rows);
          if (gate.tasksOmitted > 0) {
            box.append(node('p', 'goal-gate-row-sub',
              number(gate.tasksOmitted) + ' further verification tasks were not sent to this device.'));
          }
        }
        return box;
      }

      function goalDecideWord(table, key) {
        const spec = table[key];
        return spec && key !== 'unknown' ? spec.word.toLowerCase() : 'a state this screen cannot name';
      }

      function goalDecideOutcomeWords(outcome) {
        if (!outcome) {
          return 'The Mac recorded that decision and then could not open its own record again, so this screen cannot say what the decision did to the goal. It is being re-read.';
        }
        let words = 'Recorded. The Mac now has \\u201c' + outcome.taskTitle + '\\u201d as ' +
          goalDecideWord(GOAL_TASK_STATE, outcome.taskStatus) + ', and this goal as ' +
          goalDecideWord(GOAL_STATE, outcome.goalStatus) + '. The decision is in the proof bundle above.';
        if (outcome.note && outcome.note.text) {
          words += ' It was recorded with the note \\u201c' + outcome.note.text + '\\u201d.';
        }
        return words;
      }

      function goalDecideAcceptanceWords(data) {
        const checks = Array.isArray(data.acceptance) ? data.acceptance.length : 0;
        const more = data.acceptanceOmitted > 0 ? ' ' + number(data.acceptanceOmitted) + ' more stayed on the Mac.' : '';
        if (!checks) {
          return 'This goal carries no acceptance checks, so nothing was written down for this decision to be held to. It is a judgement rather than a check.';
        }
        return 'The ' + number(checks) + ' acceptance check' + (checks === 1 ? '' : 's') +
          ' listed above are the contract. Wanigan does not evaluate them for you \\u2014 that is what this decision is.' + more;
      }

      async function goalDecideSend(verdict) {
        const data = goalDecideData;
        if (goalDecideBusy || !data || !data.decision || !data.decision.nodeId) return;
        if (!goalDecideArmedNow() || goalDecideArmed !== verdict) {
          // The first tap only arms, and what it reveals is the list of durable
          // writes the second tap makes. A verdict recorded on one tap of a
          // scrolling thumb would be a goal accepted by accident.
          goalDecideArmed = verdict;
          goalDecideArmedAt = Date.now();
          goalDecideResult = '';
          goalDecideOff = false;
          goalDecidePaint();
          setTimeout(() => {
            if (goalDecideArmed === verdict && !goalDecideArmedNow()) { goalDecideArmed = ''; goalDecidePaint(); }
          }, GOAL_ARM_MS + 200);
          return;
        }
        goalDecideArmed = '';
        goalDecideBusy = true;
        goalDecideResult = 'Recording that decision\\u2026';
        goalDecidePaint();
        // Which goal this decision is about. The operator can tap 'All goals'
        // while it is in flight, and the decision still lands on the Mac — but
        // painting one goal's answer over the list they asked for next is a
        // screen showing something nobody requested.
        const asked = goalOpenId;
        try {
          // The authorization header is re-stated because api() merges init over
          // its defaults rather than into them, so an init carrying headers of
          // its own replaces the one that holds the token.
          const result = await api('api/goal', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem(KEY) },
            body: JSON.stringify({ goal: data.id, task: data.decision.nodeId, decision: verdict, note: goalDecideNote.trim() }),
          });
          goalDecideBusy = false;
          goalDecideNote = '';
          if (goalOpenId !== asked) return;
          goalDecideResult = goalDecideOutcomeWords(result && result.outcome);
          if (result && result.goal) {
            // Repainted from the record the Mac answered with, not from the
            // verdict that was sent: what the goal became is a reading, and
            // approving a review on a goal that also holds a failed task
            // leaves it blocked rather than accepted.
            goalReadAt = Date.now();
            goalPainted = true;
            goalPaintOne(result.goal);
          } else {
            goalDecidePaint();
          }
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : '';
          goalDecideBusy = false;
          if (goalOpenId !== asked) return;
          // The dispatcher's refusal for a switched-off scope is matched the way
          // the Git screen matches it. It is not a refusal about this goal, and
          // rendering it in a result line would send the operator looking at the
          // review instead of at the setting.
          if (/disabled/.test(message)) { goalDecideOff = true; goalDecideResult = ''; }
          else goalDecideResult = message || 'The Mac refused that decision and did not say why.';
          goalDecidePaint();
        }
      }

      function goalDecideButton(verdict) {
        const spec = GOAL_VERDICT[verdict];
        const armed = goalDecideArmedNow() && goalDecideArmed === verdict;
        const button = node('button', spec.className, armed ? 'Tap again to ' + spec.label.toLowerCase() : spec.label);
        button.type = 'button';
        button.disabled = goalDecideBusy;
        button.addEventListener('click', () => { void goalDecideSend(verdict); });
        return button;
      }

      function goalDecidePaint() {
        const host = goalDecideHost;
        const data = goalDecideData;
        if (!host || !data) return;
        const decision = data.decision || {};
        const parts = [node('h3', 'goal-sub', 'Your decision')];
        // The result line outlives the controls on purpose. A decision that is
        // recorded turns this block into its own empty state a moment later,
        // and an outcome sentence that vanished with the buttons would leave
        // the operator unable to see what their tap actually did.
        const settle = (extra) => {
          const all = extra ? parts.concat([extra]) : parts;
          host.replaceChildren(...(goalDecideResult ? all.concat([node('p', 'goal-decide-result', goalDecideResult)]) : all));
        };

        if (!decision.nodeId) {
          parts.push(ui.empty('This goal has no review task.',
            decision.refusal || 'A goal reaches accepted through its review task, and this one has none recorded.'));
          settle(null);
          return;
        }
        if (!decision.awaiting) {
          parts.push(ui.empty('No decision is waiting on you here.',
            decision.refusal || 'The Mac is not holding this review open for a decision.'));
          settle(null);
          return;
        }

        const card = node('div', 'goal-decide' + (goalDecideArmedNow() ? ' armed' : ''));
        const top = node('div', 'goal-card-top');
        top.append(node('span', 'goal-decide-title', decision.taskTitle || 'Review'));
        top.append(goalTag(GOAL_TASK_STATE, decision.status));
        card.append(top);
        // Immediately above the controls, and never in place of them. An
        // operator can have a good reason to approve a goal whose gate nobody
        // ran; what they cannot have is a screen that did not say so.
        card.append(goalGateBlock(data.gate || {}));
        card.append(node('p', 'goal-decide-writes', goalDecideAcceptanceWords(data)));

        if (!remoteControlEnabled || goalDecideOff) {
          card.append(ui.off('This device can read this decision but not record it.',
            'Enable remote control in Wanigan Settings \\u2192 Phone monitor to approve, request changes or reject from here.'));
          settle(card);
          return;
        }

        const label = node('label', 'field-label');
        label.append(node('span', '', 'Note recorded with this decision'));
        const field = node('textarea', 'goal-decide-note');
        field.value = goalDecideNote;
        field.rows = 3;
        field.placeholder = 'Optional. What you checked, or what has to change.';
        field.maxLength = 500;
        const preview = node('p', 'goal-decide-preview', '');
        function goalDecidePreview() {
          preview.textContent = 'Stored on the task as: \\u201c' + goalDecideNoteWords() + '\\u201d';
        }
        goalDecidePreview();
        field.addEventListener('input', () => {
          // The note is kept here and the preview updated in place, so typing
          // never rebuilds the field it is being typed into.
          goalDecideNote = field.value;
          goalDecidePreview();
        });
        label.append(field);
        card.append(label, preview);

        if (goalDecideArmedNow()) {
          card.append(node('p', 'goal-decide-confirm',
            'Tap \\u201c' + GOAL_VERDICT[goalDecideArmed].label + '\\u201d again to record it.'));
          card.append(node('p', 'goal-decide-writes', GOAL_DECIDE_WRITES[goalDecideArmed]));
          card.append(node('p', 'goal-decide-writes', GOAL_DECIDE_ALWAYS));
        } else {
          card.append(node('p', 'goal-decide-writes',
            'A decision here is durable. Tap a verdict to read exactly what it writes and where; tap it again to record it.'));
        }

        const acts = node('div', 'goal-decide-acts');
        ['approve', 'request_changes', 'reject'].forEach((verdict) => acts.append(goalDecideButton(verdict)));
        card.append(acts);
        settle(card);
      }

      function goalPaintOne(data) {
        const head = node('div', 'goal-head');
        const back = node('button', 'secondary goal-back', 'All goals');
        back.type = 'button';
        back.addEventListener('click', () => goalClose());
        head.append(back, node('div', 'goal-head-name', data.title || goalOpenName));
        const parts = [head];

        const meta = node('div', 'goal-meta goal-head-meta');
        meta.append(goalTag(GOAL_STATE, data.status));
        meta.append(node('span', '', data.projectName || 'Unknown project'));
        meta.append(node('span', '', data.risk + ' risk'));
        // A null base commit has several causes — no repository, a repository
        // with no commit yet, a git read that failed — and neither this device
        // nor the Mac can tell them apart from the record, so the absence is
        // reported and no cause is named for it.
        meta.append(node('span', 'goal-mono', data.baseCommit
          ? 'base ' + data.baseCommit.slice(0, 10)
          : 'no base commit recorded'));
        meta.append(node('span', '', 'updated ' + ago(data.updatedAt) + ' ago'));
        parts.push(meta);
        // A pointer rather than a second copy of the controls. The decision
        // belongs under the evidence it is made from, and a goal that is
        // waiting on a person should say so before they have read three
        // screens of task graph to find out.
        if (data.decision && data.decision.awaiting) {
          parts.push(node('p', 'goal-pointer',
            'This goal is waiting on your decision. The gate result and the decision are at the bottom of this screen, under the evidence.'));
        }

        parts.push(node('h3', 'goal-sub', 'Objective'));
        parts.push(goalProse(data.objective));
        parts.push(node('h3', 'goal-sub', 'Acceptance checks'));
        const checks = Array.isArray(data.acceptance) ? data.acceptance : [];
        if (!checks.length) {
          parts.push(ui.empty('This goal carries no acceptance checks.',
            'Nothing was written down for a review to be held to, so a review here is a judgement rather than a check.'));
        } else {
          const list = node('ol', 'goal-checks');
          checks.forEach((check) => list.append(node('li', '', check.text)));
          parts.push(list);
          if (data.acceptanceOmitted > 0) {
            parts.push(node('p', 'goal-note', number(data.acceptanceOmitted) +
              ' further checks were not sent to this device.'));
          }
        }

        parts.push(node('h3', 'goal-sub', 'Spend'));
        parts.push(goalDispatchCard(data.autopilot || {}));

        parts.push(node('h3', 'goal-sub', 'Task graph'));
        const tasks = Array.isArray(data.tasks) ? data.tasks : [];
        if (!tasks.length) {
          parts.push(ui.empty('This goal has no tasks recorded.',
            'A goal without a task graph cannot be worked or accepted; open it on the Mac.'));
        } else {
          const list = node('div', 'goal-tasks');
          tasks.forEach((task) => list.append(goalTaskCard(task)));
          parts.push(list);
          if (data.tasksOmitted > 0) {
            parts.push(node('p', 'goal-note', number(data.tasksOmitted) +
              ' further tasks were not sent to this device. The graph on the Mac is larger than this.'));
          }
        }
        // A count, never the paths. The Git screen is the only surface Wanigan
        // sends a path to, and it is separately switched on.
        parts.push(node('p', 'goal-reading', data.claimsHeld > 0
          ? number(data.claimsHeld) + (data.claimsHeld === 1
            ? ' file claim is held right now. The path stays on the Mac.'
            : ' file claims are held right now. The paths stay on the Mac.')
          : 'No file claim is held right now.'));

        goalEvidence(data).forEach((part) => parts.push(part));
        // Last, and after the evidence on purpose: the proof bundle and the
        // continuity records are what the decision is made from, and a verdict
        // above them is a verdict taken before them.
        goalDecideData = data;
        goalDecideHost = node('div', 'goal-decide-host');
        parts.push(goalDecideHost);
        parts.push(node('p', 'goal-asof', goalAsOfWords()));
        goalBody().replaceChildren(...parts);
        goalDecidePaint();
      }

      async function goalRead(force) {
        const asked = goalOpenId;
        const what = asked ? 'this goal' : 'your goals';
        // Held, not skipped: the reading is left exactly as it was and only the
        // as-of line moves, so a screen frozen under a half-made decision still
        // says how old what it is showing is.
        if (goalDecideHolding()) { goalTouchAsOf(); return; }
        if (!force && goalPainted && Date.now() - goalReadAt < GOAL_MIN_MS) { goalTouchAsOf(); return; }
        if (!goalPainted) goalBody().replaceChildren(ui.reading(what));
        try {
          const data = await api(asked ? 'api/goal?goal=' + encodeURIComponent(asked) : 'api/goals');
          // The operator may have opened a goal, or gone back, while this was in
          // flight. Painting the answer to the question they stopped asking is
          // worse than waiting one more tick for the right one.
          if (goalOpenId !== asked) return;
          // This device's clock, not the Mac's generatedAt: subtracting one from
          // the other turns a couple of minutes of skew into a staleness that
          // never happened.
          goalReadAt = Date.now();
          goalPainted = true;
          if (asked) goalPaintOne(data.goal || {});
          else goalPaintList(data);
        } catch (failure) {
          if (goalOpenId !== asked) return;
          goalPainted = false;
          const box = ui.failed(what, failure instanceof Error ? failure.message : '', () => goalRead(true));
          const parts = [box];
          // A goal that has been removed on the Mac fails every retry, so the
          // way back to the list is on the screen beside the retry rather than
          // only behind a header this paint never drew.
          if (asked) {
            const back = node('button', 'secondary goal-back', 'All goals');
            back.type = 'button';
            back.addEventListener('click', () => goalClose());
            parts.push(back);
          }
          goalBody().replaceChildren(...parts);
        }
      }

      function goalOpen(id, title) {
        goalOpenId = String(id || '');
        goalOpenName = String(title || '');
        goalPainted = false;
        goalReadAt = 0;
        // A note typed against one goal is not a note about the next one, and a
        // verdict armed on one review must never survive into another.
        goalDecideReset();
        window.scrollTo(0, 0);
        void goalRead(true);
      }

      // Back to the list, which is re-read rather than restored from what this
      // device was showing before the goal was opened: a task graph's worth of
      // reading time has passed, and a list painted from memory would claim a
      // freshness it does not have.
      function goalClose() {
        goalOpenId = '';
        goalOpenName = '';
        goalPainted = false;
        goalReadAt = 0;
        goalDecideReset();
        void goalRead(true);
      }`,
  wiring: `      // No interval of this screen's own: ui.watch runs the read when the Goals
      // screen comes up and again on each poll that returns while it is still
      // there, and goalRead's own floor keeps that from becoming twenty spend
      // aggregates every three seconds.
      ui.watch('goals', () => goalRead(false));`,
};
