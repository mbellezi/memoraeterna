import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildGateReport,
  buildLib2Pairs,
  defaultGateRules,
  evaluateLib2,
  evaluateReplayGate,
  gateRule,
  pairGateOf,
  renderGateMarkdown,
  replayExtras,
  replayPairFeatures,
  ruleAllows,
  runSecondNeighbourGate,
  type Lib2Inputs
} from "./second-neighbour-gate.ts";
import {
  replayInputSchema,
  replayOrder,
  type ReplayInput,
  type SelectedPairContext
} from "./source-order-replay.ts";
import { cacheRoot } from "./test-world.ts";

const context = (overrides: Partial<SelectedPairContext>): SelectedPairContext => ({
  rootId: "N",
  candidateId: "K",
  reason: "nearest",
  cosine: 0.6,
  nearestRank: 2,
  nearestCosine: 0.65,
  candidateNearestCosine: 0.9,
  ...overrides
});

describe("the rule family", () => {
  it("is fixed in code: gaps alone, floors alone, three gaps with each floor", () => {
    const rules = defaultGateRules();
    expect(rules).toHaveLength(7 + 2 + 3 * 2);
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);
    expect(rules[0]).toEqual({ id: "gap<=0.01", floor: null, maxGap: 0.01 });
    expect(gateRule(0.8, 0.03).id).toBe("gap<=0.03 or cos>=0.8");
    expect(gateRule(null, null).id).toBe("no extras");
  });

  it("reads a pair as an extra only when one neighbour would not have selected it from either side", () => {
    // The arriving root's nearest, an owed pair and a pair that beats the candidate's nearest are
    // what one neighbour judges too.
    expect(replayPairFeatures(context({ nearestRank: 1 })).extra).toBe(false);
    expect(replayPairFeatures(context({ reason: "owed", nearestRank: null })).extra).toBe(false);
    expect(replayPairFeatures(context({ cosine: 0.95 })).extra).toBe(false);
    expect(replayPairFeatures(context({ candidateNearestCosine: null })).extra).toBe(false);
    // The arriving root's second nearest, behind its nearest and behind the candidate's.
    const second = replayPairFeatures(context({}));
    expect(second).toMatchObject({ extra: true, cosine: 0.6 });
    expect(second.gap).toBeCloseTo(0.05, 9);
    // A reverse partner has only the candidate's side: its gap is to the candidate's nearest.
    const reverse = replayPairFeatures(
      context({ reason: "reverse", nearestRank: null, nearestCosine: 0.7 })
    );
    expect(reverse).toMatchObject({ extra: true, cosine: 0.6 });
    expect(reverse.gap).toBeCloseTo(0.3, 9);
    // The closer side decides: the candidate's nearest is nearly as near as the arriving root's.
    expect(
      replayPairFeatures(context({ candidateNearestCosine: 0.61, nearestCosine: 0.9 })).gap
    ).toBeCloseTo(0.01, 9);
  });

  it("judges an extra when it is close to the nearest or above the floor, and never refuses the rest", () => {
    const extra = { extra: true, gap: 0.04, cosine: 0.6 };
    expect(ruleAllows(gateRule(null, 0.05), extra)).toBe(true);
    expect(ruleAllows(gateRule(null, 0.03), extra)).toBe(false);
    expect(ruleAllows(gateRule(0.6, null), extra)).toBe(true);
    expect(ruleAllows(gateRule(0.7, 0.03), extra)).toBe(false);
    expect(ruleAllows(gateRule(0.7, 0.04), extra)).toBe(true);
    expect(ruleAllows(gateRule(null, null), extra)).toBe(false);
    expect(ruleAllows(gateRule(null, null), { extra: false, gap: 0, cosine: 0.1 })).toBe(true);
    expect(ruleAllows(null, extra)).toBe(true);
  });
});

// --- LIB2 on a library small enough to check by hand -----------------------------------------

/**
 * Anchor X: nearest P (0.90), second Z (0.88). Anchor Y: nearest R (0.80), second S (0.60, far).
 * Anchor Z: nearest X (0.88), second T (0.87, close). So the pair X-Z is X's second nearest and Z's
 * nearest; S and T are second-nearest only. Panel and verdicts are set per pair below.
 */
