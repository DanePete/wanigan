// A chosen part of the live page, however it was chosen (picked on the page or
// in the Layers tree): five verbs first, then the note to an agent, then why it
// looks as it does, folded.
//
// - Edit ▾ is the one place for every way of changing it, grouped by where the
//   change is saved: in the site (the trace's edit targets in a sheet beside
//   the part, the admin page), on the page (retyping its words, trying a
//   style: edits of the design layer, LayerEdits.tsx), and in code (its
//   template in the code editor, an override).
// - Move opens where it is and moves it (Arrange.tsx); Code opens what made it
//   in the code editor; Alone shows it with nothing around it; Take out takes
//   an item out of its collection (only its placement or reference goes),
//   asking first when what it is in is shared, or says why it cannot.
// - An edit on the page goes into the design layer: the page shows it at once,
//   the site does not have it until it is made real from the tray (Edits, ⇧E;
//   Tray.tsx), where words are saved through the helper and styles go to an
//   agent as intent. Retype the words (E, or a double-click on them in the page)
//   types on the page itself, every keystroke shown there; Retype in a box is the
//   same edit typed here, for the keyboard and screen readers.
//
// With the site helper's trace, "Why it looks like this" also says what the
// trace knows of the part (PartTrace.tsx): the hooks that shaped it, its data,
// its cache, cost, revisions and access.
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { LiveComponent, LivePick, LivePlatform, LiveRegion, LiveSite } from '@shared/live';
import { partFor, type LiveTraceAnswer, type PartIndex } from '@shared/live-lens';
import type { EditTarget, LiveTrace } from '@shared/live-trace';
import { checkRemove, collectionOf } from '@shared/live-arrange';
import { editPath, entityOf, nameOf, originOf, overrideDir, overrides, type LiveOrigin } from '@shared/live-names';
import { ancestors, kindKey } from '@shared/live-tree';
import type { ProjectSummary } from '@shared/model';
import { bridge } from '../../lib/api';
import { liveBridge } from '../../lib/live';
import { Icon } from '../icons';
import { MenuButton, type MenuItem } from '../Menu';
import { Button, Disclosure, IconButton, useToast } from '../ui';
import { KIND_ICON } from './Layers';
import { NoteComposer, draftFor } from './Notes';
import { MoveSection, type useArrange } from './Arrange';
import { HelperDialog } from './Helper';
import { EDIT_KIND, TraceAccess, TraceCache, TraceCost, TraceData, TraceHistory, TraceMadeBy } from './PartTrace';
import { TraceNote } from './TraceNote';
import { SiteAiSection } from './SiteAi';
import type { LiveSiteAiAnswer } from '@shared/live-ai';
import { openInEditor, relativeTo, type EditorTarget } from '../../editor/EditButton';
import { changeLines, pagePath, placesOf, thisReach } from '../../lib/live-layer';
import { LayerAddedNote, RetypeWords, StyleEdit, type LayerAdded } from './LayerEdits';
import type { LayerApi } from './use-layer';

export interface Selection {
  region: LiveRegion | null;
  pick: LivePick | null;
  /** Chosen in the tree (its element made the picked one) rather than pointed at: the part is the same whoever chose it. */
  how?: 'pick' | 'tree';
}

/**
 * The five verbs, for the live view's keys (E, M, ., ⇧A, ⇧X), and typing on the chosen part's words (`retype`: a
 * double-click on them in the page). Each does what its button does, or says why it cannot. E types on the words when
 * the part is only words, and opens Edit ▾ otherwise.
 */
export type InspectorVerbs = Record<'edit' | 'move' | 'code' | 'alone' | 'take-out' | 'retype', () => void>;

const ORIGIN: Record<LiveOrigin, string> = { yours: 'Your code', contrib: 'Contributed', core: 'Drupal core' };

const near = (root: string, abs: string): string => (abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs);

