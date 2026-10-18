import { decisionsLogOdds, resolveDecisionsLimits } from "@app/ai";
import { relationsConfig, RelationCalibrationEntrySchema } from "@app/domain";
import { describe, expect, it } from "vitest";

import {
  decisionsInstruction,
  directedFromAnswers,
  labelTurns,
  listRequests,
  nearestEarlier,
  productDecisionsIdentity,
  replayOnline,
  type PlannedList
} from "./bakeoff-online.ts";
import {
  addRemoteCalibration,
  type RemoteFreezeRecord,
  type RemoteProposal
} from "./bakeoff-remote.ts";

const limits = resolveDecisionsLimits();
const byId = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

describe("the online replay (the product's request makeup, in arrival order)", () => {
  const targets = new Map([
    ["b", ["a"]],
    ["c", ["a", "b"]],
    ["d", ["a", "b", "c"]]
  ]);
  const replay = (maxNeighbourhood: number) =>
    replayOnline({
      set: "t",
      order: ["a", "b", "c", "d"],
      targets,
      compare: byId,
      maxNeighbourhood,
      emit: () => true
    });

  it("asks forward with the targets, then each reverse with the note and the candidate's partners so far", () => {
    const lists = replay(3).map((list) => [
      list.turn,
      list.kind,
      list.query,
      list.members.join("")
    ]);
    expect(lists).toEqual([
      ["b", "forward", "b", "a"],
      ["b", "reverse", "a", "b"],
      ["c", "forward", "c", "ab"],
      // a was decided against b before; the turn's own forward decision c-a is the target.
      ["c", "reverse", "a", "bc"],
      ["c", "reverse", "b", "ac"],
      ["d", "forward", "d", "abc"],
      ["d", "reverse", "a", "bcd"],
      ["d", "reverse", "b", "acd"],
      ["d", "reverse", "c", "abd"]
    ]);
  });

  it("caps a request at maxNeighbourhood, never dropping a target, partners in content order", () => {
    const lists = replay(2).filter((list) => list.turn === "d");
    expect(lists.map((list) => list.members.join(""))).toEqual(["abc", "bd", "ad", "ad"]);
    expect(lists[0]!.wanted.map((row) => [row.member, row.direction])).toEqual([
      ["a", "hiToLo"],
      ["b", "hiToLo"],
      ["c", "hiToLo"]
    ]);
  });

  it("asks no direction twice: a pair both notes list is a target, not a question, the second time", () => {
    const lists = replayOnline({
      set: "t",
      order: ["x", "y"],
      targets: new Map([
        ["x", ["y"]],
        ["y", ["x"]]
      ]),
      compare: byId,
      maxNeighbourhood: 12,
      emit: () => true
    });
    expect(lists.map((list) => [list.turn, list.kind])).toEqual([
      ["x", "forward"],
      ["x", "reverse"]
    ]);
  });

  it("marks the reverse lists the filter may drop, and asks labelled pairs and injected ones always", () => {
    const lists = replayOnline({
      set: "t",
      order: ["a", "b", "c"],
      targets: new Map([
        ["b", ["a"]],
        ["c", ["a"]]
      ]),
      compare: byId,
      maxNeighbourhood: 12,
      emit: (turn) => turn === "c",
      injected: new Map([["c", ["b"]]]),
      always: new Set(["a:c"])
    });
    expect(
      lists.map((list) => [list.kind, list.query, list.members.join(""), list.filterPair])
    ).toEqual([
      ["forward", "c", "a", null],
      ["forward-injected", "c", "ab", null],
      ["reverse", "a", "bc", null],
      ["reverse-injected", "b", "ac", null]
    ]);
  });

  it("places a label in the turn that lists it, else injects it into its later note", () => {
    const turns = labelTurns({
      pairs: [
        { lo: "a", hi: "c" },
        { lo: "a", hi: "d" },
        { lo: "e", hi: "b" },
        { lo: "e", hi: "f" }
      ],
      order: ["a", "b", "c", "d"],
      targets: new Map([["c", ["a"]]])
    });
    expect([...turns.decided]).toEqual([["a:c", "c"]]);
    expect([...turns.injected]).toEqual([
      ["d", ["a"]],
      ["b", ["e"]]
    ]);
    expect(turns.unplaced).toEqual(["e:f"]);
  });

  it("takes a library's K nearest earlier notes by its judged rows", () => {
    expect(
      nearestEarlier(
        ["a", "b", "c"],
        [
          { query: "c", doc: "a", cosine: 0.2 },
          { query: "c", doc: "b", cosine: 0.9 },
          { query: "a", doc: "b", cosine: 0.9 },
          { query: "b", doc: "a", cosine: 0.4 }
        ],
        1
      )
    ).toEqual(
      new Map([
        ["c", ["b"]],
        ["b", ["a"]]
      ])
    );
  });
});

