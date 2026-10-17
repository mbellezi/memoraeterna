/**
 * Writes the blind judge pages of a label set (T45, spec 5.2): 20 items per page in a seeded random
 * order, both sides of every item in a seeded random A/B order, one shared instruction block
 * (`judge-prompt.md`) and the sealed key (`sealed.json`) that maps page positions back to pairs and
 * that judges never read.
 *
 *   npx tsx scripts/relations/labels/render.ts [--pass <name>]
 *
 * A note side shows its title, idea, the first 600 characters of its body, its source title and its
 * language; a source side shows its title, language, an overview (its summary, or the opening of its
 * first chunk when it has none) and up to two evidence excerpts. Pages carry no score, model name,
 * dataset name, set, stratum or id other than the page position, and the renderer refuses a page on
 * which such a word appears more often than in the notes' own text.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { readSpikeDataset } from "../../golden/reverse-only.ts";
import { readNoteTexts } from "../note-texts.ts";
import {
  clip,
  contextSchema,
  directedTypes,
  evidenceSchema,
  labelSetSchema,
  labelsDirectory,
  readJson,
  sealedFormat,
  sealedSchema,
  sha256Hex,
  shuffled,
  streamRandom,
  writeTypes,
  type Excerpt,
  type LabelItem,
  type LabelSet,
  type LibraryContext,
  type LibraryEvidence,
  type Sealed,
  type SealedItem
} from "./common.ts";

export const itemsPerPage = 20;
/** At most this many items (pages, in the spec's words) per judge (R10). */
export const maxItemsPerJudge = 600;
export const display = {
  title: 300,
  idea: 400,
  body: 600,
  sourceTitle: 200,
  overview: 900,
  excerpt: 600
} as const;
/** A rough token estimate for the budget report (Portuguese-heavy text). */
export const charactersPerToken = 3.5;

export interface NoteSide {
  kind: "note";
  language: string;
  source: string;
  title: string;
  idea: string;
  body: string;
}

export interface SourceSide {
  kind: "source";
  language: string;
  title: string;
  overview: string;
  excerpts: string[];
}

export type Side = NoteSide | SourceSide;

/** What a page may show of an item: content only (no ids, sets, strata or scores). */
export interface DisplayedItem {
  lo: Side;
  hi: Side;
}

// --- Content --------------------------------------------------------------------------------------

/**
 * Text as a reader sees it: Markdown images and bare URLs dropped, links reduced to their text
 * (source chunks keep the Markdown of the imported pages).
 */
