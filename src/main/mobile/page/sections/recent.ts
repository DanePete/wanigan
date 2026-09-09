import type { MobileSection } from '../sections';

/**
 * Conversations you can pick back up, on the Agent screen.
 *
 * The phone could always start something and never continue anything. The
 * session list it shows is what is in the running process — live sessions and
 * exited tabs somebody left open — so everything from before the last launch of
 * Wanigan, which is most of what an operator has, was simply not there. Away
 * from the desk the more common wish is not "start something new", it is "get
 * back into the thing I was doing".
 *
 * Resuming is a launch and is treated as one: it spends the remote-action
 * budget, it needs the same remote-control opt-in, and it is offered only for a
 * conversation the Mac has said is still resumable. A row whose project has
 * been moved or removed is shown with the reason rather than hidden, because
 * "where did that go" is a worse question than "that cannot be resumed".
 *
 * What the row does not carry is the point: no path, no worktree, no
 * conversation id. The device names a session by Wanigan's own id — the same
 * class of value the fleet snapshot already sends it — and the Mac resolves
 * everything the CLI actually needs.
 */
export const RECENT_SECTION: MobileSection = {
  id: 'recent',
  anchorId: 'recent',
  slot: 'controls',
  markup: `        <div id="recent" class="control-card">
          <div class="console-kicker">Pick up again</div><h3>Recent conversations</h3>
          <p>Sessions this Mac has recorded, newest first. Resuming one starts a real agent on your Mac with the conversation it had before.</p>
          <div id="recent-list" class="recent-list"></div>
          <p id="recent-note" class="why" role="status"></p>
        </div>`,
  style: `    .recent-list { display:grid; gap:8px; margin-top:10px; }
    .recent-row { display:grid; gap:3px; padding:11px 12px; border:1px solid var(--line); border-radius:11px; background:var(--panel); }
    .recent-row.dead { opacity:.72; }
    .recent-top { display:flex; align-items:baseline; justify-content:space-between; gap:9px; }
    .recent-title { font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .recent-when { flex:none; color:var(--faint); font-size:11px; font-variant-numeric:tabular-nums; }
    .recent-meta { color:var(--dim); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .recent-why { color:var(--faint); font-size:11px; }
    .recent-row button { justify-self:start; margin-top:6px; }
    .recent-empty { color:var(--faint); font-size:12px; }`,
  script: `
      let recentRows = null;
      let recentFault = '';

      function recentAgo(row) {
        const at = row.endedAt || row.startedAt;
        return at ? ago(at) + ' ago' : 'not dated';
      }

      // Said from what the Mac reported, never assumed. 'live' is the Mac's own
      // answer to "is the project directory still there", and it is the only
      // thing standing between a Resume button and a failure the operator
      // cannot do anything about from a phone.
      function recentRow(row) {
        const card = node('div', 'recent-row' + (row.live ? '' : ' dead'));
        const top = node('div', 'recent-top');
        top.append(node('div', 'recent-title', row.title || 'Agent session'), node('div', 'recent-when', recentAgo(row)));
        card.append(top);
        const bits = [row.projectName, row.providerId];
        if (row.model) bits.push(row.model);
        if (row.turns > 1) bits.push(row.turns + ' turns');
        card.append(node('div', 'recent-meta', bits.join(' · ')));
        if (!row.live) {
          card.append(node('div', 'recent-why', 'The project this ran in is no longer on this Mac, so it cannot be resumed.'));
          return card;
        }
        if (!remoteControlEnabled) {
          card.append(node('div', 'recent-why', 'Remote control is off at the Mac, so this device can read this list and not act on it.'));
          return card;
        }
        const button = node('button', 'secondary', 'Resume');
        button.type = 'button';
        button.addEventListener('click', () => { void recentResume(row, button); });
        card.append(button);
        return card;
      }

      function paintRecent() {
        const list = byId('recent-list');
        if (recentFault) { list.replaceChildren(node('div', 'recent-empty', recentFault)); return; }
        if (recentRows === null) { list.replaceChildren(node('div', 'recent-empty', 'Reading recent conversations…')); return; }
        if (!recentRows.length) {
          list.replaceChildren(node('div', 'recent-empty', 'Nothing recorded yet. A session started on the Mac or from here appears in this list once it has run.'));
          return;
        }
        list.replaceChildren(...recentRows.map(recentRow));
      }

      async function loadRecent() {
        try {
          const payload = await api('api/recent');
          recentRows = Array.isArray(payload.sessions) ? payload.sessions : [];
          recentFault = '';
        } catch (error) {
          recentRows = null;
          recentFault = 'Recent conversations could not be read: ' +
            (error && error.message ? String(error.message) : 'the Mac did not answer.');
        }
        paintRecent();
      }

      async function recentResume(row, button) {
        if (actionBusy) return;
        setActionBusy(true);
        button.disabled = true;
        const was = button.textContent;
        button.textContent = 'Resuming…';
        deviceWords('recent-note', '');
        try {
          const result = await pushPost('api/action', { action: 'resume', sessionId: row.id });
          deviceWords('recent-note', 'Resumed as “' + (result.session && result.session.title ? result.session.title : row.title) +
            '”. It is on the Mac now, and on this screen once the next reading lands.');
          void poll();
        } catch (error) {
          deviceWords('recent-note', 'Not resumed: ' +
            (error && error.message ? String(error.message) : 'the Mac did not answer.'));
        } finally {
          setActionBusy(false);
          button.disabled = false;
          button.textContent = was;
        }
      }`,
  wiring: `      // On the frame's own cadence rather than a timer of its own, and only
      // while the Agent screen is the screen on show — this list changes when a
      // session ends, which is not often, and a phone radio kept awake for it
      // would be the fourth one on this page.
      ui.watch('agent', loadRecent);`,
};
