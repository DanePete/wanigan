import { useEffect, useState } from 'react';
import type { AutoModeView } from '@shared/types';
import { trustCopy } from '@shared/types';
import { Mark, Note, SectionHead, type Tone } from './bits';
import '../styles/policy-evidence.css';

/**
 * The auto-mode classifier rules Wanigan writes into the settings file it hands
 * Claude Code for this project, shown read-only and exactly as written. When no
 * block is written — Trusted, or a CLI this build has not verified the keys
 * on — the panel says which, and why.
 */

const STATUS: Record<AutoModeView['status'], { glyph: string; word: string; tone: Tone }> = {
  injected: { glyph: '◆', word: 'written into each session’s --settings file', tone: 'accent' },
  defaults: { glyph: '○', word: 'nothing written: built-in rules only', tone: 'quiet' },
  'not-verified': { glyph: '?', word: 'not written: not verified on this CLI', tone: 'warn' },
};

export default function AutoModePanel({ projectId }: { projectId: string }) {
  const [view, setView] = useState<AutoModeView | null | 'error'>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.policyEvidence.autoMode(projectId)
      .then((v) => { if (live) setView(v); })
      .catch(() => { if (live) setView('error'); });
    return () => { live = false; };
  }, [projectId]);
  if (view === null) return null;
  if (view === 'error') return <Note tone="error">Wanigan could not compile this project’s auto-mode rules.</Note>;
  const status = STATUS[view.status];
  return (
    <section className="pe-automode" aria-label="Auto-mode classifier rules">
      <SectionHead label="Auto-mode classifier rules" />
      <p className="pe-marks">
        <Mark glyph={status.glyph} word={status.word} tone={status.tone} />
        <span className="faint">{trustCopy(view.trust).label} trust · {view.providerLabel ?? 'no Claude Code CLI detected'}{view.cliVersion ? ` ${view.cliVersion}` : ''}</span>
      </p>
      <p className="ctx-fine">{view.note}</p>
      {view.block && (
        <pre className="pe-json" tabIndex={0} aria-label="The autoMode block, as written">{JSON.stringify({ autoMode: view.block }, null, 2)}</pre>
      )}
      <p className="faint ctx-fine">
        Claude Code reads classifier rules from user settings, managed settings and --settings, never from a repository’s
        own .claude/settings.json. &quot;$defaults&quot; keeps the built-in rules in place; these entries only add to them. They
        shape a classifier that runs inside the CLI in auto mode — a second layer under Wanigan’s own gate, not containment.
      </p>
    </section>
  );
}
