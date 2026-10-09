// A chosen part of the live page: where it sits, what made it and whose code
// that is, where to change it in the site's own admin, and changing it by hand.
// A hand edit is tried in the page first. Words save straight to the owner's
// own template only when they appear there exactly once; anything else
// becomes a note for an agent, with the exact change attached. Styles are
// never written by hand: what was tried goes to the agent as intent.
//
// With the site helper's trace, it also says what the trace knows of the part
// (PartTrace.tsx): the hooks that shaped it, its data, every way to edit it,
// its cache, cost, revisions and access; and it moves it (Arrange.tsx).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LiveComponent, LiveFound, LivePick, LivePlatform, LiveRegion, LiveSite } from '@shared/live';
import { partFor, type LiveTraceAnswer, type PartIndex } from '@shared/live-lens';
import type { EditTarget, LiveTrace } from '@shared/live-trace';
import { editPath, entityOf, nameOf, originOf, overrideDir, overrides, type LiveOrigin } from '@shared/live-names';
import { diagnose, troubleText } from '@shared/live-site';
import { ancestors, kindKey } from '@shared/live-tree';
import type { ProjectSummary } from '@shared/model';
import { attempt, bridge, call } from '../../lib/api';
import { liveBridge } from '../../lib/live';
import { Icon } from '../icons';
import { Button, IconButton, useToast } from '../ui';
import { KIND_ICON } from './Layers';
import { NoteComposer, draftFor } from './Notes';
import { MoveSection, type useArrange } from './Arrange';
import { TraceAccess, TraceCache, TraceCost, TraceData, TraceEdits, TraceHistory, TraceMadeBy } from './PartTrace';
import { TraceNote } from './TraceNote';
import type { StyleChange } from './note-store';

export interface Selection { region: LiveRegion | null; pick: LivePick | null }

const ORIGIN: Record<LiveOrigin, string> = { yours: 'Your code', contrib: 'Contributed', core: 'Drupal core' };

const near = (root: string, abs: string): string => (abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs);

