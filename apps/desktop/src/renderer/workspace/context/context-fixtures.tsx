import type { CSSProperties, ReactNode } from "react";
import type { ObjectKind, ObjectLocateResult, ObjectNeighborhood } from "@app/domain";

import { screenTranslator } from "../screen-locale";
import { layoutCustomProperties } from "../shell-model";
import type { ScreenFixtureSet } from "../surfaces";
import { useViewportWidth } from "../use-workspace";

/**
 * What the context panel's screens show: the fermentation fixture of design record §17 as the fake
 * `window.app` answers it, and the stands the screens draw it on. Only the screen modules and the
 * tests import this file. Titles stay English: they stand for the person's own words, and every
 * word of the panel's chrome comes from `@app/i18n`.
 */

export const t = screenTranslator();

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const ids = {
  note: uuid(22),
  source: uuid(11),
  topic: uuid(4),
  question: uuid(31),
  chunk: uuid(41)
};
export const address = (kind: ObjectKind, id: string) => `memora://${kind}/${id}`;
export const focusedNote = {
  kind: "note" as const,
  id: ids.note,
  address: address("note", ids.note)
};

const topic = (n: number, title: string) => ({ kind: "topic" as const, id: uuid(n), title });
// A read path lists the topics above the object, root first, without the untitled root.
const path = (...titles: string[]) => titles.map((title, index) => topic(60 + index, title));

/** One related note: its ID, title and the topics above it (the root left out by the read). */
interface Other {
  n: number;
  title: string;
  crumbs: string[];
}
const others: Record<string, Other> = {
  salt: {
    n: 101,
    title: "In the 19th century, salt and acidity kept food without ice",
    crumbs: ["History of science", "Food preservation"]
  },
  yoghurt: {
    n: 102,
    title: "Plain yoghurt keeps for weeks",
    crumbs: ["Nutrition", "Fermented foods"]
  },
  temperature: {
    n: 103,
    title: "Temperature controls the final acidity",
    crumbs: ["Life sciences", "Microbiology", "Fermentation", "Lactic fermentation"]
  },
  tolerate: {
    n: 104,
    title: "Lactic acid bacteria tolerate an acid medium",
    crumbs: ["Life sciences", "Microbiology", "Fermentation", "Lactic fermentation"]
  },
  barriers: {
    n: 105,
    title: "Preservation by multiple barriers",
    crumbs: ["Life sciences", "Microbiology"]
  },
  kefir: {
    n: 106,
    title: "Kefir inhibits Salmonella in laboratory tests",
    crumbs: ["Life sciences", "Microbiology", "Immunology"]
  }
};

const relation = (
  n: number,
  other: Other,
  fields: {
    type: string;
    direction: "outgoing" | "incoming" | "unknown";
    state: "applied" | "suggested" | "kept";
    probability: number | null;
    decided?: boolean;
  }
) => ({
  id: uuid(200 + n),
  type: fields.type,
  direction: fields.direction,
  directionSource: fields.direction === "unknown" ? null : "decider",
  state: fields.state,
  band: fields.state === "suggested" ? "suggest" : "apply",
  calibration: "frozen",
  probability: fields.probability,
  vetoSource: null,
  decidedBy: fields.decided === false ? null : { model: "local", kind: "local" },
  typedBy: null,
  explainedBy: null,
  explanation: null,
  other: {
    id: uuid(other.n),
    title: other.title,
    ideaStatement: other.title,
    language: "en",
    status: "current",
    superseded: false,
    authorship: "ai",
    sourceItemId: ids.source,
    sourceTitle: "Food microbiology, ch. 3",
    passage: null
  }
});