const lib2Inputs = (): Lib2Inputs => ({
  labelSet: {
    items: [
      pair("p-P", "X", "P", [{ set: "source-neighbours", basis: "nearest", anchor: "X" }]),
      pair("p-XZ", "X", "Z", [
        { set: "source-neighbours", basis: "second-nearest", anchor: "X" },
        { set: "source-neighbours", basis: "nearest", anchor: "Z" }
      ]),
      pair("p-R", "Y", "R", [{ set: "source-neighbours", basis: "nearest", anchor: "Y" }]),
      pair("p-S", "Y", "S", [{ set: "source-neighbours", basis: "second-nearest", anchor: "Y" }]),
      pair("p-T", "Z", "T", [{ set: "source-neighbours", basis: "second-nearest", anchor: "Z" }]),
      pair("p-other", "X", "P", [{ set: "source-base", basis: "nearest", anchor: "X" }])
    ]
  },
  tally: {
    items: [
      { pairId: "p-P", kind: "source", related: { majority: true } },
      { pairId: "p-XZ", kind: "source", related: { majority: true } },
      { pairId: "p-R", kind: "source", related: { majority: false } },
      { pairId: "p-S", kind: "source", related: { majority: true } },
      { pairId: "p-T", kind: "source", related: { majority: false } }
    ]
  },
  contexts: {
    lib: {
      roots: [
        root("X", [
          ["P", 0.9],
          ["Z", 0.88],
          ["U", 0.5]
        ]),
        root("Y", [
          ["R", 0.8],
          ["S", 0.6]
        ]),
        root("Z", [
          ["X", 0.88],
          ["T", 0.87]
        ])
      ]
    }
  },
  verdicts: {
    lib: {
      pairs: [
        verdict("p-P", "related"),
        verdict("p-XZ", "related"),
        verdict("p-R", "related"),
        verdict("p-S", "not_related"),
        verdict("p-T", "related")
      ]
    }
  }
});

function pair(
  pairId: string,
  lo: string,
  hi: string,
  sets: Array<{ set: string; basis: string; anchor: string }>
): Lib2Inputs["labelSet"]["items"][number] {
  return { pairId, kind: "source", library: "lib", loRoot: lo, hiRoot: hi, sets };
}
const root = (id: string, neighbours: Array<[string, number]>) => ({
  id,
  neighbours: neighbours.map(([neighbour, cosine]) => ({ id: neighbour, cosine }))
});
const verdict = (label: string, value: string) => ({ label, status: "judged", verdict: value });

describe("LIB2, the labelled second library", () => {
  it("joins each labelled pair to its panel label, its recorded verdict and its anchor's cosines", () => {
    const { pairs, problems } = buildLib2Pairs(lib2Inputs());
    expect(problems).toEqual([]);
    expect(pairs.map((item) => item.pairId)).toEqual(["p-P", "p-R", "p-S", "p-T", "p-XZ"]);
    const xz = pairs.find((item) => item.pairId === "p-XZ")!;
    expect(xz).toMatchObject({ panel: true, judge: { status: "judged", related: true } });
    // Second nearest of X and nearest of Z: one pair, two events, each from its anchor's side.
    expect(xz.events).toEqual([
      { basis: "second-nearest", anchor: "X", cosine: 0.88, nearestCosine: 0.9 },
      { basis: "nearest", anchor: "Z", cosine: 0.88, nearestCosine: 0.88 }
    ]);
  });

  it("reports labels it cannot place instead of guessing", () => {
    const inputs = lib2Inputs();
    inputs.tally.items.push({ pairId: "p-rank", kind: "source", related: { majority: true } });
    inputs.labelSet.items.push(
      pair("p-lost", "X", "ZZ", [{ set: "source-neighbours", basis: "nearest", anchor: "X" }]),
      pair("p-rank", "X", "Z", [{ set: "source-neighbours", basis: "nearest", anchor: "X" }]),
      pair("p-nolabel", "Y", "R", [{ set: "source-neighbours", basis: "nearest", anchor: "Y" }])
    );
    const { pairs, problems } = buildLib2Pairs(inputs);
    expect(problems).toEqual([
      "p-lost: no cosine for nearest anchor X",
      "p-rank: labelled nearest but rank 2 in its anchor's list",
      "p-nolabel: no panel majority"
    ]);
    expect(pairs.map((item) => item.pairId)).not.toContain("p-lost");
  });

  it("counts one neighbour, two neighbours and a gate pair by pair", () => {
    const { pairs } = buildLib2Pairs(lib2Inputs());
    // One neighbour judges the pairs that are some anchor's nearest: P, X-Z (Z's), R.
    expect(evaluateLib2(pairs, "nearest-only")).toMatchObject({
      judgedPairs: 3,
      panelPositives: 3,
      acceptedInU: 2,
      panelNegativesAccepted: 1,
      secondOnlyJudged: 0
    });
    expect(evaluateLib2(pairs, "nearest-only").callsPerAnchor).toBeCloseTo(1, 9);
    // Two neighbours judge all five: S is not related, T is a related panel-negative.
    expect(evaluateLib2(pairs, "all")).toMatchObject({
      judgedPairs: 5,
      acceptedInU: 2,
      panelNegativesAccepted: 2,
      secondOnlyJudged: 2
    });
    // A gap of 0.02 keeps T (0.01 behind Z's nearest) and refuses S (0.2 behind Y's); X-Z is judged anyway.
    expect(evaluateLib2(pairs, gateRule(null, 0.02))).toMatchObject({
      judgedPairs: 4,
      acceptedInU: 2,
      panelNegativesAccepted: 2,
      secondOnlyJudged: 1
    });
    // A floor of 0.65 keeps T (0.87) too, and S (0.60) stays out.
    expect(evaluateLib2(pairs, gateRule(0.65, null)).judgedPairs).toBe(4);
    expect(evaluateLib2(pairs, gateRule(null, null)).judgedPairs).toBe(3);
  });

  it("counts a pair no verdict run judged as not accepted", () => {
    const inputs = lib2Inputs();
    inputs.verdicts.lib!.pairs = inputs.verdicts.lib!.pairs.filter((item) => item.label !== "p-P");
    const { pairs } = buildLib2Pairs(inputs);
    expect(pairs.find((item) => item.pairId === "p-P")!.judge).toBeNull();
    expect(evaluateLib2(pairs, "nearest-only").acceptedInU).toBe(1);
  });
});

