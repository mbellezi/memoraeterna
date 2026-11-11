// The home area of the IPC (F5 D9, D30; design record 7.1): what the renderer may ask of the main
// process to fill Home. It is one read, `home.digest`, and it writes nothing: "new" is computed
// since the `since` the renderer passes (its `lastHomeOpenAt`), the main process keeps no record of
// visits. The area is wired into `DesktopApi`, the preload and `registerIpcHandlers` by the wave's
// wiring card (T171); until then these are its own channels and its own typed surface, so the
// schemas, the main handler and the preload bridge agree on one source.
import {
  AskScopeSchema,
  ChangeSetRiskSchema,
  ChangeSetSummarySchema,
  InboxItemSchema,
  InboxKindSchema,
  ObjectKindSchema,
  ObjectResolvedSchema,
  AskQuestionStatusSchema,
  questionTextMaxLength
} from "@app/domain";
import { z } from "zod";

/** The channels of the area, `app:home:*`; T171 spreads them into `ipcChannels`. */
export const homeChannels = {
  digest: "app:home:digest"
} as const;
export type HomeChannel = (typeof homeChannels)[keyof typeof homeChannels];

/** What each part of the digest holds at most (the repository's bounds, restated for the schema). */
export const homeDigestBounds = {
  continue: 6,
  arrivals: 10,
  inbox: 3,
  questions: 3,
  growth: 5,
  gardener: 3,
  shapeRoots: 24
} as const;

const count = z.number().int().min(0);
const isoTimestamp = z.string().datetime({ offset: true });

/**
 * `home.digest`: `since` is when Home was last opened (ISO 8601), from the renderer's
 * `lastHomeOpenAt`. Null or absent when it never was: the digest then looks back seven days.
 */
export const HomeDigestInputSchema = z
  .object({ since: isoTimestamp.nullable().optional() })
  .strict();
export type HomeDigestInput = z.input<typeof HomeDigestInputSchema>;

/** One object of the Retomar trail, with the summary of its address (null once it is gone). */
export const HomeContinueEntrySchema = z
  .object({
    address: z.string().min(1),
    kind: ObjectKindSchema,
    title: z.string(),
    parentAddress: z.string().nullable(),
    openedAt: isoTimestamp,
    summary: ObjectResolvedSchema.nullable()
  })
  .strict();
export type HomeContinueEntry = z.infer<typeof HomeContinueEntrySchema>;

/** A source or a note that arrived, resolved with the topics above it. */
export const HomeArrivalSchema = z
  .object({ createdAt: isoTimestamp, object: ObjectResolvedSchema })
  .strict();
export type HomeArrival = z.infer<typeof HomeArrivalSchema>;

export const HomeArrivalsSchema = z
  .object({
    /** Root sources created after `since`; chapters are not arrivals of their own. */
    sources: z
      .object({ total: count, items: z.array(HomeArrivalSchema).max(homeDigestBounds.arrivals) })
      .strict(),
    /** Current notes created after `since`; `placed` have a primary place in the tree. */
    notes: z
      .object({
        total: count,
        placed: count,
        unplaced: count,
        items: z.array(HomeArrivalSchema).max(homeDigestBounds.arrivals)
      })
      .strict()
  })
  .strict();
export type HomeArrivals = z.infer<typeof HomeArrivalsSchema>;

/**
 * One of the Inbox's first rows by risk. `item` is the Inbox's own item (its sentence parameters,
 * the objects it names and its change-set) when the Inbox service is installed; null otherwise.
 */
export const HomeInboxRowSchema = z
  .object({
    kind: InboxKindSchema,
    id: z.string().min(1),
    risk: ChangeSetRiskSchema,
    at: isoTimestamp,
    item: InboxItemSchema.nullable()
  })
  .strict();
export type HomeInboxRow = z.infer<typeof HomeInboxRowSchema>;

export const HomeQuestionSchema = z
  .object({
    id: z.string().uuid(),
    text: z.string().min(1).max(questionTextMaxLength),
    scope: AskScopeSchema,
    status: AskQuestionStatusSchema,
    createdAt: isoTimestamp,
    answerCount: count
  })
  .strict();
export type HomeQuestion = z.infer<typeof HomeQuestionSchema>;

export const HomeGrowthTopicSchema = z
  .object({ id: z.string().uuid(), title: z.string().nullable(), arrivals: count })
  .strict();
export type HomeGrowthTopic = z.infer<typeof HomeGrowthTopicSchema>;

export const HomeShapeRootSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().nullable(),
    notes: count,
    topics: count,
    health: z.enum(["good", "attention", "violation"])
  })
  .strict();
export type HomeShapeRoot = z.infer<typeof HomeShapeRootSchema>;

export const HomeShapeSchema = z
  .object({
    hasTree: z.boolean(),
    notes: count,
    topics: count,
    depth: count,
    violations: z.object({ hard: count, soft: count }).strict(),
    outOfBounds: count,
    arrivalsThisWeek: count,
    roots: z.array(HomeShapeRootSchema).max(homeDigestBounds.shapeRoots)
  })
  .strict();
export type HomeShape = z.infer<typeof HomeShapeSchema>;

/** A change-set the Gardener applied or proposed since `since`: the `changes.*` summary itself. */
export const HomeGardenerChangeSchema = ChangeSetSummarySchema;
export type HomeGardenerChange = z.infer<typeof HomeGardenerChangeSchema>;

export const HomeDigestSchema = z
  .object({
    /** The `since` the digest used. */
    since: isoTimestamp,
    /** The library holds no source: Home is the first-run surface. */
    firstRun: z.boolean(),
    continue: z.array(HomeContinueEntrySchema).max(homeDigestBounds.continue),
    new: HomeArrivalsSchema,
    inbox: z
      .object({ total: count, top: z.array(HomeInboxRowSchema).max(homeDigestBounds.inbox) })
      .strict(),
    questions: z.array(HomeQuestionSchema).max(homeDigestBounds.questions),
    growth: z.array(HomeGrowthTopicSchema).max(homeDigestBounds.growth),
    shape: HomeShapeSchema,
    gardener: z
      .object({ count, top: z.array(HomeGardenerChangeSchema).max(homeDigestBounds.gardener) })
      .strict()
  })
  .strict();
export type HomeDigest = z.infer<typeof HomeDigestSchema>;

/** The message key of the one failure the handler reports (no database yet). */
export const homeErrorKeys = ["home.errors.unavailable"] as const;

/** `window.app.home` as this area defines it. */
export interface HomeApi {
  /** What Home shows, in one bounded read; nothing is written. */
  digest: (input?: HomeDigestInput) => Promise<HomeDigest>;
}