describe("the online scores", () => {
  it("read each wanted direction from its requests, as the product combines two orders", () => {
    const list = {
      set: "t",
      kind: "forward" as const,
      turn: "q",
      query: "q",
      members: ["m1", "m2"],
      wanted: [{ member: "m2", pair: "m2:q", direction: "hiToLo" as const }],
      filterPair: null
    };
    const text = (id: string) => `Title: ${id}\nIdea: ${id}\nText: ${id}`;
    const requests = listRequests(list, text, decisionsInstruction(), limits);
    const planned: PlannedList = {
      ...list,
      requests: requests.map(({ planned: request, hash }) => ({
        hash,
        candidateIndices: request.candidateIndices,
        orders: [...request.orders]
      }))
    };
    // Each request answers in its own candidate order: m2's probability is 0.9 in A and 0.7 in B.
    const answers = new Map(
      requests.map(({ planned: request, hash }) => [
        hash,
        request.candidateIndices.map((index) =>
          index === 1 ? (request.orders[0] === "A" ? 0.9 : 0.7) : 0.1
        )
      ])
    );
    const scored = directedFromAnswers([planned], answers, limits, () => true);
    expect(scored.missing).toBe(0);
    expect(scored.probability.get("q>m2")).toBeCloseTo(0.8, 10);
    expect(scored.logOdds.get("q>m2")).toBeCloseTo(
      decisionsLogOdds(0.8, limits.probabilityEpsilon),
      10
    );
    // An unanswered request leaves its directions missing.
    expect(directedFromAnswers([planned], new Map(), limits, () => true).missing).toBe(1);
  });
});

describe("the identity frozen for the product's requests", () => {
  it("is the identity relations-config ships, computed from the product's own builder", () => {
    const shipped = relationsConfig.calibrations.find(
      (entry) => entry.identity.runtimeKind === "remote"
    );
    const identity = productDecisionsIdentity(decisionsInstruction(), limits);
    expect(shipped?.identity).toEqual(identity);
    expect(shipped).toMatchObject({
      kind: "isotonic",
      applyFrom: expect.closeTo(2.228, 3),
      suggestFrom: expect.closeTo(1.593, 3),
      parity: { requestDesignSha256: identity.requestDesignSha256 }
    });
  });

  it("replaces the same model's entry of another request design in a re-freeze, and records it", () => {
    const shipped = relationsConfig.calibrations.find(
      (entry) => entry.identity.runtimeKind === "remote"
    )!;
    const dense = RelationCalibrationEntrySchema.parse({
      ...shipped,
      identity: { ...shipped.identity, requestDesignSha256: "e".repeat(64) },
      parity: { requestDesignSha256: "e".repeat(64) },
      freezeHash: "f".repeat(64)
    });
    const previous = {
      format: "memora-f3-freeze",
      configHash: "a".repeat(64),
      frozenAt: "2026-10-18T07:53:06.300Z",
      parity: {},
      inputHashes: {},
      config: {},
      calibrations: [relationsConfig.calibrations[0]!, dense],
      proposal: { sha256: "b".repeat(64), computedAt: "x" },
      previous: []
    } as unknown as RemoteFreezeRecord;
    const proposal = {
      computedAt: "2026-10-18T09:59:13.328Z",
      inputs: { labelSetSha256: "c".repeat(64) },
      requestDesign: { neighbourhood: { kind: "online" } },
      identity: shipped.identity,
      folds: { seed: 20261022, count: 5 },
      blocks: shipped.kind === "isotonic" ? shipped.blocks : [],
      bands: { pApply: 0.88, pSuggest: 0.62, applyFromScore: 2.228, suggestFromScore: 1.593 },
      tuning: { forbiddenBeforeTyping: 0 }
    } as unknown as RemoteProposal;
    const add = (supersedes?: string) =>
      addRemoteCalibration({
        previous,
        previousFile: "frozen-first.json",
        proposal,
        proposalSha256: "d".repeat(64),
        frozenAt: new Date("2026-10-18T10:00:00.000Z"),
        ...(supersedes ? { supersedes } : {}),
        basis: "online"
      });
    expect(() => add()).toThrow("already holds");
    const record = add("another request design");
    expect(record.calibrations.map((entry) => entry.identity.runtimeKind)).toEqual([
      "mlx",
      "remote"
    ]);
    expect(record.calibrations[1]).toMatchObject({ identity: shipped.identity, basis: "online" });
    expect(record.remote?.decisions?.superseded).toEqual([
      { requestDesignSha256: "e".repeat(64), freezeHash: "f".repeat(64) }
    ]);
    expect(record.previous).toEqual([
      {
        configHash: "a".repeat(64),
        frozenAt: "2026-10-18T07:53:06.300Z",
        file: "frozen-first.json"
      }
    ]);
  });
});
