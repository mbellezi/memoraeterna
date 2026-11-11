// The Inbox (F4 D29, spec 3.10): the one place for human judgment. It reads the open items of every
// store as one list ordered by risk then age, counts them, and carries each verb out through the
// store's own writer, so a verdict persists where the calibration label F6 reads it. It adds no
// label store and calls no AI. Every request is validated here and every answer before it leaves.
import {
  createChangeSetRepository,
  createGardenerFindingRepository,
  createGardenerOutcomeRepository,
  createInboxRepository,
  InboxCursorError,
  type InboxPageInput,
  type InboxRowKey,
  type InboxRowsPage,
  type PgPool
} from "@app/db";
import {
  InboxActInputSchema,
  InboxActResultSchema,
  InboxCountsSchema,
  InboxListInputSchema,
  InboxListSchema,
  compareInboxPositions,
  emptyInboxCounts,
  inboxCursor,
  inboxKinds,
  inboxReadLimits,
  inboxRiskRank,
  inboxTime,
  parseInboxCursor,
  type BudgetSnapshot,
  type ChangesReviewResult,
  type ChangesUndoResult,
  type GardenerFindingKind,
  type InboxActInput,
  type InboxActResult,
  type InboxCounts,
  type InboxItem,
  type InboxList,
  type InboxPosition,
  type RelationReviewInput,
  type RelationReviewResult
} from "@app/domain";

import type { AppEvent, AppEventHandler, AppEventType } from "../../../shared/app-events.js";
import type { MatchBacklogAcceptance } from "../relations/relation-match-backlog.js";
import {
  budgetVariant,
  inboxItems,
  isUuid,
  obsidianItem,
  parseChangeSetItemId,
  parseDivergenceItemId,
  parseQuarantineItemId,
  type ObsidianConflictRecord
} from "./inbox-items.js";

const errors = {
  invalidCursor: "inbox.errors.invalidCursor",
  invalidItem: "inbox.errors.invalidItem",
  unavailable: "inbox.errors.unavailable"
} as const;

/** The store handlers that carry the verbs out (tests pass fakes). */
export interface InboxServiceOptions {
  getPool: () => PgPool | null;
  /** `changes.review` and `changes.undo`: the change-sets of the three stores. */
  changes: {
    review(input: unknown): Promise<ChangesReviewResult>;
    undo(input: unknown): Promise<ChangesUndoResult>;
  };
  /** `relations.review`: keep or remove a suggested or withdrawn relation. */
  reviewRelation(input: RelationReviewInput): Promise<RelationReviewResult | null>;
  /**
   * The MATCH backlog (F4 D16): its offer is posted when the Inbox opens (a decider that changed
   * while the app ran), its acceptance carries the owner's yes out; null while the decider's
   * service is not running.
   */
  matchBacklog: () => {
    accept(findingId: string): Promise<MatchBacklogAcceptance>;
    offer?(): Promise<unknown>;
  } | null;
  /** The supervisor's manual retry of a job; resolves to null when the job is gone. */
  retryJob(jobId: string): Promise<unknown>;
  /** The RemoteBudget: its meters, and the continue past the pause share (D14). */
  budget?: { snapshot(): Promise<BudgetSnapshot>; continue(): Promise<BudgetSnapshot> };
  /** The vault's conflicts (editorial and projection); empty while Obsidian is not in use. */
  obsidianConflicts?: () => Promise<ObsidianConflictRecord[]>;
  /** The bus: counts are published after any change, and the stores' events trigger a recount. */
  events?: {
    publish(event: AppEvent): void;
    subscribe<T extends AppEventType>(type: T, handler: AppEventHandler<T>): () => void;
  };
  /** Quiet time after an event before the counts are read again. */
  refreshDelayMs?: number;
  now?: () => number;
  logger?: Pick<Console, "warn">;
}

