import { z } from "zod";

import {
  IsoDateTimeSchema,
  Sha256Schema,
  StableIdSchema
} from "./primitives.js";

export const ObsidianSyncStatusSchema = z.enum([
  "pending",
  "synced",
  "dirty",
  "conflicted",
  "deleted",
  "error",
  "paused"
]);

export type ObsidianSyncStatus = z.infer<typeof ObsidianSyncStatusSchema>;

export const ObsidianSyncEntityTypeSchema = z.enum([
  "source_item",
  "document",
  "atomic_note",
  "source_summary"
]);

export type ObsidianSyncEntityType = z.infer<
  typeof ObsidianSyncEntityTypeSchema
>;

export const ObsidianSyncFileSchema = z
  .object({
    id: StableIdSchema,
    memoraId: StableIdSchema,
    entityType: ObsidianSyncEntityTypeSchema,
    entityId: StableIdSchema,
    sourceItemId: StableIdSchema.optional(),
    documentId: StableIdSchema.optional(),
    vaultRelativePath: z.string().min(1),
    frontmatterHash: Sha256Schema,
    contentHash: Sha256Schema,
    fileMtime: IsoDateTimeSchema,
    syncVersion: z.number().int().nonnegative(),
    syncStatus: ObsidianSyncStatusSchema,
    lastSeenAt: IsoDateTimeSchema.optional(),
    deletedAt: IsoDateTimeSchema.optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema
  })
  .strict();

export type ObsidianSyncFile = z.infer<typeof ObsidianSyncFileSchema>;
