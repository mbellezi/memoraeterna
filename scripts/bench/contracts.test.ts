import { describe, expect, it } from "vitest";

import {
  classifyRecordedCall,
  type PreparedItem,
  type ReplayCall,
  type ReplayCaller
} from "./contracts/index.ts";
import { buildKnowledgeGraphRepairPrompt } from "../../apps/desktop/src/main/services/knowledge-processing.js";
import {
  buildAtomicNoteRepairPrompt,
  buildAtomicNoteGenerationPrompt
} from "../../apps/desktop/src/main/services/knowledge-processing.js";
import { renderPrompt } from "../../apps/desktop/src/main/services/prompt-runtime.js";
import { buildRelationMatchPrompt } from "../../apps/desktop/src/main/services/relation-type-resolution.js";
import {
  chunkIds,
  confirmationBody,
  graphAnswer,
  graphAnswerWithBadRelation,
  graphAliases,
  graphBody,
  graphNotes,
  namesAnswer,
  namesBody,
  notesAnswer,
  notesBody,
  oldGraphBody,
  overviewAnswer,
  overviewBody,
  recorded,
  summaryAnswer,
  summaryBody,
  typingAnswer,
  typingBody
} from "./test-fixtures.ts";
import { composeInput } from "./replay-cassette.ts";

/** A caller that answers from a list, in order, and keeps every call it was asked. */
function scripted(answers: ReadonlyArray<string | Error>) {
  const calls: ReplayCall[] = [];
  const caller: ReplayCaller = async (call) => {
    calls.push(call);
    const answer = answers[calls.length - 1];
    if (answer === undefined) throw new Error("no_answer_scripted");
    if (answer instanceof Error) throw answer;
    return { output: answer, durationMs: 10 };
  };
  return { caller, calls };
}

function itemOf(taskType: string, body: string, output = "{}", language = "en"): PreparedItem {
  const classified = classifyRecordedCall(recorded({ taskType, body, output, language }));
  if (classified.kind !== "item") throw new Error(`not an item: ${classified.kind}`);
  return classified.item;
}

describe("classifying recorded calls", () => {
  it.each([
    ["summarization", summaryBody(), "summary"],
    ["atomic-note-generation", notesBody(), "notes"],
    ["knowledge-graph-generation", graphBody(), "graph"],
    ["knowledge-graph-generation", graphBody("source_chunks"), "graph"],
    ["knowledge-graph-generation", confirmationBody(true), "confirmation"],
    ["knowledge-graph-generation", confirmationBody(false), "confirmation"],
    ["structured-output", namesBody(), "topic-names"],
    ["structured-output", overviewBody(), "overview"],
    ["structured-output", typingBody(), "typing"]
  ])(
    "reads %s as %s and puts its inputs back as today's builders make them",
    (task, body, contract) => {
      const item = itemOf(task, body);
      expect(item.contract).toBe(contract);
      expect(item.body).toBe(body);
      expect(item.current).toBe(body);
    }
  );

  it("reads the language the output-language instruction names", () => {
    expect(itemOf("structured-output", overviewBody("pt-BR"), "{}", "pt-BR").language).toBe(
      "pt-BR"
    );
  });

  it("sets aside the repair prompts the recording made after its own failures", () => {
    const aliases = [...graphAliases.keys()];
    const graphRepair = buildKnowledgeGraphRepairPrompt(
      { title: "Forgetting", language: "English" },
      graphNotes,
      graphAliases,
      "{}",
      new Error("bad"),
      "atomic_notes",
      { maxEntities: 12, maxRelations: 12 }
    );
    expect(aliases).toEqual(["c1", "c2"]);
    const repairs: Array<[string, string, string]> = [
      ["knowledge-graph-generation", graphRepair, "graph"],
      [
        "atomic-note-generation",
        buildAtomicNoteRepairPrompt("{", chunkIds, new Error("bad")),
        "notes"
      ],
      [
        "knowledge-graph-generation",
        confirmationBody() + renderPrompt("graph.entity_identity.repair"),
        "confirmation"
      ],
      [
        "structured-output",
        `${namesBody()}\n\n${renderPrompt("topic.name.repair", { validation_errors: "T1: bad" })}`,
        "topic-names"
      ],
      [
        "structured-output",
        `${overviewBody()}\n\n${renderPrompt("topic.overview.repair", { validation_errors: "bad" })}`,
        "overview"
      ]
    ];
    for (const [task, body, contract] of repairs) {
      const classified = classifyRecordedCall(recorded({ taskType: task, body, output: "{}" }));
      expect(classified).toEqual({ kind: "recorded_repair", contract });
    }
  });

  it("is not fooled by a call that is no writer's", () => {
    expect(
      classifyRecordedCall(recorded({ taskType: "embedding", body: "x", output: "[]" }))
    ).toMatchObject({
      kind: "not_a_writer_call"
    });
    expect(
      classifyRecordedCall(
        recorded({ taskType: "structured-output", body: "Do something else", output: "{}" })
      )
    ).toMatchObject({ kind: "not_a_writer_call", reason: "unknown_prompt" });
  });

  it("refuses an input without an output-language instruction", () => {
    const call = recorded({ taskType: "summarization", body: summaryBody(), output: "x" });
    expect(classifyRecordedCall({ ...call, input: summaryBody() })).toMatchObject({
      kind: "unreconstructable",
      reason: "no_language_prefix"
    });
  });

  it("reports a prompt whose inputs do not come back as unreconstructable", () => {
    const damaged = notesBody().replace("[0f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b]", "[chunk one]");
    expect(
      classifyRecordedCall(
        recorded({ taskType: "atomic-note-generation", body: damaged, output: "{}" })
      )
    ).toMatchObject({ kind: "unreconstructable", contract: "notes" });
  });

  it("keeps the recorded graph prompt when it is older than today's, and flags the drift", () => {
    const item = itemOf("knowledge-graph-generation", oldGraphBody());
    expect(item.body).toBe(oldGraphBody());
    expect(item.current).toBe(graphBody());
    expect(item.current).not.toBe(item.body);
  });
});

