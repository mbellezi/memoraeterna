// Real-data inputs for Spike B: the public corpus pseudo-notes, the synthetic
// matching-benchmark notes and the owner's library (read-only, from the `owner`
// scratch cluster), rendered exactly like the app's note embedding input, plus a
// Float32 vector store under .cache/spikes/topic-tree/vectors/.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import pg from "pg";
import { z } from "zod";

import { renderPrompt } from "../../../apps/desktop/src/main/services/prompt-runtime.js";
import { corpusItemSchema, guessLanguage, readJsonl, writeJsonl } from "../corpus/items.js";
import { splitArticle } from "../corpus/split-notes.js";
import { createMatrix } from "./vectors.js";
import type { EmbeddingMatrix } from "./vectors.js";

export const repoRoot = resolve(import.meta.dirname, "../../..");
export const spikeDir = join(repoRoot, ".cache", "spikes", "topic-tree");
export const vectorsDir = join(spikeDir, "vectors");
export const corpusNotesPath = join(repoRoot, ".cache", "corpus", "notes.jsonl");
export const benchmarkNotesPath = join(spikeDir, "benchmark-notes.jsonl");

export const datasetNames = ["corpus", "benchmark", "owner"] as const;
export type DatasetName = (typeof datasetNames)[number];

/**
 * Vector stores. "corpus-notitle" holds the same pseudo-notes embedded without the
 * article title prefix (see loadCorpus): the Spike B review found that the shared
 * "Article - Section" title lets held-out notes match their ~20 siblings by title.
 */
export const storeNames = ["corpus", "corpus-notitle", "benchmark", "owner"] as const;
export type StoreName = (typeof storeNames)[number];

export const realItemSchema = z.object({
  id: z.string().min(1),
  dataset: z.enum(datasetNames),
  lang: z.enum(["pt", "en"]),
  /** Ground-truth family: Wikipedia domain, benchmark fixture family, owner root source. */
  domain: z.string().min(1),
  /** Finer group: Wikipedia article, benchmark root source, owner root source. */
  group: z.string().min(1),
  title: z.string().min(1),
  /** Plain text used for naming and display. */
  text: z.string().min(1),
  /** ISO timestamp when the item really has one (benchmark notes, owner documents). */
  createdAt: z.string().nullable(),
  /** Chronological rank (insertion order of a real import). */
  order: z.number().int().nonnegative()
});
export type RealItem = z.infer<typeof realItemSchema>;

/** A real item with its exact embedding input (never stored, only hashed). */
export interface EmbeddableItem {
  item: RealItem;
  input: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Splits a pseudo-note into an idea statement (first sentence) and a body (the rest). */
export function splitIdea(text: string): { idea: string; body: string } {
  const match = /^(.{20,}?[.!?…])\s+(?=[\p{Lu}"“«(\d])/su.exec(text);
  if (!match?.[1]) return { idea: text.trim(), body: "" };
  return { idea: match[1].trim(), body: text.slice(match[0].length).trim() };
}

/** The app's note embedding input (KnowledgeService): title, idea and body; documents get no instruction. */
export function noteInput(title: string, idea: string, body: string): string {
  return renderPrompt("embedding.content.note", {
    note_title: title,
    note_idea: idea,
    note_body: body
  });
}

/** The app's chunk embedding input (JobSupervisor). */
export function chunkInput(content: string): string {
  return renderPrompt("embedding.content.chunk", { source_text: content });
}

// ---------------------------------------------------------------------------
// Datasets

const sectionSeparator = " \u2014 ";

/**
 * The note title without the article-title prefix: the section name, or no title for
 * introduction notes (their title is the article title itself).
 */
export function sectionTitle(title: string, articleTitle: string): string {
  const prefix = `${articleTitle}${sectionSeparator}`;
  return title.startsWith(prefix) ? title.slice(prefix.length) : "";
}

export interface CorpusLoadOptions {
  /**
   * Embed with the section name only (empty for introductions) instead of
   * "Article - Section". The ideas and bodies are the same text, which still names
   * the subject in prose, as real notes do.
   */
  stripArticleTitle?: boolean;
}

export async function loadCorpus(options: CorpusLoadOptions = {}): Promise<EmbeddableItem[]> {
  const rows = await readJsonl(corpusNotesPath, corpusItemSchema);
  return rows.map((row, order) => {
    const { idea, body } = splitIdea(row.text);
    const inputTitle = options.stripArticleTitle
      ? sectionTitle(row.title, row.articleTitle)
      : row.title;
    return {
      item: {
        id: row.id,
        dataset: "corpus",
        lang: row.lang,
        domain: row.domain,
        group: `${row.lang}:${row.articleTitle}`,
        title: row.title,
        text: row.text,
        createdAt: null,
        order
      },
      input: noteInput(inputTitle, idea, body)
    };
  });
}

const scratchConnectionSchema = z.object({
  status: z.string(),
  host: z.string(),
  port: z.number().int(),
  database: z.string(),
  user: z.string(),
  password: z.string()
});

/** Runs `fn` in a READ ONLY transaction on a running scratch cluster (.cache/f0/scratch-<slug>.json). */
export async function withScratchDb<T>(
  slug: string,
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const path = join(repoRoot, ".cache", "f0", `scratch-${slug}.json`);
  const connection = scratchConnectionSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (connection.status !== "running") {
    throw new Error(
      `Scratch cluster "${slug}" is ${connection.status}; start it with scripts/db/restore-backup.ts --keep-running`
    );
  }
  const client = new pg.Client({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password
  });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await fn(client);
    await client.query("ROLLBACK");
    return result;
  } finally {
    await client.end();
  }
}

const benchmarkNoteRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  idea_statement: z.string(),
  body_markdown: z.string(),
  created_at: z.date(),
  root_title: z.string()
});

