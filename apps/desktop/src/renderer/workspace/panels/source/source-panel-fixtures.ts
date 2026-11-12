import type { ObjectLocateResult, ObjectRef, ObjectSummary } from "@app/domain";

import { sourceDetailSchema, type SourceDetail } from "../../../../shared/ipc";
import type { LibrarySourceProgress } from "../../../../shared/ipc-library";

/**
 * One synthetic source for the Source panel's tests and its screen module: an article that is
 * being turned into notes, with five sections, seven notes (the newest not placed yet), two note
 * connections and a text with pages. The values that depend on the clock (when the run started,
 * when the newest note arrived) are worked out from `now`, so "agora mesmo" is true whenever the
 * fixture is read.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const sourceFixtureAddress = `memora://source/${uuid(1)}`;
export const sourceFixtureTitle = "Complete streets: lessons from two Andean cities";

const minute = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const paragraphs = [
  "Both cities redesigned avenues to share the street between pedestrians, bicycles and buses.",
  "In Bogotá the protected lanes were built first; in Medellín the crossings came before the lanes.",
  "Traffic did not worsen after the car lanes were reduced, and the effect held over three years.",
  "Continuous sidewalks at the corners slowed the cars more than any sign did."
];
const markdown = `# ${sourceFixtureTitle}\n\n${paragraphs.join("\n\n")}\n`;
const chunkIds = paragraphs.map((_, index) => uuid(10 + index));
const spanIds = paragraphs.map((_, index) => uuid(20 + index));

/** The notes, newest first; `age` is how long before `now` each arrived. */
const noteSpecs = [
  ["Protected bike lanes attract more women cyclists", 20_000, 3],
  ["A bus-only lane did not worsen traffic in three years", 2.5 * minute, 2],
  ["Tree cover lowers the pavement temperature by up to 8 °C", 3 * minute, 2],
  ["Crossings every 120 metres raise the use of local shops", 3.5 * minute, 1],
  ["Continuous sidewalks slow the cars at the corners", 4 * minute, 1],
  ["Fewer car lanes did not increase congestion", 4.4 * minute, 0],
  ["Short blocks lengthen the routes people walk", 4.8 * minute, 0]
] as const;

export const noteIds = noteSpecs.map((_, index) => uuid(31 + index));

const topic = (n: number, title: string): ObjectRef => ({ kind: "topic", id: uuid(n), title });
const urbanPath = [topic(100, ""), topic(101, "Urban planning"), topic(102, "Active mobility")];
const transitPath = [...urbanPath, topic(103, "Public transport")];

/** The primary path of each note's place; the newest one has none yet. */
const notePaths = new Map<string, ObjectRef[]>([
  [noteIds[0] as string, []],
  [noteIds[1] as string, transitPath],
  [noteIds[2] as string, urbanPath],
  [noteIds[3] as string, urbanPath],
  [noteIds[4] as string, urbanPath],
  [noteIds[5] as string, urbanPath],
  [noteIds[6] as string, urbanPath]
]);

export function sourceFixture(now: number = Date.now()): SourceDetail {
  const started = now - 5 * minute;
  return sourceDetailSchema.parse({
    id: uuid(1),
    type: "AcademicPaper",
    title: sourceFixtureTitle,
    subtitle: null,
    sourceUri: "https://example.org/complete-streets",
    language: "en",
    summary: null,
    metadata: {
      descriptor: {
        type: "AcademicPaper",
        title: sourceFixtureTitle,
        creators: [{ name: "R. Andrade" }, { name: "L. Quispe" }],
        year: 2023,
        venue: "Journal of Urban Studies",
        volume: "12",
        pageCount: 24,
        language: "en",
        tags: ["streets", "mobility"]
      }
    },
    updatedAt: iso(now),
    history: [{ id: uuid(2), title: sourceFixtureTitle, createdAt: iso(started), isCurrent: true }],
    breadcrumbs: [{ id: uuid(1), title: sourceFixtureTitle }],
    assets: [
      {
        id: uuid(61),
        originalFileName: "complete-streets.pdf",
        mimeType: "application/pdf",
        role: "original"
      }
    ],
    documents: [
      {
        id: uuid(2),
        title: sourceFixtureTitle,
        canonicalMarkdown: markdown,
        language: "en",
        chunks: paragraphs.map((content, index) => {
          const start = markdown.indexOf(content);
          return {
            id: chunkIds[index],
            content,
            chunkIndex: index,
            sourceSpanId: spanIds[index],
            startOffset: start,
            endOffset: start + content.length,
            page: index >= 2 ? 7 + index : null
          };
        }),
        assets: []
      }
    ],
    summaries: [],
    atomicNotes: noteSpecs.map(([title, age], index) => ({
      id: noteIds[index],
      title,
      bodyMarkdown: `${title}.`,
      ideaStatement: `${title}.`,
      language: "en",
      status: "active",
      sourceItemId: uuid(1),
      sourceSpanId: spanIds[index % spanIds.length],
      evidenceChunkId: chunkIds[index % chunkIds.length],
      generationModel: "local-model",
      generationPromptVersion: "v1",
      humanProtected: false,
      createdAt: iso(now - age),
      updatedAt: iso(now - age)
    })),
    graph: { entities: [], relations: [], sourceConnections: [] },
    relations: [
      {
        id: uuid(41),
        sourceAtomicNoteId: noteIds[5],
        targetAtomicNoteId: noteIds[1],
        sourceTitle: noteSpecs[5][0],
        targetTitle: noteSpecs[1][0],
        sourceStatus: "active",
        targetStatus: "active",
        direction: "lo_to_hi",
        relationType: "supports",
        band: "apply",
        calibration: "frozen",
        state: "applied",
        finalScore: 0.9,
        explanation: "Both report that taking lanes from cars did not raise congestion."
      },
      {
        id: uuid(42),
        sourceAtomicNoteId: noteIds[4],
        targetAtomicNoteId: noteIds[3],
        sourceTitle: noteSpecs[4][0],
        targetTitle: noteSpecs[3][0],
        sourceStatus: "active",
        targetStatus: "active",
        direction: "symmetric",
        relationType: "related",
        band: "suggest",
        calibration: "provisional",
        state: "suggested",
        finalScore: 0.7,
        explanation: "Both describe what changes at the corner."
      }
    ]
  });
}

