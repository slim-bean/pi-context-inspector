/** Read-only, interaction-scoped polling. Check cheap revisions, not entire payloads.
 * Polling also catches entries appended without message events, after persistence.
 */
export interface LiveSource<T> {
  revision(): string;
  read(): T;
  onError(error: unknown): void;
}

export class LiveRefresh<T> {
  private timer?: ReturnType<typeof setInterval>;
  private revision: string;
  private disposed = false;

  constructor(private source: LiveSource<T>, private update: (value: T) => void) {
    this.revision = source.revision();
    this.timer = setInterval(() => this.refresh(), 250);
    this.timer.unref();
  }

  refresh(force = false): void {
    if (this.disposed) return;
    try {
      const revision = this.source.revision();
      if (!force && revision === this.revision) return;
      this.update(this.source.read());
      this.revision = revision;
    } catch (error) {
      this.dispose();
      this.source.onError(error);
    }
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
