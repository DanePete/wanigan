// The Changes tab: what is conflicted, staged, changed and untracked (and, in a
// card's worktree, what its commits changed), every file's diff in one scroll
// the way a review reads, and the commit box. A file, a hunk or picked lines
// are staged, unstaged or discarded from the diff itself; a discard says
// plainly what is lost before it happens. J and K move between files, V marks
// one viewed, S stages or unstages it.
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DiffArea, GitStatus, StatusEntry } from '@shared/git';
import { LIVE_STATES, type CardSummary, type ProjectSummary } from '@shared/model';
import { reviewMessage, type ReviewNote } from '@shared/review-notes';
import { attempt, call, forProject, useQuery } from '../../lib/api';
import { PROVIDER_LABEL, plural } from '../../lib/format';
import { Icon } from '../../components/icons';
import { Select } from '../../components/Select';
import { Button, Empty, Segmented, useToast } from '../../components/ui';
import { FileDiff, STATUS_LABEL, type DiffLayout, type HunkPick } from '../../components/FileDiff';
import { CommitBox, type CommitBoxHandle } from './CommitBox';
import { Resolver } from './Resolver';
import { Confirm, Ref, WhoLine, WhoMarks, type Where } from './common';
import { EditButton } from '../../editor/EditButton';

/** Narrower than this, side by side is too cramped to read, and the diff shows unified. */
const SPLIT_MIN_WIDTH = 760;
const LAYOUT_KEY = 'wanigan.diff.layout';

function readLayout(): DiffLayout {
  try { return localStorage.getItem(LAYOUT_KEY) === 'split' ? 'split' : 'unified'; } catch { return 'unified'; }
}

/** Viewed marks, per viewer: each file's key and the fingerprint of the diff that was viewed. */
type Marks = Record<string, string>;
function readMarks(key: string): Marks {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown;
    return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, h]) => typeof h === 'string')) as Marks : {};
  } catch { return {}; }
}
function writeMarks(key: string, marks: Marks): void {
  try { localStorage.setItem(key, JSON.stringify(marks)); } catch { /* a per-viewer convenience only */ }
}

/** How each area's files are lettered in the list. */
const LETTER: Record<StatusEntry['status'], string> = { M: 'M', A: 'A', D: 'D', R: 'R', '?': 'U', U: 'C' };

interface Entry { key: string; area: DiffArea; file: StatusEntry }

/** A part of the working tree, in the order a commit is made: what needs you, what goes in, what does not yet. */
const AREAS: { area: DiffArea; title: string; of: (s: GitStatus) => StatusEntry[] }[] = [
  { area: 'conflicted', title: 'Conflicted', of: (s) => s.conflicted },
  { area: 'staged', title: 'Staged', of: (s) => s.staged },
  { area: 'changed', title: 'Changed', of: (s) => s.changed },
  { area: 'untracked', title: 'Untracked', of: (s) => s.untracked },
  { area: 'branch', title: 'Committed on this branch', of: (s) => s.committed },
];

const parts = (keys: ReadonlySet<string>): HunkPick => ({
  old: [...keys].filter((k) => k.startsWith('o')).map((k) => Number(k.slice(1))),
  new: [...keys].filter((k) => k.startsWith('n')).map((k) => Number(k.slice(1))),
});
const linesIn = (p: HunkPick): number => p.old.length + p.new.length;

type Discarding = { entry: Entry; pick: HunkPick | null; what: string };

export interface WorkingTreeHandle { focusCommit(): void }

