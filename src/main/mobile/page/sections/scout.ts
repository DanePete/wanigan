import type { MobileSection } from '../sections';

/**
 * The Scout's digest: what the last scan actually did, and the proposals still
 * waiting on a decision.
 *
 * The fact this screen exists to carry is the outcome of the last pass. A scan
 * reports 'running', 'completed', 'blocked' or 'failed', and the last three are
 * not the same event — 'blocked' means a consent gate stopped the pass before
 * it contacted anything. Drawing that as a completed scan would be the phone
 * announcing an online check at the moment the Mac declined to make one, which
 * is the exact bug the desktop view carried until it was fixed: a constant
 * success sentence over a run record that had been saying otherwise all along.
 * So the outcome is glyph and word before any colour, the stored explanation
 * sits under it, and a completed pass that was never permitted to leave the
 * machine says so rather than borrowing the shape of one that did.
 *
 * The second thing it carries is the analyser. This build matches with local
 * deterministic rules and sends no source text to a model, and that is a
 * promise the desktop makes in so many words — so the phone makes it in the
 * same words, and only while the Mac is actually reporting that analyser. A
 * later one arrives here as its own unfamiliar name with no promise attached.
 *
 * It is read-only on purpose, and says so instead of implying otherwise. Every
 * write the Scout offers is either egress against an allow-list or a commitment
 * against a working tree this device does not have; a Create Goal button here
 * would either lie about what it did or do something smaller than its label.
 *
 * Typed with the slot held apart, exactly as the Spend and Device screens were
 * before they were registered: 'scout' is not in MobileSectionSlot until this
 * screen is added to the registry, and a cast to the current union would
 * compile and then compose the screen into no slot at all — a live tab that
 * navigates to a blank panel, which is the same lie as an empty fleet on a
 * sleeping Mac.
 */
type ScoutSection = Omit<MobileSection, 'slot'> & { slot: 'scout' };

