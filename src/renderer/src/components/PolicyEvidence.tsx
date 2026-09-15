import { useEffect, useState } from 'react';
import type { FatigueReport, GateSelfTestRun, GrantSetting, Project, StoredTrace } from '@shared/types';
import { Mark, Note, SectionHead, Stat, ago, num, type Tone } from './bits';
import '../styles/policy-evidence.css';

/**
 * Policy evidence panels for the Trust section of Settings: the per-command
 * trace behind a ledger row, and the observations recorded beside the ledger.
 * Kept out of Settings.tsx so that file carries one line per panel.
 */

const DECISION_TONE: Record<'allow' | 'ask' | 'deny', { glyph: string; tone: Tone }> = {
  allow: { glyph: '✓', tone: 'ok' },
  ask: { glyph: '?', tone: 'warn' },
  deny: { glyph: '⊘', tone: 'bad' },
};

const SHELL_TOOLS = new Set(['bash', 'shell', 'local_shell', 'exec_command', 'run_command', 'run_terminal_cmd']);

/** Whether a ledger row's tool is one whose decision can carry a per-command trace. */
export function tracesTool(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName.toLowerCase());
}

/**
 * Which command in the line fired which rule. Loaded when opened: a ledger read
 * of five thousand rows should not carry five thousand traces it will not show.
 */
export function LedgerTrace({ id }: { id: number }) {
  const [trace, setTrace] = useState<StoredTrace | null | 'loading' | 'error'>('loading');
  const [opened, setOpened] = useState(false);
  const load = () => {
    if (opened) return;
    setOpened(true);
    window.wanigan.policyEvidence.trace(id).then(setTrace).catch(() => setTrace('error'));
  };
  return (
    <details className="pe-trace" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) load(); }}>
      <summary>How the line was read</summary>
      {trace === 'loading' ? <p className="faint pe-fine">Reading the trace…</p>
        : trace === 'error' ? <p className="pe-fine">Wanigan could not read this row’s trace.</p>
          : trace === null ? (
            <p className="faint pe-fine">
              No per-command trace is stored for this row. Rows written before the gate parsed shell lines carry none.
            </p>
          ) : (
            <>
              <ol className="pe-trace-steps">
                {trace.steps.map((s, i) => {
                  const mark = DECISION_TONE[s.decision];
                  return (
                    <li key={i}>
                      <Mark glyph={mark.glyph} word={s.rule ?? 'no rule'} tone={s.rule ? mark.tone : 'quiet'} />
                      <code className="pe-cmd">{s.text}</code>
                      <span className="faint pe-fine">
                        {s.origin === 'raw' ? 'pattern over the whole line' : s.origin}
                        {s.via.length ? ` · via ${s.via.join(' › ')}` : ''}
                        {s.cwd ? ` · in ${s.cwd}` : ''}
                      </span>
                    </li>
                  );
                })}
              </ol>
              {trace.omitted > 0 && <p className="faint pe-fine">{trace.omitted} more commands were not stored.</p>}
              {trace.notes.map((n) => <p key={n} className="pe-fine">{n}</p>)}
            </>
          )}
    </details>
  );
}

/**
 * Whether the gate's own fixtures behaved as specified, from the last recorded
 * run. A failure is listed by rule and arm, and nothing about a failing run is
 * softened: a gate that does not pass its own tests is the headline.
 */