export function plainText(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/gu, " ")
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/gu, "$1")
    .replace(/<?https?:\/\/[^\s>]+>?/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Plain text cut to `limit` characters. */
export const shown = (text: string, limit: number): string => clip(plainText(text), limit);

/** The excerpt window: from the closest note's span (snapped back to a word start), else the start. */
export function excerptWindow(
  excerpt: Pick<Excerpt, "text" | "focus">,
  limit: number = display.excerpt
): string {
  const points = [...excerpt.text];
  let start = Math.max(0, Math.min(excerpt.focus ?? 0, points.length - limit));
  while (start > 0 && points[start - 1] !== " ") start -= 1;
  // Markup takes room that plain text does not: cut the raw window generously, then the plain one.
  const window = points.slice(start, start + 4 * limit).join("");
  return `${start > 0 ? "…" : ""}${shown(window, limit)}`;
}

export interface NoteText {
  title: string;
  idea: string;
  body: string;
}

export interface RenderSources {
  contexts: Partial<Record<"fixture" | "golden" | "corpus", LibraryContext>>;
  evidence: Partial<Record<"fixture" | "golden" | "corpus", LibraryEvidence>>;
  texts: Partial<
    Record<"fixture" | "golden" | "corpus" | "spike-a", ReadonlyMap<string, NoteText>>
  >;
  /** Spike A: root of each note and title of each root. */
  spikeRoots: ReadonlyMap<string, string>;
  spikeRootTitles: ReadonlyMap<string, string>;
}

/**
 * The primary language subtag (`pt-BR` and `pt` both show `pt`): libraries spell regions
 * differently, and a page must not tell them apart by that.
 */
export const displayLanguage = (code: string): string => code.split(/[-_]/u)[0]!.toLowerCase();

export function sourceTitleOf(context: LibraryContext, sourceItemId: string): string {
  const sources = new Map(context.sources.map((source) => [source.id, source]));
  const own = sources.get(sourceItemId);
  if (!own) throw new Error(`Source ${sourceItemId} is not in the context.`);
  if (own.rootId === own.id) return own.title;
  return `${sources.get(own.rootId)?.title ?? ""} / ${own.title}`;
}

function noteSide(item: LabelItem, noteId: string, sources: RenderSources): NoteSide {
  const text = sources.texts[item.library]?.get(noteId);
  if (!text) throw new Error(`No text for note ${noteId} of ${item.pairId}.`);
  if (item.library === "spike-a") {
    const root = sources.spikeRoots.get(noteId);
    return {
      kind: "note",
      language: displayLanguage("pt-BR"),
      source: shown(sources.spikeRootTitles.get(root ?? "") ?? "", display.sourceTitle),
      title: shown(text.title, display.title),
      idea: shown(text.idea, display.idea),
      body: shown(text.body, display.body)
    };
  }
  const context = sources.contexts[item.library];
  const note = context?.notes.find((candidate) => candidate.id === noteId);
  if (!context || !note) throw new Error(`No context for note ${noteId} of ${item.pairId}.`);
  return {
    kind: "note",
    language: displayLanguage(note.language),
    source: shown(sourceTitleOf(context, note.sourceItemId), display.sourceTitle),
    title: shown(text.title, display.title),
    idea: shown(text.idea, display.idea),
    body: shown(text.body, display.body)
  };
}

function sourceSide(item: LabelItem, rootId: string, sources: RenderSources): SourceSide {
  if (item.library === "spike-a") throw new Error("Spike A has no source pairs.");
  const context = sources.contexts[item.library];
  const root = context?.roots.find((candidate) => candidate.id === rootId);
  const evidence = sources.evidence[item.library]?.pairs.find(
    (pair) => pair.lo === item.lo && pair.hi === item.hi
  );
  if (!root) throw new Error(`No context for root ${rootId} of ${item.pairId}.`);
  if (!evidence) throw new Error(`No evidence for source pair ${item.pairId}.`);
  const excerpts = rootId === item.lo ? evidence.loExcerpts : evidence.hiExcerpts;
  return {
    kind: "source",
    language: displayLanguage(root.language),
    title: shown(root.title, display.sourceTitle),
    overview: shown(root.overview, display.overview),
    excerpts: excerpts.map((excerpt) => excerptWindow(excerpt))
  };
}

export function displayedItem(item: LabelItem, sources: RenderSources): DisplayedItem {
  const side = (id: string) =>
    item.kind === "note" ? noteSide(item, id, sources) : sourceSide(item, id, sources);
  return { lo: side(item.lo), hi: side(item.hi) };
}

/** Hash of what the judges saw of an item, independent of its page position and A/B order. */
export const contentHash = (displayed: DisplayedItem): string =>
  sha256Hex(JSON.stringify([displayed.lo, displayed.hi]));

// --- Pages ----------------------------------------------------------------------------------------

function sideBlock(label: "A" | "B", side: Side): string[] {
  if (side.kind === "note")
    return [
      `**${label}** · ${side.language} · ${side.source}`,
      `Title: ${side.title}`,
      `Idea: ${side.idea}`,
      `Text: ${side.body}`
    ];
  return [
    `**${label}** · ${side.language} · ${side.title}`,
    `Overview: ${side.overview}`,
    ...side.excerpts.map((excerpt, index) => `Excerpt ${index + 1}: ${excerpt}`)
  ];
}

export function itemBlock(itemId: string, a: Side, b: Side): string {
  const what = a.kind === "note" ? "two notes" : "two sources";
  return [`### ${itemId} · ${what}`, "", ...sideBlock("A", a), "", ...sideBlock("B", b)].join("\n");
}

export function pageText(page: number, pages: number, blocks: readonly string[]): string {
  return [
    `# Page ${String(page).padStart(3, "0")} of ${String(pages).padStart(3, "0")}`,
    "",
    "Answer every item below as `judge-prompt.md` says: one JSON object per item.",
    "",
    blocks.join("\n\n"),
    ""
  ].join("\n");
}

/** Words that would tell a judge where a pair comes from or how a model scored it. */
export const forbiddenOnPages =
  /\b(fixture|golden|corpus|env-[a-z0-9]+|pools?|strat(?:um|a)|mlx|gguf|qwen[\w.-]*|rerankers?|bge|codex|openai|gpt[\w.-]*|r_?v[69]|spike|log-?odds|scores?|scored|held-?out|tuning|benchmark|wikipedia|sealed)\b/giu;
const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;

const occurrences = (pattern: RegExp, text: string): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(pattern)) {
    const word = match[0].toLowerCase();
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
};

