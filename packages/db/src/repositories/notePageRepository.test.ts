import { describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";

import { NotePageRelationsSchema, notePageLimits, objectLocatePathLimit } from "@app/domain";
import type { PgPool } from "../client.js";
import { createNotePageRepository } from "./notePageRepository.js";
import { relationExplanationPlan } from "./relationExplanationRepository.js";

// The SQL runs against a real database in `npm run db:note-page:verify` (answers) and
// `scripts/objects/note-page-benchmark.ts` (latency); these tests pin the transaction, how rows
// become the contract and that nothing can write.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const noteRow = (overrides: Record<string, unknown> = {}) => ({
  id: id(1),
  title: "Retrieval",
  ideaStatement: "Retrieval strengthens memory.",
  bodyMarkdown: "Retrieval strengthens memory.",
  language: "en",
  status: "active",
  superseded: false,
  ownership: "source",
  humanProtected: false,
  evolution: false,
  generationModel: "writer",
  homeSourceId: id(3),
  createdAt: new Date("2026-10-15T10:00:00.123Z"),
  updatedAt: "2026-10-15 11:00:00.456+00",
  reviewedAt: null,
  lastEditedAt: null,
  successors: [{ id: id(7), title: "Next" }],
  ...overrides
});

const evidenceRow = {
  total: "120",
  items: [
    {
      chunkId: id(4),
      sourceItemId: id(5),
      documentId: id(6),
      sourceSpanId: null,
      sourceTitle: "Chapter",
      workTitle: "Book",
      chunkIndex: 2,
      range: { start: 10, end: 40 },
      page: null,
      excerpt: "Retrieval",
      language: null,
      primary: true,
      current: true,
      sourceAvailable: true
    }
  ]
};

const relationItem = (overrides: Record<string, unknown> = {}) => ({
  id: id(20),
  type: "supports",
  direction: "incoming",
  semanticSourceId: id(2),
  matchingModel: "decider",
  decisionSource: "model",
  explanation: 'Both describe recall in <note-ref id="00000000-0000-4000-8000-000000000001" />.',
  written: null,
  other: {
    id: id(2),
    title: "Other",
    ideaStatement: "Spacing helps.",
    language: null,
    status: "active",
    superseded: false,
    edited: true,
    evolution: false,
    sourceItemId: id(8),
    sourceTitle: "Paper",
    passageHash: "other-passage",
    passage: null
  },
  ...overrides
});

/** The page's own note as an explanation sees it. */
const self = {
  id: id(1),
  title: "Retrieval",
  ideaStatement: "Retrieval strengthens memory.",
  passageHash: "own-passage"
};
/** The input hash of `relationItem()` with `self`, as the explanation service computes it. */
const currentHash = (type = "supports", language = "en") =>
  relationExplanationPlan({
    type,
    semanticSourceId: id(2),
    language,
    a: { ...self, passage: { contentHash: self.passageHash } },
    b: {
      id: id(2),
      title: "Other",
      ideaStatement: "Spacing helps.",
      passage: { contentHash: "other-passage" }
    }
  }).inputHash;

const located = {
  title: "Retrieval",
  path: [{ id: id(3), title: "Book" }],
  topicPath: [
    { id: id(30), title: "" },
    { id: id(31), title: "Memory" }
  ],
  alsoIn: [],
  citedBy: [],
  alsoInCount: 0,
  citedByCount: 0,
  notes: 0,
  passages: 1,
  children: 0
};

function setup(
  answers: { note?: QueryResultRow[]; fail?: "evidence"; relations?: QueryResultRow[] } = {}
) {
  const statements: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
  const answer = (text: string): QueryResultRow[] => {
    if (/^\s*(begin|commit|rollback)/i.test(text)) return [];
    if (text.includes("atomic_note_evolution x")) return answers.note ?? [noteRow()];
    if (text.includes("primary_chunk")) {
      if (answers.fail === "evidence") throw new Error("boom");
      return [evidenceRow];
    }
    if (text.includes("with rel as"))
      return answers.relations ?? [{ total: 1, self, items: [relationItem()] }];
    return [located];
  };
  const query = vi.fn(
    async <T extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
      statements.push({ text, values });
      return { rows: answer(text) } as unknown as QueryResult<T>;
    }
  );
  const release = vi.fn();
  const pool = {
    connect: vi.fn(async () => ({ query, release })),
    query
  } as unknown as PgPool;
  return { repository: createNotePageRepository(pool), statements, release, pool };
}

