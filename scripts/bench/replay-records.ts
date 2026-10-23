/**
 * The files a replay run leaves (F4 T69), under `<data root>/f4/bench/<run id>/`:
 *
 * - `manifest.json`: what was run (arm, model folder, helper, cassette, parameters, machine);
 * - `items.ndjson`: one line per replayed item, appended as each item ends, so a run that stops can
 *   resume and the report reads whatever is there;
 * - `summary.json`: the report's numbers, written when the run ends.
 *
 * The lines hold the writer's full answers, which are library text: they stay under `.cache/`.
 */
import { z } from "zod";

import { contractIds } from "./contracts/types.ts";

export const callRecordSchema = z
  .object({
    attempt: z.number().int().nonnegative(),
    operation: z.string(),
    isRepair: z.boolean(),
    inputChars: z.number().int().nonnegative(),
    parameters: z.record(z.string(), z.unknown()),
    output: z.string(),
    /** Why the call failed (a deadline, a helper error); null when it answered. */
    error: z.string().nullable(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    wallMs: z.number(),
    ttftMs: z.number().nullable(),
    prefillTps: z.number().nullable(),
    decodeTps: z.number().nullable(),
    /** What the runtime says it did (`grammar`, `strict`, `none`); null when it says nothing. */
    schemaMode: z.string().nullable(),
    /** Whether the request carried an output schema. */
    schemaOffered: z.boolean(),
    /** The MLX helper's grammar compile time for the call (F4 D24); null or absent without one. */
    grammarCompileMs: z.number().nullable().optional(),
    peakHelperRssMiB: z.number().nullable(),
    /** The helper's physical-footprint peak since it started (counts GPU buffers); null when unread. */
    peakHelperFootprintMiB: z.number().nullable(),
    peakSwapUsedMiB: z.number().nullable(),
    minMemoryLevel: z.number().nullable()
  })
  .strict();
export type CallRecord = z.infer<typeof callRecordSchema>;

export const itemRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    key: z.string(),
    contract: z.enum(contractIds),
    fidelity: z.enum(["product-flow", "product-pure"]),
    taskType: z.string(),
    operation: z.string(),
    language: z.string(),
    promptSource: z.enum(["recorded", "current"]),
    /** Today's prompt for the same inputs is not the recorded one. */
    promptDrift: z.boolean(),
    recorded: z
      .object({
        providerId: z.string(),
        modelId: z.string(),
        inputTokens: z.number().nullable(),
        outputTokens: z.number().nullable(),
        durationMs: z.number()
      })
      .strict(),
    /** The product's flow on the recorded answer alone: what the recording itself needed. */
    baseline: z
      .object({
        ok: z.boolean(),
        error: z.string().nullable(),
        repairCalls: z.number().int().nonnegative(),
        /** Items the product kept with no call, or fixed deterministically, in the recorded answer. */
        salvagedItems: z.number().int().nonnegative(),
        firstPassClean: z.boolean()
      })
      .strict(),
    calls: z.array(callRecordSchema),
    outcome: z
      .object({
        ok: z.boolean(),
        error: z.string().nullable(),
        salvagedItems: z.number().int().nonnegative()
      })
      .strict(),
    /** The first answer needed no repair and no salvage, and the flow ended well. */
    firstPassClean: z.boolean(),
    repairCalls: z.number().int().nonnegative(),
    yield: z.record(z.string(), z.number()).nullable(),
    startedAt: z.string(),
    wallMs: z.number()
  })
  .strict();
export type ItemRecord = z.infer<typeof itemRecordSchema>;

export const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    task: z.literal("T69"),
    runId: z.string(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    arm: z
      .object({
        id: z.string(),
        label: z.string(),
        runtime: z.enum(["mlx", "gguf"]),
        catalogId: z.string().nullable(),
        modelDir: z.string(),
        parameterSource: z.string()
      })
      .strict(),
    helper: z
      .object({
        path: z.string().nullable(),
        sha256: z.string().nullable(),
        capabilities: z.array(z.string())
      })
      .strict(),
    cassette: z.object({ directory: z.string(), items: z.number().int() }).strict(),
    selection: z
      .object({
        contracts: z.array(z.enum(contractIds)),
        limit: z.number().int().nullable(),
        promptSource: z.enum(["recorded", "current"])
      })
      .strict(),
    parameters: z.record(z.string(), z.unknown()),
    seed: z.number().int().nullable(),
    schema: z.object({ requested: z.boolean(), supported: z.boolean() }).strict(),
    machine: z.record(z.string(), z.string().nullable()),
    warmup: z.object({ loadMs: z.number().nullable(), warmMs: z.number().nullable() }).strict(),
    swapBeforeMiB: z.number().nullable(),
    swapAfterMiB: z.number().nullable(),
    lock: z.object({ path: z.string().nullable(), owner: z.string().nullable() }).strict()
  })
  .strict();
export type RunManifest = z.infer<typeof manifestSchema>;

/**
 * The items of an `items.ndjson` text. A last line that does not parse is the item a stopped run was
 * writing and is dropped (it runs again on resume); a bad line before it is an error.
 */
export function parseItemLines(text: string): ItemRecord[] {
  const records: ItemRecord[] = [];
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  for (const [index, line] of lines.entries()) {
    try {
      records.push(itemRecordSchema.parse(JSON.parse(line)));
    } catch (error) {
      if (index !== lines.length - 1) throw error;
    }
  }
  return records;
}
