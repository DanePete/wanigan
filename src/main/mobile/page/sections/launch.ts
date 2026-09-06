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
 */
export const LAUNCH_SECTION: MobileSection = {
  id: 'launch',
  anchorId: 'launch-form',
  slot: 'controls',
  markup: `        <div class="control-card">
          <div class="console-kicker">New work</div><h3>Start an agent</h3><p>Launches a normal Wanigan session on your Mac with the model and reasoning effort you choose.</p>
          <form id="launch-form" class="fields"><label class="field-label"><span>Project</span><select id="project" aria-label="Project"></select></label><label class="field-label"><span>Provider</span><select id="provider" aria-label="Provider"></select></label><label class="field-label" id="model-field"><span id="model-label">Model</span><select id="model" aria-label="Model"></select></label><label class="field-label hidden" id="model-open-field"><span id="model-open-label">Model</span><input id="model-open" type="text" aria-label="Model" maxlength="120" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="CLI default"></label><label class="field-label" id="effort-field"><span id="effort-label">Reasoning effort</span><select id="effort" aria-label="Reasoning effort"></select></label><label class="field-label hidden" id="effort-open-field"><span id="effort-open-label">Reasoning effort</span><input id="effort-open" type="text" aria-label="Reasoning effort" maxlength="120" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="CLI default"></label><textarea id="launch-prompt" aria-label="Task for the new agent" maxlength="8000" required placeholder="What should this agent do?"></textarea><button>Start session</button></form>
        </div>`,
  /* `.field-label` sets a display of its own and is declared after the shared
     `.hidden`, so the two tie on specificity and the later rule wins: a field
     marked hidden would stay laid out, showing both halves of a pair and a
     picker for a field the profile does not take. nav.ts re-states the rule for
     `.sheet` for exactly this reason. */
  style: `    .field-label.hidden { display:none; }`,
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
      }`,
  wiring: `      byId('provider').addEventListener('change', () => { renderLaunchChoices(); syncActionButtons(); });
      byId('model').addEventListener('change', () => renderLaunchEfforts(false));
      byId('model-open').addEventListener('input', () => renderLaunchEfforts(false));
      byId('project').addEventListener('change', syncActionButtons);
      byId('launch-prompt').addEventListener('input', syncActionButtons);
      byId('launch-form').addEventListener('submit', async (event) => {
        event.preventDefault(); controlResult.textContent = 'Starting session…';
        if (actionBusy) return;
        setActionBusy(true);
        try {
          const result = await api('api/action', { method:'POST', headers:{ 'content-type':'application/json', authorization:'Bearer ' + localStorage.getItem(KEY) }, body:JSON.stringify({ action:'launch', projectId:byId('project').value, providerId:byId('provider').value, model:launchValue('model'), effort:launchValue('effort'), prompt:byId('launch-prompt').value }) });
          byId('launch-prompt').value = ''; syncActionButtons(); controlResult.textContent = 'Started ' + result.session.title + '.';
          requestedSessionId = result.session.id; await poll(); openSession(result.session.id);
        } catch (error) { controlResult.textContent = error instanceof Error ? error.message : 'Could not start the session.'; }
        finally { setActionBusy(false); }
      });`,
};
