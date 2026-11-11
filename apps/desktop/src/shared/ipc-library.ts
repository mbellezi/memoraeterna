// The library area of the IPC (F5 T131, D30): the Library table's rows and the generation strip's
// data. The wave's wiring card (T171) merges the channels into `ipcChannels`, the API into
// `DesktopApi`, the preload and `registerIpcHandlers`; until then these are the area's own channels
// and its own typed surface, so the schemas, the main handlers and the preload bridge agree on one
// source. The vocabularies mirror `@app/db`'s `libraryRowsRepository.ts`, and a test in
// `library-ipc.test.ts` keeps them equal (this file runs in the renderer, which never bundles the
// database package).
import { z } from "zod";

/** The channels of the area, `app:library:*`; T171 spreads them into `ipcChannels`. */
export const libraryChannels = {
  rows: "app:library:rows",
  sourceProgress: "app:library:source-progress"
} as const;
export type LibraryChannel = (typeof libraryChannels)[keyof typeof libraryChannels];

/** The columns `library.rows` sorts by (the table's headers). */
export const librarySorts = ["title", "added", "updated", "notes", "status"] as const;
export const LibrarySortSchema = z.enum(librarySorts);
export type LibrarySort = z.infer<typeof LibrarySortSchema>;

/**
 * What a source is doing for the person: `needsYou` (work waits for a person, with a reason),
 * `processing`, `failed`, `storedOnly` (stored and searchable, no note) and `ready`.
 */
export const libraryRowStatuses = [
  "processing",
  "ready",
  "failed",
  "needsYou",
  "storedOnly"
] as const;
export const LibraryRowStatusSchema = z.enum(libraryRowStatuses);
export type LibraryRowStatus = z.infer<typeof LibraryRowStatusSchema>;

/** The source types a filter may name (`source_item_type`). */
export const librarySourceTypes = [
  "PersonalNote",
  "DailyNote",
  "WebArticle",
  "Book",
  "BookChapter",
  "PeriodicalIssue",
  "AcademicPaper",
  "DocumentSection",
  "StandaloneArticle",
  "Video",
  "GenericDocument"
] as const;

export const libraryRowsLimit = { default: 50, max: 100 } as const;
const textLimit = 200;
const cursorLimit = 600;

export const LibraryRowsInputSchema = z
  .object({
    sort: LibrarySortSchema.optional(),
    /** The default depends on the sort: title and status ascending, the others descending. */
    dir: z.enum(["asc", "desc"]).optional(),
    filter: z
      .object({
        kinds: z.array(z.enum(librarySourceTypes)).min(1).max(librarySourceTypes.length).optional(),
        status: LibraryRowStatusSchema.optional(),
        /** A root topic: the sources placed in it or below it. */
        topicId: z.string().uuid().optional(),
        query: z.string().trim().min(1).max(textLimit).optional()
      })
      .strict()
      .optional(),
    cursor: z.string().min(1).max(cursorLimit).optional(),
    limit: z.number().int().min(1).max(libraryRowsLimit.max).optional(),
    /** Also count the territories and the statuses (ask on a filter change, not on every page). */
    facets: z.boolean().optional()
  })
  .strict();
export type LibraryRowsInput = z.infer<typeof LibraryRowsInputSchema>;

const PathSegmentSchema = z.object({ id: z.string().uuid(), title: z.string().max(400) }).strict();

export const LibraryRowSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    type: z.enum(librarySourceTypes),
    authors: z.array(z.string()).max(5),
    addedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    status: LibraryRowStatusSchema,
    /** Only for `needsYou`: the blocker key that holds the work (for example `no_model.no_route`). */
    reason: z.string().min(1).max(100).nullable(),
    /** Current notes of the source and of its parts. */
    noteCount: z.number().int().min(0),
    /**
     * The topics below the tree root, root-most first. Tentative: the topic where most of a source's
     * notes are placed, while the source itself is not placed yet.
     */
    place: z
      .object({ path: z.array(PathSegmentSchema).min(1).max(12), tentative: z.boolean() })
      .strict()
      .nullable(),
    hasCover: z.boolean()
  })
  .strict();
