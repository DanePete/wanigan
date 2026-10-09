// Keeping the Mac awake while agents work. A sleeping Mac stops every session
// mid-step, so while any session is live (and the setting is on) Wanigan holds a
// `prevent-app-suspension` blocker: the system stays up, the display may sleep.
//
// It lives in the app, not the core: Electron's power API is not available to
// the core's plain Node. So it holds only while Wanigan is running; quitting
// the app leaves sessions running in the core and lets the Mac sleep.

/** The part of Electron's powerSaveBlocker this needs; a stand-in in tests. */
export interface Blocker {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
}

export class KeepAwake {
  private id: number | null = null;
  private live = 0;
  private enabled: boolean;
  private readonly blocker: Blocker;

  constructor(blocker: Blocker, enabled: boolean) {
    this.blocker = blocker;
    this.enabled = enabled;
  }

  get holding(): boolean {
    return this.id !== null;
  }

  get liveSessions(): number {
    return this.live;
  }

  /** How many sessions are live now. */
  setLive(count: number): void {
    this.live = Math.max(0, Math.floor(count));
    this.apply();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.apply();
  }

  /** Let go, whatever the state (the app is quitting). */
  release(): void {
    if (this.id !== null) this.blocker.stop(this.id);
    this.id = null;
  }

  private apply(): void {
    const want = this.enabled && this.live > 0;
    if (want && this.id === null) this.id = this.blocker.start('prevent-app-suspension');
    else if (!want) this.release();
  }
}
