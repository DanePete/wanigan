import type { MobileSection } from '../sections';

/**
 * The installed skills, on the Agent screen, one tap from the session above.
 *
 * There is no Skills screen on the phone and there is not meant to be one:
 * writing a skill is editing a file inside a working tree, and this device has
 * no working tree. Invoking one that already exists is a different act — it
 * needs no repository, edits nothing, and puts no path on the wire — so it
 * lives here, in the remote-control block, under the console it types into.
 * shared/mobile-nav.ts says exactly that now, rather than the older sentence
 * that made both halves sound like the same thing.
 *
 * The claim this screen has to get right is what a tap does. It types the
 * command into the agent's prompt and stops there: no carriage return, nothing
 * submitted, and no assertion at all about what the agent will do with it. So
 * the standing sentence in the card says so before anything is tapped, and the
 * result line afterwards is read off the answer's own `submitted` field rather
 * than off a memory of what this button used to do — 'Typed … into the prompt.
 * Nothing was sent' is checkable, and 'ran the skill' is not something Wanigan
 * is in a position to know.
 *
 * A session Wanigan will not type into gets the Mac's own refusal, verbatim,
 * and the list goes flat: the names stay readable — a Codex session's refusal
 * says in so many words to copy the name and invoke it the way that CLI expects
 * — but nothing on screen is a button, because a row of buttons that each fail
 * in turn is worse than no buttons at all. The same rule covers a command
 * ../skills predicts Claude Code would itself refuse.
 *
 * The search runs on the Mac. It is one substring over names and descriptions,
 * and the result stays in the catalogue's own order rather than being re-ranked:
 * thirty rows out of two hundred sorted by name look exactly like thirty best
 * matches, and the note under the list says which of the two it is.
 */
