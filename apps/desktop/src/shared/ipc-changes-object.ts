// The change-sets of one object (F5 T173, D30, D31): the context panel's History tab. It is the one
// read `changes.forObject`, an addition to the F4 `changes.*` area: the F4 read model filters change-sets
// by kind, status and risk but not by the object they touched, so the object's own question is
// answered by one repository query over the events of the three stores. The area has its own channel
// and typed surface; `S/ipc.ts` spreads the channel and `DesktopApi.changes` takes the member.
import { ChangeSetSummarySchema, changeSetReadLimits, ObjectKindSchema } from "@app/domain";
import { z } from "zod";

/** The channels of the area. */
export const changesObjectChannels = {
  forObject: "app:changes:for-object"
} as const;

/** What `changes.forObject` returns at most: the History tab lists the last twenty. */
export const changesForObjectLimits = { max: changeSetReadLimits.objectMax } as const;

/**
 * `changes.forObject`: the change-sets that touched one object, newest first. A topic is touched by
 * the tree's structure events and by its overview writes; a note or a source by the placement
 * events of its item and by the relation passes that changed one of its relations. An entity or a
 * question is touched by no change-set, and answers an empty list.
 */
export const ChangesForObjectInputSchema = z
  .object({
    kind: ObjectKindSchema,
    id: z.string().uuid(),
    limit: z.number().int().min(1).max(changesForObjectLimits.max).optional()
  })
  .strict();
export type ChangesForObjectInput = z.input<typeof ChangesForObjectInputSchema>;

export const ChangesForObjectSchema = z
  .object({
    items: z.array(ChangeSetSummarySchema).max(changesForObjectLimits.max)
  })
  .strict();
export type ChangesForObject = z.infer<typeof ChangesForObjectSchema>;

/** The member `window.app.changes.forObject` as this area defines it. */
export interface ChangesObjectApi {
  /** The change-sets that touched one object, newest first, at most twenty; read only. */
  forObject: (input: ChangesForObjectInput) => Promise<ChangesForObject>;
}