/**
 * Forbidden words or ids on a page beyond those inside the displayed content itself (a corpus note
 * may well say "score"; the template never may).
 */
export function pageLeaks(page: string, contents: readonly string[]): string[] {
  const leaks: string[] = [];
  for (const pattern of [forbiddenOnPages, uuidPattern]) {
    const own = occurrences(pattern, contents.join("\n"));
    for (const [word, count] of occurrences(pattern, page))
      if (count > (own.get(word) ?? 0)) leaks.push(word);
  }
  return leaks;
}

const sideContents = (side: Side): string[] =>
  side.kind === "note"
    ? [side.language, side.source, side.title, side.idea, side.body]
    : [side.language, side.title, side.overview, ...side.excerpts];

export interface RenderedPass {
  pages: Array<{ file: string; text: string; items: number }>;
  sealed: Sealed;
  prompt: string;
  report: RenderReport;
}

export interface RenderReport {
  pass: string;
  items: number;
  noteItems: number;
  sourceItems: number;
  pages: number;
  characters: number;
  estimatedTokens: number;
  promptCharacters: number;
  /** Every judge reads every page. */
  perJudge: { items: number; pages: number; estimatedInputTokens: number };
  pageCharacters: number[];
}

export function renderPass(
  set: LabelSet,
  sources: RenderSources,
  options: { labelSetSha256: string; directory: string }
): RenderedPass {
  if (set.items.length > maxItemsPerJudge)
    throw new Error(
      `${set.items.length} items exceed the ${maxItemsPerJudge}-item load per judge.`
    );
  const items = [...set.items].sort((a, b) => (a.pairId < b.pairId ? -1 : 1));
  const orientation = streamRandom(set.seed, `${set.pass}:orientation`);
  const flips = new Map(items.map((item) => [item.pairId, orientation() < 0.5]));
  const ordered = shuffled(items, streamRandom(set.seed, `${set.pass}:page-order`));
  const pageCount = Math.ceil(ordered.length / itemsPerPage);
  const prompt = judgePrompt({
    directory: options.directory,
    pages: pageCount,
    items: ordered.length
  });
  const promptLeaks = pageLeaks(prompt, []);
  if (promptLeaks.length > 0)
    throw new Error(`The judge prompt would show ${promptLeaks.join(", ")}.`);
  const promptSha256 = sha256Hex(prompt);
  const pages: RenderedPass["pages"] = [];
  const sealedItems: SealedItem[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    const slice = ordered.slice((page - 1) * itemsPerPage, page * itemsPerPage);
    const blocks: string[] = [];
    const contents: string[] = [];
    slice.forEach((item, index) => {
      const itemId = `${String(page).padStart(3, "0")}-${String(index + 1).padStart(2, "0")}`;
      const displayed = displayedItem(item, sources);
      const shownA = flips.get(item.pairId) ? "hi" : "lo";
      const [a, b] = shownA === "lo" ? [displayed.lo, displayed.hi] : [displayed.hi, displayed.lo];
      blocks.push(itemBlock(itemId, a, b));
      contents.push(...sideContents(a), ...sideContents(b));
      sealedItems.push({ ...item, itemId, page, shownA, contentSha256: contentHash(displayed) });
    });
    const text = pageText(page, pageCount, blocks);
    const leaks = pageLeaks(text, contents);
    if (leaks.length > 0) throw new Error(`Page ${page} would show ${leaks.join(", ")}.`);
    pages.push({ file: `page-${String(page).padStart(3, "0")}.md`, text, items: slice.length });
  }
  const sealed: Sealed = {
    format: sealedFormat,
    version: 1,
    pass: set.pass,
    seed: set.seed,
    labelSetSha256: options.labelSetSha256,
    promptSha256,
    pages: pages.map((page) => ({
      file: page.file,
      items: page.items,
      sha256: sha256Hex(page.text)
    })),
    items: sealedItems
  };
  const characters = pages.reduce((sum, page) => sum + [...page.text].length, 0);
  const promptCharacters = [...prompt].length;
  return {
    pages,
    sealed,
    prompt,
    report: {
      pass: set.pass,
      items: ordered.length,
      noteItems: ordered.filter((item) => item.kind === "note").length,
      sourceItems: ordered.filter((item) => item.kind === "source").length,
      pages: pages.length,
      characters,
      estimatedTokens: Math.round(characters / charactersPerToken),
      promptCharacters,
      perJudge: {
        items: ordered.length,
        pages: pages.length,
        // The instruction block is read with every page (one shared block per 20-item prompt).
        estimatedInputTokens: Math.round(
          (characters + promptCharacters * pages.length) / charactersPerToken
        )
      },
      pageCharacters: pages.map((page) => [...page.text].length)
    }
  };
}

