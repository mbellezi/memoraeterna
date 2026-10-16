import { describe, expect, it } from "vitest";

import {
  admissionPointId,
  admissionPoints,
  admissionStart,
  bimodalityCoefficient,
  chooseAdmission,
  chooseGate,
  chooseMargin,
  chooseMergeCosine,
  chooseMisParentMargin,
  existingOrNewTable,
  gateAccepts,
  gatePoints,
  joinCorpusNotes,
  marginGrid,
  median,
  rocAuc,
  splitSignalVerdict,
  summarizeLoso,
  summarizeOutcomes,
  variedParameter
} from "./calibrate-placement-core.js";
import type {
  AdmissionPoint,
  AdmissionRow,
  GateNote,
  LeafSignals,
  LosoOutcome,
  NoteOutcome,
  SiblingPair
} from "./calibrate-placement-core.js";

const outcome = (overrides: Partial<NoteOutcome> = {}): NoteOutcome => ({
  admitted: true,
  margin: 0.1,
  bestRight: true,
  top1Right: true,
  rightAdmitted: true,
  wrongAdmitted: false,
  ...overrides
});

describe("statistics", () => {
  it("takes the median of an even count as the mean of the middle values", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNaN();
  });

  it("computes the ROC AUC with ties counted half", () => {
    expect(rocAuc([3, 4], [1, 2])).toBe(1);
    expect(rocAuc([1, 2], [3, 4])).toBe(0);
    expect(rocAuc([1], [1])).toBe(0.5);
    expect(rocAuc([], [1])).toBeNaN();
  });

  it("finds a higher bimodality coefficient for two modes than for one", () => {
    const one = Array.from({ length: 40 }, (_, i) => 0.5 + 0.01 * Math.sin(i * 1.7) * (i % 5));
    const two = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.2 : 0.8) + 0.001 * (i % 3));
    expect(bimodalityCoefficient(two)).toBeGreaterThan(5 / 9);
    expect(bimodalityCoefficient(two)).toBeGreaterThan(bimodalityCoefficient(one));
    expect(bimodalityCoefficient([1, 2, 3])).toBeNaN();
  });
});

describe("registered grids", () => {
  it("varies one admission parameter at a time around the start", () => {
    const points = admissionPoints();
    expect(points[0]).toEqual(admissionStart);
    expect(points).toHaveLength(15);
    expect(new Set(points.map(admissionPointId)).size).toBe(15);
    for (const point of points.slice(1)) {
      const varied = variedParameter(point);
      expect(varied).not.toBeNull();
      const others = (Object.keys(admissionStart) as (keyof AdmissionPoint)[]).filter(
        (key) => key !== varied
      );
      for (const key of others) expect(point[key]).toBe(admissionStart[key]);
    }
  });

  it("has 126 gate points and the start margin in the margin grid", () => {
    expect(gatePoints()).toHaveLength(126);
    expect(marginGrid).toContain(0.015);
  });
});

describe("placement outcomes", () => {
  it("splits auto and gated notes by margin", () => {
    const summary = summarizeOutcomes(
      [
        outcome({ margin: 0.001, bestRight: false }),
        outcome({ margin: 0.02 }),
        outcome({ margin: null }),
        outcome({ admitted: false, margin: null, bestRight: false, top1Right: false })
      ],
      [0, 0.015]
    );
    expect(summary.admitted).toBe(0.75);
    expect(summary.top1).toBe(0.75);
    expect(summary.byMargin[0]).toMatchObject({ auto: 0.75, gated: 0, autoPrecision: 2 / 3 });
    expect(summary.byMargin[1]).toMatchObject({ auto: 0.5, gated: 0.25, autoPrecision: 1 });
  });

  it("scores leave-one-source-out notes: known auto right, new not absorbed", () => {
    const notes: LosoOutcome[] = [
      { ...outcome({ margin: 0.1 }), known: true },
      { ...outcome({ margin: 0.001 }), known: true },
      { ...outcome({ margin: 0.1, bestRight: false }), known: false },
      { ...outcome({ admitted: false, margin: null }), known: false }
    ];
    const summary = summarizeLoso(notes, 0.015);
    expect(summary.score).toBe(0.5);
    expect(summary.waiting).toBe(0.5);
    expect(summary.gated).toBe(0.25);
    expect(summary.gatedBaselinePrecision).toBe(1);
  });
});

