import type { MobileSection } from '../sections';

/**
 * The selected agent: readable terminal output and the next instruction. It
 * appears only when remote control is separately enabled, which is why its
 * markup ships inside the hidden control slot rather than being injected.
 */
export const CONSOLE_SECTION: MobileSection = {
  id: 'console',
  anchorId: 'agent-console',
  slot: 'controls',
  markup: `        <div id="agent-console" class="control-card agent-console" tabindex="-1">
          <div class="console-kicker">Selected agent</div>
          <div class="terminal-head"><div><h3 id="terminal-title">Live terminal output</h3><p>Readable live output from the selected session. Send the next instruction below; permission decisions stay at the Mac.</p></div><button id="terminal-refresh" type="button" class="secondary">Refresh</button></div><pre id="terminal" class="terminal">Choose a running session to open its terminal.</pre>
          <form id="prompt-form" class="fields"><label class="field-label"><span>Session</span><select id="session" aria-label="Running session"></select></label><div></div><textarea id="session-prompt" aria-label="Message for the selected agent" maxlength="8000" required placeholder="Type the next instruction for this agent…"></textarea><button>Send message</button><button id="interrupt" type="button" class="secondary">Interrupt turn</button></form>
        </div>`,
  style: `    .agent-console { scroll-margin-top:16px; border-color:color-mix(in srgb,var(--accent) 45%,var(--line)); }
    .terminal { margin-top:10px; min-height:210px; max-height:58vh; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; padding:13px; border-radius:10px; background:var(--terminal); border:1px solid var(--line); color:var(--terminal-ink); font:15px/1.58 ui-monospace,SFMono-Regular,Menlo,monospace; -webkit-text-size-adjust:100%; }
    .terminal-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .terminal-head p { margin-bottom:0; }
    @media (max-width:680px) { .terminal { min-height:46vh; max-height:62vh; } }`,
  script: `
      async function loadTerminal() {
        const select = byId('session'); const sessionId = select.value;
        const output = byId('terminal');
        if (!sessionId) {
          byId('terminal-title').textContent = 'Live terminal output';
          output.textContent = 'Choose a running session to open its terminal.';
          return;
        }
        if (terminalBusy) return;
        terminalBusy = true;
        const follow = output.scrollTop + output.clientHeight >= output.scrollHeight - 24;
        try {
          const detail = await api('api/terminal?session=' + encodeURIComponent(sessionId));
          byId('terminal-title').textContent = detail.title + (detail.running ? ' · live' : ' · ended');
          output.textContent = detail.text || 'No terminal output yet.';
          if (follow) output.scrollTop = output.scrollHeight;
        } catch (error) { output.textContent = error instanceof Error ? error.message : 'Could not read this terminal.'; }
        finally { terminalBusy = false; }
      }
      function openSession(sessionId) {
        if (!remoteControlEnabled) return;
        requestedSessionId = sessionId;
        void renderControls(visibleSessions).then(() => {
          const console = byId('agent-console');
          console.scrollIntoView({ behavior: 'smooth', block: 'start' });
          console.focus({ preventScroll: true });
        });
      }`,
  wiring: `      byId('session-prompt').addEventListener('input', syncActionButtons);
      byId('session').addEventListener('change', () => { syncActionButtons(); byId('terminal').textContent = 'Loading terminal…'; void loadTerminal(); });
      byId('terminal-refresh').addEventListener('click', () => void loadTerminal());
      byId('prompt-form').addEventListener('submit', async (event) => {
        event.preventDefault(); controlResult.textContent = 'Sending instruction…';
        if (actionBusy) return;
        setActionBusy(true);
        try { await api('api/action', { method:'POST', headers:{ 'content-type':'application/json', authorization:'Bearer ' + localStorage.getItem(KEY) }, body:JSON.stringify({ action:'prompt', sessionId:byId('session').value, prompt:byId('session-prompt').value }) }); byId('session-prompt').value = ''; syncActionButtons(); controlResult.textContent = 'Instruction sent.'; void loadTerminal(); }
        catch (error) { controlResult.textContent = error instanceof Error ? error.message : 'Could not send instruction.'; }
        finally { setActionBusy(false); }
      });
      byId('interrupt').addEventListener('click', async () => {
        controlResult.textContent = 'Interrupting…';
        if (actionBusy) return;
        setActionBusy(true);
        try { await api('api/action', { method:'POST', headers:{ 'content-type':'application/json', authorization:'Bearer ' + localStorage.getItem(KEY) }, body:JSON.stringify({ action:'interrupt', sessionId:byId('session').value }) }); controlResult.textContent = 'Interrupt sent.'; void loadTerminal(); }
        catch (error) { controlResult.textContent = error instanceof Error ? error.message : 'Could not interrupt the session.'; }
        finally { setActionBusy(false); }
      });
      setInterval(() => { if (!document.hidden && connectionState === 'connected') void loadTerminal(); }, 1500);`,
};
