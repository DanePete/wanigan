// Editing a part where it shows: a sheet beside the part, over the page's last
// frame (a native view draws above the window, so the live view steps aside
// while the sheet is open). The platform's own form opens inside it in a view
// of the site's session, and closes itself when the site says it saved; a
// target the helper describes with a schema is a small form drawn here, saved
// through the main process. Either way the page reloads with the change.
// Formatted text (a string the schema calls HTML) is edited as its words when it
// holds no tag, sent escaped, and as its HTML when it holds inline tags, with the
// tags the site keeps said (shared/live-schema.ts htmlMode()). A target that
// shows beyond this page (a template, a synced pattern, a menu, a widget, a
// setting) says where, and its save is asked first (shared/live-trace.ts
// editNotice()), as taking out a shared item is.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { LiveRegion } from '@shared/live';
import { placeSheet, type Box } from '@shared/live-lens';
import { draftOf, htmlMode, schemaForm, valueOf, type Draft, type SchemaField, type SchemaForm } from '@shared/live-schema';
import { WORDPRESS_INLINE_TAGS, tagsIn } from '@shared/rich-text';
import type { SaveAi } from '@shared/live-ai';
import { editNotice, saveOf, type EditTarget, type LiveTrace } from '@shared/live-trace';
import { liveBridge, useCoversLive, useLiveCovers } from '../../lib/live';
import { Select } from '../Select';
import { Button, IconButton, useFocusTrap, useSingleFlight } from '../ui';
import { SavesNote } from './SiteAi';

export interface EditRequest { target: EditTarget; region: LiveRegion | null }

const NATIVE = { width: 480, height: 560 };
const SCHEMA = { width: 400, height: 520 };

export function EditSheet({ request, stage, device, cms, trace, onClose, onSaved }: {
  request: EditRequest;
  /** The stage the sheet sits in, and the device box the page is laid over inside it. */
  stage: RefObject<HTMLDivElement | null>;
  device: RefObject<HTMLDivElement | null>;
  /** "Drupal" or "WordPress", for saying whose form it is. */
  cms: string;
  /** The page's trace: what else saving runs, and what the site's AI Client is. */
  trace: LiveTrace | null;
  onClose: () => void;
  /** Saved: its revision, what the site's AI did during it (WordPress), and the value sent (a schema edit's). */
  onSaved: (target: EditTarget, revision: string | null, ai?: SaveAi | null, sent?: unknown) => void;
}) {
  const live = liveBridge();
  const { target, region } = request;
  const native = target.via === 'native-form';
  const sheet = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [error, setError] = useState<string | null>(null);
  useCoversLive();
  useFocusTrap(sheet, onClose, native ? 'button' : 'input, textarea, select, button');

  // Beside the part, inside the stage; in its top right corner when the part is off screen.
  useLayoutEffect(() => {
    let current = true;
    void (async () => {
      const st = stage.current;
      const dv = device.current;
      if (!st || !dv || !live) return;
      const r = region ? await live.where(region.index) : null;
      const anchor = r ? { x: r.x + dv.offsetLeft, y: r.y + dv.offsetTop, width: r.width, height: r.height } : null;
      if (current) setBox(placeSheet(anchor, { x: 0, y: 0, width: st.clientWidth, height: st.clientHeight }, native ? NATIVE : SCHEMA));
    })();
    return () => { current = false; };
  }, [live, stage, device, region, native]);

  useEffect(() => live?.onEdited((e) => {
    if (e.target !== target.id) return;
    if (e.saved) onSaved(target, null);
    else if (e.error) setError(e.error);
    else onClose();
  }), [live, target, onSaved, onClose]);

  const title = `Edit ${target.label}`;
  return (
    <div className={`live-sheet${native ? ' native' : ''}`} ref={sheet} role="dialog" aria-modal="true" aria-label={title}
      style={box ? { left: box.x, top: box.y, width: box.width, ...(native ? { height: box.height } : { maxHeight: box.height }) } : { visibility: 'hidden' }}>
      <header className="live-sheet-head">
        <div>
          <h2 className="live-side-title">{title}</h2>
          <p className="faint small">
            {native ? `${cms}’s own form, saved by ${cms} as you${target.revisions ? ', as a new revision' : ''}.`
              : `Checked by ${cms} when you save${target.revisions ? ', and kept as a new revision' : ''}.`}
          </p>
          {target.shows ? <p className="small live-sheet-reach">Saving it changes {target.shows}, not only this page.</p> : null}
        </div>
        <IconButton icon="close" label="Close without saving (Escape)" onClick={onClose} />
      </header>
      {error ? <p className="live-sheet-error small" role="alert">{error}</p> : null}
      {/* Before anything is saved: what else saving it runs, which Wanigan cannot see into. */}
      <SavesNote save={saveOf(trace, target)} ai={trace?.ai} />
      {native ? (box && !error ? <NativeForm target={target} /> : null)
        : <SchemaEdit target={target} cms={cms} wordpress={trace?.platform === 'wordpress'} aiClient={!!trace?.ai?.client} onSaved={(revision, ai, sent) => onSaved(target, revision, ai, sent)} onClose={onClose} onError={setError} />}
    </div>
  );
}

