// The relations-branch area of the IPC (F5 D19, D30): the note graph Map › Grafo draws for one branch
// of the topic tree or one source. The wave's wiring card (T171) spreads the channel into
// `ipcChannels`, adds `branch` to `DesktopApi.relations` and registers the handler; until then this
// is the area's own channel and typed surface, so the schemas, the handler and the bridge agree.
import { NoteRelationBandSchema } from "@app/domain";
import { z } from "zod";

export const relationsBranchChannels = {
  branch: "app:relations:branch"
} as const;

/** The bounds of a request (D19) and the defaults a request leaves out. */
export const relationsBranchLimits = {
  colourDepthDefault: 1,
  noteMax: 400,
  perTopicMax: 80,
  relationMax: 2000,
  /** Colours of `--graph-topic-1..12`: a topic's `colourIndex` i is drawn with token i + 1. */
  colourCount: 12
} as const;

const uuid = z.string().uuid();
const count = z.number().int().min(0);

export const RelationsBranchScopeSchema = z.union([
  z.object({ topicId: uuid }).strict(),
  z.object({ sourceId: uuid }).strict()
]);

/**
 * `relations.branch`: a topic (with its subtopics) or a source; the depth below the scope whose
 * topics give the colours (for a source, below the tree root); and the limits, each at most its
 * bound and that bound by default.
 */
export const RelationsBranchInputSchema = z
  .object({
    scope: RelationsBranchScopeSchema,
    colourDepth: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .default(relationsBranchLimits.colourDepthDefault),
    noteLimit: z
      .number()
      .int()
      .min(1)
      .max(relationsBranchLimits.noteMax)
      .default(relationsBranchLimits.noteMax),
    perTopicLimit: z
      .number()
      .int()
      .min(1)
      .max(relationsBranchLimits.perTopicMax)
      .default(relationsBranchLimits.perTopicMax),
    relationLimit: z
      .number()
      .int()
      .min(1)
      .max(relationsBranchLimits.relationMax)
      .default(relationsBranchLimits.relationMax)
  })
  .strict();
export type RelationsBranchInput = z.input<typeof RelationsBranchInputSchema>;
export type RelationsBranchRequest = z.output<typeof RelationsBranchInputSchema>;

/**
 * The six stances every relation view draws (glyph, colour and legend order of
 * `renderer/lib/relation-stance.ts`): a stored type reads as one of them, an unknown one as related.
 */
export const relationBranchStances = [
  "supports",
  "contradicts",
  "extends",
  "depends_on",
  "example_of",
  "related"
] as const;
export const RelationBranchStanceSchema = z.enum(relationBranchStances);
export type RelationBranchStance = z.infer<typeof RelationBranchStanceSchema>;

const typeStances: Readonly<Record<string, RelationBranchStance>> = {
  supports: "supports",
  contrasts: "contradicts",
  contradicts: "contradicts",
  extends: "extends",
  depends_on: "depends_on",
  example_of: "example_of"
};

/** The stance a stored relation type is drawn with. */
export function relationBranchStance(type: string): RelationBranchStance {
  return Object.hasOwn(typeStances, type) ? typeStances[type]! : "related";
}

export const RelationsBranchResultSchema = z
  .object({
    /** A topic scope lists the scope topic first; then by depth, title and ID. */
    topics: z.array(
      z
        .object({
          id: uuid,
          /** "" for an unnamed topic: the interface localizes the label. */
          title: z.string(),
          colourIndex: z
            .number()
            .int()
            .min(0)
            .max(relationsBranchLimits.colourCount - 1),
          parentId: uuid.nullable(),
          /** The scope's notes placed in this topic itself, not in its subtopics. */
          noteCount: count
        })
        .strict()
    ),
    /** Ranked by degree inside the scope, then recency. */
    nodes: z
      .array(
        z
          .object({
            id: uuid,
            title: z.string(),
            /**
             * Null in a source scope for a note the topic tree has not placed yet or that waits in
             * Unsorted (on the root); otherwise one of `topics`.
             */
            topicId: uuid.nullable(),
            degree: count
          })
          .strict()
      )
      .max(relationsBranchLimits.noteMax),
    /** Shown relations among the nodes, strongest first; `a` and `b` as stored (lower ID first). */
    edges: z
      .array(
        z
          .object({
            id: uuid,
            a: uuid,
            b: uuid,
            type: z.string().min(1),
            stance: RelationBranchStanceSchema,
            band: NoteRelationBandSchema.nullable()
          })
          .strict()
      )
      .max(relationsBranchLimits.relationMax),
    /**
     * Shown relations from a drawn note to a note outside the scope, per that note's topic, the
     * most first; never a topic of `topics`, the root (Unsorted) or an unplaced note.
     */
    outside: z.array(z.object({ topicId: uuid, title: z.string(), edgeCount: count }).strict()),
    /** Shown relations between two colour groups of the scope (`a` < `b`), the heaviest first. */
    superEdges: z.array(z.object({ a: uuid, b: uuid, weight: count }).strict()),
    /** A note of the scope or a relation among the nodes was left out by a limit. */
    truncated: z.boolean()
  })
  .strict();
export type RelationsBranchResult = z.infer<typeof RelationsBranchResultSchema>;

/** Null when the topic has no live successor or the source does not exist. */
export const RelationsBranchAnswerSchema = RelationsBranchResultSchema.nullable();

/** `window.app.relations.branch` as this area defines it (T171 adds it to `DesktopApi.relations`). */
export interface RelationsBranchApi {
  branch: (input: RelationsBranchInput) => Promise<RelationsBranchResult | null>;
}