/** Five shown connections and one suggestion that the Inbox also holds (below the "alta" band). */
export const relations = [
  relation(1, others.salt!, {
    type: "supports",
    direction: "incoming",
    state: "applied",
    probability: 0.91
  }),
  relation(2, others.yoghurt!, {
    type: "supports",
    direction: "incoming",
    state: "kept",
    probability: null
  }),
  relation(3, others.temperature!, {
    type: "extends",
    direction: "outgoing",
    state: "applied",
    probability: 0.88
  }),
  relation(4, others.tolerate!, {
    type: "depends_on",
    direction: "outgoing",
    state: "applied",
    probability: 0.72
  }),
  relation(5, others.barriers!, {
    type: "example_of",
    direction: "outgoing",
    state: "kept",
    probability: null
  }),
  relation(6, others.kefir!, {
    type: "supports",
    direction: "incoming",
    state: "suggested",
    probability: 0.64
  })
];

const summary = (kind: ObjectKind, id: string, title: string, crumbs: string[], preview = "") => ({
  address: address(kind, id),
  kind,
  title,
  status: "current",
  preview,
  updatedAt: "2026-11-03T10:00:00.000Z",
  path: crumbs.length > 0 ? path(...crumbs) : []
});

/** `resolveMany` answers the addresses it is asked: the related notes, and anything else by kind. */
const resolveMany = (input: { addresses: string[] }) => {
  const items: Record<string, unknown> = {};
  for (const requested of input.addresses) {
    const other = Object.values(others).find(
      (entry) => requested === address("note", uuid(entry.n))
    );
    if (other) {
      items[requested] = summary("note", uuid(other.n), other.title, other.crumbs);
      continue;
    }
    if (requested.startsWith("memora://question/"))
      items[requested] = summary(
        "question",
        requested.slice(-36),
        "Why do fermented foods keep longer outside the fridge?",
        []
      );
    else if (requested.startsWith("memora://topic/"))
      items[requested] = summary("topic", requested.slice(-36), "Fermentation", [
        "Life sciences",
        "Microbiology"
      ]);
    else if (requested.startsWith("memora://source/"))
      items[requested] = summary(
        "source",
        requested.slice(15, 51),
        "Food microbiology, ch. 3",
        [],
        "At a pH below 4.2 the growth of common pathogens is practically inhibited, which explains the stability of fermented vegetables."
      );
  }
  return { items, missing: [] as string[] };
};

const located: ObjectLocateResult = {
  object: {
    kind: "note",
    id: ids.note,
    title: "Lactic acid inhibits pathogens by lowering the pH"
  },
  primaryPath: [
    topic(1, ""),
    topic(2, "Life sciences"),
    topic(3, "Microbiology"),
    topic(5, "Fermentation"),
    topic(4, "Lactic fermentation"),
    { kind: "note", id: ids.note, title: "Lactic acid inhibits pathogens by lowering the pH" }
  ],
  alsoIn: [topic(7, "Fermented foods")],
  citedBy: [topic(4, "Lactic fermentation")],
  counts: { alsoIn: 2, citedBy: 1, notes: 0, passages: 2, children: 0 }
};

const evidence = (empty: boolean) => ({
  note: {
    id: ids.note,
    title: "Lactic acid inhibits pathogens by lowering the pH",
    ideaStatement: "Lactic acid lowers the pH and keeps pathogens from growing.",
    bodyMarkdown: "x",
    language: "en",
    status: "current",
    superseded: false,
    ownership: "source",
    humanProtected: false,
    authorship: "ai",
    generationModel: "local model",
    homeSourceId: ids.source,
    createdAt: "2026-11-03T21:14:00.000Z",
    updatedAt: "2026-11-03T21:14:00.000Z",
    reviewedAt: null,
    lastEditedAt: null
  },
  successors: [],
  evidence: empty
    ? { items: [], total: 0 }
    : {
        items: [
          passage(
            1,
            "…at a pH below 4.2 the growth of common pathogens is practically inhibited, which explains the stability of fermented vegetables…",
            47,
            12
          ),
          passage(
            2,
            "Sauerkraut, well salted and well soured, got through the winter in cellars without ice and without spoiling.",
            112,
            20
          )
        ],
        total: 2
      },
  placement: located,
  relations: { items: [], total: 0 },
  withdrawn: { items: [], total: 0 },
  earlierVersions: { items: [], total: 0 }
});

