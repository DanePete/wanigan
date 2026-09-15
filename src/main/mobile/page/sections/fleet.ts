import type { MobileSection } from '../sections';

/**
 * The monitor itself: the four totals, the session cards, and the two claims
 * the page is only allowed to make about a poll that actually returned.
 */
export const FLEET_SECTION: MobileSection = {
  id: 'fleet',
  anchorId: 'sessions',
  slot: 'dashboard',
  markup: `      <p id="stale-note" class="stale-note hidden"></p>
      <div class="stats">
        <div class="stat"><strong id="needs">0</strong><span>Needs you</span></div>
        <div class="stat"><strong id="running">0</strong><span>Running</span></div>
        <div class="stat"><strong id="cost">$0.00</strong><span>Fleet spend</span></div>
        <div class="stat"><strong id="tokens">0</strong><span>Output tokens</span></div>
      </div>
      <p id="fleet-start-row" class="fleet-start hidden"><button type="button" id="fleet-start">Start an agent</button></p>
      <h2>Sessions</h2>
      <div id="sessions" class="grid"></div>
      <div id="empty" class="notice hidden"><strong id="empty-claim">No session panes are open.</strong><span id="empty-note">Start one in Wanigan and it will appear on the next poll.</span></div>
      <div id="monitor-note" class="notice monitor-note hidden"><strong>Read-only monitor</strong>Enable remote control in Wanigan Settings → Phone monitor to open a terminal, send a message, or start an agent from this device.</div>`,
  style: `    .stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:9px; }
    .stat { padding:13px; min-height:82px; }
    .stat strong { display:block; font-size:clamp(19px,5vw,28px); letter-spacing:-.03em; font-variant-numeric:tabular-nums; }
    .stat span { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
    .card { padding:14px; min-width:0; }
    .session-card { width:100%; color:var(--ink); text-align:left; font-weight:400; cursor:pointer; touch-action:manipulation; }
    .session-card:active { transform:scale(.985); border-color:var(--accent); }
    .tap-hint { color:var(--accent); font-size:11px; font-weight:700; margin-top:10px; }
    /* Told apart from a live session's invitation by wording and by weight, not
       by colour alone: this one opens a record, not a terminal you can type in. */
    .tap-hint-ended { color:var(--dim); font-weight:400; }
    .monitor-note { margin-top:10px; font-size:12px; }
    /* The one creative act a phone can perform, at the top of the screen a
       phone opens on. It declares no display of its own, so the shared .hidden
       rule still decides whether it is there — it is not, while remote control
       is off at the Mac and starting anything would fail. */
    .fleet-start { margin-top:12px; }
    .fleet-start button { width:100%; }
    .card-top { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .name { font-weight:720; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .provider { color:var(--dim); font-size:12px; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .badge { flex:none; border-radius:999px; padding:3px 8px; font-size:11px; font-weight:760; border:1px solid currentColor; }
    .badge.permission,.badge.error { color:var(--critical); background:var(--critical-soft); }
    .badge.finished { color:var(--good); background:var(--good-soft); }
    .badge.working { color:var(--blue); background:var(--blue-soft); }
    .badge.idle { color:var(--dim); background:var(--panel-raised); }
    .meta { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; border-top:1px solid var(--line); margin-top:12px; padding-top:10px; }
    .metric strong { display:block; font-size:13px; font-variant-numeric:tabular-nums; }
    .metric span { display:block; color:var(--faint); font-size:10px; text-transform:uppercase; letter-spacing:.06em; }
    .stale-note { color:var(--serious); font-size:12px; font-weight:720; margin:0 0 11px; }
    #dashboard.stale .stats,#dashboard.stale .grid { opacity:.62; }
    @media (max-width:680px) { .stats { grid-template-columns:repeat(2,minmax(0,1fr)); } .grid { grid-template-columns:1fr; } }
    /* helper sweep · P1 policy: what a waiting approval's script alias runs.
       Verdicts carry a glyph and a word, never colour alone. */
    .approval { border-top:1px solid var(--line); margin-top:12px; padding-top:10px; display:grid; gap:7px; min-width:0; }
    .approval-title { font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:.08em; }
    .approval-alias { font-family:ui-monospace,Menlo,monospace; font-size:12px; overflow-wrap:anywhere; }
    .approval-verdicts { display:flex; flex-wrap:wrap; gap:6px; font-size:11px; font-weight:720; }
    .approval-verdicts span { border:1px solid currentColor; border-radius:999px; padding:2px 7px; }
    .approval-bad { color:var(--critical); }
    .approval-warn { color:var(--serious); }
    .approval-ok { color:var(--good); }
    .approval-quiet { color:var(--dim); }
    .approval-run { font-family:ui-monospace,Menlo,monospace; font-size:11.5px; background:var(--panel-raised); border-radius:8px; padding:6px 8px; overflow-wrap:anywhere; white-space:pre-wrap; }
    .approval-run small { display:block; color:var(--faint); font-family:inherit; font-size:10px; }
    .approval-note { color:var(--dim); font-size:11.5px; line-height:1.45; overflow-wrap:anywhere; }`,
  script: `
      function metric(label, value) {
        const wrap = node('div', 'metric');
        wrap.append(node('strong', '', value), node('span', '', label));
        return wrap;
      }

      function card(session) {
        // An ended session is still worth opening: its terminal holds what the
        // agent printed on its way out, which is the only answer to "why did
        // that stop?". Making the card inert was what left a phone with a
        // session it could see, could not tap, and could not explain.
        const ended = session.status === 'exited';
        const interactive = remoteControlEnabled;
        const out = node(interactive ? 'button' : 'article', interactive ? 'card session-card' : 'card');
        if (interactive) out.type = 'button';
        const top = node('div', 'card-top');
        const identity = node('div', '');
        const title = session.title || session.projectName || 'Agent session';
        const secondary = [];
        if (session.projectName && session.projectName !== title) secondary.push(session.projectName);
        secondary.push(session.providerId || 'agent');
        if (session.model) secondary.push(session.model);
        identity.append(node('div', 'name', title), node('div', 'provider', secondary.join(' · ')));
        const badge = node('span', 'badge ' + session.attention.kind,
          session.attention.label + ' · ' + ago(session.attention.since));
        top.append(identity, badge);
        const meta = node('div', 'meta');
        meta.append(metric('Spend', session.usage.costStatus === 'unavailable' ? 'Not reported' : dollars(session.usage.costUsd)),
          metric('Requests', number(session.usage.requests)),
          metric('Output', number(session.usage.outTokens)));
        out.append(top, meta);
        if (session.approval && Array.isArray(session.approval.scripts)) out.append(approvalBlock(session.approval));
        if (interactive) {
          out.append(node('div', ended ? 'tap-hint tap-hint-ended' : 'tap-hint',
            ended ? 'Ended · tap to read its last output' : 'Tap to open terminal & reply'));
          out.addEventListener('click', () => openSession(session.id));
        }
        return out;
      }

      // helper sweep · P1 policy. Sent by the Mac only for a session waiting on
      // a permission prompt while remote control is on; everything in it was
      // bounded and sanitised there, and it is written here as text nodes only.
      function approvalBlock(card) {
        const wrap = node('div', 'approval');
        wrap.append(node('div', 'approval-title', 'What the waiting command runs'));
        for (const s of card.scripts) {
          wrap.append(node('div', 'approval-alias', s.alias + ' · ' + s.manifest));
          const verdicts = node('div', 'approval-verdicts');
          const rev = s.reversible === 'reversible' ? ['approval-ok', '↺ reversible']
            : s.reversible === 'not reversible' ? ['approval-bad', '! not reversible'] : ['approval-warn', '? cannot confirm reversible'];
          verdicts.append(node('span', rev[0], rev[1]));
          const ch = s.change === 'changed' ? ['approval-bad', '! changed since launch']
            : s.change === 'new since launch' ? ['approval-bad', '+ new since launch']
              : s.change === 'unchanged' ? ['approval-quiet', '= same as at launch'] : ['approval-quiet', '? change since launch unknown'];
          verdicts.append(node('span', ch[0], ch[1]));
          wrap.append(verdicts);
          for (const run of s.runs) {
            const line = node('div', 'approval-run', run.command);
            line.prepend(node('small', '', run.from));
            wrap.append(line);
          }
          if (s.moreRuns > 0) wrap.append(node('div', 'approval-note', s.moreRuns + ' more line' + (s.moreRuns === 1 ? '' : 's') + ' at the Mac.'));
          if (s.hosts.length) wrap.append(node('div', 'approval-note', 'Hosts: ' + s.hosts.join(', ')));
          if (s.paths.length) wrap.append(node('div', 'approval-note', 'Paths: ' + s.paths.join(', ')));
          if (s.because) wrap.append(node('div', 'approval-note', s.because));
          if (s.change === 'changed' || s.change === 'new since launch') wrap.append(node('div', 'approval-note approval-bad', s.changeDetail));
          for (const n of s.notes) wrap.append(node('div', 'approval-note', n));
        }
        return wrap;
      }

      // Drawn from the same flag the session cards read: while remote control is
      // off, a button that cannot launch anything is worse than no button, and
      // the read-only notice below already names the setting that turns it on.
      function applyStartButton() {
        byId('fleet-start-row').classList.toggle('hidden', !remoteControlEnabled);
      }

      function applyEmptyClaim() {
        // 'No session panes are open' is a claim about the Mac, not about this
        // page, so it may only appear when a poll came back and came back
        // empty. Before the first success there is nothing to claim at all, and
        // once the Mac goes quiet the same box has to speak in the past tense.
        const observed = lastGoodAt > 0 && lastSessionCount === 0;
        byId('empty').classList.toggle('hidden', !observed);
        if (!observed) return;
        const fresh = connectionState === 'connected';
        text('empty-claim', fresh ? 'No session panes are open.' : 'Nothing was open when the Mac last answered.');
        // 'Start one in Wanigan' was the wrong instruction to give someone
        // holding a paired phone with remote control on: this device can start
        // one, and the button above does it. The Mac is named only when it is
        // genuinely the only way.
        text('empty-note', !fresh
          ? 'That reading is ' + ago(lastGoodAt) + ' old, so the fleet may have changed since.'
          : remoteControlEnabled
            ? 'Start an agent with the button above, or start one in Wanigan; either appears on the next poll.'
            : 'Start one in Wanigan and it will appear on the next poll.');
      }`,
  wiring: `      byId('fleet-start').addEventListener('click', () => openLaunch());`,
};
