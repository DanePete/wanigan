// The few things worth a setting, one section at a time (the list beside it is
// shell/SettingsNav.tsx). Most of Wanigan has a sensible default instead.
import type { ProjectSummary } from '@shared/model';
import type { AppSettings, NotifyLevel } from '@shared/settings';
import type { UpdateStatus } from '@shared/updates';
import { JevHealthNow, JevSettings } from '../components/Jev';
import { LocalModelsSettings } from '../components/LocalModels';
import { PhoneSettings } from '../components/PhoneSettings';
import { VoiceSettings } from '../components/VoiceSettings';
import { Badge, Button, Disclosure, EmptyState, Segmented, Toggle, useToast } from '../components/ui';
import { bridge } from '../lib/api';
import { ago, plural } from '../lib/format';
import { useLocation, type SettingsSection } from '../lib/router';
import { useAppState } from '../lib/settings';
import { setTheme, useTheme, type ThemeChoice } from '../lib/theme';
import { resetTours, setToursOff, startTour, useTourState } from '../lib/tours';
import { SettingRow, SettingsGroup, SettingsPage } from './SettingsPage';

export function SettingsView({ projects }: { projects: ProjectSummary[] | undefined }) {
  const { route } = useLocation();
  const section: SettingsSection = route.name === 'settings' ? route.section ?? 'appearance' : 'appearance';
  switch (section) {
    case 'appearance': return <AppearanceSettings />;
    case 'general': return <GeneralSettings />;
    case 'live': return <LiveViewSettings />;
    case 'updates': return <UpdateSettings />;
    case 'local': return <LocalModelsSettings />;
    case 'phone': return <PhoneSettings />;
    case 'voice': return <VoiceSettings />;
    case 'jev': return (
      <SettingsPage id="set-jev" title="Jev" meta={<JevHealthNow />}>
        <JevSettings projects={projects} />
      </SettingsPage>
    );
  }
}

const THEMES: readonly { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'Match the system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * Light, dark, or whatever the system is set to: kept in this window, on this computer (it was the rail's switch).
 * And the guided tours: whether a view's tour offers itself on the first visit, and playing them again.
 */
function AppearanceSettings() {
  const { choice } = useTheme();
  const tours = useTourState();
  const toast = useToast();
  return (
    <SettingsPage id="set-appearance" title="Appearance">
      <SettingsGroup title="Look" tour="settings-theme">
        <SettingRow label="Theme" hint="Kept on this computer."
          control={<Segmented<ThemeChoice> label="Theme" value={choice} options={THEMES} onChange={setTheme} />} />
      </SettingsGroup>
      <SettingsGroup title="Guided tours" tour="settings-tours">
        <SettingRow>
          <Toggle checked={!tours.off} onChange={(on) => setToursOff(!on)} label="Offer a view’s tour the first time you open it"
            hint="Every view’s tour is a click away whenever you want it: the compass at the end of the status line, or Tour in the palette." />
        </SettingRow>
        <SettingRow label="Play them again" hint="The welcome tour walks the whole window; each view’s tour offers itself again on your next visit."
          control={(
            <span className="settings-tours">
              <Button size="s" icon="tour" onClick={() => startTour('welcome')}>Play the welcome tour</Button>
              <Button size="s" tone="quiet" onClick={() => { resetTours(); toast('Every tour will offer itself again, the welcome tour included.', 'done'); }}>Offer every tour again</Button>
            </span>
          )} />
      </SettingsGroup>
    </SettingsPage>
  );
}

const mac = (): boolean => bridge().platform === 'darwin';

function notifyOptions(): readonly { value: NotifyLevel; label: string; hint: string }[] {
  return [
    { value: 'all', label: 'On', hint: 'Permission requests, failures, reviews, questions and finished turns' },
    { value: 'urgent', label: 'Only permission and failures', hint: 'Only what has an agent stopped or a session failed' },
    { value: 'off', label: 'Off', hint: `Nothing; Needs you${mac() ? ' and the Dock icon' : ''} still count${mac() ? '' : 's'} it all` },
  ];
}

