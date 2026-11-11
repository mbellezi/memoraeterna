import { sourceDetailSchema } from "../../../../shared/ipc";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const paragraphs = ["First paragraph of the document.", "Second paragraph, the cited one."];
const markdown = `# A book\n\n${paragraphs.join("\n\n")}\n`;

export const sourceFixtureIds = {
  source: id(1),
  document: id(2),
  chunks: [id(11), id(12)],
  spans: [id(21), id(22)],
  note: id(31),
  otherNote: id(32),
  relation: id(41),
  child: id(51)
} as const;

/** One source with every part the Source page draws, for the parity and part tests. */
export function sourceFixture() {
  return sourceDetailSchema.parse({
    id: sourceFixtureIds.source,
    type: "Book",
    title: "A book",
    subtitle: "A subtitle",
    sourceUri: "https://example.org/book",
    language: "en",
    summary: "What the book says.",
    metadata: {
      summaryStale: true,
      descriptor: { type: "Book", title: "A book", tags: ["one", "two"], publisher: "Press" }
    },
    updatedAt: "2026-10-14T10:00:00.000Z",
    history: [
      { id: id(2), title: "A book", createdAt: "2026-10-14T10:00:00.000Z", isCurrent: true }
    ],
    breadcrumbs: [{ id: id(1), title: "A book" }],
    assets: [
      { id: id(61), originalFileName: "book.pdf", mimeType: "application/pdf", role: "original" },
      { id: id(62), originalFileName: "cover.png", mimeType: "image/png", role: "cover" }
    ],
    documents: [
      {
        id: sourceFixtureIds.document,
        title: "A book",
        canonicalMarkdown: markdown,
        language: "en",
        chunks: paragraphs.map((content, index) => {
          const start = markdown.indexOf(content);
          return {
            id: sourceFixtureIds.chunks[index]!,
            content,
            chunkIndex: index,
            sourceSpanId: sourceFixtureIds.spans[index]!,
            startOffset: start,
            endOffset: start + content.length,
            page: index === 1 ? 7 : null
          };
        }),
        assets: [
          {
            id: id(61),
            originalFileName: "book.pdf",
            mimeType: "application/pdf",
            role: "original"
          }
        ]
      }
    ],
    summaries: [
      {
        id: id(71),
        summary: "An earlier summary.",
        provider: "local",
        model: "model-a",
        promptVersion: "v1",
        generatedAt: "2026-10-13T10:00:00.000Z"
      }
    ],
    atomicNotes: [
      {
        id: sourceFixtureIds.note,
        title: "A note",
        bodyMarkdown: "Body.",
        ideaStatement: "An idea.",
        language: "en",
        status: "pending_review",
        sourceItemId: sourceFixtureIds.source,
        sourceSpanId: null,
        evidenceChunkId: sourceFixtureIds.chunks[0],
        generationModel: "model-a",
        generationPromptVersion: "v1",
        humanProtected: false,
        createdAt: "2026-10-14T10:00:00.000Z",
        updatedAt: "2026-10-14T10:00:00.000Z"
      }
    ],
    graph: {
      entities: [{ id: id(81), type: "Concept", name: "An entity", confidence: 0.8 }],
      relations: [],
      sourceConnections: []
    },
    relations: [
      {
        id: sourceFixtureIds.relation,
        sourceAtomicNoteId: sourceFixtureIds.note,
        targetAtomicNoteId: sourceFixtureIds.otherNote,
        sourceTitle: "A note",
        targetTitle: "Another note",
        sourceStatus: "pending_review",
        targetStatus: "approved",
        direction: "lo_to_hi",
        relationType: "supports",
        band: "apply",
        calibration: "frozen",
        state: "applied",
        finalScore: 0.9,
        explanation: "They agree."
      }
    ]
  });
}
