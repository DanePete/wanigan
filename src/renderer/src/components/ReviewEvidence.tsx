import type { ReactNode } from 'react';
import type { DocketDetail, GoalResumeReceipt, GoalTraceEvent } from '@shared/types';
import { Hint, Mark, Pill, SectionHead, Segmented, ago, markOf, usd } from './bits';
import { useViewMemory } from './viewMemory';

type Area = 'proof' | 'handoffs' | 'activity';
/** Evidence remains goal-wide: a Review task depends on proof from Verify. */
export default function ReviewEvidence({ docket, receipts, traces, onTask, children }: {
  docket: DocketDetail; receipts: GoalResumeReceipt[]; traces: GoalTraceEvent[];
  onTask: (id: string) => void; children: ReactNode;
}) {
  const [area, setArea] = useViewMemory<Area>(`${docket.id}/evidence`, 'proof');
  const attribution = (nodeId: string | null) => {
    const node = docket.nodes.find(node => node.id === nodeId);
    return node ? <button type="button" className="control-attribution" onClick={() => onTask(node.id)}>{node.title}</button> : <span className="faint">Goal record</span>;
  };
  return <aside className="control-proof" aria-label="Goal evidence">
          <details className="control-contract" open><summary>What done looks like<span>{docket.acceptance.length} acceptance checks</span></summary>
            <ol className="control-acceptance">{docket.acceptance.map((check, index) => <li key={index}>{check}</li>)}</ol>
          </details>
    <SectionHead label="Evidence" right={<span className="faint">Across this goal</span>} />
    <Segmented<Area> label="Evidence area" value={area} onChange={setArea} options={[{ value: 'proof', label: 'Proof' }, { value: 'handoffs', label: 'Handoffs' }, { value: 'activity', label: 'Activity' }]} />
    <div className="control-proof-body" key={area}>
      {area === 'proof' && <>
        <SectionHead label="Proof bundle" count={docket.proofs.length} />
        {docket.proofs.length === 0 ? <Hint>No evidence yet. A passing review gate is required before verification can complete.</Hint> : docket.proofs.map(proof => <article className="control-record" key={proof.id}>
          <div><Pill status={proof.status} /><span>{proof.kind}</span><time>{ago(proof.createdAt)}</time></div>
          <p>{proof.summary}</p>{attribution(proof.nodeId)}
        </article>)}
      </>}
      {area === 'handoffs' && <>
        <SectionHead label="Checkpoints" count={docket.checkpoints.length} />
        {docket.checkpoints.length === 0 ? <Hint>A checkpoint records the repository and conversation identity available at handoff.</Hint> : docket.checkpoints.map(checkpoint => <article className="control-record" key={checkpoint.id}>
          <div><span>Checkpoint</span><time>{ago(checkpoint.createdAt)}</time></div><p>{checkpoint.note}</p>{attribution(checkpoint.nodeId)}
          {checkpoint.repoCommit && <code>commit {checkpoint.repoCommit.slice(0, 10)}</code>}
          {checkpoint.conversationId && <code>thread {checkpoint.conversationId}</code>}
        </article>)}
        <SectionHead label="Recovery" count={receipts.length} />
        {receipts.length === 0 ? <Hint>No recovery receipt has been recorded.</Hint> : receipts.map(receipt => <article className="control-record" key={receipt.nodeId}>
          <Mark {...markOf(receipt.state === 'exact' ? 'passed' : receipt.state === 'writer_active' ? 'running' : 'blocked')} word={receipt.state.replaceAll('_', ' ')} />
          <p>{receipt.detail}</p>{attribution(receipt.nodeId)}
          {receipt.conversationId && <code>thread {receipt.conversationId}</code>}
        </article>)}
        {children}
      </>}
      {area === 'activity' && <>
        <SectionHead label="Recent signals" count={traces.length} />
        {traces.length === 0 ? <Hint>No operational signals recorded for this goal yet.</Hint> : traces.map(trace => <article className="control-record" key={trace.id}>
          <div><Pill status={trace.status} /><time>{ago(trace.createdAt)}</time></div>
          <p>{trace.toolName ?? trace.kind}{trace.summary ? ` · ${trace.summary}` : ''}</p>
          {attribution(trace.nodeId)}<span className="faint">{trace.durationMs !== null ? `${trace.durationMs} ms` : ''}{trace.costUsd ? ` · ${usd(trace.costUsd)}` : ''}</span>
        </article>)}
      </>}
    </div>
  </aside>;
}
