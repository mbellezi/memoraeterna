import type { ObjectResolved } from "@app/domain";

import type { HomeDigest } from "../../../../shared/ipc-home";
import { item, summary, uuid } from "../../../components/inbox/inbox-fixtures";

/**
 * Home's digest as the tests and the screens tool read it: the design record's day (§17 fixture):
 * three sources arrived since yesterday evening, one still generating, nine changes by the Jardineiro,
 * three decisions and the tree with Nutrição too big. Titles are the person's own content, so they
 * stay in Portuguese in every language.
 */

/** `hours` before `now`, as the ISO text the digest uses. */
export const hoursBefore = (now: number, hours: number): string =>
  new Date(now - hours * 3_600_000).toISOString();

const topic = (n: number, title: string) => ({ kind: "topic" as const, id: uuid(n), title });

const resolved = (
  kind: ObjectResolved["kind"],
  n: number,
  title: string,
  extra: Partial<ObjectResolved> = {}
): ObjectResolved => ({
  address: `memora://${kind}/${uuid(n)}`,
  kind,
  title,
  status: "current",
  preview: "",
  updatedAt: "2026-11-11T09:00:00.000Z",
  ...extra
});

export const ids = {
  generatingSource: uuid(101),
  placedSource: uuid(102),
  deepSource: uuid(103),
  question: uuid(201)
} as const;

