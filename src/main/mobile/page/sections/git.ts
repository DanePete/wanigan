import type { MobileSection } from '../sections';

/**
 * The repository review: which projects git reports as dirty, then one
 * project's changed files with git's own status letters beside them, then one
 * file's diff.
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
 * Reading only, still. There is no route here that stages, applies, commits or
 * writes, and the three screens below are three reads of the same working tree.
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
 * throttle is a floor under the shared tick, not a timer of this screen's own.
 */
export const GIT_SECTION: MobileSection = {
  id: 'git',
  anchorId: 'repos',
  slot: 'git',
  markup: `        <section id="repos" class="repos">
          <h2>Working trees</h2>
          <p class="repo-lead">This is the only Wanigan screen a file path is ever sent to. Paths are relative to each project's own folder, never to where that folder sits on the Mac. A repository's list is git's status letters and line counts; tap a file and this device also reads that one file's diff, which is source — bounded, and refused rather than trimmed when it will not fit. Nothing on this screen writes.</p>
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
    @media (min-width:900px) { .repo-list { grid-template-columns:repeat(2,minmax(0,1fr)); } }`,
  script: `
      // The floor under the shared tick. Each project read is three git
      // processes, so following the fleet's three-second poll would run a
      // hundred of them a minute for a screen whose answer changes when someone
      // saves a file. Fifteen seconds is still faster than a person can read
      // forty repositories.
      const REPO_MIN_MS = 15000;
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
      let repoOpenId = '';
      let repoOpenName = '';
      // The third level. Empty means the list of files; set means that one
      // file's diff, and it is part of what the throttled re-read asks for, so
      // an open diff refreshes itself rather than freezing at the moment it
      // was opened while the agent that wrote it keeps working.
      let repoOpenPath = '';
      let repoReadAt = 0;
      let repoPainted = false;

      function repoBody() { return byId('repo-body'); }

      function repoAsOfWords() {
        return 'git was asked ' + ago(repoReadAt) + ' ago. Wanigan re-reads while this screen is open, ' +
          'at most every ' + Math.round(REPO_MIN_MS / 1000) + ' seconds, because each project read starts git.';
      }

      // Repainted rather than rebuilt on a throttled tick: the reading itself is
      // unchanged, but 'asked 4s ago' becomes false on its own, and a screen
      // that keeps saying it is the same stale claim the fleet refuses to make.
      function repoTouchAsOf() {
        const line = repoBody().querySelector('.repo-asof');
        if (line) line.textContent = repoAsOfWords();
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

      function repoPaintOne(data) {
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
        parts.push(node('p', 'repo-asof', repoAsOfWords()));
        repoBody().replaceChildren(...parts);
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
            'each project has changed. It is off until you turn it on, because a changed-file list is ' +
            'made of file paths and no other screen here sends one.');
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
        if (!force && repoPainted && Date.now() - repoReadAt < REPO_MIN_MS) { repoTouchAsOf(); return; }
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

      function repoOpen(id, name) {
        repoOpenId = String(id || '');
        repoOpenName = String(name || '');
        repoOpenPath = '';
        repoPainted = false;
        repoReadAt = 0;
        window.scrollTo(0, 0);
        void repoRead(true);
      }

      function repoClose() {
        repoOpenId = '';
        repoOpenName = '';
        repoOpenPath = '';
        repoPainted = false;
        repoReadAt = 0;
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
      // from memory would claim a freshness it does not have.
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
