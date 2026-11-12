import type { ObjectKind, ObjectRef, ObjectResolved, ObjectResolveManyInput } from "@app/domain";

import type { SearchOmniInput, SearchOmniItem } from "../../../shared/ipc-search";

/**
 * The library Cmd-K and the search results panel read through the fake `window.app` in the screens
 * tool: the design record's fermentation fixture (§17). Object titles and text stand for the
 * person's own content and stay in English; every word of the app's own chrome comes from
 * `@app/i18n`. Only the two screen modules and the tests import this file.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const address = (kind: ObjectKind, n: number) => `memora://${kind}/${uuid(n)}`;

const topicRef = (n: number, title: string): ObjectRef => ({ kind: "topic", id: uuid(n), title });
const lifeSciences = topicRef(2, "Life sciences");
const microbiology = topicRef(3, "Microbiology");
const fermentation = topicRef(5, "Fermentation");
const history = topicRef(6, "History of science");
const nutrition = topicRef(7, "Nutrition");

interface Entry {
  kind: ObjectKind;
  title: string;
  preview: string;
  counts?: Record<string, number>;
  path?: ObjectRef[];
  /** Found by its text, not its title: the row shows this line. */
  snippet?: string;
}

const entries: Record<string, Entry> = {
  [address("topic", 5)]: {
    kind: "topic",
    title: "Fermentation",
    preview:
      "Processes in which microorganisms turn sugars into acids, gases or alcohol, and what that did for the preservation of food.",
    counts: { notes: 32, children: 2 },
    path: [lifeSciences, microbiology]
  },
  [address("topic", 8)]: {
    kind: "topic",
    title: "Lactic fermentation",
    preview: "Bacteria that turn sugar into lactic acid, and with that preserve food.",
    counts: { notes: 18, children: 3 },
    path: [lifeSciences, microbiology, fermentation]
  },
  [address("topic", 9)]: {
    kind: "topic",
    title: "Alcoholic fermentation",
    preview: "Yeasts that turn sugar into alcohol and carbon dioxide.",
    counts: { notes: 9, children: 1 },
    path: [lifeSciences, microbiology, fermentation]
  },
  [address("topic", 10)]: {
    kind: "topic",
    title: "Fermented foods",
    preview: "Yoghurt, sauerkraut, kefir, kimchi and the rest of the pantry.",
    counts: { notes: 6, children: 0 },
    path: [nutrition]
  },
  [address("topic", 11)]: {
    kind: "topic",
    title: "Fermentation at home",
    preview: "Jars, salt and patience.",
    counts: { notes: 4, children: 0 },
    path: [nutrition]
  },
  [address("topic", 12)]: {
    kind: "topic",
    title: "Fermentation temperature",
    preview: "Why a cooler ferment ends less acid.",
    counts: { notes: 3, children: 0 },
    path: [lifeSciences, microbiology, fermentation]
  },
  [address("note", 21)]: {
    kind: "note",
    title: "Lactic acid lowers the pH and inhibits pathogens",
    preview:
      "When lactic acid bacteria consume the sugars of a food, the acid they produce brings the pH down to about 4, where most spoilage bacteria cannot multiply.",
    counts: { sources: 2 },
    path: [lifeSciences, microbiology, fermentation]
  },
  [address("note", 22)]: {
    kind: "note",
    title: "Pasteur showed that fermentation is the work of living organisms",
    preview: "In the 1850s he tied each ferment to a microbe.",
    counts: { sources: 1 },
    path: [history]
  },
  [address("note", 23)]: {
    kind: "note",
    title: "Temperature controls the final acidity of a ferment",
    preview: "A cooler ferment ends less acid and more aromatic.",
    counts: { sources: 1 },
    path: [lifeSciences, microbiology, fermentation]
  },
  [address("note", 24)]: {
    kind: "note",
    title: "A salt brine selects the ferment that will win",
    preview: "Salt holds back moulds and lets the lactic bacteria through.",
    counts: { sources: 1 },
    path: [nutrition]
  },
  [address("note", 25)]: {
    kind: "note",
    title: "Kefir ferments with both yeasts and bacteria",
    preview: "A symbiosis that gives it fizz and acidity.",
    counts: { sources: 1 },
    path: [nutrition]
  },
  [address("source", 11)]: {
    kind: "source",
    title: "Food microbiology, chapter 3",
    preview:
      "The chapter explains how lactic bacteria, yeasts and moulds compete in foods, and why acidity, salt and the lack of oxygen decide who wins.",
    counts: { notes: 14, passages: 38 },
    path: [lifeSciences, microbiology],
    snippet: "…lactic fermentation reduces the pH of the medium to about 4…"
  },
  [address("entity", 41)]: {
    kind: "entity",
    title: "Louis Pasteur",
    preview: "French chemist and microbiologist, who tied each ferment to a living microbe.",
    counts: { notes: 11 }
  },
  [address("question", 31)]: {
    kind: "question",
    title: "Why do fermented foods keep longer outside the fridge?",
    preview: "Because the fermentation itself builds the barrier that protects the food.",
    counts: { answers: 1 }
  }
};

