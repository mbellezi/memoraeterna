// The entities area of the IPC (F5 D30, T132): what the renderer may ask of the main process about
// an entity's page. The area is wired into `DesktopApi`, the preload and `registerIpcHandlers` by
// the wave's wiring card (T171); until then these are its own channels and its own typed surface,
// so the schemas, the main handler and the preload bridge agree on one source.
import { ObjectRefSchema, ObjectTopicRefSchema } from "@app/domain";
import { z } from "zod";

/** The channels of the area, `app:entities:*`; T171 spreads them into `ipcChannels`. */
export const entitiesChannels = {
  page: "app:entities:page"
} as const;
export type EntitiesChannel = (typeof entitiesChannels)[keyof typeof entitiesChannels];

/** Mentions one page holds (the repository's `entityMentionsPageLimit`). */
export const entityMentionsPageSize = 50;
/** Co-mentioned entities one first page lists (the repository's `entityCoMentionLimit`). */
export const entityCoMentionsMax = 10;

/**
 * `entities.page`: the entity, and the `next` of the previous page to read the mentions after it.
 * Without `cursor` the page also carries the topics and the co-mentioned entities.
 */
export const EntitiesPageInputSchema = z
  .object({ id: z.string().uuid(), cursor: z.string().min(1).max(1024).optional() })
  .strict();
export type EntitiesPageInput = z.infer<typeof EntitiesPageInputSchema>;

export const EntityMentionSchema = z
  .object({
    noteId: z.string().uuid(),
    title: z.string(),
    sourceId: z.string().uuid().nullable(),
    sourceTitle: z.string().nullable(),
    /** The live topic the note is primarily placed in; null when it is not placed. */
    topicId: z.string().uuid().nullable(),
    /** Empty when the topic is not named yet or the note is not placed: clients localize it. */
    topicTitle: z.string(),
    /** How many of the entity's current notes that topic holds; 0 when not placed. */
    topicNotes: z.number().int().nonnegative()
  })
  .strict();
export type EntityMention = z.infer<typeof EntityMentionSchema>;

export const EntityPageSchema = z
  .object({
    entity: z
      .object({
        id: z.string().uuid(),
        /** The stored kind (person, organism, place…); localized by the reader. */
        type: z.string(),
        canonicalName: z.string(),
        aliases: z.array(z.string()),
        description: z.string().nullable(),
        language: z.string().min(1).max(16)
      })
      .strict(),
    /** Current notes that mention the entity, and the distinct sources that own them. */
    counts: z
      .object({ notes: z.number().int().nonnegative(), sources: z.number().int().nonnegative() })
      .strict(),
    /** Grouped by topic, the densest topic first, then the notes not placed; titles inside. */
    mentions: z
      .object({
        items: z.array(EntityMentionSchema).max(entityMentionsPageSize),
        next: z.string().min(1).max(1024).optional()
      })
      .strict(),
    /** First page only (no cursor), as `objects.locate` places the entity. */
    topics: z
      .object({
        primary: z.array(ObjectRefSchema).max(16),
        alsoIn: z.array(ObjectTopicRefSchema).max(8),
        alsoInCount: z.number().int().nonnegative()
      })
      .strict()
      .optional(),
    /** First page only: the entities that share the most current notes with this one. */
    coMentioned: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            type: z.string(),
            canonicalName: z.string(),
            sharedNotes: z.number().int().positive()
          })
          .strict()
      )
      .max(entityCoMentionsMax)
      .optional()
  })
  .strict();
export type EntityPage = z.infer<typeof EntityPageSchema>;

/** `window.app.entities` as this area defines it. */
export interface EntitiesApi {
  /** One entity's page; null when it does not exist. */
  page: (input: EntitiesPageInput) => Promise<EntityPage | null>;
}
