import type { ObjectLocateResult } from "@app/domain";

import type { EntityMention, EntityPage, EntitiesPageInput } from "../../../../shared/ipc-entities";

/**
 * One synthetic entity for the Entity panel's screen and tests (design record §17's fermentation
 * fixture): Lactobacillus, mentioned in 11 notes of 4 sources, 8 of them on the first page so the
 * "show more" row and the partial sources line show. The titles stand for the person's own content
 * and stay in English; every word of the app around them comes from `@app/i18n`.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const entityFixture = {
  id: uuid(41),
  address: `memora://entity/${uuid(41)}`,
  noteAddress: `memora://note/${uuid(101)}`
} as const;

const topicIds = { lactic: uuid(5), immunology: uuid(6), fermented: uuid(7) } as const;
const sourceIds = { micro: uuid(11), kefir: uuid(12), gut: uuid(13), dairy: uuid(14) } as const;

const mention = (
  n: number,
  title: string,
  source: keyof typeof sourceIds,
  sourceTitle: string,
  topic: { id: string; title: string; notes: number } | null
): EntityMention => ({
  noteId: uuid(100 + n),
  title,
  sourceId: sourceIds[source],
  sourceTitle,
  topicId: topic?.id ?? null,
  topicTitle: topic?.title ?? "",
  topicNotes: topic?.notes ?? 0
});

const lactic = { id: topicIds.lactic, title: "Lactic fermentation", notes: 6 };
const immunology = { id: topicIds.immunology, title: "Immunology", notes: 3 };
const fermented = { id: topicIds.fermented, title: "Fermented foods", notes: 2 };

const micro = "Food microbiology, ch. 3";
const kefir = "Kefir and kombucha at home";
const gut = "The gut and its tenants";

const firstItems: EntityMention[] = [
  mention(1, "Lactic acid inhibits pathogens by lowering the pH", "micro", micro, lactic),
  mention(2, "Kefir joins bacteria and yeasts in one colony", "kefir", kefir, lactic),
  mention(3, "Lactic acid bacteria tolerate an acid medium", "micro", micro, lactic),
  mention(4, "Temperature controls the final acidity", "micro", micro, lactic),
  mention(5, "Sauerkraut starts with a salt brine, not with a starter", "kefir", kefir, lactic),
  mention(
    6,
    "Lactobacillus strains outcompete spoilage bacteria in the first days",
    "micro",
    micro,
    lactic
  ),
  mention(7, "Kefir lowers Salmonella counts in laboratory tests", "gut", gut, immunology),
  mention(8, "Strains differ in how they reach the colon alive", "gut", gut, immunology)
];

const secondItems: EntityMention[] = [
  mention(9, "Probiotic claims need a named strain", "gut", gut, immunology),
  mention(10, "Natural yoghurt keeps for weeks", "kefir", kefir, fermented),
  mention(
    11,
    "Heat-treated ferments carry no live cultures",
    "dairy",
    "Dairy chemistry primer",
    fermented
  )
];

const header: EntityPage["entity"] = {
  id: entityFixture.id,
  type: "Concept",
  canonicalName: "Lactobacillus",
  aliases: ["lactobacilli", "Lactobacillus", "lactic acid bacteria"],
  description:
    "A genus of rod-shaped bacteria that turn sugars into lactic acid. They set the sour taste of yoghurt, sauerkraut and kefir.",
  language: "en"
};

const firstPage: EntityPage = {
  entity: header,
  counts: { notes: 11, sources: 4 },
  mentions: { items: firstItems, next: "cursor-2" },
  topics: {
    primary: [
      { kind: "topic", id: uuid(1), title: "" },
      { kind: "topic", id: uuid(2), title: "Life sciences" },
      { kind: "topic", id: uuid(3), title: "Microbiology" },
      { kind: "topic", id: topicIds.lactic, title: "Lactic fermentation" }
    ],
    alsoIn: [
      { kind: "topic", id: topicIds.immunology, title: "Immunology" },
      { kind: "topic", id: topicIds.fermented, title: "Fermented foods" }
    ],
    alsoInCount: 2
  },
  coMentioned: [
    { id: uuid(42), type: "Person", canonicalName: "Louis Pasteur", sharedNotes: 4 },
    { id: uuid(43), type: "Concept", canonicalName: "Lactic acid", sharedNotes: 3 },
    { id: uuid(44), type: "Concept", canonicalName: "Kefir", sharedNotes: 1 }
  ]
};

const secondPage: EntityPage = {
  entity: header,
  counts: { notes: 11, sources: 4 },
  mentions: { items: secondItems }
};

const emptyPage: EntityPage = {
  entity: { ...header, description: null, aliases: ["lactobacilli"] },
  counts: { notes: 0, sources: 0 },
  mentions: { items: [] },
  topics: { primary: [], alsoIn: [], alsoInCount: 0 },
  coMentioned: []
};

/** The fixtures of the success and the empty state of the panel and its frame's ribbon. */
export function entityFixtures(empty: boolean) {
  const located: ObjectLocateResult = {
    object: { kind: "entity", id: entityFixture.id, title: header.canonicalName },
    primaryPath: empty
      ? [{ kind: "entity", id: entityFixture.id, title: header.canonicalName }]
      : [
          ...(firstPage.topics?.primary ?? []),
          { kind: "entity", id: entityFixture.id, title: header.canonicalName }
        ],
    alsoIn: empty ? [] : (firstPage.topics?.alsoIn ?? []),
    citedBy: [],
    counts: { alsoIn: empty ? 0 : 2, citedBy: 0, notes: empty ? 0 : 11, passages: 0, children: 0 }
  };
  return {
    "entities.page": ({ cursor }: EntitiesPageInput) =>
      empty ? emptyPage : cursor === undefined ? firstPage : secondPage,
    "objects.locate": () => located
  };
}

export {
  emptyPage as entityEmptyPage,
  firstPage as entityFirstPage,
  secondPage as entitySecondPage
};
