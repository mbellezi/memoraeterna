import { z } from "zod";

import {
  ChangeSetBlockerSchema,
  ChangeSetRiskSchema,
  ChangeSetSummarySchema
} from "./change-sets.js";
import { TopicMessageParamsSchema } from "./topics.js";

/**
 * The Inbox (F4 D29, spec 3.10): the one place for human judgment. A read model over the stores,
 * with no label store of its own: every verdict is written by the store's existing writer
 * (`changes.review` and `changes.undo`, `relations.review`, the quarantine's retry, a finding's
 * dismissal, the MATCH backlog's acceptance, the budget's continue) and persists there, as the
 * calibration label F6 reads. Items carry stored values and parameters, never copy and never raw
 * IDs as text: the interface words each kind from message keys, and names an object by its title.
 * Browser-safe: the database, main, the IPC, the preload and the renderer share this module.
 */

const uuid = z.string().uuid();
const isoTimestamp = z.string().datetime({ offset: true });
const count = z.number().int().min(0);
const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** The kinds of D29, in the order the Inbox lists them (the `inbox.changed` event uses the same). */
export const inboxKinds = [
  "review",
  "quarantined",
  "contradiction",
  "withdrawn",
  "duplicate",
  "obsidian_conflict",
  "budget",
  "backlog"
] as const;
export const InboxKindSchema = z.enum(inboxKinds);
export type InboxKind = z.infer<typeof InboxKindSchema>;

/** Bounds of the `inbox.*` contracts. */
export const inboxReadLimits = {
  pageDefault: 50,
  pageMax: 50,
  cursorMax: 400,
  idMax: 300,
  objectsMax: 8,
  titleMax: 300,
  variantMax: 40,
  /** Obsidian conflicts one read lists at most (each store lists its newest hundred). */
  obsidianMax: 200
} as const;

/** The verbs an item offers (`a` apply or keep, `x` dismiss or remove, `r` retry). */
export const inboxVerbs = ["apply", "dismiss", "retry"] as const;
export const InboxVerbSchema = z.enum(inboxVerbs);
export type InboxVerb = z.infer<typeof InboxVerbSchema>;

/** The verbs `inbox.act` takes: the offered ones, and `undo` of the last one a session made. */
export const inboxActions = [...inboxVerbs, "undo"] as const;
export const InboxActionSchema = z.enum(inboxActions);
export type InboxAction = z.infer<typeof InboxActionSchema>;

/**
 * What tells apart the sentence of an item of one kind: the store of a change-set, the task of a
 * quarantined job, who withdrew a relation, how two notes were found to be duplicates, and so on.
 * The interface maps each one to a fixed message key; an unknown one reads as the kind's plain
 * sentence.
 */
export const inboxVariants = {
  review: ["topic", "relation", "overview"],
  quarantined: ["place", "rebalance", "audit", "match", "refresh", "derived", "other"],
  /** A suggested `contradicts` relation, or the Divergences an automatic overview patch kept (D17). */
  contradiction: ["relation", "divergence"],
  withdrawn: ["explainer", "typer", "unknown"],
  duplicate: ["vector", "title", "both"],
  obsidian_conflict: ["editorial", "deleted", "projection"],
  budget: ["money_80", "money_100"],
  backlog: ["match", "other"]
} as const satisfies Record<InboxKind, readonly string[]>;

/** An object an item names, with the title to show (null: unnamed, or gone since). */
export const inboxObjectKinds = ["note", "source", "topic"] as const;
export const InboxObjectSchema = z
  .object({
    kind: z.enum(inboxObjectKinds),
    id: uuid,
    title: z.string().max(inboxReadLimits.titleMax).nullable()
  })
  .strict();
export type InboxObject = z.infer<typeof InboxObjectSchema>;

/**
 * One open item. `id` is opaque and unique within its kind (a change-set is `<store>:<uuid>`, a
 * quarantined subject `<task kind>|<subject>`, a relation or a finding its own UUID). `params` are
 * the scalars its sentence needs (counts, an error class, a path, amounts). `changeSet` is set for
 * `review`: its summary, and `changes.diff` gives the before and after the detail shows.
 */
export const InboxItemSchema = z
  .object({
    kind: InboxKindSchema,
    id: z.string().min(1).max(inboxReadLimits.idMax),
    risk: ChangeSetRiskSchema,
    variant: z.string().min(1).max(inboxReadLimits.variantMax),
    at: isoTimestamp,
    params: TopicMessageParamsSchema,
    objects: z.array(InboxObjectSchema).max(inboxReadLimits.objectsMax),
    changeSet: ChangeSetSummarySchema.nullable(),
    actions: z.array(InboxVerbSchema).max(inboxVerbs.length)
  })
  .strict();
export type InboxItem = z.infer<typeof InboxItemSchema>;

/** The key a list uses for an item (a kind's IDs are unique within it only). */
export const inboxItemKey = (item: Pick<InboxItem, "kind" | "id">): string =>
  `${item.kind}:${item.id}`;

