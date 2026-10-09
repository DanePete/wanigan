// The few things worth a setting. Most of Wanigan has a sensible default instead.
import type { ProjectSummary } from '@shared/model';
import type { AppSettings, NotifyLevel } from '@shared/settings';
import type { UpdateStatus } from '@shared/updates';
import { JevSettings } from '../components/Jev';
import { LocalModelsSettings } from '../components/LocalModels';
import { PhoneSettings } from '../components/PhoneSettings';
import { Button, Segmented, useToast } from '../components/ui';
import { bridge } from '../lib/api';
import { ago, plural } from '../lib/format';
import { useAppState } from '../lib/settings';
import '../styles/live.css';

export function SettingsView({ projects }: { projects: ProjectSummary[] | undefined }) {
  return (
    <section className="view" aria-labelledby="settings-title">
      <header className="topbar">
        <div className="topbar-title"><h1 id="settings-title">Settings</h1></div>
      </header>
      <div className="view-body">
        <div className="view-pad settings">
          <GeneralSettings />
          <LiveViewSettings />
          <UpdateSettings />
          <LocalModelsSettings />
          <PhoneSettings />
          <JevSettings projects={projects} />
        </div>
      </div>
    </section>
  );
}

const NOTIFY_OPTIONS: readonly { value: NotifyLevel; label: string; hint: string }[] = [
  { value: 'all', label: 'On', hint: 'Permission requests, failures, reviews, questions and finished turns' },
  { value: 'urgent', label: 'Only permission and failures', hint: 'Only what has an agent stopped or a session failed' },
  { value: 'off', label: 'Off', hint: 'Nothing; Needs you and the dock badge still count it all' },
];

/** What the app does on this Mac. Kept by the app, not the core. */
function GeneralSettings() {
  const { state, update } = useAppState();
  const toast = useToast();
  const fail = (e: unknown): void => toast((e as Error)?.message ?? String(e), 'error');
  const s = state?.settings;

  return (
    <section className="settings-group" aria-labelledby="set-general">
      <header className="account-group-head">
        <h2 id="set-general">General</h2>
      </header>
      <div className="settings-row">
        <label className="check-row">
          <input type="checkbox" checked={s?.keepAwake ?? true} disabled={!s}
            onChange={(e) => void update({ keepAwake: e.target.checked }).catch(fail)} />
          <span>
            Keep the Mac awake while sessions run
            <span className="faint small"> — the display can still sleep. Only while Wanigan is open: quitting it leaves sessions running but lets the Mac sleep.</span>
          </span>
        </label>
        {state ? <p className="faint small">{awakeNow(state)}</p> : null}
      </div>
      <div className="settings-row settings-notify">
        <div className="settings-notify-head">
          <span className="settings-label">Notifications</span>
          <Segmented<NotifyLevel>
            label="Notifications"
            value={s?.notifications ?? 'all'}
            options={NOTIFY_OPTIONS}
            onChange={(notifications) => void update({ notifications }).catch(fail)}
          />
        </div>
        <p className="faint small">
          Banners while Wanigan is in the background, and alert cards while it is in front, for anything that needs you somewhere
          other than what you are looking at. The dock badge always counts what needs you.
        </p>
      </div>
    </section>
  );
}

/** The live view: optional, each part of it; kept by the app like the General section. */
function LiveViewSettings() {
  const { state, update } = useAppState();
  const toast = useToast();
  const fail = (e: unknown): void => toast((e as Error)?.message ?? String(e), 'error');
  const s = state?.settings;
  const set = (patch: Partial<AppSettings>): void => void update(patch).catch(fail);
  const on = s?.liveView ?? false;
  // What the switches below say when they cannot be used yet.
  const why = s && !on ? 'live-settings-why' : undefined;
  return (
    <section className="settings-group" aria-labelledby="set-live">
      <header className="account-group-head">
        <h2 id="set-live">Live view</h2>
      </header>
      <div className="settings-row">
        <label className="check-row">
          <input type="checkbox" checked={on} disabled={!s} onChange={(e) => set({ liveView: e.target.checked })} />
          <span>
            Show each project’s local site inside Wanigan
            <span className="faint small"> — a Live tab on the project and beside a session’s terminal. It opens the site you already run (ddev, Lando, a dev server). Nothing is installed or started.</span>
          </span>
        </label>
        {why ? <p id={why} className="faint small live-settings-why">Switch the live view on to choose these.</p> : null}
      </div>
      <fieldset className="settings-row live-settings-kinds">
        <legend className="settings-label">Show it for</legend>
        <label className="check-row">
          <input type="checkbox" checked={s?.liveDrupal ?? true} disabled={!s || !on} aria-describedby={why} onChange={(e) => set({ liveDrupal: e.target.checked })} />
          <span>Drupal sites <span className="faint small"> — knows which component or template made each part of the page</span></span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={s?.liveWordpress ?? true} disabled={!s || !on} aria-describedby={why} onChange={(e) => set({ liveWordpress: e.target.checked })} />
          <span>WordPress sites <span className="faint small"> — knows blocks, template parts and Elementor elements</span></span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={s?.liveSites ?? true} disabled={!s || !on} aria-describedby={why} onChange={(e) => set({ liveSites: e.target.checked })} />
          <span>Other sites and JS apps <span className="faint small"> — any address: a dev server, a static site</span></span>
        </label>
      </fieldset>
      <div className="settings-row live-settings-checks">
        <label className="check-row">
          <input type="checkbox" checked={s?.liveFollow ?? true} disabled={!s || !on} aria-describedby={why} onChange={(e) => set({ liveFollow: e.target.checked })} />
          <span>
            Follow the agents’ edits
            <span className="faint small"> — reload as they change files, and outline what each file made. Off: an edit only says what changed, and you reload.</span>
          </span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={s?.liveShots ?? false} disabled={!s || !on} aria-describedby={why} onChange={(e) => set({ liveShots: e.target.checked })} />
          <span>
            Keep before and after screenshots on cards
            <span className="faint small"> — a full-page picture of the card’s page as its session begins, and again after each turn that changes files, shown on the card with what changed marked. Taken on this Mac, kept in Wanigan’s data folder.</span>
          </span>
        </label>
      </div>
    </section>
  );
}

