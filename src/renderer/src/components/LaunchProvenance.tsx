import { useEffect, useState } from 'react';
import type { LaunchOrigin, LaunchProvenanceInput, LaunchValue } from '@shared/launch-provenance';
import { SOURCE_WORDS, resolveLaunchProvenance } from '@shared/launch-provenance';
import '../styles/runtime.css';

/**
 * "Where this value came from", as one list. The dialog resolves it from the
 * form it holds; a live session reads what main recorded at launch.
 */

export function ProvenanceList({ values, origin }: { values: LaunchValue[]; origin: LaunchOrigin }) {
  return (
    <div className="provenance">
      <dl className="provenance-list">
        {values.map((row) => (
          <div key={row.field} data-provenance-field={row.field}>
            <dt>{row.label}</dt>
            <dd>
              <span className="provenance-value">{row.value ?? '—'}</span>
              <span className="provenance-source" data-source={row.source}>{SOURCE_WORDS[row.source]}{row.note ? ` · ${row.note}` : ''}</span>
            </dd>
          </div>
        ))}
      </dl>
      {origin === 'unknown' && (
        <p className="proc-reading">This session was not launched from this window, so Wanigan resolved these from its launch snapshot.</p>
      )}
    </div>
  );
}

/** The New Session dialog's version: resolved live from the form. */
export function DialogProvenance({ input }: { input: Omit<LaunchProvenanceInput, 'env' | 'origin' | 'provider'> & { providerId: string; providerLabel: string } }) {
  const [profile, setProfile] = useState<{ env: LaunchProvenanceInput['env']; packSource: 'builtin' | 'local' | null; packLabel: string | null }>(
    { env: { provider: [], account: null, wanigan: [] }, packSource: null, packLabel: null });
  useEffect(() => {
    let live = true;
    if (!input.providerId) return;
    window.wanigan.launchProvenance.envNames(input.providerId)
      .then((next) => { if (live) setProfile(next); })
      .catch(() => { /* the demo workspace, or a profile that vanished */ });
    return () => { live = false; };
  }, [input.providerId]);
  const { providerId: _id, providerLabel, ...rest } = input;
  void _id;
  const values = resolveLaunchProvenance({
    ...rest, origin: 'dialog', env: profile.env,
    provider: { label: providerLabel, packSource: profile.packSource, packLabel: profile.packLabel },
  });
  return (
    <details className="launch-provenance">
      <summary>Where these values come from</summary>
      <ProvenanceList values={values} origin="dialog" />
    </details>
  );
}

/** A live session's version, read from what main recorded. */
export function SessionProvenance({ sessionId }: { sessionId: string }) {
  const [reading, setReading] = useState<{ origin: LaunchOrigin; values: LaunchValue[] } | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    window.wanigan.launchProvenance.forSession(sessionId)
      .then((next) => { if (live) setReading(next); })
      .catch(() => { if (live) setReading(null); });
    return () => { live = false; };
  }, [sessionId]);
  if (reading === undefined) return <p className="proc-reading">Reading the launch record…</p>;
  if (reading === null) return <p className="proc-reading">No launch record for this session.</p>;
  return <ProvenanceList values={reading.values} origin={reading.origin} />;
}