export function Inspector({ project, platform, selection, regions, components, docroot, theme, page, prefer, helper, readOnly = false, onSelect, onClose,
  site, answer, trace, parts, arrange, onEdit, siteAi, onSiteAiRefresh, verbs, layer, onTray }: {
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
  site: LiveSite;
  /** The page's trace from the site helper, or why there is none. */
  answer: LiveTraceAnswer | null;
  trace: LiveTrace | null;
  parts: PartIndex;
  arrange: ReturnType<typeof useArrange>;
  /** Open an edit target in a sheet beside the part. */
  onEdit: (target: EditTarget, region: LiveRegion | null) => void;
  /** The site's AI as its core reports it (null until read, or on a hosted environment), and asking for it again. */
  siteAi: LiveSiteAiAnswer | null;
  onSiteAiRefresh: () => void;
  /** Filled with what the verbs do, for the live view's keys. */
  verbs?: MutableRefObject<InspectorVerbs | null>;
  /** The design layer: retyped words and tried styles are its edits. */
  layer: LayerApi;
  /** Open the tray of the layer's edits. */
  onTray: () => void;
}) {
  const live = liveBridge();
  const toast = useToast();
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
  const title = name?.title ?? (pick ? `<${pick.tag}>` : 'Part');
  /** Retyping its words, or trying a style: an edit of the design layer, made here. */
  const [retyping, setRetyping] = useState(false);
  const [styling, setStyling] = useState(false);
  /** What was just added to the layer, said until the next edit. */
  const [added, setAdded] = useState<LayerAdded | null>(null);
  const [moving, setMoving] = useState(false);
  /** Why the chosen part cannot be taken out, said under the verbs once Take out is pressed. */
  const [outWhy, setOutWhy] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const movePanel = useRef<HTMLElement | null>(null);
  const editOpen = useRef<(() => void) | null>(null);
  const aloneOpen = useRef<(() => void) | null>(null);
  // A part pointed at keeps its own element; one chosen in the tree is the same part whichever element stands for it.
  const key = `${region?.index ?? ''}:${selection.how === 'tree' && region ? '' : pick?.selector ?? ''}`;
  useEffect(() => { setRetyping(false); setStyling(false); setAdded(null); setMoving(false); setOutWhy(null); }, [key]);

  const go = (path: string): void => {
    if (!page || !live) return;
    void live.go(new URL(path, page).toString());
  };
  // Where to change the content in Drupal: the part's own admin page, or the nearest part's that has one.
  const admin = chain.map((r) => ({ r, path: editPath(r) })).find((x) => x.path);
  const content = chain.map((r) => ({ r, e: entityOf(r) })).find((x) => x.e?.id);
  // Already alone (the helper's own page): nothing more to take it out of.
  const isAlone = (() => { try { return new URL(page ?? '').pathname.startsWith('/_wanigan/piece/'); } catch { return false; } })();
  const alone = helper && !isAlone && !readOnly ? alonePaths(chain).filter((a) => platform !== 'wordpress' || a.path.startsWith('/_wanigan/piece/entity/post/')) : [];
  // What the trace says, for this part or the nearest one around it.
  const traced = partFor(chain, parts);
  const edit = (t: EditTarget): void => onEdit(t, traced?.region ?? region);
  const now = region ? regions.find((r) => r.index === region.index) ?? region : null;
  const component = region?.component ? components.get(region.component) ?? null : null;
  // At the words pointed at; a part chosen in the tree is found by its own words, when it is only words.
  const code = codeOf(region, component, docroot, project, (selection.how === 'tree' ? pick?.own : pick?.text) ?? null);
  const canMove = !readOnly && !!now && !!arrange.movable(now);
  const showMove = !!now && (moving || arrange.pending?.region === now.index);
  const cms = platform === 'wordpress' ? 'WordPress' : 'Drupal';
  // Take out: the chosen part, when it is an item of one of the trace's collections.
  const own = now && !readOnly ? parts.byRegion.get(now.index) ?? null : null;
  const home = own && trace ? collectionOf(trace, own.id) : null;
  /** A collection the helper says nothing about taking out of: a helper older than version 4. */
  const oldHelper = !!home && home.removes !== true && !home.removeWhy;

  /** Words can be typed on the page: the chosen element holds only words, on the local site. */
  const typable = !!pick?.own && !!live && !readOnly;
  /**
   * Type on the chosen element's words in the page itself: the window says so under the page while it lasts, and
   * words kept there are a text edit of the layer, said here once added.
   */
  const typeOnPage = (): void => {
    if (!typable || !pick) { toast(readOnly ? 'This environment is read-only: nothing here can change it.' : 'Pick the words themselves (an element with only text in it) to retype them.'); return; }
    setStyling(false); setRetyping(false); setAdded(null);
    void layer.typeOnPage(pagePath(page) || pagePath(pick.url)).then((r) => {
      if (!r) return;
      const change = { type: 'text' as const, value: r.words };
      setAdded({ label: r.target.label, lines: changeLines({ change, before: r.target.before }), reach: thisReach(placesOf(r.target.target.part, trace), !!r.target.target.part) });
    });
  };

  /* ── Edit ▾: every way to change it, by where the change is saved ── */
  const targets = traced && trace && !readOnly ? (traced.part.edits ?? []).map((id) => parts.edits.get(id)).filter((e): e is EditTarget => !!e) : [];
  const override = targets.find((e) => e.kind === 'template-override' && !e.why) ?? null;
  const editItems: MenuItem[] = [];
  if (!readOnly) {
    const inSite = `In the site · saved by ${cms} as you`;
    for (const e of targets.filter((t) => t.kind !== 'template-override')) {
      editItems.push({
        id: `target-${e.id}`, group: inSite, icon: 'pencil', label: e.label, disabled: !!e.why,
        detail: e.why ?? `${EDIT_KIND[e.kind]}${e.via === 'native-form' ? ', in the site’s own form beside it' : ', beside it'}${e.revisions ? ' · a new revision' : ''}${e.shows ? ' · shows beyond this page' : ''}`,
        run: () => edit(e),
      });
    }
    if (admin) {
      editItems.push({ id: 'admin', group: inSite, icon: 'settings', label: adminLabel(admin.r), detail: 'Its admin page, here in the live view', run: () => go(admin.path as string) });
    }
    if (pick && live) {
      const onPage = 'On the page · in the design layer, nothing saved yet';
      const pickWords = 'Pick the words themselves (an element with only text in it) to retype them';
      editItems.push({
        id: 'words', group: onPage, icon: 'pencil', label: 'Retype the words', disabled: !pick.own, keys: pick.own ? ['E'] : undefined,
        detail: pick.own ? `On the page itself, each key as you type it (or double-click them there): Enter keeps it in the layer, Esc puts it back${layer.on ? '' : ' (the page is shown without the layer now)'}` : pickWords,
        run: typeOnPage,
      });
      editItems.push({
        id: 'words-box', group: onPage, icon: 'pencil', label: 'Retype in a box', disabled: !pick.own,
        detail: pick.own ? `The same edit, typed in a box here: for the keyboard and screen readers. ${layer.on ? 'Shown on the page once added' : 'Kept in the layer (the page is shown without it now)'}; made real from Edits (⇧E)` : pickWords,
        run: () => { setStyling(false); setAdded(null); setRetyping(true); },
      });
      editItems.push({
        id: 'style', group: onPage, icon: 'brush', label: 'Try a style', kind: 'check', checked: styling,
        detail: `This element or every one of its kind, ${layer.on ? 'shown on the page at once' : 'kept in the layer (the page is shown without it now)'}; it goes to an agent as intent`, run: () => { setRetyping(false); setStyling((v) => !v); },
      });
    }
  }
  const inCode = 'In code';
  if (code) editItems.push({ id: 'code', group: inCode, icon: 'code', label: code.path.split('/').pop() as string, detail: `${code.whose} · opens in the code editor`, keys: ['.'], run: () => openInEditor(code) });
  if (override) editItems.push({ id: 'override', group: inCode, icon: 'file', label: 'Create override…', detail: `${override.label}: a copy for this part only, in your theme`, run: () => edit(override) });

  const openCode = (): void => { if (code) openInEditor(code); };
  const takeOut = (): void => {
    if (!home || !own) { toast(readOnly ? 'This environment is read-only: nothing here can take it out.' : `Nothing says ${title} can be taken out here.`); return; }
    const remove = checkRemove(trace, { collection: home.id, item: own.id });
    if (typeof remove === 'string') { setOutWhy(remove); return; }
    setOutWhy(null);
    void arrange.saveRemove(remove);
  };
  const startMove = (): void => {
    if (!canMove) return;
    setMoving((v) => !v || arrange.pending?.region === now?.index);
  };
  // Opened, Move takes the keyboard: its arrows move the part at once.
  useEffect(() => { if (moving) movePanel.current?.querySelector<HTMLElement>('button.live-up')?.focus(); }, [moving]);
  const showAlone = (): void => {
    if (alone.length === 1) go((alone[0] as { path: string }).path);
    else if (alone.length > 1) aloneOpen.current?.();
  };
  if (verbs) {
    verbs.current = {
      // Words are typed at once, on the page; anything else opens every way to change it.
      edit: () => {
        if (typable) { typeOnPage(); return; }
        if (editItems.some((i) => !i.disabled)) editOpen.current?.(); else toast(readOnly ? 'This environment is read-only: nothing here can change it.' : `Nothing says how to change ${title} here. Tell an agent instead.`);
      },
      retype: () => { if (typable) typeOnPage(); },
      move: () => { if (canMove) startMove(); else toast(readOnly ? 'This environment is read-only: nothing here can move it.' : `${title} cannot be moved here.`); },
      code: () => { if (code) openCode(); else toast(codeWhyNot(region, docroot)); },
      alone: () => { if (alone.length) showAlone(); else toast(aloneWhyNot(helper, isAlone, readOnly)); },
      'take-out': takeOut,
    };
  }

  return (
    <div className="live-inspector"
      // A move under way takes Alt+arrows, Enter and Escape first (Arrange.tsx); an open list keeps its own keys.
      onKeyDownCapture={(e) => { if (!(e.target as Element).closest?.('[role="menu"], .sel-list')) arrange.keys(e, now); }}
      onKeyDown={(e) => { if (!e.defaultPrevented && e.key === 'Escape' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLSelectElement)) onClose(); }}>
      <div className="live-side-head">
        <div className="live-inspector-title">
          {name ? <Icon name={KIND_ICON[name.icon]} size={16} /> : <Icon name="pick" size={16} />}
          <div>
            <h2 className="live-side-title" tabIndex={-1}>{title}</h2>
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

      <div className="live-verbs" role="group" aria-label={`What to do with ${title}`}>
        <MenuButton className="live-verb" label={`Edit ${title}: every way, in one menu`} items={editItems} openRef={editOpen} width={340}
          disabled={!editItems.length} title={editItems.length ? (typable ? 'Every way to change it, by where the change is saved. E types on its words, on the page' : 'Every way to change it, by where the change is saved (E)') : readOnly ? 'This environment is read-only' : 'Nothing says how to change it here: tell an agent'}>
          <Icon name="pencil" size={16} />
          <span className="live-verb-name">Edit <Icon name="down" size={12} /></span>
          <kbd aria-hidden="true">E</kbd>
        </MenuButton>
        <button type="button" className="btn live-verb" aria-pressed={showMove} aria-keyshortcuts="M" disabled={!canMove} onClick={startMove}
          title={canMove ? 'Move it: up, down, or to another place it may go (M)' : readOnly ? 'This environment is read-only' : 'Nothing says it can be moved here'}>
          <Icon name="move" size={16} />
          <span className="live-verb-name">Move</span>
          <kbd aria-hidden="true">M</kbd>
        </button>
        <button type="button" className="btn live-verb" aria-keyshortcuts="." disabled={!code} onClick={openCode}
          title={code ? `Open ${code.path} in the code editor (.)` : codeWhyNot(region, docroot)}>
          <Icon name="code" size={16} />
          <span className="live-verb-name">Code</span>
          <kbd aria-hidden="true">.</kbd>
        </button>
        {alone.length > 1 ? (
          <MenuButton className="live-verb" label={`Show ${title} alone`} openRef={aloneOpen} align="end" width={300} title="Show it with nothing around it (⇧A)"
            items={alone.map((a) => ({ id: a.path, label: a.label, icon: 'alone' as const, detail: 'In your theme, with nothing around it; Back returns to the page', run: () => go(a.path) }))}>
            <Icon name="alone" size={16} />
            <span className="live-verb-name">Alone <Icon name="down" size={12} /></span>
            <kbd aria-hidden="true">⇧A</kbd>
          </MenuButton>
        ) : (
          <button type="button" className="btn live-verb" aria-keyshortcuts="Shift+A" disabled={!alone.length} onClick={showAlone}
            title={alone.length ? `${alone[0]?.label}: in your theme, with nothing around it (⇧A)` : aloneWhyNot(helper, isAlone, readOnly)}>
            <Icon name="alone" size={16} />
            <span className="live-verb-name">Alone</span>
            <kbd aria-hidden="true">⇧A</kbd>
          </button>
        )}
        <button type="button" className="btn live-verb live-verb-out" aria-keyshortcuts="Shift+X" disabled={!home} onClick={takeOut}
          aria-describedby={outWhy ? 'live-out-why' : undefined}
          title={home ? `Take it out of ${home.label}: only its place there goes, never what it shows (⇧X)` : readOnly ? 'This environment is read-only' : 'Nothing says it can be taken out here'}>
          <Icon name="takeOut" size={16} />
          <span className="live-verb-name">Take out</span>
          <kbd aria-hidden="true">⇧X</kbd>
        </button>
      </div>
      {outWhy ? (
        <div className="live-out-why" id="live-out-why" role="status">
          <p className="small">{outWhy}</p>
          {oldHelper && site.helper && site.helperPlan && !site.helperPlan.refused ? (
            <div className="live-actions"><Button size="s" icon="plug" onClick={() => setUpdating(true)}>Update the helper…</Button></div>
          ) : null}
        </div>
      ) : null}
      {updating ? <HelperDialog site={site} project={project} onClose={() => setUpdating(false)} /> : null}

      {showMove && now ? <MoveSection arrange={arrange} region={now} trace={trace} panelRef={movePanel} onClose={() => setMoving(false)} /> : null}
      {retyping && pick?.own ? (
        <RetypeWords key={pick.selector} pick={pick} layer={layer} page={pagePath(page) || pagePath(pick.url)} trace={trace}
          onAdded={(a) => { setRetyping(false); setAdded(a); }} onCancel={() => setRetyping(false)} />
      ) : null}
      {styling && pick ? (
        <StyleEdit key={pick.selector} pick={pick} layer={layer} page={pagePath(page) || pagePath(pick.url)} trace={trace} onAdded={setAdded} onDone={() => setStyling(false)} />
      ) : null}
      {added ? <LayerAddedNote added={added} onTray={onTray} /> : null}

      <section className="live-section live-tell" aria-label="Tell an agent">
        <h3 className="live-section-title">Tell an agent</h3>
        <NoteComposer key={key} project={project} components={components} prefer={prefer}
          draft={draftFor(page ?? pick?.url ?? '', { regions: pick ? pick.regions : chain, pick })} />
      </section>

      {region ? <Alike region={region} regions={regions} /> : null}

      <section className="live-section live-why" aria-label="Why it looks like this">
        <h3 className="live-section-title">Why it looks like this</h3>
        {region ? (
          <MadeBy region={region} component={component} project={project} docroot={docroot} theme={theme} content={content?.e ?? null}
            summary={madeBySummary(region, component, traced?.part ?? null)}>
            {traced ? (
              <>
                {traced.inherited ? <p className="faint small">From the trace of {traced.part.label}, around it:</p> : null}
                <TraceMadeBy part={traced.part} />
              </>
            ) : answer?.state === 'ok' ? null : <TraceNote compact answer={answer} site={site} project={project} />}
          </MadeBy>
        ) : (
          <p className="faint small">Nothing around it says what made it. Notes still tell an agent where it is on the page.</p>
        )}
        {/* A hosted environment is read-only: its trace is not the local site's. */}
        {!readOnly && traced && trace ? (
          <>
            <TraceData part={traced.part} edits={parts.edits} onEdit={edit} />
            <TraceCache part={traced.part} />
            <TraceCost part={traced.part} trace={trace} />
            <TraceHistory part={traced.part} />
            <TraceAccess part={traced.part} user={trace.user} />
          </>
        ) : null}
        {/* What a save here sets off on the site, and its AI as its core reports it: the local site only. */}
        {!readOnly ? <SiteAiSection answer={siteAi} onRefresh={onSiteAiRefresh} /> : null}
        {pick ? (
          <Disclosure title="The element" summary={`<${pick.tag}>`}>
            <p className="small"><span className="mono">&lt;{pick.tag}&gt;</span>{pick.text ? <> “{pick.text.slice(0, 160)}”</> : null}</p>
            <p className="mono small faint live-selector" title={pick.selector}>{pick.selector}</p>
          </Disclosure>
        ) : null}
      </section>
    </div>
  );
}

