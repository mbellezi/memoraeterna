// The optional re-match a change of the note decider offers (F4 D9, D16, spec 3.5): "n notes were
// matched by another model". Changing a model, a runtime build or a prompt never enqueues work by
// itself (decisions are provenance); it posts one `backlog` finding of the Inbox, unique per
// decider, and the owner's acceptance queues the affected notes' MATCH jobs at the lowest priority.
// A dismissal keeps every stored decision and is not asked again for that decider.
import { sha256 } from "@app/conversion";
import { createRelationMatchBacklogRepository, immediateJobDebounce, type PgPool } from "@app/db";
import { relationsConfig as defaultRelationsConfig, type RelationsConfig } from "@app/domain";

import { enqueueMatchJob } from "./relation-match.js";

export interface RelationMatchBacklogDeps {
  getPool: () => PgPool;
  /** The key matching decides under now; null while no decider can decide. */
  deciderKey: () => Promise<string | null>;
  /** The embedding space the route writes to; notes matched in another space re-embed first. */
  spaceKey?: () => Promise<string | null>;
  config?: RelationsConfig;
  wake?: () => void;
}

export type MatchBacklogOffer =
  /** No decider can decide now: nothing is offered, nothing is closed. */
  | { status: "waiting" }
  /** Every current note was matched under the decider that decides now. */
  | { status: "none"; notes: 0 }
  /** The offer for this decider is a new Inbox item, or its count was updated. */
  | { status: "offered" | "updated"; notes: number; findingId: string }
  /** The owner dismissed (or accepted) the offer for this decider: it stays closed. */
  | { status: "closed"; notes: number };

export type MatchBacklogAcceptance =
  | { status: "queued"; queued: number }
  /** The finding is not an open MATCH backlog, or no decider can decide now. */
  | { status: "closed" | "waiting" }
  /** The decider changed again since the offer: it is closed, and the next offer is a new one. */
  | { status: "stale" };

/** The finding fingerprint of a decider: one offer per decider, so a dismissal persists. */
export const matchBacklogFingerprint = (deciderKey: string) =>
  `match:${sha256(deciderKey).slice(0, 40)}`;

/**
 * The optional re-match a decider change offers (F4 D9, D16): "n notes were matched by another
 * model". Nothing is queued until the owner accepts; a dismissal keeps every stored decision.
 */
export class RelationMatchBacklog {
  private readonly config: RelationsConfig;

  public constructor(private readonly deps: RelationMatchBacklogDeps) {
    this.config = deps.config ?? defaultRelationsConfig;
  }

  /**
   * The key matching decides under now. A decider that cannot run (a required route is missing)
   * has no key: nothing is offered, accepted or closed until one can.
   */
  private async currentDeciderKey(): Promise<string | null> {
    try {
      return await this.deps.deciderKey();
    } catch {
      return null;
    }
  }

  /**
   * Counts the notes matched under another decider than the current one and posts (or updates)
   * the `backlog` finding of the Inbox. An older decider's open offer is moot and resolved.
   */
  public async offer(): Promise<MatchBacklogOffer> {
    const deciderKey = await this.currentDeciderKey();
    if (!deciderKey) return { status: "waiting" };
    const repository = createRelationMatchBacklogRepository(this.deps.getPool());
    const notes = await repository.countAffected({
      deciderKey,
      spaceKey: (await this.deps.spaceKey?.()) ?? null
    });
    const fingerprint = matchBacklogFingerprint(deciderKey);
    if (notes === 0) {
      await repository.resolveOpen(null);
      return { status: "none", notes: 0 };
    }
    await repository.resolveOpen(fingerprint);
    const offered = await repository.offer({
      fingerprint,
      params: { task: "match", reason: "decider_changed", notes }
    });
    if (!offered) return { status: "closed", notes };
    return {
      status: offered.created ? "offered" : "updated",
      notes,
      findingId: offered.finding.id
    };
  }

  /**
   * The owner accepted the offer: the affected notes are queued at the lowest priority, a page at
   * a time, one job per note (a note already queued is not queued twice), then the finding is
   * resolved. Interrupted, the finding stays open and accepting again queues what is left.
   */
  public async accept(findingId: string): Promise<MatchBacklogAcceptance> {
    const pool = this.deps.getPool();
    const repository = createRelationMatchBacklogRepository(pool);
    const finding = await repository.find(findingId);
    if (!finding || finding.status !== "open") return { status: "closed" };
    const deciderKey = await this.currentDeciderKey();
    if (!deciderKey) return { status: "waiting" };
    if (finding.fingerprint !== matchBacklogFingerprint(deciderKey)) {
      await repository.resolve(finding.id);
      return { status: "stale" };
    }
    const spaceKey = (await this.deps.spaceKey?.()) ?? null;
    const debounce = immediateJobDebounce;
    let queued = 0;
    for (let after: string | null = null; ;) {
      const page = await repository.listAffected({
        deciderKey,
        spaceKey,
        afterNoteId: after,
        limit: this.config.match.backlogPageSize
      });
      for (const { noteId, rootId } of page) {
        await enqueueMatchJob(pool, { noteId, rootId, backlog: true, debounce });
        queued += 1;
      }
      const last = page.at(-1);
      if (!last || page.length < this.config.match.backlogPageSize) break;
      after = last.noteId;
    }
    await repository.resolve(finding.id);
    if (queued > 0) this.deps.wake?.();
    return { status: "queued", queued };
  }
}