const rootSourceSql = `
  with recursive up(start_id, id, parent_id, title, depth) as (
    select s.id, s.id, s.parent_source_item_id, s.title, 0 from source_items s
    union all
    select up.start_id, p.id, p.parent_source_item_id, p.title, up.depth + 1
    from up join source_items p on p.id = up.parent_id where up.depth < 20
  )
  select distinct on (start_id) start_id, id as root_id, title as root_title
  from up where parent_id is null order by start_id, depth desc`;

/** The 150 benchmark notes with their stored text, creation time and fixture family. */
export async function loadBenchmark(): Promise<EmbeddableItem[]> {
  const families = new Map(
    (await readJsonl(benchmarkNotesPath, corpusItemSchema)).map((row) => [row.id, row.domain])
  );
  const rows = await withScratchDb("benchmark", async (client) => {
    const result = await client.query(
      `with roots as (${rootSourceSql})
       select n.id, n.title, n.idea_statement, n.body_markdown, n.created_at, r.root_title
       from atomic_notes n join roots r on r.start_id = n.created_from_source_item_id
       order by n.created_at, n.id`
    );
    return z.array(benchmarkNoteRowSchema).parse(result.rows);
  });
  return rows.map((row, order) => {
    const text = [row.title, row.idea_statement, row.body_markdown]
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join("\n");
    return {
      item: {
        id: row.id,
        dataset: "benchmark",
        lang: guessLanguage(text),
        domain: families.get(row.id) ?? "benchmark",
        group: row.root_title,
        title: row.title,
        text,
        createdAt: row.created_at.toISOString(),
        order
      },
      input: noteInput(row.title, row.idea_statement, row.body_markdown)
    };
  });
}

/** Stored GGUF note vectors of the benchmark library with their content hashes. */
export async function loadStoredVectors(
  slug: string,
  targetType: "atomic_note" | "chunk"
): Promise<Map<string, { contentHash: string; vector: Float32Array; model: string }>> {
  const rows = await withScratchDb(slug, async (client) => {
    const result = await client.query(
      `select target_id::text as id, content_hash, model, embedding::text as embedding
       from embeddings_1024 where target_type = $1`,
      [targetType]
    );
    return z
      .array(
        z.object({
          id: z.string(),
          content_hash: z.string(),
          model: z.string(),
          embedding: z.string()
        })
      )
      .parse(result.rows);
  });
  return new Map(
    rows.map((row) => [
      row.id,
      {
        contentHash: row.content_hash,
        model: row.model,
        vector: Float32Array.from(JSON.parse(row.embedding) as number[])
      }
    ])
  );
}

/** Markdown of a converted document as a wiki-style extract for the corpus splitter. */
export function markdownToExtract(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => {
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line.trim());
      if (heading) {
        const level = Math.min(6, (heading[1]?.length ?? 1) + 1);
        const marks = "=".repeat(level);
        return `${marks} ${(heading[2] ?? "").replace(/[*_`]/g, "")} ${marks}`;
      }
      return line
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__|\*|`)/g, "");
    })
    .join("\n");
}

const ownerDocumentRowSchema = z.object({
  source_id: z.string(),
  title: z.string(),
  language: z.string(),
  created_at: z.date(),
  canonical_markdown: z.string()
});

/**
 * The owner's library has no atomic notes (0 in every owner backup), so its root
 * documents are split into pseudo-notes with the public-corpus splitter (child
 * DocumentSection sources repeat the root text and are skipped).
 */