/** Where the site's own form is laid: the main process puts its view over this box and keeps it there. */
function NativeForm({ target }: { target: EditTarget }) {
  const live = liveBridge();
  const body = useRef<HTMLDivElement>(null);
  const covers = useLiveCovers();
  const [failed, setFailed] = useState<string | null>(null);
  // Something over the sheet too (a dialog, a menu): the form steps aside as the page does.
  const hidden = covers > 1;
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || !live) return;
    const rect = (): Box => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; };
    void live.editOpen(target.id, rect()).then((r) => { if (!r.ok) setFailed(r.error); });
    const moved = (): void => live.editBounds(rect());
    const observer = new ResizeObserver(moved);
    observer.observe(el);
    window.addEventListener('resize', moved);
    return () => { observer.disconnect(); window.removeEventListener('resize', moved); void live.editClose(); };
  }, [live, target.id]);
  useEffect(() => {
    const el = body.current;
    if (!el || !live) return;
    const b = el.getBoundingClientRect();
    live.editBounds(hidden ? { x: b.left, y: b.top, width: 0, height: 0 } : { x: b.left, y: b.top, width: b.width, height: b.height });
  }, [hidden, live]);
  return (
    <div className="live-sheet-native" ref={body}>
      <p className="faint small">{failed ?? 'Opening the form…'}</p>
    </div>
  );
}