/** The strip's values while the run is writing notes: the design's 7 of about 18, 6 placed. */
export function runningProgress(now: number = Date.now()): NonNullable<LibrarySourceProgress> {
  return {
    run: {
      status: "running",
      stage: "atomicNotes",
      startedAt: iso(now - 5 * minute),
      completedAt: null,
      failedStage: null
    },
    needsYou: null,
    paused: false,
    steps: {
      read: { state: "done", pages: 24 },
      chunks: { state: "done", indexed: 142 },
      notes: { state: "running", soFar: 7, estimate: 18 },
      placed: { state: "running", count: 6 },
      summary: { state: "running" },
      relations: { state: "pending", count: 0 }
    },
    sections: [
      { title: "Introduction", share: 0.1667, notes: 1, state: "done" },
      { title: "Bogotá", share: 0.2333, notes: 3, state: "done" },
      { title: "Medellín", share: 0.2667, notes: 3, state: "reading" },
      { title: "Results", share: 0.2, notes: 0, state: "pending" },
      { title: "Conclusion", share: 0.1333, notes: 0, state: "pending" }
    ]
  };
}

/** A finished run: every step done, the ruler complete. */
export function doneProgress(now: number = Date.now()): NonNullable<LibrarySourceProgress> {
  const running = runningProgress(now);
  return {
    ...running,
    run: {
      ...(running.run as NonNullable<typeof running.run>),
      status: "succeeded",
      completedAt: iso(now - minute)
    },
    steps: {
      read: { state: "done", pages: 24 },
      chunks: { state: "done", indexed: 142 },
      notes: { state: "done", soFar: 18, estimate: 18 },
      placed: { state: "done", count: 18 },
      summary: { state: "done" },
      relations: { state: "done", count: 12 }
    },
    sections: running.sections.map((section) => ({ ...section, state: "done" as const }))
  };
}

const summaryOf = (address: string, empty: boolean): ObjectSummary => ({
  address,
  kind: "source",
  title: empty ? "" : sourceFixtureTitle,
  status: "current",
  preview: empty ? "" : (paragraphs[0] ?? ""),
  updatedAt: iso(Date.now())
});

function located(address: string, empty: boolean): ObjectLocateResult {
  const noteId = [...notePaths.keys()].find((id) => address.endsWith(id));
  const own: ObjectRef = noteId
    ? { kind: "note", id: noteId, title: "" }
    : { kind: "source", id: uuid(1), title: sourceFixtureTitle };
  const path = noteId ? (notePaths.get(noteId) ?? []) : empty ? [] : urbanPath;
  return {
    object: own,
    primaryPath: path.length === 0 ? [] : [...path, own],
    alsoIn: [],
    citedBy: [],
    counts: {
      alsoIn: 0,
      citedBy: 0,
      notes: noteIds.length,
      passages: paragraphs.length,
      children: 0
    }
  };
}

/** What a fake `window.app` answers for the Source panel (success or empty). */
export function sourcePanelFixtures(
  empty: boolean,
  progress: () => LibrarySourceProgress = runningProgress
) {
  return {
    "knowledge.getSourceDetail": () => (empty ? null : sourceFixture()),
    "library.sourceProgress": () => (empty ? null : progress()),
    "library.rows": () => ({ rows: [], total: 48 }),
    "budget.estimateImport": () => ({ billing: "local" }),
    "viewHistory.record": () => undefined,
    "knowledge.listSourceRelations": () => ({ relations: [], hasMore: false, total: 0 }),
    "objects.get": ({ address }: { address: string }) => summaryOf(address, empty),
    "objects.resolveMany": ({ addresses }: { addresses: string[] }) => ({
      items: Object.fromEntries(addresses.map((address) => [address, summaryOf(address, empty)])),
      missing: []
    }),
    "objects.locate": ({ address }: { address: string }) => located(address, empty)
  };
}
