import type { MobileSection } from '../sections';

/**
 * The repository review: which projects git reports as dirty, then one
 * project's changed files with git's own status letters beside them, then one
 * file's diff — and, below that list, the two things an operator away from the
 * Mac actually needs to do about what they have just read.
 *
 * This is the only screen on the phone that is shown a file path, and it says so
 * in the served bytes rather than in a release note. Every other panel here is
 * bound by the promise at the top of mobile/snapshot.ts — no path, pid, worktree
 * or transcript crosses this wire — and a changed-file list cannot keep that
 * promise, so the promise was widened deliberately and the widening is written
 * on the screen doing the widening. The lead paragraph is in the markup, not in
 * the script, so it is readable before any read succeeds and on a device that
 * has never reached the Mac.
 *
 * What is widened is also bounded, and the bounds are named where they bite:
 *   - paths are relative to the project, never to the disk (mobile/git.ts
 *     re-roots them and refuses anything absolute, in both directions — the
 *     path this screen asks a diff for crosses the same guard);
 *   - a list carries no contents at all. One file's diff is a second request,
 *     made because the operator tapped that file, and what comes back is git's
 *     own patch — never rewritten, and never trimmed: a diff too large to send
 *     arrives as a sentence naming its size, because a hunk that stops early
 *     reads exactly like a hunk that ended;
 *   - a list that hit a cap prints how many rows it left out, and a change set
 *     too large to count says so instead of showing half a number.
 *
 * Below the list the screen writes, and the order it is in is the order of the
 * decision: what changed, then the gate, then commit. Running the project's own
 * review gate comes first because it is the question a commit is the answer to,
 * and skipping it stays possible — an operator who has read the diff and knows
 * what they are looking at is allowed to decide that — but it is not the path of
 * least resistance, and the gate block says in words whether the run it is
 * reporting actually saw the working tree above it. A gate that could not run is
 * never drawn as a gate that passed.
 *
 * The commit is the deliberate act, so the screen shows exactly what it will
 * carry before the button: the tracked file count, the untracked count that is
 * excluded, the branch, and the fact that nothing is pushed. Two taps, eight
 * seconds apart at most, and the second one names what it is about to record.
 * Untracked files are excluded by the route rather than by this screen — there
 * is no `add` on the wire to reach — and this screen's job is to make sure
 * nobody taps the button believing otherwise.
 *
 * The 'off' state is the one that matters most here. The route answers 403 while
 * the opt-in is off, and the page renders that refusal as ui.off() naming the
 * exact setting — so a screen with nothing on it is never mistaken for a Mac
 * with nothing to say. The refusal is read from the Mac's own answer rather than
 * from a flag baked into the page, which means flipping the switch on the Mac
 * fixes this screen on the next tick with nothing to reload.
 *
 * Cadence is the frame's, through ui.watch, with one throttle on top: a working
 * tree read spawns three git processes per project, and the fleet's
 * three-second tick is not the right interval to run forty of those on. The
 * throttle is a floor under the shared tick, not a timer of this screen's own,
 * and it drops while a gate is actually running because waiting a quarter of a
 * minute to learn a build finished is a screen an operator stops believing.
 */
