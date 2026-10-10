// "How the live editor works": the flow from the page to the site as a
// picture, with this project's numbers, built from the foundation's How parts
// (components/How.tsx) as the board's is. Every sentence here is a rule the
// code enforces (the design layer: use-layer.ts, Tray.tsx, LayerEdits.tsx and
// the main process's layer); if a rule changes, this changes with it. A number
// whose source has not answered is left out, never guessed. Opened from the
// toolbar's How this works and the palette (useHow('live') in Live.tsx).
import type { LayerSnapshot } from '@shared/design-layer';
import type { ProjectSummary } from '@shared/model';
import { HowArrow, HowBox, HowDialog, HowLane, HowNote, howNum } from '../How';

export function HowLiveWorks({ project, layer, drafts, helper, cms, notes, agents, agent, onClose, onEdits, onSelect, onNotes }: {
  project: ProjectSummary;
  /** The project's design layer, or null until the core has answered. */
  layer: LayerSnapshot | null;
  /** Edits only in the layer: the toolbar's count. */
  drafts: number;
  /** The site has Wanigan's helper: words can be saved through it. */
  helper: boolean;
  /** Drupal or WordPress; null for another kind of site, which has no core to save through. */
  cms: 'Drupal' | 'WordPress' | null;
  /** Notes waiting to be sent, and the project's agent sessions running now (null until the core has answered). */
  notes: number;
  agents: number | null;
  /** The agent a note starts when none runs ("Claude Code"). */
  agent: string;
  onClose: () => void;
  /** Open Edits, where every edit waits. */
  onEdits: () => void;
  /** Start selecting a part on the page. */
  onSelect: () => void;
  /** Open the dock's Notes. */
  onNotes: () => void;
}) {
  const count = (state: string): number | null => (layer ? layer.edits.filter((e) => e.state === state).length : null);
  return (
    <HowDialog place="live" title="How the live editor works" onClose={onClose}
      intro={(
        <>
          <strong>You change the page; the site changes only when you make it real.</strong>{' '}
          What you type or style waits in Wanigan’s layer, shown on the page, until you save it through {cms ? `${cms}’s own core` : 'the site'}, and it is
          called done only once it is verified.
        </>
      )}
      side={(
        <>
          <HowNote title="Who does what">
            <ul className="how-legend">
              <li><span className="how-swatch how-you" aria-hidden="true" /><strong>You:</strong> every edit, every save, every verification. Nothing here is saved without your click.</li>
              <li><span className="how-swatch how-wanigan" aria-hidden="true" /><strong>Wanigan:</strong> keeps what you changed in its layer, shows it on the page, and says when it can no longer find its part.</li>
              <li><span className="how-swatch how-site" aria-hidden="true" /><strong>The site:</strong> {cms ? `${cms}’s own core saves your words, as you.` : 'it has no core Wanigan saves through, so edits go to an agent.'}</li>
              <li><span className="how-swatch how-agents" aria-hidden="true" /><strong>Agents:</strong> make what is code (templates, styles) from a note you send.</li>
            </ul>
          </HowNote>
          <HowNote title="Reading the picture" tone="quiet">
            <ul>
              <li>Arrows are the usual path; lane 2 hands a change to an agent instead, and lane 5 is how a change comes back.</li>
              <li>Click a box to open Edits or Notes, or to start selecting.</li>
              <li>Numbers are live from {project.name}’s layer. A missing number means the layer has not answered.</li>
              <li>A hosted environment is read-only: point at parts and tell an agent.</li>
            </ul>
          </HowNote>
        </>
      )}>
      <HowLane n={1} title="On the page" actor="you">
        <HowBox actor="you" title="Select a part" onClick={onSelect} hint="Select on the page">
          P, then point at it or walk the page with the arrows. Layers chooses the same part; how it was chosen never changes what can be done to it.
        </HowBox>
        <HowArrow />
        <HowBox actor="you" title="Type or style it" num={layer ? howNum(drafts, 'draft on the page now', 'drafts on the page now') : null}>
          E types on its words where they are, each key shown as you type; Enter keeps them, Esc puts them back. Style tries a style on it, or on every one of
          its kind, its reach said before you choose: each value shows on the page as you slide or type it, and Enter keeps it. Its colours come from the
          site itself, each said by where it came from: the palette the site declares (WordPress’s theme.json), its theme’s tokens, and the colours its page uses.
        </HowBox>
      </HowLane>

      <HowLane n={2} title="Or hand it to an agent" actor="agents">
        <HowBox actor="you" title="Snap, Record or a note" num={howNum(notes, 'note waiting', 'notes waiting')} onClick={onNotes} hint="Open Notes">
          Snap marks up a picture of the page, Record keeps a run of it with each step, and a note says what should change on the chosen part. Ask an agent
          sends it with its pictures and what the page says it is.
        </HowBox>
        <HowArrow label="one click" />
        <HowBox actor="agents" title="Straight to an agent" num={agents === null ? null : agents ? howNum(agents, 'agent running here', 'agents running here') : 'no agent running here'}>
          {`With an agent running, it is queued to it and arrives when it is next idle. With none, Start ${agent} with this starts one, as New session would, with
          it as the first message. Nothing starts by itself.`}
        </HowBox>
      </HowLane>

      <HowLane n={3} title="It waits in the layer" actor="wanigan">
        <HowBox actor="wanigan" title="Kept, keyed to the part" num={howNum(layer?.edits.length, 'edit in the layer', 'edits in the layer')} onClick={onEdits} hint="Open Edits">
          Each edit is keyed to its part by what the site says it is, and shown again after every reload. Nothing is written to the site yet.
        </HowBox>
        <HowArrow label="you choose" />
        <HowBox actor="wanigan" title="Set aside, not guessed" num={howNum(count('orphaned'), 'set aside')} onClick={onEdits} hint="Open Edits">
          If its part shows other words or is gone, the edit is set aside as orphaned, says why, and is never put on whatever is there now.
        </HowBox>
      </HowLane>

      <HowLane n={4} title="Into the site" actor="site">
        <HowBox actor="you" title="Make it real" num={howNum(count('implemented'), 'in the site, not verified')} onClick={onEdits} hint="Open Edits">
          {helper && cms
            ? `Words are saved through ${cms}’s own core, as the user you are logged in as, with a revision where ${cms} keeps one.`
            : 'Words are saved through the site helper, once it is set up for this site.'}{' '}
          A style goes to an agent as a brief, on your click; no session is started for it.
        </HowBox>
        <HowArrow label="then" />
        <HowBox actor="site" title="Verify" num={howNum(count('verified'), 'verified')} onClick={onEdits} hint="Open Edits">
          Renders the page with and without the layer at 390 and 1440 px and compares: the styles of what was edited, the pixels around it, then the rest of
          the page against how it was before.
        </HowBox>
      </HowLane>

      <HowLane n={5} title="When it goes wrong" actor="needs">
        <HowBox actor="you" title="Undo" onClick={onEdits} hint="Open Edits">
          Undo takes back the newest add or discard, and Redo brings it back. An edit already in the site is never taken out of the layer.
        </HowBox>
        <HowBox actor="needs" title="Not verified" onClick={onEdits} hint="Open Edits">
          The step that failed, each difference and the pictures are said, and the edit stays in the site, as made.
        </HowBox>
        <HowBox actor="agents" title="Code, not content">
          {cms === 'Drupal' ? 'A style, a token, and words a template writes' : 'A style or a token'}: these are code, so they go to an agent as a note with the
          part and its page, and a picture of it while the view shows that page.
        </HowBox>
      </HowLane>
    </HowDialog>
  );
}
