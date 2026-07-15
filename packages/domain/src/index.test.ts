import { describe, expect, it } from "vitest";

import {
  AtomicNoteGenerationOutputSchema,
  AtomicNoteRelationSchema,
  AtomicNoteSchema,
  DocumentSchema,
  IngestionRunSchema,
  ObsidianSyncFileSchema,
  SourceItemSchema,
  SourceItemTypes,
  StorageSettingsSchema
} from "./index.js";

const now = "2026-07-05T12:00:00.000Z";
const later = "2026-07-05T12:30:00.000Z";
const hash =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const validSourceItem = {
  id: "src_01JABCDEF123456789",
  type: "WebArticle",
  title: "Local-first memory systems",
  sourceOrigin: "web_capture",
  originalUri: "https://example.com/memory",
  contentHash: hash,
  language: "en",
  metadata: {
    author: "Example Author"
  },
  createdAt: now,
  updatedAt: now
} as const;

const validDocument = {
  id: "doc_01JABCDEF123456789",
  sourceItemId: validSourceItem.id,
  sourceType: validSourceItem.type,
  title: validSourceItem.title,
  originalUri: validSourceItem.originalUri,
  contentHash: hash,
  language: "en",
  markdownContent: "# Local-first memory systems\n\nEvidence stays local.",
  markdownHash: hash,
  conversionStatus: "converted",
  metadata: {},
  createdAt: now,
  updatedAt: now
} as const;

const validAtomicNote = {
  id: "an_01JABCDEF123456789",
  title: "Local-first systems preserve provenance",
  bodyMarkdown: "Local-first systems can keep evidence close to the user.",
  ideaStatement: "Local-first systems preserve provenance by default.",
  language: "en",
  status: "pending_review",
  createdFromSourceItemId: validSourceItem.id,
  generationModel: "gemini-example",
  generationPromptVersion: "atomic-note-v1",
  metadata: {},
  createdAt: now,
  updatedAt: now
} as const;

describe("@app/domain schemas", () => {
  it("keeps the hierarchical SourceItem type taxonomy exact", () => {
    expect(SourceItemTypes).toEqual([
      "PersonalNote",
      "DailyNote",
      "WebArticle",
      "Book",
      "BookChapter",
      "PeriodicalIssue",
      "AcademicPaper",
      "DocumentSection",
      "StandaloneArticle",
      "Video",
      "GenericDocument"
    ]);
  });

  it("parses valid core domain payloads", () => {
    expect(SourceItemSchema.parse(validSourceItem)).toEqual(validSourceItem);
    expect(DocumentSchema.parse(validDocument)).toEqual(validDocument);
    expect(AtomicNoteSchema.parse(validAtomicNote)).toEqual(validAtomicNote);
  });

  it("rejects invalid SourceItem type values", () => {
    const invalid = {
      ...validSourceItem,
      type: "PodcastEpisode"
    };

    expect(SourceItemSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects invalid spans and self-relations", () => {
    const invalidRelation = {
      id: "anr_01JABCDEF123456789",
      sourceAtomicNoteId: validAtomicNote.id,
      targetAtomicNoteId: validAtomicNote.id,
      relationType: "related",
      finalScore: 0.8,
      status: "pending_review",
      createdAt: now
    };

    expect(AtomicNoteRelationSchema.safeParse(invalidRelation).success).toBe(
      false
    );
  });

  it("validates structured atomic note generation output", () => {
    expect(AtomicNoteGenerationOutputSchema.parse({
      notes: [{
        title: "One idea",
        bodyMarkdown: "A self-contained explanation.",
        ideaStatement: "One source idea becomes one note.",
        evidenceChunkIds: ["chunk_01JABCDEF123456789"]
      }]
    }).notes).toHaveLength(1);

    expect(AtomicNoteGenerationOutputSchema.safeParse({
      notes: [{ title: "Missing evidence", bodyMarkdown: "Body", ideaStatement: "Idea", evidenceChunkIds: [] }]
    }).success).toBe(false);
  });

  it("rejects storage settings that enable paths without configured roots", () => {
    const invalid = {
      id: "storage_01JABCDEF123456789",
      obsidianRootFolder: "Memora",
      obsidianSyncEnabled: true,
      obsidianDeletePolicy: "tombstone",
      copyUploadedFilesEnabled: true,
      createdAt: now,
      updatedAt: now
    };

    expect(StorageSettingsSchema.safeParse(invalid).success).toBe(false);
  });

  it("serializes and deserializes main domain types", () => {
    const ingestionRun = {
      id: "ir_01JABCDEF123456789",
      sourceItemId: validSourceItem.id,
      status: "running",
      currentStage: "chunking",
      stagesCheckpoint: {
        conversion: {
          status: "completed",
          completedAt: now,
          metadata: {}
        }
      },
      startedAt: now,
      createdAt: now,
      updatedAt: later
    } as const;

    const syncFile = {
      id: "sync_01JABCDEF123456789",
      memoraId: validAtomicNote.id,
      entityType: "atomic_note",
      entityId: validAtomicNote.id,
      sourceItemId: validSourceItem.id,
      documentId: validDocument.id,
      vaultRelativePath: "Memora/Atomic/local-first.md",
      frontmatterHash: hash,
      contentHash: hash,
      fileMtime: later,
      syncVersion: 1,
      syncStatus: "pending",
      lastSeenAt: later,
      createdAt: now,
      updatedAt: later
    } as const;

    const payloads = [
      [SourceItemSchema, validSourceItem],
      [DocumentSchema, validDocument],
      [AtomicNoteSchema, validAtomicNote],
      [IngestionRunSchema, ingestionRun],
      [ObsidianSyncFileSchema, syncFile]
    ] as const;

    for (const [schema, payload] of payloads) {
      const serialized = JSON.stringify(schema.parse(payload));
      expect(schema.parse(JSON.parse(serialized))).toEqual(payload);
    }
  });
});
