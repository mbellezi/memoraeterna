import {
  RelationCalibrationEntrySchema,
  relationsConfig,
  type RelationCalibrationEntry
} from "@app/domain";
import { describe, expect, it } from "vitest";

import {
  addRemoteCalibration,
  decisionsIdentity,
  decisionsRequestDesign,
  decisionsRequestDesignSha256,
  meanOfOrders,
  nearestRows,
  neighbourhoods,
  planRequests,
  logitAt,
  type RemoteFreezeRecord,
  type RemoteProposal
} from "./bakeoff-remote.ts";
import { canonicalJson, sha256Hex } from "./bakeoff.ts";
import { designFingerprint } from "../spikes/decisions/design.ts";

const instruction = "Given a note (Query), decide whether the Document note makes a claim.";

describe("the Decisions decider's identity (plan decision 30)", () => {
  it("names the model, the instruction and the whole request design, with no runtime build", () => {
    const identity = decisionsIdentity(instruction);
    expect(identity).toMatchObject({
      contract: "relation-decide-decisions-v1",
      instructionSha256: sha256Hex(instruction),
      template: "relation-pair-text-v1",
      bodyCharacters: 600,
      rule: "mean",
      provider: "openai",
      model: "gpt-6-luna",
      runtimeKind: "remote"
    });
    expect(identity.requestDesignSha256).toBe(
      sha256Hex(canonicalJson(decisionsRequestDesign(instruction)))
    );
    expect(decisionsRequestDesign(instruction)).toMatchObject({
      question: "predicate",
      orderSalts: ["bakeoff-1", "bakeoff-2"],
      scale: { kind: "logit", epsilon: 1e-7 },
      maxCandidatesPerRequest: 20
    });
    // Another instruction is another design.
    expect(decisionsRequestDesignSha256(`${instruction} Other.`)).not.toBe(
      identity.requestDesignSha256
    );
  });

  it("is the dense validation's design: Spike A's mechanism instruction, which the product no longer ships", () => {
    // The instruction the dense validation sent (Spike A's frozen `mechanism`, catalog revision 1).
    const mechanism =
      "Given a note (Query), decide whether the Document note makes a claim about the same underlying " +
      "mechanism, rule or phenomenon, so that a careful reader would link the two notes. Shared names, " +
      "titles, vocabulary, catalogs or credits do not count.";
    expect(designFingerprint(mechanism)).toBe(
      "2824e0cdd2c68756206913454e8a083638442a2d048373de8650392e219e6531"
    );
    // The first Decisions freeze (8017633d) named this dense design; the product's requests are
    // online (bakeoff-online.ts), so the shipped entry is the one re-frozen for them.
    expect(decisionsIdentity(mechanism).requestDesignSha256).toBe(
      "0e1ebd94857f256b1ea72cd5883c803c2b0db6d87277009b78c6679eaca4098c"
    );
    const shipped = relationsConfig.calibrations.find(
      (entry) => entry.identity.runtimeKind === "remote"
    );
    expect(shipped?.identity).toEqual({
      ...decisionsIdentity(mechanism),
      requestDesignSha256: expect.not.stringMatching(/^0e1ebd94/u)
    });
  });
});

describe("the gate F requests", () => {
  const text = (id: string) => `Title: ${id}\nIdea: idea of ${id}\nText: body`;

  it("ask each note against its whole neighbourhood, chunked at 20 in id order, in both orders", () => {
    const pairs: Array<[string, string]> = Array.from({ length: 25 }, (_, index) => [
      "q",
      `n${String(index).padStart(2, "0")}`
    ]);
    const map = neighbourhoods([...pairs, ["n00", "n01"], ["q", "q"]]);
    expect(map.get("q")).toHaveLength(25);
    expect(map.get("n00")).toEqual(["n01", "q"]);
    const planned = planRequests({ set: "x1", neighbourhoods: map, text, instruction });
    const forQ = planned.filter((job) => job.meta.queryId === "q");
    // 25 candidates: two balanced chunks (13 and 12) in each order.
    expect(forQ.map((job) => [job.order, job.meta.candidateIds.length])).toEqual([
      ["A", 13],
      ["A", 12],
      ["B", 13],
      ["B", 12]
    ]);
    // The same candidates in both orders, shuffled differently; one predicate per candidate.
    const [a, , b] = forQ;
    expect([...a!.meta.candidateIds].sort()).toEqual([...b!.meta.candidateIds].sort());
    expect(a!.meta.candidateIds).not.toEqual(b!.meta.candidateIds);
    expect(a!.request.questions.every((question) => question.type === "predicate")).toBe(true);
    expect(a!.request.model).toBe("gpt-6-luna");
    expect(a!.request.input.startsWith(instruction)).toBe(true);
  });

  it("approximate a library with no F3 export by each note's K nearest judged rows", () => {
    const rows = [
      { query: "a", doc: "b", cosine: 0.9 },
      { query: "a", doc: "c", cosine: 0.5 },
      { query: "a", doc: "c", cosine: 0.95 },
      { query: "a", doc: "d", cosine: 0.1 },
      { query: "a", doc: "a", cosine: 1 },
      { query: "b", doc: "d", cosine: 0.2 }
    ];
    expect(nearestRows(rows, 2)).toEqual([
      ["a", "c"],
      ["a", "b"],
      ["b", "d"]
    ]);
  });

  it("score a directed pair by the mean of its two orders' probabilities, at the bake-off's scale", () => {
    const { scores, incomplete } = meanOfOrders([
      { order: "A", query: "a", doc: "b", probability: 0.9 },
      { order: "B", query: "a", doc: "b", probability: 0.7 },
      { order: "A", query: "b", doc: "a", probability: 0.2 },
      { order: "A", query: "c", doc: "a", probability: 1 },
      { order: "B", query: "c", doc: "a", probability: 1 },
      { order: "B", query: "d", doc: "a", probability: null }
    ]);
    expect(incomplete).toBe(1);
    expect(scores).toEqual([
      { query: "a", doc: "b", probability: 0.8, logOdds: logitAt(0.8) },
      { query: "c", doc: "a", probability: 1, logOdds: logitAt(1) }
    ]);
    expect(logitAt(1)).toBeCloseTo(16.118, 3);
  });
});

