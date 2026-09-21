import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExtensionArtifactInfo,
  ExtensionConsentLine,
  ExtensionInfo,
  ExtensionInspection,
  ExtensionOrigin,
  ExtensionRemoval,
  ExtensionStatus,
} from '@shared/types';
import {
  Chip, ConfirmNote, EmptyState, Explainer, Hint, Mark, Note, PageHead, Reading,
  SectionHead, Segmented, Stat, ago, num, type Tone,
} from '../components/bits';
import McpStore from './McpStore';
import ExtensionCredentials from './ExtensionCredentials';

/*
 * The extension store.
 *
 * A Wanigan extension is a bundle of DECLARATIONS — MCP servers, skills, review
 * gates, instructions — for surfaces this app already has. Nothing it ships runs
 * inside Wanigan, which is the whole reason a stranger's bundle can be installed
 * at all, and the reason this view can afford to read like a store rather than a
 * security console.
 *
 * Three promises this file keeps, in order of how much they matter:
 *
 *  1. A declaration that was NOT applied is printed on the card with the note
 *     saying why. Never a tooltip, never a hover, never folded away. "Declared
 *     but not applied, and here is why" is the sentence that makes the rest of
 *     the list believable; hide it and the inventory becomes a claim nobody can
 *     check.
 *  2. Install is behind a consent panel that has to be opened, and the sentence
 *     about what Wanigan does and does not check sits beside the Install button
 *     rather than in a footer or a README.
 *  3. Uninstall prints what was removed AND what was kept because a person had
 *     edited it, with the reason. A kept row is never worded as a failure.
 *
 * There is no remote catalogue. Browse lists what this Wanigan holds — folders
 * that were added, and bundles saved out of its own configuration — and says so.
 * Every count on a card is read off `artifacts`; nothing here invents a download
 * number, a rating or a featured row, because there is no measurement behind one.
 */

type Mode = 'store' | 'browse' | 'installed';
type Panel = 'none' | 'add' | 'save' | 'store';
type Sort = 'updated' | 'name' | 'publisher';
type Provide = ExtensionArtifactInfo['kind'];
type StateFacet = 'enabled' | 'disabled' | 'needs-trust' | 'invalid' | 'update';
/** How an artifact row should be worded: the same shape means four things. */
type ArtifactMode = 'installed' | 'planned' | 'removed' | 'kept';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The one sentence a person needs before they press Install, in the words
 * Wanigan can actually stand behind. It is rendered beside the button, not in a
 * banner at the top that scrolls away and not only in the guide.
 */
const SAFETY = 'Wanigan checks that an extension is shaped like one and shows you everything it declares. It does not review what a server does once it runs.';

/*
 * State never travels as colour alone. Every reading below is a glyph plus a
 * word plus a sentence, because green against red measures ΔE 4.1 under
 * deuteranopia (see the note at the top of components/AttentionQueue.tsx) and
 * "this bundle is unreadable" is not a state that may go quiet in greyscale.
 */
const STATUS_READING: Record<ExtensionStatus, { glyph: string; word: string; tone: Tone; blurb: string }> = {
  enabled: {
    glyph: '✓', word: 'Enabled', tone: 'ok',
    blurb: 'Installed, approved, and its declarations are in place.',
  },
  disabled: {
    glyph: '○', word: 'Disabled', tone: 'quiet',
    blurb: 'Still installed and still on disk. Nothing it declares is active until you switch it back on.',
  },
  'needs-trust': {
    glyph: '?', word: 'Waiting for your approval', tone: 'warn',
    blurb: 'Wanigan can read this extension and finds nothing wrong with its shape — but these exact manifest bytes have never been approved here. Nothing it declares is applied until they are. This is not an error: it is the difference between a bundle Wanigan could read and one you have agreed to.',
  },
  invalid: {
    glyph: '✕', word: 'Cannot be read', tone: 'serious',
    blurb: 'Wanigan cannot read this directory as an extension at all, so nothing in it was applied. Every reason is listed below, not just the first.',
  },
};

const ORIGIN_READING: Record<ExtensionOrigin, string> = {
  // Read through the same validator as everything else, and digest-recorded
  // like everything else — "ships with" is a fact about where it came from,
  // never a reason it was trusted.
  builtin: 'Ships with Wanigan',
  folder: 'Added from a folder you chose',
  development: 'Loaded in place from a working directory',
  export: 'Saved out of this Wanigan’s own configuration',
};

const PROVIDE_READING: Record<Provide, { one: string; many: string; glyph: string }> = {
  'mcp-server': { one: 'MCP server', many: 'MCP servers', glyph: '⇄' },
  skill: { one: 'skill', many: 'skills', glyph: '✎' },
  gate: { one: 'review gate', many: 'review gates', glyph: '⊘' },
  instruction: { one: 'instruction', many: 'instructions', glyph: '¶' },
  // A public page Scout fetches on its weekly schedule — the second kind an
  // install applies, after MCP servers. Named as what it is to a person
  // ("a source Scout reads") rather than the manifest's key.
  'scout-source': { one: 'Scout source', many: 'Scout sources', glyph: '◎' },
};
const PROVIDE_ORDER: Provide[] = ['mcp-server', 'scout-source', 'skill', 'gate', 'instruction'];

const STATE_WORD: Record<StateFacet, string> = {
  enabled: 'Enabled',
  disabled: 'Disabled',
  'needs-trust': 'Waiting for approval',
  invalid: 'Cannot be read',
  update: 'Update ready',
};
const STATE_ORDER: StateFacet[] = ['enabled', 'disabled', 'needs-trust', 'invalid', 'update'];
const ORIGIN_ORDER: ExtensionOrigin[] = ['folder', 'development', 'export'];

