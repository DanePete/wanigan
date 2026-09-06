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
          <div class="terminal-head"><div><h3 id="terminal-title">Live terminal output</h3><p>Readable live output from the selected session. Send the next instruction below; permission decisions stay at the Mac.</p></div><button id="terminal-refresh" type="button" class="secondary">Refresh</button></div><p id="terminal-note" class="terminal-note hidden"></p><pre id="terminal" class="terminal">Choose a running session to open its terminal.</pre>
          <form id="prompt-form" class="fields"><label class="field-label"><span>Session</span><select id="session" aria-label="Running session"></select></label><div></div><textarea id="session-prompt" aria-label="Message for the selected agent" maxlength="8000" required placeholder="Type the next instruction for this agent…"></textarea><button>Send message</button><button id="interrupt" type="button" class="secondary">Interrupt turn</button></form>
        </div>`,
  style: `    .agent-console { scroll-margin-top:16px; border-color:color-mix(in srgb,var(--accent) 45%,var(--line)); }
    .terminal { margin-top:10px; min-height:210px; max-height:58vh; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; padding:13px; border-radius:10px; background:var(--terminal); border:1px solid var(--line); color:var(--terminal-ink); font:15px/1.58 ui-monospace,SFMono-Regular,Menlo,monospace; -webkit-text-size-adjust:100%; }
    .terminal-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .terminal-head p { margin-bottom:0; }
    .terminal-note { color:var(--serious); font-size:12px; margin:9px 0 0; }
    @media (max-width:680px) { .terminal { min-height:46vh; max-height:62vh; } }`,
  script: `
      // The terminal used to be re-read whole every 1.5 seconds. Now the page
      // holds the settled part of the screen and the server holds the cursor
      // that names it, so a steadily printing session costs a few hundred bytes
      // a tick. Both pieces of state are per session: switching sessions in the
      // picker must never append one agent's output onto another's.
      const TERMINAL_KEEP = 240 * 1024;
      let terminalSessionId = '';
      let terminalCursor = '';
      let terminalNodes = null;

      // The <pre> is painted as two text nodes rather than one string. Setting
      // textContent hands the browser the whole screen again on every tick,
      // which is the same quarter-megabyte problem one layer down; appending to
      // the settled node and replacing only the still-redrawing tail keeps the
      // device's side of the poll as cheap as the wire's.
      function terminalParts() {
        const output = byId('terminal');
        if (!terminalNodes || terminalNodes.settled.parentNode !== output) {
          output.textContent = '';
          terminalNodes = { settled: document.createTextNode(''), tail: document.createTextNode('') };
          output.append(terminalNodes.settled, terminalNodes.tail);
        }
        return terminalNodes;
      }

      // Any plain message replaces the screen, so the cursor that described
      // that screen goes with it. Keeping the cursor here would make the next
      // read an append onto a page that no longer holds what it appends to —
      // which is exactly the silent gap the cursor exists to prevent.
      function terminalMessage(message) {
        terminalNodes = null;
        terminalCursor = '';
        byId('terminal').textContent = message;
      }

      function resetTerminal(sessionId) {
        terminalSessionId = sessionId;
        terminalCursor = '';
        terminalNodes = null;
      }

      // Three different things put a fresh screen on this page and only one of
      // them is ordinary, so the page says which. A console that quietly swapped
      // its contents would look identical to one that had been appending all
      // along, and the operator would read a jump as continuous output.
      function terminalGap(detail) {
        if (detail.screenReason === 'too-much-output') return 'This session printed more than one refresh can carry. Output between this screen and the last one is not shown.';
        if (detail.screenReason === 'behind') return 'Wanigan could not continue from what was on screen, so this is a fresh screen rather than more of the same one.';
        if (detail.truncated) return 'Only the most recent output is shown.';
        return '';
      }

      async function loadTerminal() {
        const sessionId = byId('session').value;
        const output = byId('terminal');
        const note = byId('terminal-note');
        if (!sessionId) {
          byId('terminal-title').textContent = 'Live terminal output';
          note.classList.add('hidden');
          resetTerminal('');
          terminalMessage('Choose a running session to open its terminal.');
          return;
        }
        if (terminalBusy) return;
        terminalBusy = true;
        const follow = output.scrollTop + output.clientHeight >= output.scrollHeight - 24;
        try {
          if (sessionId !== terminalSessionId) resetTerminal(sessionId);
          const detail = await api('api/terminal?session=' + encodeURIComponent(sessionId) +
            (terminalCursor ? '&cursor=' + encodeURIComponent(terminalCursor) : ''));
          const body = String(detail.text || '');
          const tail = String(detail.tail || '');
          const parts = terminalParts();
          let live = tail;
          if (detail.mode === 'append') parts.settled.appendData(body);
          // A screen replaces everything, and its tail is a suffix of its text,
          // so taking that suffix off is what leaves the two nodes holding the
          // same split the next append will assume.
          else if (tail && body.endsWith(tail)) parts.settled.data = body.slice(0, body.length - tail.length);
          // A response with no tail, or one whose tail is not the end of its
          // screen, is not a shape this page can split. Showing the screen whole
          // is still right; it simply leaves the next read nothing to append to.
          else { parts.settled.data = body; live = ''; }
          parts.tail.data = live;
          if (parts.settled.length > TERMINAL_KEEP) {
            const kept = parts.settled.data.slice(-TERMINAL_KEEP);
            const edge = kept.indexOf('\\n');
            parts.settled.data = edge >= 0 ? kept.slice(edge + 1) : kept;
          }
          terminalCursor = typeof detail.cursor === 'string' ? detail.cursor : '';
          byId('terminal-title').textContent = detail.title + (detail.running ? ' · live' : ' · ended');
          if (!parts.settled.length && !parts.tail.length) terminalMessage('No terminal output yet.');
          const gap = terminalGap(detail);
          note.textContent = gap;
          note.classList.toggle('hidden', !gap);
          if (follow) output.scrollTop = output.scrollHeight;
        } catch (error) {
          note.classList.add('hidden');
          terminalMessage(error instanceof Error ? error.message : 'Could not read this terminal.');
        }
        finally { terminalBusy = false; }
      }
      function openSession(sessionId) {
        if (!remoteControlEnabled) return;
        requestedSessionId = sessionId;
        // Tapping a card on the Fleet screen is a navigation now, so it pushes a
        // history entry and the back swipe that follows returns to the fleet
        // rather than leaving the page. The console no longer has to be scrolled
        // to either — it is the whole screen — which also takes a smooth scroll
        // out from beside live terminal output.
        setView('agent', 'push');
        void renderControls(visibleSessions).then(() => {
          byId('agent-console').focus({ preventScroll: true });
        });
      }`,
  wiring: `      byId('session-prompt').addEventListener('input', syncActionButtons);
      byId('session').addEventListener('change', () => { syncActionButtons(); resetTerminal(byId('session').value); terminalMessage('Loading terminal…'); void loadTerminal(); });
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
