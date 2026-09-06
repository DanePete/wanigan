import type { MobileSection } from '../sections';

/**
 * What every account has left, and what the fleet has cost.
 *
 * It is called Spend and not Insights on purpose. The desktop has two screens
 * here — Usage, which is a live reading of each account's remaining quota, and
 * Insights, which reconciles Wanigan's own records against them — and the phone
 * carries only the half that answers the question you ask away from your desk:
 * am I burning money, and is anything about to run out. Calling it Insights
 * would promise the reconciliation tables that stay on the Mac.
 *
 * The two halves come from different places and are kept visibly apart for the
 * same reason the desktop keeps them apart. What is left is a live reading from
 * the provider, because a token counter on this machine cannot answer it:
 * compaction, cached input and plan-specific limits make every such calculation
 * a guess. What it cost is Wanigan's own exact record of what ran. Running them
 * together would invite the second to be read as evidence for the first.
 *
 * Two honesty rules carry over from the desktop and are not decorations here.
 * A cost the providers did not report is printed as not reported, never as
 * $0.00 — a provider that reported nothing is not a provider that cost nothing.
 * And a limit window the agent printed with no reset clause gets no reset time
 * at all: that shape is what a window with nothing used yet actually looks
 * like, and the Mac already learned once that treating it as a fault reports a
 * perfectly good account as broken. Inventing a time here would be the same
 * mistake pointed the other way.
 *
 * Every age on this screen is the Mac's own measurement plus the time since the
 * bytes arrived, which the device measures on its own clock. The two clocks are
 * never subtracted from each other — the same rule the Device screen states —
 * because a couple of minutes of skew would otherwise read as staleness that
 * never happened.
 *
 * Typed with the slot held apart, exactly as the Device screen was before it
 * was registered: 'spend' is not in MobileSectionSlot until this screen is
 * added to the registry, and a cast to the current union would compile and then
 * compose the screen into no slot at all — a live tab that navigates to a blank
 * panel, which is the same lie as an empty fleet on a sleeping Mac.
 */
type SpendSection = Omit<MobileSection, 'slot'> & { slot: 'spend' };

