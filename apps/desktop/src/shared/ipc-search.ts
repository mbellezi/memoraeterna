// The search area of the IPC (F5 D12, D30): `search.omni`, the one retriever every search surface
// reads (Cmd-K in quick mode, the search results panel in full mode). The wave's wiring card (T171)
// spreads the channel into `ipcChannels` and the API into `DesktopApi.search`; until then these are
// the area's own channels and typed surface, so the schemas, the main handler and the preload bridge
// agree on one source.
import { ObjectKindSchema, OmniArmNameSchema, objectKinds } from "@app/domain";
import { z } from "zod";

export const searchIpcChannels = {
  searchOmni: "app:search:omni"
} as const;

/** The bounds of a request: the query's length after trimming and the number of results. */
export const searchOmniLimits = { queryMax: 200, limitMax: 50, limitDefault: 20 } as const;

/**
 * `search.omni`: the query (1-200 characters), the mode (`quick`: titles, names and full text in
 * one statement; `full`: also passages and vectors), optionally only some kinds (Cmd-K's `#` asks
 * for topics, `@` for entities) or one topic's subtree, and the caller's `requestId`, which the
 * answer carries back so a renderer can drop answers to requests it no longer waits for.
 */
export const SearchOmniInputSchema = z
  .object({
    query: z.string().trim().min(1).max(searchOmniLimits.queryMax),
    mode: z.enum(["quick", "full"]),
    kinds: z
      .array(ObjectKindSchema)
      .min(1)
      .max(objectKinds.length)
      .refine((kinds) => new Set(kinds).size === kinds.length, "Each kind once.")
      .optional(),
    scope: z.object({ topicId: z.string().uuid() }).strict().optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(searchOmniLimits.limitMax)
      .default(searchOmniLimits.limitDefault),
    requestId: z.string().min(1).max(100)
  })
  .strict();
export type SearchOmniInput = z.input<typeof SearchOmniInputSchema>;

/** One result: the object (a passage is its source's address with a `passage` anchor). */
export const SearchOmniItemSchema = z
  .object({
    address: z.string().startsWith("memora://"),
    kind: ObjectKindSchema,
    title: z.string(),
    snippet: z.string().optional(),
    arms: z
      .array(z.object({ arm: OmniArmNameSchema, rank: z.number().int().positive() }).strict())
      .min(1),
    score: z.number().positive()
  })
  .strict();
export type SearchOmniItem = z.infer<typeof SearchOmniItemSchema>;

/**
 * The fused results, best first. `degraded` names the arms that could not run: `ann` in full mode
 * with no embedding model, `fts` when the query has no word for full-text search.
 */
export const SearchOmniResultSchema = z
  .object({
    requestId: z.string(),
    items: z.array(SearchOmniItemSchema),
    degraded: z.array(z.enum(["ann", "fts"])),
    tookMs: z.number().int().nonnegative()
  })
  .strict();
export type SearchOmniResult = z.infer<typeof SearchOmniResultSchema>;

/** `window.app.search` as this area defines it (T171 joins it to the legacy `query`). */
export interface SearchApi {
  omni: (input: SearchOmniInput) => Promise<SearchOmniResult>;
}
