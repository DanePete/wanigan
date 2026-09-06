import type { MobileSection } from '../sections';

/**
 * The selected agent: readable terminal output, the next instruction, and the
 * single keys a blocked agent is actually waiting for. It appears only when
 * remote control is separately enabled, which is why its markup ships inside
 * the hidden control slot rather than being injected.
 *
 * The key row is here because a text box with a newline on the end is not a
 * keyboard. An agent stopped on a permission prompt wants an arrow and an
 * Enter, or an Escape; typing "1" and pressing send is a different act that
 * happens to work on one provider's menu and on nothing else. The names come
 * from the Mac and so do the bytes — this page posts a name and never a
 * sequence.
 *
 * The sizing below is the other half of that thought. This is the one screen
 * someone uses standing up, one-handed, because an agent stopped and is waiting
 * — so the key row, the send button and the interrupt are laid out for a thumb
 * rather than for a cursor: a larger target than the shared sheet's floor on a
 * coarse pointer, a gap wide enough that a thumb aimed at Escape cannot land on
 * Enter, the two actions side by side rather than stacked eight pixels apart,
 * and a shorter terminal on a short phone so the controls are still reachable
 * without scrolling past the output they act on.
 */
export const CONSOLE_SECTION: MobileSection = {
  id: 'console',
  anchorId: 'agent-console',
  slot: 'controls',
  markup: `        <div id="agent-console" class="control-card agent-console" tabindex="-1">
          <div class="console-kicker">Selected agent</div>
          <div class="terminal-head"><div><h3 id="terminal-title">Live terminal output</h3><p>Readable live output from the selected session. Whatever you send below is typed into this agent&rsquo;s terminal, exactly as it would be at the Mac: a message, or one of the single keys a prompt is waiting on.</p></div><button id="terminal-refresh" type="button" class="secondary">Refresh</button></div><p id="terminal-note" class="terminal-note hidden"></p><pre id="terminal" class="terminal">Choose a running session to open its terminal.</pre>
          <div id="terminal-keys" class="terminal-keys hidden" role="group" aria-label="Press one key in this session terminal"></div>
          <form id="prompt-form" class="fields"><label class="field-label"><span>Session</span><select id="session" aria-label="Running session"></select></label><textarea id="session-prompt" aria-label="Message for the selected agent" maxlength="8000" required placeholder="Type the next instruction for this agent…"></textarea><button>Send message</button><button id="interrupt" type="button" class="secondary">Interrupt turn</button></form>
        </div>`,
  style: `    .agent-console { scroll-margin-top:16px; border-color:color-mix(in srgb,var(--accent) 45%,var(--line)); }
    /* overscroll-behavior keeps a flick inside the terminal. Without it, reading
       to the end of the output carries straight on into scrolling the page, and
       the live screen someone was reading slides away under their thumb. */
    .terminal { margin-top:10px; min-height:210px; max-height:58vh; overflow:auto; overscroll-behavior:contain; white-space:pre-wrap; overflow-wrap:anywhere; padding:13px; border-radius:10px; background:var(--terminal); border:1px solid var(--line); color:var(--terminal-ink); font:15px/1.58 ui-monospace,SFMono-Regular,Menlo,monospace; -webkit-text-size-adjust:100%; }
    .terminal-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .terminal-head p { margin-bottom:0; }
    .terminal-note { color:var(--serious); font-size:12px; margin:9px 0 0; }
    .terminal-keys { display:flex; flex-wrap:wrap; gap:6px; margin-top:9px; }
    /* Section styles are appended after the shared sheet, so this rule beats
       .hidden at equal specificity and the row would show before /api/control
       has said whether the bridge advertises any keys. Re-stated here for the
       same reason nav.ts re-states it for the sheet. */
    .terminal-keys.hidden { display:none; }
    .terminal-keys button { flex:1 1 84px; display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:8px 10px; user-select:none; -webkit-user-select:none; }
    .terminal-key-glyph { color:var(--faint); font-size:15px; line-height:1; }
    /* Refresh keeps its own width. Flex would otherwise let the paragraph beside
       it squeeze the button to the width of one wrapped word, which is a target
       nobody can hit and a label nobody can read. */
    .terminal-head button { flex:none; }
    /* The session picker takes the whole row and the two actions share the one
       below it, at every width. Stacked full-width buttons put Interrupt turn
       directly under Send message with eight pixels between them, which is a
       mis-tap that ends a turn; side by side, position tells them apart as well
       as the label does. */
    #prompt-form { grid-template-columns:repeat(2,minmax(0,1fr)); }
    #prompt-form .field-label { grid-column:1 / -1; }
    @media (max-width:680px) { .terminal { min-height:46vh; max-height:62vh; } }
    /* A short phone held one-handed cannot show a 62vh terminal and still put
       the keys and the send button within a thumb's reach, and those are what
       someone standing up came here for. Give the reading back to the controls
       when there is not enough height for both. */
    @media (max-width:680px) and (max-height:720px) { .terminal { min-height:32vh; max-height:42vh; } }
    /* A finger is not a cursor. The shared sheet's 44px is the floor Apple and
       Google both publish; this console is the one screen someone uses while
       standing up holding a phone, so its controls take the larger target and
       the key row takes a gap wide enough that a thumb aimed at Escape cannot
       land on Enter. */
    @media (pointer:coarse) {
      .agent-console button { min-height:48px; }
      .agent-console select { min-height:48px; }
      .terminal-keys { gap:9px; }
      .terminal-keys button { flex:1 1 96px; }
    }`,
  script: `
      // The terminal used to be re-read whole every 1.5 seconds. Now the page
      // holds the settled part of the screen and the server holds the cursor
      // that names it, so a steadily printing session costs a few hundred bytes
      // a tick. Both pieces of state are per session: switching sessions in the
      // picker must never append one agent's output onto another's.
      const TERMINAL_KEEP = 240 * 1024;
      // How far off the bottom still counts as following the output. A mouse
      // wheel lands where it is aimed and 24px was enough for it; a thumb flick
      // with momentum routinely stops a few dozen pixels short, and the tighter
      // slack read that as 'the operator scrolled up to read something' — so the
      // terminal quietly stopped following a live agent and stayed that way.
      const TERMINAL_FOLLOW_SLACK = 56;
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
      // A blocked agent is not always waiting for a sentence. Claude Code's
      // permission prompt is a numbered menu and a Codex approval is a
      // keypress; both want an arrow, an Escape or a bare Enter, and a text box
      // that always appends a newline can send none of the three. So the keys
      // are here as their own buttons — named by the Mac, because the byte
      // sequence behind each one lives in the main process and this page only
      // ever posts the name it was given.
      let keyRowSignature = '';

      function terminalKeyButton(key) {
        const label = String(key.label || key.name || '');
        const button = node('button', 'secondary');
        button.type = 'button';
        // Glyph and word together. An arrowhead on its own is a guess about
        // what a button does, and this button does something to a live agent.
        const glyph = node('span', 'terminal-key-glyph', String(key.glyph || ''));
        glyph.setAttribute('aria-hidden', 'true');
        button.append(glyph, node('span', '', label));
        button.setAttribute('aria-label', 'Press ' + label + ' in this session terminal');
        button.addEventListener('click', () => void sendKey(key));
        return button;
      }

      // Rebuilt only when the Mac's list changes, but re-enabled on every
      // terminal read. A keypress spends the same twenty-a-minute action budget
      // as a launch, and a button that still looks live while another action is
      // in flight is how one intended press becomes two.
      function refreshKeyRow() {
        const row = byId('terminal-keys');
        const keys = controlOptions && Array.isArray(controlOptions.keys) ? controlOptions.keys : [];
        const signature = keys.map((key) => key.name + ' ' + key.label).join('|');
        if (signature !== keyRowSignature) {
          keyRowSignature = signature;
          row.replaceChildren(...keys.map(terminalKeyButton));
          // No keys advertised means this Mac cannot press one, and a row of
          // buttons that each fail in turn would be worse than no row at all.
          row.classList.toggle('hidden', keys.length === 0);
        }
        const ready = Boolean(byId('session').value) && !actionBusy;
        row.querySelectorAll('button').forEach((button) => { button.disabled = !ready; });
      }

      async function sendKey(key) {
        const sessionId = byId('session').value;
        if (!sessionId || actionBusy) return;
        const label = String(key.label || key.name || '');
        controlResult.textContent = 'Pressing ' + label + '…';
        setActionBusy(true);
        refreshKeyRow();
        try {
          await api('api/action', { method:'POST', headers:{ 'content-type':'application/json', authorization:'Bearer ' + localStorage.getItem(KEY) }, body:JSON.stringify({ action:'key', sessionId:sessionId, key:key.name }) });
          controlResult.textContent = 'Pressed ' + label + '.';
          void loadTerminal();
        }
        catch (error) { controlResult.textContent = error instanceof Error ? error.message : 'Could not press that key.'; }
        finally { setActionBusy(false); refreshKeyRow(); }
      }

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
        // Before the busy guard below, so the row still settles into its
        // disabled state while a read is in flight.
        refreshKeyRow();
        if (!sessionId) {
          byId('terminal-title').textContent = 'Live terminal output';
          note.classList.add('hidden');
          resetTerminal('');
          terminalMessage('Choose a running session to open its terminal.');
          return;
        }
        if (terminalBusy) return;
        terminalBusy = true;
        const follow = output.scrollTop + output.clientHeight >= output.scrollHeight - TERMINAL_FOLLOW_SLACK;
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
      // sections.ts's rule says a screen must not hold an interval of its
      // own, and this screen holds one anyway. The cadence is the reason:
      // this is live terminal output, and the cursor protocol above makes each
      // tick a few hundred bytes rather than a re-read of the screen, so
      // ui.watch()'s three-second poll is the wrong cadence for it. The guard
      // is what the exception costs — it has to answer the harm the rule names
      // instead. document.hidden only asks whether the tab is in front, so
      // standing on Spend, Git or Device with the page open still asked the
      // Mac for a terminal every 1.5 seconds, forty times a minute, for output
      // nobody was looking at.
      setInterval(() => {
        if (document.hidden || connectionState !== 'connected') return;
        if (!ui.showing('agent')) return;
        void loadTerminal();
      }, 1500);`,
};