/*
 * The consent panel's groups. The heading says what the group MEANS rather than
 * repeating the manifest's own vocabulary: a reader deciding whether to install
 * a stranger's bundle needs "a program that will run on this machine", not
 * "command".
 */
const CONSENT_GROUPS: { kind: ExtensionConsentLine['kind']; heading: string; meaning: string }[] = [
  {
    kind: 'command',
    heading: 'Programs that will run on this machine',
    meaning: 'Each line is a program Wanigan will start outside itself, as you, with your files. It does not run inside Wanigan — that is why an extension can be installed at all — but it runs.',
  },
  {
    kind: 'host',
    heading: 'Where data will be sent',
    meaning: 'Each line is somewhere one of these servers reaches. Anything sent through it leaves this machine.',
  },
  {
    kind: 'credential',
    heading: 'Credentials it will ask you for',
    meaning: 'Each line is a secret this extension expects. Wanigan stores it and hands it to the program named above; the value is never printed back here.',
  },
  {
    kind: 'file',
    heading: 'Files it will write',
    meaning: 'Each line is a path this install creates or changes.',
  },
  {
    kind: 'note',
    heading: 'What the author wanted said',
    meaning: 'Left by whoever built this bundle. Wanigan passes it through; it does not vouch for it.',
  },
];

const providesOf = (x: { artifacts: ExtensionArtifactInfo[] }) => {
  const counts = new Map<Provide, number>();
  for (const a of x.artifacts) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  return PROVIDE_ORDER.filter((k) => counts.has(k)).map((k) => ({ kind: k, n: counts.get(k) ?? 0 }));
};

const provideWord = (kind: Provide, n: number) =>
  `${num(n)} ${n === 1 ? PROVIDE_READING[kind].one : PROVIDE_READING[kind].many}`;

const publisherLine = (p: ExtensionInfo['publisher']) =>
  p ? `${p.name}${p.url ? ` · ${p.url}` : ''}` : 'No publisher recorded';

function toggleIn<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** How an artifact row reads, in each of the four places one is rendered. */
function artifactReading(a: ExtensionArtifactInfo, mode: ArtifactMode): { glyph: string; word: string; tone: Tone; note: string | null } {
  if (mode === 'removed') return { glyph: '–', word: 'Removed', tone: 'quiet', note: a.note };
  // Never worded as a failure: keeping an edited row is the promise, not the
  // shortfall. Uninstalling a extension that silently reverted somebody's own
  // change is the outcome that would stop people uninstalling at all.
  if (mode === 'kept') {
    return {
      glyph: '✓', word: 'Kept, because you edited it', tone: 'ok',
      note: a.note ?? 'Wanigan does not revert a row somebody has since changed. It is exactly as you left it.',
    };
  }
  if (a.applied) {
    return mode === 'planned'
      ? { glyph: '○', word: 'Will be applied', tone: 'quiet', note: a.note }
      : { glyph: '✓', word: 'Applied', tone: 'ok', note: a.note };
  }
  return {
    glyph: '!',
    word: mode === 'planned' ? 'Declared, will not be applied' : 'Declared, not applied',
    tone: 'warn',
    note: a.note ?? 'No reason was recorded for this. Treat the declaration as not installed.',
  };
}

const artifactKey = (a: ExtensionArtifactInfo) => `${a.kind}/${a.ref}/${a.projectId ?? ''}`;