function row(
  dataset: string,
  holdout: AdmissionRow["holdout"],
  seed: number,
  values: AdmissionPoint,
  data: { score?: number; precision?: number; admitted?: number }
): AdmissionRow {
  const summary =
    holdout === "loso"
      ? null
      : {
          notes: 100,
          top1: 0.9,
          admitted: data.admitted ?? 0.98,
          rightAdmitted: 0.8,
          wrongAdmitted: 0.5,
          byMargin: marginGrid.map((margin) => ({
            margin,
            auto: 0.8,
            gated: 0.1,
            autoPrecision: (data.precision ?? 0.92) + margin
          }))
        };
  const loso =
    holdout === "loso"
      ? {
          notes: 50,
          known: 40,
          score: data.score ?? 0.6,
          knownAutoRight: 0,
          newNotAbsorbed: 0,
          waiting: 0.1,
          gated: 0.05,
          gatedBaselinePrecision: 0.7
        }
      : null;
  return {
    dataset,
    holdout,
    seed,
    point: admissionPointId(values),
    values,
    summary,
    loso
  };
}

describe("R1 admission adoption", () => {
  const seeds = [7, 8, 9];
  const rowsFor = (values: AdmissionPoint, score: number, precision = 0.92, admitted = 0.98) =>
    seeds.flatMap((seed) => [
      row("env-g", "loso", seed, values, { score }),
      row("env-f", "loso", seed, values, { score }),
      row("env-c", "known", seed, values, { precision, admitted }),
      row("corpus-notitle", "known", seed, values, { precision, admitted })
    ]);

  it("keeps the start values when no value gains a point on DS-G/F", () => {
    const rows = admissionPoints().flatMap((point, index) =>
      rowsFor(point, index === 0 ? 0.6 : 0.605)
    );
    const choice = chooseAdmission(rows);
    expect(choice.adopted).toEqual(admissionStart);
    expect(choice.combination.checked).toBe(false);
  });

  it("adopts a better value unless it costs corpus precision", () => {
    const leaf = { ...admissionStart, leafFloor: 0.4 };
    const z = { ...admissionStart, spreadFactor: 2 };
    const rows = [
      ...rowsFor(admissionStart, 0.6),
      ...rowsFor(leaf, 0.65),
      ...rowsFor(z, 0.7, 0.85)
    ];
    const choice = chooseAdmission(rows);
    expect(choice.adopted.leafFloor).toBe(0.4);
    expect(choice.adopted.spreadFactor).toBe(2.5);
    const zEntry = choice.parameters.find((entry) => entry.parameter === "spreadFactor")!;
    expect(zEntry.candidates.find((candidate) => candidate.value === 2)?.qualifies).toBe(false);
  });

  it("keeps only the larger gain when an unmeasured combination is not confirmed", () => {
    const leaf = { ...admissionStart, leafFloor: 0.4 };
    const floor = { ...admissionStart, admissionFloor: 0.25 };
    const rows = [...rowsFor(admissionStart, 0.6), ...rowsFor(leaf, 0.65), ...rowsFor(floor, 0.62)];
    const choice = chooseAdmission(rows, () => null);
    expect(choice.combination).toEqual({ checked: true, kept: false });
    expect(choice.adopted).toEqual(leaf);
  });
});

describe("R2 margin", () => {
  it("takes the smallest margin with precision >= 0.90 in every split", () => {
    const rows = [7, 8].map((seed) =>
      row("env-c", "known", seed, admissionStart, { precision: seed === 7 ? 0.885 : 0.9 })
    );
    // precision at margin m is 0.885 + m on seed 7: >= 0.90 from 0.015.
    expect(chooseMargin(rows, admissionStart).margin).toBe(0.015);
  });
});

describe("R3 gate", () => {
  it("applies the softmax rule with the none option", () => {
    expect(gateAccepts([5, 0], { temperature: 1, tau: 0, theta: 0.5 })).toEqual({
      accepted: true,
      index: 0
    });
    expect(gateAccepts([0, 0], { temperature: 1, tau: 0, theta: 0.5 }).accepted).toBe(false);
    expect(gateAccepts([], { temperature: 1, tau: 0, theta: 0.5 }).accepted).toBe(false);
  });

  it("chooses the eligible point with the most correct placements", () => {
    const notes: GateNote[] = [];
    for (const seed of [7, 8, 9]) {
      for (let i = 0; i < 50; i += 1) {
        // Confident right answers, unsure wrong ones.
        notes.push({ seed, logOdds: [6, -4], right: [true, false], bestRight: true });
        notes.push({ seed, logOdds: [0.2, 0], right: [false, true], bestRight: false });
      }
    }
    const choice = chooseGate(notes);
    expect(choice.how).toBe("eligible");
    expect(choice.chosen?.medianPrecision).toBe(1);
    expect(choice.chosen?.medianCorrectShare).toBe(0.5);
    expect(choice.baseline.precision).toBe(0.5);
  });

  it("falls back to the most precise point when none reaches the bar", () => {
    const notes: GateNote[] = [7, 8].flatMap((seed) => [
      { seed, logOdds: [3, 0], right: [true, false], bestRight: true },
      { seed, logOdds: [3, 0], right: [false, true], bestRight: false }
    ]);
    const choice = chooseGate(notes);
    expect(choice.how).toBe("fallback");
    expect(choice.chosen?.medianPrecision).toBe(0.5);
  });
});