describe("the notes flow", () => {
  it("asks once for a valid answer and digests it", async () => {
    const item = itemOf("atomic-note-generation", notesBody());
    const { caller, calls } = scripted([notesAnswer]);
    const outcome = await item.run(caller, "recorded");
    expect(outcome).toMatchObject({ ok: true, error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      contract: "notes",
      taskType: "atomic-note-generation",
      attempt: 0,
      isRepair: false,
      prompt: notesBody()
    });
    expect(outcome.digest).toMatchObject({ count: 2 });
  });

  it("repairs only the invalid note, with the product's repair prompt", async () => {
    const answer = JSON.parse(notesAnswer) as { notes: Array<Record<string, unknown>> };
    answer.notes[1]!.evidenceChunkIds = ["not-a-chunk"];
    const fixed = JSON.stringify({ notes: [JSON.parse(notesAnswer).notes[1]] });
    const item = itemOf("atomic-note-generation", notesBody());
    const { caller, calls } = scripted([JSON.stringify(answer), fixed]);
    const outcome = await item.run(caller, "recorded");
    expect(calls.map((call) => [call.attempt, call.isRepair, call.operation])).toEqual([
      [0, false, "atomic_note_generation"],
      [1, true, "atomic_note_repair"]
    ]);
    expect(calls[1]!.prompt).toContain("Previous invalid output");
    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.digest).toMatchObject({ count: 2 });
  });

  it("fails after the one repair when the writer cannot produce notes", async () => {
    const item = itemOf("atomic-note-generation", notesBody());
    const { caller, calls } = scripted(["not json", "still not json"]);
    const outcome = await item.run(caller, "recorded");
    expect(calls).toHaveLength(2);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).not.toBeNull();
  });

  it("reports a failed call as a failed flow", async () => {
    const item = itemOf("atomic-note-generation", notesBody());
    const { caller } = scripted([new Error("deadline")]);
    expect(await item.run(caller, "recorded")).toMatchObject({ ok: false, error: "deadline" });
  });

  it("digests a recorded answer whatever its flaws, and compares answers", () => {
    const item = itemOf("atomic-note-generation", notesBody());
    const digest = item.digestOf(notesAnswer)!;
    expect(digest).toMatchObject({
      count: 2,
      titles: ["spacing helps recall", "feedback helps tests"]
    });
    expect(item.digestOf("nonsense")).toBeNull();
    const half = item.digestOf(JSON.stringify({ notes: [JSON.parse(notesAnswer).notes[0]] }))!;
    expect(item.compare(half, digest)).toMatchObject({ countRatio: 0.5, evidenceCoverage: 0.5 });
    expect(item.compare(digest, digest)).toMatchObject({
      countRatio: 1,
      titleOverlap: 1,
      evidenceCoverage: 1
    });
  });

  it("builds today's prompt the same way the product does", () => {
    expect(notesBody()).toBe(
      buildAtomicNoteGenerationPrompt({ title: "Spaced practice", language: "en" }, [
        {
          id: chunkIds[0]!,
          content: "Practice spread over days improves recall.\n\nIt beats cramming."
        },
        { id: chunkIds[1]!, content: "Feedback after a test makes the next test easier." }
      ])
    );
  });
});

