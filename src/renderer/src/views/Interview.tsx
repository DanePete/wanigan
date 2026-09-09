import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocketRisk, Interview as InterviewRecord, InterviewProposal, Project } from '@shared/types';
import { Explainer, Note, PageHead, usd } from '../components/bits';

/**
 * The screen that grills you, then hands you a goal to accept or throw away.
 *
 * Everything Wanigan could create before this was the same four phases — plan,
 * implement, verify, review — whatever the work was, with whatever acceptance
 * check the operator could be bothered to type before the interesting part.
 * What makes an acceptance check worth having is that it could fail, and you do
 * not get one of those from a form. You get it from somebody asking "what
 * happens if the offer has no end date" and not moving on.
 *
 * Three things this screen is careful about, all of them about spending
 * somebody's money in front of them:
 *
 * The budget is set before the first question, and the spend is on screen from
 * then on — the real number the API reported at synchronous rates, not an
 * estimate and not the batch price.
 *
 * Nothing moves on its own. There is no poll and no timer here: an interview
 * advances when you answer, and stops when you stop.
 *
 * The proposal is a draft, and it says so. Every field is editable before the
 * goal is written, because the operator has the last word on the contract —
 * and because a plan you cannot correct is one you accept out of politeness.
 */

/**
 * How hard to be grilled. This replaced a dollar menu.
 *
 * The old control offered $0.25 / $1 / $3 / $10 for a thing that costs between
 * ten and thirty cents end to end — four numbers that all meant "yes", in front
 * of somebody with no way to know that. Length is the decision an operator
 * actually has, and the cost follows from it and is shown.
 */
const LENGTHS = [
  { questions: 5, label: 'Quick', why: 'the contract and little else' },
  { questions: 10, label: 'Standard', why: 'enough to catch what you skipped' },
  { questions: 16, label: 'Thorough', why: 'for work you cannot easily undo' },
];
const RISKS: DocketRisk[] = ['low', 'elevated', 'high'];
const RISK_WHY: Record<DocketRisk, string> = {
  low: 'Reversible, contained, nothing else depends on it.',
  elevated: 'The default. Real work in a real repository.',
  high: 'Touches something load-bearing, or is hard to undo.',
};