/** Events after which the open items may have changed. */
const recountEvents = [
  "job.progress",
  "changes.changed",
  "tree.changed",
  "relation.created",
  "overview.changed"
] as const satisfies readonly AppEventType[];

const defaultRefreshDelayMs = 3_000;
/** The longest quiet time the adaptive delay of `recountDelayMs` grows to. */
const recountDelayMaxMs = 60_000;

/**
 * The quiet time before a recount: at least `baseMs`, and ten times as long as the last read took,
 * so a library with tens of thousands of routed suggestions (D33: the visibility check is paid per
 * relation) never spends most of its time counting while a stream of events goes on.
 */
export function recountDelayMs(baseMs: number, lastReadMs: number): number {
  return Math.max(baseMs, Math.min(recountDelayMaxMs, Math.round(lastReadMs * 10)));
}
/** How long the vault's conflicts are reused by the recounts that follow a stream of events. */
const vaultCacheMs = 10_000;
/** How often opening the Inbox asks the MATCH backlog whether its decider changed. */
const offerEveryMs = 60_000;

const sameCounts = (a: InboxCounts | null, b: InboxCounts): boolean =>
  a !== null && JSON.stringify(a) === JSON.stringify(b);

/** The meters of a month's budget in the dollars the item shows. */
const dollars = (value: number): number => Math.round(value * 100) / 100;

export class InboxService {
  private lastCounts: InboxCounts | null = null;
  private unsubscribe: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<void> | null = null;
  private again = false;
  /** How long the last count took to read (the quiet time before the next one follows it). */
  private lastReadMs = 0;
  private disposed = false;
  private vault: { at: number; records: ObsidianConflictRecord[] } | null = null;
  private offeredAt = Number.NEGATIVE_INFINITY;
  /** When this process first listed a vault conflict whose time is not stored. */
  private conflictSeen = new Map<string, Date>();

  constructor(private readonly options: InboxServiceOptions) {}

