import type { AgentDefinitionsReport, CodexLoaderReport, ReferenceLintReport } from '@shared/cost-types';
import { EmptyState, Mark, Note, SectionHead, Stat, num } from './bits';
import { ContextFileLink } from './ContextWorkspace';
import '../styles/cost.css';

/**
 * Three Context areas that answer the questions the Claude Code chain above
 * them cannot: what Codex is told and where it cuts, which references in the
 * instruction files have gone stale, and which subagents start without
 * CLAUDE.md at all.
 *
 * Grammar, as everywhere in this view: bytes, file counts and lines are
 * observed and render plain; token figures are estimates and carry "~" and
 * "est."; a modelled rule (the loader's order and cut) says it is modelled.
 */

const bytes = (n: number) => `${num(n)} B`;

function Est({ n }: { n: number }) {
  return <>~{num(n)} <span className="cost-est">est.</span></>;
}

const STATUS = {
  loaded: { glyph: '●', word: 'loads', tone: 'ok' as const },
  truncated: { glyph: '◐', word: 'cut', tone: 'warn' as const },
  'past-budget': { glyph: '✕', word: 'past the budget', tone: 'bad' as const },
  blank: { glyph: '○', word: 'blank', tone: 'quiet' as const },
};

export function CodexLoaderPanel({ report, error }: { report: CodexLoaderReport | null; error: string | null }) {
  if (error && !report) return <Note tone="warn"><strong>The Codex loader could not be read.</strong> {error}</Note>;
  if (!report) return null;
  const { chain } = report;
  const share = chain.maxBytes > 0 ? chain.totalBytes / chain.maxBytes : 0;
  const past = chain.files.filter((f) => f.status === 'truncated' || f.status === 'past-budget');
  const budget = report.skillBudget;
  return (
    <div className="cost-card">
      <div className="stat-grid">
        <Stat label="AGENTS.md chain" value={bytes(chain.totalBytes)} sub={`${num(chain.files.filter((f) => f.status !== 'blank').length)} files, root first`} />
        <Stat label="Byte budget" value={bytes(chain.maxBytes)} sub={report.maxBytesFrom === 'config' ? 'project_doc_max_bytes in config.toml' : 'Codex default'} />
        <Stat label="Past the budget" value={bytes(chain.droppedBytes)} sub={past.length ? `${num(past.length)} files cut or dropped` : 'nothing is cut'} />
        <Stat label="Skills listed each turn" value={num(report.listedSkills)} sub={<>{report.listedTokens > 0 ? <Est n={report.listedTokens} /> : 'no listing'} tokens</>} />
      </div>
      <meter className="cost-meter" min={0} max={1} low={0.75} high={0.9} optimum={0.2} value={Math.min(1, share)}
        aria-label={`AGENTS.md chain uses ${Math.round(share * 100)}% of the ${bytes(chain.maxBytes)} budget`} />
      <p className="faint cost-fine">
        {Math.round(share * 100)}% of Codex’s project-doc budget for a session started at {report.projectRoot}.
        Codex home {report.codexHome}{report.accountLabel ? ` (account ${report.accountLabel})` : ''}. Load order and cut are modelled on the 0.154.0 loader.
      </p>

      <SectionHead label="Load order" count={chain.files.length} />
      {chain.files.length === 0 ? (
        <EmptyState posture="nothing-in-scope" title="No AGENTS.md between the project root and this directory."
          cue={`Codex looks for ${['AGENTS.override.md', 'AGENTS.md', ...report.fallbacks].join(', then ')} in each directory from ${report.rootDir ?? report.projectRoot} down.`} />
      ) : (
        <div className="ctx-scroll">
          <table className="grid cost-chain">
            <thead><tr><th>File</th><th>Status</th><th className="r">Bytes</th><th className="r">Running total</th><th>Falls past the budget</th></tr></thead>
            <tbody>
              {chain.files.map((f) => {
                const s = STATUS[f.status];
                return (
                  <tr key={f.path}>
                    <td>
                      <ContextFileLink path={f.path}>{f.path.startsWith(report.projectRoot) ? f.path.slice(report.projectRoot.length + 1) || f.name : f.path}</ContextFileLink>
                      {f.shadows.length > 0 && <span className="cost-cell-sub">shadows {f.shadows.join(', ')}</span>}
                    </td>
                    <td><Mark glyph={s.glyph} word={s.word} tone={s.tone} /></td>
                    <td className="r">{num(f.bytes)}</td>
                    <td className="r">{num(f.runningTotal)}</td>
                    <td className="mono">{f.droppedRange ? `bytes ${num(f.droppedRange[0])}–${num(f.droppedRange[1])} of ${f.name}` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {report.global && (
        <p className="faint cost-fine">
          Also given to every session: {report.global.path} ({bytes(report.global.bytes)}), the account’s own instructions,
          joined ahead of the project docs and not counted against this budget.
        </p>
      )}

      <SectionHead label="Skills listing" count={report.skills.length} />
      <p className="cost-fine">
        {budget.status === 'known'
          ? <>Budget {num(budget.tokens)} tokens — {budget.source === 'window-share'
              ? `2% of ${report.model ?? 'the model'}’s ${num(budget.contextWindow ?? 0)}-token window (${report.contextWindowSource ?? 'recorded'})`
              : budget.source === 'explicit-capped' ? 'skills.max_context_tokens, capped at 10,000' : 'skills.max_context_tokens in config.toml'}.
            {' '}Listing: <Est n={report.listedTokens} /> tokens{report.listedTokens > budget.tokens ? ' — over budget, so Codex shortens descriptions to fit.' : '.'}</>
          : <>The listing budget is unknown: {budget.reason} Listing: <Est n={report.listedTokens} /> tokens.</>}
      </p>
      {report.skills.length > 0 && (
        <div className="ctx-scroll">
          <table className="grid">
            <thead><tr><th>Skill</th><th>Root</th><th>Listed to the model</th><th className="r">Tokens</th></tr></thead>
            <tbody>
              {report.skills.map((s) => (
                <tr key={s.path}>
                  <td className="mono">{s.name}</td>
                  <td>{s.root === 'codex-home' ? 'Codex home' : s.root}</td>
                  <td>{s.listed
                    ? <Mark glyph="●" word={s.implicit === 'unknown' ? 'listed (policy unreadable)' : 'listed'} tone="ok" />
                    : <Mark glyph="○" word="manual only" tone="quiet" />}</td>
                  <td className="r">{s.listed ? <Est n={s.estTokens} /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {report.notes.length > 0 && <ul className="cost-cause-list faint">{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
    </div>
  );
}

export function ReferenceLintPanel({ report, error }: { report: ReferenceLintReport | null; error: string | null }) {
  if (error && !report) return <Note tone="warn"><strong>Stale references could not be checked.</strong> {error}</Note>;
  if (!report) return null;
  const refs = report.files.reduce((n, f) => n + f.references, 0);
  return (
    <div className="cost-card">
      <SectionHead label="References that do not resolve" count={report.issues.length} />
      {report.issues.length === 0 ? (
        <p className="faint cost-fine">
          {num(refs)} path and command references across {num(report.files.length)} instruction files; every one resolves.
        </p>
      ) : (
        <div className="ctx-scroll">
          <table className="grid">
            <thead><tr><th>Where</th><th>Reference</th><th>Finding</th></tr></thead>
            <tbody>
              {report.issues.map((issue) => (
                <tr key={`${issue.file}:${issue.line}:${issue.text}`}>
                  <td><ContextFileLink path={issue.file}>{issue.file.split('/').slice(-2).join('/')}:{issue.line}</ContextFileLink></td>
                  <td className="mono">{issue.text}</td>
                  <td>{issue.kind === 'path'
                    ? <>No such path{issue.suggestion ? <> — did you mean <span className="mono">{issue.suggestion}</span>?</> : '.'}</>
                    : <>Not on the PATH agents launch with.</>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="faint cost-fine">{report.note}{report.tracked ? '' : ' git ls-files could not be read, so there are no suggestions.'}</p>
    </div>
  );
}

export function SubagentsPanel({ report, error }: { report: AgentDefinitionsReport | null; error: string | null }) {
  if (error && !report) return <Note tone="warn"><strong>Agent definitions could not be read.</strong> {error}</Note>;
  if (!report) return null;
  const omitting = report.agents.filter((a) => a.omitClaudeMd === true);
  return (
    <div className="cost-card">
      <div className="stat-grid">
        <Stat label="Agent definitions" value={num(report.agents.length)} sub="project, personal and plugin" />
        <Stat label="Load no CLAUDE.md" value={num(omitting.length)} sub="omitClaudeMd: true" />
        <Stat label="Claude Code" value={report.installedVersion ?? 'unknown'} sub={`key added in ${report.keySince}`} />
      </div>
      {report.supported === false && <Note tone="warn">{report.note}</Note>}
      {report.agents.length === 0 ? (
        <EmptyState posture="nothing-yet" title="No subagents are defined for this project."
          cue="Agents live in .claude/agents/*.md here, in ~/.claude/agents, or in an installed plugin." />
      ) : (
        <div className="ctx-scroll">
          <table className="grid">
            <thead><tr><th>Agent</th><th>Scope</th><th>Instructions</th><th>Model</th></tr></thead>
            <tbody>
              {report.agents.map((a) => (
                <tr key={a.path}>
                  <td><span className="mono">{a.name}</span><span className="cost-cell-sub">{a.description}</span></td>
                  <td>{a.plugin ? `plugin · ${a.plugin}` : a.scope}</td>
                  <td>{a.omitClaudeMd === true
                    ? <Mark glyph="⊘" word="loads no CLAUDE.md (managed policy still loads)" tone="warn" />
                    : a.omitClaudeMd === 'unknown'
                      ? <Mark glyph="?" word="omitClaudeMd set to a value the CLI ignores" tone="quiet" />
                      : <Mark glyph="●" word="CLAUDE.md chain as above" tone="quiet" />}</td>
                  <td className="mono">{a.model ?? 'inherit'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {report.supported !== false && <p className="faint cost-fine">{report.note}</p>}
    </div>
  );
}
