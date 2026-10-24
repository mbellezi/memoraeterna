import type { DesktopApi } from "../../../shared/ipc";

/** What the badge needs of `window.app`. */
export interface InboxBadgeApi {
  inbox: Pick<DesktopApi["inbox"], "counts">;
  onAppEvent: DesktopApi["onAppEvent"];
}

/**
 * How many items wait in the Inbox, for the navigation rail's badge: read once when it starts and
 * kept by `inbox.changed` after, never polled. It is shell chrome, not a view: it keeps listening
 * while the Inbox is hidden, which is the point of a badge.
 */
export class InboxBadge {
  private total: number | null = null;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private token = 0;

  constructor(private readonly api: () => InboxBadgeApi) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): number | null => this.total;

  private set(total: number): void {
    if (total === this.total) return;
    this.total = total;
    for (const listener of [...this.listeners]) listener();
  }

  /** Reads the count and follows the changes; a second call while started does nothing. */
  start(): void {
    if (this.unsubscribe) return;
    const token = ++this.token;
    const api = this.api();
    this.unsubscribe = api.onAppEvent("inbox.changed", (event) => {
      // A pushed count is newer than a read that is still on its way.
      this.token += 1;
      this.set(event.total);
    });
    api.inbox
      .counts()
      .then((counts) => {
        if (token === this.token && this.unsubscribe) this.set(counts.total);
      })
      .catch(() => undefined);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.token += 1;
  }
}
