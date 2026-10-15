// The `topicsChanged` push (D15): recorded only after a change-set commits, coalesced over a short
// window and delivered to subscribers (T16 forwards them to the renderer's channel). Topic IDs are
// listed up to `topicLimits.changedTopicIdsMax`; a broader change sends null (refresh everything).
import { TopicsChangedEventSchema, topicLimits } from "@app/domain";
import type { z } from "zod";

export type TopicsChangedEvent = z.output<typeof TopicsChangedEventSchema>;

export interface TopicChange {
  treeId: string;
  generation: number;
  /** Topics whose content or counts changed; null when too many to list. */
  topicIds: readonly string[] | null;
  /** The committed change-set, or null for a change without one (statistics, a new tree). */
  changeSetId: string | null;
}

/** Coalescing window after a commit (D15). */
export const topicsChangedCoalesceMs = 250;

interface Pending {
  treeId: string;
  generation: number;
  topicIds: Set<string> | null;
  changeSetIds: Set<string | null>;
}

export class TopicChangeCoalescer {
  private pending: Pending | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(event: TopicsChangedEvent) => void>();

  public constructor(
    private readonly options: {
      delayMs?: number;
      logger?: Pick<Console, "error">;
    } = {}
  ) {}

  public subscribe(listener: (event: TopicsChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Records a committed change; a change of another tree first flushes the pending one. */
  public record(change: TopicChange): void {
    if (this.pending && this.pending.treeId !== change.treeId) this.flush();
    const pending = (this.pending ??= {
      treeId: change.treeId,
      generation: change.generation,
      topicIds: new Set(),
      changeSetIds: new Set()
    });
    pending.generation = Math.max(pending.generation, change.generation);
    if (change.topicIds === null) pending.topicIds = null;
    else if (pending.topicIds) for (const id of change.topicIds) pending.topicIds.add(id);
    if (pending.topicIds && pending.topicIds.size > topicLimits.changedTopicIdsMax) {
      pending.topicIds = null;
    }
    pending.changeSetIds.add(change.changeSetId);
    this.timer ??= setTimeout(() => this.flush(), this.options.delayMs ?? topicsChangedCoalesceMs);
  }

  /** Emits the pending change now: one event, naming its change-set only when there was one. */
  public flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    const changeSets = [...pending.changeSetIds];
    const event = TopicsChangedEventSchema.parse({
      treeId: pending.treeId,
      generation: pending.generation,
      topicIds: pending.topicIds ? [...pending.topicIds].sort() : null,
      changeSetId: changeSets.length === 1 ? changeSets[0] : null
    });
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.options.logger?.error("topicsChanged listener failed", error);
      }
    }
  }

  /** Drops a pending change without emitting it (shutdown). */
  public dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.listeners.clear();
  }
}
