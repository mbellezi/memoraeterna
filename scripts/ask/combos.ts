import { createKnowledgeConsultationRepository } from "@app/db";

/**
 * The question and scope combinations of the Ask candidates measurement (F4 T79, C3). F3 measured
 * 250 + 1,020 of them on the soak database and its scratch scripts are gone, so this rebuilds the
 * set from the library itself, the same way every time for the same library and seed:
 *
 *  - `wide` (250): scopes that rank many passages, the whole library, a quarter to three quarters
 *    of its root sources, or the largest topics. These set the p95.
 *  - `narrow` (1,020): one source, a handful, a few dozen, or a small topic, with the same mix of
 *    questions. These cover the signals and the edge cases.
 *
 * Questions are drawn from the library so most of them match: words of a passage, the idea of a
 * note, a source title (exact, and folded to capitals and no accents), an entity name, a question
 * around a phrase, a passage phrase stripped of its accents, and the questions that match nothing
 * or only stop words. One combination in eight asks for reviewed material only.
 */
export type ComboSet = "wide" | "narrow";
export type QuestionKind =
  | "passage-words"
  | "idea"
  | "title"
  | "title-folded"
  | "entity"
  | "natural"
  | "accent-stripped"
  | "stop-words"
  | "no-match"
  | "punctuation";
export type ScopeKind = "library" | "roots" | "sources" | "topic";

export interface AskCombo {
  id: string;
  set: ComboSet;
  scope: ScopeKind;
  question: string;
  questionKind: QuestionKind;
  sourceIds: string[];
  reviewedOnly: boolean;
  topicId: string | null;
}

