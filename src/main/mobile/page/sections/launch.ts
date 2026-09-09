import type { MobileSection } from '../sections';

/**
 * Starting new work: project, provider, model and effort, then a prompt.
 *
 * The two dependent fields are drawn from the offer the Mac computed for the
 * chosen profile — src/main/mobile/launch-options.ts — and never from a list
 * this page keeps of its own. That is a change of authority, not of layout: the
 * page used to render one flat array of efforts under a fixed 'Reasoning
 * effort' caption, which offered the shipped Codex profile levels its launch
 * compiler refuses, showed a disabled picker for profiles that take no effort
 * at all, and could not narrow the list when a model accepts fewer. So the
 * answer now says which control to draw as well as what to put in it: a set the
 * profile opened with `allowCustom` is a text box, a closed one is a picker,
 * and a field the profile does not take is neither.
 *
 * Each field is therefore a pair of labels, one holding a select and one an
 * input, with exactly one of them on screen. Swapping the control inside a
 * single label would leave the caption pointing at a hidden element, and a
 * caption that focuses nothing when tapped is worse on a phone than anywhere.
 *
 * The account row answers the question the phone could not ask at all: which
 * login this session signs in as. An operator with a work account and a
 * personal one had no way to say from here, and a launch that silently takes
 * whatever the app default resolves to writes to the wrong history and spends
 * the wrong subscription. Its first option is the ABSENCE of a choice, so it
 * names the account this project would actually fall back to — a sentence only
 * the Mac can write, because the project's pin lives in its database — and the
 * caption below never calls a deliberately chosen account "your default".
 *
 * The row beside it is that pin, and the two are deliberately different
 * questions asked in the same place. The first is "this launch"; the second is
 * "this repository, from now on" — the choice that stops an operator having to
 * remember, and the one that previously required walking to the Mac. Seeing the
 * pinned login BEFORE launching is the point of putting it here rather than on
 * a settings screen: the identity a session commits under is not something to
 * discover afterwards.
 *
 * Three absences, drawn through ui.* rather than as a blank row. Nothing read
 * yet is ui.reading — the pin is a fact about the Mac's database and this
 * device may never have reached it. A refused or failed write is ui.failed with
 * the Mac's own sentence and a retry, never a silently reverted picker. And one
 * account is ui.empty: pinning needs something to choose between, and a
 * one-option picker offering the login you already have is a control that
 * cannot do anything. Settings.tsx hides its picker below two accounts for the
 * same reason.
 *
 * What the pin does NOT do is reach a running session, and the sentence saying
 * so is checked rather than decorative: sessions.ts resolves the account once
 * at spawn, freezes it onto the session and into session_log.account_id, and
 * builds the child's environment from that frozen answer. So a session already
 * running keeps its login because the pin is never read again — and a resumed
 * conversation keeps the account it was recorded under, which outranks the pin
 * outright. Both are said plainly instead of being left for someone to find.
 */
