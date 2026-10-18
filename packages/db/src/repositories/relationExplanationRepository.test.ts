import { describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";

import {
  createRelationExplanationRepository,
  relationExplanationInputHash,
  relationExplanationInputVersion,
  relationExplanationIsCurrent,
  relationExplanationPlan,
  relationExplanationWriterHash
} from "./relationExplanationRepository.js";

const low = "00000000-0000-4000-8000-000000000001";
const high = "00000000-0000-4000-8000-000000000002";
const note = (id: string, ideaStatement: string, contentHash: string | null = "hash-" + id) => ({
  id,
  title: "Title",
  ideaStatement,
  passage: contentHash === null ? null : { contentHash }
});

describe("relation explanation inputs", () => {
  const inputs = {
    type: "supports",
    direction: "n1_to_n2" as const,
    language: "en",
    first: { ideaStatement: "First idea", passageHash: "p1" },
    second: { ideaStatement: "Second idea", passageHash: "p2" }
  };

  it("hashes what the explanation depends on, and nothing else", () => {
    const hash = relationExplanationInputHash(inputs);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(relationExplanationInputHash({ ...inputs })).toBe(hash);
    for (const changed of [
      { ...inputs, type: "extends" },
      { ...inputs, direction: "unknown" as const },
      { ...inputs, language: "pt-BR" },
      { ...inputs, first: { ...inputs.first, ideaStatement: "Edited idea" } },
      { ...inputs, second: { ...inputs.second, passageHash: "p3" } },
      { ...inputs, second: { ...inputs.second, passageHash: null } },
      { ...inputs, first: inputs.second, second: inputs.first }
    ])
      expect(relationExplanationInputHash(changed)).not.toBe(hash);
  });

  it("does not depend on IDs or on the stored endpoint order of a symmetric relation", () => {
    const a = note(low, "Alpha", "pa"),
      b = note(high, "Beta", "pb");
    const plan = relationExplanationPlan({
      type: "contrasts",
      semanticSourceId: null,
      language: "en",
      a,
      b
    });
    expect(
      relationExplanationPlan({
        type: "contrasts",
        semanticSourceId: null,
        language: "en",
        a: b,
        b: a
      })
    ).toEqual(plan);
    const renamed = relationExplanationPlan({
      type: "contrasts",
      semanticSourceId: null,
      language: "en",
      a: { ...a, id: "00000000-0000-4000-8000-000000000009" },
      b
    });
    expect(renamed.inputHash).toBe(plan.inputHash);
  });

  it("changes when a directed relation is turned around", () => {
    const a = note(low, "Alpha"),
      b = note(high, "Beta");
    const plan = (semanticSourceId: string, language = "en") =>
      relationExplanationPlan({ type: "supports", semanticSourceId, language, a, b }).inputHash;
    expect(plan(low)).not.toBe(plan(high));
  });

  it("is another explanation in another content language, and the same one in the same language", () => {
    const a = note(low, "Alpha"),
      b = note(high, "Beta");
    const plan = (language: string) =>
      relationExplanationPlan({ type: "supports", semanticSourceId: low, language, a, b })
        .inputHash;
    expect(plan("en")).toBe(plan("en"));
    expect(plan("pt-BR")).not.toBe(plan("en"));
  });
});

describe("the key of a written explanation (F3 D22)", () => {
  const a = note(low, "Alpha", "pa"),
    b = note(high, "Beta", "pb");
  const writer = { promptRevision: "prompt-3", model: "model-a" };
  const plan = (who?: typeof writer | null, language = "en") =>
    relationExplanationPlan({
      type: "supports",
      semanticSourceId: low,
      language,
      writer: who,
      a,
      b
    });

  it("is the version 3 hash of the facts, then the hash of the writer", () => {
    expect(relationExplanationInputVersion).toBe("relation-explanation-input-v3");
    const facts = plan().factsHash;
    expect(facts).toMatch(/^[a-f0-9]{64}$/);
    expect(plan().inputHash).toBe(facts);
    expect(plan(writer).inputHash).toBe(`${facts}.${relationExplanationWriterHash(writer)}`);
    expect(relationExplanationWriterHash(writer)).toMatch(/^[a-f0-9]{16}$/);
  });

  it("changes with the prompt revision and with the model, never the facts part", () => {
    const key = plan(writer).inputHash;
    for (const other of [
      { ...writer, promptRevision: "prompt-4" },
      { ...writer, model: "model-b" }
    ]) {
      expect(plan(other).inputHash).not.toBe(key);
      expect(plan(other).factsHash).toBe(plan(writer).factsHash);
    }
    expect(plan(writer, "pt-BR").inputHash).not.toBe(key);
  });

  it("is current for the same writer, and for any writer when the reader does not know it", () => {
    const stored = plan(writer).inputHash;
    expect(relationExplanationIsCurrent(stored, plan(writer))).toBe(true);
    expect(relationExplanationIsCurrent(stored, plan({ ...writer, model: "model-b" }))).toBe(false);
    expect(
      relationExplanationIsCurrent(stored, plan({ ...writer, promptRevision: "prompt-4" }))
    ).toBe(false);
    // A reader without a writer matches on the facts: a key with a writer, or a bare facts hash.
    for (const unknown of [undefined, null]) {
      expect(relationExplanationIsCurrent(stored, plan(unknown))).toBe(true);
      expect(relationExplanationIsCurrent(plan().factsHash, plan(unknown))).toBe(true);
      expect(relationExplanationIsCurrent(stored, plan(unknown, "pt-BR"))).toBe(false);
    }
    // A key of the previous version (no dot, another facts hash) is never current.
    expect(relationExplanationIsCurrent("a".repeat(64), plan(writer))).toBe(false);
    expect(relationExplanationIsCurrent("a".repeat(64), plan(null))).toBe(false);
    expect(relationExplanationIsCurrent(plan().factsHash, plan(writer))).toBe(false);
  });
});

describe("relation explanation repository", () => {
  function setup(rows: QueryResultRow[]) {
    const query = vi.fn(
      async <T extends QueryResultRow>() => ({ rows }) as unknown as QueryResult<T>
    );
    return { repository: createRelationExplanationRepository({ query }), query };
  }

  it("reads the context in one statement and maps the cached explanation", async () => {
    const { repository, query } = setup([
      {
        relationId: low,
        type: "supports",
        status: "pending_review",
        semanticSourceId: low,
        vetoable: true,
        withdrawn: false,
        vetoSource: null,
        a: note(low, "A"),
        b: note(high, "B"),
        stored: {
          text: "Cached",
          inputHash: "h",
          model: "writer",
          writtenAt: "2026-10-15T10:00:00Z"
        }
      }
    ]);
    const context = await repository.readContext(low);
    expect(query).toHaveBeenCalledTimes(1);
    expect(context).toMatchObject({ vetoable: true, withdrawn: false, vetoSource: null });
    expect(context?.stored).toEqual({
      text: "Cached",
      inputHash: "h",
      model: "writer",
      writtenAt: new Date("2026-10-15T10:00:00Z")
    });
    expect(await setup([]).repository.readContext(low)).toBeNull();
  });

  it("names a home source only while it exists, so an audit never links a deleted one", async () => {
    const orphan = { ...note(low, "A"), homeSourceId: null };
    const { repository } = setup([
      {
        relationId: low,
        type: "supports",
        status: "pending_review",
        semanticSourceId: null,
        a: orphan,
        b: note(high, "B"),
        stored: null
      }
    ]);
    expect((await repository.readContext(low))?.a.homeSourceId).toBeNull();
    // The statement takes the id from `source_items`, not from the dangling column.
    expect(repository.statements.context).toContain(
      "(select s.id from source_items s where s.id = a.created_from_source_item_id)"
    );
    expect(repository.statements.context).toContain(
      "(select s.id from source_items s where s.id = b.created_from_source_item_id)"
    );
  });

  it("reads whether the relation may be withdrawn, and whether it is, only through the predicates", async () => {
    const { repository } = setup([]);
    const { context } = repository.statements;
    // The veto state is read through the visibility module, never filtered on its columns.
    expect(context).toContain("r.status = 'pending_review' and r.vetoed_at is null) as vetoable");
    expect(context).toContain("r.status = 'pending_review' and r.vetoed_at is not null");
    expect(context).toContain('r.veto_source as "vetoSource"');
    const withdrawn = await setup([
      {
        relationId: low,
        type: "supports",
        status: "pending_review",
        semanticSourceId: null,
        vetoable: false,
        withdrawn: true,
        vetoSource: "explainer",
        a: note(low, "A"),
        b: note(high, "B"),
        stored: null
      }
    ]).repository.readContext(low);
    expect(withdrawn).toMatchObject({ vetoable: false, withdrawn: true, vetoSource: "explainer" });
  });

  it("stores beside the relation and never updates the relation or a note", async () => {
    const { repository } = setup([]);
    const { context, save } = repository.statements;
    expect(context).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(save).toContain("insert into atomic_note_relation_explanations");
    expect(save).toContain(
      "where exists (select 1 from atomic_note_relations where id = $1::uuid)"
    );
    expect(save).not.toMatch(/update\s+atomic_note/i);
    expect(
      await repository.save({
        relationId: low,
        text: "Text",
        inputHash: "h",
        promptVersion: "v",
        provider: "p",
        model: "m",
        runtime: "remote",
        aiTaskRunId: null,
        language: "en"
      })
    ).toBeNull();
  });
});
