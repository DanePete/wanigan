// One conflicted file, resolved in place. Each conflict shows our side and
// theirs side by side (and, when asked, the base they both came from), in the
// diff's colours; it is resolved by taking ours, theirs, both in either order,
// or text written by hand, and the result shows under it as the choices are
// made. The whole file can be taken from one side instead. "Mark resolved"
// writes the result and stages it, and asks before keeping any markers. The
// states with no text to merge (deleted on one side, a binary file) get the
// choices that fit them.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { CONFLICT_STATES, chosenLines, conflictCount, parseConflicts, resolveConflicts, type ConflictHunk, type HunkChoice } from '@shared/conflict';
import type { StatusEntry } from '@shared/git';
import { languageFor, tokenizeLine, START, type Lang } from '@shared/syntax';
import { pieces } from '@shared/diff';
import { attempt, call, useQuery } from '../../lib/api';
import { plural } from '../../lib/format';
import { Icon } from '../../components/icons';
import { Button, useToast } from '../../components/ui';
import { Confirm, WhoLine, type Where } from './common';

/** Unchanged lines kept on each side of a conflict; the rest fold away. */
const CONTEXT = 3;

type ChoiceName = Exclude<HunkChoice, { text: string }> | 'edit';

const CHOICES: { value: ChoiceName; label: string; hint: string }[] = [
  { value: 'ours', label: 'Ours', hint: 'Keep our lines, drop theirs' },
  { value: 'theirs', label: 'Theirs', hint: 'Keep their lines, drop ours' },
  { value: 'ours-then-theirs', label: 'Both, ours first', hint: 'Keep both: our lines, then theirs' },
  { value: 'theirs-then-ours', label: 'Both, theirs first', hint: 'Keep both: their lines, then ours' },
  { value: 'edit', label: 'Edit', hint: 'Write the result by hand' },
];

const nameOf = (c: HunkChoice | undefined): ChoiceName | null => (c === undefined ? null : typeof c === 'object' ? 'edit' : c);

