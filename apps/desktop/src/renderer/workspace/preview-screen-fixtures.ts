import type {
  ObjectKind,
  ObjectRef,
  ObjectResolved,
  ObjectResolveManyInput,
  ObjectBacklinksResult
} from "@app/domain";

/**
 * The library the hover card's and quick-look's screens read through the fake `window.app`: the
 * design record's fermentation fixture (§17), with a few lines of text per object. Object titles
 * and text stand for the person's own content and stay in English; every word of the app's own
 * chrome comes from `@app/i18n`. Only the two screen modules import this file.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const address = (kind: ObjectKind, n: number) => `memora://${kind}/${uuid(n)}`;

export const previewAddresses = {
  source: address("source", 11),
  topic: address("topic", 4),
  note: address("note", 21),
  noteTwo: address("note", 22),
  noteThree: address("note", 23),
  noteFour: address("note", 24),
  entity: address("entity", 41),
  question: address("question", 31),
  /** A passage of the source: the card previews the passage, not the source. */
  sourcePassage: `${address("source", 11)}#passage=${uuid(91)}`,
  /** A relation from the note to another note: its card says where the other end sits. */
  relatedNote: `${address("note", 24)}#relation=${uuid(95)}`
} as const;

const topic = (n: number, title: string): ObjectRef => ({ kind: "topic", id: uuid(n), title });
const microbiology = [
  topic(2, "Life sciences"),
  topic(3, "Microbiology"),
  topic(5, "Fermentation")
];
const history = [topic(6, "History of science"), topic(7, "Food preservation")];

type Entry = Omit<ObjectResolved, "address">;

const base = {
  status: "current" as const,
  updatedAt: "2026-11-03T09:12:00.000Z"
};

const library: Record<string, Entry> = {
  [previewAddresses.source]: {
    ...base,
    kind: "source",
    title: "Food microbiology, chapter 3",
    preview:
      "The chapter explains how lactic bacteria, yeasts and moulds compete in foods, and why acidity, salt and the lack of oxygen decide who wins.",
    counts: { notes: 14, passages: 38 },
    path: microbiology
  },
  [previewAddresses.sourcePassage]: {
    ...base,
    kind: "source",
    title: "Food microbiology, chapter 3",
    preview:
      "Below a pH of about 4.2 the growth of most common pathogens is practically inhibited, which is why a ferment can stay on the shelf for weeks.",
    counts: { notes: 14, passages: 38 },
    path: microbiology
  },
  [previewAddresses.topic]: {
    ...base,
    kind: "topic",
    title: "Lactic fermentation",
    preview:
      "Bacteria that turn sugar into lactic acid, and with that preserve food. The base of yoghurt, sauerkraut and kefir.",
    counts: { notes: 18, children: 3 },
    path: microbiology
  },
  [previewAddresses.note]: {
    ...base,
    kind: "note",
    title: "Lactic acid lowers the pH and inhibits pathogens",
    preview:
      "When lactic acid bacteria consume the sugars of a food, the acid they produce brings the pH down to about 4, where most spoilage bacteria cannot multiply.",
    counts: { sources: 2 },
    path: microbiology
  },
  [previewAddresses.noteTwo]: {
    ...base,
    kind: "note",
    title: "Lactic bacteria tolerate an acid medium",
    preview: "They keep growing where most spoilage bacteria stop.",
    counts: { sources: 1 },
    path: microbiology
  },
  [previewAddresses.noteThree]: {
    ...base,
    kind: "note",
    title: "Temperature controls the final acidity",
    preview: "A cooler ferment ends less acid and more aromatic.",
    counts: { sources: 1 },
    path: microbiology
  },
  [previewAddresses.noteFour]: {
    ...base,
    kind: "note",
    title: "In the 19th century, salt and acidity kept food without ice",
    preview:
      "Salt and acid were the two weapons of the pantry: one pulled the water out, the other took the spirit out of the microbes.",
    counts: { sources: 1 },
    path: history
  },
  [previewAddresses.relatedNote]: {
    ...base,
    kind: "note",
    title: "In the 19th century, salt and acidity kept food without ice",
    preview:
      "Salt and acid were the two weapons of the pantry: one pulled the water out, the other took the spirit out of the microbes.",
    counts: { sources: 1 },
    path: history
  },
  [previewAddresses.entity]: {
    ...base,
    kind: "entity",
    title: "Lactobacillus plantarum",
    preview: "A lactic acid bacterium common in vegetable ferments and in the human gut.",
    counts: { notes: 6 }
  },
  [previewAddresses.question]: {
    ...base,
    kind: "question",
    title: "Why do fermented foods keep longer outside the fridge?",
    preview:
      "Because the fermentation itself builds the barrier that protects the food: the acid lowers the pH and the competing microbes crowd out the harmful ones.",
    counts: { answers: 1 }
  }
};

/** An object whose text is not there yet: what the empty state shows. */
const withoutText = (entry: Entry): Entry => {
  const { counts: _counts, ...rest } = entry;
  return { ...rest, preview: "" };
};

function resolveMany(empty: boolean) {
  return ({ addresses }: ObjectResolveManyInput) => {
    const items: Record<string, ObjectResolved> = {};
    for (const requested of addresses) {
      const entry = library[requested];
      if (entry)
        items[requested] = {
          ...(empty ? withoutText(entry) : entry),
          address: requested
        };
    }
    return {
      items,
      missing: addresses.filter((requested) => library[requested] === undefined)
    };
  };
}

/** What the fake `window.app.objects` answers for the card and the sheet. */
export function previewFixtures(empty: boolean) {
  return {
    "objects.resolveMany": resolveMany(empty),
    "objects.backlinks": (): ObjectBacklinksResult => ({
      items: empty
        ? []
        : [previewAddresses.note, previewAddresses.noteTwo, previewAddresses.noteThree].map(
            (from) => ({ from, via: "evidence" as const })
          )
    })
  };
}
