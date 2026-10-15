import {
  TopicReadError,
  createTopicReadRepository,
  type PgPool,
  type TopicAncestry,
  type TopicPageRows
} from "@app/db";
import {
  TopicChangeSetInputSchema,
  TopicChangeSetSchema,
  TopicNotesInputSchema,
  TopicNotesSchema,
  TopicPageInputSchema,
  TopicPageSchema,
  TopicPathInputSchema,
  TopicPathSchema,
  TopicShapeInputSchema,
  TopicShapeSchema,
  TopicTreeInputSchema,
  TopicTreeSchema,
  TopicsStatusSchema,
  topicReadLimits,
  type TopicChangeSet,
  type TopicNotes,
  type TopicOverviewState,
  type TopicPage,
  type TopicPath,
  type TopicRelatedTopic,
  type TopicShape,
  type TopicTree,
  type TopicsBlockedReason,
  type TopicsPhase,
  type TopicsStatus
} from "@app/domain";

/** What only the running engine knows about `topics.status` (the topic service supplies it). */
export interface TopicEngineStatus {
  /** `building` while the first build of the active tree runs; the default is derived from the tree. */
  phase?: TopicsPhase;
  blocked?: TopicsBlockedReason;
  dailyCapReached?: boolean;
  /** With `space_changed`: the notes a re-embedding would cover. */
  reembedNotes?: number;
}

export interface TopicReadServiceOptions {
  getPool: () => PgPool | null;
  /** The engine's own state for `topics.status`; absent, the status carries the database's counts only. */
  engineStatus?: () => TopicEngineStatus | Promise<TopicEngineStatus>;
  /** The state of a topic's overview (T31); absent, a page reports that none can be written yet. */
  overview?: (topicId: string) => Promise<TopicOverviewState>;
  /** The clock of "new this week" and "changed today". */
  now?: () => Date;
}

/**
 * The read side of the topic screens: validates every request and every answer, completes what the
 * database cannot (neighbouring topics lifted to the page's level, the overview and the engine's
 * status) and nothing else. Nothing here calls AI or writes (docs/plan.md F2, D21 of the spec).
 */
export class TopicReadService {
  private ancestry: TopicAncestry | null = null;

  constructor(private readonly options: TopicReadServiceOptions) {}

  /** The children of a topic (the root's when `parentId` is null); null when the parent is gone. */
  async tree(input: unknown): Promise<TopicTree | null> {
    const parsed = TopicTreeInputSchema.parse(input ?? {});
    const answer = await this.read(() => this.repository().readTree(parsed, this.clock()));
    return answer === null ? null : TopicTreeSchema.parse(answer);
  }

  /** The path to a topic, resolving the redirect of a retired one; null when it does not exist. */
  async path(input: unknown): Promise<TopicPath | null> {
    const { id } = TopicPathInputSchema.parse(input);
    const answer = await this.repository().readPath(id);
    return answer === null ? null : TopicPathSchema.parse(answer);
  }

  /** Pages of a topic's leaves. */
  async notes(input: unknown): Promise<TopicNotes | null> {
    const parsed = TopicNotesInputSchema.parse(input);
    const answer = await this.read(() => this.repository().readItems(parsed));
    return answer === null
      ? null
      : TopicNotesSchema.parse({ items: answer.items, nextCursor: answer.nextCursor });
  }

  /** The Topic page: a deterministic map of content, without AI; null when the topic is gone. */
  async page(input: unknown): Promise<TopicPage | null> {
    const parsed = TopicPageInputSchema.parse(input);
    const rows = await this.read(() => this.repository().readPage(parsed, this.clock()));
    if (rows === null) return null;
    const relatedTopics = await this.relatedTopics(rows);
    const overview = (await this.options.overview?.(rows.topic.id)) ?? {
      status: "absent" as const,
      canWrite: false
    };
    return TopicPageSchema.parse({
      generation: rows.generation,
      topic: rows.topic,
      redirectedFrom: rows.redirectedFrom,
      path: rows.path,
      counts: rows.counts,
      subtopics: rows.subtopics,
      centralNotes: rows.centralNotes,
      moreNotes: rows.moreNotes,
      sources: rows.sources,
      relatedTopics,
      relationStances: rows.relationStances,
      lastChange: rows.lastChange,
      overview
    });
  }

