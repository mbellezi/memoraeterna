import { z } from "zod";

import { IsoDateTimeSchema, StableIdSchema } from "./primitives.js";

export const ObsidianDeletePolicySchema = z.enum([
  "tombstone",
  "trash",
  "delete",
  "unlink"
]);

export type ObsidianDeletePolicy = z.infer<
  typeof ObsidianDeletePolicySchema
>;

export const StorageSettingsSchema = z
  .object({
    id: StableIdSchema,
    obsidianVaultPath: z.string().min(1).optional(),
    obsidianRootFolder: z.string().min(1),
    obsidianSyncEnabled: z.boolean(),
    obsidianDeletePolicy: ObsidianDeletePolicySchema,
    uploadedFilesPath: z.string().min(1).optional(),
    copyUploadedFilesEnabled: z.boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema
  })
  .strict()
  .superRefine((settings, context) => {
    if (settings.obsidianSyncEnabled && !settings.obsidianVaultPath) {
      context.addIssue({
        code: "custom",
        message: "obsidianVaultPath is required when Obsidian sync is enabled",
        path: ["obsidianVaultPath"]
      });
    }

    if (settings.copyUploadedFilesEnabled && !settings.uploadedFilesPath) {
      context.addIssue({
        code: "custom",
        message: "uploadedFilesPath is required when uploaded file copies are enabled",
        path: ["uploadedFilesPath"]
      });
    }
  });

export type StorageSettings = z.infer<typeof StorageSettingsSchema>;