describe("note page repository", () => {
  it("reads the page in one read-only repeatable-read transaction, in order", async () => {
    const { repository, statements, release } = setup();
    const page = await repository.readPage(id(1), { relationLimit: 20, contentLanguage: "en" });
    expect(page).not.toBeNull();
    const texts = statements.map((s) => s.text.trim().split(/\s+/).slice(0, 3).join(" "));
    expect(texts[0]).toBe("begin transaction isolation");
    expect(statements[0]!.text).toContain("repeatable read, read only");
    expect(statements[1]!.values).toEqual([id(1), notePageLimits.successors]);
    expect(statements[2]!.values).toEqual([
      id(1),
      notePageLimits.evidence,
      objectLocatePathLimit - 1
    ]);
    expect(statements[3]!.values).toEqual([id(1), 20, 0, notePageLimits.excerptCharacters]);
    expect(statements[4]!.text).toContain("with recursive note as");
    expect(statements.at(-1)!.text).toBe("commit");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("returns null for a missing note without reading anything else", async () => {
    const { repository, statements, release } = setup({ note: [] });
    expect(
      await repository.readPage(id(1), { relationLimit: 20, contentLanguage: "en" })
    ).toBeNull();
    expect(statements.map((s) => s.text.trim().split(/\s/)[0])).toEqual([
      "begin",
      "select",
      "commit"
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases when a statement fails", async () => {
    const { repository, statements, release } = setup({ fail: "evidence" });
    await expect(
      repository.readPage(id(1), { relationLimit: 20, contentLanguage: "en" })
    ).rejects.toThrow("boom");
    expect(statements.at(-1)!.text).toBe("rollback");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("maps rows to the contract: timestamps, authorship, explanation, no scores", async () => {
    const { repository } = setup({
      note: [noteRow({ lastEditedAt: "2026-10-15T12:00:00Z", humanProtected: true })]
    });
    const page = (await repository.readPage(id(1), { relationLimit: 20, contentLanguage: "en" }))!;
    expect(page.note.createdAt).toBe("2026-10-15T10:00:00.123Z");
    expect(page.note.updatedAt).toBe("2026-10-15T11:00:00.456Z");
    expect(page.note.lastEditedAt).toBe("2026-10-15T12:00:00.000Z");
    expect(page.note.authorship).toBe("edited");
    expect(page.successors).toEqual([{ id: id(7), title: "Next" }]);
    expect(page.evidence.total).toBe(120);
    expect(page.placement.primaryPath.at(-1)).toEqual({
      kind: "note",
      id: id(1),
      title: "Retrieval"
    });
    const [relation] = page.relations.items;
    expect(relation).toEqual({
      id: id(20),
      type: "supports",
      direction: "incoming",
      decidedBy: "decider",
      explanation: {
        text: 'Both describe recall in <note-ref id="00000000-0000-4000-8000-000000000001" />.',
        writtenBy: "decider"
      },
      other: {
        id: id(2),
        title: "Other",
        ideaStatement: "Spacing helps.",
        language: null,
        status: "active",
        superseded: false,
        authorship: "edited",
        sourceItemId: id(8),
        sourceTitle: "Paper",
        passage: null
      }
    });
    expect(NotePageRelationsSchema.parse(page.relations)).toEqual(page.relations);
  });

  it("shows an explanation written on demand while its inputs are unchanged", async () => {
    const written = { text: "Written on open.", inputHash: currentHash(), model: "writer" };
    const { repository } = setup({
      relations: [{ total: 1, self, items: [relationItem({ written })] }]
    });
    const [relation] = (await repository.readPage(id(1), {
      relationLimit: 20,
      contentLanguage: "en"
    }))!.relations.items;
    expect(relation?.explanation).toEqual({ text: "Written on open.", writtenBy: "writer" });
  });

  it("reads a stale explanation as none, so it is written again when opened", async () => {
    // Written for another type: the idea, the passage or the direction changing works the same way.
    const written = { text: "Old.", inputHash: currentHash("extends"), model: "writer" };
    const { repository } = setup({
      relations: [{ total: 1, self, items: [relationItem({ written })] }]
    });
    const [relation] = (await repository.readPage(id(1), {
      relationLimit: 20,
      contentLanguage: "en"
    }))!.relations.items;
    expect(relation?.explanation).toBeNull();
  });

  it("reads an explanation written in another content language as none, in the page and in a further page", async () => {
    const written = { text: "Escrita em ingles.", inputHash: currentHash(), model: "writer" };
    const answers = { relations: [{ total: 1, self, items: [relationItem({ written })] }] };
    const { repository } = setup(answers);
    const portuguese = await repository.readPage(id(1), {
      relationLimit: 20,
      contentLanguage: "pt-BR"
    });
    expect(portuguese!.relations.items[0]?.explanation).toBeNull();
    const english = await repository.readPage(id(1), { relationLimit: 20, contentLanguage: "en" });
    expect(english!.relations.items[0]?.explanation?.text).toBe("Escrita em ingles.");
    const further = await repository.listRelations(id(1), {
      offset: 0,
      limit: 20,
      contentLanguage: "pt-BR"
    });
    expect(further.items[0]?.explanation).toBeNull();
    // An explanation written in the current language counts again.
    const rewritten = { ...written, inputHash: currentHash("supports", "pt-BR") };
    const current = setup({
      relations: [{ total: 1, self, items: [relationItem({ written: rewritten })] }]
    });
    const page = await current.repository.readPage(id(1), {
      relationLimit: 20,
      contentLanguage: "pt-BR"
    });
    expect(page!.relations.items[0]?.explanation?.text).toBe("Escrita em ingles.");
  });

  it("loads a relation whose excerpt of exactly the bound in characters has more UTF-16 units", async () => {
    // `left(content, 600)` yields 600 code points: 601 UTF-16 units with one emoji.
    const excerpt = "\u{1F600}" + "a".repeat(notePageLimits.excerptCharacters - 1);
    const item = relationItem();
    const other = {
      ...item.other,
      passage: { chunkId: id(4), sourceSpanId: null, chunkIndex: 0, excerpt, language: null }
    };
    const { repository } = setup({
      relations: [{ total: 1, self, items: [{ ...item, other }] }]
    });
    const page = await repository.readPage(id(1), { relationLimit: 20, contentLanguage: "en" });
    expect(page!.relations.items[0]?.other.passage?.excerpt).toBe(excerpt);
    expect(NotePageRelationsSchema.parse(page!.relations).items).toHaveLength(1);
  });

  it("lists the relation to a knowledge note whose home source was deleted", async () => {
    const item = relationItem();
    const other = { ...item.other, sourceItemId: null, sourceTitle: "" };
    const { repository } = setup({
      relations: [{ total: 1, self, items: [{ ...item, other }] }]
    });
    const page = await repository.readPage(id(1), { relationLimit: 20, contentLanguage: "en" });
    expect(page!.relations.items[0]?.other).toMatchObject({ sourceItemId: null, sourceTitle: "" });
    expect(NotePageRelationsSchema.parse(page!.relations).total).toBe(1);
  });

  it("an evolution note is the AI's reviewed evolution until a person edits it", async () => {
    const { repository } = setup({ note: [noteRow({ evolution: true, ownership: "knowledge" })] });
    const page = (await repository.readPage(id(1), { relationLimit: 20, contentLanguage: "en" }))!;
    expect(page.note.authorship).toBe("evolution");
    expect(page.note.ownership).toBe("knowledge");
  });

  it("pages relations on the pool, without a transaction", async () => {
    const { repository, statements, pool } = setup();
    const relations = await repository.listRelations(id(1), {
      offset: 40,
      limit: 20,
      contentLanguage: "en"
    });
    expect(relations.total).toBe(1);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.values).toEqual([id(1), 20, 40, notePageLimits.excerptCharacters]);
    expect(
      (pool as unknown as { connect: ReturnType<typeof vi.fn> }).connect
    ).not.toHaveBeenCalled();
  });

  it("only reads: no statement writes, locks or changes the schema", () => {
    const { repository } = setup();
    for (const statement of Object.values(repository.statements)) {
      expect(statement).not.toMatch(/\b(insert|update|delete|truncate|create|drop|alter|grant)\b/i);
      expect(statement).not.toMatch(/for\s+(update|share|no key update)/i);
    }
  });

  it("never lets a score out: it only orders the relation rows", () => {
    const { relations } = setup().repository.statements;
    expect(relations).toContain("order by rel.final_score desc");
    expect(relations).not.toMatch(/'finalScore'|'score'/);
  });

  it("reads an explanation written on demand beside the relation, for the page rows only", () => {
    const { relations } = setup().repository.statements;
    expect(relations).toContain(
      "left join atomic_note_relation_explanations x on x.relation_id = page.id"
    );
  });

  it("counts and lists the same relations: the home source is a left join, not a filter", () => {
    const { relations, evidence } = setup().repository.statements;
    expect(relations).toContain(
      "left join source_items os on os.id = o.created_from_source_item_id"
    );
    expect(relations).not.toMatch(/(?<!left )join source_items/);
    expect(relations).toContain("coalesce(os.title, '')");
    // Characters, as the contract counts them: one constant bounds the SQL and the schema.
    expect(relations).toContain("left(oc.content, $4::int)");
    expect(evidence).toContain(`left(page.excerpt, ${notePageLimits.evidenceExcerptCharacters})`);
  });

  it("hides discarded relations and discarded or archived notes", () => {
    const { relations } = setup().repository.statements;
    expect(relations).toContain("r.status <> 'rejected'");
    expect(relations).toContain("o.status not in ('rejected', 'archived')");
  });
});