export function GateSelfTestPanel() {
  const [run, setRun] = useState<GateSelfTestRun | null | 'loading' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    window.wanigan.policyEvidence.selfTest()
      .then((r) => { if (live) setRun(r); })
      .catch(() => { if (live) setRun('error'); });
    return () => { live = false; };
  }, []);
  const again = async () => {
    setBusy(true);
    try { setRun(await window.wanigan.policyEvidence.runSelfTest()); }
    catch { setRun('error'); }
    finally { setBusy(false); }
  };
  const failed = run && typeof run === 'object' && run.passed < run.rules;
  return (
    <section className="pe-selftest" aria-label="Gate self-test">
      <SectionHead label="Gate self-test"
                   right={<button type="button" className="btn btn-sm" disabled={busy} onClick={() => void again()}>{busy ? 'Running…' : 'Run again'}</button>} />
      {run === 'loading' ? <p className="faint pe-fine">Reading the last run…</p>
        : run === 'error' ? <Note tone="error">Wanigan could not read or run the gate self-test.</Note>
          : run === null ? <p className="dim pe-fine">No run is recorded yet. It runs when Wanigan starts; run it now to see the result.</p>
            : (
              <>
                <p className={`pe-selftest-line${failed ? ' failed' : ''}`}>
                  <Mark glyph={failed ? '!' : '✓'} word={`Gate self-test: ${run.passed}/${run.rules} rules behaved as specified`} tone={failed ? 'bad' : 'ok'} />
                  <span className="faint pe-fine"> {ago(run.at)}</span>
                </p>
                {run.failures.length > 0 && (
                  <ul className="pe-notes" aria-label="Rules that did not behave as specified">
                    {run.failures.map((f, i) => (
                      <li key={`${f.rule}-${f.arm}-${i}`}>
                        <code>{f.rule}</code>, {f.arm === 'refuse' ? 'the payload it must refuse or ask about' : 'the ordinary payload it must allow'}:
                        expected {f.expected}, got {f.got}.
                      </li>
                    ))}
                  </ul>
                )}
                {run.uncovered.length > 0 && (
                  <p className="pe-alarm">No fixtures for: {run.uncovered.join(', ')}.</p>
                )}
                <p className="faint pe-fine">
                  Each rule is run against one payload it must refuse or ask about and one ordinary payload it must allow,
                  with a synthetic home and project folder. A pass says the rules behave as written; it does not make them
                  containment, and it says nothing about a particular file on this Mac.
                </p>
              </>
            )}
    </section>
  );
}

const clockHour = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric' });

/**
 * How many approvals were asked for and how fast they were answered, over the
 * last day. Observed counts only; every duration is inferred from the event
 * that followed the prompt, and the panel says so beside the numbers.
 */