function awakeNow(state: NonNullable<ReturnType<typeof useAppState>['state']>): string {
  if (!state.settings.keepAwake) return 'Off: the Mac sleeps as it normally would.';
  if (state.awake.holding) return `Holding the Mac awake now, for ${plural(state.awake.live, 'live session')}.`;
  return 'Nothing is live, so the Mac may sleep.';
}

/**
 * Whether a newer Wanigan is out, from GitHub's releases. Not in the demo,
 * which never asks the network. This build offers manual downloads.
 */
function UpdateSettings() {
  const { state, update, check } = useAppState();
  const toast = useToast();
  const fail = (e: unknown): void => toast((e as Error)?.message ?? String(e), 'error');
  if (!state?.updates) return null;
  const status = state.updates;
  const open = (which: 'download' | 'notes'): void => void bridge().openUpdate(which).catch(fail);

  return (
    <section className="settings-group" aria-labelledby="set-updates">
      <header className="account-group-head">
        <h2 id="set-updates">Updates</h2>
      </header>
      <div className="settings-row">
        <div className="settings-line">
          <span className="settings-label">Wanigan {state.version}</span>
          <Button size="s" icon="refresh" onClick={() => check().catch(fail)} disabled={status.state === 'checking'}>Check now</Button>
        </div>
        <p className="faint small" aria-live="polite">{statusLine(status)}</p>
      </div>
      {status.state === 'available' ? (
        <div className="settings-row update-found">
          <div className="settings-line">
            <span className="settings-label">Wanigan {status.release.version} is available</span>
            <div className="settings-actions">
              <Button size="s" tone="primary" icon="pull" onClick={() => open('download')}>Download</Button>
              <Button size="s" icon="open" onClick={() => open('notes')}>Release notes</Button>
            </div>
          </div>
          <p className="faint small">
            {status.release.name}
            {status.release.publishedAt ? ` · published ${new Date(status.release.publishedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
          </p>
          <p className="small">
            To install it, quit Wanigan, open the disk image and drag Wanigan 2 into Applications, replacing this one. Your
            projects, boards and history stay. If sessions are running when the new version opens, it asks before restarting them.
          </p>
        </div>
      ) : null}
      <div className="settings-row">
        <label className="check-row">
          <input type="checkbox" checked={state.settings.updateChecks === 'daily'}
            onChange={(e) => void update({ updateChecks: e.target.checked ? 'daily' : 'off' }).catch(fail)} />
          <span>
            Check for a new version once a day
            <span className="faint small"> — Wanigan asks GitHub’s public list of releases. No project, conversation or usage data is included; GitHub receives normal connection metadata.</span>
          </span>
        </label>
      </div>
      <p className="faint small settings-note">
        Updates are installed manually: download the new version, quit Wanigan, and replace the app in Applications.
        Automatic installation is not implemented in this build.
      </p>
    </section>
  );
}

function statusLine(status: UpdateStatus): string {
  switch (status.state) {
    case 'never': return 'Not checked yet.';
    case 'checking': return 'Checking GitHub…';
    case 'current': return `Up to date. Checked ${ago(status.checkedAt)}.`;
    case 'available': return `Checked ${ago(status.checkedAt)}.`;
    case 'failed': return `Could not check (${ago(status.checkedAt)}): ${status.message}`;
  }
}