export function Inspector({ project, platform, selection, regions, components, docroot, theme, page, prefer, helper, readOnly = false, onSelect, onClose, onSaved,
  site, answer, trace, parts, arrange, onEdit }: {
  project: ProjectSummary;
  platform: LivePlatform | null;
  selection: Selection;
  regions: LiveRegion[];
  components: Map<string, LiveComponent>;
  docroot: string | null;
  /** The owner's theme folder as the page shows it (`themes/custom/acme/`), for overrides. */
  theme: string | null;
  /** The page shown, for links into the site's admin. */
  page: string | null;
  prefer: string | null;
  /** The site has Wanigan's helper: fields can be saved and pieces shown alone. */
  helper: boolean;
  /** A hosted environment: point at parts and tell an agent, but nothing here changes the site. */
  readOnly?: boolean;
  onSelect: (region: LiveRegion) => void;
  onClose: () => void;
  /** Words were saved: the page should show them. */
  onSaved: () => void;
  site: LiveSite;
  /** The page's trace from the site helper, or why there is none. */
  answer: LiveTraceAnswer | null;
  trace: LiveTrace | null;
  parts: PartIndex;
  arrange: ReturnType<typeof useArrange>;
  /** Open an edit target in a sheet beside the part. */
  onEdit: (target: EditTarget, region: LiveRegion | null) => void;
}) {
  const live = liveBridge();
  const { region, pick } = selection;
  const chain = useMemo(() => {
    if (!region) return [];
    const now = regions.find((r) => r.index === region.index) ?? region;
    return [now, ...ancestors(regions, now.index)];
  }, [region, regions]);
  const crumbs = chain.slice(1).filter((r) => !nameOf(r).wrapper).reverse();
  /** What a region is called, by the helper's label when the trace has one. */
  const called = (r: LiveRegion) => {
    const p = parts.byRegion.get(r.index);
    return nameOf(r, r.component ? components.get(r.component)?.name ?? null : null, p ? { label: p.label, kind: p.kind } : null);
  };
  const name = region ? called(region) : null;
  const [words, setWords] = useState<{ before: string; after: string } | null>(null);
  /** The template the old words were found in, for the note that takes them to an agent. */
  const [wordsFile, setWordsFile] = useState<string | null>(null);
  const [style, setStyle] = useState<StyleChange[]>([]);
  const [styling, setStyling] = useState(false);
  const key = `${region?.index ?? ''}:${pick?.selector ?? ''}`;
  useEffect(() => { setWords(null); setWordsFile(null); setStyle([]); setStyling(false); }, [key]);

  const go = (path: string): void => {
    if (!page || !live) return;
    void live.go(new URL(path, page).toString());
  };
  // Where to change the content in Drupal: the part's own admin page, or the nearest part's that has one.
  const admin = chain.map((r) => ({ r, path: editPath(r) })).find((x) => x.path);
  const content = chain.map((r) => ({ r, e: entityOf(r) })).find((x) => x.e?.id);
  // Already alone (the helper's own page): nothing more to take it out of.
  const isAlone = (() => { try { return new URL(page ?? '').pathname.startsWith('/_wanigan/piece/'); } catch { return false; } })();
  const alone = helper && !isAlone ? alonePaths(chain).filter((a) => platform !== 'wordpress' || a.path.startsWith('/_wanigan/piece/entity/post/')) : [];
  // What the trace says, for this part or the nearest one around it.
  const traced = partFor(chain, parts);
  const edit = (t: EditTarget): void => onEdit(t, traced?.region ?? region);
  const now = region ? regions.find((r) => r.index === region.index) ?? region : null;

  return (
    <div className="live-inspector"
      // A move under way takes Alt+arrows, Enter and Escape first (Arrange.tsx).
      onKeyDownCapture={(e) => { arrange.keys(e, now); }}
      onKeyDown={(e) => { if (!e.defaultPrevented && e.key === 'Escape' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLSelectElement)) onClose(); }}>
      <div className="live-side-head">
        <div className="live-inspector-title">
          {name ? <Icon name={KIND_ICON[name.icon]} size={16} /> : <Icon name="pick" size={16} />}
          <div>
            <h2 className="live-side-title" tabIndex={-1}>{name?.title ?? (pick ? `<${pick.tag}>` : 'Part')}</h2>
            {name?.kind ? <p className="faint small">{name.kind}</p> : null}
          </div>
        </div>
        <IconButton icon="close" label="Back to the layers" onClick={onClose} />
      </div>

      {crumbs.length ? (
        <nav className="live-crumbs small" aria-label="Where it sits">
          {crumbs.map((r) => (
            <button key={r.index} type="button" className="live-crumb" onClick={() => onSelect(r)}>{called(r).title}</button>
          ))}
          <span className="live-crumb here" aria-current="true">{name?.title ?? pick?.tag}</span>
        </nav>
      ) : null}

      {pick ? (
        <section className="live-section" aria-label="What you picked">
          <p className="small"><span className="mono">&lt;{pick.tag}&gt;</span>{pick.text ? <> “{pick.text.slice(0, 160)}”</> : null}</p>
          <p className="mono small faint live-selector" title={pick.selector}>{pick.selector}</p>
        </section>
      ) : null}

      {region ? <Alike region={region} regions={regions} /> : null}

      {region ? (
        <MadeBy region={region} component={region.component ? components.get(region.component) ?? null : null} docroot={docroot} project={project} theme={theme}>
          {traced ? (
            <>
              {traced.inherited ? <p className="faint small">From the trace of {traced.part.label}, around it:</p> : null}
              <TraceMadeBy part={traced.part} edits={parts.edits} onEdit={edit} />
            </>
          ) : answer?.state === 'ok' ? null : <TraceNote compact answer={answer} site={site} project={project} />}
        </MadeBy>
      ) : (
        <p className="faint small">Nothing around it says what made it. Notes still tell an agent where it is on the page.</p>
      )}

      {/* A hosted environment is read-only: nothing here edits or moves it. */}
      {readOnly ? null : traced && trace ? (
        <div className="live-trace-sections">
          <TraceEdits part={traced.part} edits={parts.edits} onEdit={edit} />
          {now ? <MoveSection arrange={arrange} region={now} trace={trace} /> : null}
          <TraceData part={traced.part} edits={parts.edits} onEdit={edit} />
          <TraceCache part={traced.part} />
          <TraceCost part={traced.part} trace={trace} />
          <TraceHistory part={traced.part} />
          <TraceAccess part={traced.part} user={trace.user} />
        </div>
      ) : now ? <div className="live-trace-sections"><MoveSection arrange={arrange} region={now} trace={trace} /></div> : null}

      {!readOnly && (admin || content || alone.length) ? (
        <section className="live-section" aria-label="Change it in the site">
          <h3 className="live-section-title">In the site</h3>
          {content?.e ? <p className="small">Shows {content.e.type.replace(/_/g, ' ')} {content.e.id}{content.e.bundle ? ` (${content.e.bundle.replace(/_/g, ' ')})` : ''}.</p> : null}
          <div className="live-actions">
            {admin ? (
              <Button size="s" icon="pencil" onClick={() => go(admin.path as string)}>{adminLabel(admin.r)}</Button>
            ) : null}
            {alone.map((a) => <Button key={a.path} size="s" tone="quiet" icon="eye" onClick={() => go(a.path)}>{a.label}</Button>)}
          </div>
          <p className="faint small">
            {admin ? 'Opens it here, in the live view. Content you change there is the site’s own, saved by Drupal.' : ''}
            {alone.length ? `${admin ? ' ' : ''}Alone, it shows in your theme with nothing around it; Back returns to the page.` : ''}
          </p>
        </section>
      ) : null}

      {pick && live && !readOnly ? (
        <section className="live-section" aria-label="Change it by hand">
          <h3 className="live-section-title">By hand</h3>
          <div className="live-actions">
            <Button size="s" icon="pencil" disabled={!pick.own}
              title={pick.own ? 'Retype the words on the page: Enter keeps them, Escape puts them back' : 'Pick the words themselves (an element with only text in it) to retype them'}
              onClick={async () => { const change = await live.editText(); if (change) setWords(change); }}>
              Edit the words
            </Button>
            <Button size="s" icon="brush" tone={styling ? 'primary' : 'plain'} aria-pressed={styling} onClick={() => setStyling((v) => !v)}>Adjust the style</Button>
          </div>
          {words ? <WordsChange words={words} pick={pick} project={project} helper={helper} onFound={setWordsFile}
            onSaved={() => { setWords(null); onSaved(); }} onUndo={() => { setWords(null); void live.reload(); }} /> : null}
          {styling ? <StylePanel pick={pick} onChange={setStyle} /> : null}
        </section>
      ) : null}

      <section className="live-section" aria-label="Tell an agent">
        <h3 className="live-section-title">Tell an agent</h3>
        <NoteComposer key={key} project={project} components={components} prefer={prefer}
          draft={{ ...draftFor(page ?? pick?.url ?? '', { regions: pick ? pick.regions : chain, pick }), words: words ? { ...words, file: wordsFile } : null, style }} />
      </section>
    </div>
  );
}

