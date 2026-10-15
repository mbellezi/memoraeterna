// The data side of the ENV-C corpus runner (F2 T22b): the public Wikipedia pseudo-note corpus
// (`.cache/corpus/{notes.jsonl,manifest.json}`, Spike B), the plan of which articles seed the base
// library and which are held out, and the seeding of one article as a root source with its
// attribution, a document, one chunk per note and the notes themselves. Pure TypeScript plus the
// repositories; the runner (`corpus-runner.ts`) owns the safety checks, the stages and the topic
// barrier. Nothing here calls a model.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createAtomicNoteRepository,
  createChunkRepository,
  createDocumentRepository,
  createJobRepository,
  createSourceItemRepository
} from "@app/db";
import type { PersistedChunkInput, PgPool } from "@app/db";
import { createRng, deriveSeed } from "@app/domain/topic-tree";
import { z } from "zod";

export const corpusNotesFile = "notes.jsonl";
export const corpusManifestFile = "manifest.json";
/** The separator between the article title and the section in a pseudo-note title (Spike B). */
const sectionSeparator = " — ";

const languageSchema = z.enum(["pt", "en"]);

const noteRowSchema = z
  .object({
    id: z.string().min(1),
    lang: languageSchema,
    domain: z.string().min(1),
    articleTitle: z.string().min(1),
    title: z.string().min(1),
    text: z.string().min(1)
  })
  .strict();

const manifestArticleSchema = z
  .object({
    lang: languageSchema,
    domain: z.string().min(1),
    title: z.string().min(1),
    pageId: z.number().int().positive(),
    revisionId: z.number().int().positive(),
    notes: z.number().int().min(0)
  })
  .strict();

const manifestSchema = z.looseObject({
  name: z.string().min(1),
  license: z.string().min(1),
  licenseUrl: z.string().url(),
  attribution: z.string().min(1),
  articles: z.array(manifestArticleSchema).min(1)
});