  private pool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error(errors.unavailable);
    return pool;
  }

  /** Follows the stores' events and the budget; the counts are read once to start. */
  start(): void {
    const events = this.options.events;
    if (!events || this.unsubscribe.length > 0) return;
    for (const type of recountEvents)
      this.unsubscribe.push(events.subscribe(type, () => this.schedule()));
    this.unsubscribe.push(
      events.subscribe("budget.changed", (event) => {
        this.syncBudget(event.budget)
          .catch((error: unknown) =>
            this.options.logger?.warn("The budget's Inbox items could not be synced", error)
          )
          .finally(() => this.schedule());
      })
    );
    void this.syncBudgetNow().then(() => this.schedule());
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const stop of this.unsubscribe) stop();
    this.unsubscribe = [];
  }

  // -------------------------------------------------------------------------
  // inbox.list and inbox.counts

  /**
   * A page of open items by risk (high first) and age (oldest first). `offer: false` makes it a
   * pure read: the MATCH backlog is not offered (the offer writes a finding), which is how Home
   * reads the top rows.
   */
  async list(input: unknown, options: { offer?: boolean } = {}): Promise<InboxList> {
    const parsed = InboxListInputSchema.parse(input ?? {});
    const pool = this.pool();
    const after = parsed.cursor ? parseInboxCursor(parsed.cursor) : null;
    if (parsed.cursor && !after) throw new Error(errors.invalidCursor);
    // Opening the Inbox is when a decider that changed while the app ran offers its re-match.
    if (
      options.offer !== false &&
      !parsed.cursor &&
      (!parsed.kinds || parsed.kinds.includes("backlog"))
    )
      await this.offerBacklog();
    const wantsObsidian = !parsed.kinds || parsed.kinds.includes("obsidian_conflict");
    const obsidian =
      wantsObsidian && (!parsed.risk || parsed.risk === "medium")
        ? await this.conflictTimes(pool, await this.obsidian())
        : [];
    const page = await this.readPage(pool, {
      kinds: parsed.kinds,
      risk: parsed.risk,
      after: parsed.cursor ?? null,
      limit: parsed.limit
    });

    // The database rows and the vault's conflicts, merged by the one order of the list.
    type Entry =
      | { position: InboxPosition; row: InboxRowKey }
      | { position: InboxPosition; conflict: InboxItem };
    const entries: Entry[] = page.rows.map((row) => ({
      position: { rank: row.rank, at: row.at, key: row.key },
      row
    }));
    for (const record of obsidian) {
      const item = obsidianItem(record, inboxTime(record.at));
      const position = {
        rank: inboxRiskRank(item.risk),
        at: item.at,
        key: `${item.kind}:${item.id}`
      };
      if (!after || compareInboxPositions(position, after) > 0)
        entries.push({ position, conflict: item });
    }
    entries.sort((a, b) => compareInboxPositions(a.position, b.position));
    const taken = entries.slice(0, parsed.limit);
    const hasMore = entries.length > parsed.limit || page.hasMore;
    const last = taken.at(-1);

    const rows = taken.flatMap((entry) => ("row" in entry ? [entry.row] : []));
    const hydrated = new Map(
      (await inboxItems(pool, rows)).map((item) => [`${item.kind}:${item.id}`, item])
    );
    const items = taken.flatMap((entry) => {
      const item = "conflict" in entry ? entry.conflict : hydrated.get(entry.position.key);
      return item ? [item] : [];
    });
    return InboxListSchema.parse({
      items,
      nextCursor: hasMore && last ? inboxCursor(last.position) : null
    });
  }

  /**
   * The open items by kind and by risk. `cached` lets the vault's conflicts (the one count that
   * costs a read of the sync tables) come from the last read within a few seconds: the recount
   * that follows a stream of events uses it, a person's request never does.
   */
  async counts(options: { cached?: boolean } = {}): Promise<InboxCounts> {
    const rows = await createInboxRepository(this.pool()).counts();
    const counts = emptyInboxCounts();
    for (const kind of inboxKinds) counts.byKind[kind] = rows.byKind[kind] ?? 0;
    counts.byRisk = { ...rows.byRisk };
    const conflicts = (await this.obsidian(options.cached === true)).length;
    counts.byKind.obsidian_conflict = conflicts;
    counts.byRisk.medium += conflicts;
    counts.total = inboxKinds.reduce((sum, kind) => sum + counts.byKind[kind], 0);
    return InboxCountsSchema.parse(counts);
  }

  /** Posts the MATCH backlog's offer for the decider of now, at most once a minute; never throws. */
  private async offerBacklog(): Promise<void> {
    const backlog = this.options.matchBacklog();
    if (!backlog?.offer) return;
    const now = (this.options.now ?? Date.now)();
    if (now - this.offeredAt < offerEveryMs) return;
    this.offeredAt = now;
    try {
      const offer = await backlog.offer();
      // A new offer changes the counts: the badge and the Activity follow at once.
      if (offer && typeof offer === "object" && "status" in offer && offer.status === "offered")
        void this.refreshNow();
    } catch (error) {
      this.options.logger?.warn("The MATCH backlog could not be offered", error);
    }
  }

  private async readPage(pool: PgPool, input: InboxPageInput): Promise<InboxRowsPage> {
    try {
      return await createInboxRepository(pool).page(input);
    } catch (error) {
      if (error instanceof InboxCursorError)
        throw new Error(errors.invalidCursor, { cause: error });
      throw error;
    }
  }

  private async obsidian(cached = false): Promise<ObsidianConflictRecord[]> {
    const now = (this.options.now ?? Date.now)();
    if (cached && this.vault && now - this.vault.at < vaultCacheMs) return this.vault.records;
    try {
      const records = ((await this.options.obsidianConflicts?.()) ?? []).slice(
        0,
        inboxReadLimits.obsidianMax
      );
      this.vault = { at: now, records };
      return records;
    } catch (error) {
      // The vault being unreadable must not hide the rest of the Inbox.
      this.options.logger?.warn("The Obsidian conflicts could not be listed", error);
      return [];
    }
  }

  /**
   * When each conflict arose, for its age and its place in the list: the stored time of its
   * operation or revision, else the first time this process listed it (never a made-up date, which
   * would read as decades old and sort first).
   */
  private async conflictTimes(
    pool: PgPool,
    records: readonly ObsidianConflictRecord[]
  ): Promise<Array<ObsidianConflictRecord & { at: Date }>> {
    const keyOf = (record: ObsidianConflictRecord) =>
      `${record.variant === "projection" ? "projection" : "editorial"}:${record.id}`;
    const unknown = records.filter((record) => record.at === null);
    let stored = new Map<string, Date>();
    if (unknown.length > 0) {
      try {
        stored = await createInboxRepository(pool).obsidianConflictTimes({
          editorial: unknown.filter((r) => r.variant !== "projection").map((r) => r.id),
          projection: unknown.filter((r) => r.variant === "projection").map((r) => r.id)
        });
      } catch (error) {
        this.options.logger?.warn("The Obsidian conflicts' times could not be read", error);
      }
    }
    const now = new Date((this.options.now ?? Date.now)());
    const seen = new Map<string, Date>();
    const timed = records.map((record) => {
      if (record.at) return { ...record, at: record.at };
      const key = keyOf(record);
      const at = stored.get(key) ?? this.conflictSeen.get(key) ?? now;
      if (!stored.has(key)) seen.set(key, at);
      return { ...record, at };
    });
    // Every read lists all of the vault's conflicts, so one that is not listed is solved.
    this.conflictSeen = seen;
    return timed;
  }

  // -------------------------------------------------------------------------
  // inbox.act

  /** Carries one verb out through the store's own writer. */
  async act(input: unknown): Promise<InboxActResult> {
    const parsed = InboxActInputSchema.parse(input);
    const result = await this.run(parsed);
    // A verdict changes what is open: the counts follow at once, not after the quiet period.
    if (result.status === "done" || result.status === "gone" || result.status === "stale")
      void this.refreshNow();
    return InboxActResultSchema.parse(result);
  }

  private async run(input: InboxActInput): Promise<InboxActResult> {
    switch (input.kind) {
      case "review":
        return this.changeSet(input);
      case "contradiction":
        return parseDivergenceItemId(input.id) === null
          ? this.relation(input)
          : this.divergence(input);
      case "suggestion":
      case "withdrawn":
        return this.relation(input);
      case "quarantined":
        return this.quarantine(input);
      case "duplicate":
      case "backlog":
      case "budget":
        return this.finding(input);
      case "obsidian_conflict":
        return { status: "unsupported" };
    }
  }

  private async changeSet(input: InboxActInput): Promise<InboxActResult> {
    const ref = parseChangeSetItemId(input.id);
    if (!ref) throw new Error(errors.invalidItem);
    try {
      if (input.action === "undo") {
        const undone = await this.options.changes.undo(ref);
        return undone.status === "undone"
          ? { status: "done", undoable: false }
          : { status: "blocked", blockers: undone.blockers, more: undone.more };
      }
      if (input.action !== "apply" && input.action !== "dismiss") return { status: "unsupported" };
      const verdict = await this.options.changes.review({ ...ref, verdict: input.action });
      if (verdict.status === "blocked")
        return { status: "blocked", blockers: verdict.blockers, more: verdict.more };
      // The status that stands answers the verdict: another one (a verdict given elsewhere, an
      // undo since) is not this one, and the list is read again.
      if (verdict.status !== (input.action === "apply" ? "applied" : "dismissed"))
        return { status: "stale" };
      // Applied stays undoable while its store says the undo is available.
      const undoable =
        input.action === "apply" &&
        (await createChangeSetRepository(this.pool()).get(ref.kind, ref.id))?.undo === "available";
      return { status: "done", undoable };
    } catch (error) {
      if (error instanceof Error && error.message === "changes.errors.notFound")
        return { status: "gone" };
      throw error;
    }
  }

  private async relation(input: InboxActInput): Promise<InboxActResult> {
    if (!isUuid(input.id)) throw new Error(errors.invalidItem);
    if (input.action !== "apply" && input.action !== "dismiss") return { status: "unsupported" };
    const wanted = input.action === "apply" ? "kept" : "removed";
    const reviewed = await this.options.reviewRelation({
      relationId: input.id,
      verdict: input.action === "apply" ? "keep" : "remove"
    });
    if (!reviewed) return { status: "gone" };
    // A verdict is final in both directions (I-R2, I-R3): another one that stands is not ours.
    return reviewed.outcome === wanted ? { status: "done", undoable: false } : { status: "stale" };
  }

  /**
   * The owner's verdict on the Divergences an automatic overview patch kept (D17, D29): keeping
   * them beside the text resolves the finding, dismissing it can be taken back. Either way the
   * overview stays as it is; undoing the patch itself is Activity's (and closes the item).
   */
  private async divergence(input: InboxActInput): Promise<InboxActResult> {
    const findingId = parseDivergenceItemId(input.id);
    if (!findingId) throw new Error(errors.invalidItem);
    const findings = createGardenerFindingRepository(this.pool());
    const finding = await findings.get(findingId);
    if (!finding || finding.kind !== "divergence") return { status: "gone" };
    if (input.action === "undo") {
      if (finding.status !== "dismissed") return { status: "gone" };
      return (await findings.reopen(finding.id))
        ? { status: "done", undoable: false }
        : { status: "gone" };
    }
    if (finding.status !== "open") return { status: "gone" };
    if (input.action === "dismiss")
      return (await findings.dismiss(finding.id))
        ? { status: "done", undoable: true }
        : { status: "gone" };
    if (input.action !== "apply") return { status: "unsupported" };
    return (await findings.resolve("divergence", [finding.fingerprint])) > 0
      ? { status: "done", undoable: false }
      : { status: "gone" };
  }

  private async quarantine(input: InboxActInput): Promise<InboxActResult> {
    const subject = parseQuarantineItemId(input.id);
    if (!subject) throw new Error(errors.invalidItem);
    const pool = this.pool();
    const inbox = createInboxRepository(pool);
    if (input.action === "undo") {
      return (await inbox.undismissQuarantine(subject.kind, subject.subjectKey))
        ? { status: "done", undoable: false }
        : { status: "gone" };
    }
    if (input.action === "dismiss") {
      const dismissed = await inbox.dismissQuarantine(subject.kind, subject.subjectKey);
      return dismissed ? { status: "done", undoable: dismissed === "stamped" } : { status: "gone" };
    }
    if (input.action !== "retry") return { status: "unsupported" };
    const outcome = await createGardenerOutcomeRepository(pool).get(
      subject.kind,
      subject.subjectKey
    );
    if (!outcome?.quarantinedAt) return { status: "gone" };
    if (!outcome.lastJobId) return { status: "stale" };
    // The retry releases the quarantine in the statement that queues the job again.
    return (await this.options.retryJob(outcome.lastJobId))
      ? { status: "done", undoable: false }
      : { status: "stale" };
  }

  private async finding(input: InboxActInput): Promise<InboxActResult> {
    if (!isUuid(input.id)) throw new Error(errors.invalidItem);
    const findings = createGardenerFindingRepository(this.pool());
    const finding = await findings.get(input.id);
    const kind = input.kind as GardenerFindingKind;
    if (!finding || finding.kind !== kind) return { status: "gone" };
    if (input.action === "undo") {
      if (finding.status !== "dismissed") return { status: "gone" };
      return (await findings.reopen(finding.id))
        ? { status: "done", undoable: false }
        : { status: "gone" };
    }
    if (finding.status !== "open") return { status: "gone" };
    if (input.action === "dismiss")
      return (await findings.dismiss(finding.id))
        ? { status: "done", undoable: true }
        : { status: "gone" };
    if (input.action !== "apply") return { status: "unsupported" };
    if (kind === "backlog") return this.acceptBacklog(finding.id, finding.params.task);
    if (kind === "budget") return this.continueBudget(finding.fingerprint);
    return { status: "unsupported" };
  }

  /** The owner accepted the optional re-match: the affected notes are queued at the lowest priority. */
  private async acceptBacklog(findingId: string, task: unknown): Promise<InboxActResult> {
    if (task !== "match") return { status: "unsupported" };
    const backlog = this.options.matchBacklog();
    if (!backlog) throw new Error(errors.unavailable);
    const accepted = await backlog.accept(findingId);
    switch (accepted.status) {
      case "queued":
        return { status: "done", undoable: false, queued: accepted.queued };
      case "waiting":
        return { status: "waiting" };
      case "stale":
        return { status: "stale" };
      case "closed":
        return { status: "gone" };
    }
  }

  /** The owner continues remote background work past the pause share (D14). */
  private async continueBudget(fingerprint: string): Promise<InboxActResult> {
    const budget = this.options.budget;
    if (!budget) throw new Error(errors.unavailable);
    if (budgetVariant(fingerprint) !== "money_80") return { status: "unsupported" };
    const snapshot = await budget.continue();
    await this.syncBudget(snapshot);
    return snapshot.money.state === "paused"
      ? { status: "waiting" }
      : { status: "done", undoable: false };
  }

  // -------------------------------------------------------------------------
  // The budget's items

  private async syncBudgetNow(): Promise<void> {
    try {
      if (this.options.budget) await this.syncBudget(await this.options.budget.snapshot());
    } catch (error) {
      this.options.logger?.warn("The budget's Inbox items could not be synced", error);
    }
  }

  /**
   * The budget's meters as Inbox items (D14, D29): one open item for the month's money while it is
   * paused at the warning share (`money_80`) or used up (`money_100`), closed when the person
   * continues or the cap rises, and never reopened once the person dismissed it. A subscription
   * lane's daily allowance clears by itself and has no item.
   */
  async syncBudget(snapshot: BudgetSnapshot): Promise<void> {
    const pool = this.options.getPool();
    if (!pool) return;
    const findings = createGardenerFindingRepository(pool);
    const { money, month } = snapshot;
    const wanted =
      money.state === "paused" && !money.continued
        ? { fingerprint: `money_80:${month}`, risk: "medium" as const }
        : money.state === "exhausted"
          ? { fingerprint: `money_100:${month}`, risk: "high" as const }
          : null;
    if (wanted)
      await findings.record([
        {
          kind: "budget",
          fingerprint: wanted.fingerprint,
          objectRefs: [],
          params: { month, spentUsd: dollars(money.spentUsd), capUsd: dollars(money.capUsd) },
          risk: wanted.risk
        }
      ]);
    await findings.resolveMissing("budget", wanted ? [wanted.fingerprint] : []);
  }

  // -------------------------------------------------------------------------
  // inbox.changed

  private schedule(): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.refreshNow();
      },
      recountDelayMs(this.options.refreshDelayMs ?? defaultRefreshDelayMs, this.lastReadMs)
    );
    this.timer.unref?.();
  }

  /** Reads the counts and publishes them when they differ from the last ones published. */
  async refreshNow(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.again = false;
        try {
          const startedAt = (this.options.now ?? Date.now)();
          const counts = await this.counts({ cached: true });
          this.lastReadMs = Math.max(0, (this.options.now ?? Date.now)() - startedAt);
          if (!sameCounts(this.lastCounts, counts)) {
            this.lastCounts = counts;
            this.options.events?.publish({ type: "inbox.changed", ...counts });
          }
        } catch (error) {
          this.options.logger?.warn("The Inbox counts could not be read", error);
        }
      } while (this.again && !this.disposed);
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
}