function SchemaEdit({ target, cms, wordpress, aiClient, onSaved, onClose, onError }: {
  target: EditTarget;
  cms: string;
  /** The trace is the WordPress helper's: formatted text is kept by its rules (the inline tags it keeps). */
  wordpress: boolean;
  /** WordPress core's AI Client is on the site: the owner may stop it for this one save. */
  aiClient: boolean;
  onSaved: (revision: string | null, ai: SaveAi | null, sent: unknown) => void; onClose: () => void; onError: (e: string | null) => void;
}) {
  const live = liveBridge();
  const [form] = useState<SchemaForm | null>(() => schemaForm(target.schema));
  const [draft, setDraft] = useState<Draft>(() => (form ? draftOf(form, target.value) : {}));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [noSiteAi, setNoSiteAi] = useState(false);
  /** A save of something shown beyond this page, waiting for the owner's yes. */
  const [asking, setAsking] = useState(false);
  const notice = editNotice(target);
  const once = useSingleFlight();
  if (!form) {
    return (
      <div className="live-sheet-body">
        <p className="small">This edit has a shape Wanigan does not draw as a form (nested values, or a choice of kinds). Change it in the site’s own admin, or ask an agent.</p>
        <div className="live-sheet-foot"><Button tone="quiet" onClick={onClose}>Close</Button></div>
      </div>
    );
  }
  const set = (name: string, v: Draft[string]): void => { setDraft((d) => ({ ...d, [name]: v })); setErrors((e) => { const { [name]: _gone, ...rest } = e; return rest; }); };
  const save = async (confirmed = false): Promise<void> => {
    onError(null);
    const out = valueOf(form, draft, target.value);
    if ('errors' in out) { setErrors(out.errors); setAsking(false); return; }
    // Shown beyond this page: said, and saved only on the owner's yes.
    if (notice && !confirmed) { setAsking(true); return; }
    setAsking(false);
    setSaving(true);
    const result = await live?.editSave(target.id, out.value, noSiteAi ? { noSiteAi: true } : undefined);
    setSaving(false);
    if (!result?.ok) { onError(result?.error ?? 'The site did not save it.'); return; }
    onSaved(result.revision, result.ai ?? null, out.value);
  };
  // Enter in a field and the Save button are one submit; a second while saving does nothing.
  return (
    <form className="live-sheet-body" onSubmit={(e) => { e.preventDefault(); void once(save); }} noValidate>
      {form.fields.map((f) => {
        const mode = htmlMode(form, f, target.value);
        const was = form.object ? (target.value as Record<string, unknown> | undefined)?.[f.name] : target.value;
        return <FieldInput key={f.name || 'value'} field={f} html={mode ? { mode, holds: typeof was === 'string' ? tagsIn(was) : [], wordpress, cms } : null}
          value={draft[f.name]} error={errors[f.name] ?? null} onChange={(v) => set(f.name, v)} />;
      })}
      {form.kept.length ? <p className="faint small">Kept as they are (not drawn here): {form.kept.join(', ')}.</p> : null}
      {aiClient ? (
        <div className="field">
          <label className="live-check">
            <input type="checkbox" checked={noSiteAi} aria-describedby="live-no-site-ai-hint" onChange={(e) => setNoSiteAi(e.target.checked)} />
            <span>Save without the site’s AI Client</span>
          </label>
          <p className="field-hint" id="live-no-site-ai-hint">
            For this save only, WordPress core’s AI Client refuses every prompt. It stops only AI that goes through core’s AI Client: a plugin that calls a provider on its own is not stopped.
          </p>
        </div>
      ) : null}
      {/* Keyed apart: reused, Back's button would turn into Save's submit while its click is still running, and ask again. */}
      {asking && notice ? (
        <div key="ask" className="live-sheet-foot ask" role="group" aria-labelledby="live-sheet-ask">
          <p className="small live-sheet-ask" id="live-sheet-ask">{notice} Save it there?</p>
          <Button tone="quiet" onClick={() => setAsking(false)}>Back</Button>
          <Button tone="primary" icon="check" autoFocus disabled={saving} onClick={() => once(() => save(true))}>{saving ? 'Saving…' : 'Save wherever it shows'}</Button>
        </div>
      ) : (
        <div key="foot" className="live-sheet-foot">
          <Button tone="quiet" onClick={onClose}>Cancel</Button>
          <Button type="submit" tone="primary" icon="check" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      )}
    </form>
  );
}

/** A string the schema calls HTML: edited as its words, or as its HTML; the tags it holds now; whose rules keep it. */
interface HtmlField { mode: 'words' | 'markup'; holds: string[]; wordpress: boolean; cms: string }

/** What a field of formatted text says under it: how what is typed is saved, and, as HTML, which tags the site keeps. */
function htmlHint(h: HtmlField): string {
  if (h.mode === 'words') return 'Its words, as the page shows them. What you type is saved as words: an & or a < stays a character, never markup.';
  const own = h.holds.filter((t) => !(WORDPRESS_INLINE_TAGS as readonly string[]).includes(t));
  return h.wordpress
    ? `Formatted text, shown as its HTML: change the words between the tags. Only these inline tags are kept: ${WORDPRESS_INLINE_TAGS.map((t) => `<${t}>`).join(' ')}${own.length ? `, and ${own.map((t) => `<${t}>`).join(' ')}, which it holds already` : ''}. WordPress refuses any other tag, and cleans what it keeps (wp_kses_post()).`
    : `Formatted text, shown as its HTML: change the words between the tags. ${h.cms} cleans the markup when it saves.`;
}