// --- Judge prompt ---------------------------------------------------------------------------------

export function judgePrompt(input: { directory: string; pages: number; items: number }): string {
  const last = String(input.pages).padStart(3, "0");
  const directed = directedTypes.join(", ");
  const symmetric = writeTypes.filter((type) => !directedTypes.includes(type)).join(" and ");
  return `# Relation judging: instructions

You are one of three independent judges. You label pairs of notes and pairs of sources. Work alone:
read only this file and the page files listed at the end, and write only your own answer file. Do not
open, list or search any other file (in this folder or anywhere else), do not look for where the texts
come from, and do not use tools other than reading the pages and writing your answers.

## What a page shows

Each page holds up to ${itemsPerPage} items. An item shows two notes, A and B, or two sources, A and B.

- A note shows its language, the source it was written from, its title, its idea and the start of its
  text.
- A source shows its language, its title, an overview and up to two excerpts of its text.

The texts are in Portuguese or English. Judge them as written, in their own language. A and B are in
random order: the order means nothing. A text that ends with "…" was cut short.

## The three questions (every item)

1. **related**: does one note make a claim about the same mechanism, rule or phenomenon as the other,
   supported by both texts, so that a careful reader would link them? Shared names, topics, places or
   dates, similar vocabulary, or being about the same broad subject are not enough. Answer "yes" or
   "no". For two sources, ask the same of the two sources as wholes, from their overviews and
   excerpts.
2. **type**: only when related is "yes", the one type below that describes the link best. When related
   is "no", null.
3. **direction**: only for the directed types (${directed}): "A->B" when A is the subject (A supports
   B, A extends B, A depends on B, A is an example of B, A clarifies B), "B->A" when B is. For
   ${symmetric}, and whenever related is "no", null.

Types, with X the subject and Y the object:

- **supports**: X gives evidence, a reason or a result that makes Y's claim more likely to be true.
- **contradicts** (no direction): X and Y make claims about the same thing that cannot both be true,
  or reach opposite conclusions about it.
- **extends**: X builds on Y's claim and adds a further step, condition, consequence or a wider scope.
- **depends_on**: X's claim holds only if Y's claim holds; X presupposes Y.
- **example_of**: X is a specific case or instance of the general mechanism, rule or phenomenon that
  Y states.
- **clarifies**: X explains, defines or makes precise what Y states, without adding a claim of its own.
- **same_as** (no direction): X and Y state the same claim in other words.

When more than one type fits, choose the one that describes the link most precisely.

Judge every item on its own. There is no expected share of "yes": two texts on the same subject that
make unrelated claims are "no". Use only what the texts say; do not supply a link from outside
knowledge that the texts themselves do not support.

## Answer format

Write your answers to \`${input.directory}/answers/<judge>.json\`, where \`<judge>\` is the name you were
given (for example \`judge-1\`). The file is one JSON array with one object per item, one object per
line, in page order:

\`\`\`json
[
{"id": "001-01", "related": "no", "type": null, "direction": null},
{"id": "001-02", "related": "yes", "type": "extends", "direction": "B->A"},
{"id": "001-03", "related": "yes", "type": "same_as", "direction": null}
]
\`\`\`

Use exactly these four keys. \`id\` is the item's number as the page shows it; \`related\` is "yes" or
"no"; \`type\` is one of ${writeTypes.map((type) => `"${type}"`).join(", ")} or null; \`direction\` is
"A->B", "B->A" or null. Every item of every page appears exactly once (${input.items} items). Save the
file after each page (rewrite the whole array) so that no answer is lost.

## Pages

\`${input.directory}/pages/page-001.md\` to \`${input.directory}/pages/page-${last}.md\`, ${input.pages} pages, read in order.
`;
}

// --- Inputs and main ------------------------------------------------------------------------------

export const libraryProfiles = { fixture: "env-f", golden: "env-g", corpus: "env-c" } as const;
export const defaultTexts = {
  fixture: ".cache/f3/scratch/t46a/env-f-note-texts.json",
  golden: ".cache/f3/scratch/t46a/env-g-note-texts.json",
  corpus: ".cache/f3/scratch/t46a/env-c-20261018-note-texts.json"
} as const;
export const defaultSpike = {
  dataset: ".cache/spikes/reranker/dataset.json",
  benchmark: "scripts/fixtures/matching-benchmark.json"
} as const;

