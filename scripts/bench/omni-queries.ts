/**
 * The deterministic query set of the Cmd-K benchmark (F5 T128, bar X3(a)). Pure: the benchmark reads
 * each kind's titles from the profile and this module draws from them. The same titles and seed give
 * the same set on every machine, so a re-run on a clone (and `e2e/cmdk-latency.spec.ts`, which types
 * the same prefixes) compares like with like.
 *
 * Set: for each kind, `perKind` titles drawn with a seeded generator; each title yields one query, the
 * first `L` characters of the title with `L` drawn in 2..12 (a user stops typing somewhere on the way
 * to the whole title). `typedPrefixes` gives the keystroke-by-keystroke sequence up to that query.
 */
export const omniQuerySeed = 20261111;
export const omniQueriesPerKind = 50;
export const omniPrefixLengths = { min: 2, max: 12 } as const;

/** The kinds that have a title the omni statement matches by trigram. */
export const omniQueryKinds = ["source", "topic", "note", "entity", "question"] as const;
export type OmniQueryKind = (typeof omniQueryKinds)[number];

export interface TitleSample {
  id: string;
  title: string;
}

export interface OmniQuery {
  kind: OmniQueryKind;
  id: string;
  /** The title as the set normalises it (whitespace collapsed, trimmed). */
  title: string;
  /** What the user has typed: a prefix of `title`, 2-12 characters, never ending in a space. */
  query: string;
}

/** mulberry32: a 32-bit generator; the same seed gives the same sequence in every runtime. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Whitespace collapsed and trimmed, as the user would see the title in a result row. */
export function normalizeTitle(title: string): string {
  return title.replace(/\s+/gu, " ").trim();
}

/** The first `length` characters (code points) of the title, without a trailing space. */
export function prefixOf(title: string, length: number): string {
  return [...title].slice(0, length).join("").trimEnd();
}

/** The prefix lengths of a title whose query is at least 2 characters once trailing spaces go. */
function allowedLengths(title: string, min: number, max: number): number[] {
  const lengths: number[] = [];
  const limit = Math.min(max, [...title].length);
  for (let length = min; length <= limit; length += 1)
    if ([...prefixOf(title, length)].length >= min) lengths.push(length);
  return lengths;
}

/** A stable hash of the kind's name, so a kind's draw does not depend on the other kinds. */
function kindSeed(seed: number, kind: OmniQueryKind): number {
  let hash = 2_166_136_261;
  for (const character of kind) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  return (seed ^ hash) >>> 0;
}

export interface BuildQuerySetOptions {
  seed?: number;
  perKind?: number;
  minLength?: number;
  maxLength?: number;
}

/**
 * The query set. `titles` holds each kind's candidates in any order: they are sorted by id (then
 * title) first, so the set depends on the data and the seed only. A kind with fewer candidates than
 * `perKind` contributes all of them; a kind with none contributes nothing.
 */
export function buildQuerySet(
  titles: Partial<Record<OmniQueryKind, readonly TitleSample[]>>,
  options: BuildQuerySetOptions = {}
): OmniQuery[] {
  const seed = options.seed ?? omniQuerySeed;
  const perKind = options.perKind ?? omniQueriesPerKind;
  const min = options.minLength ?? omniPrefixLengths.min;
  const max = options.maxLength ?? omniPrefixLengths.max;
  const set: OmniQuery[] = [];
  for (const kind of omniQueryKinds) {
    const pool = (titles[kind] ?? [])
      .map(({ id, title }) => ({ id, title: normalizeTitle(title) }))
      .filter(({ title }) => allowedLengths(title, min, max).length > 0)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.title.localeCompare(b.title)));
    const random = mulberry32(kindSeed(seed, kind));
    // A partial Fisher-Yates shuffle: the first `count` places hold the draw.
    const count = Math.min(perKind, pool.length);
    for (let index = 0; index < count; index += 1) {
      const pick = index + Math.floor(random() * (pool.length - index));
      [pool[index], pool[pick]] = [pool[pick]!, pool[index]!];
    }
    for (const { id, title } of pool.slice(0, count)) {
      const lengths = allowedLengths(title, min, max);
      const length = lengths[Math.floor(random() * lengths.length)]!;
      set.push({ kind, id, title, query: prefixOf(title, length) });
    }
  }
  return set;
}

/**
 * The strings a user types to reach the query, one per keystroke: the prefixes of lengths 2 to the
 * query's own (`e2e/cmdk-latency.spec.ts` types these at 80 ms per key). A prefix that ends in a
 * space is the same search as the one before it and is left out.
 */
export function typedPrefixes(query: OmniQuery, minLength = omniPrefixLengths.min): string[] {
  const full = [...query.query].length;
  const sequence: string[] = [];
  for (let length = minLength; length <= full; length += 1) {
    const prefix = prefixOf(query.query, length);
    if ([...prefix].length >= minLength && sequence.at(-1) !== prefix) sequence.push(prefix);
  }
  return sequence;
}
