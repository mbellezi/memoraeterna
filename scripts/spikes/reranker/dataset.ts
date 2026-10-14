/**
 * Spike A dataset: schema, note text and loader shared by the build, scoring and evaluation scripts.
 * The dataset itself is built from the matching benchmark exports (`build-dataset.ts`) and lives
 * under `.cache/spikes/reranker/` (never versioned).
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

export const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..");
export const outputDirectory = join(repositoryRoot, ".cache", "spikes", "reranker");
export const datasetPath = join(outputDirectory, "dataset.json");
export const frozenPath = join(outputDirectory, "frozen.json");

export const bodyCharacters = 400;

export const runtimeNames = ["mlx", "gguf-qwen3", "gguf-bge"] as const;
export type RuntimeName = (typeof runtimeNames)[number];

export const partitionSchema = z.enum(["tuning", "holdout"]);
export type Partition = z.infer<typeof partitionSchema>;

export const phaseSchema = z.enum(["baseline", "economy", "coverage", "validate"]);
export type Phase = z.infer<typeof phaseSchema>;

const noteSchema = z
  .object({
    id: z.string().uuid(),
    root: z.string().min(1),
    partition: partitionSchema,
    title: z.string(),
    idea: z.string(),
    text: z.string().min(1)
  })
  .strict();

/** One judged candidate of the old pipeline: `query` is the note being matched, `doc` the candidate. */
const rowSchema = z
  .object({
    phase: phaseSchema,
    query: z.string().uuid(),
    doc: z.string().uuid(),
    cosine: z.number(),
    oldLlm: z.number().min(0).max(1),
    finalScore: z.number(),
    accepted: z.boolean()
  })
  .strict();

const labelSchema = z
  .object({
    pair: z.tuple([z.string(), z.string()]),
    partition: partitionSchema,
    kind: z.enum(["expected", "forbidden"])
  })
  .strict();

const pairSchema = z.tuple([z.string().uuid(), z.string().uuid()]);

const oldSourceLevelSchema = z
  .object({
    expectedFound: z.number().int(),
    expectedTotal: z.number().int(),
    forbiddenFound: z.number().int()
  })
  .strict();

export const datasetSchema = z
  .object({
    version: z.literal(1),
    createdAt: z.string(),
    textFormat: z.string(),
    notes: z.array(noteSchema),
    labels: z.array(labelSchema),
    rows: z.array(rowSchema),
    /** `tuning`: economy rows; `holdout`: validate rows; `all`: every row plus its reverse. */
    sets: z.object({
      tuning: z.array(pairSchema),
      holdout: z.array(pairSchema),
      all: z.array(pairSchema)
    }),
    oldSourceLevel: z.object({ tuning: oldSourceLevelSchema, holdout: oldSourceLevelSchema })
  })
  .strict();

export type Dataset = z.infer<typeof datasetSchema>;
export type DatasetNote = Dataset["notes"][number];
export type DatasetRow = Dataset["rows"][number];
export type PairSetName = keyof Dataset["sets"];

/** Title, idea statement and the first 400 characters of the body, one labelled line each. */
export function noteText(note: { title: string; idea: string; body: string }): string {
  const body = [...note.body.replace(/\s+/g, " ").trim()].slice(0, bodyCharacters).join("");
  return `Title: ${note.title}\nIdea: ${note.idea}\nText: ${body}`;
}

export async function loadDataset(): Promise<Dataset> {
  return datasetSchema.parse(JSON.parse(await readFile(datasetPath, "utf8")));
}

export const frozenSchema = z
  .object({
    instructionId: z.string(),
    instruction: z.string(),
    chosenAt: z.string(),
    basis: z.string()
  })
  .strict();

export async function loadFrozen(): Promise<z.infer<typeof frozenSchema>> {
  return frozenSchema.parse(JSON.parse(await readFile(frozenPath, "utf8")));
}