describe("the re-freeze that adds the Decisions decider (D3)", () => {
  const hash = (digit: string) => digit.repeat(64);
  const local = RelationCalibrationEntrySchema.parse({
    kind: "isotonic",
    identity: {
      contract: "relation-decide-v1",
      instructionSha256: hash("a"),
      template: "relation-pair-text-v1",
      bodyCharacters: 600,
      rule: "mean",
      provider: "local",
      model: "mlx-qwen3-reranker-0.6b",
      runtimeKind: "mlx",
      repository: "Qwen/Qwen3-Reranker-0.6B",
      revision: "r",
      quantization: "bf16",
      artifactSha256: hash("b")
    },
    blocks: [{ fromScore: 0, probability: 0.4 }],
    applyFrom: null,
    suggestFrom: 0.125,
    basis: "plan decision 29",
    labelSetHash: hash("c"),
    freezeHash: hash("d"),
    fittedAt: "2026-10-18T05:42:47.694Z",
    parity: { referenceHash: hash("e"), scores: [1] }
  }) as RelationCalibrationEntry;
  const previous = {
    format: "memora-f3-freeze",
    version: 1,
    task: "T58",
    configHash: hash("d"),
    calibrationIdentity: "local",
    frozenAt: "2026-10-18T07:10:50.254Z",
    parity: { mlx: { verdict: "ok" } },
    inputHashes: { labels: hash("1") },
    config: { instruction: { id: "relation", sha256: hash("a") } },
    calibrations: [local],
    proposal: { sha256: hash("2"), computedAt: "2026-10-18T05:42:47.694Z" },
    previous: []
  } as unknown as RemoteFreezeRecord;
  const identity = decisionsIdentity(instruction);
  const proposal = {
    computedAt: "2026-10-18T07:51:57.188Z",
    inputs: { labelSetSha256: hash("c"), fitScores: hash("3") },
    requestDesign: decisionsRequestDesign(instruction),
    identity,
    blocks: [
      { fromScore: -16, probability: 0.01 },
      { fromScore: 2.372, probability: 0.95 }
    ],
    bands: { pApply: 0.8707, pSuggest: 0.6009, applyFromScore: 2.372, suggestFromScore: 1.497 },
    tuning: { forbiddenBeforeTyping: 0 }
  } as unknown as RemoteProposal;

  it("keeps every earlier calibration as it was and adds the new one under a new hash", () => {
    const record = addRemoteCalibration({
      previous,
      previousFile: "frozen-first.json",
      proposal,
      proposalSha256: hash("4"),
      frozenAt: new Date("2026-10-18T08:00:00.000Z")
    });
    expect(record.calibrations[0]).toEqual(local);
    expect(record.configHash).not.toBe(previous.configHash);
    expect(record.calibrations[1]).toMatchObject({
      kind: "isotonic",
      identity,
      applyFrom: 2.372,
      suggestFrom: 1.497,
      freezeHash: record.configHash,
      parity: { requestDesignSha256: identity.requestDesignSha256 }
    });
    expect(record.previous).toEqual([
      { configHash: previous.configHash, frozenAt: previous.frozenAt, file: "frozen-first.json" }
    ]);
    expect(record.frozenAt).toBe("2026-10-18T08:00:00.000Z");
    expect(record.inputHashes).toMatchObject({
      labels: hash("1"),
      "remote:decisions:fitScores": hash("3"),
      "remote:decisions:proposal": hash("4")
    });
    // The local proposal stays the record's: gate F's eval split keeps its weights.
    expect(record.proposal).toEqual(previous.proposal);
    expect(record.remote?.decisions?.requestDesign).toEqual(proposal.requestDesign);
    // The hash does not depend on the fit time.
    expect(
      addRemoteCalibration({
        previous,
        previousFile: "frozen-first.json",
        proposal: { ...proposal, computedAt: "2026-10-19T00:00:00.000Z" },
        proposalSha256: hash("4"),
        frozenAt: new Date("2026-10-18T09:00:00.000Z")
      }).configHash
    ).toBe(record.configHash);
  });

  it("refuses a second entry of the same model, a decider with no band, or a forbidden link", () => {
    const once = addRemoteCalibration({
      previous,
      previousFile: "f.json",
      proposal,
      proposalSha256: hash("4"),
      frozenAt: new Date()
    });
    expect(() =>
      addRemoteCalibration({
        previous: once,
        previousFile: "g.json",
        proposal,
        proposalSha256: hash("4"),
        frozenAt: new Date()
      })
    ).toThrow("already holds");
    expect(() =>
      addRemoteCalibration({
        previous,
        previousFile: "f.json",
        proposal: {
          ...proposal,
          bands: { ...proposal.bands, applyFromScore: null, suggestFromScore: null }
        },
        proposalSha256: hash("4"),
        frozenAt: new Date()
      })
    ).toThrow("no band");
    expect(() =>
      addRemoteCalibration({
        previous,
        previousFile: "f.json",
        proposal: { ...proposal, tuning: { ...proposal.tuning, forbiddenBeforeTyping: 1 } },
        proposalSha256: hash("4"),
        frozenAt: new Date()
      })
    ).toThrow("forbidden");
  });
});