export async function loadOwner(): Promise<EmbeddableItem[]> {
  const documents = await withScratchDb("owner", async (client) => {
    const result = await client.query(
      `select s.id::text as source_id, s.title, s.language, s.created_at, d.canonical_markdown
       from source_items s join documents d on d.source_item_id = s.id
       where s.parent_source_item_id is null order by s.created_at, s.id`
    );
    return z.array(ownerDocumentRowSchema).parse(result.rows);
  });
  const output: EmbeddableItem[] = [];
  for (const document of documents) {
    const lang = guessLanguage(document.canonical_markdown);
    const notes = splitArticle(
      {
        lang,
        domain: document.title,
        title: document.title,
        pageId: 0,
        revisionId: 0,
        extract: markdownToExtract(document.canonical_markdown)
      },
      { minChars: 200, maxChars: 700, maxPerArticle: 1000 }
    );
    for (const note of notes) {
      const { idea, body } = splitIdea(note.text);
      output.push({
        item: {
          id: `owner-${document.source_id.slice(0, 8)}-${note.id.slice(-4)}`,
          dataset: "owner",
          lang,
          domain: document.title,
          group: document.title,
          title: note.title,
          text: note.text,
          createdAt: document.created_at.toISOString(),
          order: output.length
        },
        input: noteInput(note.title, idea, body)
      });
    }
  }
  return output;
}

const ownerChunkRowSchema = z.object({ id: z.string(), content: z.string() });

/** Owner chunks with the app's chunk input, for the MLX vs stored GGUF comparison. */
export async function loadOwnerChunks(): Promise<{ id: string; input: string }[]> {
  const rows = await withScratchDb("owner", async (client) => {
    const result = await client.query(
      "select id::text as id, content from chunks order by created_at, chunk_index"
    );
    return z.array(ownerChunkRowSchema).parse(result.rows);
  });
  return rows.map((row) => ({ id: row.id, input: chunkInput(row.content) }));
}

// ---------------------------------------------------------------------------
// Vector store: <name>.f32 (row-major Float32, unit rows), <name>.index.jsonl
// (row i = item i plus its input hash and token count), <name>.meta.json.

export const storedRowSchema = realItemSchema.extend({
  inputSha256: z.string().length(64),
  tokens: z.number().int().positive(),
  truncated: z.boolean()
});
export type StoredRow = z.infer<typeof storedRowSchema>;

export const storeMetaSchema = z.object({
  dataset: z.string(),
  count: z.number().int().nonnegative(),
  dim: z.number().int().positive(),
  model: z.object({
    name: z.string(),
    repository: z.string(),
    revision: z.string(),
    sha256: z.string()
  }),
  runtime: z.string(),
  input: z.string(),
  createdAt: z.string()
});
export type StoreMeta = z.infer<typeof storeMetaSchema>;

export interface VectorStore {
  meta: StoreMeta;
  rows: StoredRow[];
  matrix: EmbeddingMatrix;
}

function storePaths(name: string) {
  return {
    vectors: join(vectorsDir, `${name}.f32`),
    index: join(vectorsDir, `${name}.index.jsonl`),
    meta: join(vectorsDir, `${name}.meta.json`)
  };
}

export async function writeStore(
  name: string,
  meta: StoreMeta,
  rows: readonly StoredRow[],
  vectors: Float32Array
): Promise<void> {
  if (vectors.length !== rows.length * meta.dim) {
    throw new Error(`Store ${name}: ${vectors.length} floats for ${rows.length} x ${meta.dim}`);
  }
  await mkdir(vectorsDir, { recursive: true });
  const paths = storePaths(name);
  await writeFile(
    paths.vectors,
    Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength)
  );
  await writeJsonl(paths.index, rows);
  await writeFile(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

export async function readStore(name: string): Promise<VectorStore | null> {
  const paths = storePaths(name);
  let metaText: string;
  try {
    metaText = await readFile(paths.meta, "utf8");
  } catch {
    return null;
  }
  const meta = storeMetaSchema.parse(JSON.parse(metaText));
  const rows = await readJsonl(paths.index, storedRowSchema);
  const buffer = await readFile(paths.vectors);
  const matrix = createMatrix(rows.length, meta.dim);
  if (buffer.byteLength !== matrix.data.byteLength) {
    throw new Error(
      `Store ${name}: ${buffer.byteLength} bytes, expected ${matrix.data.byteLength}`
    );
  }
  // Copy: a Buffer's byteOffset is not guaranteed to be 4-byte aligned.
  new Uint8Array(matrix.data.buffer).set(buffer);
  return { meta, rows, matrix };
}
