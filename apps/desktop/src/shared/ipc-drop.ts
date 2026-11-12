// The drop area of the IPC (F5 D32, T150): what the renderer may ask of the main process about
// files dropped on the window. The renderer holds `File` objects and never a path: the preload
// resolves each path with `webUtils.getPathForFile` and invokes main directly; main validates it
// (a regular file, not a symlink, within the size cap, an accepted type) and answers with an
// opaque, expiring `fileToken` that `ingestion.importFile` takes, the same token a dialog choice
// yields (`rules/security-privacy.md`, external input and filesystem).
import { SourceDescriptorDraftSchema } from "@app/domain";
import { z } from "zod";

/** The channel of the area. */
export const dropChannels = {
  prepare: "app:ingestion:prepare-dropped"
} as const;

/** Files one call prepares at most; the window's drop hands them over one at a time. */
export const droppedFilesMax = 20;

/** What a prepared file is, for the words of the drop card and the Add flow (never a path). */
export const droppedKinds = [
  "pdf",
  "epub",
  "markdown",
  "text",
  "web",
  "office",
  "data",
  "notebook"
] as const;
export type DroppedKind = (typeof droppedKinds)[number];

/** Why a dropped item was not taken. */
export const droppedRefusals = [
  "notAFile",
  "symlink",
  "empty",
  "tooLarge",
  "unsupported",
  "unreadable"
] as const;
export type DroppedRefusal = (typeof droppedRefusals)[number];

/** What the preload sends: the resolved paths, which only the preload and main ever see. */
export const PrepareDroppedInputSchema = z
  .object({ paths: z.array(z.string().min(1).max(4096)).min(1).max(droppedFilesMax) })
  .strict();
export type PrepareDroppedInput = z.infer<typeof PrepareDroppedInputSchema>;

export const DroppedFileSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      /** The expiring token `ingestion.importFile` takes. */
      fileToken: z.string().uuid(),
      name: z.string().min(1),
      size: z.number().int().nonnegative(),
      kind: z.enum(droppedKinds),
      mimeType: z.string().min(1),
      /** What the file says of itself (title, creators, language), as the picker's result carries. */
      draft: SourceDescriptorDraftSchema
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      name: z.string(),
      reason: z.enum(droppedRefusals)
    })
    .strict()
]);
export type DroppedFile = z.infer<typeof DroppedFileSchema>;
export const DroppedFilesSchema = z.array(DroppedFileSchema).max(droppedFilesMax);

/** What the renderer hands the bridge: the dropped items, of which only `name` is read here. */
export interface DroppedFileHandle {
  readonly name: string;
}

/** `window.app.ingestion.prepareDroppedFiles`: one result per file, in order. */
export type PrepareDroppedFiles = (files: readonly DroppedFileHandle[]) => Promise<DroppedFile[]>;