export default function Interview({ projects, projectId, onDone, onCancel }: {
  projects: Project[];
  projectId: string | null;
  /** The goal was written; its id, so the caller can go and open it. */
  onDone: (docketId: string) => void;
  onCancel: () => void;
}) {
  const [project, setProject] = useState(projectId ?? projects[0]?.id ?? '');
  const [seed, setSeed] = useState('');
  const [questions, setQuestions] = useState(10);
  const [models, setModels] = useState<{ id: string; label: string; costPerQuestion: number }[]>([]);
  const [model, setModel] = useState('claude-sonnet-5');
  const [record, setRecord] = useState<InterviewRecord | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<InterviewProposal | null>(null);
  // The acceptance box keeps its own raw text, and that is not an
  // optimisation. Splitting on every keystroke and storing the result made this
  // a controlled textarea whose value could never hold a trailing space or an
  // empty line: typing one produced a state that rendered without it, React put
  // the old string back, and the operator watched the space they typed vanish
  // and the next word join the last. A second check could not be started at
  // all — Return was swallowed by the same filter. Raw in, parsed once on
  // accept, the way Control's own goal form already does it.
  // Interviews that were left open. The transcript has always been durable —
  // it is a table, so a quit does not lose ten minutes of the operator's own
  // answers — but until now nothing in the app could reach one again, which
  // made that durability worth exactly nothing. Money had already been spent
  // on every one of these.
  const [resumable, setResumable] = useState<InterviewRecord[]>([]);
  const answerBox = useRef<HTMLTextAreaElement>(null);

  // Once, on mount. This had `model` in its dependencies so it could correct an
  // unhonourable selection — which meant every time the operator picked a
  // different model the whole list was fetched again over IPC. The correction
  // only ever needs to happen against the list as it arrives, so it happens
  // inside the callback where that list is, and the effect depends on nothing.
  useEffect(() => {
    window.wanigan.interview.models()
      .then((rows) => {
        setModels(rows);
        if (!rows.length) return;
        setModel((current) => (rows.some((row) => row.id === current) ? current : rows[0].id));
      })
      .catch(() => setModels([]));
  }, []);

  useEffect(() => {
    if (record !== null) return;
    window.wanigan.interview.list(null, 20)
      .then((rows) => setResumable(rows.filter((row) => row.status === 'asking' || row.status === 'proposed')))
      .catch(() => setResumable([]));
  }, [record]);

  const open = record?.status === 'asking' ? record.turns[record.turns.length - 1] ?? null : null;

  // The question is the only thing on screen worth typing into, so put the
  // cursor there. Keyed on the question rather than the record, so answering
  // moves focus to the next one and a spend refresh does not steal it back
  // mid-sentence.
  useEffect(() => { if (open?.answer === null) answerBox.current?.focus(); }, [open?.question, open?.answer]);

  const [acceptanceText, setAcceptanceText] = useState('');

  useEffect(() => {
    if (record?.status === 'proposed' && record.proposal && draft === null) {
      setDraft(record.proposal);
      setAcceptanceText(record.proposal.acceptance.join('\n'));
    }
  }, [record, draft]);

  const run = useCallback(async (label: string, work: () => Promise<InterviewRecord>) => {
    setBusy(label); setError(null);
    try { setRecord(await work()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }, []);

  /* ── before it starts ────────────────────────────────────────────── */

  if (record === null) {
    return (
      <div className="pane">
        <PageHead
          eyebrow="Work"
          title="Plan a goal"
          lead="Describe roughly what you want. Wanigan will ask you about it — one question at a time — until it can write a contract that could fail, then propose the tasks."
          actions={<button className="btn" type="button" onClick={onCancel}>Back to the board</button>}
        />
        {error && <Note tone="error">{error}</Note>}

        {resumable.length > 0 && (
          <div className="iv-resume">
            <span className="label">Pick up where you left off</span>
            {resumable.map((row) => (
              <button key={row.id} className="iv-resume-row" type="button"
                      onClick={() => void run('resume', () => window.wanigan.interview.get(row.id))}>
                <span className="iv-resume-seed">{row.seed}</span>
                <span className="iv-resume-meta">
                  {row.status === 'proposed'
                    ? 'waiting for you to accept or throw away'
                    : `${row.turns.length} ${row.turns.length === 1 ? 'question' : 'questions'} in`}
                  {' · '}{usd(row.spendUsd)} spent
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="iv-start">
          <label className="label" htmlFor="iv-project">Project</label>
          <select id="iv-project" className="field" value={project} onChange={(e) => setProject(e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <label className="label" htmlFor="iv-seed">What do you want to do?</label>
          <textarea id="iv-seed" className="field iv-seed" rows={4} value={seed}
                    placeholder="Rough is fine — a sentence or two. The questions are what sharpen it."
                    onChange={(e) => setSeed(e.target.value)} />

          <label className="label" htmlFor="iv-model">Who does the grilling</label>
          <select id="iv-model" className="field" value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label} — about {usd(row.costPerQuestion)} a question
              </option>
            ))}
          </select>

          <span className="label">How hard to grill you</span>
          <div className="iv-budgets" role="group" aria-label="How many questions at most">
            {LENGTHS.map((length) => (
              <button key={length.questions} type="button"
                      className={`iv-budget${questions === length.questions ? ' on' : ''}`}
                      aria-pressed={questions === length.questions}
                      title={length.why}
                      onClick={() => setQuestions(length.questions)}>
                {length.label} · up to {length.questions}
              </button>
            ))}
          </div>
          {/* The estimate is stated before the first call, not discovered on a
              spend report later. This is the one screen in Wanigan where the app
              itself spends money rather than an agent doing it. */}
          <p className="faint iv-fine">
            {LENGTHS.find((l) => l.questions === questions)?.why ?? ''} — at most{' '}
            <strong>{usd((models.find((m) => m.id === model)?.costPerQuestion ?? 0) * questions)}</strong>,
            and usually less, because it proposes as soon as it can rather than using every question.
            This calls the Claude Platform API on your key at synchronous rates — Wanigan spending,
            not an agent — and shows what it has actually spent after every question.
          </p>
          <p className="faint iv-fine">
            Codex, GLM and DeepSeek are not options here. Those are agent harnesses Wanigan launches
            as command-line tools with their own logins; the interview is a direct API call on your
            Platform key, so it can only use models that key can reach.
          </p>

          <div className="iv-acts">
            <button className="btn btn-primary" type="button"
                    disabled={busy !== null || !project || seed.trim().length < 8}
                    onClick={() => void run('start', () => window.wanigan.interview.start({
                      projectId: project, seed: seed.trim(), model, maxQuestions: questions,
                    }))}>
              {busy === 'start' ? 'Asking…' : 'Start the interview'}
            </button>
          </div>
        </div>

        <Explainer id="interview-why" title="Why this is an interview and not a form">
          A form collects what you already thought of. The value in this one is the follow-up: the
          second question is written against your first answer, so it can go after the thing you
          skipped. That is also why it refuses to be thorough for its own sake — it proposes as soon
          as it can write acceptance checks that could actually fail, rather than working through a
          checklist you have already answered.
        </Explainer>
      </div>
    );
  }

  const modelLabel = models.find((m) => m.id === record.model)?.label ?? record.model;
  const spent = (
    <span className="iv-spend">
      {modelLabel} · question {Math.min(record.turns.length, record.maxQuestions)} of {record.maxQuestions} · {usd(record.spendUsd)} spent
    </span>
  );

  /* ── the grilling ────────────────────────────────────────────────── */

  if (record.status === 'asking' || record.status === 'failed') {
    return (
      <div className="pane">
        <PageHead eyebrow="Work" title="Plan a goal" compact
                  lead={record.seed}
                  actions={<>{spent}<button className="btn" type="button" disabled={busy !== null}
                    onClick={() => { void window.wanigan.interview.abandon(record.id).catch(() => {}); onCancel(); }}>
                    Abandon
                  </button></>} />

        {error && <Note tone="error">{error}</Note>}
        {record.detail && <Note tone="warn">{record.detail}</Note>}

        <ol className="iv-turns">
          {record.turns.map((turn, index) => (
            <li key={`${turn.at}:${index}`} className="iv-turn">
              <p className="iv-q">{turn.question}</p>
              {turn.why && <p className="iv-why">{turn.why}</p>}
              {turn.answer !== null
                ? <p className="iv-a">{turn.answer}</p>
                : (
                  <div className="iv-answer">
                    <label className="label" htmlFor="iv-answer">Your answer</label>
                    <textarea id="iv-answer" ref={answerBox} className="field" rows={3} value={answer}
                              disabled={busy !== null}
                              onChange={(e) => setAnswer(e.target.value)}
                              onKeyDown={(e) => {
                                // ⌘↵ sends, the way the composer does. An
                                // interview is ten of these in a row and
                                // reaching for the mouse each time is what
                                // makes somebody answer in three words.
                                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && answer.trim()) {
                                  e.preventDefault();
                                  const value = answer.trim();
                                  setAnswer('');
                                  void run('answer', () => window.wanigan.interview.answer(record.id, value));
                                }
                              }} />
                    <div className="iv-acts">
                      <button className="btn btn-primary" type="button"
                              disabled={busy !== null || !answer.trim()}
                              onClick={() => {
                                const value = answer.trim();
                                setAnswer('');
                                void run('answer', () => window.wanigan.interview.answer(record.id, value));
                              }}>
                        {busy === 'answer' ? 'Thinking…' : 'Answer'}
                      </button>
                      <span className="faint iv-fine">⌘↵ sends</span>
                      {/* The way out for somebody who has said enough. It
                          proposes from what it has rather than refusing, so a
                          long interview is never wasted. */}
                      <button className="btn" type="button" disabled={busy !== null}
                              onClick={() => void run('conclude', () => window.wanigan.interview.conclude(record.id))}>
                        {busy === 'conclude' ? 'Writing it up…' : 'Enough — propose the goal'}
                      </button>
                    </div>
                  </div>
                )}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  /* ── the proposal ────────────────────────────────────────────────── */

  if (record.status === 'proposed' && draft) {
    const edit = (patch: Partial<InterviewProposal>) => setDraft({ ...draft, ...patch });
    // Parsed here rather than on the way in, so what is committed is exactly
    // what buildPlan would have made of it and the box stays typeable.
    const acceptance = acceptanceText.split('\n').map((line) => line.trim()).filter(Boolean);
    return (
      <div className="pane">
        <PageHead eyebrow="Work" title="Accept this goal?" compact
                  lead={`From ${record.turns.length} ${record.turns.length === 1 ? 'question' : 'questions'}. Everything below is editable — nothing is written until you accept.`}
                  actions={<>{spent}<button className="btn" type="button"
                    onClick={() => { void window.wanigan.interview.abandon(record.id).catch(() => {}); onCancel(); }}>
                    Throw it away
                  </button></>} />

        {error && <Note tone="error">{error}</Note>}

        <div className="iv-review">
          <label className="label" htmlFor="iv-title">Title</label>
          <input id="iv-title" className="field" value={draft.title} onChange={(e) => edit({ title: e.target.value })} />

          <label className="label" htmlFor="iv-objective">Objective</label>
          <textarea id="iv-objective" className="field" rows={4} value={draft.objective}
                    onChange={(e) => edit({ objective: e.target.value })} />

          <span className="label">Risk</span>
          <div className="iv-risks" role="group" aria-label="Risk level">
            {RISKS.map((value) => (
              <button key={value} type="button" className={`iv-budget${draft.risk === value ? ' on' : ''}`}
                      aria-pressed={draft.risk === value} title={RISK_WHY[value]}
                      onClick={() => edit({ risk: value })}>{value}</button>
            ))}
          </div>
          <p className="faint iv-fine">{RISK_WHY[draft.risk]}</p>

          <label className="label" htmlFor="iv-acceptance">
            Acceptance — one per line. These are what the final review is marked against.
          </label>
          <textarea id="iv-acceptance" className="field"
                    rows={Math.max(3, acceptanceText.split('\n').length + 1)}
                    value={acceptanceText}
                    onChange={(e) => setAcceptanceText(e.target.value)} />

          <span className="label">{draft.plan.length} tasks</span>
          <ol className="iv-plan">
            {draft.plan.map((node, index) => (
              <li key={index} className="iv-node">
                <div className="iv-node-top">
                  <span className="iv-kind">{node.kind}</span>
                  <strong>{node.title}</strong>
                </div>
                <p className="iv-node-say">{node.instructions}</p>
                <div className="iv-node-meta">
                  {node.claimPath && <span className="iv-chip">owns {node.claimPath}</span>}
                  {node.dependsOn && node.dependsOn.length > 0 && (
                    <span className="iv-chip">
                      after {node.dependsOn.map((d) => draft.plan[d]?.title ?? `task ${d + 1}`).join(', ')}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {/* The graph is the one part not editable here, and saying so is
              better than a text box that pretends. Editing a dependency graph
              needs the plan editor in Control, and a half-editor that could
              produce a cycle would be refused on accept with nothing useful to
              say about which edit caused it. */}
          <p className="faint iv-fine">
            The task list is fixed at this point — accept the goal and edit its graph in Control, or
            throw this away and say what was wrong in another interview.
          </p>

          <div className="iv-acts">
            <button className="btn btn-primary" type="button"
                    disabled={busy !== null || !draft.title.trim() || acceptance.length === 0}
                    onClick={async () => {
                      setBusy('commit'); setError(null);
                      try {
                        const docket = await window.wanigan.interview.commit(record.id, { ...draft, acceptance });
                        onDone(docket.id);
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      } finally { setBusy(null); }
                    }}>
              {busy === 'commit' ? 'Writing the goal…' : `Accept — create ${draft.plan.length} tickets`}
            </button>
            {acceptance.length === 0 && (
              <span className="faint iv-fine">Add at least one acceptance check — it is the contract the review is marked against.</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pane">
      <PageHead eyebrow="Work" title="Plan a goal" compact lead={`This interview is ${record.status}.`}
                actions={<button className="btn" type="button" onClick={onCancel}>Back to the board</button>} />
    </div>
  );
}