/** The helper's pages that show a part of this chain alone: a piece of content, a component, a block, sample content. */
function alonePaths(chain: readonly LiveRegion[]): { path: string; label: string }[] {
  const out: { path: string; label: string }[] = [];
  const at = chain[0];
  if (at?.component) out.push({ path: `/_wanigan/piece/component/${encodeURIComponent(at.component)}`, label: 'Show it alone, with its examples' });
  const entity = chain.map((r) => entityOf(r)).find((e) => e && (e.id || e.bundle)) ?? null;
  const mode = entity?.viewMode ? `?view_mode=${encodeURIComponent(entity.viewMode)}` : '';
  if (entity?.id && entity.id !== 'new') out.push({ path: `/_wanigan/piece/entity/${encodeURIComponent(entity.type)}/${encodeURIComponent(entity.id)}${mode}`, label: `Show ${entity.type.replace(/_/g, ' ')} ${entity.id} alone` });
  if (entity?.bundle) out.push({ path: `/_wanigan/piece/sample/${encodeURIComponent(entity.type)}/${encodeURIComponent(entity.bundle)}${mode}`, label: `A ${entity.bundle.replace(/_/g, ' ')} with sample content` });
  const block = chain.find((r) => r.block?.includes('@'))?.block?.split('@')[1];
  if (block && /^[a-z0-9_]+$/.test(block) && !at?.component) out.push({ path: `/_wanigan/piece/block/${block}`, label: 'Show the block alone' });
  return out.slice(0, 3);
}

/** How many parts on the page are the same kind as this one (the same component, the same template): outlined together on request. */
function Alike({ region, regions }: { region: LiveRegion; regions: LiveRegion[] }) {
  const live = liveBridge();
  const key = kindKey(region);
  const like = regions.filter((r) => kindKey(r) === key);
  if (like.length < 2 || !live) return null;
  return (
    <p className="small live-alike">
      <span>One of {like.length} like it on this page: an edit to what made it changes them all.</span>
      <Button size="s" tone="quiet" icon="layers" onClick={() => void live.outline(like.map((r) => r.index), null, 'hover')}>Outline all {like.length}</Button>
    </p>
  );
}