const benchmarkSchema = z
  .object({ sources: z.array(z.object({ key: z.string(), title: z.string() }).passthrough()) })
  .passthrough();

/** Spike A's rendered text keeps the first 400 body characters after `Text: `. */
export function spikeBody(text: string): string {
  const marker = text.indexOf("\nText: ");
  return marker < 0 ? "" : text.slice(marker + "\nText: ".length);
}

async function readSources(set: LabelSet): Promise<RenderSources> {
  const libraries = new Set(set.items.map((item) => item.library));
  const sources: RenderSources = {
    contexts: {},
    evidence: {},
    texts: {},
    spikeRoots: new Map(),
    spikeRootTitles: new Map()
  };
  for (const library of ["fixture", "golden", "corpus"] as const) {
    if (!libraries.has(library)) continue;
    const profile = libraryProfiles[library];
    sources.contexts[library] = await readJson(
      `${labelsDirectory}/inputs/${profile}-context.json`,
      contextSchema,
      "library context"
    );
    if (set.items.some((item) => item.library === library && item.kind === "source"))
      sources.evidence[library] = await readJson(
        `${labelsDirectory}/inputs/${profile}-evidence.json`,
        evidenceSchema,
        "evidence"
      );
    const texts = await readNoteTexts(defaultTexts[library]);
    sources.texts[library] = new Map(texts.file.notes.map((note) => [note.id, note]));
  }
  if (libraries.has("spike-a")) {
    const dataset = await readSpikeDataset(defaultSpike.dataset);
    const benchmark = benchmarkSchema.parse(
      JSON.parse(await readFile(defaultSpike.benchmark, "utf8"))
    );
    sources.texts["spike-a"] = new Map(
      dataset.notes.map((note) => {
        const fields = note as { id: string; title?: unknown; idea?: unknown; text?: unknown };
        return [
          note.id,
          {
            title: String(fields.title ?? ""),
            idea: String(fields.idea ?? ""),
            body: spikeBody(String(fields.text ?? ""))
          }
        ];
      })
    );
    sources.spikeRoots = new Map(dataset.notes.map((note) => [note.id, note.root]));
    sources.spikeRootTitles = new Map(
      benchmark.sources.map((source) => [source.key, source.title])
    );
  }
  return sources;
}

export const passDirectory = (pass: string | undefined): string =>
  pass && pass !== "panel" ? `${labelsDirectory}/passes/${pass}` : labelsDirectory;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { pass: { type: "string" } },
    strict: true,
    allowPositionals: false
  });
  const directory = passDirectory(values.pass);
  const labelSetPath = `${directory}/label-set.json`;
  const bytes = await readFile(labelSetPath).catch(() => {
    throw new Error(`Cannot read the label set "${labelSetPath}". Run sample.ts first.`);
  });
  const set = labelSetSchema.parse(JSON.parse(bytes.toString("utf8")));
  const rendered = renderPass(set, await readSources(set), {
    labelSetSha256: sha256Hex(bytes),
    directory
  });
  const pagesDirectory = join(directory, "pages");
  await mkdir(pagesDirectory, { recursive: true });
  const stale = (await readdir(pagesDirectory)).filter((file) => /^page-\d{3}\.md$/u.test(file));
  if (stale.length > 0 && stale.length !== rendered.pages.length)
    throw new Error(
      `${pagesDirectory} holds ${stale.length} pages of another rendering; remove them first.`
    );
  for (const page of rendered.pages) await writeFile(join(pagesDirectory, page.file), page.text);
  await writeFile(join(directory, "judge-prompt.md"), rendered.prompt);
  await writeFile(
    join(directory, "sealed.json"),
    `${JSON.stringify(sealedSchema.parse(rendered.sealed), null, 1)}\n`
  );
  await writeFile(
    join(directory, "render-report.json"),
    `${JSON.stringify(rendered.report, null, 1)}\n`
  );
  await mkdir(join(directory, "answers"), { recursive: true });
  const { report } = rendered;
  console.info(
    `${report.pass}: ${report.items} items (${report.noteItems} note, ${report.sourceItems} source) on ${report.pages} pages, ` +
      `${report.characters} characters (~${report.estimatedTokens} tokens); per judge ~${report.perJudge.estimatedInputTokens} input tokens ` +
      `with the instruction block per page; wrote ${resolve(directory)}`
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`[labels/render] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
