import { describe, expect, it, vi } from "vitest";

import { joinPrompts, renderPrompt } from "./prompt-runtime.js";
import {
  buildRelationMatchPrompt,
  confirmMatchGroup,
  parseRelationMatchesTolerant,
  repairCalls,
  showsTwin,
  type RelationMatchRow
} from "./relation-type-resolution.js";

const row = (key: string, candidates: string[]): RelationMatchRow => ({
  key,
  predicate: `Concept: ${key}`,
  definition: `Definition of ${key}.`,
  candidates: candidates.map((candidate) => ({
    key: candidate,
    predicate: `Concept: ${candidate}`,
    definition: `Definition of ${candidate}.`
  }))
});
const rows = [row("r1", ["c1", "c2"]), row("r2", ["c3"]), row("r3", ["c4"])];

// FRREC (10-24) in short: one person extracted in three batches of a source, with a stored candidate
// c1. A later row lists an earlier row's provisional identity (c2 is r1's, c3 is r24's), so a call with
// both rows shows the earlier row its twin.
const ebbinghaus = (definition: string) => ({ predicate: "Person: Ebbinghaus", definition });
const stored = { key: "c1", ...ebbinghaus("Stored before.") };
const twinOfR1 = { key: "c2", ...ebbinghaus("Extracted from batch 0.") };
const twinOfR24 = { key: "c3", ...ebbinghaus("Extracted from batch 1.") };
const recurring: RelationMatchRow[] = [
  { key: "r1", ...ebbinghaus("Extracted from batch 0."), candidates: [stored] },
  { key: "r24", ...ebbinghaus("Extracted from batch 1."), candidates: [stored, twinOfR1] },
  {
    key: "r35",
    ...ebbinghaus("Extracted from batch 2."),
    candidates: [twinOfR1, twinOfR24, stored]
  }
];

describe("repairCalls", () => {
  it("finds a row shown a candidate that reads like it but is not its own", () => {
    expect(showsTwin(recurring)).toBe(true);
    expect(showsTwin([recurring[0]!, recurring[1]!])).toBe(true);
    // Alone, a row only meets its own candidates; r24 and r35 never show r24 a twin of r1's.
    expect(recurring.some((item) => showsTwin([item]))).toBe(false);
    expect(showsTwin([recurring[1]!])).toBe(false);
    expect(showsTwin(rows)).toBe(false);
  });

  it("splits a repair only where a row would meet its twin, keeping the order", () => {
    expect(repairCalls(rows).map((call) => call.map((item) => item.key))).toEqual([
      ["r1", "r2", "r3"]
    ]);
    expect(repairCalls(recurring).map((call) => call.map((item) => item.key))).toEqual([
      ["r1"],
      ["r24"],
      ["r35"]
    ]);
    expect(
      repairCalls([recurring[0]!, rows[1]!, recurring[1]!]).map((call) => call.length)
    ).toEqual([2, 1]);
    expect(repairCalls([])).toEqual([]);
  });
});

describe("parseRelationMatchesTolerant", () => {
  const answer = '{"matches":[["r1","c2"],["r2",null],["r3","c4"]]}';

  it("decides every row of a clean answer", () => {
    const result = parseRelationMatchesTolerant(answer, rows);
    expect([...result.decided]).toEqual([
      ["r1", "c2"],
      ["r2", null],
      ["r3", "c4"]
    ]);
    expect(result.missing).toEqual([]);
  });

  it("recovers the two defects a local writer recorded: a repeated object and a trailing parenthesis", () => {
    for (const defect of [`${answer}\n\n${answer}`, `${answer})`]) {
      const result = parseRelationMatchesTolerant(defect, rows);
      expect(result.decided.size).toBe(3);
      expect(result.missing).toEqual([]);
    }
  });

  it("keeps the valid pairs and leaves the others missing", () => {
    const result = parseRelationMatchesTolerant(
      // r1 names a candidate it does not have, r9 is not a row, r3 is absent.
      '{"matches":[["r1","c3"],["r9","c1"],["r2",null],["r2","c3"],"junk",["r3"]]}',
      rows
    );
    // r2 was answered twice with different candidates: neither is trusted.
    expect([...result.decided]).toEqual([]);
    expect(result.missing.map((item) => item.key)).toEqual(["r1", "r2", "r3"]);
    const partial = parseRelationMatchesTolerant('{"matches":[["r1","c1"],["r2","c9"]]}', rows);
    expect([...partial.decided]).toEqual([["r1", "c1"]]);
    expect(partial.missing.map((item) => item.key)).toEqual(["r2", "r3"]);
  });

  it("accepts a row answered twice the same way", () => {
    const result = parseRelationMatchesTolerant('{"matches":[["r2","c3"],["r2","c3"]]}', rows);
    expect([...result.decided]).toEqual([["r2", "c3"]]);
  });

  it("decides nothing for an answer that has no matches list or no object", () => {
    for (const output of ["", "not json", '{"other":1}', "[]", `${answer} {"matches":[]}`, null]) {
      const result = parseRelationMatchesTolerant(output, rows);
      expect(result.decided.size).toBe(0);
      expect(result.missing).toHaveLength(3);
    }
  });
});