// --- The replay behind the gate --------------------------------------------------------------

/** Unit vectors at a given cosine from axis 0 (each in its own plane). */
const at = (cosine: number, axis: number) =>
  Array.from({ length: 8 }, (_, i) =>
    i === 0 ? cosine : i === axis ? Math.sqrt(1 - cosine * cosine) : 0
  );

const replayInput = (): ReplayInput =>
  replayInputSchema.parse({
    format: "memora-source-order-replay-input",
    version: 1,
    roots: [
      { id: "A", title: "Alpha", vector: at(1, 1), hasNotes: true },
      { id: "B", title: "Beta", vector: at(0.9, 1), hasNotes: true },
      { id: "C", title: "Gamma", vector: at(0.2, 2), hasNotes: true },
      { id: "D", title: "Delta", vector: at(0.1, 3), hasNotes: true }
    ],
    promoted: [["C", "D"]],
    verdicts: [
      { pair: ["A", "B"], accepted: true },
      { pair: ["A", "C"], accepted: false },
      { pair: ["B", "C"], accepted: true },
      { pair: ["B", "D"], accepted: false }
    ],
    expected: [
      ["A", "B"],
      ["C", "D"]
    ],
    forbidden: [["A", "D"]]
  });

describe("the source-order replay behind the gate", () => {
  it("refuses a second-neighbour pair by its gap and prices the refusal", () => {
    const input = replayInput();
    // C arrives after A and B: its nearest is A (0.20), then B (0.18): a gap of 0.02.
    const tight = replayOrder(input, ["A", "B", "C", "D"], {
      neighbours: 2,
      pairGate: pairGateOf(gateRule(null, 0.01))
    });
    expect(tight.skipped).toContain("B|C");
    const loose = replayOrder(input, ["A", "B", "C", "D"], {
      neighbours: 2,
      pairGate: pairGateOf(gateRule(null, 0.05))
    });
    expect(loose.skipped).not.toContain("B|C");
    expect(loose.calls).toBeGreaterThan(tight.calls);
  });

  it("summarizes calls per source, the acceptances the gate cost and the one-call-per-root bound", () => {
    const input = replayInput();
    const none = evaluateReplayGate(input, { orders: 30, rule: null, neighbours: 2 });
    const closed = evaluateReplayGate(input, {
      orders: 30,
      rule: gateRule(null, null),
      neighbours: 2
    });
    expect(none.rule).toBe("all extras");
    expect(none.lostRecordedAcceptancesPerOrder).toBe(0);
    expect(closed.rule).toBe("no extras");
    expect(closed.callsPerSource.mean).toBeLessThan(none.callsPerSource.mean);
    expect(closed.skippedPerSource).toBeGreaterThan(0);
    // A gate that refuses pairs leaves no more pairs to judge live.
    expect(closed.closure.reached).toBeLessThanOrEqual(none.closure.reached);
    // B-C is a recorded acceptance: refusing it costs one in every order that reaches it.
    expect(closed.lostRecordedAcceptancePairs).toBeGreaterThanOrEqual(1);
    expect(none.batchedCallsPerSource).toBeLessThanOrEqual(none.callsPerSource.mean);
    expect(none.pairsPerBatchedCall).toBeGreaterThanOrEqual(1);
    const one = evaluateReplayGate(input, { orders: 30, rule: null, neighbours: 1 });
    expect(one.rule).toBe("one neighbour");
    expect(one.callsPerSource.mean).toBeLessThanOrEqual(none.callsPerSource.mean);
  });

  it("measures the pairs only the second neighbour selects", () => {
    const extras = replayExtras(replayInput(), 30);
    expect(extras.perSource).toBeGreaterThan(0);
    expect(extras.maxCosine).toBeLessThan(0.5);
    expect(extras.medianGap).toBeGreaterThanOrEqual(0);
  });
});