const passage = (n: number, excerpt: string, page: number, index: number) => ({
  chunkId: uuid(40 + n),
  sourceItemId: ids.source,
  documentId: uuid(50),
  sourceSpanId: null,
  sourceTitle: n === 1 ? "Food microbiology, ch. 3" : "Preserves and brines in the 19th century",
  workTitle: null,
  chunkIndex: index,
  range: null,
  page,
  excerpt,
  language: "en",
  primary: n === 1,
  current: true,
  sourceAvailable: true
});

const backlinks = (empty: boolean) => ({
  items: empty
    ? []
    : [
        {
          from: address("topic", uuid(4)),
          via: "overview_citation",
          snippet: "Acidity alone is not enough: salt and the lack of oxygen complete the barrier."
        },
        {
          from: address("question", ids.question),
          via: "question_citation",
          anchor: `passage=${ids.chunk}`,
          snippet: "Why do fermented foods keep longer outside the fridge?"
        }
      ]
});

const neighborhood = (empty: boolean): ObjectNeighborhood => {
  const node = (n: number, title: string, depth: 0 | 1) => ({
    id: n === 0 ? ids.note : uuid(n),
    kind: "note" as const,
    title,
    ideaStatement: title,
    language: "en",
    depth
  });
  if (empty)
    return {
      focus: ids.note,
      depth: 1,
      nodes: [node(0, "Lactic acid inhibits pathogens by lowering the pH", 0)],
      edges: [],
      neighbourTotal: 0,
      truncated: false
    };
  const nodes = [
    node(0, "Lactic acid inhibits pathogens by lowering the pH", 0),
    node(101, others.salt!.title, 1),
    node(103, others.temperature!.title, 1),
    node(104, others.tolerate!.title, 1),
    node(105, others.barriers!.title, 1)
  ];
  const edge = (
    n: number,
    other: number,
    type: string,
    direction: "lo_to_hi" | "hi_to_lo" | "unknown"
  ) => {
    const lo = ids.note < uuid(other) ? ids.note : uuid(other);
    const hi = ids.note < uuid(other) ? uuid(other) : ids.note;
    return {
      id: uuid(300 + n),
      lo,
      hi,
      direction,
      type,
      state: "applied" as const,
      band: "apply" as const
    };
  };
  return {
    focus: ids.note,
    depth: 1,
    nodes,
    edges: [
      edge(1, 101, "supports", "unknown"),
      edge(2, 103, "extends", "unknown"),
      edge(3, 104, "depends_on", "unknown"),
      edge(4, 105, "example_of", "unknown")
    ],
    neighbourTotal: 4,
    truncated: false
  };
};

/** The calls the context panel's screens make, for the note in focus. */
export function contextFixtures(empty: boolean): ScreenFixtureSet {
  return {
    "notes.relations": () => ({
      items: empty ? [] : relations,
      total: empty ? 0 : relations.length
    }),
    "notes.page": () => evidence(empty),
    "objects.resolveMany": resolveMany,
    "objects.locate": () => located,
    "objects.backlinks": () => backlinks(empty),
    "objects.neighborhood": () => neighborhood(empty),
    "relations.review": () => ({ relationId: relations[5]!.id, outcome: "kept", changed: true })
  };
}

/** A column as wide as the context panel at this window, on the desk colour. */
export function ContextColumn({ children }: { children: ReactNode }) {
  const width = useViewportWidth();
  return (
    <div
      className="flex h-full justify-end bg-background"
      style={layoutCustomProperties(width) as CSSProperties}
    >
      <div className="h-full w-(--ctx-w) flex-none overflow-y-auto border-l border-border bg-background px-4 pt-4 pb-8">
        {children}
      </div>
    </div>
  );
}