export function Resolver({ where, file, load, busy, busyWhy }: {
  where: Where; file: StatusEntry; load: boolean; busy: boolean; busyWhy?: string;
}) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const id = useId();
  // Read again when the file's own status changes (an edit, a count), not on every git event:
  // once it is resolved this goes with the list, and must not ask for a file no longer conflicted.
  const read = useQuery('git.conflict', load ? { ...where, path: file.path } : null, []);
  const reread = read.reload;
  const seenState = useRef(`${file.code}:${file.hunks}`);
  useEffect(() => {
    const now = `${file.code}:${file.hunks}`;
    if (now !== seenState.current) { seenState.current = now; reread(); }
  }, [file.code, file.hunks, reread]);
  const c = read.data;
  const parsed = useMemo(() => (c?.merged ? parseConflicts(c.merged) : null), [c?.merged]);
  const [choices, setChoices] = useState<ReadonlyMap<number, HunkChoice>>(new Map());
  useEffect(() => setChoices(new Map()), [c?.merged]);
  const [showBase, setShowBase] = useState(false);
  const [preview, setPreview] = useState(false);
  const [keeping, setKeeping] = useState<{ left: number; asIs: boolean } | null>(null);
  const result = useMemo(() => (parsed ? resolveConflicts(parsed, choices) : null), [parsed, choices]);
  const lang = languageFor(file.path);
  const state = CONFLICT_STATES[c?.code ?? file.code ?? 'UU'];
  const total = parsed?.hunks.length ?? 0;
  const left = result?.left ?? total;

  const choose = (index: number, choice: HunkChoice | null): void => setChoices((all) => {
    const next = new Map(all);
    if (choice === null) next.delete(index); else next.set(index, choice);
    return next;
  });
  const resolve = async (params: { side?: 'ours' | 'theirs'; content?: string; asIs?: boolean; keepMarkers?: boolean }, done: string): Promise<void> => {
    const r = await attempt(() => call('git.resolve', { ...where, path: file.path, digest: c?.digest, ...params }), fail);
    setKeeping(null);
    if (!r) reread();
    if (r) toast(`${done}${r.left ? ` ${plural(r.left, 'file')} still conflict${r.left === 1 ? 's' : ''}.` : ' Nothing conflicts now: commit to finish.'}`);
  };
  // Returned, so the button stays disabled until the file is written.
  const markResolved = (): Promise<void> | undefined => {
    if (!result) return undefined;
    if (result.left) { setKeeping({ left: result.left, asIs: false }); return undefined; }
    return resolve({ content: result.text }, `Resolved ${file.path}.`);
  };
  const sides = c && !c.merged;
  const labels = { ours: c?.oursLabel ?? 'ours', theirs: c?.theirsLabel ?? 'theirs' };

  return (
    <section className="resolver" aria-label={`Resolve ${file.path}`}>
      <header className="diff-head resolver-head" tabIndex={-1}>
        <span className="diff-path mono" title={file.path}>
          {file.path.includes('/') ? <span className="diff-dir">{file.path.slice(0, file.path.lastIndexOf('/') + 1)}</span> : null}
          {file.path.split('/').pop()}
        </span>
        <span className="resolver-state">{state.what}</span>
        {total ? (
          <span className={`resolver-count${left ? ' open' : ' done'}`} role="status">
            {left ? `${left} of ${plural(total, 'conflict')} left` : `All ${plural(total, 'conflict')} chosen`}
          </span>
        ) : null}
        <span className="diff-head-end">
          {c && (c.stages.ours || c.stages.theirs) ? (
            <>
              <Button size="s" tone="quiet" disabled={busy} title={busyWhy ?? `The whole file as ${labels.ours} has it`} onClick={() => resolve({ side: 'ours' }, `Took ${labels.ours}’s ${file.path}.`)}>
                {sides ? state.ours : `Take ours (${labels.ours})`}
              </Button>
              <Button size="s" tone="quiet" disabled={busy} title={busyWhy ?? `The whole file as ${labels.theirs} has it`} onClick={() => resolve({ side: 'theirs' }, `Took ${labels.theirs}’s ${file.path}.`)}>
                {sides ? state.theirs : `Take theirs (${labels.theirs})`}
              </Button>
            </>
          ) : null}
          {parsed && total ? (
            <Button size="s" tone="primary" icon="check" disabled={busy} title={busyWhy ?? (left ? 'Some conflicts are not chosen yet: their markers would stay' : 'Write the result and stage it')} onClick={markResolved}>
              Mark resolved
            </Button>
          ) : null}
        </span>
      </header>
      {file.who.length ? <div className="diff-note"><WhoLine who={file.who} /></div> : null}
      {read.error ? <p className="error-text view-pad">{read.error.message}</p>
        : !c ? <p className="faint view-pad diff-wait">Reading git’s versions of the file…</p>
          : c.binary || c.tooLarge ? (
            <p className="resolver-note view-pad">
              {c.binary ? 'A binary file: there are no lines to choose between.' : 'Too large to resolve line by line here.'} Take one side whole, or resolve it in an editor and mark it resolved as it is.
              {' '}<button type="button" className="linkish" disabled={busy} onClick={() => setKeeping({ left: 0, asIs: true })}>Mark resolved as it is</button>
            </p>
          ) : sides ? (
            <p className="resolver-note view-pad">
              {state.what}. {c.stages.theirs ? `${labels.theirs} has a version of it` : `${labels.theirs} has none`}; {c.stages.ours ? `${labels.ours} has one` : `${labels.ours} has none`}.
              {' '}Choose above: keeping a version stages it, deleting removes the file.
            </p>
          ) : parsed ? (
            <>
              {c.edited ? (
                <p className="resolver-note view-pad">
                  The file was edited after git marked it ({plural(c.inFile ?? 0, 'conflict')} left in it now). The choices here start from git’s own versions, and writing them replaces those edits.
                  {' '}<button type="button" className="linkish" disabled={busy} onClick={() => setKeeping({ left: c.inFile ?? 0, asIs: true })}>Mark resolved as edited</button>
                </p>
              ) : null}
              <div className="resolver-tools">
                {/* Added on both sides, there is nothing they came from. */}
                {c.stages.base ? (
                  <label className="resolver-toggle">
                    <input type="checkbox" checked={showBase} onChange={(e) => setShowBase(e.target.checked)} />
                    Show what both sides came from
                  </label>
                ) : null}
                <label className="resolver-toggle">
                  <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
                  Show the whole result
                </label>
              </div>
              {preview && result ? (
                <div className="resolver-preview" aria-label={`${file.path} as it will be written`}>
                  <CodeLines lines={result.text.replace(/\r?\n$/, '').split(/\r?\n/)} lang={lang} start={1} />
                </div>
              ) : (
                <div className="resolver-body">
                  {parsed.segments.map((s, i) => (s.kind === 'text' ? (
                    <Context key={`t${i}`} lines={s.lines} first={i === 0} last={i === parsed.segments.length - 1} lang={lang} />
                  ) : (
                    <Hunk key={`h${s.hunk.index}`} id={`${id}-${s.hunk.index}`} hunk={s.hunk} total={total} lang={lang} labels={labels} showBase={showBase}
                      choice={choices.get(s.hunk.index)} onChoose={(v) => choose(s.hunk.index, v)} disabled={busy} />
                  )))}
                </div>
              )}
            </>
          ) : null}
      {keeping ? (
        <Confirm danger={keeping.left > 0} title={keeping.left ? `Keep the markers of ${plural(keeping.left, 'conflict')} in ${file.path}?` : `Mark ${file.path} resolved as it is?`}
          act={keeping.left ? 'Keep the markers and stage it' : 'Mark resolved'} onClose={() => setKeeping(null)}
          onAct={() => (keeping.asIs ? resolve({ asIs: true, keepMarkers: keeping.left > 0 }, `Marked ${file.path} resolved.`) : resolve({ content: result?.text ?? '', keepMarkers: true }, `Staged ${file.path} with its markers.`))}>
          {keeping.left ? (
            <p>{plural(keeping.left, 'conflict')} {keeping.left === 1 ? 'is' : 'are'} not resolved, so the file would be staged with its &lt;&lt;&lt;&lt;&lt;&lt;&lt;, ======= and &gt;&gt;&gt;&gt;&gt;&gt;&gt; lines in it, and the commit would hold them. Only do this if the file is meant to contain them.</p>
          ) : <p>The file is staged exactly as it is on disk now.</p>}
        </Confirm>
      ) : null}
    </section>
  );
}