describe("the graph flow", () => {
  it("keeps valid items with no call when only a relation is bad", async () => {
    const item = itemOf("knowledge-graph-generation", graphBody());
    const { caller, calls } = scripted([graphAnswerWithBadRelation]);
    const outcome = await item.run(caller, "recorded");
    expect(calls).toHaveLength(1);
    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.salvagedItems).toBeGreaterThan(0);
    expect(outcome.digest).toMatchObject({ entities: ["ebbinghaus", "forgetting curve"] });
  });

  it("asks again, with the product's repair prompt, when nothing valid is left", async () => {
    const item = itemOf("knowledge-graph-generation", graphBody());
    const { caller, calls } = scripted(["{}", graphAnswer]);
    const outcome = await item.run(caller, "recorded");
    expect(outcome).toMatchObject({ ok: true, salvagedItems: 0 });
    expect(calls[1]).toMatchObject({ isRepair: true, operation: "graph_atomic_notes_repair" });
    expect(calls[1]!.prompt).toContain("The previous knowledge-graph response was invalid");
    expect(calls[1]!.prompt).toContain("The only allowed evidence aliases in this batch are:");
  });

  it("sends the recorded body or today's prompt as the first ask, and the same repair", async () => {
    const item = itemOf("knowledge-graph-generation", oldGraphBody());
    const recordedRun = scripted(["{}", graphAnswer]);
    await item.run(recordedRun.caller, "recorded");
    const currentRun = scripted(["{}", graphAnswer]);
    await item.run(currentRun.caller, "current");
    expect(recordedRun.calls[0]!.prompt).toBe(oldGraphBody());
    expect(currentRun.calls[0]!.prompt).toBe(graphBody());
    expect(recordedRun.calls[1]!.prompt).toBe(currentRun.calls[1]!.prompt);
  });

  it("fails with the product's code when the repair is invalid too", async () => {
    const item = itemOf("knowledge-graph-generation", graphBody());
    const { caller } = scripted(["{}", "{}"]);
    const outcome = await item.run(caller, "recorded");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("knowledge_graph_output_invalid:nothing_valid");
  });

  it("reads the source-chunk form of the prompt too", async () => {
    const item = itemOf("knowledge-graph-generation", graphBody("source_chunks"));
    expect(item.operation).toBe("graph_source_chunks");
    const { caller } = scripted([graphAnswer]);
    expect(await item.run(caller, "recorded")).toMatchObject({ ok: true });
  });

  it("compares entities and relations with the recorded answer by normalized name", () => {
    const item = itemOf("knowledge-graph-generation", graphBody());
    const recordedDigest = item.digestOf(graphAnswer)!;
    const partial = item.digestOf(
      JSON.stringify({
        entities: [
          {
            key: "x",
            type: "Concept",
            canonicalName: "EBBINGHAUS",
            aliases: [],
            confidence: 1,
            evidenceChunkIds: ["c1"]
          }
        ],
        relations: []
      })
    )!;
    expect(item.compare(partial, recordedDigest)).toMatchObject({
      entityRecall: 0.5,
      entityPrecision: 1,
      relationRecall: 0
    });
    expect(item.compare(recordedDigest, recordedDigest)).toMatchObject({
      entityRecall: 1,
      relationRecall: 1,
      relationPrecision: 1,
      predicateAgreement: 1
    });
    expect(item.digestOf("[]")).toBeNull();
  });
});