export interface Queryable {
  query<Row extends object>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

/** A small seeded generator (mulberry32): the same seed gives the same sequence. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)]!;

export function pickWeighted<T>(random: () => number, items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let at = random() * total;
  for (const [item, weight] of items) {
    at -= weight;
    if (at < 0) return item;
  }
  return items.at(-1)![0];
}

export const stripAccents = (text: string): string => text.normalize("NFD").replace(/\p{M}+/gu, "");

/** The words of a text worth asking about: letters and digits, at least `min` characters, once each. */
export function contentWords(text: string, min = 4): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const match of text.matchAll(/\p{L}[\p{L}\p{N}'’-]*/gu)) {
    const word = match[0].toLowerCase();
    if (word.length >= min && !seen.has(word)) {
      seen.add(word);
      words.push(word);
    }
  }
  return words;
}

/** `count` consecutive words of the text, from a random start among the words of the text. */
export function phraseOf(random: () => number, text: string, count: number): string {
  const words = text.split(/\s+/u).filter((word) => /\p{L}/u.test(word));
  if (words.length <= count) return words.join(" ");
  const start = Math.floor(random() * (words.length - count + 1));
  return words
    .slice(start, start + count)
    .join(" ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

export interface QuestionPools {
  /** Passages of the library, each with the source it belongs to. */
  chunks: { sourceItemId: string; content: string }[];
  ideas: string[];
  titles: string[];
  entities: string[];
}

const questionKinds = [
  ["passage-words", 30],
  ["idea", 15],
  ["title", 8],
  ["title-folded", 4],
  ["entity", 8],
  ["natural", 15],
  ["accent-stripped", 8],
  ["stop-words", 5],
  ["no-match", 4],
  ["punctuation", 3]
] as const satisfies readonly (readonly [QuestionKind, number])[];

const naturalForms = [
  (phrase: string) => `What does the text say about ${phrase}?`,
  (phrase: string) => `Como funciona ${phrase}?`,
  (phrase: string) => `Explain ${phrase} in detail`,
  (phrase: string) => `¿Qué es ${phrase}?`
];

/**
 * One question of the kind, from the pools; `inScope` narrows the passages to those of the scope
 * (the kinds that quote a passage fall back to any passage when the scope holds none in the pool).
 */
export function questionOf(
  random: () => number,
  kind: QuestionKind,
  pools: QuestionPools,
  inScope: (sourceItemId: string) => boolean
): string {
  const scoped = pools.chunks.filter((chunk) => inScope(chunk.sourceItemId));
  const passage = () => pick(random, scoped.length ? scoped : pools.chunks).content;
  const words = (count: number) => contentWords(passage()).slice(0, count + 3);
  switch (kind) {
    case "passage-words": {
      const found = contentWords(passage());
      const count = 3 + Math.floor(random() * 5);
      const start = Math.floor(random() * Math.max(1, found.length - count));
      return found.slice(start, start + count).join(" ") || "memory";
    }
    case "idea":
      return pools.ideas.length
        ? `${pick(random, pools.ideas).split(/\s+/u).slice(0, 24).join(" ")}?`
        : words(5).join(" ");
    case "title":
      return pools.titles.length ? pick(random, pools.titles) : words(3).join(" ");
    case "title-folded":
      return stripAccents(pools.titles.length ? pick(random, pools.titles) : "title").toUpperCase();
    case "entity":
      return pools.entities.length ? pick(random, pools.entities) : words(2).join(" ");
    case "natural":
      return pick(random, naturalForms)(phraseOf(random, passage(), 2 + Math.floor(random() * 3)));
    case "accent-stripped":
      return stripAccents(phraseOf(random, passage(), 4 + Math.floor(random() * 4)));
    case "stop-words":
      return pick(random, [
        "o a de que e do da em um",
        "the of and to in is that it for",
        "el la de que y en los las por"
      ]);
    case "no-match":
      return pick(random, ["zzqxv nothingmatches wwjjk", "qqqq xxxxzz", "kkjjhh vvbbnn"]);
    case "punctuation":
      return pick(random, ["???", "...", "-- ; :"]);
  }
}

const idsOf = (rows: { id: string }[]): string[] => rows.map((row) => row.id);

/** Every source in scope for the sources chosen, with their descendants, as Ask resolves it. */
async function resolveScope(db: Queryable, sourceIds: string[]): Promise<string[]> {
  return createKnowledgeConsultationRepository(db as never).scope({
    sourceIds,
    includeDescendants: true
  });
}

/** Builds the combinations of the set(s) from the library `db` reads. Read-only. */
export async function buildCombos(
  db: Queryable,
  options: { seed: number; wide: number; narrow: number }
): Promise<AskCombo[]> {
  const seed = String(options.seed);
  // One after the other: a single connection runs one statement at a time.
  const roots = await db.query<{ id: string }>(
    "select id from source_items where parent_source_item_id is null order by id"
  );
  const everySource = await db.query<{ id: string }>("select id from source_items order by id");
  const topics = await db.query<{ id: string; placed: number }>(
    `select t.id, (select count(*) from topic_placements p where p.topic_id = t.id)::int as placed
       from topics t where t.retired_at is null order by t.id`
  );
  const chunkRows = await db.query<QuestionPools["chunks"][number]>(
    `select c.source_item_id as "sourceItemId", c.content from chunks c
      where c.metadata->>'processingMode' is distinct from 'catalog_metadata'
      order by md5(c.id::text || $1) limit 800`,
    [seed]
  );
  const ideaRows = await db.query<{ idea: string }>(
    `select idea_statement as idea from atomic_notes where status not in ('rejected', 'archived')
      order by md5(id::text || $1) limit 400`,
    [seed]
  );
  const titleRows = await db.query<{ title: string }>(
    "select title from source_items order by md5(id::text || $1) limit 300",
    [seed]
  );
  const entityRows = await db.query<{ name: string }>(
    "select canonical_name as name from entities order by md5(id::text || $1) limit 300",
    [seed]
  );
  if (!everySource.rows.length) throw new Error("The library has no sources to ask about.");
  const pools: QuestionPools = {
    chunks: chunkRows.rows,
    ideas: ideaRows.rows.map((row) => String(row.idea)),
    titles: titleRows.rows.map((row) => String(row.title)),
    entities: entityRows.rows.map((row) => String(row.name))
  };
  const rootIds = idsOf(roots.rows);
  const allIds = idsOf(everySource.rows);
  // The largest topics first: the placements of a topic are a stand-in for the size of its subtree.
  const bySize = topics.rows.toSorted((a, b) => b.placed - a.placed || (a.id < b.id ? -1 : 1));
  const largeTopics = bySize.slice(0, Math.max(1, Math.ceil(bySize.length * 0.1)));
  const smallTopics = bySize
    .filter((topic) => topic.placed > 0)
    .slice(-Math.max(1, Math.ceil(bySize.length * 0.5)));
  const topicScope = async (topicId: string): Promise<string[]> =>
    createKnowledgeConsultationRepository(db as never).scope({
      sourceIds: [],
      includeDescendants: true,
      topicId
    });

  const combos: AskCombo[] = [];
  const random = createRandom(options.seed);
  const sample = <T>(items: readonly T[], count: number): T[] => {
    const pool = [...items];
    const taken: T[] = [];
    while (taken.length < count && pool.length)
      taken.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!);
    return taken;
  };
  const make = async (set: ComboSet, index: number): Promise<AskCombo> => {
    const wide = set === "wide";
    const scopeKind = wide
      ? pickWeighted<ScopeKind>(random, [
          ["library", 16],
          ["roots", 44],
          ["topic", largeTopics.length ? 40 : 0]
        ])
      : pickWeighted<ScopeKind>(random, [
          ["sources", 50],
          ["roots", 45],
          ["topic", smallTopics.length ? 5 : 0]
        ]);
    let sourceIds: string[];
    let topicId: string | null = null;
    if (scopeKind === "library") sourceIds = allIds;
    else if (scopeKind === "topic") {
      const topic = pick(random, wide ? largeTopics : smallTopics);
      topicId = topic.id;
      sourceIds = await topicScope(topicId);
    } else if (scopeKind === "roots") {
      const share = wide ? 0.25 + random() * 0.5 : 0;
      const count = wide
        ? Math.max(1, Math.round(rootIds.length * share))
        : pickWeighted(random, [
            [2, 3],
            [3, 3],
            [5, 2],
            [10, 2],
            [30, 1]
          ] as const);
      sourceIds = await resolveScope(db, sample(rootIds, Math.min(count, rootIds.length)));
    } else sourceIds = await resolveScope(db, sample(allIds, 1));
    if (!sourceIds.length) sourceIds = allIds.slice(0, 1);
    const scoped = new Set(sourceIds);
    const questionKind = pickWeighted<QuestionKind>(random, questionKinds);
    return {
      id: `${set}-${String(index + 1).padStart(4, "0")}`,
      set,
      scope: scopeKind,
      question: questionOf(random, questionKind, pools, (id) => scoped.has(id)),
      questionKind,
      sourceIds,
      reviewedOnly: random() < 1 / 8,
      topicId
    };
  };
  for (let index = 0; index < options.wide; index += 1) combos.push(await make("wide", index));
  for (let index = 0; index < options.narrow; index += 1) combos.push(await make("narrow", index));
  return combos;
}
