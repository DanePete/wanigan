import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEPS_MODES, DEPS_MODE_COPY, bootstrapFacts, durationText, parseCommandInput, runFacts, summarizeRun,
  type DepsMode, type WorktreeBootstrap, type WorktreeCommandRun, type WorktreeRunSummary, type WorktreeSetupConfig,
} from '@shared/worktree-bootstrap';
import { Hint, Mark, Note, SectionHead, Segmented, ago, type MarkSpec } from './bits';
import '../styles/worktree-setup.css';

/*
 * What every worktree Wanigan makes for a project is given, beside the review
 * gate because it is the same kind of thing: command text the operator writes
 * once and Wanigan runs many times. Saving asks in a native dialog, in main,
 * for any line not already stored; this view only shows main's answer.
 */

type Props = { projectId: string; projectName: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toLines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);
const leaf = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const DEPS_OUTCOME: Record<DepsMode, string> = { link: 'linked to the main checkout', clone: 'cloned', skip: 'left out' };

/** Glyph and word for a run, so its state never rests on colour. */
function runMark(run: Pick<WorktreeRunSummary, 'phase' | 'status'>): MarkSpec {
  const word = `${run.phase} ${run.status}`;
  if (run.status === 'passed') return { glyph: '✓', word, tone: 'ok' };
  if (run.status === 'running') return { glyph: '▸', word, tone: 'quiet' };
  return { glyph: '✕', word, tone: 'serious' };
}

function includeLine(include: WorktreeSetupConfig['include']): string {
  if (include.state === 'absent') return 'No .worktreeinclude in the repository root, so no gitignored files are copied in.';
  if (include.state === 'unreadable') return `.worktreeinclude could not be read: ${include.detail}. Nothing is copied from it until it can.`;
  return include.patterns
    ? `.worktreeinclude has ${include.patterns} ${include.patterns === 1 ? 'pattern' : 'patterns'}: gitignored files matching them are copied into each new worktree.`
    : '.worktreeinclude has no patterns, so nothing is copied from it.';
}

/** Project identity owns the drafts and every pending operation, as in ReviewGate. */
export default function WorktreeSetup(props: Props) {
  return <ProjectWorktreeSetup key={props.projectId} {...props} />;
}

function ProjectWorktreeSetup({ projectId, projectName }: Props) {
  const [config, setConfig] = useState<WorktreeSetupConfig | null>(null);
  const [runs, setRuns] = useState<WorktreeCommandRun[] | null>(null);
  const [setupText, setSetupText] = useState('');
  const [teardownText, setTeardownText] = useState('');
  const [busy, setBusy] = useState<'save' | 'deps' | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const acting = useRef(false);

  // The two reads fail apart: history that cannot be read must not lock the
  // operator out of the commands, and commands that cannot be read are never
  // shown as an empty list someone could save over.
  const read = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true); setReadError(null); setRunsError(null);
    const [next, history] = await Promise.allSettled([
      window.wanigan.worktrees.setup(projectId),
      window.wanigan.worktrees.commandRuns(projectId, 12),
    ]);
    if (!mounted.current || request !== sequence.current) return;
    if (next.status === 'fulfilled') {
      setConfig(next.value);
      setSetupText(next.value.setup.join('\n')); setTeardownText(next.value.teardown.join('\n'));
    } else { setConfig(null); setReadError(message(next.reason)); }
    if (history.status === 'fulfilled') setRuns(history.value);
    else { setRuns(null); setRunsError(message(history.reason)); }
    setLoading(false);
  }, [projectId]);
  // The component is keyed on the project, so `read` is fixed for its life and
  // only an unmount ends the effect; `mounted` is what stops a late answer.
  useEffect(() => { mounted.current = true; void read(); return () => { mounted.current = false; }; }, [read]);

  const setupLines = toLines(setupText);
  const teardownLines = toLines(teardownText);
  const dirty = !!config && (setupLines.join('\n') !== config.setup.join('\n') || teardownLines.join('\n') !== config.teardown.join('\n'));
  const parsed = parseCommandInput({ setup: setupLines, teardown: teardownLines });
  const invalid = 'problem' in parsed ? parsed.problem : null;

  const save = async () => {
    if (acting.current || !config || invalid || !dirty) return;
    acting.current = true; setBusy('save'); setActionError(null); setNotice(null);
    try {
      // May wait at main's consent dialog; a view left meanwhile takes nothing from the answer.
      const stored = await window.wanigan.worktrees.saveCommands(projectId, { setup: setupLines, teardown: teardownLines });
      if (!mounted.current) return;
      setConfig((c) => c && { ...c, setup: stored.setup, teardown: stored.teardown, updatedAt: stored.updatedAt });
      setSetupText(stored.setup.join('\n')); setTeardownText(stored.teardown.join('\n'));
      setNotice('Commands saved. Nothing ran now: they run in the next worktree Wanigan makes or removes for this project.');
    } catch (e) {
      if (mounted.current) setActionError(message(e));
    } finally {
      acting.current = false; if (mounted.current) setBusy(null);
    }
  };

  const chooseDeps = async (mode: DepsMode) => {
    if (acting.current || !config || mode === config.depsMode) return;
    acting.current = true; setBusy('deps'); setActionError(null); setNotice(null);
    try {
      const saved = await window.wanigan.worktrees.setDepsMode(projectId, mode);
      if (!mounted.current) return;
      setConfig((c) => c && { ...c, depsMode: saved });
      setNotice(`Dependency folders will be ${DEPS_OUTCOME[saved]} in new worktrees. Worktrees that already exist keep what they have.`);
    } catch (e) {
      if (mounted.current) setActionError(message(e));
    } finally {
      acting.current = false; if (mounted.current) setBusy(null);
    }
  };

  const state = loading ? 'Reading…' : !config ? 'Unavailable' : busy === 'save' ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved';
  return <section className="wt-setup" aria-label="Worktree setup">
    <div className="wt-setup-config">
      <SectionHead label="New worktrees" right={<span>{state}</span>} />
      <p className="wt-setup-cue">What each worktree Wanigan makes for {projectName} is given. Kept in Wanigan, never written into the repository.</p>
      {readError && <Note tone="error" action={{ label: 'Retry', run: read }}>Could not read this project’s worktree settings: {readError}</Note>}
      {config && <>
        <div className="wt-setup-field">
          <span className="label">Dependency folders</span>
          <Segmented label="Dependency folders in new worktrees" value={config.depsMode}
                     onChange={(mode) => void chooseDeps(mode)}
                     options={DEPS_MODES.map((mode) => ({ value: mode, label: DEPS_MODE_COPY[mode].label }))} />
        </div>
        <p className="wt-setup-caption">{DEPS_MODE_COPY[config.depsMode].hint}</p>
        <p className="wt-setup-caption">{includeLine(config.include)}</p>
        <span className="label">Setup, after a worktree is made</span>
        <textarea className="field mono" aria-label="Worktree setup commands" rows={3} value={setupText}
                  disabled={!!busy} placeholder="npm ci" onChange={(e) => { setSetupText(e.target.value); setNotice(null); }} />
        <span className="label">Teardown, before a worktree is removed</span>
        <textarea className="field mono" aria-label="Worktree teardown commands" rows={2} value={teardownText}
                  disabled={!!busy} placeholder="docker compose down" onChange={(e) => { setTeardownText(e.target.value); setNotice(null); }} />
        <p className="wt-setup-caption">
          One command per line, run through your login shell in the worktree with WANIGAN_WORKTREE, WANIGAN_REPO_ROOT,
          WANIGAN_PORT and WANIGAN_PORT_COUNT set, and stopped at the first failure. A setup that fails keeps its
          worktree and does not stop the session from starting. New lines are confirmed in a system dialog.
        </p>
        {invalid && <Note tone="warn">{invalid}</Note>}
        {actionError && <Note tone="error">{actionError}</Note>}
        <div className="wt-setup-actions">
          <button className="btn" disabled={!!busy || !dirty || !!invalid} onClick={() => void save()}>
            {busy === 'save' ? 'Saving…' : 'Save commands'}
          </button>
        </div>
        {notice && <p className="wt-setup-notice" role="status">{notice}</p>}
      </>}
    </div>
    <div className="wt-setup-runs">
      <SectionHead label="Recent runs" count={runs ? runs.length : undefined} />
      {runsError && <Note tone="error" action={{ label: 'Retry', run: read }}>Could not read the recorded runs: {runsError}</Note>}
      {runs && runs.length === 0 && <Hint>No setup or teardown has run for {projectName}. A run is recorded here each time Wanigan makes or removes one of its worktrees with commands saved.</Hint>}
      {runs?.map((run) => <RunRecord key={run.id} run={run} />)}
      {runs && runs.length >= 12 && <p className="wt-setup-caption">Showing the newest 12 recorded runs.</p>}
    </div>
  </section>;
}