export type LibraryRow = z.infer<typeof LibraryRowSchema>;

export const LibraryRowsResultSchema = z
  .object({
    rows: z.array(LibraryRowSchema).max(libraryRowsLimit.max),
    /** Present while there are more rows; pass it back with the same sort, direction and filter. */
    next: z.string().min(1).max(cursorLimit).optional(),
    /** Sources matching the filter, whatever the page. */
    total: z.number().int().min(0),
    facets: z
      .object({
        /** Per root topic (title order) then the sources with no place (`topic: null`, last). */
        territories: z.array(
          z.object({ topic: PathSegmentSchema.nullable(), count: z.number().int().min(1) }).strict()
        ),
        statuses: z.object({
          processing: z.number().int().min(0),
          ready: z.number().int().min(0),
          failed: z.number().int().min(0),
          needsYou: z.number().int().min(0),
          storedOnly: z.number().int().min(0)
        })
      })
      .strict()
      .optional()
  })
  .strict();
export type LibraryRowsResult = z.infer<typeof LibraryRowsResultSchema>;

export const LibrarySourceProgressInputSchema = z.object({ sourceId: z.string().uuid() }).strict();
export type LibrarySourceProgressInput = z.infer<typeof LibrarySourceProgressInputSchema>;

export const stepStates = ["pending", "running", "done", "failed", "notApplicable"] as const;
const StepStateSchema = z.enum(stepStates);

/**
 * The generation strip's values (design record 6.2): the run, the six steps and the section ruler.
 * Re-read on `job.progress` and `object.changed`, never on a timer. `null` when the source does
 * not exist.
 */
export const LibrarySourceProgressSchema = z
  .object({
    run: z
      .object({
        status: z.enum(["pending", "running", "succeeded", "failed", "canceled"]),
        stage: z.string(),
        startedAt: z.string().datetime().nullable(),
        completedAt: z.string().datetime().nullable(),
        /** The stage that failed, when one did. */
        failedStage: z.string().nullable()
      })
      .strict()
      .nullable(),
    /** The blocker key when the work waits for a person; the strip says what to do. */
    needsYou: z.string().min(1).max(100).nullable(),
    /** The person paused the work (the strip says "Pausada por você" and offers to resume it). */
    paused: z.boolean(),
    steps: z
      .object({
        read: z
          .object({ state: StepStateSchema, pages: z.number().int().min(1).nullable() })
          .strict(),
        chunks: z.object({ state: StepStateSchema, indexed: z.number().int().min(0) }).strict(),
        notes: z
          .object({
            state: StepStateSchema,
            soFar: z.number().int().min(0),
            /** About how many notes there will be; null while unknown. */
            estimate: z.number().int().min(1).nullable()
          })
          .strict(),
        placed: z.object({ state: StepStateSchema, count: z.number().int().min(0) }).strict(),
        summary: z.object({ state: StepStateSchema }).strict(),
        relations: z.object({ state: StepStateSchema, count: z.number().int().min(0) }).strict()
      })
      .strict(),
    /** One segment per section, at most 40, shares adding up to 1. */
    sections: z
      .array(
        z
          .object({
            title: z.string(),
            share: z.number().min(0).max(1),
            notes: z.number().int().min(0),
            state: z.enum(["done", "reading", "pending"])
          })
          .strict()
      )
      .max(40)
  })
  .strict()
  .nullable();
export type LibrarySourceProgress = z.infer<typeof LibrarySourceProgressSchema>;

/** `window.app.library` as this area defines it. */
export interface LibraryApi {
  /** One keyset page of the library's root sources. */
  rows: (input: LibraryRowsInput) => Promise<LibraryRowsResult>;
  /** The generation strip's data for one source. */
  sourceProgress: (input: LibrarySourceProgressInput) => Promise<LibrarySourceProgress>;
}
