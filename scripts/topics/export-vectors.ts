// The replay store: the on-disk form of an item set with its unit vectors, read by the offline
// replay and calibration harness and written by `topics:export` (T22a) and the Spike B scripts.
//
//   <name>.f32          row-major little-endian Float32, `count` x `dim`, unit rows
//   <name>.index.jsonl  one JSON object per row, in row order (ReplayRow)
//   <name>.meta.json    ReplayMeta: the dataset, the embedding model/space and when it was made
//
// The layout is the Spike B vector store (`.cache/spikes/topic-tree/vectors`): its files load
// unchanged. Rows may carry extra fields (Spike B keeps `inputSha256`, `tokens`, `truncated`);
// they are ignored here. Vectors are never compared across embedding spaces (`rules/data.md`):
// `meta.spaceKey` names the space of an app export and callers keep one space per dataset.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { createMatrix, maxUnitDeviation, normalizeRows } from "@app/domain/topic-tree";
import type { EmbeddingMatrix } from "@app/domain/topic-tree";

export const ReplayRowSchema = z.looseObject({
  /** Note or source ID (Spike B: the corpus item ID). */
  id: z.string().min(1),
  kind: z.enum(["note", "source"]).optional(),
  /**
   * Content hash of the item (D22: the first part of the content key). Spike B stores carry the
   * SHA-256 of the embedding input (`inputSha256`) instead; the ID's hash stands in otherwise.
   */
  contentHash: z.string().min(1).optional(),
  inputSha256: z.string().min(1).optional(),
  lang: z.string().min(1),
  /** Ground-truth family when there is one (Wikipedia domain, fixture family); else "unknown". */
  domain: z.string().min(1).optional(),
  /** Finer group: the article, or the root source of an app export. */
  group: z.string().min(1),
  title: z.string(),
  text: z.string().optional(),
  /** Chronological rank (the order of a real import, or of the manifest). */
  order: z.number().int().min(0),
  /** Root source of a note in an app export; the group when absent. */
  rootSourceId: z.string().min(1).nullable().optional(),
  createdAt: z.string().nullable().optional(),
  dataset: z.string().optional()
});

export const ReplayMetaSchema = z.looseObject({
  dataset: z.string().min(1),
  count: z.number().int().min(0),
  dim: z.number().int().positive(),
  model: z.looseObject({
    name: z.string(),
    repository: z.string().optional(),
    revision: z.string().optional(),
    sha256: z.string().optional()
  }),
  runtime: z.string(),
  input: z.string(),
  createdAt: z.string(),
  /** The embedding space of an app export (`embeddingSpaceKey`); absent for Spike B (MLX). */
  spaceKey: z.string().min(1).optional()
});
export type ReplayMeta = z.infer<typeof ReplayMetaSchema>;

/** A row with the defaults resolved. */
export interface ReplayRow {
  id: string;
  kind: "note" | "source";
  contentHash: string;
  lang: string;
  domain: string;
  group: string;
  title: string;
  text: string;
  order: number;
  rootSourceId: string;
}

export interface ReplayStore {
  meta: ReplayMeta;
  rows: ReplayRow[];
  matrix: EmbeddingMatrix;
}