  /** The cells of the tree (or one branch) and its shape verdict; null when the root is gone. */
  async shape(input: unknown): Promise<TopicShape | null> {
    const parsed = TopicShapeInputSchema.parse(input ?? {});
    const answer = await this.repository().readShape(parsed, this.clock());
    return answer === null ? null : TopicShapeSchema.parse(answer);
  }

  /** A textual before and after of a change-set; null when it does not exist. */
  async changeSet(input: unknown): Promise<TopicChangeSet | null> {
    const { id } = TopicChangeSetInputSchema.parse(input);
    const answer = await this.repository().readChangeSet(id);
    return answer === null ? null : TopicChangeSetSchema.parse(answer);
  }

  /** Where the engine is: the database's counts and the engine's own state. Never blocks. */
  async status(): Promise<TopicsStatus> {
    const counts = await this.repository().readStatusCounts();
    const engine = (await this.options.engineStatus?.()) ?? {};
    const items = counts?.items ?? 0;
    const placed = counts?.placed ?? 0;
    return TopicsStatusSchema.parse({
      phase: engine.phase ?? (counts ? "active" : "building"),
      ...(engine.blocked ? { blocked: engine.blocked } : {}),
      counts: {
        items,
        placed,
        pending: Math.max(0, items - placed),
        needsGate: counts?.needsGate ?? 0
      },
      ...(engine.dailyCapReached !== undefined ? { dailyCapReached: engine.dailyCapReached } : {}),
      ...(engine.reembedNotes !== undefined ? { reembedNotes: engine.reembedNotes } : {})
    });
  }

  private repository() {
    const pool = this.options.getPool();
    if (!pool) throw new Error("topics.errors.unavailable");
    return createTopicReadRepository(pool);
  }

  private clock(): { now: Date } {
    return { now: this.options.now?.() ?? new Date() };
  }

  /** A cursor that does not parse is a stale one: the caller reloads from the first page. */
  private async read<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof TopicReadError) {
        throw new Error("topics.errors.stale", { cause: error });
      }
      throw error;
    }
  }

  /**
   * The neighbours of a page: the topics that hold the notes related to its notes, lifted to the
   * level of the page (a neighbour deeper than the page counts for its ancestor at that level, a
   * shallower one for itself), without the page itself, its ancestors and the root's own pile.
   */
  private async relatedTopics(rows: TopicPageRows): Promise<TopicRelatedTopic[]> {
    if (rows.relatedLeaves.length === 0) return [];
    const ancestry = await this.ancestryAt(rows);
    if (!ancestry) return [];
    const nodes = new Map(ancestry.topics.map((topic) => [topic.id, topic]));
    const level = rows.path.length - 1;
    const excluded = new Set(rows.path.map((entry) => entry.id));
    const counts = new Map<string, number>();
    for (const leaf of rows.relatedLeaves) {
      let node = nodes.get(leaf.topicId);
      while (node && node.depth > level && node.parentId !== null) node = nodes.get(node.parentId);
      if (!node || node.id === ancestry.rootId || excluded.has(node.id)) continue;
      counts.set(node.id, (counts.get(node.id) ?? 0) + leaf.relationCount);
    }
    return [...counts]
      .map(([id, relationCount]) => ({ id, title: nodes.get(id)?.title ?? null, relationCount }))
      .sort(
        (a, b) =>
          b.relationCount - a.relationCount ||
          (a.title ?? "\uffff").localeCompare(b.title ?? "\uffff") ||
          a.id.localeCompare(b.id)
      )
      .slice(0, topicReadLimits.relatedTopicsMax);
  }

  /** The cached ancestry of the page's generation, read again when the tree moved on. */
  private async ancestryAt(rows: TopicPageRows): Promise<TopicAncestry | null> {
    const cached = this.ancestry;
    if (cached && cached.treeId === rows.treeId && cached.generation === rows.generation) {
      return cached;
    }
    const loaded = await this.repository().readAncestry();
    this.ancestry = loaded;
    return loaded;
  }
}