export const SCOUT_SECTION: ScoutSection = {
  id: 'scout',
  anchorId: 'scout',
  slot: 'scout',
  markup: `        <section id="scout" class="scout">
          <h2>Last scan</h2>
          <div id="scout-run" class="scout-run"></div>
          <p id="scout-next" class="scout-lead"></p>
          <p id="scout-method" class="scout-lead"></p>
          <p class="scout-lead">This screen reads. Starting a scan is egress against the source allow-list, and creating a Goal from a proposal is a Mac action — both are decisions Wanigan takes at the machine holding the allow-list and the repository.</p>

          <h2>Sources</h2>
          <div id="scout-sources" class="scout-sources"></div>

          <h2>Proposals</h2>
          <p class="scout-lead">Open proposals only: the ones still waiting on a decision. Snoozed and dismissed proposals stay on the Mac, where reopening one is a decision made against the repository it is about. The order below is a filing order, not a ranking.</p>
          <div id="scout-list" class="scout-list"></div>
        </section>`,
  style: `    .scout > h2:first-child { margin-top:4px; }
    .scout-lead { color:var(--dim); font-size:12px; line-height:1.5; margin-bottom:10px; }
    .scout-run,.scout-sources,.scout-list { display:grid; gap:10px; }
    .scout-run-card,.scout-source,.scout-proposal { padding:14px; display:grid; gap:8px; min-width:0; }
    .scout-run-top { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; }
    .scout-run-glyph { color:var(--faint); font-size:15px; }
    .scout-run-word { font-weight:760; letter-spacing:-.01em; }
    .scout-run-when { margin-left:auto; color:var(--faint); font-size:11px; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .scout-run-card.outcome-completed .scout-run-glyph { color:var(--good); }
    .scout-run-card.outcome-blocked .scout-run-glyph { color:var(--serious); }
    .scout-run-card.outcome-failed .scout-run-glyph { color:var(--critical); }
    .scout-run-card.outcome-blocked { border-color:color-mix(in srgb,var(--serious) 45%,var(--line)); }
    .scout-run-card.outcome-failed { border-color:color-mix(in srgb,var(--critical) 50%,var(--line)); }
    .scout-run-line { font-size:13px; line-height:1.5; }
    .scout-run-detail,.scout-run-mode { color:var(--dim); font-size:12px; line-height:1.5; }
    .scout-run-error { color:var(--critical); font-size:12px; line-height:1.5; }
    .scout-source-top { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
    .scout-source-name { font-weight:720; overflow:hidden; text-overflow:ellipsis; }
    .scout-tag { flex:none; border:1px solid var(--line); border-radius:999px; padding:2px 8px; color:var(--dim); font-size:11px; font-weight:700; white-space:nowrap; }
    .scout-tag.off { color:var(--faint); }
    .scout-tag.bad { color:var(--critical); border-color:color-mix(in srgb,var(--critical) 45%,var(--line)); }
    .scout-source-line { color:var(--dim); font-size:12px; line-height:1.5; }
    .scout-proposal-top { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
    .scout-kicker { color:var(--faint); font-size:10px; text-transform:uppercase; letter-spacing:.06em; overflow:hidden; text-overflow:ellipsis; }
    .scout-proposal-title { margin:0; font-size:16px; letter-spacing:-.01em; }
    .scout-proposal-summary,.scout-why { color:var(--dim); font-size:13px; line-height:1.5; }
    .scout-facts { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; border-top:1px solid var(--line); padding-top:10px; }
    .scout-fact { display:grid; gap:2px; min-width:0; }
    .scout-fact span { color:var(--faint); font-size:10px; text-transform:uppercase; letter-spacing:.06em; }
    .scout-fact strong { font-size:13px; font-variant-numeric:tabular-nums; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .scout-evidence-toggle { justify-self:start; }
    .scout-evidence { display:grid; gap:4px; border-left:2px solid var(--line); padding-left:10px; }
    .scout-evidence-title { font-size:13px; }
    .scout-evidence-meta { color:var(--faint); font-size:11px; }
    .scout-evidence-excerpt { color:var(--dim); font-size:12px; line-height:1.5; }
    .scout-evidence-cut { color:var(--serious); font-size:11px; font-weight:700; line-height:1.5; }
    .scout-evidence-link { color:var(--blue); font-size:12px; font-weight:700; }
    .scout-none { color:var(--serious); font-size:12px; font-weight:700; line-height:1.5; }
    @media (max-width:680px) { .scout-facts { grid-template-columns:repeat(2,minmax(0,1fr)); } }`,
  script: `
      let scoutPayload = null;
      // When that payload reached this device, on this device's clock. The one
      // age below that is about the reading itself is the Mac's own measurement
      // plus the time since this moment; the two clocks are added, never
      // subtracted from each other.
      let scoutReadAt = 0;
      let scoutFailure = '';
      let scoutRefresh = null;
      // Which proposal has its evidence open. Held outside the paint because
      // the frame re-runs this screen's read on every poll: without it, an
      // expanded proposal would fold itself shut every three seconds while
      // somebody was reading the excerpt inside it.
      let scoutOpenId = '';

      function scoutRetry() { if (scoutRefresh) void scoutRefresh(); }

      // Branches rather than a lookup object, because the key comes off the
      // wire: 'constructor' and 'toString' are hits on any object literal and
      // would resolve to something this table never wrote.
      function scoutRunGlyph(status) {
        if (status === 'running') return '◐';
        if (status === 'completed') return '✓';
        if (status === 'blocked') return '⁃';
        if (status === 'failed') return '✕';
        return '?';
      }

      function scoutRunWord(status) {
        if (status === 'running') return 'Still running';
        if (status === 'completed') return 'Completed';
        if (status === 'blocked') return 'Blocked';
        if (status === 'failed') return 'Failed';
        return 'Not recognised';
      }

      // The sentence that keeps three different outcomes from reading as one.
      // A blocked pass never contacted anything and must never be described as
      // a check that happened; a completed pass that was not permitted to leave
      // the Mac is a local inventory refresh and must not borrow the shape of
      // an online one either.
      function scoutRunSentence(run) {
        if (run.status === 'blocked') {
          return 'A consent gate stopped this scan before it contacted anything, so no online check was made.';
        }
        if (run.status === 'failed') {
          return 'It broke before it finished, and nothing was proposed from it.';
        }
        if (run.status === 'running') {
          return 'It has not reported an outcome yet, so there is nothing to read from it.';
        }
        if (run.status !== 'completed') {
          return 'Wanigan recorded an outcome this build has not been taught to read. Open Scout on the Mac before trusting it.';
        }
        if (!run.networkAllowed) {
          return 'A local pass: the capability inventory was refreshed and no official source was contacted.';
        }
        return 'Read ' + number(run.evidenceCount) + ' of ' + number(run.sourceCount) +
          ' enabled source' + (run.sourceCount === 1 ? '' : 's') + ' and filed ' + number(run.proposalCount) +
          ' proposal' + (run.proposalCount === 1 ? '' : 's') + '.';
      }

      function scoutModeWords(run) {
        if (run.mode === 'scheduled') return 'Started by the weekly watch on the Mac.';
        if (run.mode === 'preview') return 'A local preview, started by hand at the Mac. Previews never contact a source.';
        return 'Started by hand at the Mac.';
      }

      // ago() tops out in hours, which turns a scan from a fortnight ago into
      // '336h 0m'. Past two days the date is the readable answer, and it is the
      // device's local date because that is the calendar the reader is holding.
      function scoutWhen(at) {
        if (!at) return 'at a time nothing recorded';
        const since = Date.now() - Number(at);
        if (since < 172800000) return ago(at) + ' ago';
        return new Date(Number(at)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      }

      // ago() answers how long since; this answers how long until. Relative and
      // never a wall clock: the weekly cron is read in the Mac's local time and
      // this page is held in whatever timezone the operator is standing in.
      function scoutUntil(at) {
        const seconds = Math.round((Number(at) - Date.now()) / 1000);
        if (seconds <= 0) return 'due now';
        if (seconds < 3600) return 'in ' + Math.max(1, Math.floor(seconds / 60)) + 'm';
        const hours = Math.floor(seconds / 3600);
        if (hours < 48) return 'in ' + hours + 'h';
        return 'in ' + Math.floor(hours / 24) + ' days';
      }

      // How long this device has been holding the current reading, on this
      // device's clock alone. Zero before the first payload arrives, which is
      // the truthful answer for a reading that does not exist yet.
      function scoutSince() {
        return scoutReadAt ? Date.now() - scoutReadAt : 0;
      }

      // When the next scan is, or the honest reason there is not one. A
      // disarmed schedule has no next fire at all, and printing a guessed one
      // would be the phone promising background egress nobody allowed.
      function scoutNextLine() {
        if (!scoutPayload.workspaceEnabled) {
          return 'Scout is paused on the Mac, so nothing will scan until it is enabled there.';
        }
        if (!scoutPayload.onlineResearchEnabled) {
          return 'Unattended source checks are not allowed, so the weekly watch cannot read a source. That permission is given on the Mac.';
        }
        if (!scoutPayload.weeklyEnabled || scoutPayload.nextRunAt === null) {
          return 'No weekly watch is armed, so the next scan is whenever someone starts one at the Mac.';
        }
        return scoutPayload.cadenceLabel + ' · next scan ' + scoutUntil(scoutPayload.nextRunAt) + '.';
      }

      // The promise is made only while the Mac is reporting the analyser that
      // earns it. A later analyser is named and left undescribed rather than
      // inheriting a sentence about a rules engine it may not be.
      function scoutMethodLine() {
        if (scoutPayload.deterministic) {
          return 'Proposals are built by local deterministic rules. No source text is sent to a model.';
        }
        return 'This build analyses with “' + scoutPayload.analysisMethod +
          '”, which this screen cannot describe. Check what it does on the Mac before trusting a proposal from it.';
      }

      function scoutRunCard() {
        const run = scoutPayload.lastRun;
        if (!run) {
          return ui.empty('No scan has run yet.',
            'Scout files a proposal only after a pass. Start one, or arm the weekly watch, in Wanigan → Scout on the Mac.');
        }
        const card = node('article', 'card scout-run-card outcome-' + run.status);
        const top = node('div', 'scout-run-top');
        const glyph = node('span', 'scout-run-glyph', scoutRunGlyph(run.status));
        glyph.setAttribute('aria-hidden', 'true');
        top.append(glyph, node('strong', 'scout-run-word', scoutRunWord(run.status)),
          node('span', 'scout-run-when', scoutWhen(run.startedAt)));
        card.append(top, node('p', 'scout-run-line', scoutRunSentence(run)));
        // Wanigan's own stored account of the pass. A blocked scan keeps its
        // reason here and writes no error at all, so a card that printed only
        // the error would leave the one outcome that most needs explaining
        // showing a bare word.
        if (run.detail) card.append(node('p', 'scout-run-detail', run.detail));
        if (run.error) card.append(node('p', 'scout-run-error', run.error));
        card.append(node('p', 'scout-run-mode', scoutModeWords(run)));
        return card;
      }

      function scoutSourceCard(row) {
        const card = node('article', 'card scout-source');
        const top = node('div', 'scout-source-top');
        top.append(node('div', 'scout-source-name', row.label),
          node('span', 'scout-tag' + (row.enabled ? '' : ' off'), row.enabled ? 'included' : 'excluded'));
        card.append(top);
        // 'Never checked' is its own answer and never 'ok'. A source nothing has
        // ever read must not wear the shape of one that answered.
        const checked = row.lastCheckedAt ? ' ' + scoutWhen(row.lastCheckedAt) : '';
        const outcome = row.lastStatus === 'ok' ? 'Read without error' + checked + '.'
          : row.lastStatus === 'failed' ? 'Could not be read' + checked + '.'
          : row.lastStatus === 'skipped' ? 'Skipped' + checked + '.'
          : 'Never checked.';
        card.append(node('p', 'scout-source-line', row.publisher + ' · ' + outcome));
        if (row.lastStatus === 'failed' && row.lastDetail) {
          card.append(node('p', 'scout-run-error', row.lastDetail));
        }
        return card;
      }

      function scoutFact(label, value) {
        const fact = node('div', 'scout-fact');
        fact.append(node('span', '', label), node('strong', '', value));
        return fact;
      }

      function scoutStatusWord(status) {
        if (status === 'reviewed') return 'reviewed';
        if (status === 'goal-created') return 'goal created';
        return 'new';
      }

      function scoutEvidenceCard(item) {
        const box = node('div', 'scout-evidence');
        box.append(node('strong', 'scout-evidence-title', item.title));
        const meta = [item.publisher || '', item.publishedAt
          ? 'published ' + new Date(item.publishedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
          : ''].filter(Boolean).join(' · ');
        if (meta) box.append(node('span', 'scout-evidence-meta', meta));
        if (item.excerpt) box.append(node('p', 'scout-evidence-excerpt', item.excerpt));
        // An excerpt that stops mid-sentence with nothing said about it reads
        // as a source that trailed off there. The Mac holds the longer passage;
        // this says so rather than leaving an ellipsis to be interpreted.
        if (item.excerptTruncated) {
          box.append(node('p', 'scout-evidence-cut',
            'This passage was cut at ' + item.excerpt.length + ' characters to keep it off the radio. The stored excerpt is longer; read it on the Mac.'));
        }
        if (item.url) {
          const link = node('a', 'scout-evidence-link', 'Open the source ↗');
          link.href = item.url;
          link.target = '_blank';
          link.rel = 'noreferrer noopener';
          box.append(link);
        }
        return box;
      }

      function scoutProposalCard(row) {
        const card = node('article', 'card scout-proposal');
        const top = node('div', 'scout-proposal-top');
        top.append(node('span', 'scout-kicker', row.category + ' · found ' + scoutWhen(row.foundAt)),
          node('span', 'scout-tag', scoutStatusWord(row.status)));
        card.append(top, node('h3', 'scout-proposal-title', row.title),
          node('p', 'scout-proposal-summary', row.summary));
        const facts = node('div', 'scout-facts');
        // Reason codes, not a verdict, and the confidence is labelled as the
        // rule-table output it is. The proposal's score never crosses the wire:
        // it is a constant that looks like a measurement.
        facts.append(scoutFact('Effort', row.effort), scoutFact('Risk', row.risk),
          scoutFact('Confidence · rule', Number(row.confidence).toFixed(2)),
          scoutFact('Evidence', number(row.evidenceCount) + (row.evidenceCount === 1 ? ' source' : ' sources')));
        card.append(facts);
        if (row.whyNow) card.append(node('p', 'scout-why', 'Why it surfaced: ' + row.whyNow));
        if (row.recommendation) card.append(node('p', 'scout-why', 'Proposed next step: ' + row.recommendation));
        if (row.evidenceCount === 0) {
          card.append(node('p', 'scout-none',
            'No source is attached to this proposal. Do not turn it into work until one is.'));
          return card;
        }
        const open = scoutOpenId === row.id;
        const toggle = node('button', 'secondary scout-evidence-toggle',
          open ? 'Hide evidence' : 'Show evidence');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.addEventListener('click', () => {
          scoutOpenId = scoutOpenId === row.id ? '' : row.id;
          paintScout();
        });
        card.append(toggle);
        if (open) {
          card.append(...row.evidence.map(scoutEvidenceCard));
          if (row.evidenceTruncated) {
            card.append(node('p', 'scout-evidence-cut', 'Showing ' + row.evidence.length + ' of ' +
              number(row.evidenceCount) + ' attached sources. The rest are on the Mac.'));
          }
        }
        if (row.goalLinked) {
          card.append(node('p', 'scout-run-mode',
            'A Goal already exists for this proposal. It opens in Control on the Mac.'));
        }
        return card;
      }

      function paintScoutList(box) {
        const rows = scoutPayload.proposals || [];
        if (!rows.length) {
          box.replaceChildren(ui.empty('No proposal is waiting on you.',
            'Scout files one only when an enabled source matches a rule about something Wanigan does not do yet.'));
          return;
        }
        const out = rows.map(scoutProposalCard);
        if (scoutPayload.truncated) {
          out.push(node('p', 'scout-lead', 'Showing ' + rows.length + ' of ' +
            (scoutPayload.readCapped ? 'at least ' : '') + number(scoutPayload.openCount) +
            ' open proposals, in the order Wanigan files them. The rest are on the Mac.'));
        }
        // Once the Mac has gone quiet these proposals are a memory rather than
        // a reading, and the sentence says which. The age is the Mac's own
        // measurement of how old its composed reading was plus the time this
        // device has held it — the two clocks are added, never subtracted from
        // each other, so skew cannot read as staleness that never happened.
        if (ui.observed() && !ui.fresh()) {
          out.push(node('p', 'scout-lead', 'This is the last reading, from ' +
            ago(Date.now() - (scoutPayload.readAgeMs + scoutSince())) + ' ago.'));
        }
        box.replaceChildren(...out);
      }

      function paintScoutSources(box) {
        const rows = scoutPayload.sources || [];
        if (!rows.length) {
          box.replaceChildren(ui.empty('No source is configured.',
            'Scout cannot read anything until a trusted source exists, which is set up on the Mac.'));
          return;
        }
        const out = rows.map(scoutSourceCard);
        if (!scoutPayload.enabledSourceCount) {
          out.unshift(node('p', 'scout-none',
            'No source is enabled, so an online pass has nothing to read and will be blocked before it starts.'));
        }
        box.replaceChildren(...out);
      }

      function paintScout() {
        const runBox = byId('scout-run'), sourceBox = byId('scout-sources'), listBox = byId('scout-list');
        if (!scoutPayload) {
          const scan = 'the last Scout scan', queue = 'the Scout proposals';
          runBox.replaceChildren(scoutFailure ? ui.failed(scan, scoutFailure, scoutRetry) : ui.reading(scan));
          sourceBox.replaceChildren(scoutFailure ? ui.failed('the Scout sources', scoutFailure, scoutRetry) : ui.reading('the Scout sources'));
          listBox.replaceChildren(scoutFailure ? ui.failed(queue, scoutFailure, scoutRetry) : ui.reading(queue));
          text('scout-next', '');
          text('scout-method', '');
          return;
        }
        text('scout-next', scoutNextLine());
        text('scout-method', scoutMethodLine());
        runBox.replaceChildren(scoutRunCard());
        paintScoutSources(sourceBox);
        paintScoutList(listBox);
      }

      async function loadScout() {
        try {
          scoutPayload = await api('api/scout');
          scoutReadAt = Date.now();
          scoutFailure = '';
        } catch (failure) {
          scoutPayload = null;
          scoutFailure = failure instanceof Error ? failure.message : '';
        }
        paintScout();
      }`,
  wiring: `      // Guarded because every line below needs this screen's markup to have been
      // composed into the frame, and one section's wiring runs in the same
      // closure as every other section's. A registry edit that dropped this
      // screen would otherwise take the whole page down on the first null.
      if (byId('scout-run')) {
        paintScout();
        // The frame owns the cadence. This screen holds no interval of its own:
        // its read runs when the screen comes on and again on each poll that
        // returns while it still is, which is also what makes the retry button
        // the same read rather than a second one.
        scoutRefresh = ui.watch('scout', loadScout);
      }`,
};