/** The file Code opens: the part's template, or its component's, inside the project; where the picked words are. */
function codeOf(region: LiveRegion | null, component: LiveComponent | null, docroot: string | null, project: ProjectSummary, words: string | null): (EditorTarget & { whose: string }) | null {
  if (!region) return null;
  const root = project.path;
  const twig = component?.files.find((f) => f.endsWith('.twig')) ?? null;
  const fromComponent = component && twig ? relativeTo(root, `${component.dir}/${twig}`) : null;
  if (fromComponent) return { projectId: project.id, path: fromComponent, find: words, whose: `Component ${component?.name ?? region.component}` };
  const fromTemplate = region.file && docroot ? relativeTo(root, `${docroot}/${region.file}`) : null;
  const origin = originOf(region.file);
  if (fromTemplate) return { projectId: project.id, path: fromTemplate, find: words, whose: origin ? ORIGIN[origin] : 'Its template' };
  return null;
}

function codeWhyNot(region: LiveRegion | null, docroot: string | null): string {
  if (!region) return 'Nothing around it says which file made it';
  if (region.file && !docroot) return 'The site’s folder is not known, so its template cannot be opened';
  if (region.file) return 'Its template is outside the project’s folder';
  return 'The page does not say which file made it';
}

function aloneWhyNot(helper: boolean, isAlone: boolean, readOnly: boolean): string {
  if (readOnly) return 'A hosted environment shows parts only in its own pages';
  if (isAlone) return 'It is shown alone already: Back returns to the page';
  if (!helper) return 'Showing a part alone needs the site helper';
  return 'Nothing around it can be shown alone';
}