export const LAUNCH_SECTION: MobileSection = {
  id: 'launch',
  anchorId: 'launch-form',
  slot: 'controls',
  markup: `        <div class="control-card">
          <div class="console-kicker">New work</div><h3>Start an agent</h3><p>Launches a normal Wanigan session on your Mac with the model and reasoning effort you choose.</p>
          <form id="launch-form" class="fields"><label class="field-label"><span>Project</span><select id="project" aria-label="Project"></select></label><label class="field-label"><span>Provider</span><select id="provider" aria-label="Provider"></select></label><label class="field-label" id="model-field"><span id="model-label">Model</span><select id="model" aria-label="Model"></select></label><label class="field-label hidden" id="model-open-field"><span id="model-open-label">Model</span><input id="model-open" type="text" aria-label="Model" maxlength="120" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="CLI default"></label><label class="field-label" id="effort-field"><span id="effort-label">Reasoning effort</span><select id="effort" aria-label="Reasoning effort"></select></label><label class="field-label hidden" id="effort-open-field"><span id="effort-open-label">Reasoning effort</span><input id="effort-open" type="text" aria-label="Reasoning effort" maxlength="120" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="CLI default"></label><label class="field-label hidden" id="account-field"><span>Account for this session</span><select id="account" aria-label="Account for this session"></select></label><label class="field-label hidden" id="account-pin-field"><span>Account for this project</span><select id="account-pin" aria-label="Account pinned to this project"></select></label><p id="account-note" class="account-note hidden" role="status"></p><p id="account-pin-note" class="account-note hidden" role="status"></p><div id="account-pin-state" class="account-pin-state hidden"></div><textarea id="launch-prompt" aria-label="Task for the new agent" maxlength="8000" required placeholder="What should this agent do?"></textarea><p id="launch-blocker" class="account-note hidden" role="status"></p><button>Start session</button></form>
        </div>`,
  /* `.field-label` sets a display of its own and is declared after the shared
     `.hidden`, so the two tie on specificity and the later rule wins: a field
     marked hidden would stay laid out, showing both halves of a pair and a
     picker for a field the profile does not take. nav.ts re-states the rule for
     `.sheet` for exactly this reason. */
  style: `    .field-label.hidden { display:none; }
    /* The caption declares no display of its own, so the shared hidden rule is
       the only thing that decides whether it is on screen. */
    .account-note { grid-column:1 / -1; color:var(--dim); font-size:12px; }
    /* The ui.* box is a grid item like any other field, so it is spanned across
       both columns rather than squeezed into one. It declares no display of its
       own, which is what leaves the shared \`.hidden\` rule free to decide
       whether it is on screen at all. */
    .account-pin-state { grid-column:1 / -1; }`,
  script: `
      // Which profile the two dependent fields are currently drawn for. A poll
      // returns every three seconds and re-renders this form; without this the
      // re-render could not tell "the operator switched provider, re-seed from
      // the new profile's declared defaults" from "nothing changed, leave what
      // they picked alone".
      let launchProfileId = '';

      function launchOffer() {
        const provider = (controlOptions && controlOptions.providers || []).find((value) => value.id === byId('provider').value);
        return provider && provider.launch || null;
      }

      // The visible half of a field's pair carries its value; the hidden half
      // still holds whatever the previously chosen profile needed.
      function launchControl(id) {
        return byId(id + '-open-field').classList.contains('hidden') ? byId(id) : byId(id + '-open');
      }

      // The Fleet screen's button, and the reason it exists: on an iPhone the
      // launch form is below a terminal and, before this, below every installed
      // skill as well. A form two screens down is a form nobody found, which is
      // the same experience as a phone that cannot start a session. This puts it
      // on screen in one tap, with the cursor already in the box that says what
      // the agent should do.
      function openLaunch() {
        if (!remoteControlEnabled) return;
        setView('agent', 'push');
        const card = byId('launch-form');
        if (card && card.scrollIntoView) card.scrollIntoView({ block: 'start' });
        byId('launch-prompt').focus({ preventScroll: true });
      }

      function launchValue(id) {
        return launchControl(id).value.trim();
      }

      function renderLaunchField(id, field, choices, previous, reseed) {
        const closed = byId(id), open = byId(id + '-open');
        const supported = !!field && field.supported === true;
        byId(id + '-field').classList.toggle('hidden', !supported || field.open === true);
        byId(id + '-open-field').classList.toggle('hidden', !supported || field.open !== true);
        // Nothing offered means nothing sent: a profile that does not take this
        // field must not launch with a leftover value from the one before it.
        if (!supported) { closed.replaceChildren(); closed.value = ''; open.value = ''; return; }
        text(id + '-label', field.label);
        text(id + '-open-label', field.label);
        closed.replaceChildren(...choices.map((choice) => option(choice.value, choice.label)));
        closed.disabled = choices.length === 0;
        // replaceChildren has already dropped a selection the new offer no
        // longer contains, which is the point: moving Codex to a model with a
        // narrower reasoning range used to leave the wider level selected and
        // armed, and it died in the launch compiler rather than here.
        restoreValue(closed, reseed ? field.defaultValue || '' : previous);
        if (reseed) open.value = field.defaultValue || '';
      }

      function renderLaunchChoices(previous) {
        const providerId = byId('provider').value;
        const reseed = providerId !== launchProfileId;
        launchProfileId = providerId;
        const offer = launchOffer();
        renderLaunchField('model', offer && offer.model, offer && offer.model.choices || [],
          previous && previous.model || byId('model').value, reseed);
        renderLaunchEfforts(reseed);
        renderLaunchAccount(reseed);
      }

      // Two claims about one launch, and the offer is where they agree: the
      // profile says which efforts it will compile, the CLI's catalogue says
      // which ones the chosen model accepts. Both are the Mac's to hold, so the
      // narrowed list arrives attached to the model it belongs to and this page
      // only has to read the right one.
      function renderLaunchEfforts(reseed) {
        const offer = launchOffer();
        const chosen = offer ? (offer.model.choices || []).find((choice) => choice.value === launchValue('model')) : null;
        renderLaunchField('effort', offer && offer.effort,
          chosen && chosen.efforts || (offer && offer.effort.choices) || [],
          byId('effort').value, reseed === true);
      }

      function launchAccounts() {
        const provider = (controlOptions && controlOptions.providers || []).find((value) => value.id === byId('provider').value);
        return provider && provider.accounts || null;
      }

      // What this launch signs in as with nothing chosen here, for the project
      // that is chosen. Looked up, never worked out: which account a project
      // falls back to depends on a pin held in the database on the Mac, and a
      // page that guessed would say "your default" for a project deliberately
      // pinned to the other login.
      function launchAccountFollow(offer) {
        const projectId = byId('project').value;
        return offer && (offer.follow || []).find((row) => row.projectId === projectId) || null;
      }

      function renderLaunchAccount(reseed) {
        const offer = launchAccounts();
        const select = byId('account');
        const supported = !!offer && offer.supported === true && (offer.choices || []).length > 0;
        byId('account-field').classList.toggle('hidden', !supported);
        byId('account-note').classList.toggle('hidden', !supported);
        // A profile that signs in against another vendor has no account to
        // choose, and a leftover id from the profile before it would be an id
        // the Mac refuses.
        if (!supported) { select.replaceChildren(); select.value = ''; sayAccount(''); renderAccountPin(); return; }
        const follow = launchAccountFollow(offer);
        // Switching profile drops the pick: an account belongs to a harness,
        // and carrying one across would post an id this launch has to refuse.
        const previous = reseed ? '' : select.value;
        select.replaceChildren(option('', follow
          ? 'Follow ' + (follow.source === 'project' ? 'this project' : 'your default') + ' — ' + follow.label
          : 'Follow this project or your default'),
          ...offer.choices.map((row) => option(row.id,
            row.label + (row.isDefault ? ' · default' : '') + (row.present ? '' : ' · directory missing'))));
        // An account removed at the Mac since this page loaded is simply no
        // longer in the list, so restoreValue leaves the follow option selected
        // — and the caption below then says which login that is, rather than
        // letting a stale name stand.
        restoreValue(select, previous);
        sayAccount(launchAccountSentence(offer, follow));
        renderAccountPin();
      }

      // The poll re-renders this form every three seconds, and the caption is a
      // live region: writing the same sentence back into it would announce it
      // again on every pass, so only a real change is written.
      function sayAccount(sentence) {
        const note = byId('account-note');
        if (note.textContent !== sentence) note.textContent = sentence;
      }

      // One sentence, in the order the operator needs it: which login, then why
      // that one, then anything that would stop it being true. A chosen account
      // reads as chosen — never as the default, which it may well not be.
      function launchAccountSentence(offer, follow) {
        const chosen = (offer.choices || []).find((row) => row.id === byId('account').value);
        let sentence = chosen
          ? 'Signs in as ' + chosen.label + ' — chosen for this session only.'
          : follow
            ? 'Signs in as ' + follow.label + (follow.source === 'project' ? ' — this project is set to it.' : ' — your default account.')
            : 'Choose a project to see which login this would sign in as.';
        if (chosen && chosen.present === false) sentence += ' Its directory is no longer on the Mac.';
        // Absence of evidence: on macOS the login lives in the Keychain, which
        // Wanigan does not read, so this is never "signed out".
        if (chosen && chosen.signedIn === 'unknown') sentence += ' Wanigan cannot see whether it is signed in; if the session asks, run /login once.';
        // The agent ranks an exported credential above a stored login, so with
        // one set the row above is not what the session authenticates with.
        if (offer.override) sentence += ' ' + offer.override + ' is set on the Mac and outranks a stored login, so this session uses that credential and not the account above.';
        return sentence;
      }

      // A write is in flight, and the Mac's own sentence for the last one that
      // did not land. The picker is never quietly reverted on a refusal: an
      // operator who watched a control snap back has no idea whether the change
      // was rejected, lost, or applied to something else.
      let accountPinBusy = false;
      let accountPinError = '';
      // A re-read of the form is in flight after a failure. Without it the
      // retry button would appear to do nothing on a slow connection, and the
      // one state the operator is owed while waiting — 'still reading' — would
      // be a branch below that nothing could ever reach.
      let accountPinReading = false;
      // What the last write did, kept until the operator moves to another
      // project or profile. A confirmation wiped by the next three-second poll
      // is one an operator can miss entirely, so it is held — which is only
      // honest because every clause in it stays true: what was pinned, and what
      // was already running at the moment it changed, in the past tense.
      let accountPinSaid = '';
      let accountPinSaidFor = '';

      function accountPinKey() {
        return byId('project').value + '|' + byId('provider').value;
      }

      // The pin row, and the three absences it can be in instead.
      //
      // Every branch returns, so exactly one of them is on screen: a picker, or
      // a reading box, or a failure with the Mac's sentence, or the statement
      // that there is nothing here to choose between. The picker itself is only
      // drawn from a follow row the Mac wrote — which account is pinned, and
      // what clearing it would restore, are both facts about a database on the
      // other end of this connection and neither is worked out here.
      function renderAccountPin() {
        // A change already posted owns the control until it comes back. The
        // poll re-renders this form every three seconds, and a re-render mid
        // write would put the old value back under the operator's finger.
        if (accountPinBusy) return;
        const field = byId('account-pin-field');
        const note = byId('account-pin-note');
        const box = byId('account-pin-state');
        const select = byId('account-pin');
        const showPicker = (visible) => {
          field.classList.toggle('hidden', !visible);
          note.classList.toggle('hidden', !visible);
          if (!visible) { select.replaceChildren(); select.value = ''; }
        };
        const showState = (child) => {
          showPicker(false);
          box.replaceChildren(child);
          box.classList.remove('hidden');
        };
        const what = 'which login this project is pinned to';
        // Nothing has been established yet. The Mac holds this record and this
        // device may never have reached it, so the row says it is still reading
        // rather than drawing an empty picker that reads as "no pin".
        if (accountPinReading || !ui.observed() || !controlOptions) { showState(ui.reading(what)); return; }
        if (accountPinError) { showState(ui.failed(what, accountPinError, pinRetry)); return; }
        const offer = launchAccounts();
        // This profile signs in against another vendor, or has no account
        // decision at all. The session row above is hidden for the same answer
        // and says why; a second copy of that sentence here would be noise.
        if (!offer || offer.supported !== true) {
          showPicker(false); box.replaceChildren(); box.classList.add('hidden'); return;
        }
        const choices = offer.choices || [];
        if (choices.length < 2) {
          showState(ui.empty('There is only one login to sign in as.',
            'Pinning a repository to an account needs a second one. Add it in Wanigan Settings → Accounts on the Mac.'));
          return;
        }
        if (!byId('project').value) {
          showState(ui.empty('No project is chosen.', 'Choose one above to see which login it is pinned to.'));
          return;
        }
        const follow = launchAccountFollow(offer);
        // A project on screen that the Mac's answer does not cover. Said as a
        // failed read, because that is what it is — not as "no pin", which
        // would be this page inventing a record it never saw.
        if (!follow) {
          showState(ui.failed(what, 'The Mac did not say which login this project uses.', pinRetry));
          return;
        }
        box.replaceChildren();
        box.classList.add('hidden');
        showPicker(true);
        select.replaceChildren(option('', 'No pin — follows ' + follow.fallbackLabel),
          ...choices.map((row) => option(row.id,
            row.label + (row.isDefault ? ' · default' : '') + (row.present ? '' : ' · directory missing'))));
        // An account removed at the Mac since this page loaded is no longer in
        // the list, so the control falls back to the unpinned option rather
        // than showing a name nothing on the Mac answers to.
        restoreValue(select, follow.pinnedAccountId || '');
        select.disabled = false;
        sayPin(accountPinSaid && accountPinSaidFor === accountPinKey()
          ? accountPinSaid : pinSentence(follow));
      }

      // The caption is a live region, so only a real change is written into it.
      function sayPin(sentence) {
        const note = byId('account-pin-note');
        if (note.textContent !== sentence) note.textContent = sentence;
      }

      // What is pinned, what would happen without it, and when a change lands.
      // The last clause is true whenever it is printed rather than conditional
      // on a liveness reading this row does not have: the pin is read once, at
      // the moment a session starts.
      function pinSentence(follow) {
        return (follow.pinnedAccountId
          ? 'Pinned: new sessions here sign in as ' + follow.label + '. Without the pin they would use ' + follow.fallbackLabel + '.'
          : 'No pin: new sessions here sign in as ' + follow.fallbackLabel + ' — your default account.')
          + ' A pin is read when a session starts, so one already running keeps the login it started with, and a resumed conversation keeps the account it was recorded under.';
      }

      // What the write actually did, from the write's own answer.
      //
      // The count is the only liveness claim this row ever makes, and it is
      // made from a number the Mac produced in the same breath as the write —
      // never from the cached /api/control payload, which is as old as this
      // page and would have this line reporting an agent that finished an hour
      // ago. It is written in the past tense for the same reason: 'was already
      // running when you changed it' stays true while the line is on screen,
      // and 'is running' would not. A missing count claims nothing at all: the
      // desktop may have wired no bridge to answer, and that is not zero.
      function pinConfirmation(result) {
        const follow = result && result.follow;
        if (!follow) return 'Saved.';
        let sentence = 'Saved. ' + pinSentence(follow);
        const running = result.runningSessions;
        if (typeof running === 'number' && running === 1) {
          sentence += ' One session was already running here when you changed it, and keeps the login it started with.';
        } else if (typeof running === 'number' && running > 1) {
          sentence += ' ' + running + ' sessions were already running here when you changed it, and keep the logins they started with.';
        }
        return sentence;
      }

      // Read the whole form again from the Mac. Used as the retry on a failed
      // read and after a write, because /api/control is where every other row
      // on this screen comes from and one screen must not hold two answers.
      async function pinRefresh() {
        controlOptions = await api('api/control');
        renderLaunchAccount(false);
      }

      async function pinRetry() {
        accountPinError = '';
        accountPinReading = true;
        renderAccountPin();
        try { await pinRefresh(); }
        catch (failure) {
          accountPinError = failure instanceof Error ? failure.message : 'The Mac did not answer.';
        } finally {
          accountPinReading = false;
          renderAccountPin();
        }
      }

      // Setting which identity a repository's agents sign in as: a write, at
      // control scope, carrying two ids the Mac issued and nothing else. No
      // path crosses in either direction — the config directory that actually
      // selects the login stays on the Mac, as it does everywhere else here.
      async function pinAccountToProject() {
        if (accountPinBusy) return;
        const select = byId('account-pin');
        const projectId = byId('project').value;
        const providerId = byId('provider').value;
        if (!projectId || !providerId) return;
        accountPinBusy = true;
        accountPinError = '';
        accountPinSaid = '';
        select.disabled = true;
        sayPin('Saving which login this project signs in as…');
        let result = null;
        try {
          result = await api('api/project-account', { method:'POST', headers:{ 'content-type':'application/json', authorization:'Bearer ' + localStorage.getItem(KEY) }, body:JSON.stringify({ projectId, providerId, accountId: select.value || null }) });
        } catch (failure) {
          // A refusal replaces the row with the Mac's own sentence and a retry.
          // The one thing it never does is snap the picker quietly back to the
          // previous value: a control that reverts with no explanation leaves
          // an operator unable to tell a rejection from a change that landed
          // somewhere they were not looking.
          accountPinBusy = false;
          select.disabled = false;
          accountPinError = failure instanceof Error ? failure.message : 'The Mac refused that change.';
          renderAccountPin();
          return;
        }
        accountPinBusy = false;
        select.disabled = false;
        accountPinSaid = pinConfirmation(result);
        accountPinSaidFor = projectId + '|' + providerId;
        try { await pinRefresh(); }
        catch (failure) {
          // The write landed; only reading the form back did not. Saying "could
          // not save" here would send someone to change it again.
          accountPinError = 'The change was saved, but this page could not read the form back afterwards: '
            + (failure instanceof Error ? failure.message : 'the Mac did not answer.');
          renderAccountPin();
        }
      }`,
  wiring: `      byId('provider').addEventListener('change', () => { renderLaunchChoices(); syncActionButtons(); });
      byId('model').addEventListener('change', () => renderLaunchEfforts(false));
      byId('model-open').addEventListener('input', () => renderLaunchEfforts(false));
      byId('account').addEventListener('change', () => renderLaunchAccount(false));
      byId('account-pin').addEventListener('change', () => { void pinAccountToProject(); });
      // The fallback account is a fact about the project, so changing the
      // project changes the sentence under the picker.
      byId('project').addEventListener('change', () => { renderLaunchAccount(false); syncActionButtons(); });
      byId('launch-prompt').addEventListener('input', syncActionButtons);
      byId('launch-form').addEventListener('submit', async (event) => {
        event.preventDefault(); controlResult.textContent = 'Starting session…';
        if (actionBusy) return;
        setActionBusy(true);
        try {
          const result = await api('api/action', { method:'POST', headers:{ 'content-type':'application/json', authorization:'Bearer ' + localStorage.getItem(KEY) }, body:JSON.stringify({ action:'launch', projectId:byId('project').value, providerId:byId('provider').value, model:launchValue('model'), effort:launchValue('effort'), accountId:byId('account').value, prompt:byId('launch-prompt').value }) });
          byId('launch-prompt').value = ''; syncActionButtons(); controlResult.textContent = 'Started ' + result.session.title + '.';
          requestedSessionId = result.session.id; await poll(); openSession(result.session.id);
        } catch (error) { controlResult.textContent = error instanceof Error ? error.message : 'Could not start the session.'; }
        finally { setActionBusy(false); }
      });`,
};
