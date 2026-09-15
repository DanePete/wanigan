import { useCallback, useEffect, useRef, useState } from 'react';
import type { SkillListingReport, SkillListingRow } from '@shared/cost-types';
import { ConfirmNote, EmptyState, Mark, Note, Reading, SectionHead, Stat, num } from './bits';
import '../styles/cost.css';

/**
 * Skills listed to the model each turn, per harness, with the estimated cost
 * of the listing and — for personal skills Wanigan applied — the switch that
 * takes one out of the listing while keeping it invocable by name.
 *
 * The switch writes a file, so it is a T2 action: one sentence naming the
 * skill and the file, a verb button, and Cancel. Project skills never get it;
 * the row says where that change belongs instead.
 */

function Est({ n }: { n: number }) {
  return <>~{num(n)} <span className="cost-est">est.</span></>;
}

const DECIDED: Record<SkillListingRow['decidedBy'], string> = {
  'disable-model-invocation': 'disable-model-invocation in SKILL.md',
  allow_implicit_invocation: 'policy.allow_implicit_invocation in agents/openai.yaml',
  skillOverrides: 'skillOverrides setting',
  default: 'default',
};

export default function SkillListingCost({ projectId }: { projectId: string | null }) {
  const [report, setReport] = useState<SkillListingReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ row: SkillListingRow; allow: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const mine = ++sequence.current;
    try {
      const next = await window.wanigan.cost.skillListing(projectId);
      if (mine === sequence.current) { setReport(next); setError(null); }
    } catch (e) { if (mine === sequence.current) setError(e instanceof Error ? e.message : String(e)); }
  }, [projectId]);
  useEffect(() => {
    void load();
    // A reply for the previous project must not land after the switch.
    const ticket = sequence;
    return () => { ticket.current++; };
  }, [load]);

  const apply = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      const next = await window.wanigan.cost.setSkillModelInvocation(projectId, confirm.row.harness, confirm.row.path, confirm.allow);
      setReport(next);
      setDone(`${confirm.row.name} is ${confirm.allow ? 'listed to the model again' : 'now manual-only: invocable by name, not listed'}.`);
      setConfirm(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (error && !report) return <Note tone="warn"><strong>The skill listing could not be read.</strong> {error}</Note>;
  if (!report) return <Reading what="the skill listings" />;

  return (
    <section className="cost-card" aria-label="Skill listing cost">
      <div className="stat-grid">
        {report.providers.map((p) => (
          <Stat key={p.harness} label={`${p.label} · listed each turn`} value={num(p.listed + p.unknown)}
            sub={<><Est n={p.estTokens} /> tokens · {num(p.hidden)} manual-only</>} />
        ))}
      </div>
      <p className="faint cost-fine">{report.note}</p>
      {done && <Note tone="ok" onDismiss={() => setDone(null)}>{done}</Note>}
      {error && <Note tone="warn">{error}</Note>}
      {confirm && (
        <ConfirmNote
          what={<>{confirm.allow ? 'List' : 'Stop listing'} <span className="mono">{confirm.row.name}</span> for {confirm.row.harness === 'codex' ? 'Codex' : 'Claude Code'} by writing {confirm.row.harness === 'codex'
            ? <>policy.allow_implicit_invocation: {String(confirm.allow)} to its agents/openai.yaml</>
            : <>disable-model-invocation: {String(!confirm.allow)} to its SKILL.md frontmatter — Undo of the projection will then refuse, because the file no longer matches what Wanigan applied</>}</>}
          verb={confirm.allow ? 'List it' : 'Make manual-only'} busy={busy}
          onRun={() => void apply()} onCancel={() => setConfirm(null)} />
      )}
      {report.providers.map((p) => (
        <div key={p.harness}>
          <SectionHead label={p.label} count={p.rows.length} />
          {p.rows.length === 0 ? (
            <EmptyState posture="nothing-in-scope" title={`No ${p.label} skills were found.`} cue={p.harness === 'codex' ? `Codex skills live in .agents/skills here, in ~/.agents/skills, and in ${report.codexHome}/skills.` : 'Claude Code skills live in .claude/skills here, in ~/.claude/skills, and in plugins.'} />
          ) : (
            <div className="ctx-scroll">
              <table className="grid">
                <thead><tr><th>Skill</th><th>Where</th><th>Listed to the model</th><th className="r">Tokens</th><th>Switch</th></tr></thead>
                <tbody>
                  {p.rows.map((row) => (
                    <tr key={row.path}>
                      <td><span className="mono">{row.name}</span></td>
                      <td>{row.source}{row.managed ? ' · applied by Wanigan' : ''}</td>
                      <td>
                        {row.listed === true ? <Mark glyph="●" word="listed" tone="ok" />
                          : row.listed === false ? <Mark glyph="○" word="manual only" tone="quiet" />
                            : <Mark glyph="?" word="setting unreadable, counted as listed" tone="warn" />}
                        <span className="cost-cell-sub">{DECIDED[row.decidedBy]}</span>
                      </td>
                      <td className="r">{row.estTokens ? <Est n={row.estTokens} /> : '—'}</td>
                      <td>
                        {row.toggle
                          ? <button type="button" className="btn btn-sm" disabled={busy}
                              onClick={() => { setDone(null); setConfirm({ row, allow: row.listed === false }); }}>
                              {row.listed === false ? 'List it' : 'Make manual-only'}
                            </button>
                          : <span className="cost-cell-sub">{row.personal ? 'not applied by Wanigan — edit the file'
                            : row.source === 'project' || row.source === 'agents-project' ? 'project skill — propose in the review inbox'
                              : 'installed by the harness or a plugin — not Wanigan’s to switch'}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