export default function Extensions() {
  const [list, setList] = useState<ExtensionInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Null until somebody chooses: the honest default depends on whether anything
  // is installed, and that answer arrives with the first read.
  const [modeChoice, setModeChoice] = useState<Mode | null>(null);
  const [panel, setPanel] = useState<Panel>('none');
  const [query, setQuery] = useState('');
  const [provides, setProvides] = useState<Provide[]>([]);
  const [states, setStates] = useState<StateFacet[]>([]);
  const [origins, setOrigins] = useState<ExtensionOrigin[]>([]);
  const [sort, setSort] = useState<Sort>('updated');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removal, setRemoval] = useState<ExtensionRemoval | null>(null);
  const [inspection, setInspection] = useState<ExtensionInspection | null>(null);
  /*
   * Which manifest digest has actually been opened and read. Not a boolean:
   * a flag that says "somebody reviewed something" carries over to the next
   * folder, and re-arming the gate when the bytes change is the same rule the
   * install call already enforces by passing the digest back.
   */
  const [reviewedSha, setReviewedSha] = useState<string | null>(null);
  const [offer, setOffer] = useState<{ mcpServers: { id: string; name: string; detail: string }[] } | null>(null);
  const [servers, setServers] = useState<string[]>([]);
  const [newId, setNewId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [saved, setSaved] = useState<ExtensionInspection | null>(null);
  const [justInstalled, setJustInstalled] = useState<ExtensionInfo | null>(null);
  const alive = useRef(true);
  const search = useRef<HTMLInputElement>(null);
  const storePanel = useRef<HTMLElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const rows = await window.wanigan.extensions.list();
      if (!alive.current) return;
      setList(rows);
      setListError(null);
    } catch (e) {
      // The list already on screen is the last thing Wanigan actually read.
      // Clearing it would turn a failed call into the claim that nothing is
      // installed, which is a different statement about the world.
      if (alive.current) setListError(errorText(e));
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  /** Every action runs through here: one busy key, one error line, one re-read. */
  const act = useCallback(async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      if (alive.current) setActionError(errorText(e));
    } finally {
      if (alive.current) setBusy(null);
      await refresh();
    }
  }, [refresh]);

  // `/` is the store's search key, and it must not steal a slash somebody is
  // typing into a field. Escape clears, and is handled on the input itself so it
  // never swallows a dialog's own Escape elsewhere in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return;
      e.preventDefault();
      search.current?.focus();
      search.current?.select();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const rows = useMemo(() => list ?? [], [list]);
  const mode: Mode = modeChoice ?? (rows.length > 0 ? 'installed' : 'browse');

  /**
   * An update is only claimed when a folder that was actually read carries the
   * same id at a different version. There is no remote catalogue to ask, so
   * every other extension is "no update known", not "up to date".
   */
  const update = useMemo(() => {
    if (!inspection?.id || !inspection.version) return null;
    const installed = rows.find((r) => r.id === inspection.id);
    if (!installed || installed.version === inspection.version) return null;
    return { id: inspection.id, from: installed.version, to: inspection.version };
  }, [inspection, rows]);

  const statesOf = useCallback((x: ExtensionInfo): StateFacet[] => {
    const out: StateFacet[] = [];
    if (x.status === 'invalid') out.push('invalid');
    else if (x.status === 'needs-trust') out.push('needs-trust');
    else out.push(x.enabled ? 'enabled' : 'disabled');
    if (update?.id === x.id) out.push('update');
    return out;
  }, [update]);

  const needle = query.trim().toLowerCase();
  // Searching the artifact refs is the point: an MCP server called `figma`
  // has to be findable by typing figma, even when the bundle around it is
  // called something else entirely.
  const searched = useMemo(() => rows.filter((x) => {
    if (!needle) return true;
    const hay = [
      x.label, x.id, x.description ?? '', x.publisher?.name ?? '', x.publisher?.id ?? '',
      ...x.artifacts.map((a) => a.ref),
    ];
    return hay.some((t) => t.toLowerCase().includes(needle));
  }), [rows, needle]);

  // Facet counts are read off the searched set, so a chip never promises rows
  // that the search has already removed. A zero-count facet is not rendered at
  // all — offering a choice that can only lead to an empty list is the same
  // defect as an empty list with no way back.
  const facetCounts = useMemo(() => {
    const p = new Map<Provide, number>();
    const s = new Map<StateFacet, number>();
    const o = new Map<ExtensionOrigin, number>();
    for (const x of searched) {
      for (const { kind } of providesOf(x)) p.set(kind, (p.get(kind) ?? 0) + 1);
      for (const st of statesOf(x)) s.set(st, (s.get(st) ?? 0) + 1);
      o.set(x.origin, (o.get(x.origin) ?? 0) + 1);
    }
    return { provides: p, states: s, origins: o };
  }, [searched, statesOf]);

  const shown = useMemo(() => {
    const filtered = searched.filter((x) => {
      if (provides.length && !providesOf(x).some(({ kind }) => provides.includes(kind))) return false;
      if (states.length && !statesOf(x).some((st) => states.includes(st))) return false;
      if (origins.length && !origins.includes(x.origin)) return false;
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (sort === 'name') return a.label.localeCompare(b.label);
      if (sort === 'publisher') {
        return (a.publisher?.name ?? '').localeCompare(b.publisher?.name ?? '') || a.label.localeCompare(b.label);
      }
      return b.updatedAt - a.updatedAt;
    });
  }, [searched, provides, states, origins, sort, statesOf]);

  const heldCount = rows.reduce((n, x) => n + x.artifacts.filter((a) => !a.applied).length, 0);
  const heldShown = shown.reduce((n, x) => n + x.artifacts.filter((a) => !a.applied).length, 0);
  const enabledCount = rows.filter((x) => x.enabled && x.status === 'enabled').length;
  const filters = provides.length + states.length + origins.length;
  const locked = busy !== null;

  const clearFilters = () => { setProvides([]); setStates([]); setOrigins([]); };
  const clearAll = () => { setQuery(''); clearFilters(); };

  async function setEnabled(x: ExtensionInfo, enabled: boolean) {
    await act(`enable:${x.id}`, async () => {
      const next = await window.wanigan.extensions.setEnabled(x.id, enabled);
      if (alive.current) setList(next);
    });
  }

  async function uninstall(x: ExtensionInfo) {
    await act(`uninstall:${x.id}`, async () => {
      const receipt = await window.wanigan.extensions.uninstall(x.id);
      if (!alive.current) return;
      setRemoval(receipt);
      setConfirming(null);
    });
  }

  async function choose() {
    await act('choose', async () => {
      const read = await window.wanigan.extensions.choose();
      if (!alive.current) return;
      // Null is a dismissed picker, not a failure. Say nothing and leave the
      // panel exactly as it was.
      if (!read) return;
      setInspection(read);
      setPanel('add');
    });
  }

  async function reread(directory: string) {
    await act('inspect', async () => {
      const read = await window.wanigan.extensions.inspect(directory);
      if (!alive.current) return;
      setInspection(read);
    });
  }

  /**
   * A store entry, reviewed. The main process fetches this exact version and
   * writes it out as an extension directory; the inspection it returns is shown
   * in the same consent panel, gated on the same review, as a folder picked by
   * hand. Nothing here installs.
   */
  async function reviewFromStore(sourceKey: string, name: string, version: string) {
    await act(`stage:${name}`, async () => {
      const read = await window.wanigan.store.stage(sourceKey, name, version);
      if (!alive.current) return;
      setInspection(read);
      setReviewedSha(null);
      setPanel('store');
      requestAnimationFrame(() => storePanel.current?.scrollIntoView({ block: 'start' }));
    });
  }

  async function install(target: ExtensionInspection) {
    // The digest travels exactly as it was handed over, so a manifest that
    // changed between the panel and the click is refused rather than installed
    // unseen. No digest means nothing was approvable in the first place.
    const sha = target.manifestSha256;
    if (!sha) return;
    // Installed from the store, the operator goes back to the store to keep
    // browsing; from a folder, to the list that now holds it.
    const fromStore = panel === 'store';
    await act('install', async () => {
      const next = await window.wanigan.extensions.install(target.path, sha);
      if (!alive.current) return;
      setList(next);
      setJustInstalled(fromStore ? next.find((x) => x.id === target.id) ?? null : null);
      setInspection(null);
      setSaved(null);
      setReviewedSha(null);
      setPanel('none');
      setModeChoice(fromStore ? 'store' : 'installed');
    });
  }

  async function loadOffer() {
    await act('exportable', async () => {
      const read = await window.wanigan.extensions.exportable();
      if (alive.current) setOffer(read);
    });
  }

  async function saveExtension() {
    // No path crosses this bridge: the destination is chosen in the main
    // process's own folder picker, and a dismissed picker answers null — which
    // is a person changing their mind, not a failure to report.
    await act('export', async () => {
      const written = await window.wanigan.extensions.export({
        id: newId.trim(), label: newLabel.trim(), mcpServerIds: servers,
      });
      if (alive.current && written) setSaved(written);
    });
  }

  function openPanel(next: Panel) {
    setPanel((current) => (current === next ? 'none' : next));
    setActionError(null);
    if (next === 'save' && offer === null && !locked) void loadOffer();
  }

  const active: { key: string; word: string; drop: () => void }[] = [
    ...provides.map((k) => ({ key: `p:${k}`, word: PROVIDE_READING[k].many, drop: () => setProvides((v) => toggleIn(v, k)) })),
    ...states.map((s) => ({ key: `s:${s}`, word: STATE_WORD[s], drop: () => setStates((v) => toggleIn(v, s)) })),
    ...origins.map((o) => ({ key: `o:${o}`, word: ORIGIN_READING[o], drop: () => setOrigins((v) => toggleIn(v, o)) })),
  ];

  return (
    <div className="pane ex-view">
      <PageHead
        title="Extensions"
        lead="Add and manage reusable tools, skills, and checks for your workspace."
        actions={
          <>
            <button type="button" className="btn btn-primary" disabled={locked}
                    aria-expanded={panel === 'add'} onClick={() => openPanel('add')}>
              Add from folder
            </button>
            <button type="button" className="btn" disabled={locked}
                    aria-expanded={panel === 'save'} onClick={() => openPanel('save')}>
              Save as extension
            </button>
            <button type="button" className="btn" disabled={locked} onClick={() => void refresh()}>
              {busy === null ? 'Re-read' : 'Working…'}
            </button>
          </>
        }
      />

      <Hint>These are Wanigan extensions. Claude Code plugins are managed separately in Plugins.</Hint>
      <Explainer id="extensions-what" title="What an extension is, and what Wanigan checks" defaultHidden>
        <p>
          An extension is a bundle of declarations, never a place to load code. Nothing it ships runs
          inside Wanigan: anything that has to compute runs out of process behind a protocol Wanigan
          already speaks, which today means an MCP server or a provider pack’s capability adapter.
        </p>
        <p>{SAFETY}</p>
        <p>
          These are not the plugins in the Plugins view. Those are Claude Code’s own, read out of
          <span className="mono"> ~/.claude</span> and installed with its CLI.
        </p>
      </Explainer>

      {listError && list !== null && (
        <Note tone="error" action={{ label: 'Try again', run: () => refresh() }}>
          The extension list could not be re-read, so this is the last one Wanigan saw. {listError}
        </Note>
      )}
      {actionError && (
        <Note tone="error" onDismiss={() => setActionError(null)}>{actionError}</Note>
      )}

      {panel === 'add' && (
        <section className="ex-panel" aria-label="Add an extension from a folder">
          <SectionHead label="Add from folder" right={
            <button type="button" className="btn btn-sm" onClick={() => setPanel('none')}>Close</button>
          } />
          <p className="ex-lead">
            Point Wanigan at a folder holding an extension manifest. Choosing a folder reads it and
            nothing else — no file is written and nothing is installed until you have opened what it
            declares and pressed the button yourself.
          </p>
          <div className="ex-actions">
            <button type="button" className="btn btn-primary" disabled={locked} onClick={() => void choose()}>
              {busy === 'choose' ? 'Waiting for the folder picker…' : 'Choose a folder…'}
            </button>
            {inspection && (
              <button type="button" className="btn" disabled={locked} onClick={() => void reread(inspection.path)}>
                {busy === 'inspect' ? 'Reading…' : 'Read that folder again'}
              </button>
            )}
          </div>
          {busy === 'inspect' && <Reading what="that folder" />}
          {inspection && (
            <InspectionPanel
              inspection={inspection}
              reviewed={inspection.manifestSha256 !== null && inspection.manifestSha256 === reviewedSha}
              busy={busy}
              onReview={() => setReviewedSha(inspection.manifestSha256)}
              onInstall={() => void install(inspection)}
            />
          )}
        </section>
      )}

      {panel === 'store' && inspection && (
        <section className="ex-panel" aria-label="Review a server from the store" ref={storePanel}>
          <SectionHead label="Review before installing" right={
            <button type="button" className="btn btn-sm" onClick={() => setPanel('none')}>Close</button>
          } />
          <p className="ex-lead">
            Wanigan fetched this exact version from the catalog and wrote it out as an extension, and has
            installed nothing. Open what it declares below — the command it runs, the host it reaches, anything
            it will ask you for — and press the button yourself if you want it. The registry verified who
            published it; it did not review what it does.
          </p>
          <InspectionPanel
            inspection={inspection}
            reviewed={inspection.manifestSha256 !== null && inspection.manifestSha256 === reviewedSha}
            busy={busy}
            onReview={() => setReviewedSha(inspection.manifestSha256)}
            onInstall={() => void install(inspection)}
          />
        </section>
      )}

      {panel === 'save' && (
        <section className="ex-panel" aria-label="Save as extension">
          <SectionHead label="Save as extension" right={
            <button type="button" className="btn btn-sm" onClick={() => setPanel('none')}>Close</button>
          } />
          <p className="ex-lead">
            Take what this Wanigan already has and write it out as a folder: one you can keep, hand to
            somebody, or install on another machine. This writes files and does nothing else — no
            credential value is copied into the bundle, and nothing is sent anywhere.
          </p>
          {offer === null ? (
            busy === 'exportable'
              ? <Reading what="what this Wanigan can save" />
              : (
                <button type="button" className="btn" disabled={locked} onClick={() => void loadOffer()}>
                  Read what can be saved
                </button>
              )
          ) : offer.mcpServers.length === 0 ? (
            <EmptyState
              posture="nothing-yet"
              title="Nothing to save yet"
              cue="Save as extension writes out the MCP servers this Wanigan is configured with, and none are configured. Add one in Settings and it will be offered here."
            />
          ) : (
            <div className="ex-form">
              <fieldset className="ex-fieldset">
                <legend className="sub">MCP servers to include</legend>
                <div className="ex-choices">
                  {offer.mcpServers.map((s) => (
                    <label className="ex-choice" key={s.id}>
                      <input
                        type="checkbox"
                        checked={servers.includes(s.id)}
                        disabled={locked}
                        onChange={() => setServers((v) => toggleIn(v, s.id))}
                      />
                      <span className="ex-choice-copy">
                        <strong>{s.name}</strong>
                        <span className="ex-detail">{s.detail}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="ex-field">
                <label className="label" htmlFor="ex-new-id">Extension id</label>
                <input id="ex-new-id" className="field" value={newId} disabled={locked}
                       placeholder="acme-search" onChange={(e) => setNewId(e.target.value)} />
                <Hint>How the bundle is identified once installed. Keep it lowercase and stable.</Hint>
              </div>
              <div className="ex-field">
                <label className="label" htmlFor="ex-new-label">Name</label>
                <input id="ex-new-label" className="field" value={newLabel} disabled={locked}
                       placeholder="Acme Search" onChange={(e) => setNewLabel(e.target.value)} />
                <Hint>What a person reads on the card.</Hint>
              </div>
              <div className="ex-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={locked || !newId.trim() || !newLabel.trim() || servers.length === 0}
                  onClick={() => void saveExtension()}
                >
                  {busy === 'export' ? 'Writing…' : 'Choose a folder and write it'}
                </button>
              </div>
              <Hint>Wanigan asks where to write it in a folder picker of its own. Close that picker and nothing is written.</Hint>
              {(!newId.trim() || !newLabel.trim() || servers.length === 0) && (
                <Hint>An id, a name and at least one server are needed before this can be written.</Hint>
              )}
            </div>
          )}
          {saved && (
            <div className="ex-saved">
              <SectionHead label="Written" />
              <p className="ex-lead">
                Here is the bundle Wanigan just wrote, read back from disk the same way a stranger’s
                folder would be. Install it here, or hand the folder to somebody else.
              </p>
              <InspectionPanel
                inspection={saved}
                reviewed={saved.manifestSha256 !== null && saved.manifestSha256 === reviewedSha}
                busy={busy}
                onReview={() => setReviewedSha(saved.manifestSha256)}
                onInstall={() => void install(saved)}
              />
            </div>
          )}
        </section>
      )}

      {removal && (
        <RemovalReceipt removal={removal} onDismiss={() => setRemoval(null)} />
      )}

      <div className="ex-toolbar">
        <Segmented<Mode>
          label="Extension view"
          value={mode}
          onChange={setModeChoice}
          options={[
            { value: 'store', label: 'Store' },
            { value: 'browse', label: 'Browse' },
            { value: 'installed', label: `Installed${list ? ` (${num(rows.length)})` : ''}` },
          ]}
        />
        {mode !== 'store' && (<>
        <div className="ex-search">
          <label className="label" htmlFor="ex-search">Search</label>
          <input
            id="ex-search"
            ref={search}
            type="search"
            className="field"
            value={query}
            placeholder="Name, publisher, or a server it provides"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setQuery(''); } }}
          />
          <Hint>Press / to jump here, Escape to clear. Searches names, publishers, descriptions and every server, skill or gate an extension declares.</Hint>
        </div>
        <Segmented<Sort>
          label="Sort extensions"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'updated', label: 'Recently updated' },
            { value: 'name', label: 'Name' },
            { value: 'publisher', label: 'Publisher' },
          ]}
        />
        </>)}
      </div>

      {mode === 'store' ? (
        <McpStore
          installed={rows}
          busy={busy}
          justInstalled={justInstalled}
          onDismissInstalled={() => setJustInstalled(null)}
          onReview={(key, name, version) => void reviewFromStore(key, name, version)}
        />
      ) : (<>
      {list !== null && rows.length > 0 && (
        <div className="ex-facets">
          <div className="ex-facet-row">
            <span className="sub">Provides</span>
            {PROVIDE_ORDER.map((k) => {
              const n = facetCounts.provides.get(k) ?? 0;
              if (n === 0) return null;
              return (
                <Chip key={k} pressed={provides.includes(k)} count={n}
                      onToggle={() => setProvides((v) => toggleIn(v, k))}>
                  {PROVIDE_READING[k].many}
                </Chip>
              );
            })}
          </div>
          <div className="ex-facet-row">
            <span className="sub">State</span>
            {STATE_ORDER.map((s) => {
              const n = facetCounts.states.get(s) ?? 0;
              if (n === 0) return null;
              return (
                <Chip key={s} pressed={states.includes(s)} count={n}
                      onToggle={() => setStates((v) => toggleIn(v, s))}>
                  {STATE_WORD[s]}
                </Chip>
              );
            })}
          </div>
          <div className="ex-facet-row">
            <span className="sub">Origin</span>
            {ORIGIN_ORDER.map((o) => {
              const n = facetCounts.origins.get(o) ?? 0;
              if (n === 0) return null;
              return (
                <Chip key={o} pressed={origins.includes(o)} count={n}
                      onToggle={() => setOrigins((v) => toggleIn(v, o))}>
                  {ORIGIN_READING[o]}
                </Chip>
              );
            })}
          </div>
        </div>
      )}

      {/* A filtered list that looks like an empty list is the bug: every filter
          in force is printed here, and each one is its own way back out. */}
      {(filters > 0 || needle) && (
        <div className="ex-active">
          <span className="sub">Showing only</span>
          {needle && (
            <button type="button" className="ex-drop" onClick={() => setQuery('')}>
              “{query.trim()}”<span aria-hidden="true"> ×</span>
              <span className="sr-only"> — clear this search</span>
            </button>
          )}
          {active.map((a) => (
            <button type="button" className="ex-drop" key={a.key} onClick={a.drop}>
              {a.word}<span aria-hidden="true"> ×</span>
              <span className="sr-only"> — remove this filter</span>
            </button>
          ))}
          <button type="button" className="btn btn-sm" onClick={clearAll}>Clear all</button>
        </div>
      )}

      {mode === 'installed' && list !== null && rows.length > 0 && (
        <div className="row3">
          <Stat label="Installed" value={num(rows.length)} />
          <Stat label="Enabled" value={num(enabledCount)} sub={`${num(rows.length - enabledCount)} not active`} />
          <Stat label="Declared, not applied" value={num(heldCount)}
                sub={heldCount === 0 ? 'Everything declared is in place' : 'Each one says why on its card'} />
        </div>
      )}

      {list === null ? (
        listError ? (
          <EmptyState
            posture="could-not-read"
            title="The extension list could not be read"
            cue={listError}
            action={<button type="button" className="btn" onClick={() => void refresh()}>Try again</button>}
          />
        ) : (
          // Not answered yet is not the same as nothing installed, and the
          // difference lasts exactly as long as the first read.
          <Reading what="the extensions this Wanigan holds" />
        )
      ) : shown.length === 0 ? (
        rows.length === 0 ? (
          <EmptyState
            posture="nothing-yet"
            title="Nothing here yet"
            cue="Browse lists every extension this Wanigan holds: the folders you add, and the bundles you save out of your own configuration. There is no remote catalogue yet, so nothing appears here until one of those happens."
            action={
              <div className="ex-actions">
                <button type="button" className="btn btn-primary" onClick={() => openPanel('add')}>Add from folder</button>
                <button type="button" className="btn" onClick={() => openPanel('save')}>Save as extension</button>
              </div>
            }
          />
        ) : (
          <EmptyState
            posture="nothing-in-scope"
            title={needle ? `Nothing matches “${query.trim()}”` : 'Nothing matches these filters'}
            cue={
              needle && filters > 0
                ? `${num(rows.length)} installed, and none of them matches that search with ${filters === 1 ? 'that filter' : 'those filters'} in force.`
                : needle
                  ? `${num(rows.length)} installed. The search reads names, ids, publishers, descriptions and declared servers, skills and gates.`
                  : `${num(rows.length)} installed, none inside ${filters === 1 ? 'this filter' : 'these filters'}.`
            }
            action={<button type="button" className="btn" onClick={clearAll}>Clear search and filters</button>}
          />
        )
      ) : (
        <>
          <SectionHead
            label={mode === 'browse' ? 'Everything this Wanigan holds' : 'Installed'}
            count={shown.length}
            right={heldShown > 0
              ? <Mark glyph="!" word={`${num(heldShown)} declared, not applied`} tone="warn" />
              : undefined}
          />
          <div className={mode === 'browse' ? 'ex-grid' : 'ex-rows'}>
            {shown.map((x) => (
              <ExtensionCard
                key={x.id}
                x={x}
                dense={mode === 'installed'}
                busy={busy}
                update={update?.id === x.id ? update : null}
                confirming={confirming === x.id}
                onConfirm={() => setConfirming(x.id)}
                onCancel={() => setConfirming(null)}
                onToggle={(enabled) => void setEnabled(x, enabled)}
                onUninstall={() => uninstall(x)}
                onReviewUpdate={() => setPanel('add')}
                onCredentials={setList}
              />
            ))}
          </div>
        </>
      )}
      </>)}
    </div>
  );
}

