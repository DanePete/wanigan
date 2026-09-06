import type { MobileSection } from '../sections';

/**
 * Starting new work: project, provider, model and effort, then a prompt. The
 * model and effort lists follow the chosen provider, so this screen owns that
 * dependent render even though the shared script populates the two selects
 * above it.
 */
export const LAUNCH_SECTION: MobileSection = {
  id: 'launch',
  anchorId: 'launch-form',
  slot: 'controls',
  markup: `        <div class="control-card">
          <div class="console-kicker">New work</div><h3>Start an agent</h3><p>Launches a normal Wanigan session on your Mac with the model and reasoning effort you choose.</p>
          <form id="launch-form" class="fields"><label class="field-label"><span>Project</span><select id="project" aria-label="Project"></select></label><label class="field-label"><span>Provider</span><select id="provider" aria-label="Provider"></select></label><label class="field-label"><span>Model</span><select id="model" aria-label="Model"></select></label><label class="field-label"><span>Reasoning effort</span><select id="effort" aria-label="Reasoning effort"></select></label><textarea id="launch-prompt" aria-label="Task for the new agent" maxlength="8000" required placeholder="What should this agent do?"></textarea><button>Start session</button></form>
        </div>`,
  style: '',
  script: `
      function renderLaunchChoices(previous) {
        const provider = (controlOptions && controlOptions.providers || []).find((value) => value.id === byId('provider').value);
        const model = byId('model'), effort = byId('effort');
        model.replaceChildren(option('', 'Provider default model'), ...((provider && provider.models) || []).map((value) => option(value.value, value.label)));
        effort.replaceChildren(option('', 'Provider default effort'), ...((provider && provider.efforts) || []).map((value) => option(value, value)));
        restoreValue(model, previous && previous.model || model.value);
        restoreValue(effort, previous && previous.effort || effort.value);
        model.disabled = !provider || !(provider.models || []).length;
        effort.disabled = !provider || !(provider.efforts || []).length;
      }`,
  wiring: `      byId('provider').addEventListener('change', () => { renderLaunchChoices(); syncActionButtons(); });
      byId('project').addEventListener('change', syncActionButtons);
      byId('launch-prompt').addEventListener('input', syncActionButtons);
      byId('launch-form').addEventListener('submit', async (event) => {
        event.preventDefault(); controlResult.textContent = 'Starting session…';
        if (actionBusy) return;
        setActionBusy(true);
        try {
          const result = await api('api/action', { method:'POST', headers:{ 'content-type':'application/json', authorization:'Bearer ' + localStorage.getItem(KEY) }, body:JSON.stringify({ action:'launch', projectId:byId('project').value, providerId:byId('provider').value, model:byId('model').value, effort:byId('effort').value, prompt:byId('launch-prompt').value }) });
          byId('launch-prompt').value = ''; syncActionButtons(); controlResult.textContent = 'Started ' + result.session.title + '.';
          requestedSessionId = result.session.id; await poll(); openSession(result.session.id);
        } catch (error) { controlResult.textContent = error instanceof Error ? error.message : 'Could not start the session.'; }
        finally { setActionBusy(false); }
      });`,
};