export const GIT_SECTION: MobileSection = {
  id: 'git',
  anchorId: 'repos',
  slot: 'git',
  markup: `        <section id="repos" class="repos">
          <h2>Working trees</h2>
          <p class="repo-lead">This is the only Wanigan screen a file path is ever sent to. Paths are relative to each project's own folder, never to where that folder sits on the Mac. A repository's list is git's status letters and line counts; tap a file and this device also reads that one file's diff, which is source — bounded, and refused rather than trimmed when it will not fit. From here you can also ask the Mac to run the project's own review gate, and commit what git already tracks. Untracked files are never added to a commit from a phone, and nothing is ever pushed: the Mac does that.</p>
          <div id="repo-body" class="repo-body"></div>
        </section>`,
  style: `    .repos > h2:first-child { margin-top:4px; }
    .repo-lead { color:var(--dim); font-size:12px; margin-bottom:12px; }
    .repo-list,.repo-files { display:grid; gap:9px; }
    .repo-row { display:grid; gap:6px; width:100%; padding:14px; text-align:left; border:1px solid var(--line); border-radius:13px; background:linear-gradient(145deg,var(--panel),var(--panel-raised)); color:var(--ink); font-weight:400; }
    button.repo-row { touch-action:manipulation; }
    button.repo-row:active { transform:scale(.985); border-color:var(--accent); }
    .repo-row-top { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
    .repo-name { font-weight:720; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .repo-tag { flex:none; display:inline-flex; align-items:center; gap:5px; border:1px solid currentColor; border-radius:999px; padding:2px 8px; font-size:11px; font-weight:760; }
    .repo-tag[data-tone="alert"] { color:var(--critical); background:var(--critical-soft); }
    .repo-tag[data-tone="serious"] { color:var(--serious); background:var(--panel-raised); }
    .repo-tag[data-tone="ok"] { color:var(--good); background:var(--good-soft); }
    .repo-tag[data-tone="quiet"] { color:var(--dim); background:var(--panel-raised); }
    .repo-meta { display:flex; flex-wrap:wrap; gap:4px 12px; color:var(--dim); font-size:12px; font-variant-numeric:tabular-nums; }
    .repo-branch { font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
    .repo-reason { color:var(--dim); font-size:12px; }
    .repo-open-hint { color:var(--accent); font-size:11px; font-weight:700; }
    .repo-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px; }
    .repo-head-name { font-weight:760; font-size:17px; letter-spacing:-.02em; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .repo-head-meta { margin-bottom:12px; }
    .repo-file { display:grid; grid-template-columns:auto minmax(0,1fr); gap:3px 10px; padding:11px 13px; border:1px solid var(--line); border-radius:11px; background:var(--panel); }
    button.repo-file { width:100%; text-align:left; font-weight:400; color:var(--ink); }
    button.repo-file:active { transform:scale(.985); border-color:var(--accent); }
    .repo-code { grid-row:1 / span 2; align-self:start; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; font-weight:700; letter-spacing:.02em; color:var(--ink); border:1px solid var(--line); border-radius:7px; padding:3px 6px; background:var(--panel-raised); white-space:pre; }
    .repo-file.conflicted .repo-code { color:var(--critical); border-color:color-mix(in srgb,var(--critical) 50%,var(--line)); }
    .repo-file.untracked .repo-code { color:var(--dim); }
    .repo-path { min-width:0; font-size:13px; overflow-wrap:anywhere; }
    .repo-file-meta { display:flex; flex-wrap:wrap; gap:3px 10px; color:var(--dim); font-size:11px; font-variant-numeric:tabular-nums; }
    .repo-added { color:var(--good); font-weight:700; }
    .repo-removed { color:var(--critical); font-weight:700; }
    .repo-diff-path { white-space:normal; overflow-wrap:anywhere; font-size:15px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    .repo-diff { margin:0; max-height:64vh; overflow:auto; overscroll-behavior:contain; padding:12px; border:1px solid var(--line); border-radius:11px; background:var(--terminal); color:var(--terminal-ink); font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; -webkit-text-size-adjust:100%; }
    .repo-diff-body { display:block; min-width:max-content; }
    .repo-diff-line { display:block; white-space:pre; }
    .repo-diff-line.add { color:var(--good); }
    .repo-diff-line.del { color:var(--critical); }
    .repo-diff-line.hunk { color:var(--blue); }
    .repo-diff-line.head { color:var(--dim); }
    .repo-note { color:var(--serious); font-size:12px; font-weight:700; margin-top:11px; }
    .repo-asof { color:var(--faint); font-size:11px; margin-top:11px; }
    .repo-act-block { display:grid; gap:8px; margin-top:16px; padding:14px; border:1px solid var(--line); border-radius:13px; background:var(--panel); }
    .repo-sub { margin:0; font-size:11px; font-weight:760; text-transform:uppercase; letter-spacing:.08em; color:var(--faint); }
    .repo-gate-state { display:flex; align-items:baseline; gap:7px; font-weight:760; }
    .repo-gate-glyph { font-size:13px; }
    .repo-gate-state[data-tone="ok"] { color:var(--good); }
    .repo-gate-state[data-tone="alert"] { color:var(--critical); }
    .repo-gate-state[data-tone="serious"] { color:var(--serious); }
    .repo-gate-state[data-tone="quiet"] { color:var(--dim); }
    .repo-line { color:var(--dim); font-size:12px; margin:0; }
    .repo-line.warn { color:var(--serious); font-weight:700; }
    .repo-message { min-height:74px; }
    .repo-act { justify-self:start; }
    .repo-act-block.armed { border-color:color-mix(in srgb,var(--critical) 55%,var(--line)); }
    .repo-confirm { color:var(--serious); font-size:12px; font-weight:700; margin:0; }
    .repo-outcome { color:var(--ink); font-size:12px; font-weight:700; margin:0; }
    @media (min-width:900px) { .repo-list { grid-template-columns:repeat(2,minmax(0,1fr)); } }`,
  script: `
      // The floor under the shared tick. Each project read is three git
      // processes, so following the fleet's three-second poll would run a
      // hundred of them a minute for a screen whose answer changes when someone
      // saves a file. Fifteen seconds is still faster than a person can read
      // forty repositories.
      const REPO_MIN_MS = 15000;
      // The floor while a gate is actually running. A gate is minutes of real
      // work and its outcome is the thing the operator is waiting on; a quarter
      // of a minute between 'running' and 'passed' is long enough for someone
      // to decide the screen has stopped. Still the shared tick underneath —
      // this is a floor, never an interval of this screen's own.
      const REPO_GATE_MIN_MS = 5000;
      // Long enough to read the sentence the second tap is confirming, short
      // enough that a tap now and a pocket tap later are never read as one
      // decision. The same window the Runs and Device screens arm with.
      const REPO_ARM_MS = 8000;
      const REPO_STATE = {
        dirty: { glyph: '●', word: 'Changed', tone: 'serious' },
        clean: { glyph: '✓', word: 'Clean', tone: 'ok' },
        'not-a-repo': { glyph: '○', word: 'Not a repository', tone: 'quiet' },
        unreadable: { glyph: '✕', word: 'Unreadable', tone: 'alert' },
      };
      // What 'where' means in words. The colour of a code chip is a second
      // channel; this is the first one, and it is what a screen reader gets.
      const REPO_WHERE = {
        conflicted: 'Conflicted',
        staged: 'Staged',
        unstaged: 'Not staged',
        both: 'Staged and changed again',
        untracked: 'Untracked',
      };
      const REPO_UNCOUNTED = {
        binary: 'Binary — git does not count its lines',
        untracked: 'Not counted — git does not diff a file it is not tracking',
        'not-counted': 'Not counted',
      };
      // Glyph and word together, before any colour, and four of them because the
      // Mac records four. 'Not recognised' is one: a gate whose stored status
      // this build has never been taught to read must not borrow the shape of
      // one that passed.
      const REPO_GATE_STATE = {
        running: { glyph: '◔', word: 'Running', tone: 'serious' },
        passed: { glyph: '✓', word: 'Passed', tone: 'ok' },
        failed: { glyph: '✕', word: 'Failed', tone: 'alert' },
        unknown: { glyph: '?', word: 'Not recognised', tone: 'quiet' },
      };
      let repoOpenId = '';
      let repoOpenName = '';
      // The third level. Empty means the list of files; set means that one
      // file's diff, and it is part of what the throttled re-read asks for, so
      // an open diff refreshes itself rather than freezing at the moment it
      // was opened while the agent that wrote it keeps working.
      let repoOpenPath = '';
      let repoReadAt = 0;
      let repoPainted = false;
      // The last one-repository reading, kept so an arm, a note or a finished
      // action can repaint without spending another three git processes to
      // redraw what this device is already holding.
      let repoLastOne = null;
      // What the last reading said about the gate, the commit and the tree the
      // commit would be made against. Read from the Mac's answer every time, and
      // never assembled here: the digest in particular is the Mac's statement
      // about what it served, and a value this page computed would be the page's
      // opinion of what it was shown — which is the thing being checked.
      let repoGate = null;
      let repoOffer = null;
      let repoTreeId = '';
      let repoGateLive = false;
      let repoGateBusy = false;
      let repoGateNote = '';
      let repoCommitBusy = false;
      let repoCommitArmedAt = 0;
      let repoCommitNote = '';
      // The draft, held outside the DOM so a repaint cannot throw away a
      // half-written message. Cleared when the operator leaves this repository,
      // never when they open a file's diff and come back.
      let repoMessage = '';

      function repoBody() { return byId('repo-body'); }

      // Only on the repository screen. A diff is one file and no gate is ever
      // reported beside it, so re-reading a patch every five seconds would buy
      // nothing and spend git processes to do it.
      function repoFloor() {
        return !repoOpenPath && repoGateLive ? REPO_GATE_MIN_MS : REPO_MIN_MS;
      }

      function repoAsOfWords() {
        return 'git was asked ' + ago(repoReadAt) + ' ago. Wanigan re-reads while this screen is open, ' +
          'at most every ' + Math.round(repoFloor() / 1000) + ' seconds, because each project read starts git.';
      }

      // Repainted rather than rebuilt on a throttled tick: the reading itself is
      // unchanged, but 'asked 4s ago' becomes false on its own, and a screen
      // that keeps saying it is the same stale claim the fleet refuses to make.
      function repoTouchAsOf() {
        const line = repoBody().querySelector('.repo-asof');
        if (line) line.textContent = repoAsOfWords();
      }

      function repoArmed() {
        return repoCommitArmedAt > 0 && Date.now() - repoCommitArmedAt < REPO_ARM_MS;
      }

      // Hold still while the operator is in the middle of something. Rebuilding
      // a row under a thumb halfway through a two-tap commit is how a deliberate
      // action becomes a mis-tap, and rebuilding the message box is a commit
      // message thrown away mid-sentence. Nothing is claimed by holding: the
      // as-of line is still repainted, so a held screen says how old its reading
      // is instead of looking like a fresh one.
      function repoHolding() {
        if (repoCommitBusy || repoGateBusy || repoArmed()) return true;
        const field = byId('repo-message');
        return Boolean(field && document.activeElement === field);
      }

      function repoTag(state) {
        const spec = REPO_STATE[state] || REPO_STATE.unreadable;
        const tag = node('span', 'repo-tag');
        // Glyph, then word, then colour. On a phone in sunlight the shape is
        // what survives, and the word is what a screen reader reads.
        const glyph = node('span', '', spec.glyph);
        glyph.setAttribute('aria-hidden', 'true');
        tag.append(glyph, node('span', '', spec.word));
        tag.setAttribute('data-tone', spec.tone);
        return tag;
      }

      function repoBranchWords(repo) {
        if (repo.detached) return 'Detached HEAD';
        return repo.branch ? repo.branch : 'No branch';
      }

      function repoTrackWords(repo) {
        const parts = [];
        if (repo.ahead > 0) parts.push(repo.ahead + ' ahead');
        if (repo.behind > 0) parts.push(repo.behind + ' behind');
        return parts.join(' · ');
      }

      function repoMeta(repo, extra) {
        const meta = node('div', 'repo-meta' + (extra ? ' ' + extra : ''));
        meta.append(node('span', 'repo-branch', repoBranchWords(repo)));
        const tracking = repoTrackWords(repo);
        if (tracking) meta.append(node('span', '', tracking));
        if (repo.operation) meta.append(node('span', '', repo.operation + ' in progress'));
        return meta;
      }

      function repoRow(repo) {
        // Only a repository with something in it opens. A tap that leads to
        // 'nothing changed' spends a round trip and three git processes to say
        // what the row it was on already said.
        const openable = repo.state === 'dirty';
        const row = node(openable ? 'button' : 'div', 'repo-row ' + repo.state);
        if (openable) {
          row.type = 'button';
          row.addEventListener('click', () => repoOpen(repo.id, repo.name));
        }
        const top = node('div', 'repo-row-top');
        top.append(node('div', 'repo-name', repo.name || 'Unnamed project'), repoTag(repo.state));
        row.append(top);
        // Only a repository git actually answered for gets a branch line. A row
        // that could not be read printing 'No branch' states something Wanigan
        // does not know — the read failed, so the branch is unknown rather than
        // absent — and on a plain folder it is a fact about nothing.
        if (repo.state === 'dirty' || repo.state === 'clean') row.append(repoMeta(repo));
        if (repo.state === 'dirty') {
          row.append(node('div', 'repo-meta', repo.changed + (repo.changed === 1 ? ' file changed' : ' files changed')));
        }
        if (repo.reason) row.append(node('p', 'repo-reason', repo.reason));
        if (openable) row.append(node('div', 'repo-open-hint', 'Tap for the changed files'));
        return row;
      }

      function repoFileRow(file) {
        // Every row opens, including the ones with no diff to show. A binary,
        // an untracked folder and a file that changed back all answer with one
        // sentence saying which of those they are, and a row that refused to be
        // tapped would leave the operator guessing at that from a status letter.
        const row = node('button', 'repo-file ' + file.where);
        row.type = 'button';
        row.addEventListener('click', () => repoOpenFile(file.path));
        // git's own two characters, unchanged. The blank half of a code like
        // ' M' is a non-breaking space so the chip keeps its width instead of
        // collapsing into a one-letter code git never printed.
        const code = node('span', 'repo-code', String(file.status || '  ').split(' ').join('\\u00a0'));
        code.setAttribute('aria-hidden', 'true');
        const meta = node('div', 'repo-file-meta');
        meta.append(node('span', '', REPO_WHERE[file.where] || 'Changed'));
        if (file.uncounted) meta.append(node('span', '', REPO_UNCOUNTED[file.uncounted] || 'Not counted'));
        else {
          meta.append(node('span', 'repo-added', '+' + number(file.added)));
          meta.append(node('span', 'repo-removed', '−' + number(file.removed)));
        }
        const path = node('div', 'repo-path', file.path);
        // The code is decorative to a screen reader; the row's name carries the
        // same fact in words, in the order a person would say it.
        path.setAttribute('aria-label', (REPO_WHERE[file.where] || 'Changed') + ': ' + file.path);
        row.append(code, path, meta);
        return row;
      }

      function repoPaintList(data) {
        // The list screen has no gate on it, so it must not borrow the faster
        // floor a running gate earns the repository screen.
        repoGateLive = false;
        const repos = Array.isArray(data.repos) ? data.repos : [];
        if (!repos.length) {
          repoBody().replaceChildren(ui.empty('No projects are registered on this Mac.',
            'Add one in Wanigan and its working tree will appear here.'));
          return;
        }
        const list = node('div', 'repo-list');
        repos.forEach((repo) => list.append(repoRow(repo)));
        const parts = [list];
        if (data.note) parts.push(node('p', 'repo-note', data.note));
        parts.push(node('p', 'repo-asof', repoAsOfWords()));
        repoBody().replaceChildren(...parts);
      }

      /* ── the gate ─────────────────────────────────────────────────── */

      // The shape is checked rather than the key, so an inherited hit —
      // 'constructor', 'toString' — resolves to the honest row too.
      function repoGateShape(status) {
        const found = REPO_GATE_STATE[status];
        if (found && found.glyph) return found;
        return REPO_GATE_STATE.unknown;
      }

      function repoPlural(n, one, many) {
        const value = Math.max(0, Number(n) || 0);
        return value + ' ' + (value === 1 ? one : many);
      }

      // Did this run see the files above it? Three answers, and the third is
      // 'Wanigan did not record which tree this saw' rather than a guess — a
      // gate started on the Mac, or one that outlived the process that started
      // it, has no recorded tree, and 'not known' is not 'the same one'.
      function repoGateSubject(run) {
        if (!run.ranAgainst) {
          return { glyph: '?', tone: 'quiet', words: 'Wanigan did not record which working tree this run saw, so it cannot say whether this result is about the files above.' };
        }
        if (run.ranAgainst === repoTreeId) {
          return { glyph: '✓', tone: 'ok', words: 'It ran against exactly the working tree above.' };
        }
        return { glyph: '●', tone: 'serious', words: 'The working tree has changed since this ran, so this result is not about the files above.' };
      }

      function repoGateFailureWords(run) {
        const step = run.failed;
        if (!step) return '';
        const named = step.command
          ? 'Stopped at command ' + step.position + ' of ' + step.total + ': ' + step.command + '.'
          : 'Stopped at command ' + step.position + ' of ' + step.total + '. ' + (step.withheld || '');
        const code = step.exitCode === null
          ? ' It reported no exit code.'
          : ' It exited ' + step.exitCode + '.';
        return named + code + ' Wanigan never sends command output to a phone; read it on the Mac.';
      }

      function repoGateRunLines(run) {
        const shape = repoGateShape(run.status);
        const parts = [];
        const state = node('div', 'repo-gate-state');
        const glyph = node('span', 'repo-gate-glyph', shape.glyph);
        // The glyph is decoration to a screen reader; the word beside it is the
        // state, and reading out a ring before it teaches nobody anything.
        glyph.setAttribute('aria-hidden', 'true');
        state.append(glyph, node('span', '', shape.word));
        state.setAttribute('data-tone', shape.tone);
        parts.push(state);
        if (run.status === 'running') {
          parts.push(node('p', 'repo-line', 'Started ' + ago(run.startedAt) + ' ago · ' +
            run.reported + ' of ' + repoPlural(run.commands, 'command', 'commands') + ' reported so far.'));
        } else {
          parts.push(node('p', 'repo-line', repoPlural(run.commands, 'command', 'commands') + ' · finished ' +
            ago(run.endedAt || run.startedAt) + ' ago.'));
        }
        if (run.status === 'failed') parts.push(node('p', 'repo-line warn', repoGateFailureWords(run)));
        if (run.status === 'unknown') {
          parts.push(node('p', 'repo-line warn',
            'Wanigan recorded a state for this run that this screen has not been taught to read, so it will not say whether it passed. Open the gate on the Mac.'));
        }
        const subject = repoGateSubject(run);
        const line = node('p', 'repo-line' + (subject.tone === 'serious' ? ' warn' : ''), subject.glyph + ' ' + subject.words);
        parts.push(line);
        if (run.stalled) parts.push(node('p', 'repo-line warn', run.stalled));
        return parts;
      }

      function repoGateBlock() {
        const block = node('div', 'repo-act-block');
        block.append(node('p', 'repo-sub', 'Review gate'));
        if (!repoGate.readable) {
          block.append(ui.failed("this project's review gate", repoGate.reason, () => repoRead(true)));
          return block;
        }
        if (!repoGate.commands) {
          // Not an empty state: the capability exists and is switched off for
          // this project, and the sentence names the exact place it is turned
          // on — the same rule the whole-screen 'off' box follows.
          block.append(ui.off('This project has no review gate.',
            'Wanigan runs the commands saved for the project on the Mac — Git → this project → Review gate. Save at least one there and this screen can run it from here.'));
          return block;
        }
        if (!repoGate.latest) {
          block.append(ui.empty('This gate has never run.',
            'It runs ' + repoPlural(repoGate.commands, 'command', 'commands') + '. Nothing has asked it to yet.'));
        } else {
          repoGateRunLines(repoGate.latest).forEach((line) => block.append(line));
        }
        if (repoGate.latest && repoGate.latest.live) {
          // A sentence rather than a disabled button. The Mac is already running
          // this gate, and a button offered here would invite the reading that
          // the first tap did not take.
          block.append(node('p', 'repo-confirm',
            'Running on the Mac now. This screen shows the outcome when it finishes.'));
        } else {
          const button = node('button', 'repo-act', 'Run the review gate');
          button.type = 'button';
          button.disabled = repoGateBusy;
          button.addEventListener('click', () => { void repoGateAct(); });
          block.append(button);
        }
        if (repoGateNote) block.append(node('p', 'repo-outcome', repoGateNote));
        return block;
      }

      async function repoGateAct() {
        if (repoGateBusy) return;
        repoGateBusy = true;
        repoGateNote = 'Asking the Mac to run the gate…';
        repoRepaint();
        try {
          // The authorization header is re-stated because api() merges init over
          // its defaults rather than into them, so an init carrying headers of
          // its own replaces the one that holds the token.
          const result = await api('api/repo/gate', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem(KEY) },
            body: JSON.stringify({ project: repoOpenId }),
          });
          repoGateNote = result && result.started === false
            ? 'A run was already going, so this device is watching that one rather than starting a second.'
            : 'The gate is running on the Mac.';
        } catch (failure) {
          repoGateNote = failure instanceof Error ? failure.message : 'Wanigan did not run the gate, and did not say why.';
        } finally {
          repoGateBusy = false;
          void repoRead(true);
        }
      }

      /* ── the commit ───────────────────────────────────────────────── */

      // What the gate has to say about a commit made right now. Never a block:
      // an operator who has read the diff may decide the gate is not worth the
      // wait, and this screen is not the place to overrule that. It is a
      // sentence, above the button, in the tense the record supports.
      function repoGateStanding() {
        if (!repoGate || !repoGate.readable || !repoGate.commands) return '';
        const run = repoGate.latest;
        if (!run) return 'The review gate has never run in this project.';
        if (run.live) return 'The review gate is running now. Its result is not in yet.';
        if (run.ranAgainst && run.ranAgainst !== repoTreeId) {
          return 'The last review gate ran against a different working tree, so it says nothing about these files.';
        }
        if (!run.ranAgainst) return 'Wanigan cannot say which working tree the last gate run saw.';
        if (run.status === 'passed') return 'The review gate passed against exactly these files.';
        if (run.status === 'failed') return 'The review gate failed against exactly these files.';
        return 'The last review gate ended in a state this screen cannot name.';
      }

      function repoCommitWords() {
        const tracked = repoPlural(repoOffer.tracked, 'tracked file', 'tracked files');
        const left = repoOffer.untracked > 0
          ? ' The ' + repoPlural(repoOffer.untracked, 'file git is not tracking is', 'files git is not tracking are') +
            ' not included: this device never adds a file to a commit.'
          : '';
        return 'This records the ' + tracked + ' listed above.' + left +
          ' Nothing is pushed — the Mac does that.';
      }

      function repoConfirmWords(branch) {
        return 'Tap again and Wanigan commits ' + repoPlural(repoOffer.tracked, 'tracked file', 'tracked files') +
          ' in "' + (repoOpenName || 'this project') + '" on ' + (branch || 'the current branch') +
          (repoOffer.untracked > 0 ? ', leaving ' + repoPlural(repoOffer.untracked, 'untracked file', 'untracked files') + ' alone' : '') +
          '. It is not pushed.';
      }

      function repoSyncCommitButton() {
        const button = byId('repo-commit-act');
        if (button) button.disabled = repoCommitBusy || !repoMessage.trim();
      }

      function repoCommitBlock(data) {
        const armed = repoArmed();
        const block = node('div', 'repo-act-block' + (armed ? ' armed' : ''));
        block.append(node('p', 'repo-sub', 'Commit'));
        // Every refusal the Mac computed arrives as one sentence, and it is the
        // same sentence the route would answer with — the button and the route
        // share the function that wrote it, so they cannot disagree.
        if (repoOffer.blocked) {
          block.append(ui.empty('There is nothing here for this device to commit.', repoOffer.blocked));
          if (repoCommitNote) block.append(node('p', 'repo-outcome', repoCommitNote));
          return block;
        }
        block.append(node('p', 'repo-line', repoCommitWords()));
        const standing = repoGateStanding();
        if (standing) block.append(node('p', 'repo-line' + (/passed/.test(standing) ? '' : ' warn'), standing));
        const field = node('textarea', 'repo-message');
        field.id = 'repo-message';
        field.rows = 3;
        field.value = repoMessage;
        field.placeholder = 'What this change does';
        field.maxLength = 2000;
        field.setAttribute('aria-label', 'Commit message');
        field.addEventListener('input', () => { repoMessage = field.value; repoSyncCommitButton(); });
        block.append(field);
        const button = node('button', 'secondary repo-act',
          armed ? 'Tap again to commit ' + repoPlural(repoOffer.tracked, 'file', 'files')
            : 'Commit ' + repoPlural(repoOffer.tracked, 'file', 'files'));
        button.id = 'repo-commit-act';
        button.type = 'button';
        button.disabled = repoCommitBusy || !repoMessage.trim();
        button.addEventListener('click', () => { void repoCommitAct(); });
        block.append(button);
        if (armed) block.append(node('p', 'repo-confirm', repoConfirmWords(data.branch)));
        if (repoCommitNote) block.append(node('p', 'repo-outcome', repoCommitNote));
        return block;
      }

      function repoCommitOutcome(result) {
        const named = result && result.commit ? ' as ' + result.commit : '';
        const done = repoPlural(result && result.committed, 'file', 'files');
        const left = Math.max(0, Number(result && result.left) || 0);
        return 'Committed' + named + ': ' + done + '.' +
          (left > 0 ? ' ' + repoPlural(left, 'untracked file was', 'untracked files were') + ' left alone.' : '') +
          ' Nothing was pushed — the Mac does that.';
      }

      async function repoCommitAct() {
        if (repoCommitBusy) return;
        const message = repoMessage.trim();
        if (!message) return;
        if (!repoArmed()) {
          // Two taps, and the second one names what will be recorded. A commit
          // is a write to the operator's repository, and a thumb finds a button
          // by accident on a screen it is scrolling past.
          repoCommitArmedAt = Date.now();
          repoCommitNote = '';
          repoRepaint();
          setTimeout(() => {
            if (repoCommitArmedAt > 0 && !repoArmed()) { repoCommitArmedAt = 0; repoRepaint(); }
          }, REPO_ARM_MS + 200);
          return;
        }
        repoCommitArmedAt = 0;
        repoCommitBusy = true;
        repoCommitNote = 'Committing…';
        repoRepaint();
        try {
          const result = await api('api/repo/commit', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem(KEY) },
            // The digest is the Mac's own statement of the reading this screen
            // is showing, handed straight back. The Mac refuses the commit if
            // its tree has moved since, and says what moved.
            body: JSON.stringify({ project: repoOpenId, digest: repoTreeId, message: message }),
          });
          repoMessage = '';
          repoCommitNote = repoCommitOutcome(result);
        } catch (failure) {
          repoCommitNote = failure instanceof Error ? failure.message : 'Wanigan refused that commit, and did not say why.';
        } finally {
          repoCommitBusy = false;
          // Forced, because the tree has just changed and a throttled read would
          // leave the file list claiming files that are now committed.
          void repoRead(true);
        }
      }

      /* ── one repository ───────────────────────────────────────────── */

      function repoPaintOne(data) {
        repoLastOne = data;
        repoGate = data.gate && typeof data.gate === 'object' ? data.gate : null;
        repoOffer = data.commit && typeof data.commit === 'object' ? data.commit : null;
        repoTreeId = typeof data.digest === 'string' ? data.digest : '';
        repoGateLive = Boolean(repoGate && repoGate.latest && repoGate.latest.live);
        const head = node('div', 'repo-head');
        const back = node('button', 'secondary repo-back', 'All repositories');
        back.type = 'button';
        back.addEventListener('click', () => repoClose());
        head.append(back, node('div', 'repo-head-name', data.name || repoOpenName));
        const parts = [head, repoMeta(data, 'repo-head-meta')];
        const files = Array.isArray(data.files) ? data.files : [];
        if (!files.length) {
          parts.push(ui.empty('git reports nothing changed here.',
            'The working tree matched the last commit when Wanigan asked.'));
        } else {
          // One sentence for the whole list rather than a hint on each row: a
          // three-hundred-file repository would otherwise repeat it three
          // hundred times down a phone screen.
          parts.push(node('p', 'repo-lead', 'Tap a file to read its diff.'));
          const list = node('div', 'repo-files');
          files.forEach((file) => list.append(repoFileRow(file)));
          parts.push(list);
        }
        // Both caps, in the answer's own words. A count that was refused and a
        // list that was cut are different absences with different fixes, so
        // they arrive as two sentences rather than one hedge.
        if (data.countsNote) parts.push(node('p', 'repo-note', data.countsNote));
        if (data.note) parts.push(node('p', 'repo-note', data.note));
        // The order of the decision: what changed, then the gate, then the
        // commit. The gate sits between the two on purpose — reaching the
        // button without having looked at it stays possible and stops being
        // the shortest way down the screen.
        if (repoGate) parts.push(repoGateBlock());
        if (repoOffer) parts.push(repoCommitBlock(data));
        parts.push(node('p', 'repo-asof', repoAsOfWords()));
        repoBody().replaceChildren(...parts);
      }

      // Redraw from the reading this device is already holding. Used by the
      // things that change what the screen says without changing what the Mac
      // said — arming a commit, a note coming back — so a repaint never costs
      // three git processes.
      function repoRepaint() {
        if (repoOpenPath || !repoLastOne) return;
        repoPaintOne(repoLastOne);
      }

      // git's own patch, one row per line, with the character git printed still
      // the first thing on that row. The colour is the second channel and the
      // +, - or @ is the first, which is the one that survives a phone held in
      // sunlight and the one a screen reader can read out.
      //
      // The block scrolls in both directions inside itself: a diff of minified
      // JavaScript is one line a hundred thousand columns wide, and wrapping it
      // would turn a hunk into a paragraph while making the whole page slide
      // sideways under every other screen's fingers. min-width:max-content on
      // the inner element is what keeps a coloured row's background running the
      // full width of the widest line rather than stopping at the viewport.
      function repoDiffBlock(patch) {
        const block = node('pre', 'repo-diff');
        const body = node('code', 'repo-diff-body');
        String(patch).replace(/\\n$/, '').split('\\n').forEach((line) => {
          const first = line.charAt(0);
          // The file headers are checked before the +/- lines: '+++ b/file' and
          // '--- a/file' start with the same characters as a changed line and
          // are not one, so colouring them as added and removed source would be
          // the viewer inventing a change git never reported.
          const kind = line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('diff --git ')
            || line.startsWith('index ') || line.startsWith('new file ') || line.startsWith('deleted file ')
            || line.startsWith('old mode ') || line.startsWith('new mode ')
            || line.startsWith('similarity index ') || line.startsWith('rename ')
            ? ' head'
            : first === '+' ? ' add' : first === '-' ? ' del' : first === '@' ? ' hunk' : '';
          // A blank row is a space rather than nothing, so an empty line in the
          // file keeps its height instead of collapsing the diff around it.
          body.append(node('span', 'repo-diff-line' + kind, line === '' ? ' ' : line));
        });
        block.append(body);
        return block;
      }

      function repoPaintDiff(data) {
        const head = node('div', 'repo-head');
        const back = node('button', 'secondary repo-back', 'All changed files');
        back.type = 'button';
        back.addEventListener('click', () => repoCloseFile());
        head.append(back, node('div', 'repo-head-name repo-diff-path', data.path || repoOpenPath));
        const meta = node('div', 'repo-meta repo-head-meta');
        meta.append(node('span', '', REPO_WHERE[data.where] || 'Changed'));
        // The counts are the ones git reported for this file on this read, not
        // the ones the list was carrying: the list may be a quarter of a minute
        // old, and two numbers beside a diff have to describe that diff.
        if (typeof data.added === 'number') {
          meta.append(node('span', 'repo-added', '+' + number(data.added)));
          meta.append(node('span', 'repo-removed', '−' + number(data.removed)));
        }
        const parts = [head, meta];
        if (data.patch) parts.push(repoDiffBlock(data.patch));
        // A refused diff is not a failed read. The Mac answered, and what it
        // answered with is the sentence — too large, binary, changed back — so
        // this is an absence with a reason rather than an error with a retry
        // button that would fetch the same refusal again.
        else {
          parts.push(ui.empty('There are no hunks to show for this file.',
            data.reason || 'Wanigan did not say why, which is itself a bug worth reporting.'));
        }
        parts.push(node('p', 'repo-asof', repoAsOfWords()));
        repoBody().replaceChildren(...parts);
      }

      // The refusal the dispatcher sends while the opt-in is off is a 403 whose
      // sentence contains 'disabled' — the same contract the agent console
      // reads. Everything else is a read that failed, and gets a retry.
      function repoFailureBox(what, failure, retry) {
        const message = failure instanceof Error ? failure.message : '';
        if (/disabled/.test(message)) {
          return ui.off('Repository review is off.',
            'Wanigan Settings → Phone monitor → Repository review lets this device read which files ' +
            'each project has changed, run that project\\'s review gate, and commit what git already ' +
            'tracks. It is off until you turn it on, because a changed-file list is made of file paths ' +
            'and no other screen here sends one.');
        }
        return ui.failed(what, message, retry);
      }

      function repoEndpoint(id, file) {
        if (!id) return 'api/repos';
        const project = 'project=' + encodeURIComponent(id);
        return file
          ? 'api/repo/file?' + project + '&file=' + encodeURIComponent(file)
          : 'api/repo?' + project;
      }

      async function repoRead(force) {
        const asked = repoOpenId;
        const askedFile = repoOpenPath;
        const what = askedFile ? "this file's diff" : asked ? 'this working tree' : 'the working trees';
        if (!force && repoPainted && (repoHolding() || Date.now() - repoReadAt < repoFloor())) {
          repoTouchAsOf();
          return;
        }
        if (!repoPainted) repoBody().replaceChildren(ui.reading(what));
        try {
          const data = await api(repoEndpoint(asked, askedFile));
          // The operator may have opened a repository or a file, or gone back,
          // while this was in flight. Painting the answer to the question they
          // have stopped asking is worse than waiting one more tick for the
          // right one, so both levels are compared and not just the repository.
          if (repoOpenId !== asked || repoOpenPath !== askedFile) return;
          // This device's clock, not the Mac's generatedAt: subtracting one from
          // the other turns a couple of minutes of skew into a staleness that
          // never happened.
          repoReadAt = Date.now();
          repoPainted = true;
          if (askedFile) repoPaintDiff(data);
          else if (asked) repoPaintOne(data);
          else repoPaintList(data);
        } catch (failure) {
          if (repoOpenId !== asked || repoOpenPath !== askedFile) return;
          repoPainted = false;
          repoBody().replaceChildren(repoFailureBox(what, failure, () => repoRead(true)));
        }
      }

      // Everything this screen was holding about one repository, forgotten. The
      // draft message goes with it: a commit message written about one project's
      // files must never turn up under another's.
      function repoForget() {
        repoLastOne = null;
        repoGate = null;
        repoOffer = null;
        repoTreeId = '';
        repoGateLive = false;
        repoGateNote = '';
        repoCommitNote = '';
        repoCommitArmedAt = 0;
        repoMessage = '';
      }

      function repoOpen(id, name) {
        repoOpenId = String(id || '');
        repoOpenName = String(name || '');
        repoOpenPath = '';
        repoPainted = false;
        repoReadAt = 0;
        repoForget();
        window.scrollTo(0, 0);
        void repoRead(true);
      }

      function repoClose() {
        repoOpenId = '';
        repoOpenName = '';
        repoOpenPath = '';
        repoPainted = false;
        repoReadAt = 0;
        repoForget();
        void repoRead(true);
      }

      function repoOpenFile(path) {
        repoOpenPath = String(path || '');
        repoPainted = false;
        repoReadAt = 0;
        window.scrollTo(0, 0);
        void repoRead(true);
      }

      // Back to the file list, which is re-read rather than restored from what
      // this device was showing before the diff was opened: the working tree
      // has had a diff's worth of reading time to change, and a list painted
      // from memory would claim a freshness it does not have. The draft message
      // survives — reading a hunk before writing about it is the point.
      function repoCloseFile() {
        repoOpenPath = '';
        repoPainted = false;
        repoReadAt = 0;
        void repoRead(true);
      }`,
  wiring: `      // No interval of this screen's own: ui.watch runs the read when the Git
      // screen comes up and again on each poll that returns while it is still
      // there, and repoRead's own floor keeps that from becoming forty git
      // processes every three seconds.
      ui.watch('git', () => repoRead(false));`,
};
