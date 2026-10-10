// "How the live editor works": the flow from the page to the site as a
// picture, with this project's numbers, in the spirit of the board's
// (views/HowItWorks.tsx). Every sentence here is a rule the code enforces (the
// design layer: use-layer.ts, Tray.tsx, LayerEdits.tsx and src/main's layer); if
// a rule changes, this changes with it. A number whose source has not answered
// is left out, never guessed. Opened from the toolbar's help and from the
// palette (openHowLiveWorks), which goes to the live view first.
import { useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import type { LayerSnapshot } from '@shared/design-layer';
import type { ProjectSummary } from '@shared/model';
import { plural } from '../../lib/format';
import { Dialog } from '../ui';

/* ── opening it, from the toolbar or the palette ───────────────────────── */

let wanted: string | null = null;
const listeners = new Set<() => void>();
const tell = (): void => { for (const l of listeners) l(); };

/** Open the live editor's How it works for a project: shown once its live view is on screen (the palette goes there first). */
export function openHowLiveWorks(projectId: string): void {
  wanted = projectId;
  tell();
}

/** Whether a project's live view shows How it works now, and opening and closing it. */
export function useHowLiveWorks(projectId: string, active: boolean): { shown: boolean; open: () => void; close: () => void } {
  const now = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => wanted);
  return {
    shown: active && now === projectId,
    open: () => openHowLiveWorks(projectId),
    close: () => { if (wanted === projectId) { wanted = null; tell(); } },
  };
}

/* ── the picture ───────────────────────────────────────────────────────── */

type Actor = 'you' | 'agents' | 'board' | 'needs' | 'done';
const ACTOR_TAG: Record<Actor, string> = { you: 'You', agents: 'An agent', board: 'Wanigan’s layer', needs: 'Needs you', done: 'The site' };