describe("the report", () => {
  const build = (bars?: {
    minAccepted: number;
    maxPanelNegatives: number;
    maxCallsPerSource: number;
  }) =>
    buildGateReport({
      lib2Pairs: buildLib2Pairs(lib2Inputs()).pairs,
      problems: ["one problem"],
      replayInput: replayInput(),
      orders: 20,
      inputs: [{ name: "x", path: "x.json", sha256: "abc" }],
      rules: [gateRule(null, 0.02), gateRule(null, 0.3)],
      ...(bars ? { bars } : {})
    });

  it("lists one-neighbour and two-neighbour controls around the rules, and names none when no rule meets the bars", () => {
    const report = build();
    expect(report.lib2.rows.map((row) => row.rule)).toEqual([
      "nearest-only",
      "gap<=0.02",
      "gap<=0.3",
      "all"
    ]);
    expect(report.replay.rows.map((row) => row.rule)).toEqual([
      "one neighbour",
      "gap<=0.02",
      "gap<=0.3",
      "all extras"
    ]);
    expect(report.lib2).toMatchObject({ pairs: 5, anchors: 3, panelPositives: 3 });
    expect(report.lib2.secondOnlyPositives).toBe(1);
    expect(report.meetingAllBars).toEqual([]);
    expect(report.closest).toBeNull();
    const markdown = renderGateMarkdown(report);
    expect(markdown).toContain("No rule of the sweep meets all three bars.");
    expect(markdown).toContain("No rule of the sweep meets the two LIB2 bars.");
    expect(markdown).toContain("- one problem");
    expect(markdown).toContain("| one neighbour | 2 / 3 | 1 |");
  });

  it("names the rules that meet the LIB2 bars and the call bar, and the cheapest of the first", () => {
    const report = build({ minAccepted: 2, maxPanelNegatives: 2, maxCallsPerSource: 99 });
    expect(report.meetingAllBars).toEqual(["gap<=0.02", "gap<=0.3"]);
    expect(report.closest?.rule).toBe("gap<=0.02");
    const strict = build({ minAccepted: 2, maxPanelNegatives: 2, maxCallsPerSource: 0.1 });
    expect(strict.meetingAllBars).toEqual([]);
    expect(strict.closest).not.toBeNull();
    expect(renderGateMarkdown(strict)).toContain("costs the fewest calls");
  });
});

describe("the command", () => {
  let directory = "";
  const files = {
    labels: "",
    tally: "",
    context: "",
    verdicts: "",
    replay: ""
  };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-gate-"));
    const inputs = lib2Inputs();
    files.labels = join(directory, "labels.json");
    files.tally = join(directory, "tally.json");
    files.context = join(directory, "context.json");
    files.verdicts = join(directory, "verdicts.json");
    files.replay = join(directory, "replay.json");
    await writeFile(files.labels, JSON.stringify(inputs.labelSet));
    await writeFile(files.tally, JSON.stringify(inputs.tally));
    await writeFile(files.context, JSON.stringify(inputs.contexts.lib));
    await writeFile(files.verdicts, JSON.stringify(inputs.verdicts.lib));
    await writeFile(files.replay, JSON.stringify(replayInput()));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const args = () => [
    "--orders",
    "10",
    "--replay-input",
    files.replay,
    "--labels",
    files.labels,
    "--tally",
    files.tally,
    "--context",
    `lib=${files.context}`,
    "--verdicts",
    `lib=${files.verdicts}`
  ];

  it("prints the report, or writes it with its JSON and the checksums of its inputs", async () => {
    const printed = await runSecondNeighbourGate(args());
    expect(printed).toContain("# Second-neighbour gate");
    const out = join(directory, "report.md");
    const json = join(directory, "report.json");
    expect(await runSecondNeighbourGate([...args(), "--out", out, "--json", json])).toBeNull();
    expect(await readFile(out, "utf8")).toBe(printed);
    const report = JSON.parse(await readFile(json, "utf8")) as ReturnType<typeof buildGateReport>;
    expect(report.format).toBe("memora-second-neighbour-gate");
    expect(report.inputs.map((input) => input.name)).toEqual([
      "context:lib",
      "labels",
      "replay-input",
      "tally",
      "verdicts:lib"
    ]);
    expect(report.inputs.every((input) => /^[0-9a-f]{64}$/u.test(input.sha256))).toBe(true);
    expect(report.lib2.rows.length).toBe(defaultGateRules().length + 2);
  });

  it("shows its usage and refuses nonsense", async () => {
    expect(await runSecondNeighbourGate(["--help"])).toContain("--replay-input");
    await expect(runSecondNeighbourGate([...args(), "--orders", "0"])).rejects.toThrow("--orders");
    await expect(runSecondNeighbourGate([...args(), "--context", "nofile"])).rejects.toThrow(
      "library=file"
    );
    await expect(runSecondNeighbourGate([...args(), "--surprise"])).rejects.toThrow();
  });
});

