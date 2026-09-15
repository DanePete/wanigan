import { useEffect, useState } from 'react';
import type { ExposureLeadView } from '@shared/types';
import { Mark, Note, SectionHead, ago, dur } from './bits';
import '../styles/policy-evidence.css';
import '../styles/policy-surface.css';

/**
 * Exposure leads: a sensitive read, then a way for data to leave, in the same
 * session, with the time between them. Always labelled a lead and not proof —
 * two recorded events in an order that makes a question worth asking, and
 * nothing about what bytes moved.
 */

const SINK_WORD: Record<ExposureLeadView['sink']['kind'], string> = {
  web: 'web fetch or search',
  upload: 'data sent over HTTP',
  'copy-to-host': 'copy to another host',
  'raw-socket': 'raw socket',
  'git-push-other-remote': 'push to a remote other than origin',
  'mcp-remote': 'MCP server off this machine',
  'mcp-unknown': 'MCP server, locality cannot be confirmed',
};

export function LeadList({ leads, showProject }: { leads: ExposureLeadView[]; showProject: boolean }) {
  return (
    <ul className="pe-leads">
      {leads.map((l) => (
        <li key={`${l.read.eventId}-${l.sink.eventId}`}>
          <Mark glyph="⇢" word="lead, not proof" tone="warn" />
          <span className="pe-lead-line">
            {showProject && <strong>{l.projectName ?? 'no project recorded'} · </strong>}
            read <code>{l.read.path}</code>, then {SINK_WORD[l.sink.kind]} {dur(l.gapMs)} later
          </span>
          <span className="faint pe-fine pe-lead-what"><code>{l.read.what}</code> → <code>{l.sink.what}</code></span>
          <span className="faint pe-fine">{ago(l.sink.at)}{l.earlierReads ? ` · ${l.earlierReads} earlier sensitive read${l.earlierReads === 1 ? '' : 's'} in this session` : ''}</span>
        </li>
      ))}
    </ul>
  );
}

/** For the egress report: the last week, every session. */
export default function ExposureLeads() {
  const [leads, setLeads] = useState<ExposureLeadView[] | null | 'error'>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.policyEvidence.exposure()
      .then((r) => { if (live) setLeads(r); })
      .catch(() => { if (live) setLeads('error'); });
    return () => { live = false; };
  }, []);
  return (
    <section className="pe-exposure" aria-label="Exposure leads">
      <SectionHead label="Exposure leads, last 7 days" />
      {leads === null ? <p className="faint pe-fine">Reading recorded tool calls…</p>
        : leads === 'error' ? <Note tone="error">Wanigan could not read the recorded tool calls.</Note>
          : !leads.length ? <p className="dim pe-fine">No session read a credential file and then sent anything anywhere, in what was recorded.</p>
            : <LeadList leads={leads} showProject />}
      <p className="faint pe-fine">
        A lead joins a read of a credential store, an .env file or a keychain to a later web call, upload, copy to another
        host, raw socket, push to a remote other than origin, or MCP call to a server not on this machine, in the same
        session. It is a lead, not proof: Wanigan does not know what the second call carried. Commands are read from the
        stored 160-character summary.
      </p>
    </section>
  );
}