/** Lines of code in colour, numbered from `start`. */
function CodeLines({ lines, lang, start, tone }: { lines: readonly string[]; lang: Lang | null; start?: number; tone?: string }) {
  const rows = useMemo(() => {
    let state = START;
    return lines.map((text) => {
      if (!lang) return { text, spans: undefined };
      const t = tokenizeLine(lang, text, state);
      state = t.state;
      return { text, spans: t.spans };
    });
  }, [lines, lang]);
  if (!lines.length) return <p className="resolver-empty">No lines.</p>;
  return (
    <table className={`diff-lines resolver-lines${tone ? ` ${tone}` : ''}`}>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="dl">
            {start ? <td className="dl-no">{start + i}</td> : null}
            <td className="dl-text">{pieces(r.text, r.spans).map((p, k) => (p.kind ? <span key={k} className={`syn-${p.kind}`}>{p.text}</span> : p.text))}{r.text ? null : ' '}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The text both sides agree on: a few lines next to each conflict, the rest folded. */
function Context({ lines, first, last, lang }: { lines: string[]; first: boolean; last: boolean; lang: Lang | null }) {
  const head = first ? [] : lines.slice(0, CONTEXT);
  const tail = last ? [] : lines.slice(Math.max(head.length, lines.length - CONTEXT));
  const folded = lines.length - head.length - tail.length;
  return (
    <div className="resolver-context">
      {head.length ? <CodeLines lines={head} lang={lang} /> : null}
      {folded > 0 ? <p className="resolver-fold">{plural(folded, 'unchanged line')}</p> : null}
      {tail.length ? <CodeLines lines={tail} lang={lang} /> : null}
    </div>
  );
}

function Hunk({ id, hunk, total, lang, labels, showBase, choice, onChoose, disabled }: {
  id: string; hunk: ConflictHunk; total: number; lang: Lang | null; labels: { ours: string; theirs: string }; showBase: boolean;
  choice: HunkChoice | undefined; onChoose: (c: HunkChoice | null) => void; disabled: boolean;
}) {
  const current = nameOf(choice);
  const [draft, setDraft] = useState('');
  const pick = (v: ChoiceName): void => {
    if (v === 'edit') {
      // Start from what was chosen, or both sides, so editing is trimming rather than retyping.
      const from = choice === undefined ? [...hunk.ours, ...hunk.theirs] : chosenLines(hunk, choice);
      setDraft(from.join('\n'));
      onChoose({ text: from.join('\n') });
    } else onChoose(current === v ? null : v);
  };
  const lines = choice === undefined ? null : chosenLines(hunk, choice);
  const base = showBase && hunk.base;
  const side = (who: 'ours' | 'base' | 'theirs', label: string, body: string[]): ReactNode => (
    <div className={`resolver-side side-${who}`}>
      <div className="resolver-side-head"><span className="side-mark" aria-hidden="true" />{label}</div>
      <CodeLines lines={body} lang={lang} />
    </div>
  );
  return (
    <div className={`resolver-hunk${current ? ' chosen' : ''}`} role="group" aria-labelledby={`${id}-t`}>
      <div className="resolver-hunk-bar">
        <span id={`${id}-t`} className="resolver-hunk-title">Conflict {hunk.index + 1} of {total}</span>
        <span className="choice-group" role="radiogroup" aria-label={`Resolve conflict ${hunk.index + 1}`}>
          {CHOICES.map((o) => (
            <button key={o.value} type="button" role="radio" aria-checked={current === o.value} className={current === o.value ? 'on' : ''}
              title={o.hint} disabled={disabled} onClick={() => pick(o.value)}>{o.label}</button>
          ))}
        </span>
      </div>
      <div className={`resolver-sides${base ? ' three' : ''}`}>
        {side('ours', `Ours · ${labels.ours}`, hunk.ours)}
        {base ? side('base', 'Where both started', hunk.base ?? []) : null}
        {side('theirs', `Theirs · ${labels.theirs}`, hunk.theirs)}
      </div>
      <div className="resolver-result">
        <div className="resolver-side-head">{current ? <><Icon name="check" size={13} /> Result</> : 'Result'}</div>
        {current === 'edit' ? (
          <textarea className="resolver-edit mono" aria-label={`Result of conflict ${hunk.index + 1}`} rows={Math.min(14, Math.max(3, draft.split('\n').length + 1))}
            value={draft} spellCheck={false} disabled={disabled}
            onChange={(e) => { setDraft(e.target.value); onChoose({ text: e.target.value }); }} />
        ) : lines ? <CodeLines lines={lines} lang={lang} tone="resolver-chosen" />
          : <p className="resolver-open">Not chosen yet: its markers stay in the file.</p>}
        {current === 'edit' && conflictCount(draft) ? <p className="resolver-open">What you wrote still holds conflict markers.</p> : null}
      </div>
    </div>
  );
}