export function homeDigest(
  now: number,
  options: { calm?: boolean; firstRun?: boolean } = {}
): HomeDigest {
  const empty = options.firstRun === true;
  const calm = options.calm === true;
  const since = hoursBefore(now, 26);
  const shape = {
    hasTree: !empty,
    notes: empty ? 0 : 412,
    topics: empty ? 0 : 38,
    depth: empty ? 0 : 4,
    violations: { hard: 1, soft: 0 },
    outOfBounds: 1,
    arrivalsThisWeek: calm ? 0 : 41,
    roots: empty
      ? []
      : [
          {
            id: uuid(1),
            title: "Ciências da vida",
            notes: 128,
            topics: 11,
            health: "good" as const
          },
          { id: uuid(2), title: "Nutrição", notes: 96, topics: 9, health: "violation" as const },
          {
            id: uuid(3),
            title: "Planejamento urbano",
            notes: 84,
            topics: 8,
            health: "good" as const
          },
          { id: uuid(4), title: "Teoria musical", notes: 70, topics: 6, health: "good" as const },
          {
            id: uuid(5),
            title: "História da ciência",
            notes: 34,
            topics: 4,
            health: "attention" as const
          }
        ]
  };
  const trail = [
    {
      address: `memora://note/${uuid(303)}`,
      kind: "note" as const,
      title: "O ácido lático inibe patógenos ao baixar o pH",
      parentAddress: `memora://topic/${uuid(12)}`,
      openedAt: hoursBefore(now, 23.5),
      summary: resolved("note", 303, "O ácido lático inibe patógenos ao baixar o pH")
    },
    {
      address: `memora://topic/${uuid(12)}`,
      kind: "topic" as const,
      title: "Fermentação lática",
      parentAddress: null,
      openedAt: hoursBefore(now, 23.7),
      summary: resolved("topic", 12, "Fermentação lática")
    },
    {
      address: `memora://source/${uuid(302)}`,
      kind: "source" as const,
      title: "Microbiologia dos alimentos, cap. 3",
      parentAddress: null,
      openedAt: hoursBefore(now, 23.9),
      summary: resolved("source", 302, "Microbiologia dos alimentos, cap. 3")
    }
  ];
  return {
    since,
    firstRun: empty,
    continue: empty ? [] : trail,
    new:
      calm || empty
        ? {
            sources: { total: 0, items: [] },
            notes: { total: 0, placed: 0, unplaced: 0, items: [] }
          }
        : {
            sources: {
              total: 3,
              items: [
                {
                  createdAt: hoursBefore(now, 2),
                  object: resolved(
                    "source",
                    101,
                    "Ruas completas: lições de duas cidades andinas",
                    {
                      counts: { notes: 7, passages: 40 },
                      path: []
                    }
                  )
                },
                {
                  createdAt: hoursBefore(now, 5),
                  object: resolved("source", 102, "Ritmo e síncope no choro", {
                    counts: { notes: 9, passages: 31 },
                    path: [topic(1, ""), topic(4, "Teoria musical"), topic(41, "Ritmo")]
                  })
                },
                {
                  createdAt: hoursBefore(now, 24),
                  object: resolved("source", 103, "Kefir e kombucha em casa", {
                    counts: { notes: 14, passages: 52 },
                    path: [
                      topic(1, ""),
                      topic(9, "Ciências da vida"),
                      topic(10, "Microbiologia"),
                      topic(11, "Fermentação"),
                      topic(12, "Fermentação lática")
                    ]
                  })
                }
              ]
            },
            notes: { total: 30, placed: 29, unplaced: 1, items: [] }
          },
    inbox:
      calm || empty
        ? { total: 0, top: [] }
        : {
            total: 3,
            top: [
              {
                kind: "review",
                id: `topic:${uuid(901)}`,
                risk: "high",
                at: hoursBefore(now, 8),
                item: item("review", {
                  id: `topic:${uuid(901)}`,
                  variant: "topic",
                  changeSet: summary({
                    kind: "topic",
                    id: uuid(901),
                    titleKey: "topics.changeSets.proposal",
                    titleParams: { items: 85 }
                  }),
                  objects: [{ kind: "topic", id: uuid(2), title: "Nutrição" }]
                })
              },
              {
                kind: "contradiction",
                id: uuid(20),
                risk: "medium",
                at: hoursBefore(now, 10),
                item: item("contradiction", {
                  objects: [
                    { kind: "note", id: uuid(21), title: "Gordura saturada eleva o LDL (2014)" },
                    { kind: "note", id: uuid(22), title: "Gordura saturada e coração (2020)" }
                  ]
                })
              },
              {
                kind: "duplicate",
                id: uuid(40),
                risk: "low",
                at: hoursBefore(now, 12),
                item: item("duplicate", {
                  objects: [
                    { kind: "note", id: uuid(41), title: "Kefir de água" },
                    { kind: "note", id: uuid(42), title: "Kefir de água em casa" }
                  ]
                })
              }
            ]
          },
    questions: empty
      ? []
      : [
          {
            id: ids.question,
            text: "Por que a acidez impede o crescimento de bactérias patogênicas?",
            scope: { kind: "topic", topicId: uuid(12) },
            status: "complete" as const,
            createdAt: hoursBefore(now, 22),
            answerCount: 1
          },
          {
            id: uuid(202),
            text: "Quais fontes falam de síncope no choro?",
            scope: { kind: "library" },
            status: "complete" as const,
            createdAt: hoursBefore(now, 30),
            answerCount: 1
          }
        ],
    growth: [],
    shape,
    gardener:
      calm || empty
        ? { count: 0, top: [] }
        : {
            count: 9,
            top: [
              summary({
                kind: "topic",
                id: uuid(801),
                titleKey: "topics.changeSets.place",
                titleParams: { items: 30 },
                risk: "low",
                status: "applied",
                undo: "available",
                at: hoursBefore(now, 1)
              }),
              summary({
                kind: "topic",
                id: uuid(802),
                titleKey: "topics.changeSets.rebalance",
                titleParams: { operations: 3, items: 22 },
                risk: "medium",
                status: "applied",
                undo: "blocked",
                at: hoursBefore(now, 3)
              }),
              summary({
                kind: "topic",
                id: uuid(803),
                titleKey: "topics.changeSets.naming",
                titleParams: { topics: 2 },
                risk: "low",
                status: "applied",
                undo: "available",
                at: hoursBefore(now, 6)
              })
            ]
          }
  };
}