/** What the app does on this computer. Kept by the app, not the core. */
function GeneralSettings() {
  const { state, update } = useAppState();
  const toast = useToast();
  const fail = (e: unknown): void => toast((e as Error)?.message ?? String(e), 'error');
  const s = state?.settings;

  return (
    <SettingsPage id="set-general" title="General">
      <SettingsGroup title="While sessions run">
        <SettingRow hint={state ? awakeNow(state) : undefined} live>
          <Toggle checked={s?.keepAwake ?? true} disabled={!s} onChange={(keepAwake) => void update({ keepAwake }).catch(fail)}
            label="Keep this computer awake while sessions run"
            hint="The display can still sleep. Only while Wanigan is open: quitting it leaves sessions running, and lets the computer sleep." />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Notifications" tour="settings-notify">
        <SettingRow label="Notifications"
          hint={`Banners while Wanigan is in the background, and alerts while it is in front, for anything that needs you somewhere other than what you are looking at.${mac() ? ' The Dock icon always counts what needs you.' : ''}`}
          control={(
            <Segmented<NotifyLevel> label="Notifications" value={s?.notifications ?? 'all'} options={notifyOptions()}
              onChange={(notifications) => void update({ notifications }).catch(fail)} />
          )} />
      </SettingsGroup>
    </SettingsPage>
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
  const off = !s || !on;
  // What the switches below say when they cannot be used yet.
  const why = s && !on ? 'Switch the live view on to choose these.' : null;
  return (
    <SettingsPage id="set-live" title="Live view">
      <SettingsGroup title="The live view" tour="settings-live">
        <SettingRow>
          <Toggle checked={on} disabled={!s} onChange={(liveView) => set({ liveView })} label="Show each project’s local site inside Wanigan"
            hint="A Live tab on the project and beside a session’s terminal. It opens the site you already run (ddev, Lando, a dev server); nothing is installed or started." />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Show it for" note={why} className={off ? 'is-waiting' : undefined}>
        <SettingRow>
          <Toggle checked={s?.liveDrupal ?? true} disabled={off} onChange={(liveDrupal) => set({ liveDrupal })} label="Drupal sites"
            hint="Knows which component or template made each part of the page." />
        </SettingRow>
        <SettingRow>
          <Toggle checked={s?.liveWordpress ?? true} disabled={off} onChange={(liveWordpress) => set({ liveWordpress })} label="WordPress sites"
            hint="Knows blocks, template parts and Elementor elements." />
        </SettingRow>
        <SettingRow>
          <Toggle checked={s?.liveSites ?? true} disabled={off} onChange={(liveSites) => set({ liveSites })} label="Other sites and JS apps"
            hint="Any address: a dev server, a static site." />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="While agents work" note={why} className={off ? 'is-waiting' : undefined}>
        <SettingRow>
          <Toggle checked={s?.liveFollow ?? true} disabled={off} onChange={(liveFollow) => set({ liveFollow })} label="Follow the agents’ edits"
            hint="Reload as they change files, and outline what each file made. Off: an edit only says what changed, and you reload." />
        </SettingRow>
        <SettingRow>
          <Toggle checked={s?.liveShots ?? false} disabled={off} onChange={(liveShots) => set({ liveShots })} label="Keep before and after screenshots on cards"
            hint="A full-page picture of the card’s page as its session begins, and again after each turn that changes files, shown on the card with what changed marked. Taken on this computer, kept in Wanigan’s data folder." />
        </SettingRow>
      </SettingsGroup>
      <Disclosure title="Hosted environments" summary="Opened read-only, and only when you do" className="settings-more">
        <p>
          A site’s Dev, Test and Live, kept in its site settings, are tabs beside Local, and Compare lays a page of your local site over the same
          page there. Opening one, or comparing with it, sends requests to that site, only when you do. It opens read-only, in a private session of
          its own: no cookies shared with your local site, never the helper’s token, its certificate checked as any browser would (or, for a copy
          of the site on this computer, by your own mkcert authority, as the Local tab is), and nothing sent that could change it.
        </p>
      </Disclosure>
    </SettingsPage>
  );
}

function awakeNow(state: NonNullable<ReturnType<typeof useAppState>['state']>): string {
  if (!state.settings.keepAwake) return 'Off: this computer sleeps as it normally would.';
  if (state.awake.holding) return `Holding this computer awake now, for ${plural(state.awake.live, 'live session')}.`;
  return 'Nothing is live, so this computer may sleep.';
}

/**
 * Whether a newer Wanigan is out, from GitHub's releases. Not in the demo,
 * which never asks the network. This build offers manual downloads.
 */
function UpdateSettings() {
  const { state, update, check } = useAppState();
  const toast = useToast();
  const fail = (e: unknown): void => toast((e as Error)?.message ?? String(e), 'error');
  const status = state?.updates ?? null;
  const open = (which: 'download' | 'notes'): void => void bridge().openUpdate(which).catch(fail);

  return (
    <SettingsPage id="set-updates" title="Updates"
      tools={status ? <Button size="s" icon="refresh" onClick={() => check().catch(fail)} disabled={status.state === 'checking'} data-tour="settings-updates">Check now</Button> : null}>
      {!state ? null : !status ? (
        <EmptyState title="Updates are not checked here" icon="pull">The demo never asks the network, so it never looks for a new version.</EmptyState>
      ) : (
        <>
          <SettingsGroup title="This version">
            <SettingRow label={`Wanigan ${state.version}`} hint={statusLine(status)} live />
            {status.state === 'available' ? (
              <SettingRow className="update-found"
                label={<>Wanigan {status.release.version} is available <Badge tone="water">New</Badge></>}
                hint={`${status.release.name}${status.release.publishedAt ? ` · published ${new Date(status.release.publishedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}`}
                control={(
                  <span className="settings-actions">
                    <Button size="s" tone="primary" icon="pull" onClick={() => open('download')}>Download</Button>
                    <Button size="s" icon="open" onClick={() => open('notes')}>Release notes</Button>
                  </span>
                )}>
                <p className="setting-more">
                  {mac()
                    ? 'To install it, quit Wanigan, open the disk image and drag Wanigan 2 into Applications, replacing this one.'
                    : 'To install it, quit Wanigan, then install the new version over this one.'}
                  {' '}Your projects, boards and history stay. If sessions are running when the new version opens, it asks before restarting them.
                </p>
              </SettingRow>
            ) : null}
          </SettingsGroup>
          <SettingsGroup title="Checking">
            <SettingRow>
              <Toggle checked={state.settings.updateChecks === 'daily'} onChange={(daily) => void update({ updateChecks: daily ? 'daily' : 'off' }).catch(fail)}
                label="Check for a new version once a day"
                hint="Wanigan asks GitHub’s public list of releases. No project, conversation or usage data is included; GitHub receives normal connection metadata." />
            </SettingRow>
          </SettingsGroup>
          <p className="settings-foot">
            Updates are installed manually: download the new version, quit Wanigan, and replace the app.
            Automatic installation is not implemented in this build.
          </p>
        </>
      )}
    </SettingsPage>
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
