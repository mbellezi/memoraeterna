// The `relationsChanged` push (F3 3.11 step 4): after a link job commits, the notes whose relations
// changed are announced to the windows, coalesced over a short window, at most 200 IDs per event,
// so an open Note page refreshes its list once per commit burst instead of polling.

/** One push: the notes whose relations changed (1 to 200 IDs). */
export interface RelationsChangedEvent {
  noteIds: string[];
}

export const relationsChangedMaxNoteIds = 200;
export const relationsChangedCoalesceMs = 250;

/**
 * Collects changed note IDs and emits them once the window after the first change closes; more
 * than 200 IDs leave as several events. Listeners that throw never stop the others.
 */
export class RelationsChangedEmitter {
  private readonly listeners = new Set<(event: RelationsChangedEvent) => void>();
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    private readonly options: {
      coalesceMs?: number;
      onListenerError?: (error: unknown) => void;
    } = {}
  ) {}

  public subscribe(listener: (event: RelationsChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Records changed notes; the event leaves when the coalescing window closes. */
  public changed(noteIds: Iterable<string>): void {
    for (const id of noteIds) this.pending.add(id);
    if (this.pending.size === 0 || this.timer) return;
    this.timer = setTimeout(
      () => this.flush(),
      this.options.coalesceMs ?? relationsChangedCoalesceMs
    );
  }

  /** Emits what is pending now (also on shutdown). */
  public flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ids = [...this.pending].sort();
    this.pending = new Set();
    for (let start = 0; start < ids.length; start += relationsChangedMaxNoteIds) {
      const event = { noteIds: ids.slice(start, start + relationsChangedMaxNoteIds) };
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch (error) {
          this.options.onListenerError?.(error);
        }
      }
    }
  }
}
