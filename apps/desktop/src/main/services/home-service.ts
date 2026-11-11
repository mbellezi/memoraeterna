import { createHomeDigestRepository, type HomeDigestRecord, type PgPool } from "@app/db";
import type { InboxItem, InboxList } from "@app/domain";

import {
  HomeDigestInputSchema,
  HomeDigestSchema,
  homeDigestBounds,
  type HomeDigest
} from "../../shared/ipc-home.js";

/**
 * The slice of the Inbox service the digest needs. With it, the Inbox row count and its three first
 * rows are the Inbox's own (the Obsidian conflicts, which the sync service lists, included, and each
 * row carrying its sentence parameters); without it they come from the database kinds alone.
 */
export interface HomeInbox {
  list: (input: { limit: number }) => Promise<InboxList>;
  counts: () => Promise<{ total: number }>;
}

export interface HomeServiceOptions {
  getPool: () => PgPool | null;
  inbox?: (() => HomeInbox | null) | undefined;
  /** The clock (tests). */
  now?: (() => Date) | undefined;
}

/**
 * Home's one read (F5 D9, T130): what arrived, what the Gardener did, what waits, the last
 * questions and the shape of the tree, since the `since` the renderer passes. Read-only: it stores
 * no last visit and calls no AI.
 */
export class HomeService {
  constructor(private readonly options: HomeServiceOptions) {}

  async digest(input: unknown): Promise<HomeDigest> {
    const { since } = HomeDigestInputSchema.parse(input ?? {});
    const pool = this.options.getPool();
    if (!pool) throw new Error("home.errors.unavailable");
    const now = this.options.now?.() ?? new Date();
    const record = await createHomeDigestRepository(pool).digest({
      since: since ? new Date(since) : null,
      now
    });
    const inbox = await this.inbox(record);
    return HomeDigestSchema.parse(toDigest(record, inbox));
  }

  /** The Inbox's own total and rows when it is installed; its failure never fails Home. */
  private async inbox(
    record: HomeDigestRecord
  ): Promise<{ total: number; order: InboxItem[] | null }> {
    const inbox = this.options.inbox?.() ?? null;
    if (!inbox) return { total: record.inbox.total, order: null };
    try {
      const [counts, list] = await Promise.all([
        inbox.counts(),
        inbox.list({ limit: homeDigestBounds.inbox })
      ]);
      return { total: counts.total, order: list.items.slice(0, homeDigestBounds.inbox) };
    } catch {
      return { total: record.inbox.total, order: null };
    }
  }
}

const iso = (date: Date): string => date.toISOString();

function toDigest(record: HomeDigestRecord, inbox: { total: number; order: InboxItem[] | null }) {
  return {
    since: iso(record.since),
    firstRun: record.firstRun,
    continue: record.continue.map((entry) => ({ ...entry, openedAt: iso(entry.openedAt) })),
    new: {
      sources: {
        total: record.new.sources.total,
        items: record.new.sources.items.map((a) => ({ ...a, createdAt: iso(a.createdAt) }))
      },
      notes: {
        ...record.new.notes,
        items: record.new.notes.items.map((a) => ({ ...a, createdAt: iso(a.createdAt) }))
      }
    },
    inbox: {
      total: inbox.total,
      top: inbox.order
        ? inbox.order.map((item) => ({
            kind: item.kind,
            id: item.id,
            risk: item.risk,
            at: item.at,
            item
          }))
        : record.inbox.top.map((row) => ({ ...row, item: null }))
    },
    questions: record.questions.map((q) => ({ ...q, createdAt: iso(q.createdAt) })),
    growth: record.growth,
    shape: record.shape,
    gardener: {
      count: record.gardener.count,
      top: record.gardener.top.map((change) => ({
        ...change,
        at: iso(change.at),
        undoneAt: change.undoneAt ? iso(change.undoneAt) : null
      }))
    }
  };
}