export const paletteAddresses = {
  topic: address("topic", 5),
  note: address("note", 21),
  source: address("source", 11),
  entity: address("entity", 41),
  question: address("question", 31)
} as const;

const rank = (addresses: string[]): SearchOmniItem[] =>
  addresses.map((item, index) => {
    const entry = entries[item]!;
    return {
      address: item,
      kind: entry.kind,
      title: entry.title,
      ...(entry.snippet ? { snippet: entry.snippet } : {}),
      arms: [{ arm: "title_trgm" as const, rank: index + 1 }],
      score: 1 / (60 + index + 1)
    };
  });

/** The answer for "ferment": the best result first, then the groups' rows in rank order. */
const fermentationResults = rank([
  address("topic", 5),
  address("topic", 8),
  address("note", 21),
  address("topic", 9),
  address("source", 11),
  address("note", 22),
  address("topic", 10),
  address("entity", 41),
  address("note", 23),
  address("topic", 11),
  address("note", 24),
  address("question", 31),
  address("topic", 12),
  address("note", 25)
]);

/** What `search.omni` answers: the fermentation results narrowed to the kinds asked for. */
export function omniFixture(empty: boolean) {
  return (input: SearchOmniInput) => {
    // Full mode also finds passages: a source text, shown as its address with a passage anchor.
    const passage: SearchOmniItem = {
      address: `${address("source", 11)}#passage=${uuid(91)}`,
      kind: "source",
      title: "Food microbiology, chapter 3",
      snippet:
        "Below a pH of about 4.2 the growth of most common pathogens is inhibited, which is why a lactic ferment can stay on the shelf for weeks.",
      arms: [{ arm: "chunk_fts" as const, rank: 1 }],
      score: 1 / 62
    };
    const all =
      input.mode === "full"
        ? [...fermentationResults.slice(0, 3), passage, ...fermentationResults.slice(3)]
        : fermentationResults;
    const items = empty
      ? []
      : all.filter((item) => !input.kinds || input.kinds.includes(item.kind));
    return {
      requestId: input.requestId,
      items: input.limit ? items.slice(0, input.limit) : items,
      degraded: [] as ("ann" | "fts")[],
      tookMs: 14
    };
  };
}

/** What `objects.resolveMany` answers for those addresses, with their place. */
export function resolveManyFixture() {
  return ({ addresses }: ObjectResolveManyInput) => {
    const items: Record<string, ObjectResolved> = {};
    for (const requested of addresses) {
      const entry = entries[requested.split("#")[0] ?? requested];
      if (!entry) continue;
      items[requested] = {
        address: requested,
        kind: entry.kind,
        title: entry.title,
        status: "current",
        preview: entry.preview,
        updatedAt: "2026-11-03T09:12:00.000Z",
        ...(entry.counts ? { counts: entry.counts } : {}),
        ...(entry.path ? { path: entry.path } : {})
      };
    }
    return { items, missing: addresses.filter((requested) => items[requested] === undefined) };
  };
}

/** The opened objects the empty box lists: a pin and four recent ones. */
export function recentFixture(empty: boolean) {
  const at = (n: number) => `2026-11-1${n}T09:00:00.000Z`;
  const entry = (item: string, openedAt: string, pinned: boolean) => {
    const source = entries[item]!;
    return {
      address: item,
      kind: source.kind,
      id: item.slice(-36),
      title: source.title,
      parentAddress: null,
      openedAt,
      openCount: 2,
      pinned
    };
  };
  return () =>
    empty
      ? []
      : [
          entry(address("topic", 5), at(1), true),
          entry(address("note", 21), at(1), false),
          entry(address("source", 11), at(0), false),
          entry(address("question", 31), at(0), false),
          entry(address("entity", 41), at(0), false),
          entry(address("note", 24), at(0), false)
        ];
}

/** The rows of a list behind the scrim, as the person's own content. */
export const backdropRows = [
  "Street grids: lessons from two hundred cities",
  "Rhythm and syncopation in choro",
  "Kefir and kombucha at home",
  "Preserves and salting in the 19th century",
  "Functional harmony in ten lessons",
  "The pantry before refrigeration"
];