describe("the confirmation flow", () => {
  it("decides every row from one clean answer", async () => {
    const item = itemOf("knowledge-graph-generation", confirmationBody());
    const { caller, calls } = scripted([
      JSON.stringify({
        matches: [
          ["r1", "c1"],
          ["r2", null]
        ]
      })
    ]);
    const outcome = await item.run(caller, "recorded");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ language: "en", operation: "entity_identity_resolution" });
    expect(outcome.digest).toEqual({ decisions: { r1: "c1", r2: null } });
  });

  it("asks again only for the rows left undecided, with the repair fragment", async () => {
    const item = itemOf("knowledge-graph-generation", confirmationBody());
    const { caller, calls } = scripted([
      JSON.stringify({ matches: [["r1", "c1"]] }),
      JSON.stringify({ matches: [["r2", "c2"]] })
    ]);
    const outcome = await item.run(caller, "recorded");
    expect(calls[1]).toMatchObject({ isRepair: true, attempt: 1 });
    expect(calls[1]!.prompt).toContain('{"relations":[["r2",');
    expect(calls[1]!.prompt).not.toContain('["r1","Concept');
    expect(calls[1]!.prompt.endsWith(renderPrompt("graph.entity_identity.repair"))).toBe(true);
    expect(outcome.digest).toEqual({ decisions: { r1: "c1", r2: "c2" } });
  });

  it("hands each call the product's own call contract beside the static one (F4 D24)", async () => {
    const item = itemOf("knowledge-graph-generation", confirmationBody());
    const { caller, calls } = scripted([
      JSON.stringify({ matches: [["r1", "c1"]] }),
      JSON.stringify({ matches: [["r2", "c2"]] })
    ]);
    await item.run(caller, "recorded");
    expect(calls.map((call) => call.answerContract?.name)).toEqual([
      "confirmation",
      "confirmation"
    ]);
    const [first, repair] = calls.map((call) => call.answerContract!.callContract!);
    // The first ask covers both rows in order; the repair only the row it asks.
    expect(
      first!.safeParse({
        matches: [
          ["r1", "c1"],
          ["r2", null]
        ]
      }).success
    ).toBe(true);
    expect(
      first!.safeParse({
        matches: [
          ["r2", null],
          ["r1", "c1"]
        ]
      }).success
    ).toBe(false);
    expect(repair!.safeParse({ matches: [["r2", "c2"]] }).success).toBe(true);
    expect(repair!.safeParse({ matches: [["r1", "c1"]] }).success).toBe(false);
  });

  it("rebuilds a call whose later row names an earlier row by its key (F4 D20)", async () => {
    const body = buildRelationMatchPrompt(
      [
        {
          key: "r1",
          predicate: "Person: Ada",
          definition: "Ada, from batch 0.",
          candidates: [{ key: "c1", predicate: "Person: Ada", definition: "Stored." }]
        },
        {
          key: "r2",
          predicate: "Person: Ada",
          definition: "Ada, from batch 1.",
          candidates: [
            { key: "r1", predicate: "Person: Ada", definition: "Ada, from batch 0." },
            { key: "c1", predicate: "Person: Ada", definition: "Stored." }
          ]
        }
      ],
      true
    );
    const item = itemOf("knowledge-graph-generation", body);
    expect(item.current).toBe(body);
    const { caller } = scripted([
      JSON.stringify({
        matches: [
          ["r1", "c1"],
          ["r2", "r1"]
        ]
      })
    ]);
    expect((await item.run(caller, "recorded")).digest).toEqual({
      decisions: { r1: "c1", r2: "r1" }
    });
  });

  it("fails when a row is still undecided after the repair", async () => {
    const item = itemOf("knowledge-graph-generation", confirmationBody());
    const { caller } = scripted(["{}", "{}"]);
    expect(await item.run(caller, "recorded")).toMatchObject({
      ok: false,
      error: "errors.relationTypes.invalidOutput"
    });
  });

  it("compares decisions row by row", () => {
    const item = itemOf("knowledge-graph-generation", confirmationBody());
    const theirs = { decisions: { r1: "c1", r2: null } };
    expect(item.compare({ decisions: { r1: "c1", r2: "c2" } }, theirs)).toMatchObject({
      agreement: 0.5,
      overMergeRate: 0.5,
      underMergeRate: 0
    });
    expect(
      item.digestOf(
        JSON.stringify({
          matches: [
            ["r1", "c1"],
            ["zz", "c9"]
          ]
        })
      )
    ).toEqual({
      decisions: { r1: "c1" }
    });
  });
});