// --- F3's recorded evidence ------------------------------------------------------------------

const stored = {
  replay: join(cacheRoot, "f3/m2/out/s1-replay-final/replay-input.json"),
  labels: join(cacheRoot, "f3/labels/label-set.json"),
  gold: join(cacheRoot, "f3/m2/runs/SPG/source-pair-verdicts.json"),
  corpus: join(cacheRoot, "f3/m2/runs/SPC/source-pair-verdicts.json")
};
const storedPresent = Object.values(stored).every((path) => existsSync(path));

describe.skipIf(!storedPresent)("F3's stored second library and replay", () => {
  it("reproduces what F3 recorded: 6 of 27 panel-positive pairs at one neighbour, 13 at two", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "memora-gate-stored-")), "report.json");
    await runSecondNeighbourGate(["--orders", "50", "--json", out, "--out", `${out}.md`]);
    const report = JSON.parse(await readFile(out, "utf8")) as ReturnType<typeof buildGateReport>;
    expect(report.problems).toEqual([]);
    expect(report.lib2).toMatchObject({ pairs: 53, anchors: 30, panelPositives: 27 });
    const rows = new Map(report.lib2.rows.map((row) => [row.rule, row]));
    expect(rows.get("nearest-only")).toMatchObject({ acceptedInU: 6, judgedPairs: 27 });
    expect(rows.get("all")).toMatchObject({ acceptedInU: 13, judgedPairs: 53 });
    expect(report.replay.roots).toBe(52);
    // F3's replay: 1.52 judge calls per source at one neighbour over 2,000 orders; the same
    // seeds give about that over fewer.
    const one = report.replay.rows.find((row) => row.rule === "one neighbour")!;
    expect(one.callsPerSource.mean).toBeGreaterThan(1.4);
    expect(one.callsPerSource.mean).toBeLessThan(1.6);
    expect(one.expected.min).toBe(54);
    expect(one.forbiddenMax).toBe(0);
    await rm(join(out, ".."), { recursive: true, force: true });
    // The whole sweep over 50 orders takes about 1.3 s alone but over 5 s on a loaded machine.
  }, 60_000);

  it("prices the S1 re-measure at two neighbours: 140 pairs F3 never judged are reached by 5% of orders, none at one", async () => {
    const input = replayInputSchema.parse(JSON.parse(await readFile(stored.replay, "utf8")));
    const one = evaluateReplayGate(input, { orders: 2000, rule: null, neighbours: 1 });
    const two = evaluateReplayGate(input, { orders: 2000, rule: null, neighbours: 2 });
    // F3's replay: 1,020 pairs reached at one neighbour, none by 5% of the 2,000 orders (the closure
    // judged them); the same recordings leave 140 at two, and 590 by 1% of orders.
    expect(one.closure).toEqual({ reached: 1020, atLeast1: 281, atLeast5: 0, atLeast10: 0 });
    expect(two.closure).toEqual({ reached: 1045, atLeast1: 590, atLeast5: 140, atLeast10: 36 });
    expect(one.callsPerSource.mean).toBeCloseTo(1.517, 3);
    expect(two.callsPerSource.mean).toBeCloseTo(2.745, 3);
    // Two replays of 2,000 orders each take about 4.6 s alone, so the 5 s default fails under load.
  }, 60_000);
});