/** Splits a pseudo-note into an idea statement (first sentence) and a body (the rest): Spike B. */
export function splitIdea(text: string): { idea: string; body: string } {
  const match = /^(.{20,}?[.!?…])\s+(?=[\p{Lu}"“«(\d])/su.exec(text);
  if (!match?.[1]) return { idea: text.trim(), body: "" };
  return { idea: match[1].trim(), body: text.slice(match[0].length).trim() };
}

/**
 * The note title without the article-title prefix: the section name, or no title for an
 * introduction note (its title is the article title itself). This is `corpus-notitle`: the ideas
 * and bodies still name the subject in prose, as real notes do.
 */
export function sectionTitle(title: string, articleTitle: string): string {
  const prefix = `${articleTitle}${sectionSeparator}`;
  return title.startsWith(prefix) ? title.slice(prefix.length) : "";
}

export const articleKey = (lang: string, title: string): string => `${lang}:${title}`;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface CorpusNote {
  /** The corpus ID (`wp-en-24544-c000`); it is the note's generation key. */
  id: string;
  /** Section title; empty for an introduction (the notitle variant). */
  title: string;
  idea: string;
  body: string;
  /** The pseudo-note text: the chunk the note is derived from. */
  text: string;
}

export interface CorpusArticle {
  /** `<lang>:<title>`. */
  key: string;
  lang: "pt" | "en";
  title: string;
  domain: string;
  pageId: number;
  revisionId: number;
  notes: CorpusNote[];
}

export interface Corpus {
  name: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  /** Manifest order. */
  articles: CorpusArticle[];
  noteCount: number;
}

export class CorpusDataError extends Error {
  override readonly name = "CorpusDataError";
}

/** Reads and cross-checks the corpus: every note belongs to a manifest article, counts agree. */
export async function loadCorpus(directory: string): Promise<Corpus> {
  const folder = resolve(directory);
  let manifestText: string;
  let notesText: string;
  try {
    manifestText = await readFile(join(folder, corpusManifestFile), "utf8");
    notesText = await readFile(join(folder, corpusNotesFile), "utf8");
  } catch (error) {
    throw new CorpusDataError(
      `The corpus folder needs ${corpusManifestFile} and ${corpusNotesFile}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const manifest = manifestSchema.parse(JSON.parse(manifestText));
  const articles = new Map<string, CorpusArticle>();
  for (const entry of manifest.articles) {
    const key = articleKey(entry.lang, entry.title);
    if (articles.has(key)) throw new CorpusDataError(`The manifest lists ${key} twice`);
    articles.set(key, { key, ...entry, notes: [] });
  }
  const seen = new Set<string>();
  const lines = notesText.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.trim() === "") continue;
    const parsed = noteRowSchema.safeParse(JSON.parse(line));
    if (!parsed.success)
      throw new CorpusDataError(
        `${corpusNotesFile}:${index + 1}: ${parsed.error.issues[0]?.message ?? "invalid note"}`
      );
    const row = parsed.data;
    const article = articles.get(articleKey(row.lang, row.articleTitle));
    if (!article)
      throw new CorpusDataError(
        `${corpusNotesFile}:${index + 1}: ${articleKey(row.lang, row.articleTitle)} is not in the manifest`
      );
    if (seen.has(row.id)) throw new CorpusDataError(`${corpusNotesFile}: ${row.id} appears twice`);
    seen.add(row.id);
    const { idea, body } = splitIdea(row.text);
    article.notes.push({
      id: row.id,
      title: sectionTitle(row.title, row.articleTitle),
      idea,
      body,
      text: row.text
    });
  }
  for (const article of articles.values()) {
    const expected = manifest.articles.find(
      (entry) => articleKey(entry.lang, entry.title) === article.key
    )?.notes;
    if (expected !== article.notes.length)
      throw new CorpusDataError(
        `${article.key} has ${article.notes.length} notes, the manifest says ${expected}`
      );
  }
  const list = [...articles.values()].filter((article) => article.notes.length > 0);
  return {
    name: manifest.name,
    license: manifest.license,
    licenseUrl: manifest.licenseUrl,
    attribution: manifest.attribution,
    articles: list,
    noteCount: list.reduce((total, article) => total + article.notes.length, 0)
  };
}

// ---------------------------------------------------------------------------
// The plan: base library and held-out articles

/**
 * Which articles are held out of the base library and arrive one at a time later (the live gate
 * spot check of T23, the in-app growth runs):
 * - `articles:<n>`: n articles, chosen by the seed;
 * - `share:<x>`: seeded articles until they hold about the share x (0 to 1, exclusive) of the notes;
 * - `file:<path>`: a JSON array of article keys (`<lang>:<title>`), for a twin-aware list made by
 *   the offline harness; the order of the file is the arrival order.
 */
export type HoldoutSpec =
  | { mode: "articles"; count: number }
  | { mode: "share"; share: number }
  | { mode: "file"; path: string };

export function parseHoldout(value: string, baseDirectory: string): HoldoutSpec {
  const [mode, ...rest] = value.split(":");
  const argument = rest.join(":").trim();
  if (mode === "articles") {
    const count = Number(argument);
    if (!Number.isInteger(count) || count < 1)
      throw new CorpusDataError("The holdout articles:<n> needs a whole number of at least 1");
    return { mode, count };
  }
  if (mode === "share") {
    const share = Number(argument);
    if (!(share > 0 && share < 1))
      throw new CorpusDataError("The holdout share:<x> needs a number between 0 and 1");
    return { mode, share };
  }
  if (mode === "file" && argument !== "") return { mode, path: resolve(baseDirectory, argument) };
  throw new CorpusDataError(
    "The holdout is articles:<n>, share:<x> or file:<path> (a JSON array of <lang>:<title>)"
  );
}

export interface CorpusPlan {
  /** Seeded into the library first, in manifest order. */
  base: CorpusArticle[];
  /** Arrive one at a time afterwards, in this order. */
  held: CorpusArticle[];
}

/** A seeded subset of `count` articles, in manifest order (a smoke-sized corpus). */
export function limitArticles(
  articles: readonly CorpusArticle[],
  count: number,
  seed: number
): CorpusArticle[] {
  if (count >= articles.length) return [...articles];
  const order = createRng(deriveSeed(seed, "corpus-articles")).shuffle(
    articles.map((_, index) => index)
  );
  const chosen = new Set(order.slice(0, count));
  return articles.filter((_, index) => chosen.has(index));
}

export async function planCorpus(
  articles: readonly CorpusArticle[],
  holdout: HoldoutSpec | null,
  seed: number
): Promise<CorpusPlan> {
  if (holdout === null) return { base: [...articles], held: [] };
  let held: CorpusArticle[];
  if (holdout.mode === "file") {
    const keys = z.array(z.string().min(1)).parse(JSON.parse(await readFile(holdout.path, "utf8")));
    const byKey = new Map(articles.map((article) => [article.key, article]));
    held = keys.map((key) => {
      const article = byKey.get(key);
      if (!article) throw new CorpusDataError(`The holdout file names ${key}, which is not seeded`);
      return article;
    });
    if (new Set(keys).size !== keys.length)
      throw new CorpusDataError("The holdout file lists an article twice");
  } else {
    const order = createRng(deriveSeed(seed, "corpus-holdout")).shuffle([...articles]);
    held = [];
    let notes = 0;
    const total = articles.reduce((sum, article) => sum + article.notes.length, 0);
    const done = () =>
      holdout.mode === "articles" ? held.length >= holdout.count : notes >= holdout.share * total;
    for (const article of order) {
      if (done()) break;
      held.push(article);
      notes += article.notes.length;
    }
  }
  const heldKeys = new Set(held.map((article) => article.key));
  const base = articles.filter((article) => !heldKeys.has(article.key));
  if (base.length === 0) throw new CorpusDataError("The holdout leaves no article in the base");
  return { base, held };
}

// ---------------------------------------------------------------------------
// Seeding

export interface SeededArticle {
  rootSourceId: string;
  noteIds: string[];
  chunks: number;
}

/** What identifies a seeded note in the generation columns (a corpus note is not AI output). */
const generation = {
  provider: "corpus",
  model: "wikipedia-pseudo-note",
  runtime: "none",
  promptVersion: "corpus-notitle-v1"
} as const;

/** The permalink of the revision the notes were cut from. */
export function revisionUrl(article: Pick<CorpusArticle, "lang" | "title" | "revisionId">): string {
  const title = encodeURIComponent(article.title.replaceAll(" ", "_"));
  return `https://${article.lang}.wikipedia.org/w/index.php?title=${title}&oldid=${article.revisionId}`;
}

/**
 * Seeds one article: a root source with its attribution (license, revision, the corpus statement),
 * a document that holds the notes' text, one chunk and source span per note, the notes (active at
 * birth, `ownership = source`, title/idea/body as in `corpus-notitle`) and the `note-embedding`
 * jobs that give them vectors in the app's own space. The notes are the evidence of their own
 * chunk. The library is the product's own (Wikipedia text, CC BY-SA 4.0).
 */
export async function seedArticle(
  pool: PgPool,
  corpus: Pick<Corpus, "name" | "license" | "licenseUrl" | "attribution">,
  article: CorpusArticle
): Promise<SeededArticle> {
  const markdown = `# ${article.title}\n\n${article.notes.map((note) => note.text).join("\n\n")}\n`;
  const source = await createSourceItemRepository(pool).create({
    type: "WebArticle",
    title: article.title,
    sourceOrigin: "wikipedia-corpus",
    sourceUri: revisionUrl(article),
    externalId: `wikipedia:${article.lang}:${article.pageId}`,
    contentHash: sha256(markdown),
    language: article.lang,
    metadata: {
      corpus: {
        name: corpus.name,
        license: corpus.license,
        licenseUrl: corpus.licenseUrl,
        attribution: `${corpus.attribution} Article: "${article.title}", Wikipedia (${article.lang}), revision ${article.revisionId}.`,
        pageId: article.pageId,
        revisionId: article.revisionId
      }
    }
  });
  const document = await createDocumentRepository(pool).create({
    sourceItemId: source.id,
    title: article.title,
    canonicalMarkdown: markdown,
    contentHash: sha256(markdown),
    language: article.lang
  });
  let cursor = markdown.indexOf("\n\n") + 2;
  const chunks: PersistedChunkInput[] = article.notes.map((note, chunkIndex) => {
    const startOffset = markdown.indexOf(note.text, cursor);
    cursor = startOffset + note.text.length;
    const spanId = randomUUID();
    return {
      id: randomUUID(),
      sourceSpanId: spanId,
      chunkIndex,
      content: note.text,
      contentHash: sha256(note.text),
      language: article.lang,
      chunkingVersion: "corpus-v1",
      span: { id: spanId, startOffset, endOffset: startOffset + note.text.length }
    };
  });
  const stored = await createChunkRepository(pool).replaceDocumentChunks(
    document.id,
    source.id,
    chunks
  );
  const generationRow = await pool.query<{ id: string }>(
    `insert into knowledge_generations (source_item_id, stage, status, metadata)
     values ($1, 'atomicNotes', 'current', $2::jsonb) returning id::text as id`,
    [source.id, JSON.stringify({ corpus: corpus.name })]
  );
  const generationId = generationRow.rows[0]!.id;
  const notes = createAtomicNoteRepository(pool);
  const jobs = createJobRepository(pool);
  const noteIds: string[] = [];
  for (const [index, note] of article.notes.entries()) {
    const chunk = stored[index]!;
    const record = await notes.upsertGenerated({
      generationId,
      title: note.title,
      bodyMarkdown: note.body,
      ideaStatement: note.idea,
      language: article.lang,
      sourceItemId: source.id,
      evidenceChunkId: chunk.id,
      sourceSpanId: chunk.sourceSpanId,
      evidenceLinks: [{ chunkId: chunk.id, sourceSpanId: chunk.sourceSpanId }],
      generationProvider: generation.provider,
      generationModel: generation.model,
      generationRuntime: generation.runtime,
      generationPromptVersion: generation.promptVersion,
      generationKey: note.id,
      metadata: { corpusNoteId: note.id }
    });
    noteIds.push(record.id);
    await jobs.enqueueNoteEmbedding({ atomicNoteId: record.id, sourceItemId: source.id });
  }
  return { rootSourceId: source.id, noteIds, chunks: stored.length };
}
