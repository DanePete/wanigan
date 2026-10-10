// "How Code works": what the editor opens, what it refuses to edit and why,
// what a save writes, and how the live view follows it. Every sentence is a
// rule the core's files service (core/files.ts: guardOf, write, the 2 MB and
// UTF-8 limits) or the editor (code/controller.ts: drafts, an agent's change)
// enforces. Numbers are this window's: the files open here, the unsaved ones.
import { MAX_EDIT_BYTES } from '@shared/files';
import type { ProjectSummary } from '@shared/model';
import { navigate } from '../lib/router';
import { HowArrow, HowBox, HowDialog, HowLane, HowNote, howNum } from '../components/How';
import { focusFileTree } from './FileTree';
import { openQuickOpen } from './store';

const MB = MAX_EDIT_BYTES / 1024 / 1024;

export function CodeHow({ project, tabs, unsaved, onClose }: { project: ProjectSummary; tabs: number; unsaved: number; onClose: () => void }) {
  const then = (run: () => void) => () => { onClose(); requestAnimationFrame(run); };
  return (
    <HowDialog place="code" title="How Code works" onClose={onClose}
      intro={<><strong>The editor writes only what you saw.</strong> It opens the project’s own files, keeps someone else’s code read-only unless you say otherwise, and never saves over a change it did not show you.</>}
      side={(
        <>
          <HowNote title="What it will not open or write">
            <ul>
              <li>Anything but UTF-8 text: a binary file, UTF-16 or another encoding.</li>
              <li>A file over {MB} MB.</li>
              <li>Git’s own records, and anything a link leads to outside the project.</li>
              <li>A file that is read-only on disk: Wanigan will not change its permissions to write it.</li>
            </ul>
          </HowNote>
          <HowNote title="Where it is kept" tone="quiet">
            <p>Every save is in the project’s Activity (“You edited …”). Unsaved text is kept on this computer, and comes back if the window closes before you save.</p>
          </HowNote>
        </>
      )}>
      <HowLane n={1} title="Open" actor="you">
        <HowBox actor="you" title="Find a file" num={howNum(tabs, 'file open', 'files open')} onClick={then(() => openQuickOpen(null))} hint="Open a file by name">
          By name from anywhere in the project, from the files beside the editor, from Edit in Changes or a turn’s changes, or from a part picked in the live view.
        </HowBox>
        <HowArrow />
        <HowBox actor="wanigan" title="Someone else’s code is read-only" num={null} onClick={then(focusFileTree)} hint="Show the files">
          Drupal core, contributed modules, vendor, node_modules, WordPress core and plugins open read-only, saying why: their next update replaces a change. Edit anyway, and it is yours to keep.
        </HowBox>
      </HowLane>

      <HowLane n={2} title="Edit" actor="you">
        <HowBox actor="you" title="Your changes, unsaved" num={howNum(unsaved, 'file unsaved', 'files unsaved')}>
          A dot on the tab until you save. Closing an unsaved file asks first. Line endings and a byte-order mark are kept as the file has them, and new lines indent the way the file does.
        </HowBox>
        <HowArrow label="meanwhile" />
        <HowBox actor="agents" title="An agent changes the file" num={howNum(project.liveSessions, 'session running', 'sessions running')}
          onClick={then(() => navigate({ name: 'project', projectKey: project.key, view: 'sessions' }))} hint="Show the sessions">
          With nothing unsaved, the file reloads and says who changed it. With your changes open, nothing is replaced: Compare and merge, reload theirs, or save yours over it.
        </HowBox>
      </HowLane>

      <HowLane n={3} title="Save" actor="you">
        <HowBox actor="wanigan" title="Written only over what you read" num={null}>
          A save writes the file only if it is still the version you opened. If anything changed it since, nothing is written, and the two open side by side to merge.
        </HowBox>
        <HowArrow />
        <HowBox actor="site" title="The live view follows" num={null} onClick={then(() => navigate({ name: 'project', projectKey: project.key, view: 'live' }))} hint="Open the live view">
          While it follows the site, a save reaches the page as an agent’s edit does: a stylesheet is swapped in place, a template reloads the page.
        </HowBox>
      </HowLane>
    </HowDialog>
  );
}
