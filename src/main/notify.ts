// Announcing needs: macOS notifications while Wanigan is not in front, alert
// cards in the window while it is, and the dock badge. Which need goes where is
// decided in shared/notifications.ts; this only shows it and records what was
// actually shown.
import { Notification, app, type BrowserWindow } from 'electron';
import type { Need } from '../shared/model.ts';
import type { NotifyLevel } from '../shared/settings.ts';
import {
  markDismissed, markNative, markWindow, nativeBatch, needRoute, nothingAnnounced, notificationFor, plan, type Announced,
} from '../shared/notifications.ts';

export class NeedNotifier {
  private state: Announced = nothingAnnounced();
  private timer: NodeJS.Timeout | null = null;
  private readonly fetchNeeds: () => Promise<Need[]>;
  private readonly window: () => BrowserWindow | null;
  private readonly open: (route: string) => void;
  private readonly level: () => NotifyLevel;

  /** `open` brings the app forward at a route, making the window if it was closed; `level` is the owner's setting. */
  constructor(fetchNeeds: () => Promise<Need[]>, window: () => BrowserWindow | null, open: (route: string) => void, level: () => NotifyLevel) {
    this.fetchNeeds = fetchNeeds;
    this.window = window;
    this.open = open;
    this.level = level;
  }

  /** Coalesce bursts of core events (and focus changes) into one look. */
  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, 400);
  }

  /** The window showed these alerts, or already had them on screen. */
  seen(keys: string[]): void {
    this.state = markWindow(this.state, keys);
  }

  /** The owner dismissed or opened these alerts. */
  dismissed(keys: string[]): void {
    this.state = markDismissed(this.state, keys);
  }

  async refresh(): Promise<void> {
    let needs: Need[];
    try { needs = await this.fetchNeeds(); } catch { return; }
    if (process.platform === 'darwin') app.dock?.setBadge(needs.length ? String(needs.length) : '');
    const win = this.window();
    const focused = !!win && !win.isDestroyed() && win.isVisible() && win.isFocused();
    const next = plan(this.state, needs, focused, this.level());
    this.state = next.state;
    if (next.window.length && win) win.webContents.send('app:alerts', next.window);
    if (!next.native.length || !Notification.isSupported()) return;

    const { single, rest } = nativeBatch(next.native);
    for (const need of single) {
      const { title, body } = notificationFor(need);
      const n = new Notification({ title, body, silent: need.kind === 'waiting' });
      n.on('click', () => this.open(needRoute(need)));
      n.show();
    }
    if (rest) {
      const n = new Notification({ title: rest.title, body: rest.body });
      n.on('click', () => this.open('#/needs'));
      n.show();
    }
    this.state = markNative(this.state, next.native);
  }
}
