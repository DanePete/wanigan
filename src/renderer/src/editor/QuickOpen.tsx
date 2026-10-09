// ⌘P: any file in the open project, by typing a few letters of its name or
// path (`hero tw`, `checkout/css`), and `:42` for a line. Git's own ignore
// rules choose what is listed; installed code (vendor, node_modules) only when
// asked. The files open in the code editor, as a jump Back returns from.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { fuzzyFind, parseQuery, type FuzzyHit } from '@shared/fuzzy';
import type { FileList } from '@shared/files';
import type { ProjectSummary } from '@shared/model';
import { bridge, call, useQuery } from '../lib/api';
import { useCoversLive } from '../lib/live';
import { Icon } from '../components/icons';
import { keyLabel } from '@shared/shortcuts';
import { navOf, openInEditor, useEditor } from './store';

/** A folder's list is kept a moment, so ⌘P twice in a row does not walk it twice. */
const lists = new Map<string, { at: number; list: Promise<FileList> }>();
const KEEP_MS = 15_000;

function listOf(projectId: string, cardId: string | null, installed: boolean): Promise<FileList> {
  const key = `${projectId}|${cardId ?? ''}|${installed ? 1 : 0}`;
  const hit = lists.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.list;
  const list = call('files.list', { projectId, cardId, ...(installed ? { installed: true } : {}) });
  lists.set(key, { at: Date.now(), list });
  list.catch(() => lists.delete(key));
  return list;
}

export function QuickOpen({ project, cardKey, onClose }: { project: ProjectSummary; cardKey: string | null; onClose: () => void }) {
  useCoversLive();
  const mac = bridge().platform === 'darwin';
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const editor = useEditor();
  const cards = useQuery('cards.list', cardKey ? { projectId: project.id } : null, ['board']);
  const card = cardKey ? cards.data?.find((c) => c.key === cardKey && c.worktree) ?? null : null;
  const cardId = card?.id ?? null;
  const waiting = !!cardKey && !cards.data;
  const [query, setQuery] = useState('');
  const [installed, setInstalled] = useState(false);
  const [list, setList] = useState<FileList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    if (waiting) return undefined;
    let current = true;
    setError(null);
    listOf(project.id, cardId, installed).then((l) => { if (current) setList(l); }, (e: Error) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [project.id, cardId, installed, waiting]);

  const { line } = parseQuery(query);
  const recent = useMemo(() => {
    // Nothing typed: the files open now and the places visited lately, newest first.
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (path: string): void => { if (!seen.has(path)) { seen.add(path); out.push(path); } };
    const nav = navOf(project.id);
    for (let i = nav.spots.length - 1; i >= 0; i--) {
      const s = nav.spots[i];
      if (s && s.key.startsWith(`${project.id}|${cardId ?? ''}|`)) add(s.path);
    }
    for (const t of editor.tabs) if (t.projectId === project.id && (t.cardId ?? null) === cardId) add(t.path);
    return out;
  }, [editor.tabs, project.id, cardId]);
  const hits: (FuzzyHit & { recent?: boolean })[] = useMemo(() => {
    if (!list) return [];
    if (!query.trim() || /^:\d*$/.test(query.trim())) {
      const known = new Set(list.files);
      const top = recent.filter((p) => known.has(p)).map((path) => ({ path, score: 0, positions: [], recent: true }));
      return [...top, ...list.files.filter((f) => !recent.includes(f)).slice(0, 60).map((path) => ({ path, score: 0, positions: [] }))];
    }
    return fuzzyFind(query, list.files, 80);
  }, [list, query, recent]);

  useEffect(() => { setActive(0); }, [query, list]);
  useEffect(() => { document.getElementById(`qo-${uid}-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, uid]);

  // Enter typed before the list arrived opens the best match once it does.
  const pending = useRef(false);
  useEffect(() => { if (pending.current && list) { pending.current = false; choose(hits[0]); } }); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (hit: FuzzyHit | undefined): void => {
    if (!list) { pending.current = true; return; }
    if (!hit) return;
    onClose();
    openInEditor({ projectId: project.id, cardId, path: hit.path, line });
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(hits.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(hits[active]); }
    else if (e.key === 'Tab' && !(e.target as HTMLElement).matches('input[type=checkbox]')) {
      // Two stops: the search, and the box that adds installed code.
      e.preventDefault();
      (e.shiftKey || document.activeElement !== input.current ? input.current : document.getElementById(`qo-${uid}-installed`))?.focus();
    }
  };

  const where = card ? `${card.key}’s worktree` : project.name;
  const count = list ? `${list.files.length.toLocaleString()} file${list.files.length === 1 ? '' : 's'}${list.cut ? ', not all of them' : ''}` : '';
  return createPortal(
    <div className="scrim scrim-top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette quick-open" role="dialog" aria-modal="true" aria-label={`Open a file in ${where}`} onKeyDown={onKey}>
        <div className="palette-input">
          <Icon name="file" />
          <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Open a file in ${where} (name, path, or name:line)`}
            aria-label="File to open" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={`qo-${uid}-list`}
            aria-activedescendant={hits[active] ? `qo-${uid}-${active}` : undefined} spellCheck={false} autoComplete="off" />
        </div>
        <div className="palette-results" id={`qo-${uid}-list`} role="listbox" aria-label="Files" ref={results}>
          {error ? <div className="palette-empty error-text" role="presentation">{error}</div> : null}
          {!error && !list ? <div className="palette-empty" role="presentation">Listing {where}’s files…</div> : null}
          {list && !hits.length ? <div className="palette-empty" role="presentation">No file matches “{query.trim()}”.{installed ? '' : ' Installed code (vendor, node_modules) is not searched unless you ask.'}</div> : null}
          {hits.map((hit, i) => {
            const at = hit.path.lastIndexOf('/') + 1;
            return (
              <div key={hit.path} id={`qo-${uid}-${i}`} role="option" aria-selected={i === active}
                className={`palette-option quick-open-option${i === active ? ' active' : ''}`}
                onMouseMove={() => { if (i !== active) setActive(i); }} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(hit)}>
                <Icon name={hit.recent ? 'clock' : 'file'} size={15} />
                <span className="palette-label"><Marked text={hit.path.slice(at)} positions={hit.positions} offset={at} /></span>
                <span className="palette-detail quick-open-dir"><Marked text={hit.path.slice(0, Math.max(0, at - 1))} positions={hit.positions} offset={0} /></span>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <label className="quick-open-installed">
            <input id={`qo-${uid}-installed`} type="checkbox" checked={installed} onChange={(e) => setInstalled(e.target.checked)} />
            Include vendor and node_modules
          </label>
          <span aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span aria-hidden="true"><kbd>{keyLabel('Enter', mac)}</kbd> open</span>
          <span className="palette-foot-end" aria-live="polite">{count}{list?.source === 'git' ? ' · as git sees them' : ''}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A path with the letters that matched in bold. */
function Marked({ text, positions, offset }: { text: string; positions: number[]; offset: number }) {
  if (!positions.length) return <>{text}</>;
  const set = new Set(positions.map((p) => p - offset));
  const out: ReactNode[] = [];
  let run = '';
  let bold = false;
  const flush = (key: number): void => {
    if (!run) return;
    out.push(bold ? <b key={key}>{run}</b> : run);
    run = '';
  };
  // By UTF-16 index, as the matcher counts.
  text.split('').forEach((ch, i) => {
    const on = set.has(i);
    if (on !== bold) { flush(i); bold = on; }
    run += ch;
  });
  flush(text.length);
  return <>{out}</>;
}