export const SPEND_SECTION: SpendSection = {
  id: 'spend',
  anchorId: 'spend',
  slot: 'spend',
  markup: `        <section id="spend" class="spend">
          <h2>What is left</h2>
          <p class="spend-lead">Read live from each account, because a token count on the Mac cannot tell you what a plan has left. This is the reading Wanigan already had; asking again starts a real CLI process, so it stays a thing you do at the Mac.</p>
          <div id="spend-limits" class="spend-limits"></div>

          <h2>What it cost</h2>
          <div class="spend-window" role="group" aria-label="Spend window">
            <button type="button" class="secondary spend-days" data-spend-days="7" aria-pressed="false">7 days</button>
            <button type="button" class="secondary spend-days" data-spend-days="14" aria-pressed="true">14 days</button>
            <button type="button" class="secondary spend-days" data-spend-days="30" aria-pressed="false">30 days</button>
          </div>
          <p id="spend-window-note" class="spend-lead">Wanigan’s own record of what ran.</p>
          <div id="spend-cost" class="spend-cost"></div>
        </section>`,
  style: `    .spend > h2:first-child { margin-top:4px; }
    .spend-lead { color:var(--dim); font-size:12px; margin-bottom:10px; }
    .spend-limits,.spend-cost { display:grid; gap:10px; }
    .spend-account,.spend-row { padding:14px; display:grid; gap:12px; min-width:0; }
    .spend-account-top { display:flex; align-items:baseline; justify-content:space-between; gap:10px; flex-wrap:wrap; }
    .spend-account-name { font-weight:720; overflow:hidden; text-overflow:ellipsis; }
    .spend-tags { display:flex; gap:6px; flex-wrap:wrap; }
    .spend-tag { border:1px solid var(--line); border-radius:999px; padding:2px 8px; color:var(--dim); font-size:11px; font-weight:700; white-space:nowrap; }
    .spend-tag.stale { color:var(--serious); border-color:color-mix(in srgb,var(--serious) 45%,var(--line)); }
    .spend-meter { display:grid; gap:5px; }
    .spend-meter-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
    .spend-meter-name { font-size:13px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .spend-meter-value { flex:none; font-size:12px; font-weight:760; font-variant-numeric:tabular-nums; color:var(--dim); }
    .spend-track { height:8px; border:1px solid var(--line); border-radius:3px; background:var(--input); overflow:hidden; }
    .spend-fill { height:100%; background:var(--blue); }
    .spend-meter.warning .spend-fill { background:var(--serious); }
    .spend-meter.warning .spend-meter-value { color:var(--serious); }
    .spend-meter.critical .spend-fill { background:var(--critical); }
    .spend-meter.critical .spend-meter-value { color:var(--critical); }
    .spend-reset { color:var(--faint); font-size:11px; font-variant-numeric:tabular-nums; }
    .spend-detail { color:var(--dim); font-size:12px; line-height:1.5; }
    .spend-window { display:flex; gap:8px; margin-bottom:10px; }
    .spend-days { flex:1; min-height:40px; padding:6px 8px; font-size:13px; }
    .spend-days[aria-pressed="true"] { color:var(--accent-ink); background:var(--accent); border-color:var(--accent); }
    .spend-total { display:grid; gap:2px; padding:14px; border:1px solid var(--line); border-radius:13px; background:var(--panel); }
    .spend-total-value { font-size:clamp(21px,6vw,30px); letter-spacing:-.03em; font-variant-numeric:tabular-nums; }
    .spend-total-label { color:var(--faint); font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
    .spend-row-top { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
    .spend-row-name { font-weight:720; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .spend-row-cost { flex:none; font-weight:760; font-variant-numeric:tabular-nums; }
    .spend-row-meta { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; border-top:1px solid var(--line); padding-top:10px; }
    .spend-fact { display:grid; gap:2px; min-width:0; }
    .spend-fact span { color:var(--faint); font-size:10px; text-transform:uppercase; letter-spacing:.06em; }
    .spend-fact strong { font-size:13px; font-variant-numeric:tabular-nums; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    @media (max-width:680px) { .spend-row-meta { grid-template-columns:repeat(2,minmax(0,1fr)); } }`,
  script: `
      // The window the cost half is asking for. The heading below is drawn from
      // the window the Mac answered with rather than from this one, so a
      // request in flight can never leave figures sitting under a sentence
      // naming a different span.
      let spendDays = 14;
      let spendPayload = null;
      // When that payload reached this device, on this device's clock. Every
      // age on this screen is the Mac's own measurement plus the time since
      // this moment; the two clocks are never subtracted from each other.
      let spendReadAt = 0;
      let spendFailure = '';
      let spendRefresh = null;

      function spendRetry() { if (spendRefresh) void spendRefresh(); }

      // A provider that reported no cost is not a provider that was free, and a
      // figure that silently treats it as zero is a number pretending to be a
      // bill. 'at least' rather than the desktop's ≥ because there is no hover
      // on a phone to explain a glyph.
      function spendCost(costUsd, status) {
        if (status === 'unreported') return 'Not reported';
        return (status === 'partial' ? 'at least ' : '') + dollars(costUsd);
      }

      // How long this device has been holding the current reading, on this
      // device's clock alone. It is the only elapsed time on this screen, and
      // every age below is the Mac's own measurement plus it — so the two
      // clocks are added, never subtracted from each other. Zero before the
      // first payload arrives, which is the truthful answer for a reading that
      // does not exist yet rather than the fifty-six years since the epoch.
      function spendSince() {
        return spendReadAt ? Date.now() - spendReadAt : 0;
      }

      // Rebuilt as a local timestamp so ago() can do that addition without
      // either clock touching the other.
      function spendAge(readAgeMs) {
        return readAgeMs === null ? '' : ago(Date.now() - (readAgeMs + spendSince()));
      }

      function spendStale(row) {
        if (row.readAgeMs === null) return false;
        return row.readAgeMs + spendSince() > spendPayload.staleAfterMs;
      }

      // A window the agent printed with no reset clause has no reset, and this
      // prints none. The Mac already learned the other half of this: requiring
      // the clause reported a perfectly good account with nothing used yet as
      // an unreadable output format. Guessing a time here would be that same
      // mistake pointed the other way.
      function spendReset(win) {
        if (win.resetsAtText === null && win.resetsInMs === null) return '';
        if (win.resetsInMs === null) return 'resets ' + win.resetsAtText;
        const left = win.resetsInMs - spendSince();
        if (left <= 0) return 'resetting now';
        const minutes = Math.floor(left / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        if (days >= 1) return 'resets in ' + days + 'd ' + (hours % 24) + 'h';
        if (hours >= 1) return 'resets in ' + hours + 'h ' + (minutes % 60) + 'm';
        return 'resets in ' + minutes + 'm';
      }

      // The same words the desktop meter uses, so one product does not call one
      // span two things on two screens.
      function spendWindowTitle(win) {
        const kind = win.kind === 'session' ? 'Session' : win.kind === 'week' ? 'This week' : win.kind;
        return win.scope ? kind + ' · ' + win.scope : kind;
      }

      function spendBand(percent) {
        if (percent >= 95) return 'critical';
        if (percent >= 75) return 'warning';
        return '';
      }

      function spendMeter(win) {
        const wrap = node('div', 'spend-meter ' + spendBand(win.usedPercent));
        const head = node('div', 'spend-meter-head');
        head.append(node('span', 'spend-meter-name', spendWindowTitle(win)),
          node('span', 'spend-meter-value', win.usedPercent + '% used'));
        const track = node('div', 'spend-track');
        const fill = node('div', 'spend-fill');
        // Set at its value with nothing to animate: a limit reading is a value,
        // not a measurement being taken.
        fill.style.width = Math.max(0, Math.min(100, Number(win.usedPercent) || 0)) + '%';
        track.append(fill);
        wrap.append(head, track);
        // The word carries the state and the colour only repeats it, so a full
        // window still reads as full in sunlight and in a screenshot.
        const foot = [win.usedPercent >= 100 ? 'exhausted' : '', spendReset(win)].filter(Boolean).join(' · ');
        if (foot) wrap.append(node('div', 'spend-reset', foot));
        return wrap;
      }

      function spendAccountCard(row) {
        const card = node('article', 'card spend-account');
        const top = node('div', 'spend-account-top');
        const tags = node('div', 'spend-tags');
        tags.append(node('span', 'spend-tag', row.harnessLabel));
        if (row.plan) tags.append(node('span', 'spend-tag', row.plan));
        const age = spendAge(row.readAgeMs);
        if (age) tags.append(node('span', 'spend-tag' + (spendStale(row) ? ' stale' : ''), 'read ' + age + ' ago'));
        top.append(node('div', 'spend-account-name', row.label), tags);
        card.append(top);
        const meters = row.state === 'ok' ? row.windows : [];
        if (meters.length) card.append(...meters.map(spendMeter));
        // A reading can be complete and still carry something the meters do not
        // say: Codex reports a spend control separately from its percentages,
        // and that is the fact that explains a refused run while every window
        // still looks fine.
        if (row.detail) card.append(node('p', 'spend-detail', row.detail));
        else if (!meters.length) card.append(node('p', 'spend-detail', 'No limit window was reported for this account.'));
        return card;
      }

      function spendFact(label, value) {
        const fact = node('div', 'spend-fact');
        fact.append(node('span', '', label), node('strong', '', value));
        return fact;
      }

      function spendRowCard(row) {
        const card = node('article', 'card spend-row');
        const top = node('div', 'spend-row-top');
        top.append(node('div', 'spend-row-name', row.model),
          node('div', 'spend-row-cost', spendCost(row.costUsd, row.costStatus)));
        const meta = node('div', 'spend-row-meta');
        meta.append(spendFact('Account', row.accountLabel), spendFact('Requests', number(row.requests)),
          spendFact('Output', number(row.outTokens)), spendFact('Cached in', number(row.cacheRead)));
        card.append(top, meta);
        return card;
      }

      function paintSpendLimits(box) {
        const rows = spendPayload.accounts || [];
        if (!rows.length) {
          box.replaceChildren(ui.empty('No accounts are configured.',
            'Add one in Wanigan Settings → Accounts on the Mac and what it has left appears here.'));
          return;
        }
        box.replaceChildren(...rows.map(spendAccountCard));
      }

      function paintSpendCost(box) {
        const rows = spendPayload.rows || [];
        const totals = spendPayload.totals || {};
        if (!rows.length) {
          box.replaceChildren(ui.empty('Nothing was recorded in this window.',
            'Wanigan records a request when a session it started makes one, so an empty window means none ran.'));
          return;
        }
        const out = [];
        const total = node('div', 'spend-total');
        total.append(node('strong', 'spend-total-value', spendCost(totals.costUsd, totals.costStatus)),
          node('span', 'spend-total-label', number(totals.requests) + ' requests · ' + number(totals.outTokens) + ' output tokens'));
        out.push(total);
        if (totals.costStatus === 'partial') {
          out.push(node('p', 'spend-detail',
            'Some requests carried no provider cost, so that is a floor rather than a bill.'));
        }
        if (totals.costStatus === 'unreported') {
          out.push(node('p', 'spend-detail',
            'No request in this window carried a provider cost. That is a provider that reported nothing, not a fleet that cost nothing.'));
        }
        out.push(...rows.map(spendRowCard));
        if (spendPayload.truncated) {
          out.push(node('p', 'spend-detail', 'Showing the ' + rows.length + ' busiest of ' +
            spendPayload.modelCount + ' account and model pairs, by output tokens. The rest are on the Mac.'));
        }
        box.replaceChildren(...out);
      }

      function paintSpend() {
        const limitsBox = byId('spend-limits'), costBox = byId('spend-cost');
        if (!spendPayload) {
          const left = 'what each account has left', cost = 'what the fleet has cost';
          limitsBox.replaceChildren(spendFailure ? ui.failed(left, spendFailure, spendRetry) : ui.reading(left));
          costBox.replaceChildren(spendFailure ? ui.failed(cost, spendFailure, spendRetry) : ui.reading(cost));
          text('spend-window-note', 'Wanigan’s own record of what ran.');
          return;
        }
        // Drawn from the window the Mac answered for. A heading drawn from what
        // this page asked for can caption fourteen days of figures "last 30
        // days" and never notice it is doing it.
        text('spend-window-note', 'Last ' + spendPayload.days + ' days · Wanigan’s own record of what ran.');
        paintSpendLimits(limitsBox);
        paintSpendCost(costBox);
      }

      async function loadSpend() {
        const asked = spendDays;
        try {
          const answer = await api('api/explore?panel=spend&days=' + encodeURIComponent(String(asked)));
          // A late answer for a window nobody is asking about any more is
          // dropped rather than painted: the tap that changed the window
          // already cleared the screen, and filling it back in with the old
          // span would undo exactly the thing that clearing was for.
          if (asked !== spendDays) return;
          spendPayload = answer;
          spendReadAt = Date.now();
          spendFailure = '';
        } catch (failure) {
          if (asked !== spendDays) return;
          spendPayload = null;
          spendFailure = failure instanceof Error ? failure.message : '';
        }
        paintSpend();
      }

      function spendSyncDays() {
        document.querySelectorAll('[data-spend-days]').forEach((button) => {
          button.setAttribute('aria-pressed', Number(button.dataset.spendDays) === spendDays ? 'true' : 'false');
        });
      }

      function spendSetDays(days) {
        if (days === spendDays) return;
        spendDays = days;
        // Drop the figures rather than leave them under a heading that now
        // names a different window. Between the tap and the Mac's answer there
        // is genuinely nothing to show, and saying so is the honest state.
        spendPayload = null;
        spendFailure = '';
        spendSyncDays();
        paintSpend();
        spendRetry();
      }`,
  wiring: `      // Guarded because every line below needs this screen's markup to have been
      // composed into the frame, and one section's wiring runs in the same
      // closure as every other section's. A registry edit that dropped this
      // screen would otherwise take the whole page down on the first null —
      // which is a phone showing nothing at all rather than one screen fewer.
      // The smoke suite's anchor sweep is what catches the drop itself.
      if (byId('spend-limits')) {
        document.querySelectorAll('[data-spend-days]').forEach((button) => {
          button.addEventListener('click', () => spendSetDays(Number(button.dataset.spendDays)));
        });
        spendSyncDays();
        paintSpend();
        // The frame owns the cadence. This screen holds no interval of its own:
        // its read runs when the screen comes on and again on each poll that
        // returns while it still is, which is also what makes the retry button
        // above the same read rather than a second one.
        spendRefresh = ui.watch('spend', loadSpend);
      }`,
};
