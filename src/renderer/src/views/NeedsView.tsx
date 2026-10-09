import { NEED_GROUP } from '../lib/needs';
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { LIVE_STATES, NEED_KINDS, type Need, type ProjectSummary, type Session } from '@shared/model';
import { replyRoute } from '@shared/attention';
import { attempt, bridge, call, useQuery } from '../lib/api';
import { href, navigate, openCard } from '../lib/router';
import { ago, plural } from '../lib/format';
import { signalFor } from '../components/Orb';
import { PlayableOrb } from '../components/PlayableOrb';
import type { OrbMood } from '../orb/mood';
import { Icon } from '../components/icons';
import { Button, NotAnswering, ProjectMark, useToast } from '../components/ui';
import { ContinueOn } from '../components/ContinueOn';
import { InstallHint } from '../components/Install';
import { Ask, RevealedLine } from '../components/Ask';
import { AttachButton, AttachmentChips, useAttachments, useFileDrop } from '../components/Attachments';


export function NeedsView({ needs, projects, loading, error, onRetry, onAddProject }: {
  needs: Need[] | undefined;
  projects: ProjectSummary[] | undefined;
  loading: boolean;
  /** The core did not answer: say so, never "Nothing needs you". */
  error: Error | null;
  onRetry: () => void;
  onAddProject: () => void;
}) {
  const running = projects?.reduce((n, p) => n + p.liveSessions, 0) ?? 0;
  const count = needs?.length ?? 0;
  // Which agent is behind each row, and whether it still runs: that decides where a reply can go.
  const live = useQuery('sessions.list', { live: true }, ['sessions']);
  const sessions = useMemo(() => new Map((live.data ?? []).map((s) => [s.id, s])), [live.data]);
  const projectsWith = new Set(needs?.map((n) => n.projectId)).size;
  const mood = useNeedsMood(needs);
  if (error) {
    return (
      <section className="view needs" aria-label="Needs you">
        <NotAnswering error={error} onRetry={onRetry} />
      </section>
    );
  }
  const headline = loading ? 'Checking…' : count === 0 ? 'Nothing needs you.' : `${count === 1 ? 'One thing needs' : `${count} things need`} you.`;
  const sub = loading ? '' : count === 0
    ? running ? `${plural(running, 'session')} running. Wanigan will say when one needs you.` : projects?.length ? 'Nothing is running.' : 'Open a project to begin.'
    : `In ${plural(projectsWith, 'project')}.${running ? ` ${plural(running, 'session')} running.` : ''}`;

  return (
    <section className="view needs" aria-labelledby="needs-title">
      {/* When something needs you, the list is the hero: the orb and headline step back. */}
      <header className={`needs-hero${count ? ' busy' : ''}`}>
        <PlayableOrb size={count ? 140 : 200} signal={signalFor(needs, running)} mood={mood} className="needs-orb" />
        <div className="needs-words">
          <h1 id="needs-title" className="needs-headline">{headline}</h1>
          <p className="needs-sub">{sub}</p>
          {!loading && projects && !projects.length ? <Button tone="primary" icon="folder" onClick={onAddProject}>Open a project</Button> : null}
        </div>
      </header>

      {!loading && count === 0 ? <Readiness projects={projects} onAddProject={onAddProject} /> : null}

      {count ? (
        <div className="needs-groups">
          {NEED_KINDS.map((kind) => {
            const items = needs?.filter((n) => n.kind === kind) ?? [];
            if (!items.length) return null;
            return (
              <section key={kind} className={`need-group need-${kind}`} aria-labelledby={`need-${kind}`}>
                <header>
                  <h2 id={`need-${kind}`}>{NEED_GROUP[kind].title} <span className="faint">{items.length}</span></h2>
                  <p className="faint">{NEED_GROUP[kind].hint}</p>
                </header>
                <ol>
                  {items.map((n) => (
                    <NeedRow key={`${n.kind}-${n.sessionId ?? ''}-${n.cardId ?? ''}-${n.since}`} need={n} session={n.sessionId ? sessions.get(n.sessionId) ?? null : null} />
                  ))}
                </ol>
              </section>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

/** What a reply is called, to the agent it goes to. */
const AGENT_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

function NeedRow({ need, session }: { need: Need; session: Session | null }) {
  const toast = useToast();
  const projectKey = need.projectKey;
  const sessionHref = need.sessionId ? href({ name: 'session', projectKey, sessionId: need.sessionId }) : null;
  const dismiss = need.sessionId && (need.kind === 'waiting' || need.kind === 'failed' || need.kind === 'interrupted' || need.kind === 'quiet' || need.kind === 'starting')
    ? () => attempt(() => call('sessions.seen', { id: need.sessionId as string }), (m) => toast(m, 'error'))
    : null;
  const route = replyRoute(need, session ? { provider: session.provider, state: session.state, live: LIVE_STATES.has(session.state), relayed: session.relayed } : null);
  const [replying, setReplying] = useState(false);
  // What happened to the last reply. The row itself stays until the agent's own events clear it.
  const [sent, setSent] = useState<string | null>(null);
  const row = useRef<HTMLLIElement>(null);
  const agent = AGENT_NAME[session?.provider ?? ''] ?? 'the agent';

  const closeReply = (): void => {
    setReplying(false);
    requestAnimationFrame(() => row.current?.querySelector<HTMLButtonElement>('.need-reply-open')?.focus());
  };
  const send = async (text: string, attachments: string[]): Promise<boolean> => {
    const id = need.sessionId as string;
    const files = attachments.length ? { attachments } : {};
    if (need.kind === 'question' && need.cardId) {
      // The answer is recorded on the card, which settles the question, and the agent is told.
      const answered = await attempt(() => call('cards.comment', { id: need.cardId as string, body: text }), (m) => toast(m, 'error'));
      if (!answered) return false;
      const told = await attempt(() => call('sessions.queue', { id, text: `The owner answered your question on ${need.cardKey}: ${text}`, ...files }),
        (m) => toast(`Answered on ${need.cardKey}, but ${agent} was not told: ${m}`, 'error'));
      if (told) toast(told.queued ? `Answered on ${need.cardKey}. ${agent} gets it when it finishes its turn.` : `Answered on ${need.cardKey} and sent to ${agent}.`);
      return true;
    }
    const r = await attempt(() => call('sessions.queue', { id, text, ...files }), (m) => toast(m, 'error', { action: { label: 'Retry', run: () => void send(text, attachments).then((ok) => { if (ok) closeReply(); }) } }));
    if (!r) return false;
    setSent(r.queued ? 'Queued until it finishes' : `Sent to ${agent}`);
    return true;
  };

  let primary: ReactElement | null = null;
  if (need.kind === 'review' || need.kind === 'question') {
    primary = <Button tone={need.kind === 'review' ? 'primary' : 'attention'} onClick={() => need.cardKey && openCard(need.cardKey)}>{need.kind === 'review' ? 'Review' : 'Answer'}</Button>;
  } else if (need.kind === 'limit' && need.sessionId) {
    primary = <ContinueOn sessionId={need.sessionId} accountId={need.accountId ?? null} projectKey={projectKey} />;
  } else if (need.kind === 'interrupted' && need.sessionId && need.resumable) {
    const resume = (): Promise<void> => attempt(() => call('sessions.resume', { id: need.sessionId as string }), (m) => toast(m, 'error', { action: { label: 'Retry', run: () => void resume() } }))
      .then((s) => { if (s) navigate({ name: 'session', projectKey, sessionId: s.id }); });
    primary = (
      <Button tone="primary" icon="resume" onClick={resume}>
        Resume
      </Button>
    );
  } else if (sessionHref) {
    // A permission prompt, or a question before the agent has started, is answered
    // in the terminal, which takes the keyboard when the session opens.
    const inTerminal = need.kind === 'permission' || need.kind === 'starting';
    primary = <a className={`btn btn-m ${inTerminal ? 'btn-attention' : 'btn-plain'}`} href={sessionHref}><span>{inTerminal ? 'Answer in terminal' : 'Open'}</span></a>;
  }
  const asks = need.kind === 'permission' ? need.asks ?? [] : [];

  return (
    <li ref={row} className={`need-row${asks.length || replying ? ' need-row-open' : ''}`}>
      <ProjectMark projectKey={projectKey} size="s" />
      <div className="need-main">
        <p className="need-title">
          {need.cardKey ? <button type="button" className="linkish mono need-key" onClick={() => openCard(need.cardKey)}>{need.cardKey}</button> : null}
          <span>{need.title}</span>
        </p>
        {need.detail && need.kind === 'permission' && !asks.length ? <RevealedLine text={need.detail} /> : null}
        {need.detail && need.kind !== 'permission' ? <p className="need-detail">{need.detail}</p> : null}
        {route && !route.ok ? <p className="need-detail need-why">{route.why}</p> : null}
        {sent ? <p className="need-sent" role="status"><Icon name="check" size={14} /> {sent}</p> : null}
      </div>
      <span className="need-since faint" title={new Date(need.since).toLocaleString()}>{ago(need.since)}</span>
      <div className="need-actions">
        {route?.ok && !replying ? (
          <Button className="need-reply-open" tone={need.kind === 'question' ? 'attention' : 'primary'} icon="reply" onClick={() => { setReplying(true); setSent(null); }}>
            Reply
          </Button>
        ) : null}
        {primary && !(route?.ok && need.kind === 'question') ? primary : null}
        {route?.ok && need.kind === 'question' && need.cardKey ? <Button tone="quiet" onClick={() => openCard(need.cardKey)}>Open card</Button> : null}
        {dismiss ? <Button tone="quiet" onClick={dismiss}>Dismiss</Button> : null}
      </div>
      {asks.length ? (
        <div className="need-asks">
          {asks.map((ask, i) => <Ask key={`${i}-${ask.tool}`} ask={ask} />)}
        </div>
      ) : null}
      {replying ? (
        <ReplyBox
          label={need.kind === 'question' ? `Answer ${need.cardKey}` : `Reply to ${need.title}`}
          placeholder={need.kind === 'question' ? `Answer the question. It goes on ${need.cardKey} and to ${agent}.` : `Tell ${agent} what to do next.`}
          sessionId={need.sessionId}
          needsText={need.kind === 'question'}
          send={send}
          onClose={closeReply}
        />
      ) : null}
    </li>
  );
}

/** A one-line reply inside the row: Enter sends, Shift+Enter starts a new line, Escape closes. */
function ReplyBox({ label, placeholder, sessionId, needsText, send, onClose }: {
  label: string;
  placeholder: string;
  /** The session whose composer the files wait in, shared with the session view's. */
  sessionId: string | null;
  /** An answer on a card needs words; files alone will not do. */
  needsText: boolean;
  send: (text: string, attachments: string[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const attach = useAttachments(sessionId ? { session: sessionId } : null);
  useFileDrop(form, (files) => void attach.add(files));
  const ids = attach.files.map((f) => f.id);
  const ready = (!!text.trim() || (!needsText && ids.length > 0)) && !attach.adding;
  useEffect(() => { box.current?.focus(); }, []);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);
  const submit = async (): Promise<void> => {
    if (!ready || busy) return;
    setBusy(true);
    // The text stays in the box when sending fails, so it can be sent again.
    const ok = await send(text.trim(), ids).finally(() => setBusy(false));
    if (ok) onClose();
  };
  return (
    <form ref={form} className={`need-reply${sessionId ? ' takes-files' : ''}`} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <AttachmentChips files={attach.files} adding={attach.adding} onRemove={attach.remove} />
      {sessionId ? <AttachButton onPick={attach.pick} /> : null}
      <label className="visually-hidden" htmlFor={id}>{label}</label>
      <textarea
        id={id}
        ref={box}
        rows={1}
        value={text}
        placeholder={placeholder}
        aria-describedby={`${id}-keys`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
        }}
      />
      <Button tone="primary" type="submit" icon="send" disabled={!ready || busy}>Send</Button>
      <Button tone="quiet" onClick={onClose}>Cancel</Button>
      <p id={`${id}-keys`} className="need-reply-keys faint">Enter sends · Shift+Enter for a new line · Esc closes{sessionId ? ' · paste or drop images and files' : ''}</p>
    </form>
  );
}

/**
 * Wanigan reacts to what changes here, once each time: alarm when a session
 * fails (holding a low glow while it stands), the blue flame when the failures
 * are dealt with, and a celebration when the last thing that needed you is done.
 */
function useNeedsMood(needs: Need[] | undefined): OrbMood {
  const failed = needs?.some((n) => n.kind === 'failed' || n.kind === 'interrupted') ?? false;
  const count = needs?.length ?? 0;
  const previous = useRef<{ failed: boolean; count: number } | null>(null);
  const [passing, setPassing] = useState<OrbMood>('idle');
  useEffect(() => {
    if (!needs) return;
    const was = previous.current;
    previous.current = { failed, count };
    if (!was) return;
    const next: OrbMood | null = !failed && was.failed ? 'recovered' : count === 0 && was.count > 0 ? 'celebrate' : null;
    if (!next) return;
    setPassing(next);
    const t = window.setTimeout(() => setPassing('idle'), 3500);
    return () => window.clearTimeout(t);
  }, [failed, count, needs]);
  return failed ? 'alarm' : passing;
}

/**
 * When nothing needs you, what you would check on a first run, in three quiet
 * lines: whether each agent is signed in, and whether there is a project.
 * Read from what Wanigan already knows; nothing is asked or launched.
 */
function Readiness({ projects, onAddProject }: { projects: ProjectSummary[] | undefined; onAddProject: () => void }) {
  const accounts = useQuery('accounts.list', {}, ['accounts']);
  if (!accounts.data) return null;
  const line = (agent: string, provider: 'claude' | 'codex'): { ok: boolean; text: string; missing?: 'claude' | 'codex' } => {
    const list = accounts.data!.filter((a) => a.provider === provider);
    // A CLI that is not there is not "found", whatever its folder holds.
    if (list.length && list.every((a) => !a.installed)) return { ok: false, text: `${agent} · not installed`, missing: provider };
    const signed = list.find((a) => a.signedIn === 'yes');
    if (signed) return { ok: true, text: `${agent} · signed in${signed.identity ? ` as ${signed.identity}` : ''}${list.length > 1 ? `, ${list.length} accounts` : ''}` };
    if (list.some((a) => a.signedIn === 'unknown')) return { ok: true, text: `${agent} · found; Wanigan could not confirm who is signed in` };
    return list.length ? { ok: false, text: `${agent} · signed out` } : { ok: false, text: `${agent} · no account folder found` };
  };
  const rows = [line('Claude Code', 'claude'), line('Codex', 'codex')];
  return (
    <ul className="readiness" aria-label="Ready to work">
      {rows.map((r) => (
        <li key={r.text} className={r.ok ? 'ok' : ''}>
          <span className="readiness-dot" aria-hidden="true" />
          <span>{r.text}</span>
          {r.missing ? <InstallHint cli={r.missing} /> : !r.ok ? <a href={href({ name: 'accounts' })}>Sign in</a> : null}
        </li>
      ))}
      <li className={projects?.length ? 'ok' : ''}>
        <span className="readiness-dot" aria-hidden="true" />
        <span>{projects?.length ? `${plural(projects.length, 'project')} open` : 'No projects yet'}</span>
        {!projects?.length ? <button type="button" className="linkish" onClick={onAddProject}>Open a project</button> : null}
      </li>
      {!projects?.length ? (
        <li className="readiness-demo">
          <span className="readiness-dot" aria-hidden="true" />
          <span>Or look around first: the demo has sample projects and stand-in agents, and touches nothing real.</span>
          <button type="button" className="linkish" onClick={() => void bridge().openDemo()}>Open the demo</button>
        </li>
      ) : null}
    </ul>
  );
}