export function HowLiveWorks({ project, layer, drafts, helper, cms, onClose, onEdits, onSelect }: {
  project: ProjectSummary;
  /** The project's design layer, or null until the core has answered. */
  layer: LayerSnapshot | null;
  /** Edits only in the layer: the toolbar's count. */
  drafts: number;
  /** The site has Wanigan's helper: words can be saved through it. */
  helper: boolean;
  /** Drupal or WordPress; null for another kind of site, which has no core to save through. */
  cms: 'Drupal' | 'WordPress' | null;
  onClose: () => void;
  /** Open Edits, where every edit waits. */
  onEdits: () => void;
  /** Start selecting a part on the page. */
  onSelect: () => void;
}) {
  const count = (state: string): number | null => (layer ? layer.edits.filter((e) => e.state === state).length : null);
  const made = count('implemented');
  const verified = count('verified');
  const orphaned = count('orphaned');
  const site = cms ?? 'the site';
  return (
    <Dialog title="How the live editor works" onClose={onClose} width={1180}>
      <p className="how-intro">
        <strong>You change the page; the site changes only when you make it real.</strong>{' '}
        What you type or style waits in Wanigan’s layer, shown on the page, until you save it through {cms ? `${cms}’s own core` : 'the site'}, and it is called done only once it is verified.
      </p>
      <div className="how">
        <div className="how-flow" aria-label="How a change moves from the page to the site">
          <Lane n={1} title="On the page" actor="you">
            <Box actor="you" title="Select a part" num={null} onClick={onSelect} hint="Select on the page">
              P, then point at it or walk the page with the arrows. Layers chooses the same part; how it was chosen never changes what can be done to it.
            </Box>
            <Arrow />
            <Box actor="you" title="Type or style it" num={drafts ? `${plural(drafts, 'draft')} on the page now` : layer ? 'no drafts now' : null}>
              E types on its words where they are, each key shown as you type; Enter keeps them, Esc puts them back. Style tries a style on it, or on every one of its kind, its reach said before you choose.
            </Box>
          </Lane>

          <Lane n={2} title="It waits in the layer" actor="board">
            <Box actor="board" title="Kept, keyed to the part" num={layer ? `${plural(layer.edits.length, 'edit')} in the layer` : null} onClick={onEdits} hint="Open Edits">
              Each edit is keyed to the part by what the site says it is, and shown again after every reload. Nothing is written to the site yet.
            </Box>
            <Arrow label="you choose" />
            <Box actor="board" title="Set aside, not guessed" num={orphaned ? `${plural(orphaned, 'edit')} set aside` : layer ? 'none set aside' : null} onClick={onEdits} hint="Open Edits">
              If its part shows other words or is gone, the edit is set aside as orphaned, says why, and is never put on whatever is there now.
            </Box>
          </Lane>

          <Lane n={3} title="Into the site" actor="done">
            <Box actor="you" title="Make it real" num={made !== null ? `${plural(made, 'edit')} in the site, not verified` : null} onClick={onEdits} hint="Open Edits">
              {helper && cms
                ? `Words are saved through ${cms}’s own core, as the user you are logged in as, with a revision where ${cms} keeps one.`
                : 'Words are saved through the site helper, once it is set up for this site.'}{' '}
              A style goes to an agent as a brief, on your click; no session is started for it.
            </Box>
            <Arrow label="then" />
            <Box actor="done" title="Verify" num={verified !== null ? `${plural(verified, 'edit')} verified` : null} onClick={onEdits} hint="Open Edits">
              Renders the page with and without the layer at 390 and 1440 px and compares: the styles of what was edited, the pixels around it, then the rest of the page against how it was before.
            </Box>
          </Lane>

          <Lane n={4} title="When it goes wrong" actor="needs">
            <Box actor="you" title="Undo" num={null} onClick={onEdits} hint="Open Edits">
              Undo takes back the newest add or discard, and Redo brings it back. An edit already in {site} is never taken out of the layer.
            </Box>
            <Box actor="needs" title="Not verified" num={null} onClick={onEdits} hint="Open Edits">
              The step that failed, each difference and the pictures are said, and the edit stays in the site, as made.
            </Box>
            <Box actor="agents" title="Code, not content" num={null}>
              {cms === 'Drupal' ? 'A style, a token, and words a template writes' : 'A style or a token'}: these are code, so they go to an agent as a note with the part and its page, and a picture of it while the view shows that page.
            </Box>
          </Lane>
        </div>

        <aside className="how-side">
          <section className="how-card">
            <h3>Who does what</h3>
            <ul className="how-legend">
              <li><span className="how-swatch how-you" aria-hidden="true" /><strong>You:</strong> every edit, every save, every verification. Nothing here is saved without your click.</li>
              <li><span className="how-swatch how-board" aria-hidden="true" /><strong>Wanigan’s layer:</strong> keeps what you changed, shows it on the page, and says when it can no longer find its part.</li>
              <li><span className="how-swatch how-done" aria-hidden="true" /><strong>The site:</strong> {cms ? `${cms}’s own core saves your words, as you.` : 'it has no core Wanigan saves through; edits go to an agent.'}</li>
              <li><span className="how-swatch how-agents" aria-hidden="true" /><strong>An agent:</strong> makes what is code (templates, styles) from a note you send.</li>
            </ul>
          </section>
          <section className="how-card how-card-quiet">
            <h3>Reading the picture</h3>
            <ul>
              <li>Arrows are the usual path; lane 4 is how a change comes back.</li>
              <li>Click a box to open Edits, or to start selecting.</li>
              <li>Numbers are live from {project.name}’s layer. A missing number means the layer has not answered.</li>
              <li>A hosted environment is read-only: point at parts and tell an agent.</li>
            </ul>
          </section>
        </aside>
      </div>
    </Dialog>
  );
}

function Lane({ n, title, actor, children }: { n: number; title: string; actor: Actor; children: ReactNode }) {
  return (
    <section className={`how-lane how-${actor}`} aria-label={`${n}. ${title}`}>
      <h3 className="how-lane-title"><span className="how-lane-n">{n}</span>{title}</h3>
      <div className="how-lane-row">{children}</div>
    </section>
  );
}

function Box({ actor, title, num, children, onClick, hint }: {
  actor: Actor; title: string; num: string | null; children: ReactNode; onClick?: () => void; hint?: string;
}) {
  const onKey = (e: KeyboardEvent): void => {
    if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); }
  };
  return (
    <div
      className={`how-box how-${actor}${onClick ? ' linked' : ''}`}
      {...(onClick ? { role: 'link', tabIndex: 0, onClick, onKeyDown: onKey, 'aria-label': `${title}. ${hint ?? ''}`, 'data-tip': hint } : {})}
    >
      <span className="how-tag">{ACTOR_TAG[actor]}</span>
      <strong className="how-title">{title}</strong>
      <p className="how-text">{children}</p>
      {num ? <span className="how-num">{num}</span> : null}
    </div>
  );
}

function Arrow({ label }: { label?: string }) {
  return (
    <span className={`how-arrow${label ? ' labelled' : ''}`} aria-hidden="true">
      {label ? <span className="how-arrow-label">{label}</span> : null}
    </span>
  );
}