// ---------------------------------------------------------------------------
// inbox.list and inbox.counts

/** By risk (high first), then by age (oldest first); `cursor` continues a page. */
export const InboxListInputSchema = z
  .object({
    kinds: z.array(InboxKindSchema).min(1).max(inboxKinds.length).optional(),
    risk: ChangeSetRiskSchema.optional(),
    cursor: z.string().min(1).max(inboxReadLimits.cursorMax).optional(),
    limit: int(1, inboxReadLimits.pageMax).default(inboxReadLimits.pageDefault)
  })
  .strict();
export type InboxListInput = z.input<typeof InboxListInputSchema>;

export const InboxListSchema = z
  .object({
    items: z.array(InboxItemSchema).max(inboxReadLimits.pageMax),
    nextCursor: z.string().min(1).max(inboxReadLimits.cursorMax).nullable()
  })
  .strict();
export type InboxList = z.infer<typeof InboxListSchema>;

/** The open items by kind and by risk: every key is present, a missing count is a zero. */
export const InboxCountsSchema = z
  .object({
    total: count,
    byKind: z.record(InboxKindSchema, count),
    byRisk: z.record(ChangeSetRiskSchema, count)
  })
  .strict();
export type InboxCounts = z.infer<typeof InboxCountsSchema>;

export const emptyInboxCounts = (): InboxCounts => ({
  total: 0,
  byKind: Object.fromEntries(inboxKinds.map((kind) => [kind, 0])) as InboxCounts["byKind"],
  byRisk: { low: 0, medium: 0, high: 0 }
});

// ---------------------------------------------------------------------------
// inbox.act

export const InboxActInputSchema = z
  .object({
    kind: InboxKindSchema,
    id: z.string().min(1).max(inboxReadLimits.idMax),
    action: InboxActionSchema
  })
  .strict();
export type InboxActInput = z.infer<typeof InboxActInputSchema>;

/**
 * What came of a verb. `done`: the writer wrote it; `undoable` says whether `undo` can take it
 * back, `queued` counts the notes an accepted MATCH backlog queued. `blocked`: the writer named
 * what stands in the way. `stale`: the item changed since it was listed (read it again).
 * `waiting`: it cannot run now (no decider, no budget to continue); the item stays. `gone`: the
 * item is not open any more. `unsupported`: the kind offers no such verb.
 */
export const InboxActResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done"), undoable: z.boolean(), queued: count.optional() }).strict(),
  z
    .object({
      status: z.literal("blocked"),
      blockers: z.array(ChangeSetBlockerSchema).min(1).max(20),
      more: count
    })
    .strict(),
  z.object({ status: z.literal("stale") }).strict(),
  z.object({ status: z.literal("waiting") }).strict(),
  z.object({ status: z.literal("gone") }).strict(),
  z.object({ status: z.literal("unsupported") }).strict()
]);
export type InboxActResult = z.infer<typeof InboxActResultSchema>;

/** The message keys of the failures the Inbox handlers report (`new Error(key)`). */
export const inboxErrorKeys = [
  "inbox.errors.invalidCursor",
  "inbox.errors.invalidItem",
  /** No database, or the store's writer is not installed. */
  "inbox.errors.unavailable"
] as const;
export const InboxErrorKeySchema = z.enum(inboxErrorKeys);
export type InboxErrorKey = z.infer<typeof InboxErrorKeySchema>;

// ---------------------------------------------------------------------------
// Order

const riskRanks = { high: 0, medium: 1, low: 2 } as const;

/** 0 for high, 1 for medium, 2 for low: the order the Inbox lists by. */
export const inboxRiskRank = (risk: z.infer<typeof ChangeSetRiskSchema>): number => riskRanks[risk];

/**
 * The place of an item in the list: risk (high first), age (oldest first), then its key, all in
 * code-unit order so the database and the process agree. `cursor` is its text form.
 */
export interface InboxPosition {
  rank: number;
  /** An ISO UTC time with microseconds, as the database writes it (`…SS.UUUUUUZ`). */
  at: string;
  key: string;
}

const positionPattern = /^([0-2])\|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|(.+)$/u;

export function inboxCursor(position: InboxPosition): string {
  return `${position.rank}|${position.at}|${position.key}`;
}

/** The position a cursor stands for; null when it is not one. */
export function parseInboxCursor(cursor: string): InboxPosition | null {
  const match = positionPattern.exec(cursor);
  if (!match) return null;
  const at = match[2] as string;
  if (Number.isNaN(Date.parse(at))) return null;
  return { rank: Number(match[1]), at, key: match[3] as string };
}

export function compareInboxPositions(a: InboxPosition, b: InboxPosition): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return a.key === b.key ? 0 : a.key < b.key ? -1 : 1;
}

/** An ISO time with microseconds from a date (the database keeps them; a date cannot). */
export function inboxTime(date: Date): string {
  return `${date.toISOString().slice(0, 23)}000Z`;
}
