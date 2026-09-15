import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SECRET_RULE_LABEL, type SecretScanReport } from '@shared/secret-scan';
import type { AssistedByPreview } from '@shared/assisted-by';
import { ConfirmNote, Note, num } from './bits';
import '../styles/publish-checks.css';

/*
 * What a commit or a push would carry that the person pressing the button
 * should see first: possible secrets, and the Assisted-by lines a commit will
 * end with. The main process enforces both (src/main/guarded-git.ts). These
 * panels say what it will enforce, in the words it will enforce it with, so the
 * button that goes past a finding is never a surprise and never a formality.
 */

const DONE = { commit: 'committed', push: 'pushed' } as const;
const ANYWAY = { commit: 'Commit anyway', push: 'Push anyway' } as const;

const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const when = (ts: number) => new Date(ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

/** Every finding, where it is, what it looks like and the line with the value masked, plus what the scan did not read. */
export function SecretFindings({ report }: { report: SecretScanReport }) {
  const count = report.findings.length + report.omitted;
  const act = report.action;
  return (
    <div className="pc-findings">
      <p className="pc-lead">
        {count ? (
          <><span aria-hidden="true">✕ </span><strong>{plural(count, 'possible secret')} in {report.scope}.</strong> Nothing has been {DONE[act]}.</>
        ) : report.unreadable ? (
          <><span aria-hidden="true">? </span><strong>Wanigan could not check {report.scope} for secrets:</strong> {report.unreadable}. Nothing has been {DONE[act]}.</>
        ) : (
          <><span aria-hidden="true">◑ </span><strong>Part of {report.scope} was not checked for secrets.</strong> Nothing has been {DONE[act]}.</>
        )}
      </p>
      {report.findings.length > 0 && (
        <ul className="pc-list" aria-label="Possible secrets">
          {report.findings.map((f, i) => (
            <li key={`${f.commit ?? ''}:${f.file}:${f.line}:${f.rule}:${i}`} className="pc-finding">
              <span className="pc-where">{f.file}:{f.line}{f.commit ? ` · ${f.commit.slice(0, 8)}` : ''}</span>
              <span className="pc-rule">{SECRET_RULE_LABEL[f.rule]}</span>
              <code className="pc-excerpt">{f.excerpt}</code>
            </li>
          ))}
        </ul>
      )}
      {report.partial && <p className="pc-foot">Not read: {report.partial}.</p>}
      <p className="pc-foot">
        {report.omitted > 0 && <>{plural(report.omitted, 'more finding')} not listed; {ANYWAY[act]} goes past those too. </>}
        {report.suppressed > 0 && <>{plural(report.suppressed, 'line')} marked <span className="mono">wanigan:allow-secret</span> not reported. </>}
        Choose {ANYWAY[act]} only if you have read {count ? (count === 1 ? 'it' : 'them') : 'this'} and{' '}
        {count ? (count === 1 ? 'it is not a real credential' : 'none is a real credential') : 'accept what was not checked'}.
      </p>
    </div>
  );
}

/** A clean scan, said as what it is: shapes looked for and not found, over a stated amount. */
function CleanScan({ report }: { report: SecretScanReport }) {
  return (
    <span className="pc-clean">
      <span aria-hidden="true">✓ </span>No credential shapes found in {report.scope} ({plural(report.addedLines, 'added line')} read
      {report.suppressed > 0 ? `, ${plural(report.suppressed, 'line')} marked wanigan:allow-secret` : ''}). Wanigan looks for
      known key shapes, so this is not proof there is none.
    </span>
  );
}

export type PublishConfirm = { what: ReactNode; verb: string; tone: 'warn' | 'error'; run: () => Promise<void> };

/**
 * The push confirmation, decided by the scan that ran when Push was pressed:
 * findings replace the sentence and the verb, and a clean scan is stated under
 * it. `run` is handed the digest only when the scan needs one.
 */
export function pushConfirmation(report: SecretScanReport, what: string, verb: string,
  run: (acknowledge: string | undefined) => Promise<void>): PublishConfirm {
  if (report.needsAcknowledgement) {
    return { what: <SecretFindings report={report} />, verb: ANYWAY.push, tone: 'error', run: () => run(report.digest) };
  }
  return { what: <>{what} <CleanScan report={report} /></>, verb, tone: 'warn', run: () => run(undefined) };
}

/** The lines a commit will end with, or why none can be worked out. Nothing at all while the setting is off. */
export function AssistedByLines({ preview, error }: { preview: AssistedByPreview | null; error: string | null }) {
  if (error) {
    return (
      <p className="pc-trailers-note" role="status">
        <span aria-hidden="true">? </span>The Assisted-by lines could not be worked out: {error} A commit now is refused for the same reason.
      </p>
    );
  }
  if (!preview?.enabled) return null;
  const span = preview.since === null ? 'on this branch, which has no commit yet' : `since the last commit, ${when(preview.since)}`;
  return (
    <div className="pc-trailers" role="group" aria-label="Assisted-by trailers">
      <p className="pc-trailers-head">
        Assisted-by · only sessions Wanigan started and recorded in this checkout {span}
      </p>
      {preview.trailers.length ? (
        <pre className="pc-trailers-lines">{preview.trailers.join('\n')}</pre>
      ) : (
        <p className="pc-trailers-note">No recorded session worked here {span}, so this commit gets no Assisted-by line.</p>
      )}
    </div>
  );
}

type CommitStatus = { root: string; branch: string | null; staged: unknown[]; unstaged: unknown[]; clean: boolean };

/**
 * The Git view's commit box: message, Assisted-by preview, and the secret check
 * that runs when Commit is pressed. Mounted per repository (keyed by root), so a
 * scan or a preview for one repository can never be shown over another.
 */
export function CommitBox({ st, headHash, msg, setMsg, busy, act }: {
  st: CommitStatus;
  /** The commit HEAD names, so the preview is re-read when a commit lands. */
  headHash: string | null;
  msg: string;
  setMsg: (value: string) => void;
  busy: string | null;
  act: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const root = st.root;
  const [scan, setScan] = useState<{ report: SecretScanReport; all: boolean } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<AssistedByPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  // Bumped after every commit attempt: a refusal because the lines changed has
  // to put the new lines on screen, and nothing else about the tree moved.
  const [attempts, setAttempts] = useState(0);
  const changeKey = `${st.branch ?? ''}|${headHash ?? ''}|${st.staged.length}|${st.unstaged.length}|${attempts}`;
  // The findings open under the buttons, so pressing Commit never moves the
  // button under the pointer, and are brought into view: in a short pane the
  // list and its Commit anyway would otherwise sit below the fold unseen.
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scan) panel.current?.scrollIntoView({ block: 'nearest' });
  }, [scan]);

  useEffect(() => {
    let live = true;
    window.wanigan.git.assistedBy(root).then(
      (p) => { if (live) { setPreview(p); setPreviewErr(null); } },
      (e: unknown) => { if (live) { setPreview(null); setPreviewErr(message(e)); } },
    );
    return () => { live = false; };
  }, [root, changeKey]);

  const trailers = preview?.enabled ? preview.trailers : [];

  async function commit(all: boolean, acknowledge?: string) {
    setScan(null); setCheckErr(null);
    if (acknowledge === undefined) {
      setChecking(true);
      let report: SecretScanReport;
      try {
        report = await window.wanigan.git.scanSecrets(root, { action: 'commit', all });
      } catch (e) {
        setCheckErr(`The secret check did not run, so nothing was committed: ${message(e)}`);
        return;
      } finally {
        setChecking(false);
      }
      if (report.needsAcknowledgement) { setScan({ report, all }); return; }
    }
    await act('Commit', async () => {
      try {
        const out = await window.wanigan.git.commit(root, msg, { all, acknowledge, trailers });
        setMsg('');
        return out;
      } finally {
        setAttempts((n) => n + 1);
      }
    });
  }

  // Until the first preview read answers, the list a commit would send is not
  // known yet; sending an empty one while the setting is on is a refusal
  // waiting to happen, so the buttons wait for that one read instead.
  const previewPending = preview === null && previewErr === null;
  const blocked = !!busy || checking || previewPending || !msg.trim();
  return (
    <div className="gt-commit">
      <textarea value={msg} aria-label="Commit message" placeholder="Commit message" onChange={(e) => setMsg(e.target.value)} />
      <AssistedByLines preview={preview} error={previewErr} />
      <div className="pc-actions">
        <button className="btn btn-primary" disabled={blocked || !st.staged.length} onClick={() => void commit(false)}>
          {checking ? 'Checking…' : `Commit${st.staged.length ? ` ${st.staged.length} file${st.staged.length > 1 ? 's' : ''}` : ''}`}
        </button>
        {/* Same message check as Commit: without it this button is enabled only
            to fail in the main process on an empty message. The label says what
            it does, so it carries no hover tooltip. */}
        <button className="btn" disabled={blocked || !st.unstaged.length} onClick={() => void commit(true)}>
          Stage all &amp; commit
        </button>
      </div>
      {!st.staged.length && !st.clean && (
        <span className="faint pc-hint">Stage something, or use “Stage all &amp; commit”.</span>
      )}
      {checkErr && <Note tone="error">{checkErr}</Note>}
      {scan && (
        <div ref={panel}>
          <ConfirmNote tone="error" what={<SecretFindings report={scan.report} />} verb={ANYWAY.commit} busy={!!busy}
                       onCancel={() => setScan(null)}
                       onRun={() => { const held = scan; return commit(held.all, held.report.digest); }} />
        </div>
      )}
    </div>
  );
}