describe("confirmMatchGroup", () => {
  const run = (...outputs: unknown[]) => {
    const ai = {
      runDefaultTask: vi.fn(),
      calls: () => ai.runDefaultTask.mock.calls as Array<[string, string, Record<string, unknown>]>
    };
    outputs.forEach((output, index) =>
      ai.runDefaultTask.mockResolvedValueOnce({ output, aiTaskRunId: `run-${index}` })
    );
    return ai;
  };
  const confirm = (
    ai: ReturnType<typeof run>,
    options: { pinned?: boolean; entityIdentity?: boolean } = {}
  ) =>
    confirmMatchGroup({
      ai: ai as never,
      group: rows,
      entityIdentity: options.entityIdentity ?? true,
      context: { sourceItemId: "source-1" },
      promptVersion: "version",
      stage: "entity_identity_resolution",
      pinned: options.pinned ?? false,
      invalidOutputError: options.pinned
        ? "errors.relationTypes.invalidOutput"
        : "errors.entityIdentity.invalidOutput"
    });

  it("makes one call for an answer with a recorded defect, unpinned", async () => {
    const ai = run(`{"matches":[["r1","c1"],["r2",null],["r3","c4"]]})`);
    const decisions = await confirm(ai);
    expect(ai.runDefaultTask).toHaveBeenCalledTimes(1);
    expect(decisions.get("r1")).toEqual({ candidate: "c1", aiTaskRunId: "run-0" });
    expect(decisions.size).toBe(3);
  });

  it("asks again only about the rows the first answer left undecided", async () => {
    const ai = run('{"matches":[["r1","c2"]]}', '{"matches":[["r2","c3"],["r3",null]]}');
    const decisions = await confirm(ai);
    const [first, second] = ai.calls();
    expect(first![1]).toBe(buildRelationMatchPrompt(rows, true));
    expect(second![1]).toBe(
      joinPrompts(
        buildRelationMatchPrompt([rows[1]!, rows[2]!], true),
        renderPrompt("graph.entity_identity.repair")
      )
    );
    expect(second![2]).toMatchObject({
      attempt: 1,
      isRepair: true,
      stage: "entity_identity_resolution"
    });
    expect(first![2]).toMatchObject({ attempt: 0, isRepair: false });
    // Each decision keeps the run that made it.
    expect(decisions.get("r1")?.aiTaskRunId).toBe("run-0");
    expect(decisions.get("r2")?.aiTaskRunId).toBe("run-1");
    expect(decisions.get("r3")).toEqual({ candidate: null, aiTaskRunId: "run-1" });
  });

  it("fails with the entity code when a row is still undecided after the one repair", async () => {
    const ai = run('{"matches":[["r1","c2"]]}', '{"matches":[["r2","c3"]]}');
    await expect(confirm(ai)).rejects.toThrow("errors.entityIdentity.invalidOutput");
    expect(ai.runDefaultTask).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    "repairs rows that chose their own twin without showing it again (entity identity %s)",
    async (entityIdentity) => {
      // FRREC's answers: r1 and r24 each named their twin, r35 a valid candidate.
      const ai = run(
        '{"matches":[["r1","c2"],["r24","c3"],["r35","c2"]]}',
        '{"matches":[["r1","c1"]]}',
        '{"matches":[["r24","c2"]]}'
      );
      const decisions = await confirmMatchGroup({
        ai: ai as never,
        group: recurring,
        entityIdentity,
        context: { sourceItemId: "source-1" },
        promptVersion: "version",
        stage: "entity_identity_resolution",
        pinned: false,
        invalidOutputError: "errors.entityIdentity.invalidOutput"
      });
      const repair = renderPrompt(
        entityIdentity ? "graph.entity_identity.repair" : "graph.relation_identity.repair"
      );
      expect(ai.calls().map(([, prompt]) => prompt)).toEqual([
        buildRelationMatchPrompt(recurring, entityIdentity),
        joinPrompts(buildRelationMatchPrompt([recurring[0]!], entityIdentity), repair),
        joinPrompts(buildRelationMatchPrompt([recurring[1]!], entityIdentity), repair)
      ]);
      expect(ai.calls().map(([, , context]) => context.attempt)).toEqual([0, 1, 1]);
      expect(ai.calls()[1]![1]).not.toContain('"c2"');
      expect(
        [...decisions].map(([key, { candidate, aiTaskRunId }]) => [key, candidate, aiTaskRunId])
      ).toEqual([
        ["r35", "c2", "run-0"],
        ["r1", "c1", "run-1"],
        ["r24", "c2", "run-2"]
      ]);
    }
  );

  it("still fails a row that stays undecided after its twin-free repair", async () => {
    const ai = run(
      '{"matches":[["r1","c2"],["r24","c3"],["r35","c2"]]}',
      '{"matches":[["r1","c9"]]}',
      '{"matches":[["r24","c2"]]}'
    );
    await expect(
      confirmMatchGroup({
        ai: ai as never,
        group: recurring,
        entityIdentity: true,
        context: {},
        promptVersion: "version",
        stage: "entity_identity_resolution",
        pinned: false,
        invalidOutputError: "errors.entityIdentity.invalidOutput"
      })
    ).rejects.toThrow("errors.entityIdentity.invalidOutput");
    expect(ai.runDefaultTask).toHaveBeenCalledTimes(3);
  });

  it("pinned, a twin changes nothing: the whole group is asked again", async () => {
    const answer = '{"matches":[["r1","c1"],["r24","c2"],["r35","c2"]]}';
    const ai = run('{"matches":[["r1","c2"],["r24","c3"],["r35","c2"]]}', answer);
    await confirmMatchGroup({
      ai: ai as never,
      group: recurring,
      entityIdentity: true,
      context: {},
      promptVersion: "version",
      stage: "entity_identity_resolution",
      pinned: true,
      invalidOutputError: "errors.relationTypes.invalidOutput"
    });
    expect(ai.calls()[1]![1]).toBe(
      joinPrompts(
        buildRelationMatchPrompt(recurring, true),
        renderPrompt("graph.entity_identity.repair")
      )
    );
  });

  it("uses the relation-type repair text for relation types", async () => {
    const ai = run('{"matches":[]}', `{"matches":[["r1","c1"],["r2",null],["r3",null]]}`);
    await confirm(ai, { entityIdentity: false });
    expect(ai.calls()[1]![1]).toBe(
      joinPrompts(
        buildRelationMatchPrompt(rows, false),
        renderPrompt("graph.relation_identity.repair")
      )
    );
  });

  it("pinned, a recorded defect takes its recorded repair: the whole group again with the repair text", async () => {
    const answer = '{"matches":[["r1","c1"],["r2",null],["r3","c4"]]}';
    const ai = run(`${answer}\n\n${answer}`, answer);
    const decisions = await confirm(ai, { pinned: true });
    const [first, second] = ai.calls();
    expect(first![1]).toBe(buildRelationMatchPrompt(rows, true));
    expect(second![1]).toBe(
      joinPrompts(
        buildRelationMatchPrompt(rows, true),
        renderPrompt("graph.entity_identity.repair")
      )
    );
    expect(decisions.size).toBe(3);
    expect(decisions.get("r1")?.aiTaskRunId).toBe("run-1");
  });

  it("pinned, two invalid answers fail with the code the answers were recorded under", async () => {
    const ai = run('{"matches":[["r1","c1"]]}', "nothing");
    await expect(confirm(ai, { pinned: true })).rejects.toThrow(
      "errors.relationTypes.invalidOutput"
    );
    expect(ai.runDefaultTask).toHaveBeenCalledTimes(2);
  });

  it("lists the source items of the rows' candidates in the call context", async () => {
    const ai = run('{"matches":[["r1","c1"],["r2",null],["r3",null]]}');
    const withSources = rows.map((item) => ({
      ...item,
      candidates: item.candidates.map((candidate) => ({
        ...candidate,
        sourceItemIds: [`source-of-${candidate.key}`]
      }))
    }));
    await confirmMatchGroup({
      ai: ai as never,
      group: withSources,
      entityIdentity: true,
      context: { sourceItemId: "source-1" },
      promptVersion: "version",
      stage: "stage",
      pinned: false,
      invalidOutputError: "x"
    });
    expect((ai.calls()[0]![2] as { sourceItemIds: string[] }).sourceItemIds).toEqual([
      "source-1",
      "source-of-c1",
      "source-of-c2",
      "source-of-c3",
      "source-of-c4"
    ]);
  });
});