/** What Made by holds, in one line, for its closed heading. */
function madeBySummary(region: LiveRegion, component: LiveComponent | null, part: { source?: { file: string }; chain?: unknown[] } | null): string {
  const file = component ? component.id : region.file ? region.file.split('/').pop() ?? region.file
    : region.component ?? part?.source?.file.split('/').pop() ?? region.block?.split('@')[0] ?? region.view ?? region.entity ?? null;
  const origin = originOf(region.file);
  const hooks = part?.chain?.length ? `${part.chain.length} ${part.chain.length === 1 ? 'hook' : 'hooks'}` : null;
  return [file, origin ? ORIGIN[origin].toLowerCase() : null, hooks].filter(Boolean).join(' · ') || 'not said';
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

/**
 * What made a part: its component's folder and files, or its template and
 * whose code it is, the content it shows, and how to change someone else's
 * template here only. Folded: what to do with the part comes first.
 */
function MadeBy({ region, component, docroot, project, theme, content, summary, children }: {
  region: LiveRegion; component: LiveComponent | null; docroot: string | null; project: ProjectSummary; theme: string | null;
  /** The piece of content it shows, nearest first. */
  content: ReturnType<typeof entityOf>;
  summary: string;
  /** What the site helper's trace adds. */
  children?: ReactNode;
}) {
  const origin = originOf(region.file);
  const template = region.file && docroot ? `${docroot}/${region.file}` : null;
  // A component's own files open in the code editor (Code opens its template).
  const componentPath = (file: string): string | null => (component ? relativeTo(project.path, `${component.dir}/${file}`) : null);
  const options = overrides(region);
  return (
    <Disclosure title="Made by" summary={summary}>
      {content?.id ? <p className="small">Shows {content.type.replace(/_/g, ' ')} {content.id}{content.bundle ? ` (${content.bundle.replace(/_/g, ' ')})` : ''}.</p> : null}
      {component ? (
        <div className="live-made">
          <span className="mono small">{component.id}</span>
          {component.description ? <span className="small">{component.description}</span> : null}
          <span className="mono small faint" title={component.dir}>{near(project.path, component.dir)}/</span>
          <span className="live-files">{component.files.map((f) => {
            const path = componentPath(f);
            return path
              ? <button key={f} type="button" className="lib-tag mono live-file-open" title={`Open ${f} in the code editor`} onClick={() => openInEditor({ projectId: project.id, path })}>{f}</button>
              : <span key={f} className="lib-tag mono">{f}</span>;
          })}</span>
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
          <div className="live-actions">
            <Button size="s" tone="quiet" icon="folder" onClick={() => void bridge().openPath(component.dir)}>Show in Finder</Button>
          </div>
        </div>
      ) : region.component ? <span className="mono small">{region.component}</span> : null}
      {region.file ? (
        <div className="live-made">
          <span className="live-made-file">
            <span className="mono small" title={region.file}>{region.file}</span>
            {origin ? <span className={`live-origin ${origin}`}>{ORIGIN[origin]}</span> : null}
          </span>
          {region.hook ? <span className="faint small">Theme hook {region.hook}</span> : null}
          {template ? (
            <div className="live-actions">
              <Button size="s" tone="quiet" icon="file" onClick={() => void bridge().openPath(template)}>Show in Finder</Button>
            </div>
          ) : null}
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
          <p className="faint small">Then clear Drupal’s cache. A note to an agent above says the same.</p>
        </div>
      ) : null}
      {!region.file && !component && !region.component && !children ? (
        <p className="faint small">{[region.entity && `Content ${region.entity}`, region.block && `Block ${region.block}`, region.view && `View ${region.view}`, region.element && `Elementor ${region.element}`].filter(Boolean).join(' · ') || 'The page does not say which file made it.'}</p>
      ) : null}
      {children}
    </Disclosure>
  );
}

