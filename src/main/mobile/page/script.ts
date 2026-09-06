/**
 * The page's shared script: pairing, the authenticated fetch helper, the
 * three-state connection machine, and the control shell both console screens
 * populate. Navigation between screens is nav.ts's fragment, spliced in with
 * the sections below.
 *
 * Every screen's fragment is concatenated into this one closure rather than
 * shipped as a separate script. Function declarations hoist, so a screen can
 * call a shared helper and the shared render can call a screen's renderer
 * without either module having to know the other's order — and the page keeps
 * a single nonce, which the strict CSP requires.
 */
export function mobileScript(
  remoteControl: boolean,
  sections: { script: string; wiring: string },
): string {
  return `    (() => {
      'use strict';
      const KEY = 'wanigan.mobile.token';
      const byId = (id) => document.getElementById(id);
      const pair = byId('pair');
      const error = byId('error');
      const dashboard = byId('dashboard');
      const dot = byId('dot');
      const connection = byId('connection');
      const modeLabel = byId('mode-label');
      let remoteControlEnabled = ${remoteControl ? 'true' : 'false'};
      let busy = false;
      // Remote actions start real local processes. A mobile browser can emit
      // two taps before the first request returns, so never turn one intended
      // launch or instruction into duplicate agents or duplicate prompts.
      let actionBusy = false;
      let controlOptions = null;
      let visibleSessions = [];
      let terminalBusy = false;
      let requestedSessionId = '';
      const control = byId('controls');
      const controlResult = byId('control-result');
      const monitorNote = byId('monitor-note');
      const agentLocked = byId('agent-locked');
      const staleNote = byId('stale-note');
      // Three different situations used to render identically here: the Mac is
      // awake with nothing running, the Mac has stopped answering, and this
      // device has never reached the Mac at all. All three arrived as an empty
      // fleet, which is the worst answer to give someone in a coffee shop
      // wondering whether their agents are still working. So the page keeps the
      // time of the last poll that actually returned, and names which of the
      // three it is in words; the dot's colour is only a second channel.
      const POLL_FAST_MS = 3000;
      const POLL_SLOW_MS = 60000;
      let lastGoodAt = 0;
      let lastSessionCount = -1;
      let connectionState = 'never';
      let pollDelay = POLL_FAST_MS;
      let pollTimer = null;

      // The fourth case, and the only one the browser will state outright:
      // navigator.onLine false means THIS DEVICE has no network. That is a
      // different sentence from a Mac that stopped answering, and the page used
      // to print the second one for both — telling someone on a train with no
      // signal that their laptop had probably gone to sleep. Only false is
      // trusted: onLine true means a radio is attached, not that anything on
      // the other end of it is awake, so it decides nothing here.
      function deviceOffline() { return navigator.onLine === false; }

      function setRemoteMode(next) {
        remoteControlEnabled = next === true;
        modeLabel.textContent = remoteControlEnabled ? 'Private remote control' : 'Private fleet monitor';
        monitorNote.classList.toggle('hidden', remoteControlEnabled);
        syncAgentNotice();
      }

      // The Agent screen is a destination in its own right now, so it is
      // reachable before there is a console to put on it. An empty screen would
      // read as a broken one, and the two reasons it can be empty have
      // different fixes: the opt-in is off at the Mac, or this device has not
      // reached the Mac yet. Say which.
      function syncAgentNotice() {
        const locked = control.classList.contains('hidden');
        agentLocked.classList.toggle('hidden', !locked);
        if (!locked) return;
        text('agent-locked-claim', remoteControlEnabled
          ? 'The agent console has not opened yet.'
          : 'Remote control is off.');
        text('agent-locked-note', remoteControlEnabled
          ? 'It opens as soon as this device reaches the Mac and reads the sessions it is running.'
          : 'Enable it in Wanigan Settings → Phone monitor to open a terminal, send a message, or interrupt a turn from this device.');
      }

      function syncActionButtons() {
        const launch = byId('launch-form').querySelector('button');
        const prompt = byId('prompt-form').querySelector('button');
        const interrupt = byId('interrupt');
        launch.disabled = actionBusy || !byId('project').value || !byId('provider').value || !byId('launch-prompt').value.trim();
        prompt.disabled = actionBusy || !byId('session').value || !byId('session-prompt').value.trim();
        interrupt.disabled = actionBusy || !byId('session').value;
      }

      function setActionBusy(next) {
        actionBusy = next;
        syncActionButtons();
      }

      async function api(path, init) {
        const token = localStorage.getItem(KEY);
        const endpoint = new URL(path, location.href); endpoint.hash = '';
        const response = await fetch(endpoint, Object.assign({ headers: { authorization: 'Bearer ' + token }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }, init || {}));
        if (response.status === 401) { localStorage.removeItem(KEY); throw new Error('Pairing expired.'); }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || ('Wanigan returned HTTP ' + response.status + '.'));
        return data;
      }
      function option(value, label) { const out = node('option', '', label); out.value = value; return out; }
      function restoreValue(select, value) {
        if ([...select.options].some((item) => item.value === value)) select.value = value;
      }

      async function renderControls(sessions) {
        if (!remoteControlEnabled) {
          control.classList.add('hidden');
          return;
        }
        visibleSessions = sessions.filter((session) => session.status !== 'exited');
        try {
          if (!controlOptions) controlOptions = await api('api/control');
          const project = byId('project'), provider = byId('provider'), session = byId('session');
          const selected = {
            project: project.value,
            provider: provider.value,
            model: byId('model').value,
            effort: byId('effort').value,
            session: session.value,
          };
          project.replaceChildren(...(controlOptions.projects || []).map((value) => option(value.id, value.name + (value.branch ? ' · ' + value.branch : ''))));
          provider.replaceChildren(...(controlOptions.providers || []).filter((value) => value.available).map((value) => option(value.id, value.label)));
          restoreValue(project, selected.project);
          restoreValue(provider, selected.provider);
          renderLaunchChoices(selected);
          const selectedSession = requestedSessionId || selected.session;
          session.replaceChildren(...visibleSessions.map((value) => option(value.id, value.title + ' · ' + value.projectName)));
          if ([...session.options].some((value) => value.value === selectedSession)) {
            session.value = selectedSession;
            requestedSessionId = '';
          }
          syncActionButtons();
          control.classList.remove('hidden');
          setRemoteMode(true);
          await loadTerminal();
        } catch (error) {
          control.classList.add('hidden');
          setRemoteMode(false);
          if (error instanceof Error && !/disabled/.test(error.message)) controlResult.textContent = error.message;
        }
      }

      function pairingToken(rawValue) {
        let raw = String(rawValue || '').trim();
        if (raw.includes('://')) {
          try { raw = new URL(raw).hash.slice(1); } catch { return ''; }
        }
        if (!raw) return;
        const params = new URLSearchParams(raw);
        let token = params.get('token');
        if (!token && !raw.includes('=')) {
          try { token = decodeURIComponent(raw); } catch { token = ''; }
        }
        return token && /^[A-Za-z0-9_-]{40,128}$/.test(token) ? token : '';
      }
      function tokenFromFragment() {
        const token = pairingToken(location.hash.slice(1));
        if (token) localStorage.setItem(KEY, token);
        history.replaceState(null, '', location.pathname + location.search);
      }

      function text(id, value) { byId(id).textContent = String(value); }
      function number(value) { return Math.max(0, Number(value) || 0).toLocaleString(); }
      function dollars(value) { return '$' + Math.max(0, Number(value) || 0).toFixed(2); }
      function ago(value) {
        const seconds = Math.max(0, Math.round((Date.now() - Number(value || Date.now())) / 1000));
        if (seconds < 60) return seconds + 's';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes + 'm';
        return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
      }
      function node(tag, className, value) {
        const out = document.createElement(tag);
        if (className) out.className = className;
        if (value !== undefined) out.textContent = String(value);
        return out;
      }

      function render(snapshot) {
        const totals = snapshot.totals || {};
        const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
        if (['system', 'light', 'dark'].includes(snapshot.appearance)) document.documentElement.dataset.theme = snapshot.appearance;
        setRemoteMode(snapshot.remoteControl === true);
        text('host', snapshot.host || 'Wanigan');
        text('needs', number((totals.permission || 0) + (totals.error || 0) + (totals.finished || 0)));
        text('running', number(totals.running));
        text('cost', totals.costUnavailable ? (totals.costUsd > 0 ? dollars(totals.costUsd) + ' + unpriced' : 'Not reported') : dollars(totals.costUsd));
        text('tokens', number(totals.outTokens));
        const list = byId('sessions');
        list.replaceChildren(...sessions.map(card));
        lastSessionCount = sessions.length;
        applyEmptyClaim();
        text('updated', 'Updated ' + new Date(snapshot.generatedAt || Date.now()).toLocaleTimeString() +
          (snapshot.version ? ' · Wanigan ' + snapshot.version : ''));
        if (remoteControlEnabled) void renderControls(sessions);
        // setRemoteMode ran at the top of this render, so hiding the console
        // here happens after the notice was last synced; re-sync or a console
        // that has just been switched off leaves the screen blank.
        else { control.classList.add('hidden'); syncAgentNotice(); }
      }

      function state(kind, label) {
        dot.className = 'dot' + (kind ? ' ' + kind : '');
        connection.textContent = label;
      }

      function setConnection(next) {
        connectionState = next;
        applyFreshness();
      }

      function applyFreshness() {
        const age = lastGoodAt ? ago(lastGoodAt) : '';
        if (connectionState === 'connected') {
          state('live', 'Live · polling every ' + Math.round(POLL_FAST_MS / 1000) + 's');
          staleNote.classList.add('hidden');
          dashboard.classList.remove('stale');
        } else if (connectionState === 'offline') {
          // Nothing here blames the Mac. This device has no radio, so what the
          // Mac is doing is unknown rather than suspected — the shell is being
          // served by the worker's cache, and the last reading is dated for the
          // same reason the stale branch dates it.
          state('bad', 'Offline · this device has no network');
          text('error-title', 'This device has no network.');
          text('error-why', 'Wanigan cannot be reached from here, so nothing on this screen is a reading of the fleet right now. It will reconnect on its own when a network comes back.');
          if (lastGoodAt) {
            text('stale-note', 'Last reading from ' + age + ' ago · not the fleet right now.');
            staleNote.classList.remove('hidden');
            dashboard.classList.add('stale');
          } else {
            staleNote.classList.add('hidden');
          }
        } else if (connectionState === 'stale') {
          // The numbers below are still worth showing - the last thing the fleet
          // was doing is real information - but a tile reading '3 running'
          // twenty minutes after the Mac went quiet is the app stating
          // something it cannot know, so the whole reading is dated instead.
          state('stale', 'Stale · last seen ' + age + ' ago');
          text('error-title', 'The Mac stopped answering ' + age + ' ago.');
          text('error-why', 'The usual reasons are that the Mac went to sleep, its lid was closed on battery, or it left the network. This page cannot tell which. Wanigan will reconnect on its own when the Mac answers again.');
          text('stale-note', 'Last reading from ' + age + ' ago · not the fleet right now.');
          staleNote.classList.remove('hidden');
          dashboard.classList.add('stale');
        } else {
          state('bad', 'Never connected');
          text('error-title', 'This device has not reached Wanigan yet.');
          text('error-why', 'Nothing has been heard from the Mac on this device, so there is no fleet reading to show. That is usually the pairing token or the private tunnel in front of Wanigan rather than the Mac being asleep.');
          staleNote.classList.add('hidden');
        }
        applyEmptyClaim();
      }

      // A phone on cellular retrying a sleeping Mac every three seconds is a
      // battery bug: the Mac cannot answer until it wakes, and the retries buy
      // nothing but radio time. Stay fast while the Mac is answering, step the
      // retry out towards a ceiling while it is not, and drop straight back to
      // the fast interval on the first success.
      function schedulePoll() {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(() => { pollTimer = null; void poll(); }, pollDelay);
      }

      async function poll() {
        if (busy) return;
        if (document.hidden) { schedulePoll(); return; }
        const token = localStorage.getItem(KEY);
        if (!token) {
          pair.classList.remove('hidden'); dashboard.classList.add('hidden'); error.classList.add('hidden');
          state('bad', 'Pairing required'); schedulePoll(); return;
        }
        busy = true;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const endpoint = new URL('api/status', location.href);
          endpoint.hash = '';
          const response = await fetch(endpoint, {
            headers: { authorization: 'Bearer ' + token },
            cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
            signal: controller.signal
          });
          if (response.status === 401) {
            localStorage.removeItem(KEY);
            pair.classList.remove('hidden'); dashboard.classList.add('hidden'); error.classList.add('hidden');
            state('bad', 'Pairing expired'); return;
          }
          if (!response.ok) throw new Error('Wanigan returned HTTP ' + response.status + '.');
          const snapshot = await response.json();
          lastGoodAt = Date.now();
          pollDelay = POLL_FAST_MS;
          render(snapshot);
          pair.classList.add('hidden'); error.classList.add('hidden'); dashboard.classList.remove('hidden');
          setConnection('connected');
        } catch (failure) {
          pollDelay = Math.min(POLL_SLOW_MS, pollDelay * 2);
          text('error-text', failure instanceof Error ? failure.message : 'The next poll will retry.');
          error.classList.remove('hidden');
          // Having heard from the Mac earlier in this session and having never
          // heard from it are different problems with different fixes, and the
          // page is the only thing that knows which one this is.
          if (deviceOffline()) setConnection('offline');
          else setConnection(lastGoodAt ? 'stale' : 'never');
        } finally { clearTimeout(timeout); busy = false; schedulePoll(); }
      }
${sections.script}

      tokenFromFragment();
      // Order matters: bootRoute() seeds history.state on the entry
      // tokenFromFragment() has just stripped, so the credential never returns
      // to the address on a Back.
      bootRoute();
      syncAgentNotice();
      byId('pair-form').addEventListener('submit', (event) => {
        event.preventDefault();
        const token = pairingToken(byId('pair-token').value);
        if (token) { byId('pair-token').setCustomValidity(''); localStorage.setItem(KEY, token); byId('pair-token').value = ''; void poll(); return; }
        const code = String(byId('pair-token').value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        fetch(new URL('api/pair', location.href), { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ code }), cache:'no-store', credentials:'omit', referrerPolicy:'no-referrer' })
          .then((response) => response.json().then((body) => ({ response, body })))
          .then(({ response, body }) => { if (!response.ok || !body.token) throw new Error(body.error || 'Pairing failed.'); localStorage.setItem(KEY, body.token); byId('pair-token').value = ''; void poll(); })
          .catch((error) => { byId('pair-token').setCustomValidity(error instanceof Error ? error.message : 'Pairing failed.'); byId('pair-token').reportValidity(); });
      });
${sections.wiring}
      void poll();
      // Age the 'last seen' wording between attempts. Once the retry has backed
      // off to a minute, a label written at the last attempt would understate
      // how long the Mac has actually been quiet.
      setInterval(() => { if (!document.hidden && lastGoodAt && connectionState !== 'connected') applyFreshness(); }, 15000);
      // Someone bringing the page back to the front is asking for a fresh
      // answer, so drop the backoff and try immediately rather than making them
      // wait out the current ceiling.
      document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollDelay = POLL_FAST_MS; void poll(); } });
      // A radio coming back is the one event worth abandoning the backoff for:
      // the ceiling exists to stop a dead poll draining a battery, and there is
      // nothing dead about a phone that just found a network.
      addEventListener('online', () => { pollDelay = POLL_FAST_MS; void poll(); });
      addEventListener('offline', () => { setConnection('offline'); });

      // The worker caches the shell and nothing else — never an /api/ reply, so
      // this can make the app open with no network without ever replaying a
      // fleet reading as though it were current. A registration that fails is
      // not worth a word on screen: everything still works, it just needs a
      // network to open.
      if ('serviceWorker' in navigator) {
        addEventListener('load', () => {
          navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
        });
      }
    })();`;
}
