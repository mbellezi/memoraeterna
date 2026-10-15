import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRecord, PgPool } from "@app/db";

import type { AiService } from "../ai-service.js";
import { JobSupervisor } from "../job-supervisor.js";
import { KnowledgeService } from "../knowledge-service.js";
import type { TopicChangeHooks } from "./topic-hooks.js";

/**
 * The call sites of the topic hooks (T15b) that need no database: a discarded note leaves the
 * tree, an edit waits for its new vector, and the `note-embedding` job hands its note over once it
 * has one. The sites on a real schema (deletion, chunk replacement, the composite vector) are in
 * `topic-hooks.sidecar.test.ts`.
 */
const mocks = vi.hoisted(() => ({
  notes: { review: vi.fn() },
  jobs: {
    recoverInterrupted: vi.fn(),
    claimNext: vi.fn(),
    update: vi.fn(),
    reportProgress: vi.fn()
  }
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createAtomicNoteRepository: () => mocks.notes,
  createJobRepository: () => mocks.jobs
}));

const noteId = "55555555-5555-4555-8555-555555555555";
const note = {
  id: noteId,
  title: "Spacing",
  bodyMarkdown: "Body",
  ideaStatement: "Idea",
  status: "rejected",
  supersessionStatus: "current",
  metadata: {},
  createdFromSourceItemId: "11111111-1111-4111-8111-111111111111",
  updatedAt: new Date("2026-10-15T10:00:00Z"),
  createdAt: new Date("2026-10-15T09:00:00Z")
};

function hooks() {
  return {
    notesChanged: vi.fn(async () => undefined),
    sourcesChanged: vi.fn(async () => undefined),
    itemsRemoved: vi.fn(async () => undefined)
  } satisfies TopicChangeHooks;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("reviewing a note", () => {
  function knowledge(topicHooks?: TopicChangeHooks) {
    return new KnowledgeService({
      getPool: () => ({}) as PgPool,
      aiService: {} as unknown as AiService,
      userDataPath: "/tmp/test",
      getStorageSettings: async () => ({}) as never,
      getUploadedFilesBasePath: async () => null,
      ...(topicHooks ? { topicHooks } : {})
    });
  }

  it("takes a discarded note out of the topic tree", async () => {
    mocks.notes.review.mockResolvedValue(note);
    const sink = hooks();
    await knowledge(sink).reviewNote({ id: noteId, action: "discard" });
    expect(sink.notesChanged).toHaveBeenCalledOnce();
    expect(sink.notesChanged).toHaveBeenCalledWith([noteId]);
  });

  it("leaves an edit to the note-embedding job and an approval to nobody", async () => {
    mocks.notes.review.mockResolvedValue({ ...note, status: "approved" });
    const sink = hooks();
    await knowledge(sink).reviewNote({ id: noteId, action: "approve" });
    await knowledge(sink).reviewNote({ id: noteId, action: "edit", title: "Spacing, edited" });
    expect(sink.notesChanged).not.toHaveBeenCalled();
  });

  it("hands over nothing for a note that does not exist, and works without hooks", async () => {
    mocks.notes.review.mockResolvedValueOnce(null).mockResolvedValueOnce(note);
    const sink = hooks();
    await expect(knowledge(sink).reviewNote({ id: noteId, action: "discard" })).resolves.toBeNull();
    expect(sink.notesChanged).not.toHaveBeenCalled();
    await expect(knowledge().reviewNote({ id: noteId, action: "discard" })).resolves.toMatchObject({
      id: noteId
    });
  });
});

describe("the note-embedding job", () => {
  async function runEmbeddingJob(
    result: { embedded: boolean; reason?: string },
    topicHooks?: TopicChangeHooks
  ) {
    const embedAtomicNote = vi.fn(async () => result);
    const supervisor = new JobSupervisor({
      getPool: () => ({}) as PgPool,
      knowledgeService: { embedAtomicNote } as unknown as KnowledgeService,
      ...(topicHooks ? { topicHooks } : {})
    });
    mocks.jobs.claimNext.mockResolvedValue({
      id: "job",
      type: "note-embedding",
      attempts: 1,
      maxAttempts: 3,
      progress: 0,
      payload: { atomicNoteId: noteId }
    } satisfies Partial<JobRecord>);
    mocks.jobs.update.mockResolvedValue({ id: "job" });
    await supervisor.runOnce();
    expect(embedAtomicNote).toHaveBeenCalledOnce();
    await supervisor.stop();
  }

  it("hands its note to the topic tree once the new vector is stored", async () => {
    const sink = hooks();
    await runEmbeddingJob({ embedded: true }, sink);
    expect(sink.notesChanged).toHaveBeenCalledOnce();
    expect(sink.notesChanged).toHaveBeenCalledWith([noteId]);
  });

  it("also hands over a note that is gone or no longer current: the tree repairs or unplaces it", async () => {
    for (const reason of ["note_not_found", "note_not_current"]) {
      const sink = hooks();
      await runEmbeddingJob({ embedded: false, reason }, sink);
      expect(sink.notesChanged).toHaveBeenCalledWith([noteId]);
    }
  });

  it("hands over nothing when the vector did not change or no model embedded it", async () => {
    for (const reason of ["unchanged", "no_embedding"]) {
      const sink = hooks();
      await runEmbeddingJob({ embedded: false, reason }, sink);
      expect(sink.notesChanged).not.toHaveBeenCalled();
    }
  });

  it("runs without hooks", async () => {
    await expect(runEmbeddingJob({ embedded: true })).resolves.toBeUndefined();
  });
});
