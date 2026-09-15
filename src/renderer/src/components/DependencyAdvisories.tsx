import { useCallback, useEffect, useState } from 'react';
import {
  ageLabel, advisoryUrl, isMalware, statusPhrase, type AdvisoryReport, type PackageAdvisory,
} from '@shared/dependency-advisories';
import { Mark, Note, type Tone } from './bits';

/**
 * Helper sweep · P11 deps. Known advisories for the packages a session added
 * or upgraded, under its Dependencies section.
 *
 * On open it asks main for what earlier checks stored — a read of Wanigan's own
 * database, never a request — and shows each answer with its age. The lookup
 * itself happens only on the button, and the button is there only while the
 * Settings switch is on. Every host is main's: this component sends a session
 * id and a boolean. What comes back is worded by shared/dependency-advisories,
 * which has no word for "safe".
 */

function markFor(p: PackageAdvisory): { glyph: string; word: string; tone: Tone } {
  if (p.malware > 0) return { glyph: '✕', word: 'malware', tone: 'bad' };
  if (p.advisories.length) return { glyph: '⚠', word: `${p.advisories.length} advisor${p.advisories.length === 1 ? 'y' : 'ies'}`, tone: 'serious' };
  if (p.published.state === 'read' && p.published.isNew) return { glyph: '◷', word: 'new, review', tone: 'warn' };
  if (p.status === 'error') return { glyph: '?', word: 'unknown', tone: 'warn' };
  if (p.status === 'none-listed') return { glyph: '○', word: 'none listed', tone: 'quiet' };
  return { glyph: '–', word: 'not looked up', tone: 'quiet' };
}

function publishedPhrase(p: PackageAdvisory, now: number): string | null {
  if (p.published.state === 'not-covered') return null;
  if (p.published.state === 'not-read') return p.status === 'not-exact' ? null : `publish time not read: ${p.published.reason}`;
  const hours = Math.max(0, Math.round((now - p.published.at) / 3600_000));
  return p.published.isNew
    ? `published ${hours} h ago — under 72 hours, so review it before trusting it`
    : `published ${new Date(p.published.at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
}

function PackageRow({ p, now }: { p: PackageAdvisory; now: number }) {
  const mark = markFor(p);
  const published = publishedPhrase(p, now);
  const where = [...new Set(p.sources.map((s) => s.manifest))].join(', ');
  return (
    <li className="rw-adv-row">
      <div className="rw-adv-head">
        <Mark {...mark} />
        <span className="mono">{p.name}{p.version ? `@${p.version}` : ''}</span>
        <span className="faint">{p.ecosystem} · {where}</span>
      </div>
      <p className="rw-adv-line">
        {statusPhrase(p)}
        {p.checkedAt !== null && <span className="faint"> · {ageLabel(p.checkedAt, now)}{p.fromCache ? ', from an earlier check' : ''}</span>}
      </p>
      {published && <p className={`rw-adv-line${p.published.state === 'read' && p.published.isNew ? '' : ' faint'}`}>{published}</p>}
      {p.advisories.length > 0 && (
        <ul className="rw-adv-ids" aria-label={`Advisories for ${p.name}`}>
          {p.advisories.slice(0, 12).map((a) => (
            <li key={a.id}>
              <button type="button" className={`btn btn-sm mono${isMalware(a.id) ? ' rw-adv-mal' : ''}`}
                      aria-label={`Open ${a.id} on osv.dev in your browser`}
                      onClick={() => void window.wanigan.shell.openExternal(advisoryUrl(a.id))}>
                {isMalware(a.id) ? `malware · ${a.id}` : a.id} ↗
              </button>
            </li>
          ))}
          {p.advisories.length > 12 && <li className="faint">and {p.advisories.length - 12} more</li>}
        </ul>
      )}
    </li>
  );
}

export function DependencyAdvisories({ sessionId, refreshKey, hasCandidates }: { sessionId: string; refreshKey: string; hasCandidates: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [report, setReport] = useState<AdvisoryReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setErr(null);
    window.wanigan.deps.advisorySetting().then((r) => { if (live) setEnabled(r.enabled); }).catch(() => { if (live) setEnabled(false); });
    // The cache only: this read makes no request, whatever the switch says.
    window.wanigan.deps.advisories(sessionId, { lookup: false })
      .then((r) => { if (live) setReport(r); })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [sessionId, refreshKey]);

  const check = useCallback(async (refresh: boolean) => {
    setBusy(true); setErr(null);
    try { setReport(await window.wanigan.deps.advisories(sessionId, { lookup: true, refresh })); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [sessionId]);

  if (!hasCandidates) return null;
  const now = report?.assembledAt ?? Date.now();
  const looked = report?.packages.some((p) => p.checkedAt !== null) ?? false;
  // After a lookup every package is listed, including the ones it could not
  // look up and why; before one, only answers an earlier check stored are.
  const showList = !!report && (report.mode === 'lookup' || looked);
  const requests = report?.requests ?? [];
  return (
    <section className="rw-adv" aria-label="Advisories for added and upgraded packages">
      <div className="rw-adv-bar">
        <strong>Advisories</strong>
        {enabled
          ? <>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void check(false)}>
                {busy ? 'Checking…' : 'Check advisories'}
              </button>
              {looked && !busy && <button type="button" className="btn btn-sm" onClick={() => void check(true)}>Check again</button>}
            </>
          : enabled === false && <span className="faint">Lookups are off. Turn on “Dependency advisory lookups” in Settings to check these packages against OSV.</span>}
      </div>
      {err && <Note tone="error">{err}</Note>}
      {report && report.mode === 'lookup' && (
        <p className="faint rw-adv-line">
          {requests.length
            ? `This check sent ${requests.map((r) => `${r.count} request${r.count === 1 ? '' : 's'} to ${r.host}`).join(', ')}.`
            : 'Every answer came from earlier checks; no request was sent.'}
          {' '}An advisory answer is reused for a day; Check again asks OSV now.
        </p>
      )}
      {report && !looked && report.mode === 'cache-only' && (
        <p className="faint rw-adv-line">No advisory lookup has been made for these packages{enabled ? ' yet' : ''}.</p>
      )}
      {report && showList && (
        <>
          <ul className="rw-adv-list">
            {report.packages.map((p) => <PackageRow key={`${p.ecosystem}:${p.name}:${p.version ?? p.sources[0]?.spec ?? ''}`} p={p} now={now} />)}
          </ul>
          <dl className="rw-adv-coverage" aria-label="Coverage by ecosystem">
            {report.coverage.map((c) => (
              <div key={c.ecosystem} className="rw-adv-cov">
                <dt className="mono">{c.ecosystem}</dt>
                <dd>
                  <span>advisories {c.advisories}</span>
                  <span className="faint"> — {c.advisoriesDetail}</span>
                </dd>
                <dd>
                  <span>publish time {c.publishTime}</span>
                  <span className="faint"> — {c.publishDetail}</span>
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {report?.notes.map((n) => <p key={n} className="faint rw-adv-line">{n}</p>)}
    </section>
  );
}
