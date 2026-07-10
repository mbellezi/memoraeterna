import { z } from "zod";

export const workerTaskSchema = z.object({
  id: z.string().uuid(),
  type: z.enum([
    "ingestion", "markdown-conversion", "chunking", "embedding",
    "atomic-note-generation", "obsidian-sync", "asset-storage"
  ]),
  payload: z.record(z.string(), z.unknown())
}).strict();

export const workerMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("progress"), progress: z.number().min(0).max(1) }).strict(),
  z.object({ kind: z.literal("result"), result: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ kind: z.literal("error"), error: z.string().min(1) }).strict()
]);

export type WorkerTask = z.infer<typeof workerTaskSchema>;
export type WorkerMessage = z.infer<typeof workerMessageSchema>;
