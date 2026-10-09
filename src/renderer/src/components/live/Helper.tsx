// The site helper, offered and managed: what it adds to the live view, exactly
// what installing it writes and runs (shown before anything happens), and
// taking it out again. Nothing is written into the site until the owner says
// yes here.
import { useState } from 'react';
import type { LiveSite } from '@shared/live';
import type { ProjectSummary } from '@shared/model';
import { attempt, call } from '../../lib/api';
import { liveBridge } from '../../lib/live';
import { Button, Dialog, useToast } from '../ui';

const GIVES: Record<'drupal' | 'wordpress', string[]> = {
  drupal: [
    'Names content, fields, blocks and views exactly, even where Twig debug cannot.',
    'Saves words you retype on the page to plain text fields, as the user you are logged in as in the live view.',
    'Shows one piece alone: a piece of content, a component with its examples, a block, or sample content where there is none yet.',
    'Reloads the view when content changes in Drupal (an agent running drush, an editor saving), not only when files change.',
  ],
  wordpress: [
    'Names the template file behind each part of the page (header.php, each template part, the page template), each block, and each post’s content.',
    'Shows one post alone, in your theme.',
    'Reloads the view when content changes in WordPress (an agent running wp-cli, an editor saving), not only when files change.',
  ],
};
const NAME = { drupal: 'Drupal', wordpress: 'WordPress' } as const;

/** The offer, in the side panel: one line of what it adds, and the button that shows the plan. */
export function HelperOffer({ site, project }: { site: LiveSite; project: ProjectSummary }) {
  const [open, setOpen] = useState(false);
  const plan = site.helperPlan;
  if (!plan || site.helper || plan.refused) return null;
  return (
    <div className="live-helper-offer">
      <p className="small">
        {plan.kind === 'drupal' ? 'Name every piece exactly, save words to content, show a piece alone, and follow content changes too.'
          : 'Name the template file behind every part, show a post alone, and follow content changes too.'}
      </p>
      <Button size="s" icon="plug" onClick={() => setOpen(true)}>Set up the {NAME[plan.kind]} helper…</Button>
      {open ? <HelperDialog site={site} project={project} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/** The helper's state and controls, in the site settings. */
export function HelperSettings({ site, project }: { site: LiveSite; project: ProjectSummary }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const plan = site.helperPlan;
  if (!plan) return null;
  const remove = async (): Promise<void> => {
    setBusy(true);
    const done = await attempt(() => call('live.removeHelper', { projectId: project.id }), (m) => toast(m, 'error'));
    setBusy(false);
    if (done) {
      toast(plan.kind === 'drupal' ? 'The Drupal helper is gone, and the development settings are as they were.' : 'The WordPress helper is gone.');
      void liveBridge()?.reload();
    }
  };
  return (
    <section className="live-helper-settings" aria-label={`${NAME[plan.kind]} helper`}>
      <h3 className="live-section-title">{NAME[plan.kind]} helper</h3>
      {site.helper ? (
        <>
          <p className="small">
            Installed in <span className="mono">{plan.folder}</span>{site.helper.outdated ? ', and this Wanigan has a newer one' : ''}. It answers only the live
            view, and git never sees it.
          </p>
          <div className="live-actions">
            {site.helper.outdated ? <Button size="s" onClick={() => setOpen(true)}>Update it…</Button> : null}
            <Button size="s" tone="quiet" icon="trash" disabled={busy} onClick={remove}>{busy ? 'Removing…' : 'Remove the helper'}</Button>
          </div>
        </>
      ) : plan.refused ? (
        <p className="faint small">{plan.refused}</p>
      ) : (
        <>
          <p className="faint small">
            {plan.kind === 'drupal' ? 'A small development-only module that lets the live view name every piece exactly, save words to content, show a piece alone and follow content changes.'
              : 'One development-only plugin file that lets the live view name the template file behind every part, show a post alone and follow content changes.'}
          </p>
          <div className="live-actions"><Button size="s" icon="plug" onClick={() => setOpen(true)}>Set up the {NAME[plan.kind]} helper…</Button></div>
        </>
      )}
      {open ? <HelperDialog site={site} project={project} onClose={() => setOpen(false)} /> : null}
    </section>
  );
}

/** Exactly what installing writes and runs, and the yes that does it. Also opened from a trace note (TraceNote.tsx). */
export function HelperDialog({ site, project, onClose }: { site: LiveSite; project: ProjectSummary; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const plan = site.helperPlan;
  if (!plan) return null;
  const install = async (): Promise<void> => {
    setBusy(true);
    const done = await attempt(() => call('live.installHelper', { projectId: project.id }), (m) => toast(m, 'error'));
    setBusy(false);
    if (!done) return;
    toast(`The ${NAME[plan.kind]} helper is on. Reloading the page with it.`);
    onClose();
  };
  return (
    <Dialog title={`${site.helper ? 'Update' : 'Set up'} the ${NAME[plan.kind]} helper`} onClose={busy ? () => {} : onClose} width={600}
      footer={(
        <>
          <Button tone="quiet" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button tone="primary" icon="plug" onClick={install} disabled={busy}>
            {busy ? (plan.runs.length ? 'Installing… (ddev can take a minute)' : 'Installing…') : site.helper ? 'Update it' : 'Install the helper'}
          </Button>
        </>
      )}>
      <ul className="live-helper-gives small">{GIVES[plan.kind].map((g) => <li key={g}>{g}</li>)}</ul>
      <h3 className="live-section-title">What it writes</h3>
      <p className="small">{plan.kind === 'drupal' ? 'A development-only module' : 'A must-use plugin (WordPress loads it by itself)'} in <span className="mono">{plan.folder}</span>:</p>
      <p className="live-files">{plan.files.map((f) => <span key={f} className="lib-tag mono">{f}</span>)}</p>
      {plan.exclude ? <p className="small">and the line <span className="mono">{plan.exclude}</span> in this repository’s <span className="mono">.git/info/exclude</span>, so git never sees the folder. Nothing in the project’s own files changes.</p> : null}
      <h3 className="live-section-title">What it runs, in {project.name}</h3>
      {plan.runs.length ? <ul className="live-helper-runs">{plan.runs.map((r) => <li key={r} className="mono small">{r}</li>)}</ul> : <p className="small">Nothing: WordPress loads a must-use plugin by itself.</p>}
      <p className="faint small">
        {plan.kind === 'drupal'
          ? 'It acts only for requests that carry a token Wanigan keeps in Drupal’s state and sends only from the live view, so the site looks the same in any other browser. Twig development mode makes pages slower, as it does when you switch it on yourself. Removing the helper (in the site settings) switches it off, deletes the folder and the line, and puts the development settings back as they were.'
          : 'It acts only for requests that carry the token written into it, which only the live view sends, so the site looks the same in any other browser. Removing the helper (in the site settings) deletes the file and the line.'}
      </p>
    </Dialog>
  );
}