function RunRecord({ run }: { run: WorktreeCommandRun }) {
  const summary = summarizeRun(run);
  const unrun = run.status === 'running' ? 0 : run.planned - run.results.length;
  return <details className="wt-run">
    <summary>
      <Mark {...runMark(summary)} />
      <span className="wt-run-tree">{leaf(run.worktree)}</span>
      <span className="wt-run-facts">{runFacts(summary)}</span>
      <time>{ago(run.startedAt)}</time>
    </summary>
    <p className="wt-setup-caption">
      In {run.worktree}{run.env ? ` · ports ${run.env.WANIGAN_PORT}, ${run.env.WANIGAN_PORT_COUNT} of them` : ''}
      {' · '}started {new Date(run.startedAt).toLocaleString()}{run.endedAt === null ? ' · no finish recorded' : ''}
    </p>
    {run.note && <Note tone="warn">{run.note}</Note>}
    {run.results.map((result, index) => <article className="wt-run-command" key={index}>
      <div><code>{result.command}</code><span>{result.exitCode === null ? 'no exit code' : `exit ${result.exitCode}`} · {durationText(result.durationMs)}</span></div>
      <pre tabIndex={0} aria-label={`Recorded output of ${result.command}`}>{result.output || '(no output recorded)'}</pre>
    </article>)}
    {unrun > 0 && <p className="wt-setup-caption">{unrun} of {run.planned} {run.planned === 1 ? 'command' : 'commands'} did not run.</p>}
  </details>;
}

/**
 * How a worktree was made, under its branch row: the setup's verdict and the
 * end of its output, then its ports, dependency folders and include copies.
 */
export function WorktreeBootstrapNote({ bootstrap }: { bootstrap: WorktreeBootstrap }) {
  const { setup } = bootstrap;
  return <div className="wt-boot">
    {setup && <p className="wt-boot-line"><Mark {...runMark(setup)} /><span>{runFacts(setup)}</span></p>}
    <p className="wt-boot-line">{bootstrapFacts(bootstrap).join(' · ')}</p>
    {setup?.tail && <details className="wt-boot-tail">
      <summary>{setup.tailCut ? 'Last lines of the setup output' : 'Setup output'}</summary>
      <pre tabIndex={0} aria-label="Setup output">{setup.tail}</pre>
    </details>}
  </div>;
}