function FieldInput({ field: f, html, value, error, onChange }: { field: SchemaField; html: HtmlField | null; value: Draft[string] | undefined; error: string | null; onChange: (v: Draft[string]) => void }) {
  const id = `live-schema-${f.name || 'value'}`;
  // Formatted text says how it is saved in place of the site's description of it, which speaks of HTML; as HTML, both.
  const description = html?.mode === 'words' ? null : f.description;
  const described = [description ? `${id}-hint` : null, html ? `${id}-html` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  const text = typeof value === 'string' ? value : '';
  const common = { id, 'aria-invalid': error ? true : undefined, 'aria-describedby': described, 'aria-required': f.required || undefined } as const;
  const control = (() => {
    switch (f.kind) {
      case 'string':
        return f.multiline
          ? <textarea {...common} className={html?.mode === 'markup' ? 'mono' : undefined} spellCheck={html?.mode === 'markup' ? false : undefined} rows={4} value={text} maxLength={f.maxLength ?? undefined} onChange={(e) => onChange(e.target.value)} />
          : <input {...common} value={text} maxLength={f.maxLength ?? undefined} onChange={(e) => onChange(e.target.value)} />;
      case 'number':
        return <input {...common} inputMode={f.integer ? 'numeric' : 'decimal'} value={text} onChange={(e) => onChange(e.target.value)} />;
      case 'boolean':
        return null;
      case 'choice':
        return (
          <Select<string> id={id} value={text} onChange={onChange}
            options={[...(f.required ? [] : [{ value: '', label: '—' }]), ...f.options.map((o, i) => ({ value: String(i), label: o.label }))]} />
        );
      case 'strings': {
        const list = Array.isArray(value) ? value : [];
        return (
          <div className="live-strings" role="group" aria-labelledby={`${id}-label`} aria-describedby={described}>
            {list.map((item, i) => (
              <div key={i} className="live-strings-row">
                <input aria-label={`${f.title} ${i + 1}`} value={item} maxLength={f.maxLength ?? undefined} onChange={(e) => onChange(list.map((x, j) => (j === i ? e.target.value : x)))} />
                <IconButton icon="close" label={`Remove ${f.title} ${i + 1}`} onClick={() => onChange(list.filter((_, j) => j !== i))} />
              </div>
            ))}
            <div><Button size="s" tone="quiet" icon="plus" disabled={f.maxItems !== null && list.length >= f.maxItems} onClick={() => onChange([...list, ''])}>Add an item</Button></div>
          </div>
        );
      }
    }
  })();
  return (
    <div className="field">
      {f.kind === 'boolean' ? (
        <label className="live-check">
          <input type="checkbox" checked={value === true} aria-describedby={described} onChange={(e) => onChange(e.target.checked)} />
          <span>{f.title}</span>
        </label>
      ) : f.kind === 'strings' ? <span className="field-label" id={`${id}-label`}>{f.title}{f.required ? ' *' : ''}</span>
        : <label htmlFor={id}>{f.title}{html?.mode === 'markup' ? ' (HTML)' : ''}{f.required ? ' *' : ''}</label>}
      {control}
      {description ? <p className="field-hint" id={`${id}-hint`}>{description}</p> : null}
      {html ? <p className="field-hint" id={`${id}-html`}>{htmlHint(html)}</p> : null}
      {f.kind === 'string' && f.maxLength !== null ? <p className="field-hint">{text.length} of {f.maxLength}</p> : null}
      {error ? <p className="field-error small" id={`${id}-error`}>{error}</p> : null}
    </div>
  );
}