describe("R5 split signal", () => {
  it("stays off below an AUC of 0.75 and activates a separating signal", () => {
    const leaves: LeafSignals[] = [];
    for (let i = 0; i < 20; i += 1) {
      for (const dataset of ["env-c", "corpus-notitle"]) {
        leaves.push({
          seed: 7,
          dataset,
          size: 10,
          purity: 1,
          signals: { coherence: i, bimodality: 0.1 }
        });
        leaves.push({
          seed: 7,
          dataset,
          size: 10,
          purity: 0.5,
          signals: { coherence: i, bimodality: 0.9 }
        });
      }
    }
    const verdict = splitSignalVerdict(leaves);
    expect(verdict.signal).toBe("bimodality");
    expect(verdict.auc.find((entry) => entry.signal === "coherence")?.auc).toBe(0.5);
  });
});

describe("R6 sibling merge", () => {
  it("takes the smallest cosine with precision >= 0.90 and enough pairs", () => {
    const pairs: SiblingPair[] = [];
    for (const dataset of ["env-c", "corpus-notitle"]) {
      for (let i = 0; i < 30; i += 1) {
        pairs.push({ dataset, seed: 7, cosine: 0.86, size: 20, sameUnit: true });
        pairs.push({ dataset, seed: 7, cosine: 0.8, size: 20, sameUnit: i % 2 === 0 });
        pairs.push({ dataset, seed: 7, cosine: 0.95, size: 40, sameUnit: false });
      }
    }
    const choice = chooseMergeCosine(pairs, 22);
    expect(choice.chosen).toBe(0.82);
  });
});

describe("R7 mis-parent margin", () => {
  it("respects the stability floor and reports the margin without it", () => {
    const runs = [
      {
        dataset: "env-c",
        seed: 7,
        planted: 10,
        proposals: [
          ...Array.from({ length: 10 }, () => ({
            dataset: "env-c",
            seed: 7,
            gain: 0.2,
            restoresPlanted: true
          })),
          { dataset: "env-c", seed: 7, gain: 0.03, restoresPlanted: false }
        ]
      }
    ];
    const choice = chooseMisParentMargin(runs);
    expect(choice.withoutFloor).toBe(0);
    expect(choice.chosen).toBe(0.1);
    expect(choice.table.find((entry) => entry.margin === 0.1)?.recall).toBe(1);
  });
});

describe("ENV-C corpus join", () => {
  const articles = new Map([
    [
      "en:Photosynthesis",
      {
        key: "en:Photosynthesis",
        domain: "biology",
        notes: [
          { id: "c0", title: "", text: "Intro." },
          { id: "c1", title: "Light", text: "Light reactions." }
        ]
      }
    ]
  ]);
  const row = (index: number, order: number, title: string) => ({
    index,
    lang: "en",
    rootSourceId: "r1",
    rootTitle: "Photosynthesis",
    title,
    order
  });

  it("joins the k-th note of a root to the article's k-th note", () => {
    const joined = joinCorpusNotes([row(5, 11, "Light"), row(2, 10, "")], articles);
    expect(joined.map((note) => [note.index, note.corpusId, note.domain, note.group])).toEqual([
      [2, "c0", "biology", "en:Photosynthesis"],
      [5, "c1", "biology", "en:Photosynthesis"]
    ]);
  });

  it("refuses a count or title mismatch", () => {
    expect(() => joinCorpusNotes([row(0, 0, "")], articles)).toThrow(/1 exported notes/u);
    expect(() => joinCorpusNotes([row(0, 0, "X"), row(1, 1, "Light")], articles)).toThrow(/title/u);
  });
});

describe("R3b existing or new topic", () => {
  it("rewards accepting known-topic notes and refusing new-topic ones", () => {
    const known: GateNote[] = [7, 8].flatMap((seed) => [
      { seed, logOdds: [5, -5], right: [true, false], bestRight: true },
      { seed, logOdds: [5, -5], right: [false, true], bestRight: false }
    ]);
    const fresh: GateNote[] = [7, 8].map((seed) => ({
      seed,
      logOdds: [-6, -7],
      right: [false, false],
      bestRight: false
    }));
    const { rows, baseline } = existingOrNewTable(known, fresh);
    const start = rows.find((row) => row.id === "T1-tau0-theta0.5")!;
    expect(start).toMatchObject({
      knownAcceptedRight: 0.5,
      knownAcceptedWrong: 0.5,
      newAbsorbed: 0
    });
    expect(start.balanced).toBe(0.75);
    expect(baseline).toMatchObject({
      knownAcceptedRight: 0.5,
      knownAcceptedWrong: 0.5,
      newAbsorbed: 1
    });
  });
});
