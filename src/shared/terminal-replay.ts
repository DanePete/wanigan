/** Orders one scrollback snapshot and its live stream without replaying input. */
export class TerminalReplay {
  private phase: 'snapshot' | 'parsing' | 'live' = 'snapshot';
  private pendingLocal: string[] = [];
  private readonly write: (text: string, parsed?: () => void) => void;

  constructor(write: (text: string, parsed?: () => void) => void) { this.write = write; }

  /** Replayed device queries must not write their answers into the live PTY. */
  get suppressInput(): boolean { return this.phase !== 'live'; }

  feed(text: string): void {
    // Main flushes before answering the snapshot. Earlier broadcasts are
    // already in it; later ones queue behind its write in xterm's parser.
    if (this.phase !== 'snapshot') this.write(text);
  }

  local(text: string): void {
    if (this.phase === 'live') this.write(text);
    else this.pendingLocal.push(text);
  }

  snapshot(text: string): void {
    if (this.phase !== 'snapshot') return;
    this.phase = 'parsing';
    if (text) this.write(text, () => this.finish());
    else this.finish();
  }

  failed(): void { this.finish(); }

  private finish(): void {
    this.phase = 'live';
    for (const text of this.pendingLocal.splice(0)) this.write(text);
  }
}