function adminLabel(r: LiveRegion): string {
  const root = r.hook?.split('__')[0] ?? '';
  if (entityOf(r)?.id) return `Edit ${entityOf(r)?.type.replace(/_/g, ' ')} ${entityOf(r)?.id}`;
  if (r.view) return 'Edit the view';
  if (r.block || root === 'block') return 'Block settings';
  if (root === 'region') return 'Block layout';
  if (root === 'menu') return 'Edit the menu';
  return 'Open in the admin';
}

/** What made a part: its component's folder and files, or its template and whose code it is, and how to change it here only. */
function MadeBy({ region, component, docroot, project, theme, children }: {
  region: LiveRegion; component: LiveComponent | null; docroot: string | null; project: ProjectSummary; theme: string | null;
  /** What the site helper's trace adds. */
  children?: ReactNode;
}) {
  const origin = originOf(region.file);
  const template = region.file && docroot ? `${docroot}/${region.file}` : null;
  const options = overrides(region);
  return (
    <section className="live-section" aria-label="What made it">
      <h3 className="live-section-title">Made by</h3>
      {component ? (
        <div className="live-made">
          <span className="mono small">{component.id}</span>
          {component.description ? <span className="small">{component.description}</span> : null}
          <span className="mono small faint" title={component.dir}>{near(project.path, component.dir)}/</span>
          <span className="live-files">{component.files.map((f) => <span key={f} className="lib-tag mono">{f}</span>)}</span>
          {component.props.length ? (
            <ul className="live-props small" aria-label="Its props">
              {component.props.map((p) => (
                <li key={p.name} className="live-prop">
                  <span className="mono">{p.name}{p.required ? <span className="faint" title="Required"> *</span> : null}</span>
                  <span className="lib-tag mono">{p.type}</span>
                  {p.title ? <span className="faint">{p.title}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="live-actions"><Button size="s" tone="quiet" icon="folder" onClick={() => void bridge().openPath(component.dir)}>Show in Finder</Button></div>
        </div>
      ) : region.component ? <span className="mono small">{region.component}</span> : null}
      {region.file ? (
        <div className="live-made">
          <span className="live-made-file">
            <span className="mono small" title={region.file}>{region.file}</span>
            {origin ? <span className={`live-origin ${origin}`}>{ORIGIN[origin]}</span> : null}
          </span>
          {region.hook ? <span className="faint small">Theme hook {region.hook}</span> : null}
          {template ? <div className="live-actions"><Button size="s" tone="quiet" icon="file" onClick={() => void bridge().openPath(template)}>Show in Finder</Button></div> : null}
        </div>
      ) : null}
      {region.file && origin && origin !== 'yours' && options.length && theme ? (
        <div className="live-override">
          <p className="small">
            This template is {origin === 'core' ? 'Drupal core’s' : 'a contributed project’s'}: changing it there would be lost on the next update.
            To change it here, copy it into your theme under a more specific name:
          </p>
          <ul className="live-override-list">
            {options.slice(0, 3).map((f, i) => (
              <li key={f}><span className="mono small">{overrideDir(region, theme)}{f}</span>{i === 0 ? <span className="faint small"> (only parts exactly like this one)</span> : null}</li>
            ))}
          </ul>
          <p className="faint small">Then clear Drupal’s cache. A note to an agent below says the same.</p>
        </div>
      ) : null}
      {!region.file && !component && !region.component && !children ? (
        <p className="faint small">{[region.entity && `Content ${region.entity}`, region.block && `Block ${region.block}`, region.view && `View ${region.view}`, region.element && `Elementor ${region.element}`].filter(Boolean).join(' · ') || 'The page does not say which file made it.'}</p>
      ) : null}
      {children}
    </section>
  );
}

/**
 * New words, tried on the page: where they can be saved (the owner's own
 * template, when the old words appear there exactly once), and why not when
 * they cannot.
 */
function WordsChange({ words, pick, project, helper, onFound, onSaved, onUndo }: {
  words: { before: string; after: string }; pick: LivePick; project: ProjectSummary; helper: boolean;
  /** Where the old words are written, when a template writes them. */
  onFound: (file: string | null) => void;
  onSaved: () => void; onUndo: () => void;
}) {
  const toast = useToast();
  // A field the helper marked, nearest first: plain text saves through Drupal itself.
  const field = helper ? pick.regions.find((r) => r.field)?.field ?? null : null;
  const [kind, fieldName] = field ? [field.split(':')[3] ?? '', field.split(':')[2] ?? ''] : ['', ''];
  const plain = kind === 'string' || kind === 'string_long';
  const [found, setFound] = useState<{ file: string; at: LiveFound } | null | 'looking'>('looking');
  useEffect(() => {
    let current = true;
    void (async () => {
      // The innermost template that writes these words, looking outward a few templates.
      const files = pick.regions.map((r) => r.file).filter((f): f is string => !!f).slice(0, 6);
      for (const file of files) {
        const at = await call('live.findText', { projectId: project.id, file, text: words.before }).catch(() => null);
        if (at && at.count > 0) { if (current) { setFound({ file, at }); onFound(file); } return; }
      }
      if (current) { setFound(null); onFound(null); }
    })();
    return () => { current = false; };
  }, [words.before, pick, project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const content = pick.regions.map((r) => entityOf(r)).find((e) => e?.id) ?? null;

  const saveField = async (): Promise<void> => {
    if (!field) return;
    const result = await liveBridge()?.helperSave(field, words.before, words.after);
    if (result?.failure) {
      // The site did not answer: say why as the view would (is it running? which certificate?), not Chromium's code alone.
      const failure = result.failure;
      const status = await call('live.siteStatus', { projectId: project.id }).catch(() => null);
      const why = status ? diagnose({ host: new URL(failure.url).hostname, status, failure, now: Date.now() }) : null;
      toast(why ? `Not saved. ${troubleText(why)}` : result.error ?? 'The site did not save it.', 'error');
      return;
    }
    if (!result?.ok) { toast(result?.error ?? 'The site did not save it.', 'error'); return; }
    toast(`Saved to ${fieldName} on ${result.label ?? 'the content'}, as a new revision.`);
    onSaved();
  };
  const save = async (): Promise<void> => {
    if (!found || found === 'looking') return;
    const done = await attempt(() => call('live.saveText', { projectId: project.id, file: found.file, before: words.before, after: words.after }), (m) => toast(m, 'error'));
    if (!done) return;
    toast(`Saved to ${found.file.split('/').pop()} (line ${done.line}). Put it back from the edits list if you change your mind.`);
    onSaved();
  };

  return (
    <div className="live-change">
      <p className="small"><span className="live-change-before">“{words.before}”</span> → <span className="live-change-after">“{words.after}”</span></p>
      {field && plain ? (
        <>
          <p className="small">These words are the <span className="mono">{fieldName}</span> field of {field.split(':')[0]?.replace(/_/g, ' ')} {field.split(':')[1]}.</p>
          <div className="live-actions">
            <Button size="s" tone="primary" icon="check" onClick={saveField}>Save to the field</Button>
            <Button size="s" tone="quiet" icon="undo" onClick={onUndo}>Put the old words back</Button>
          </div>
          <p className="faint small">Saved by Drupal as the user you are logged in as in the live view, as a new revision where the content keeps them.</p>
        </>
      ) : found === 'looking' ? <p className="faint small">Looking for where those words are written…</p>
        : found && !found.at.refused ? (
          <>
            <p className="small">Written once in your template <span className="mono">{found.file}</span>, line {found.at.line}.</p>
            <div className="live-actions">
              <Button size="s" tone="primary" icon="check" onClick={save}>Save to the template</Button>
              <Button size="s" tone="quiet" icon="undo" onClick={onUndo}>Put the old words back</Button>
            </div>
          </>
        ) : (
          <>
            <p className="small">
              {field && !plain ? `These words are part of the ${fieldName} field, which holds ${/^text/.test(kind) ? `formatted text (${kind})` : `a ${kind.replace(/_/g, ' ')} value, not plain words`}: typed on the page, its structure or formatting could be lost. Change it in Drupal, or let an agent do it.` : found?.at.refused ?? (content
                ? `No template writes those words: they are content, stored with ${content.type.replace(/_/g, ' ')} ${content.id}. Change them in Drupal (Edit ${content.type.replace(/_/g, ' ')} ${content.id} above), or let an agent do it.`
                : 'No template on this page writes those words: they come from content, configuration or a variable.')}
            </p>
            <p className="faint small">A note below takes the new words with it, and says where they were found.</p>
            <div className="live-actions"><Button size="s" tone="quiet" icon="undo" onClick={onUndo}>Put the old words back</Button></div>
          </>
        )}
    </div>
  );
}

/* ── trying a style ────────────────────────────────────────────────────── */

type Control =
  | { prop: string; label: string; kind: 'color' }
  | { prop: string; label: string; kind: 'length'; step?: number }
  | { prop: string; label: string; kind: 'choice'; options: string[] };

const CONTROLS: Control[] = [
  { prop: 'color', label: 'Text colour', kind: 'color' },
  { prop: 'background-color', label: 'Background', kind: 'color' },
  { prop: 'font-size', label: 'Text size', kind: 'length' },
  { prop: 'font-weight', label: 'Weight', kind: 'choice', options: ['300', '400', '500', '600', '700', '800'] },
  { prop: 'line-height', label: 'Line height', kind: 'length' },
  { prop: 'letter-spacing', label: 'Letter spacing', kind: 'length', step: 0.5 },
  { prop: 'text-align', label: 'Align', kind: 'choice', options: ['left', 'center', 'right', 'justify', 'start'] },
  { prop: 'padding-top', label: 'Padding above', kind: 'length' },
  { prop: 'padding-bottom', label: 'Padding below', kind: 'length' },
  { prop: 'padding-left', label: 'Padding left', kind: 'length' },
  { prop: 'padding-right', label: 'Padding right', kind: 'length' },
  { prop: 'margin-top', label: 'Space above', kind: 'length' },
  { prop: 'margin-bottom', label: 'Space below', kind: 'length' },
  { prop: 'border-radius', label: 'Corners', kind: 'length' },
  { prop: 'gap', label: 'Gap', kind: 'length' },
];

/** `rgb(1, 2, 3)` or `rgba(…, 0)` as `#010203`, what a colour input takes; null for a transparent colour. */
function hexOf(css: string): string | null {
  const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)/.exec(css);
  if (!m) return /^#[0-9a-f]{6}$/i.test(css) ? css.toLowerCase() : null;
  if (m[4] !== undefined && Number.parseFloat(m[4]) === 0) return null;
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
}

const pxOf = (css: string): string => (/^-?[\d.]+px$/.test(css) ? String(Math.round(Number.parseFloat(css) * 10) / 10) : '');

function StylePanel({ pick, onChange }: { pick: LivePick; onChange: (changes: StyleChange[]) => void }) {
  const live = liveBridge();
  const [values, setValues] = useState<Record<string, string>>({});
  const changes = (next: Record<string, string>): StyleChange[] =>
    Object.entries(next).filter(([k, v]) => v !== '' && v !== (pick.style[k] ?? '')).map(([property, to]) => ({ property, from: pick.style[property] ?? '', to }));
  const set = (prop: string, value: string): void => {
    const next = { ...values, [prop]: value };
    setValues(next);
    onChange(changes(next));
    void live?.style({ [prop]: value });
  };
  const reset = (): void => {
    setValues({});
    onChange([]);
    void live?.unstyle();
  };
  const shown = (c: Control): string => values[c.prop] ?? pick.style[c.prop] ?? '';
  return (
    <div className="live-style">
      <div className="live-style-grid">
        {CONTROLS.map((c) => {
          const id = `live-style-${c.prop}`;
          const value = shown(c);
          return (
            <div key={c.prop} className="live-style-row">
              <label htmlFor={id} className="small">{c.label}</label>
              {c.kind === 'color' ? (
                <span className="live-style-color">
                  <input id={id} type="color" value={hexOf(value) ?? '#ffffff'} onChange={(e) => set(c.prop, e.target.value)} />
                  <span className="mono small faint">{hexOf(value) ?? 'none'}</span>
                </span>
              ) : c.kind === 'length' ? (
                <span className="live-style-length">
                  <input id={id} type="number" step={c.step ?? 1} value={pxOf(value)} placeholder={pxOf(value) ? undefined : value || 'auto'}
                    onChange={(e) => set(c.prop, e.target.value === '' ? '' : `${e.target.value}px`)} />
                  <span className="faint small">px</span>
                </span>
              ) : (
                <select id={id} value={c.options.includes(value) ? value : ''} onChange={(e) => set(c.prop, e.target.value)}>
                  {c.options.includes(value) ? null : <option value="">{value || '—'}</option>}
                  {c.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              )}
            </div>
          );
        })}
      </div>
      <div className="live-actions">
        <Button size="s" tone="quiet" icon="undo" onClick={reset} disabled={!Object.keys(values).length}>Reset</Button>
        <span className="faint small">Tried on this page only. Add a note to have an agent make it in the theme’s own styles.</span>
      </div>
    </div>
  );
}