export function FatiguePanel() {
  const [report, setReport] = useState<FatigueReport | null | 'error'>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.policyEvidence.fatigue()
      .then((r) => { if (live) setReport(r); })
      .catch(() => { if (live) setReport('error'); });
    return () => { live = false; };
  }, []);
  const seconds = report && report !== 'error' ? `${(report.fastMs / 1000).toFixed(report.fastMs % 1000 ? 1 : 0)} s` : '';
  return (
    <section className="pe-fatigue" aria-label="Approval timing">
      <SectionHead label="Approvals over the last day" />
      {report === null ? <p className="faint pe-fine">Reading approval events…</p>
        : report === 'error' ? <Note tone="error">Wanigan could not read the approval events.</Note>
          : report.totals.asked === 0 ? (
            <p className="dim pe-fine">No measurements yet: no session asked for an approval in the last 24 hours.</p>
          ) : (
            <>
              <div className="stat-grid pe-fatigue-stats">
                <Stat label="Asked" value={num(report.totals.asked)} sub="permission prompts, observed" />
                <Stat label="Answered" value={num(report.totals.answered)} sub="a later event for that tool arrived" />
                <Stat label={`Under ${seconds}`} value={num(report.totals.fast)} sub="inferred, an upper bound" />
                <Stat label="Unanswered" value={num(report.totals.unanswered)} sub="the turn moved on without one" />
              </div>
              {report.signals.length > 0 && (
                <ul className="pe-notes" aria-label="Fast approval runs recorded in the last week">
                  {report.signals.map((s) => (
                    <li key={`${s.at}-${s.sessionId ?? ''}`}>
                      <Mark glyph="≫" word="fast run" tone="warn" /> {s.summary} <span className="faint">{ago(s.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="pe-scroll">
                <table className="grid pe-table">
                  <caption className="faint pe-fine">By hour, hours with a prompt only</caption>
                  <thead><tr><th>Hour</th><th className="r">Asked</th><th className="r">Answered</th><th className="r">Under {seconds}</th></tr></thead>
                  <tbody>
                    {report.hours.filter((h) => h.asked > 0).map((h) => (
                      <tr key={h.hourStart}>
                        <td>{clockHour(h.hourStart)}</td>
                        <td className="r">{num(h.asked)}</td>
                        <td className="r">{num(h.answered)}</td>
                        <td className="r">{num(h.fast)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pe-scroll">
                <table className="grid pe-table">
                  <caption className="faint pe-fine">By session, most prompts first</caption>
                  <thead><tr><th>Session</th><th className="r">Asked</th><th className="r">Answered</th><th className="r">Under {seconds}</th><th className="r">Unanswered</th></tr></thead>
                  <tbody>
                    {report.sessions.map((s) => (
                      <tr key={s.sessionId}>
                        <td>{s.projectName ?? <span className="faint">no project recorded</span>}<div className="faint pe-fine pe-id">{s.sessionId}</div></td>
                        <td className="r">{num(s.asked)}</td>
                        <td className="r">{num(s.answered)}</td>
                        <td className="r">{num(s.fast)}</td>
                        <td className="r">{num(s.unanswered)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
      <p className="faint pe-fine">
        Claude Code sends no event when a person answers a prompt, so each time is inferred from the permission request to
        the next event for the same tool. When the tool ran, that event arrives after it finished, so the time includes the
        tool’s own run. {report && report !== 'error' ? `A run of ${report.run} answers in a row under ${seconds} is recorded as a fast run.` : ''} There is no score.
      </p>
    </section>
  );
}

const GRANT_DAYS = [1, 7, 14, 30];

/**
 * The per-project opt-in for unattended runs to rely on earlier approvals.
 * Off by default, and the explanation beside the switch is the whole rule, so
 * nobody turns it on believing it does more or less than it does.
 */
export function GrantsPanel({ projects }: { projects: Project[] }) {
  const [rows, setRows] = useState<GrantSetting[] | null | 'error'>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.policyEvidence.grantSettings()
      .then((r) => { if (live) setRows(r); })
      .catch(() => { if (live) setRows('error'); });
    return () => { live = false; };
  }, [projects.length]);
  const save = async (projectId: string, enabled: boolean, days: number) => {
    setSaving(projectId); setProblem(null);
    try {
      const next = await window.wanigan.policyEvidence.setGrantSetting(projectId, enabled, days);
      setRows((prev) => (Array.isArray(prev) ? prev.map((r) => (r.projectId === projectId ? next : r)) : prev));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally { setSaving(null); }
  };
  return (
    <section className="pe-grants" aria-label="Unattended runs and earlier approvals">
      <SectionHead label="Unattended runs: deny unless a person granted it before" />
      <p className="dim pe-fine pe-grants-rule">
        A headless or scheduled run has nobody to ask, so every question the gate would put to you is denied. With this on
        for a project, a question is allowed instead when you approved the same call in an attended session of that project
        within the window: the exact command (spacing and quoting aside), the same write tool on a path under the directory you
        approved, or the same MCP tool. Approval means Wanigan saw the permission prompt and then the tool run. Every call
        allowed this way is a ledger row naming the grant it used, and every denial names the grant that was missing. Rules
        that deny outright still deny.
      </p>
      {rows === null ? <p className="faint pe-fine">Reading grant settings…</p>
        : rows === 'error' ? <Note tone="error">Wanigan could not read the grant settings.</Note>
          : !projects.length ? <p className="faint pe-fine">No projects yet.</p>
            : (
              <div className="pe-scroll">
                <table className="grid pe-table">
                  <thead><tr><th>Project</th><th>Rely on earlier approvals</th><th>Window</th><th className="r">Grants in window</th></tr></thead>
                  <tbody>
                    {projects.map((p) => {
                      const r = rows.find((x) => x.projectId === p.id) ?? { projectId: p.id, enabled: false, days: 7, grants: 0, newestAt: null };
                      return (
                        <tr key={p.id}>
                          <td>{p.name}</td>
                          <td>
                            <label className="pe-check">
                              <input type="checkbox" checked={r.enabled} disabled={saving === p.id}
                                     onChange={(e) => void save(p.id, e.target.checked, r.days)} />
                              {r.enabled ? 'On' : 'Off'}
                            </label>
                          </td>
                          <td>
                            <select className="field" value={r.days} disabled={saving === p.id}
                                    aria-label={`Grant window for ${p.name}`}
                                    onChange={(e) => void save(p.id, r.enabled, Number(e.target.value))}>
                              {GRANT_DAYS.map((d) => <option key={d} value={d}>{d} day{d === 1 ? '' : 's'}</option>)}
                            </select>
                          </td>
                          <td className="r">{num(r.grants)}{r.newestAt ? <div className="faint pe-fine">newest {ago(r.newestAt)}</div> : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
      {problem && <Note tone="error">{problem}</Note>}
    </section>
  );
}