/** One store card. Identity, what it provides, its state, and what it held back. */
function ExtensionCard({ x, dense, busy, update, confirming, onConfirm, onCancel, onToggle, onUninstall, onReviewUpdate, onCredentials }: {
  x: ExtensionInfo;
  /** A fresh list after a credential this extension declares is saved or removed. */
  onCredentials: (list: ExtensionInfo[]) => void;
  dense: boolean;
  busy: string | null;
  update: { from: string; to: string } | null;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onToggle: (enabled: boolean) => void;
  onUninstall: () => Promise<void>;
  onReviewUpdate: () => void;
}) {
  const status = STATUS_READING[x.status];
  const held = x.artifacts.filter((a) => !a.applied);
  const locked = busy !== null;
  return (
    <article className={`ex-card${dense ? ' dense' : ''}`}>
      <div className="ex-card-head">
        <div className="ex-identity">
          <h3 className="ex-title">{x.label}</h3>
          <span className="ex-ver mono">{x.version}</span>
          <Mark glyph={status.glyph} word={status.word} tone={status.tone} />
        </div>
        <div className="ex-card-actions">
          <label className="ex-switch">
            <input
              type="checkbox"
              checked={x.enabled}
              disabled={locked || x.status === 'invalid'}
              onChange={(e) => onToggle(e.target.checked)}
            />
            <span>{x.enabled ? 'On' : 'Off'}</span>
            <span className="sr-only">{x.label}</span>
          </label>
          <button type="button" className="btn btn-sm btn-danger" disabled={locked} onClick={onConfirm}>
            Uninstall
          </button>
        </div>
      </div>

      <p className="ex-sub">{x.description || 'This manifest carries no description.'}</p>
      <p className="ex-meta">
        {publisherLine(x.publisher)} · {ORIGIN_READING[x.origin]} · installed {ago(x.installedAt)}
        {x.updatedAt !== x.installedAt ? `, updated ${ago(x.updatedAt)}` : ''}
      </p>

      <div className="ex-provides">
        {providesOf(x).map(({ kind, n }) => (
          <Mark key={kind} glyph={PROVIDE_READING[kind].glyph} word={provideWord(kind, n)} tone="quiet" />
        ))}
        {x.artifacts.length === 0 && <span className="ex-detail">Declares nothing.</span>}
      </div>

      <p className="ex-blurb">{status.blurb}</p>

      {/* What it asks for. Before this, a declared credential could be named on
          the consent screen and never given a value. */}
      {x.status !== 'invalid' && x.credentials.length > 0 && (
        <ExtensionCredentials extension={x} onChanged={onCredentials} />
      )}

      {x.status === 'invalid' && x.errors.length > 0 && (
        <Note tone="error" role="none">
          <strong>Every reason Wanigan could not read this</strong>
          <ul className="ex-errors">
            {x.errors.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </Note>
      )}

      {update && (
        <Note tone="info" role="none" action={{ label: 'Review the update', run: () => onReviewUpdate() }}>
          The folder you just read holds version {update.to} of this extension; {update.from} is what is
          installed. An update goes through the same consent panel as a first install.
        </Note>
      )}

      {/* The card's most important sentence. It stays on the card, at full size,
          whether or not anybody opens the inventory below. */}
      {held.length > 0 && (
        <div className="ex-held">
          <SectionHead label="Declared, not applied" count={held.length} />
          <p className="ex-blurb">
            Wanigan installed the rest. These it recorded and left alone, and here is what it said about
            each one.
          </p>
          <ul className="ex-artifacts">
            {held.map((a) => <ArtifactRow key={artifactKey(a)} a={a} mode="installed" />)}
          </ul>
        </div>
      )}

      {x.artifacts.length > 0 && (
        <details className="ex-disclosure">
          <summary>Everything it declares ({num(x.artifacts.length)})</summary>
          <ul className="ex-artifacts">
            {x.artifacts.map((a) => <ArtifactRow key={artifactKey(a)} a={a} mode="installed" />)}
          </ul>
          {x.sourcePath && <p className="ex-path">{x.sourcePath}</p>}
          <p className="ex-path">
            manifest {x.manifestSha256}
            {x.trustedSha256 === x.manifestSha256 ? ' · approved' : ' · these bytes are not the approved ones'}
          </p>
        </details>
      )}

      {confirming && (
        <ConfirmNote
          tone="error"
          busy={locked}
          what={
            <>
              <strong>Uninstall {x.label}?</strong>
              <p>
                Wanigan removes the {num(x.artifacts.filter((a) => a.applied).length)} row
                {x.artifacts.filter((a) => a.applied).length === 1 ? '' : 's'} it applied for this
                extension. Anything you have edited since is kept, and the receipt names it.
              </p>
            </>
          }
          verb="Uninstall"
          onRun={onUninstall}
          onCancel={onCancel}
        />
      )}
    </article>
  );
}

function ArtifactRow({ a, mode }: { a: ExtensionArtifactInfo; mode: ArtifactMode }) {
  const reading = artifactReading(a, mode);
  const flagged = !a.applied && (mode === 'installed' || mode === 'planned');
  return (
    <li className={`ex-artifact${flagged ? ' held' : ''}`}>
      <span className="ex-kind">{PROVIDE_READING[a.kind].one}</span>
      <div className="ex-artifact-copy">
        <strong className="ex-ref">{a.ref}</strong>
        <Mark glyph={reading.glyph} word={reading.word} tone={reading.tone} />
        {a.detail && <span className="ex-detail">{a.detail}</span>}
        {a.projectId && <span className="ex-detail">Project {a.projectId}</span>}
        {reading.note && <p className="ex-reason">{reading.note}</p>}
      </div>
    </li>
  );
}

/** The consent panel plus the install button, for a folder or a fresh export. */
function InspectionPanel({ inspection, reviewed, busy, onReview, onInstall }: {
  inspection: ExtensionInspection;
  reviewed: boolean;
  busy: string | null;
  onReview: () => void;
  onInstall: () => void;
}) {
  const locked = busy !== null;
  const installable = inspection.ok && inspection.manifestSha256 !== null && reviewed && !locked;
  const verb = inspection.installedVersion
    ? `Update from ${inspection.installedVersion} to ${inspection.version ?? 'this version'}`
    : `Install ${inspection.label ?? 'this extension'}`;
  return (
    <div className="ex-inspect">
      <div className="ex-card-head">
        <div className="ex-identity">
          <h3 className="ex-title">{inspection.label ?? 'Unnamed bundle'}</h3>
          {inspection.version && <span className="ex-ver mono">{inspection.version}</span>}
          <Mark
            glyph={inspection.ok ? '✓' : '✕'}
            word={inspection.ok ? 'Shaped like an extension' : 'Cannot be read'}
            tone={inspection.ok ? 'ok' : 'serious'}
          />
        </div>
      </div>
      <p className="ex-path">{inspection.path}</p>
      <p className="ex-sub">{inspection.description ?? 'This manifest carries no description.'}</p>
      <p className="ex-meta">
        {publisherLine(inspection.publisher)}
        {inspection.id ? ` · id ${inspection.id}` : ''}
      </p>
      <p className="ex-path">manifest {inspection.manifestSha256 ?? 'no digest — nothing here can be approved'}</p>

      {inspection.errors.length > 0 && (
        <Note tone="error" role="none">
          <strong>Every reason this cannot be installed</strong>
          <ul className="ex-errors">{inspection.errors.map((line, i) => <li key={i}>{line}</li>)}</ul>
        </Note>
      )}
      {inspection.warnings.length > 0 && (
        <Note tone="warn" role="none">
          <strong>Readable, with {num(inspection.warnings.length)} thing{inspection.warnings.length === 1 ? '' : 's'} worth knowing</strong>
          <ul className="ex-errors">{inspection.warnings.map((line, i) => <li key={i}>{line}</li>)}</ul>
        </Note>
      )}
      {inspection.installedVersion && (
        <Note tone="info" role="none">
          Version {inspection.installedVersion} of this extension is already installed here. Installing
          replaces it with {inspection.version ?? 'the version in this folder'}.
        </Note>
      )}

      {reviewed ? (
        <Declares lines={inspection.consent} />
      ) : (
        <div className="ex-gate">
          <p className="ex-blurb">
            This folder declares {num(inspection.consent.length)} thing
            {inspection.consent.length === 1 ? '' : 's'} that outlive the click: programs that will run
            here, hosts that will be reached, credentials it will ask for, files it will write.
          </p>
          <button type="button" className="btn" onClick={onReview}>
            Show what this will do
          </button>
        </div>
      )}

      {inspection.artifacts.length > 0 && (
        <div className="ex-held">
          <SectionHead label="What it would create" count={inspection.artifacts.length} />
          <ul className="ex-artifacts">
            {inspection.artifacts.map((a) => <ArtifactRow key={artifactKey(a)} a={a} mode="planned" />)}
          </ul>
        </div>
      )}

      <p className="ex-safety">{SAFETY}</p>
      <div className="ex-actions">
        <button type="button" className="btn btn-primary" disabled={!installable} onClick={onInstall}>
          {busy === 'install' ? 'Installing…' : verb}
        </button>
      </div>
      {!reviewed && inspection.ok && (
        <Hint>Install turns on once you have opened what this extension declares.</Hint>
      )}
      {!inspection.ok && (
        <Hint>Nothing can be installed from this folder while Wanigan cannot read it.</Hint>
      )}
    </div>
  );
}

/** Consent, grouped, with each group saying what that kind of line means. */
function Declares({ lines }: { lines: ExtensionConsentLine[] }) {
  const groups = CONSENT_GROUPS
    .map((g) => ({ ...g, lines: lines.filter((l) => l.kind === g.kind) }))
    .filter((g) => g.lines.length > 0);
  if (groups.length === 0) {
    return (
      <p className="ex-blurb">
        This bundle declares nothing that outlives the click: no program to run, no host to reach, no
        credential to ask for, no file to write.
      </p>
    );
  }
  return (
    <div className="ex-consent">
      {groups.map((g) => (
        <section className="ex-group" key={g.kind}>
          <SectionHead label={g.heading} count={g.lines.length} />
          <p className="ex-group-meaning">{g.meaning}</p>
          <ul className="ex-lines">
            {g.lines.map((l, i) => <li className="ex-line mono" key={`${g.kind}-${i}`}>{l.text}</li>)}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** What an uninstall did: what went, and what stayed because a person edited it. */
function RemovalReceipt({ removal, onDismiss }: { removal: ExtensionRemoval; onDismiss: () => void }) {
  return (
    <section className="ex-removal" aria-label="What the uninstall did">
      <SectionHead
        label={`Uninstalled ${removal.pluginId}`}
        right={<button type="button" className="btn btn-sm" onClick={onDismiss}>Dismiss</button>}
      />
      <p className="ex-blurb">{removal.detail}</p>
      <div className="ex-removal-group">
        <span className="sub">Removed</span>
        {removal.removed.length === 0 ? (
          <p className="ex-blurb">Nothing was removed: this extension had applied nothing.</p>
        ) : (
          <ul className="ex-artifacts">
            {removal.removed.map((a) => <ArtifactRow key={artifactKey(a)} a={a} mode="removed" />)}
          </ul>
        )}
      </div>
      {removal.kept.length > 0 && (
        <div className="ex-removal-group">
          <span className="sub">Kept</span>
          <p className="ex-blurb">
            An extension does not own a row you have since changed. These {num(removal.kept.length)} stayed
            exactly as you left them — that is the rule working, not the uninstall falling short — and each
            one says why.
          </p>
          <ul className="ex-artifacts">
            {removal.kept.map((a) => <ArtifactRow key={artifactKey(a)} a={a} mode="kept" />)}
          </ul>
        </div>
      )}
    </section>
  );
}