export const SKILLS_SECTION: MobileSection = {
  id: 'skills',
  anchorId: 'agent-skills',
  slot: 'controls',
  markup: `        <div id="agent-skills" class="control-card agent-skills">
          <div class="console-kicker">Installed skills</div>
          <h3>Send a skill to this agent</h3><p>Wanigan types the command into the session selected above, exactly as typing it at the Mac would &mdash; and stops there. It does not press Enter, so nothing is sent until you send it, and it cannot tell you whether the agent will run it. Writing or editing a skill is work against a repository and stays on the Mac.</p>
          <label class="field-label skill-search"><span>Find a skill</span><input id="skill-q" type="search" aria-label="Search installed skills" maxlength="80" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Name or description"></label>
          <div id="skill-list" class="skill-list"></div>
          <div id="skill-notes" class="skill-notes"></div>
        </div>`,
  style: `    .agent-skills { scroll-margin-top:16px; }
    .skill-search { margin-bottom:10px; }
    .skill-list,.skill-notes { display:grid; gap:8px; }
    .skill-notes { gap:6px; margin-top:9px; }
    /* Section styles are appended after the shared sheet, so a display of ours
       ties with .hidden on specificity and wins on order. Nothing here is
       hidden today; this is the guard that keeps that true if something is. */
    .skill-row.hidden,.skill-notes.hidden,.skill-blocked.hidden { display:none; }
    /* A row is a button, so it takes the shared button rules and undoes the
       ones that belong to a primary action: this is a list, not fourteen
       accent-filled call-to-actions stacked on a phone. */
    .skill-row { display:grid; gap:4px; text-align:left; min-height:52px; padding:11px 12px; border:1px solid var(--line); border-radius:10px; background:transparent; color:var(--ink); font-weight:400; }
    /* The rows that cannot be tapped, told apart by their edge rather than by
       colour alone — and always alongside the sentence that says why. */
    .skill-row-flat { border-style:dashed; }
    .skill-row-top { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
    .skill-invoke { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:14px; font-weight:720; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .skill-origin { flex:none; border:1px solid var(--line); border-radius:999px; padding:2px 8px; color:var(--dim); font-size:11px; font-weight:700; white-space:nowrap; }
    .skill-desc { color:var(--dim); font-size:12px; line-height:1.5; }
    .skill-flag { color:var(--serious); font-size:11px; font-weight:700; line-height:1.5; }
    .skill-note { color:var(--faint); font-size:11px; line-height:1.5; }
    .skill-blocked { display:grid; grid-template-columns:auto minmax(0,1fr); gap:9px; padding:11px 12px; border:1px solid color-mix(in srgb,var(--serious) 45%,var(--line)); border-radius:10px; color:var(--serious); font-size:12px; line-height:1.5; }
    .skill-blocked strong { color:var(--ink); display:block; }
    /* The console next door takes the larger target on a coarse pointer for the
       same reason: this is the screen someone uses standing up, and a row here
       types into a live agent. */
    @media (pointer:coarse) { .skill-row { min-height:58px; } }`,
  script: `
      let skillsPayload = null;
      let skillsFailure = '';
      let skillsRefresh = null;
      // A debounce, not a cadence. The frame still owns when this screen reads
      // — ui.watch below — and this only keeps one request per pause in typing
      // rather than one per keystroke on a cellular radio.
      let skillSearchTimer = null;

      function skillsRetry() { if (skillsRefresh) void skillsRefresh(); }

      // The session the Agent screen is currently showing, read from the
      // console's own picker rather than from a copy of it: two variables
      // drifting apart is how a skill gets typed into the agent nobody was
      // looking at.
      function skillsSessionId() {
        const picker = byId('session');
        return picker ? picker.value : '';
      }

      function skillsQuery() {
        const box = byId('skill-q');
        return box ? box.value.trim() : '';
      }

      // Whether the Mac advertises the one key that would submit what was just
      // typed. Read rather than assumed: a bridge with no PTY behind it
      // advertises no keys, and pointing at a button that is not on the page is
      // worse than saying plainly that this build cannot press Enter.
      function skillEnterOffered() {
        const keys = controlOptions && Array.isArray(controlOptions.keys) ? controlOptions.keys : [];
        return keys.some((key) => key && key.name === 'enter');
      }

      // Branches rather than a lookup object, because the key comes off the
      // wire: 'constructor' and 'toString' are hits on any object literal and
      // would resolve to a word this table never wrote.
      function skillOriginWord(origin) {
        if (origin === 'project') return 'This project';
        if (origin === 'personal') return 'Personal';
        if (origin === 'plugin') return 'Plugin';
        if (origin === 'built-in') return 'Built in';
        return 'Source not recognised';
      }

      function skillRowNode(row, live) {
        const tappable = live && row.userInvocable !== 'no';
        const el = tappable ? node('button', 'skill-row') : node('div', 'skill-row skill-row-flat');
        if (tappable) {
          el.type = 'button';
          // The label says what the tap does and where it stops, because the
          // row's own text is a command name and a description of the skill —
          // neither of which says that nothing gets sent.
          el.setAttribute('aria-label', 'Type ' + row.invoke + ' into the selected session without sending it');
          el.addEventListener('click', () => void fireSkill(row));
        }
        const top = node('div', 'skill-row-top');
        top.append(node('span', 'skill-invoke', row.invoke), node('span', 'skill-origin', skillOriginWord(row.origin)));
        el.append(top);
        if (row.description) el.append(node('span', 'skill-desc', row.description));
        if (row.userInvocable === 'no') {
          el.append(node('span', 'skill-flag', 'Claude Code would refuse this one for you, so there is no button on it.'));
        } else if (row.userInvocable === 'unknown') {
          el.append(node('span', 'skill-flag', 'Wanigan could not read whether you may invoke this one; the CLI decides at the moment you do.'));
        }
        return el;
      }

      function skillBlockedNode(reason) {
        const box = node('div', 'skill-blocked');
        const glyph = node('span', 'skill-blocked-glyph', '⁃');
        glyph.setAttribute('aria-hidden', 'true');
        const body = node('div', '');
        body.append(node('strong', '', 'Wanigan will not type into this session.'), node('span', '', reason));
        box.append(glyph, body);
        return box;
      }

      function skillNoteNodes() {
        const out = [];
        if (skillsPayload.truncated) {
          out.push(node('p', 'skill-note', 'Showing ' + (skillsPayload.skills || []).length + ' of ' +
            number(skillsPayload.matchCount) + ' matching commands, in the catalogue’s own order rather than by best match. Narrow the search to reach the rest.'));
        }
        // The Mac's own sentence about the built-in family being the ones seen
        // so far rather than every one that exists. Carried verbatim: a phone
        // that printed a shorter version of it would be claiming an inventory
        // nothing on the Mac has.
        if (skillsPayload.builtinNote) out.push(node('p', 'skill-note', skillsPayload.builtinNote));
        if (skillsPayload.agentSkillCount) {
          out.push(node('p', 'skill-note', number(skillsPayload.agentSkillCount) +
            ' Codex skill files are installed and are not listed here. Wanigan has not verified how Codex invokes one, so there is no button here that would be honest.'));
        }
        return out;
      }

      function paintSkills() {
        const box = byId('skill-list'), notes = byId('skill-notes');
        // Belt and braces: the whole remote-control block is hidden while the
        // opt-in is off, so this is rarely what an operator sees — but a list of
        // buttons that cannot work must not be what they see if it ever is.
        if (!remoteControlEnabled) {
          box.replaceChildren(ui.off('Sending a skill is off.',
            'Remote control is off at the Mac. Enable it in Wanigan Settings → Phone monitor to type a skill into a session from this device.'));
          notes.replaceChildren();
          return;
        }
        if (!skillsPayload) {
          const what = 'the installed skills';
          box.replaceChildren(skillsFailure ? ui.failed(what, skillsFailure, skillsRetry) : ui.reading(what));
          notes.replaceChildren();
          return;
        }
        const sessionId = skillsSessionId();
        const rows = skillsPayload.skills || [];
        const live = Boolean(sessionId) && !skillsPayload.blocked;
        const out = [];
        // Two different reasons nothing can be typed, and they are not the same
        // sentence. The first is about this page — no session is chosen yet —
        // and the second is the Mac's own refusal about the session that is.
        if (!sessionId) {
          out.push(node('p', 'skill-note', 'Choose a running session above, then tap a skill to type it into that agent.'));
        } else if (skillsPayload.blocked) {
          out.push(skillBlockedNode(skillsPayload.blocked));
        }
        if (!rows.length) {
          out.push(skillsPayload.total
            ? ui.empty('No skill matches that search.',
                'Wanigan searched the names and descriptions of the ' + number(skillsPayload.total) + ' commands this session would load.')
            : ui.empty('Wanigan found no skill it can type into this session.',
                'Skills are files on the Mac. A project gets its own by checking them into the repository, which is work this device does not do.'));
        } else {
          out.push(...rows.map((row) => skillRowNode(row, live)));
        }
        box.replaceChildren(...out);
        notes.replaceChildren(...skillNoteNodes());
        syncSkillRows();
      }

      // Re-enabled on every paint and around every fire. Typing a skill spends
      // the same twenty-a-minute action budget as a launch, and a row that still
      // looks live while another action is in flight is how one intended tap
      // becomes two.
      function syncSkillRows() {
        const ready = Boolean(skillsSessionId()) && !actionBusy;
        byId('skill-list').querySelectorAll('button.skill-row').forEach((button) => { button.disabled = !ready; });
      }

      async function loadSkills() {
        // The list is a monitor-scope read and would answer either way, but the
        // card it fills is inside the hidden control block: fetching it every
        // three seconds to paint nothing is a radio kept awake for no screen.
        if (!remoteControlEnabled) { skillsPayload = null; skillsFailure = ''; paintSkills(); return; }
        try {
          skillsPayload = await api('api/skills?session=' + encodeURIComponent(skillsSessionId()) +
            '&q=' + encodeURIComponent(skillsQuery()));
          skillsFailure = '';
        } catch (failure) {
          skillsPayload = null;
          skillsFailure = failure instanceof Error ? failure.message : '';
        }
        paintSkills();
      }

      // Read off the answer, not off a memory of what this button does. If a
      // later build ever submits what it typed, this sentence changes with it
      // rather than going quietly out of date — and neither branch claims the
      // agent did anything with it, because nothing here can establish that.
      function skillTypedSentence(result) {
        const invoke = String(result && result.invoke || 'that command');
        if (result && result.submitted === true) return 'Typed ' + invoke + ' and sent it.';
        return skillEnterOffered()
          ? 'Typed ' + invoke + ' into the prompt. Nothing was sent — press ⏎ above to run it.'
          : 'Typed ' + invoke + ' into the prompt. Nothing was sent, and this Wanigan build cannot press Enter from this device.';
      }

      async function fireSkill(row) {
        const sessionId = skillsSessionId();
        if (!sessionId || actionBusy) return;
        controlResult.textContent = 'Typing ' + row.invoke + '…';
        setActionBusy(true);
        syncSkillRows();
        try {
          // An id and a session, and nothing that resembles the text to write.
          // The Mac resolves the id against its own catalogue and types its own
          // string; this page could not send a command of its own if it tried.
          const result = await api('api/skills/run', { method:'POST', headers:{ 'content-type':'application/json', authorization:'Bearer ' + localStorage.getItem(KEY) }, body:JSON.stringify({ sessionId:sessionId, skillId:row.id }) });
          controlResult.textContent = skillTypedSentence(result);
          void loadTerminal();
        } catch (error) {
          controlResult.textContent = error instanceof Error ? error.message : 'Could not type that skill.';
          // The likeliest refusal is a catalogue that moved underneath the
          // button — a skill renamed, removed or shadowed since the list was
          // drawn — so the list is re-read rather than left showing the row
          // that just failed as though it were still there.
          skillsRetry();
        }
        finally { setActionBusy(false); syncSkillRows(); }
      }`,
  wiring: `      // Guarded because every line below needs this section's markup to have
      // been composed into the frame, and one section's wiring runs in the same
      // closure as every other section's. A registry edit that dropped this
      // card would otherwise take the whole page down on the first null.
      if (byId('skill-list')) {
        paintSkills();
        // The frame owns the cadence. This card holds no interval of its own:
        // its read runs when the Agent screen comes on and again on each poll
        // that returns while it still is, which is also what makes the retry
        // button the same read rather than a second one.
        skillsRefresh = ui.watch('agent', loadSkills);
        // The catalogue is the chosen session's project's, so changing the
        // session changes the list. The console's own listener does its work in
        // the same event; neither replaces the other.
        const skillPicker = byId('session');
        if (skillPicker) skillPicker.addEventListener('change', () => skillsRetry());
        byId('skill-q').addEventListener('input', () => {
          if (skillSearchTimer) clearTimeout(skillSearchTimer);
          skillSearchTimer = setTimeout(() => { skillSearchTimer = null; skillsRetry(); }, 250);
        });
        // The clear button inside a search field fires this and not 'input' in
        // some browsers, which used to leave the list filtered by a term that
        // was no longer on screen.
        byId('skill-q').addEventListener('search', () => skillsRetry());
      }`,
};