describe("the summary flow", () => {
  it("is one call whose answer the product's reader accepts", async () => {
    const item = itemOf("summarization", summaryBody());
    const { caller, calls } = scripted([summaryAnswer]);
    const outcome = await item.run(caller, "recorded");
    expect(calls).toHaveLength(1);
    expect(outcome.digest).toMatchObject({ concepts: 1 });
    expect(item.compare({ words: 4, concepts: 0 }, { words: 8, concepts: 2 })).toEqual({
      lengthRatio: 0.5,
      conceptRatio: 0
    });
  });

  it("has no repair: an empty answer ends the flow", async () => {
    const item = itemOf("summarization", summaryBody());
    const { caller, calls } = scripted([""]);
    expect(await item.run(caller, "recorded")).toMatchObject({
      ok: false,
      error: "ai_task_empty_output"
    });
    expect(calls).toHaveLength(1);
  });

  it("reads the reduction and aggregate prompts too", () => {
    const reduce = renderPrompt("summary.reduce", { partial_summaries: "one\n\n---\n\ntwo" });
    expect(itemOf("summarization", reduce).operation).toBe("summary_reduce");
    const aggregate = renderPrompt("summary.aggregate", {
      source_type: "book",
      source_title: "A title",
      ordered_subparts: "[Subpart 1: A]\nBody"
    });
    expect(itemOf("summarization", aggregate).operation).toBe("summary_aggregate");
  });
});

describe("the overview flow", () => {
  it("accepts a valid answer and digests the evidence it cites", async () => {
    const item = itemOf("structured-output", overviewBody());
    const { caller, calls } = scripted([overviewAnswer]);
    const outcome = await item.run(caller, "recorded");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ contract: "overview", maxOutputTokens: 4096 });
    expect(outcome.digest).toEqual({ paragraphs: 2, evidence: ["1", "2"] });
  });

  it("repairs once with the validation errors appended to the first prompt", async () => {
    const item = itemOf("structured-output", overviewBody());
    const bad = JSON.stringify({
      paragraphs: [{ text: "Cites nothing real [9].", citations: [9] }]
    });
    const { caller, calls } = scripted([bad, overviewAnswer]);
    const outcome = await item.run(caller, "recorded");
    expect(calls[1]!.isRepair).toBe(true);
    expect(calls[1]!.prompt.startsWith(overviewBody())).toBe(true);
    expect(calls[1]!.prompt).toContain("which is not in the evidence");
    expect(outcome.ok).toBe(true);
  });

  it("fails when the repair is invalid too", async () => {
    const item = itemOf("structured-output", overviewBody());
    const { caller } = scripted(["{}", "{}"]);
    expect(await item.run(caller, "recorded")).toMatchObject({
      ok: false,
      error: "overview_invalid"
    });
  });

  it("compares paragraphs and evidence", () => {
    const item = itemOf("structured-output", overviewBody());
    expect(
      item.compare({ paragraphs: 1, evidence: ["1"] }, { paragraphs: 2, evidence: ["1", "2"] })
    ).toEqual({ paragraphRatio: 0.5, evidenceOverlap: 0.5 });
    expect(item.digestOf("nonsense")).toBeNull();
  });
});

describe("the topic names flow", () => {
  it("accepts good names with one call", async () => {
    const item = itemOf("structured-output", namesBody());
    const { caller, calls } = scripted([namesAnswer]);
    const outcome = await item.run(caller, "recorded");
    expect(calls).toHaveLength(1);
    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.digest).toEqual({
      titles: { T1: "spaced practice", T2: "test feedback" },
      rejected: 0
    });
  });

  it("asks again only for the topics whose name was rejected, as the service does", async () => {
    const item = itemOf("structured-output", namesBody());
    const generic = JSON.stringify({
      topics: [
        {
          alias: "T1",
          title: "Spaced practice",
          description: "About spacing.",
          aliases: [],
          language: "en"
        },
        {
          alias: "T2",
          title: "Miscellaneous",
          description: "Various.",
          aliases: [],
          language: "en"
        }
      ]
    });
    const second = JSON.stringify({
      topics: [
        {
          alias: "T2",
          title: "Test feedback",
          description: "About feedback.",
          aliases: [],
          language: "en"
        }
      ]
    });
    const { caller, calls } = scripted([generic, second]);
    const outcome = await item.run(caller, "recorded");
    expect(calls[1]).toMatchObject({ isRepair: true, attempt: 1 });
    expect(calls[1]!.prompt).toContain("T2: ");
    expect(calls[1]!.prompt).toContain('"topics":[{"alias":"T2"');
    expect(calls[1]!.prompt).not.toContain('{"alias":"T1","size"');
    expect(outcome).toMatchObject({ ok: true });
  });

  it("reports names that stay rejected after the allowed repairs", async () => {
    const item = itemOf("structured-output", namesBody());
    const { caller } = scripted(["{}", "{}", "{}"]);
    expect(await item.run(caller, "recorded")).toMatchObject({
      ok: false,
      error: "naming_rejected"
    });
  });

  it("compares titles by alias", () => {
    const item = itemOf("structured-output", namesBody());
    const theirs = { titles: { T1: "spaced practice", T2: "test feedback" }, rejected: 0 };
    expect(
      item.compare({ titles: { T1: "spaced practice", T2: "feedback" }, rejected: 0 }, theirs)
    ).toMatchObject({ namedShare: 1, exactTitle: 0.5, titleOverlap: 0.75 });
  });
});

