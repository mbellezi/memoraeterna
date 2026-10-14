// Shared item format for the Spike B calibration corpora (Wikipedia pseudo-notes
// and the matching-benchmark notes). One JSON object per line.
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

import { z } from "zod";

export const corpusItemSchema = z.object({
  id: z.string().min(1),
  lang: z.enum(["pt", "en"]),
  domain: z.string().min(1),
  articleTitle: z.string().min(1),
  /** Short heading: article title plus section. */
  title: z.string().min(1),
  text: z.string().min(1)
});

export type CorpusItem = z.infer<typeof corpusItemSchema>;

export async function readJsonl<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  const rows: T[] = [];
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    const parsed = schema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new Error(`${path}:${lineNumber}: ${parsed.error.message}`);
    }
    rows.push(parsed.data);
  }
  return rows;
}

export async function writeJsonl(path: string, rows: readonly unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(path, rows.length > 0 ? `${body}\n` : "", "utf8");
}

const portugueseMarkers = new Set([
  "de",
  "do",
  "da",
  "dos",
  "das",
  "que",
  "não",
  "uma",
  "com",
  "para",
  "por",
  "são",
  "mais",
  "como",
  "também",
  "ao",
  "pelo",
  "pela",
  "em",
  "os",
  "as"
]);
const englishMarkers = new Set([
  "the",
  "of",
  "and",
  "to",
  "in",
  "is",
  "that",
  "for",
  "with",
  "as",
  "are",
  "was",
  "by",
  "it",
  "this",
  "from",
  "be",
  "or",
  "which",
  "an"
]);

/** Cheap pt/en guess by stopword counts; ties default to Portuguese. */
export function guessLanguage(text: string): "pt" | "en" {
  let pt = 0;
  let en = 0;
  for (const token of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (portugueseMarkers.has(token)) pt += 1;
    if (englishMarkers.has(token)) en += 1;
  }
  return en > pt ? "en" : "pt";
}
