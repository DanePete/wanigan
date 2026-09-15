import { useEffect, useState } from 'react';
import type { SkillSurfaceView } from '@shared/types';
import type { SurfaceFinding } from '@shared/skill-surface';
import { Mark, Note, ago, num, type Tone } from './bits';
import '../styles/policy-evidence.css';
import '../styles/policy-surface.css';

/**
 * What a skill can make an agent do, and whether a person has approved that.
 *
 * Shown in the skill reader. The line at the top is the state — approved, grown
 * since approval, or never approved — and the delta beneath it is exactly what
 * the approve button records. Findings carry a severity and a code; there is no
 * score and no "safe" verdict, because reading a skill's text cannot prove one.
 */

const SEVERITY: Record<SurfaceFinding['severity'], { glyph: string; tone: Tone }> = {
  critical: { glyph: '‼', tone: 'bad' },
  high: { glyph: '!', tone: 'serious' },
  medium: { glyph: '◆', tone: 'warn' },
  low: { glyph: '·', tone: 'quiet' },
};

function Findings({ items }: { items: SurfaceFinding[] }) {
  if (!items.length) return <p className="faint pe-fine">No findings.</p>;
  return (
    <ul className="pe-findings">
      {items.map((f, i) => (
        <li key={`${f.code}-${f.file}-${i}`}>
          <Mark glyph={SEVERITY[f.severity].glyph} word={`${f.severity} · ${f.code}`} tone={SEVERITY[f.severity].tone} />
          <span className="pe-fine"><code>{f.file}</code> — {f.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function Names({ label, items }: { label: string; items: string[] }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{items.length ? items.map((x) => <code key={x}>{x}</code>) : <span className="faint">none</span>}</dd>
    </>
  );
}

export default function SkillSurfacePanel({ skillPath }: { skillPath: string }) {
  const [view, setView] = useState<SkillSurfaceView | null | 'error'>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setView(null); setError(null);
    window.wanigan.policyEvidence.skillSurface(skillPath)
      .then((v) => { if (live) setView(v); })
      .catch((e) => { if (live) { setView('error'); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; };
  }, [skillPath]);

  if (view === null) return <p className="faint pe-fine">Reading this skill’s capability surface…</p>;
  if (view === 'error') return <Note tone="error">Wanigan could not read this skill’s capability surface. {error}</Note>;

  const approve = async () => {
    setBusy(true); setError(null);
    try { setView(await window.wanigan.policyEvidence.approveSkillSurface(skillPath, view.digest)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const d = view.delta;
  const added = d.commands.length + d.hosts.length + d.paths.length + d.findings.length;
  const state: { glyph: string; word: string; tone: Tone } = !view.approved
    ? { glyph: '○', word: 'surface never approved', tone: 'warn' }
    : d.grew ? { glyph: '!', word: `surface grew since approval: ${num(added)} new`, tone: 'bad' }
      : { glyph: '✓', word: view.approved.how === 'projected' ? 'surface as projected by Wanigan' : 'surface matches what you approved', tone: 'ok' };
  const s = view.surface;
  return (
    <section className="pe-surface" aria-label="Capability surface">
      <p className="pe-marks">
        <Mark glyph={state.glyph} word={state.word} tone={state.tone} />
        {view.approved && <span className="faint pe-fine">approved {ago(view.approved.at)}</span>}
      </p>
      {(d.grew || !view.approved) && (
        <div className="pe-surface-delta">
          <p className="pe-fine">{view.approved ? 'New since the surface you approved:' : 'Everything this skill can reach, for a first approval:'}</p>
          <dl className="pe-facts">
            <Names label="Commands" items={d.commands} />
            <Names label="Hosts" items={d.hosts} />
            <Names label="Paths" items={d.paths} />
          </dl>
          <Findings items={d.findings} />
          <div className="pe-surface-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void approve()}>
              {busy ? 'Recording…' : 'Approve this surface'}
            </button>
            <span className="faint pe-fine">Records that you read what is listed. It does not make the skill safe, and a later change asks again.</span>
          </div>
        </div>
      )}
      <details className="pe-trace">
        <summary>Whole surface: {num(s.commands.length)} commands, {num(s.hosts.length)} hosts, {num(s.paths.length)} paths, {num(s.findings.length)} findings, from {num(s.files)} files</summary>
        <dl className="pe-facts">
          <Names label="Commands" items={s.commands} />
          <Names label="Hosts" items={s.hosts} />
          <Names label="Paths" items={s.paths} />
        </dl>
        <Findings items={s.findings} />
      </details>
      {error && <Note tone="error">{error}</Note>}
    </section>
  );
}