export const WorkingTree = forwardRef<WorkingTreeHandle, {
  project: ProjectSummary; where: Where; status: GitStatus; scoped: CardSummary | null; onReload: () => void;
}>(function WorkingTree({ project, where, status, scoped, onReload }, handle) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const commitBox = useRef<CommitBoxHandle>(null);
  useImperativeHandle(handle, () => ({ focusCommit: () => commitBox.current?.focus() }), []);

  const entries = useMemo<Entry[]>(() => AREAS.flatMap(({ area, of }) => of(status).map((file) => ({ key: `${area}:${file.path}`, area, file }))), [status]);
  const entriesKey = entries.map((e) => e.key).join('\0');
  const totals = useMemo(() => {
    const local = entries.filter((e) => e.area !== 'branch');
    const paths = new Set(local.map((e) => e.file.path));
    return {
      files: paths.size,
      additions: local.reduce((n, e) => n + (e.file.additions ?? 0), 0),
      deletions: local.reduce((n, e) => n + (e.file.deletions ?? 0), 0),
      committed: status.committed.length,
    };
  }, [entries, status.committed]);

  // Review notes: left on lines here, sent to the agent as one message.
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  useEffect(() => { setNotes([]); }, [project.id, scoped?.id]);
  const live = useQuery('sessions.list', { projectId: project.id, live: true }, ['sessions'], forProject(project.id));
  const agents = (live.data ?? []).filter((s) => s.provider !== 'shell');
  const cardSession = scoped ? (scoped.holder && LIVE_STATES.has(scoped.holder.state) ? scoped.holder.sessionId : scoped.live?.sessionId ?? null) : null;
  const [chosen, setChosen] = useState('');
  const sendTo = scoped ? cardSession : (agents.find((s) => s.id === chosen) ?? agents[0])?.id ?? null;
  const sendToName = agents.find((s) => s.id === sendTo)?.title ?? (scoped ? `${scoped.key}’s session` : '');
  const sendNotes = async (): Promise<void> => {
    const text = reviewMessage(notes, scoped ? `${scoped.key}’s branch` : 'the uncommitted changes in this folder');
    if (sendTo) {
      const r = await attempt(() => call('sessions.queue', { id: sendTo, text }), fail);
      if (!r) return;
      toast(r.queued ? `Queued for ${sendToName}: it goes when the agent is next idle.` : `Sent to ${sendToName}.`);
    } else if (scoped) {
      const r = await attempt(() => call('cards.comment', { id: scoped.id, body: text }), fail);
      if (!r) return;
      toast(`Added to ${scoped.key}. The next session on it is told.`);
    } else return;
    setNotes([]);
  };

  // Unified or side by side, remembered; side by side only where there is room.
  const [preferred, setPreferred] = useState<DiffLayout>(readLayout);
  const choose = (layout: DiffLayout): void => {
    setPreferred(layout);
    try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* a per-viewer convenience only */ }
  };
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(() => window.innerWidth >= 1300);
  useEffect(() => {
    if (!scroller) return undefined;
    const watch = new ResizeObserver(([entry]) => setWide((entry?.contentRect.width ?? 0) >= SPLIT_MIN_WIDTH));
    watch.observe(scroller);
    return () => watch.disconnect();
  }, [scroller]);
  const layout: DiffLayout = preferred === 'split' && wide ? 'split' : 'unified';

  // Viewed marks hold while the diff they were given to is unchanged.
  const marksKey = `wanigan.viewed.${project.id}.${scoped?.id ?? 'folder'}`;
  const [marks, setMarks] = useState<Marks>(() => readMarks(marksKey));
  const [digests, setDigests] = useState<Record<string, string>>({});
  useEffect(() => setDigests({}), [marksKey]);
  useEffect(() => {
    const stored = readMarks(marksKey);
    const listed = new Set(entriesKey.split('\0'));
    const kept = Object.fromEntries(Object.entries(stored).filter(([k]) => listed.has(k)));
    if (Object.keys(kept).length !== Object.keys(stored).length) writeMarks(marksKey, kept);
    setMarks(kept);
  }, [marksKey, entriesKey]);
  // Ticked before its diff was read (a file far down the list): it is read now, and the mark
  // is given to that diff when it arrives. Until then it counts as viewed.
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => setPending(new Set()), [marksKey]);
  useEffect(() => {
    const ready = [...pending].filter((k) => digests[k]);
    if (!ready.length) return;
    const next = { ...marks };
    for (const k of ready) next[k] = digests[k] as string;
    writeMarks(marksKey, next);
    setMarks(next);
    setPending((p) => new Set([...p].filter((k) => !ready.includes(k))));
  }, [pending, digests, marks, marksKey]);
  const isViewed = (key: string): boolean => pending.has(key) || (marks[key] !== undefined && marks[key] === digests[key]);
  const viewedCount = entries.filter((e) => isViewed(e.key)).length;

  // Lines picked for staging, per file in its area; a pick is for the diff it was made on.
  const [picks, setPicks] = useState<Record<string, ReadonlySet<string>>>({});
  useEffect(() => setPicks({}), [marksKey, entriesKey]);
  const pickedIn = (key: string): ReadonlySet<string> => picks[key] ?? new Set();
  const setPicked = (key: string, keys: string[], on: boolean): void => setPicks((all) => {
    const next = new Set(all[key] ?? []);
    for (const k of keys) { if (on) next.add(k); else next.delete(k); }
    return { ...all, [key]: next };
  });
  const clearPick = (key: string): void => setPicks((all) => { const { [key]: _gone, ...rest } = all; return rest; });

  // Diffs are read as their files come near the screen, so a long list costs nothing until it is scrolled.
  const [near, setNear] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => setNear(new Set()), [marksKey]);
  useEffect(() => {
    if (!scroller) return undefined;
    const watch = new IntersectionObserver((seen) => {
      const keys = seen.flatMap((e) => (e.isIntersecting ? [(e.target as HTMLElement).dataset.key ?? ''] : []));
      if (keys.length) setNear((had) => (keys.every((k) => had.has(k)) ? had : new Set([...had, ...keys])));
    }, { root: scroller, rootMargin: '1200px 0px' });
    scroller.querySelectorAll('.diff-slot').forEach((el) => watch.observe(el));
    return () => watch.disconnect();
  }, [scroller, entriesKey]);

  // The file being read: the one at the top of the scroll, or the one J, K or the list went to.
  const [current, setCurrent] = useState(0);
  const pinned = useRef<number | null>(null);
  const slot = (i: number): HTMLElement | null => scroller?.querySelectorAll<HTMLElement>('.diff-slot')[i] ?? null;
  const go = (i: number, focus: boolean): void => {
    const to = Math.max(0, Math.min(entries.length - 1, i));
    const el = slot(to);
    if (!scroller || !el) return;
    pinned.current = to;
    setCurrent(to);
    scroller.scrollTop = el.offsetTop;
    if (focus) el.querySelector<HTMLElement>('.diff-head')?.focus({ preventScroll: true });
  };
  const frame = useRef(0);
  const onScroll = (): void => {
    if (frame.current || !scroller) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const slots = scroller.querySelectorAll<HTMLElement>('.diff-slot');
      const top = scroller.scrollTop;
      const held = pinned.current === null ? null : slots[pinned.current];
      if (held && held.offsetTop >= top - 4 && held.offsetTop < top + scroller.clientHeight) return;
      pinned.current = null;
      let lo = 0;
      let hi = slots.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if ((slots[mid]?.offsetTop ?? 0) <= top + 4) lo = mid; else hi = mid - 1;
      }
      setCurrent(lo);
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useEffect(() => { setCurrent(0); pinned.current = null; }, [marksKey]);

  const mark = (key: string, on: boolean): void => {
    const digest = digests[key];
    if (on && !digest) { setPending((p) => new Set([...p, key])); return; }
    if (!on && pending.has(key)) setPending((p) => new Set([...p].filter((k) => k !== key)));
    const next = { ...marks };
    if (on && digest) next[key] = digest; else delete next[key];
    writeMarks(marksKey, next);
    setMarks(next);
    const i = entries.findIndex((e) => e.key === key);
    requestAnimationFrame(() => {
      const el = slot(i);
      if (on && scroller && el && el.offsetTop < scroller.scrollTop) scroller.scrollTop = el.offsetTop;
    });
  };

  /* ── acts ───────────────────────────────────────────────────────────── */

  const act = async <T,>(work: () => Promise<T>, done?: (r: T) => void): Promise<void> => {
    const r = await attempt(work, fail);
    if (r !== undefined) { done?.(r); onReload(); }
  };
  const stageFiles = (list: StatusEntry[]): Promise<void> => act(() => call('git.stage', { ...where, paths: list.map((f) => f.path) }));
  const unstageFiles = (list: StatusEntry[]): Promise<void> => act(() => call('git.unstage', { ...where, paths: list.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])) }));
  const part = (e: Entry, action: 'stage' | 'unstage' | 'discard', pick: HunkPick): Promise<void> => {
    const digest = digests[e.key];
    if (!digest) { fail('The diff is still being read; try again in a moment.'); return Promise.resolve(); }
    return act(() => call('git.applyPart', { ...where, path: e.file.path, area: e.area, action, pick, digest }), (r) => {
      clearPick(e.key);
      const verb = action === 'stage' ? 'Staged' : action === 'unstage' ? 'Unstaged' : 'Discarded';
      toast(`${verb} ${plural(r.lines, 'line')} of ${e.file.path.split('/').pop()}.`);
    });
  };
  /** A conflicted file ticked off in the list: resolved as it is on disk (refused while it still holds markers). */
  const resolveAsIs = (f: StatusEntry): Promise<void> => act(() => call('git.resolve', { ...where, path: f.path, asIs: true }), () => toast(`Marked ${f.path} resolved.`));
  const toggle = (e: Entry): Promise<void> => {
    if (e.area === 'conflicted' && e.file.hunks) {
      toast(`${e.file.path} still has ${plural(e.file.hunks, 'conflict')}: resolve ${e.file.hunks === 1 ? 'it' : 'them'} first.`);
      return Promise.resolve();
    }
    return e.area === 'staged' ? unstageFiles([e.file]) : e.area === 'branch' ? Promise.resolve()
      : e.area === 'conflicted' ? resolveAsIs(e.file) : stageFiles([e.file]);
  };
  const [discarding, setDiscarding] = useState<Discarding | null>(null);
  const discard = async (d: Discarding): Promise<void> => {
    if (d.pick) await part(d.entry, 'discard', d.pick);
    else {
      const untracked = d.entry.area === 'untracked';
      await act(() => call('git.discard', { ...where, paths: untracked ? [] : [d.entry.file.path], untracked: untracked ? [d.entry.file.path] : [] }),
        () => toast(untracked ? `Deleted ${d.entry.file.path}.` : `Discarded the changes to ${d.entry.file.path}.`));
    }
    setDiscarding(null);
  };
  const busyHere = status.agents.length > 0;
  const agentsWhy = busyHere ? `${PROVIDER_LABEL[status.agents[0]!.provider]} is working here; discarding would change files under it` : undefined;

  // J and K between files, V to mark one viewed, S to stage or unstage it: never while typing, in a dialog, or after G.
  const keys = useRef({ go, mark, current, entries, isViewed, toggle });
  keys.current = { go, mark, current, entries, isViewed, toggle };
  useEffect(() => {
    let afterG = 0;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || target.matches('textarea, select, input:not([type="checkbox"]):not([type="radio"])')
        || target.closest('.xterm, [role="dialog"], [role="listbox"], .drawer'))) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (e.key === 'g') { afterG = Date.now(); return; }
      if (Date.now() - afterG < 1200) { afterG = 0; return; }
      const k = keys.current;
      const key = e.key.toLowerCase();
      const here = (): Entry | undefined => {
        const slotKey = target?.closest<HTMLElement>('.diff-slot')?.dataset.key ?? target?.closest<HTMLElement>('[data-key]')?.dataset.key;
        return k.entries.find((x) => x.key === slotKey) ?? k.entries[k.current];
      };
      if (key === 'j' || key === 'k') {
        e.preventDefault();
        k.go(k.current + (key === 'j' ? 1 : -1), true);
      } else if (key === 'v') {
        const entry = here();
        if (!entry) return;
        e.preventDefault();
        k.mark(entry.key, !k.isViewed(entry.key));
      } else if (key === 's') {
        const entry = here();
        if (!entry || entry.area === 'branch') return;
        e.preventDefault();
        void k.toggle(entry);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ── a file's and a hunk's buttons ──────────────────────────────────── */

  const fileActions = (e: Entry): ReactNode => {
    // A file that is there to change opens in the code editor, in this checkout.
    const edit = e.file.status !== 'D' && !e.file.binary && e.area !== 'conflicted'
      ? <EditButton target={{ projectId: project.id, cardId: where.cardId, path: e.file.path }} />
      : null;
    return <>{edit}{gitActions(e)}</>;
  };
  const gitActions = (e: Entry): ReactNode => {
    const picked = pickedIn(e.key);
    const p = parts(picked);
    if (picked.size) {
      return (
        <span className="pick-bar" role="group" aria-label={`${plural(picked.size, 'line')} picked in ${e.file.path}`}>
          <span className="pick-count">{plural(picked.size, 'line')} picked</span>
          {e.area === 'staged'
            ? <Button size="s" tone="primary" onClick={() => part(e, 'unstage', p)}>Unstage lines</Button>
            : <Button size="s" tone="primary" onClick={() => part(e, 'stage', p)}>Stage lines</Button>}
          {e.area === 'changed' ? (
            <Button size="s" tone="quiet" disabled={busyHere} title={agentsWhy}
              onClick={() => setDiscarding({ entry: e, pick: p, what: `${plural(linesIn(p), 'picked line')} of ${e.file.path}` })}>Discard lines</Button>
          ) : null}
          <Button size="s" tone="quiet" onClick={() => clearPick(e.key)}>Clear</Button>
        </span>
      );
    }
    switch (e.area) {
      case 'staged': return <Button size="s" icon="pull" onClick={() => unstageFiles([e.file])}>Unstage</Button>;
      case 'changed':
      case 'untracked':
        return (
          <>
            <Button size="s" icon="push" onClick={() => stageFiles([e.file])}>Stage</Button>
            <Button size="s" tone="quiet" icon="trash" disabled={busyHere} title={agentsWhy}
              aria-label={e.area === 'untracked' ? `Delete ${e.file.path}` : `Discard the changes to ${e.file.path}`}
              onClick={() => setDiscarding({ entry: e, pick: null, what: e.file.path })}>{e.area === 'untracked' ? 'Delete' : 'Discard'}</Button>
          </>
        );
      default: return null;
    }
  };
  const hunkActions = (e: Entry) => (h: HunkPick): ReactNode => {
    if (!linesIn(h)) return null;
    if (e.area === 'staged') return <button type="button" className="hunk-btn" onClick={(ev) => { if (ev.detail < 2) void part(e, 'unstage', h); }}>Unstage hunk</button>;
    if (e.area !== 'changed') return null;
    return (
      <>
        <button type="button" className="hunk-btn" onClick={(ev) => { if (ev.detail < 2) void part(e, 'stage', h); }}>Stage hunk</button>
        <button type="button" className="hunk-btn hunk-btn-quiet" disabled={busyHere} title={agentsWhy}
          onClick={() => setDiscarding({ entry: e, pick: h, what: `this hunk of ${e.file.path} (${plural(linesIn(h), 'changed line')})` })}>Discard hunk</button>
      </>
    );
  };
  const pickable = (e: Entry): boolean => (e.area === 'staged' || e.area === 'changed' || e.area === 'untracked') && !e.file.binary && e.file.status !== 'R';

  // The diffs themselves, built once per change to what they show (not per scroll).
  const diffs = useMemo(() => {
    const out: ReactNode[] = [];
    let lastArea: DiffArea | null = null;
    for (const e of entries) {
      if (e.area !== lastArea) {
        lastArea = e.area;
        const count = entries.filter((x) => x.area === e.area).length;
        out.push(
          <div key={`head-${e.area}`} className={`git-area-head git-area-${e.area}`}>
            {areaTitle(e.area, status)} <span className="faint">{count}</span>
          </div>,
        );
      }
      if (e.area === 'conflicted') {
        out.push(
          <div key={e.key} className="diff-slot" data-key={e.key} data-path={e.file.path}>
            <Resolver where={where} file={e.file} load={near.has(e.key)} busy={busyHere}
              busyWhy={busyHere ? `${PROVIDER_LABEL[status.agents[0]!.provider]} is working here; resolving would change files under it` : undefined} />
          </div>,
        );
        continue;
      }
      out.push(
        <div key={e.key} className="diff-slot" data-key={e.key} data-path={e.file.path}>
          <FileDiff projectId={project.id} cardId={where.cardId} file={e.file} layout={layout} area={e.area} from={e.file.from ?? null}
            load={near.has(e.key) || marks[e.key] !== undefined || pending.has(e.key)}
            viewed={isViewed(e.key)} onViewed={(on) => mark(e.key, on)}
            onDigest={(d) => setDigests((all) => (all[e.key] === d ? all : { ...all, [e.key]: d }))}
            notes={notes.filter((n) => n.file === e.file.path)}
            onAdd={(n) => setNotes((all) => [...all, n])}
            onRemove={(n) => setNotes((all) => all.filter((x) => x !== n))}
            actions={fileActions(e)}
            hunkActions={e.area === 'staged' || e.area === 'changed' ? hunkActions(e) : undefined}
            pick={pickable(e) ? { picked: pickedIn(e.key), onPick: (k, on) => setPicked(e.key, k, on) } : undefined}
            note={e.file.who.length || e.file.conflict ? (
              <>
                {e.file.conflict ? <span className="conflict-note">Conflict: {e.file.conflict}. Keep the lines you want, remove the markers, then mark it resolved.</span> : null}
                <WhoLine who={e.file.who} />
              </>
            ) : null} />
        </div>,
      );
    }
    return out;
  },
  // `mark`, `isViewed` and the actions read only what is listed here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [entries, project.id, where.cardId, layout, near, marks, pending, digests, notes, scroller, marksKey, picks, busyHere, status]);

  const cramped = preferred === 'split' && !wide;
  const groups = AREAS.map(({ area }) => ({ area, list: entries.filter((e) => e.area === area) })).filter((g) => g.list.length);

  return (
    <div className="changes git-changes">
      <div className="changes-side">
        <div className="changes-files" aria-label="Changed files">
          {groups.length ? groups.map(({ area, list }) => (
            <section key={area} className={`git-group git-group-${area}`} aria-labelledby={`git-group-${area}`}>
              <h3 className="git-group-head" id={`git-group-${area}`}>
                <span>{areaTitle(area, status)}</span>
                <span className="git-group-count">{list.length}</span>
                {area === 'staged' ? <button type="button" className="linkish small git-group-act" onClick={(ev) => { if (ev.detail < 2) void unstageFiles(list.map((e) => e.file)); }}>Unstage all</button> : null}
                {area === 'changed' || area === 'untracked' ? <button type="button" className="linkish small git-group-act" onClick={(ev) => { if (ev.detail < 2) void stageFiles(list.map((e) => e.file)); }}>Stage all</button> : null}
              </h3>
              <ul>
                {list.map((e) => {
                  const i = entries.indexOf(e);
                  const seen = isViewed(e.key);
                  const letter = LETTER[e.file.status];
                  return (
                    <li key={e.key} className={`git-file${i === current ? ' active' : ''}${seen ? ' viewed' : ''}`} data-key={e.key}>
                      {area === 'branch' ? <span className="git-file-box" aria-hidden="true" /> : (
                        <input type="checkbox" className="git-file-box" checked={area === 'staged'}
                          aria-label={area === 'staged' ? `Unstage ${e.file.path}` : area === 'conflicted' ? `Mark ${e.file.path} resolved` : `Stage ${e.file.path}`}
                          // A conflicted file with markers still in it is resolved below; ticked off, it would be refused.
                          disabled={area === 'conflicted' && !!e.file.hunks}
                          title={area === 'staged' ? 'Staged: untick to unstage'
                            : area === 'conflicted' ? (e.file.hunks ? `It still has ${plural(e.file.hunks, 'conflict')}: resolve ${e.file.hunks === 1 ? 'it' : 'them'} below, or in an editor, then tick it` : 'Tick when it is resolved')
                              : 'Tick to stage'}
                          onChange={() => void toggle(e)} />
                      )}
                      <button type="button" className="git-file-main" onClick={() => go(i, false)} aria-current={i === current ? 'true' : undefined}>
                        <span className={`fstatus fstatus-${letter}`} title={STATUS_LABEL[e.file.status]}>{letter}</span>
                        <span className="fpath" title={e.file.from ? `${e.file.from} → ${e.file.path}` : e.file.path}>
                          <span className="fname">{e.file.path.split('/').pop()}</span>
                          <span className="fdir">{e.file.path.includes('/') ? e.file.path.slice(0, e.file.path.lastIndexOf('/')) : ''}</span>
                        </span>
                        <span className="fcount">
                          {area === 'conflicted' ? <span className="fconflicts">{e.file.hunks ? plural(e.file.hunks, 'conflict') : e.file.conflict}</span>
                            : seen ? <span className="fviewed" title="Viewed"><Icon name="check" size={13} /><span className="visually-hidden">Viewed</span></span>
                            : e.file.binary ? <span className="faint">binary</span> : <>
                              {e.file.additions ? <span className="add">+{e.file.additions}</span> : null}
                              {e.file.deletions ? <span className="del">−{e.file.deletions}</span> : null}
                            </>}
                        </span>
                      </button>
                      <WhoMarks who={e.file.who} />
                    </li>
                  );
                })}
              </ul>
            </section>
          )) : (
            <div className="git-clean">
              <Icon name="check" size={18} />
              <p><strong>Nothing to commit.</strong> The working tree matches {status.branch ? <Ref name={status.branch} current /> : 'HEAD'}{status.head ? ` at ${status.head.slice(0, 7)}` : ''}.</p>
            </div>
          )}
          {status.omitted ? <p className="changes-more">and {plural(status.omitted, 'more untracked file')}, not listed. A folder git should ignore?</p> : null}
        </div>
        <CommitBox ref={commitBox} project={project} where={where} status={status} />
      </div>

      <div className="changes-main">
        <div className="toolbar changes-toolbar">
          <span className="changes-summary" title={scoped ? `Uncommitted in ${scoped.key}’s worktree, and what its commits changed` : 'Uncommitted changes in this folder, from any session or from you'}>
            <strong>{totals.files ? `${plural(totals.files, 'file')} changed` : 'Nothing uncommitted'}</strong>
            {totals.files ? <><span className="add">+{totals.additions}</span><span className="del">−{totals.deletions}</span></> : null}
            {totals.committed ? <span className="faint">{plural(totals.committed, 'file')} committed since {status.forkedFrom ?? 'its base'}</span> : null}
          </span>
          {entries.length ? (
            <span className={`changes-progress${viewedCount === entries.length ? ' all' : ''}`} role="status">
              {viewedCount === entries.length ? <Icon name="check" size={14} /> : null}
              {viewedCount === entries.length ? `All ${entries.length} viewed` : `${viewedCount} of ${entries.length} viewed`}
            </span>
          ) : null}
          <span className="toolbar-end">
            {cramped ? <span className="faint small">Unified until the window is wider</span> : null}
            <Segmented size="s" label="Diff layout" value={preferred} onChange={choose} options={[
              { value: 'unified', label: 'Unified', hint: 'One column: removed lines above the lines that replace them' },
              { value: 'split', label: 'Split', hint: cramped ? 'Side by side needs a wider window; the diff stays unified until there is room' : 'The old file on the left, the new on the right' },
            ]} />
            <Button size="s" tone="quiet" icon="refresh" onClick={onReload}>Refresh</Button>
          </span>
        </div>
        {notes.length ? (
          <div className="notes-tray" role="region" aria-label="Review notes">
            <strong>{plural(notes.length, 'review note')}</strong>
            <span className="faint small">{scoped ? `on ${scoped.key}’s branch` : 'on this folder'}</span>
            <span className="notes-tray-end">
              {!scoped && agents.length > 1 ? (
                <Select label="Send to" size="s" value={sendTo ?? ''} onChange={setChosen}
                  options={agents.map((s) => ({ value: s.id, label: s.title, detail: `${PROVIDER_LABEL[s.provider]}${s.cardKey ? ` · ${s.cardKey}` : ''}` }))} />
              ) : null}
              <Button size="s" tone="primary" icon="send" disabled={!sendTo && !scoped} onClick={() => sendNotes()}
                title={sendTo ? 'One message, queued until the agent is idle' : scoped ? 'No session is running on it: the notes go on the card' : 'Start a session to send these'}>
                {sendTo ? `Send to ${sendToName}` : scoped ? `Add to ${scoped.key}` : 'No agent running'}
              </Button>
              <Button size="s" tone="quiet" onClick={() => setNotes([])}>Clear</Button>
            </span>
          </div>
        ) : null}
        <div className="changes-diff" ref={setScroller} onScroll={onScroll}>
          {entries.length ? diffs : (
            <Empty title="Nothing to review">
              {status.ahead ? `${plural(status.ahead, 'commit')} on ${status.branch} ${status.ahead === 1 ? 'is' : 'are'} not pushed yet.` : 'Agents’ edits and yours show here as they happen.'}
            </Empty>
          )}
        </div>
      </div>

      {discarding ? (
        <Confirm danger title={discarding.entry.area === 'untracked' && !discarding.pick ? `Delete ${discarding.what}?` : `Discard ${discarding.what}?`}
          act={discarding.entry.area === 'untracked' && !discarding.pick ? 'Delete the file' : 'Discard'} onClose={() => setDiscarding(null)} onAct={() => discard(discarding)}>
          {discarding.entry.area === 'untracked' && !discarding.pick ? (
            <p>It is untracked: git never saved it, so once deleted it is gone for good.</p>
          ) : (
            <p>
              {discarding.pick ? 'Those lines go' : 'The file goes'} back to how {status.staged.some((f) => f.path === discarding.entry.file.path) ? 'it is staged' : 'the last commit has it'}.
              {' '}{discarding.pick ? `${plural(discarding.pick.new.length, 'added line')} and ${plural(discarding.pick.old.length, 'removed line')} are` : `Its ${plural(discarding.entry.file.additions ?? 0, 'added line')} and ${plural(discarding.entry.file.deletions ?? 0, 'removed line')} are`} lost,
              and nothing can bring them back: git never saved them.
            </p>
          )}
          {discarding.entry.file.who.length ? <p className="faint">An agent made {discarding.pick ? 'some of these changes' : 'changes to this file'}; it will not be told.</p> : null}
        </Confirm>
      ) : null}
    </div>
  );
});

function areaTitle(area: DiffArea, status: GitStatus): string {
  if (area === 'branch') return status.cardKey ? `Committed since ${status.forkedFrom ?? 'its base'}` : 'Committed on this branch';
  return AREAS.find((a) => a.area === area)?.title ?? area;
}
