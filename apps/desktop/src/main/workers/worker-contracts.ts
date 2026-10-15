import { z } from "zod";

export const workerTaskSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum([
      "ingestion",
      "markdown-conversion",
      "chunking",
      "embedding",
      "atomic-note-generation",
      "obsidian-sync",
      "asset-storage",
      "topic-clustering"
    ]),
    payload: z.record(z.string(), z.unknown())
  })
  .strict();

export const workerMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("progress"), progress: z.number().min(0).max(1) }).strict(),
  z.object({ kind: z.literal("result"), result: z.record(z.string(), z.unknown()) }).strict(),
  z
    .object({
      kind: z.literal("error"),
      error: z.string().min(1),
      /** System or database error code of the failure (EBUSY, a SQLSTATE), which decides whether a job retries. */
      code: z.string().min(1).max(64).optional()
    })
    .strict()
]);

export type WorkerTask = z.infer<typeof workerTaskSchema>;
export type WorkerMessage = z.infer<typeof workerMessageSchema>;

/** The message a worker posts for a failure: its text and, when it has one, its error code. */
export function workerErrorMessage(error: unknown): Extract<WorkerMessage, { kind: "error" }> {
  let code: string | undefined;
  for (let current = error, depth = 0; current instanceof Error && depth < 3; depth++) {
    const candidate = (current as Error & { code?: unknown }).code;
    if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 64) {
      code = candidate;
      break;
    }
    current = current.cause;
  }
  return {
    kind: "error",
    error: (error instanceof Error && error.message) || "worker_failed",
    ...(code ? { code } : {})
  };
}

/** The error the supervisor rejects with for a worker's failure message, keeping its error code. */
export function workerFailure(message: { error: string; code?: string | undefined }): Error {
  return Object.assign(new Error(message.error), message.code ? { code: message.code } : {});
}