describe("the typing flow", () => {
  it("accepts a complete answer", async () => {
    const item = itemOf("structured-output", typingBody());
    const { caller, calls } = scripted([typingAnswer]);
    const outcome = await item.run(caller, "recorded");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ contract: "typing", operation: "relation_typing" });
    expect(outcome.digest).toEqual({
      verdicts: { p1: "contradicts/both", p2: "same_as/both" }
    });
  });

  it("re-asks only the missing pair with the product's repair prompt, then stops", async () => {
    const item = itemOf("structured-output", typingBody());
    const first = JSON.stringify({ pairs: [{ p: "p1", t: "contradicts", d: "both" }] });
    const second = JSON.stringify({ pairs: [{ p: "p2", t: "none", d: "none" }] });
    const { caller, calls } = scripted([first, second]);
    const outcome = await item.run(caller, "recorded");
    expect(calls[1]).toMatchObject({ isRepair: true, operation: "relation_typing_repair" });
    expect(calls[1]!.prompt).toContain("p2: no result");
    expect(calls[1]!.prompt).toContain('PAIRS:\n[{"p":"p2"');
    expect(calls[1]!.prompt).not.toContain('{"p":"p1","a"');
    expect(outcome).toMatchObject({ ok: true });
  });

  it("hands each call the contract of the pairs it asks (F4 D24)", async () => {
    const item = itemOf("structured-output", typingBody());
    const first = JSON.stringify({ pairs: [{ p: "p1", t: "contradicts", d: "both" }] });
    const second = JSON.stringify({ pairs: [{ p: "p2", t: "none", d: "none" }] });
    const { caller, calls } = scripted([first, second]);
    await item.run(caller, "recorded");
    const [ask, reask] = calls.map((call) => call.answerContract!.callContract!);
    const both = {
      pairs: [
        { p: "p1", t: "contradicts", d: "both" },
        { p: "p2", t: "none", d: "none" }
      ]
    };
    expect(ask!.safeParse(both).success).toBe(true);
    expect(reask!.safeParse(both).success).toBe(false);
    expect(reask!.safeParse({ pairs: [{ p: "p2", t: "none", d: "none" }] }).success).toBe(true);
  });

  it("counts a failed call as an attempt and asks the first prompt again", async () => {
    const item = itemOf("structured-output", typingBody());
    const { caller, calls } = scripted([new Error("deadline"), typingAnswer]);
    const outcome = await item.run(caller, "recorded");
    expect(calls.map((call) => call.isRepair)).toEqual([false, false]);
    expect(outcome.ok).toBe(true);
  });

  it("leaves the pairs unanswered after the allowed attempts", async () => {
    const item = itemOf("structured-output", typingBody());
    const { caller } = scripted(["{}", "{}"]);
    expect(await item.run(caller, "recorded")).toMatchObject({
      ok: false,
      error: "typing_unanswered"
    });
  });

  it("compares verdicts", () => {
    const item = itemOf("structured-output", typingBody());
    const theirs = { verdicts: { p1: "contradicts/both", p2: "same_as/both" } };
    expect(
      item.compare({ verdicts: { p1: "contradicts/both", p2: "supports/ab" } }, theirs)
    ).toMatchObject({
      answeredShare: 1,
      typeAgreement: 0.5,
      verdictAgreement: 0.5
    });
  });
});

describe("what a caller is asked", () => {
  it("is the prompt a service would send once the language is added", () => {
    const body = notesBody();
    expect(composeInput(body, "en").endsWith(body)).toBe(true);
    expect(composeInput(body, "en")).not.toBe(body);
  });
});
