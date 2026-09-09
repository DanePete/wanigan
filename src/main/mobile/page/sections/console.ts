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
          <div class="terminal-head"><div><h3 id="terminal-title">Live terminal output</h3><p>Readable live output from the selected session. Whatever you send below is typed into this agent&rsquo;s terminal, exactly as it would be at the Mac: a message, or one of the single keys a prompt is waiting on.</p></div><button id="terminal-refresh" type="button" class="secondary">Refresh</button></div><p id="terminal-note" class="terminal-note hidden"></p><pre id="terminal" class="terminal">Choose a session to open its terminal.</pre>
          <div id="terminal-keys" class="terminal-keys hidden" role="group" aria-label="Press one key in this session terminal"></div>
          <form id="prompt-form" class="fields"><label class="field-label"><span>Session</span><select id="session" aria-label="Session"></select></label><textarea id="session-prompt" aria-label="Message for the selected agent" maxlength="8000" required placeholder="Type the next instruction for this agent…"></textarea><p id="prompt-blocker" class="account-note hidden" role="status"></p><button>Send message</button><button id="interrupt" type="button" class="secondary">Interrupt turn</button></form>
        </div>`,
  style: `    .agent-console { scroll-margin-top:16px; border-color:color-mix(in srgb,var(--accent) 45%,var(--line)); }
    /* overscroll-behavior keeps a flick inside the terminal. Without it, reading
       to the end of the output carries straight on into scrolling the page, and
       the live screen someone was reading slides away under their thumb. */
    /* The palette the Mac's sixteen colour names resolve against, mirroring the
       desktop's xterm theme so one agent's output reads the same on both
       surfaces. It does not change with the appearance setting, and that is
       deliberate: this box is dark in both, and a colour the agent picked for a
       dark terminal has to stay legible on the dark terminal it lands on.
       Anything the Mac sent as a 24-bit value is used as-is; these are only the
       named slots. */
    .terminal {
      --t-black:#18120f; --t-bright-black:#b4a895;
      --t-red:#ff9188; --t-bright-red:#ffb7b1;
      --t-green:#7be3a2; --t-bright-green:#a6f1be;
      --t-yellow:#ffd16d; --t-bright-yellow:#ffe29b;
      --t-blue:#80a9ff; --t-bright-blue:#aac5ff;
      --t-magenta:#c1a9ff; --t-bright-magenta:#dccdff;
      --t-cyan:#79d5d1; --t-bright-cyan:#a7e9e5;
      --t-white:#f6eedf; --t-bright-white:#fffaf0;
      margin-top:10px; min-height:210px; max-height:58vh; overflow:auto; overscroll-behavior:contain;
      white-space:pre-wrap; overflow-wrap:anywhere; tab-size:2;
      padding:14px 13px; border-radius:12px;
      background:var(--terminal); border:1px solid color-mix(in srgb,var(--terminal) 55%,var(--line));
      box-shadow:inset 0 1px 0 #ffffff0d, 0 10px 28px var(--shadow);
      color:var(--terminal-ink);
      /* 1.45 rather than 1.58: a terminal reads as one block, and the looser
         leading turned every wrapped agent line into two paragraphs. Ligatures
         are off because a coding face turns != and -> into glyphs that no longer
         line up with the box drawing beside them. */
      font:15px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;
      font-variant-ligatures:none; font-feature-settings:"liga" 0,"calt" 0;
      -webkit-text-size-adjust:100%;
    }
    .terminal ::selection { background:color-mix(in srgb,var(--accent) 45%,transparent); }
    .terminal::-webkit-scrollbar { width:10px; height:10px; }
    .terminal::-webkit-scrollbar-thumb { background:#ffffff24; border-radius:999px; }
    .terminal::-webkit-scrollbar-track { background:transparent; }
    /* The attributes SGR carries besides colour. Bold is a weight step rather
       than a jump, because a mono face at 15px on a phone goes muddy at 700 on a
       dark ground; dim is opacity so it stays in whatever hue the run already
       had. */
    .tf-bold { font-weight:620; }
    .tf-dim { opacity:.66; }
    .tf-italic { font-style:italic; }
    .tf-underline { text-decoration:underline; text-underline-offset:2px; }
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

      // The <pre> is painted as two containers rather than one string. Setting
      // textContent hands the browser the whole screen again on every tick,
      // which is the same quarter-megabyte problem one layer down; appending to
      // the settled half and replacing only the still-redrawing tail keeps the
      // device's side of the poll as cheap as the wire's. They are elements
      // rather than text nodes because the Mac now sends the colour along with
      // the characters, and a coloured run is a span.
      function terminalParts() {
        const output = byId('terminal');
        if (!terminalNodes || terminalNodes.settled.parentNode !== output) {
          output.textContent = '';
          terminalNodes = { settled: document.createElement('span'), tail: document.createElement('span') };
          terminalNodes.tail.className = 'terminal-live';
          output.append(terminalNodes.settled, terminalNodes.tail);
        }
        return terminalNodes;
      }

      // The sixteen names the Mac may send, each answered by one of this page's
      // own tokens, exactly as the desktop answers xterm's palette from CSS. A
      // name that is not on this list, and anything that is not a plain #rrggbb,
      // colours nothing: the agent's own output chose these values, so they are
      // checked here rather than handed to a style property on trust.
      const TERMINAL_SLOTS = ['black','red','green','yellow','blue','magenta','cyan','white',
        'bright-black','bright-red','bright-green','bright-yellow','bright-blue','bright-magenta','bright-cyan','bright-white'];
      function terminalColor(value) {
        if (typeof value !== 'string' || !value) return '';
        if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
        return TERMINAL_SLOTS.indexOf(value) >= 0 ? 'var(--t-' + value + ')' : '';
      }

      // One styled run. Inverse swaps the two colours here rather than using a
      // filter, so a run that set only a foreground still reads as reversed
      // against the terminal's own ground.
      function terminalRun(text, style) {
        const span = document.createElement('span');
        span.textContent = text;
        if (!style || typeof style !== 'object') return span;
        const flags = Number(style.flags) || 0;
        let fg = terminalColor(style.fg);
        let bg = terminalColor(style.bg);
        if (flags & 16) {
          const ink = fg || 'var(--terminal-ink)';
          fg = bg || 'var(--terminal)';
          bg = ink;
        }
        if (fg) span.style.color = fg;
        if (bg) span.style.background = bg;
        const names = [];
        if (flags & 1) names.push('tf-bold');
        if (flags & 2) names.push('tf-dim');
        if (flags & 4) names.push('tf-italic');
        if (flags & 8) names.push('tf-underline');
        if (names.length) span.className = names.join(' ');
        return span;
      }

      // A half of one response, turned into nodes. A line with no runs stays a
      // single text node, which is what every line was before colour and is
      // still the common case; a row count that does not match the lines it
      // claims to describe draws the text plain rather than guessing at the
      // alignment.
      function terminalFragment(lines, spans, palette) {
        const frag = document.createDocumentFragment();
        const styled = Array.isArray(spans) && spans.length === lines.length && Array.isArray(palette);
        for (let at = 0; at < lines.length; at++) {
          if (at > 0) frag.appendChild(document.createTextNode('\\n'));
          const line = lines[at];
          const runs = styled && Array.isArray(spans[at]) ? spans[at] : null;
          if (!runs || !runs.length) { if (line) frag.appendChild(document.createTextNode(line)); continue; }
          let column = 0;
          for (let r = 0; r + 2 < runs.length; r += 3) {
            const from = Number(runs[r]), length = Number(runs[r + 1]), id = Number(runs[r + 2]);
            // Runs arrive in column order and inside the line they describe.
            // Anything else is not a shape to repair: the rest of the line goes
            // out as plain text below.
            if (!(from >= column) || !(length > 0) || from + length > line.length) break;
            if (from > column) frag.appendChild(document.createTextNode(line.slice(column, from)));
            frag.appendChild(terminalRun(line.slice(from, from + length), palette[id]));
            column = from + length;
          }
          if (column < line.length) frag.appendChild(document.createTextNode(line.slice(column)));
        }
        return frag;
      }

      // The oldest lines go when the page holds more than it will show. Whole
      // child nodes rather than a character slice: a run is a node now, and
      // cutting one in half would leave a span holding half a word.
      function trimTerminal(settled) {
        while (settled.textContent.length > TERMINAL_KEEP && settled.firstChild) {
          settled.removeChild(settled.firstChild);
        }
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
        // A key pressed into a session that has ended is a keystroke into
        // nothing, and index.ts refuses it by name. The row goes flat for the
        // same reason the message box does, and the sentence under the box
        // covers both.
        const chosen = visibleSessions.find((value) => value.id === byId('session').value);
        const ready = Boolean(byId('session').value) && !actionBusy && !(chosen && chosen.status === 'exited');
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
          terminalMessage('Choose a session to open its terminal.');
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
          const palette = Array.isArray(detail.palette) ? detail.palette : [];
          const spans = Array.isArray(detail.spans) ? detail.spans : [];
          const tailSpans = Array.isArray(detail.tailSpans) ? detail.tailSpans : [];
          const parts = terminalParts();
          const bodyLines = body.split('\\n');
          if (detail.mode === 'append') {
            parts.settled.appendChild(terminalFragment(bodyLines, spans, palette));
          } else {
            // A screen carries its own tail at the end, and the Mac says how many
            // of its last lines that is. Counting lines is what both halves can
            // agree on; measuring the tail string against the end of the screen
            // was the same split done by arithmetic, and it stopped being
            // possible once every line carried its own colour.
            const tailCount = Math.max(0, Math.min(bodyLines.length, Number(detail.tailLines) || 0));
            const cut = bodyLines.length - tailCount;
            parts.settled.replaceChildren(terminalFragment(bodyLines.slice(0, cut), spans.slice(0, cut), palette));
          }
          // Always replaced whole: this is the half the agent is still redrawing.
          parts.tail.replaceChildren(terminalFragment(tail.split('\\n'), tailSpans, palette));
          trimTerminal(parts.settled);
          terminalCursor = typeof detail.cursor === 'string' ? detail.cursor : '';
          byId('terminal-title').textContent = detail.title + (detail.running ? ' · live' : ' · ended');
          if (!parts.settled.textContent.length && !parts.tail.textContent.trim().length) terminalMessage('No terminal output yet.');
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
      // Reached from a Fleet card, including a card for a session that has
      // ended. That is deliberate: what the agent printed on its way out is the
      // only thing that explains why it ended, and it is held on the Mac for as
      // long as the session row is. A phone that could not open it left the
      // operator with a card they could not tap and no way to find out.
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
