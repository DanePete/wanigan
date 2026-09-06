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
    .monitor-note { margin-top:10px; font-size:12px; }
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
    @media (max-width:680px) { .stats { grid-template-columns:repeat(2,minmax(0,1fr)); } .grid { grid-template-columns:1fr; } }`,
  script: `
      function metric(label, value) {
        const wrap = node('div', 'metric');
        wrap.append(node('strong', '', value), node('span', '', label));
        return wrap;
      }

      function card(session) {
        const interactive = remoteControlEnabled && session.status !== 'exited';
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
        if (interactive) {
          out.append(node('div', 'tap-hint', 'Tap to open terminal & reply'));
          out.addEventListener('click', () => openSession(session.id));
        }
        return out;
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
        text('empty-note', fresh
          ? 'Start one in Wanigan and it will appear on the next poll.'
          : 'That reading is ' + ago(lastGoodAt) + ' old, so the fleet may have changed since.');
      }`,
  wiring: '',
};