export class ReplayStoreError extends Error {
  override readonly name = "ReplayStoreError";
  constructor(
    readonly code: "missing" | "invalid",
    message: string
  ) {
    super(message);
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function replayStorePaths(
  dir: string,
  name: string
): { vectors: string; index: string; meta: string } {
  return {
    vectors: join(dir, `${name}.f32`),
    index: join(dir, `${name}.index.jsonl`),
    meta: join(dir, `${name}.meta.json`)
  };
}

function resolveRow(row: z.infer<typeof ReplayRowSchema>): ReplayRow {
  return {
    id: row.id,
    kind: row.kind ?? "note",
    contentHash: row.contentHash ?? row.inputSha256 ?? sha256Hex(row.id),
    lang: row.lang,
    domain: row.domain ?? "unknown",
    group: row.group,
    title: row.title,
    text: row.text ?? "",
    order: row.order,
    rootSourceId: row.rootSourceId ?? row.group
  };
}

/** Parses an index file: one row per non-empty line, errors name the line. */
export function parseReplayRows(text: string, source = "index"): ReplayRow[] {
  const rows: ReplayRow[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new ReplayStoreError("invalid", `${source}: line ${index + 1} is not JSON`);
    }
    const parsed = ReplayRowSchema.safeParse(value);
    if (!parsed.success) {
      throw new ReplayStoreError(
        "invalid",
        `${source}: line ${index + 1}: ${parsed.error.issues[0]?.message ?? "invalid row"}`
      );
    }
    rows.push(resolveRow(parsed.data));
  }
  return rows;
}

export interface ReadStoreOptions {
  /** Unit rows are an invariant of stored vectors; a larger deviation is an error. */
  unitTolerance?: number;
  /** Renormalize rows instead of rejecting a deviation (exports from a model that does not). */
  normalize?: boolean;
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Reads a replay store; `null` when its files do not exist. */
export async function tryReadReplayStore(
  dir: string,
  name: string,
  options: ReadStoreOptions = {}
): Promise<ReplayStore | null> {
  const paths = replayStorePaths(dir, name);
  const metaBuffer = await readOptional(paths.meta);
  if (!metaBuffer) return null;
  const metaParsed = ReplayMetaSchema.safeParse(JSON.parse(metaBuffer.toString("utf8")));
  if (!metaParsed.success) {
    throw new ReplayStoreError(
      "invalid",
      `${name}: meta: ${metaParsed.error.issues[0]?.message ?? "invalid"}`
    );
  }
  const meta = metaParsed.data;
  const indexBuffer = await readOptional(paths.index);
  const vectorBuffer = await readOptional(paths.vectors);
  if (!indexBuffer || !vectorBuffer) {
    throw new ReplayStoreError("missing", `${name}: the index or vector file is missing`);
  }
  const rows = parseReplayRows(indexBuffer.toString("utf8"), `${name} index`);
  if (rows.length !== meta.count) {
    throw new ReplayStoreError(
      "invalid",
      `${name}: ${rows.length} index rows, meta says ${meta.count}`
    );
  }
  const matrix = createMatrix(meta.count, meta.dim);
  if (vectorBuffer.byteLength !== matrix.data.byteLength) {
    throw new ReplayStoreError(
      "invalid",
      `${name}: ${vectorBuffer.byteLength} bytes of vectors, expected ${matrix.data.byteLength}`
    );
  }
  // Copy: a Buffer's byteOffset is not guaranteed to be 4-byte aligned. The files are little
  // endian, like every platform the app runs on.
  new Uint8Array(matrix.data.buffer).set(vectorBuffer);
  const deviation = maxUnitDeviation(matrix);
  if (!Number.isFinite(deviation)) {
    throw new ReplayStoreError("invalid", `${name}: the vectors hold a non-finite value`);
  }
  if (deviation > (options.unitTolerance ?? 1e-3)) {
    if (!options.normalize) {
      throw new ReplayStoreError(
        "invalid",
        `${name}: rows are not unit length (largest deviation ${deviation.toExponential(2)})`
      );
    }
    normalizeRows(matrix);
  }
  return { meta, rows, matrix };
}

export async function readReplayStore(
  dir: string,
  name: string,
  options: ReadStoreOptions = {}
): Promise<ReplayStore> {
  const store = await tryReadReplayStore(dir, name, options);
  if (!store) throw new ReplayStoreError("missing", `${name}: no replay store in ${dir}`);
  return store;
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export interface WritableReplayRow {
  id: string;
  kind?: "note" | "source";
  contentHash?: string;
  lang: string;
  domain?: string;
  group: string;
  title: string;
  text?: string;
  order: number;
  rootSourceId?: string | null;
}

/** Writes a store (vectors, index, meta), each file atomically; creates the directory. */
export async function writeReplayStore(
  dir: string,
  name: string,
  store: { meta: ReplayMeta; rows: readonly WritableReplayRow[]; matrix: EmbeddingMatrix }
): Promise<void> {
  const { meta, rows, matrix } = store;
  if (rows.length !== meta.count || matrix.count !== meta.count || matrix.dim !== meta.dim) {
    throw new ReplayStoreError(
      "invalid",
      `${name}: meta ${meta.count}x${meta.dim}, ${rows.length} rows, matrix ${matrix.count}x${matrix.dim}`
    );
  }
  const deviation = maxUnitDeviation(matrix);
  if (!(deviation <= 1e-3)) {
    throw new ReplayStoreError("invalid", `${name}: refusing to write non-unit or non-finite rows`);
  }
  for (const row of rows) ReplayRowSchema.parse(row);
  const paths = replayStorePaths(dir, name);
  await mkdir(dir, { recursive: true });
  await writeAtomic(paths.vectors, new Uint8Array(matrix.data.buffer, 0, matrix.data.byteLength));
  await writeAtomic(paths.index, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  await writeAtomic(paths.meta, `${JSON.stringify(ReplayMetaSchema.parse(meta), null, 2)}\n`);
}
