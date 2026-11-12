import { describe, expect, it } from "vitest";

import type { LibrarySourceProgress } from "../../../../shared/ipc-library";
import { doneProgress, runningProgress } from "./source-panel-fixtures";
import {
  minutesOf,
  remainingMs,
  rulerLabelMinPx,
  rulerLabelsShown,
  rulerSections,
  stripModel
} from "./source-strip-model";

type Run = NonNullable<LibrarySourceProgress>["run"];
const now = Date.UTC(2026, 10, 12, 9, 17, 0);
const base = (): NonNullable<LibrarySourceProgress> => runningProgress(now);
const withRun = (
  progress: NonNullable<LibrarySourceProgress>,
  run: Partial<NonNullable<Run>>
): NonNullable<LibrarySourceProgress> => ({
  ...progress,
  run: { ...(progress.run as NonNullable<Run>), ...run }
});

describe("the strip's form", () => {
  it("is nothing without a read or a run", () => {
    expect(stripModel(undefined, now).kind).toBe("none");
    expect(stripModel(null, now).kind).toBe("none");
    expect(stripModel({ ...base(), run: null }, now).kind).toBe("none");
  });

  it("is running while the latest run is pending or running", () => {
    expect(stripModel(base(), now).kind).toBe("running");
    expect(stripModel(withRun(base(), { status: "pending" }), now).kind).toBe("running");
  });

  it("is done once the run succeeded with notes, and searchable-only when notes are not used", () => {
    expect(stripModel(doneProgress(now), now).kind).toBe("done");
    const searchOnly = {
      ...doneProgress(now),
      steps: {
        ...doneProgress(now).steps,
        notes: { state: "notApplicable" as const, soFar: 0, estimate: null },
        summary: { state: "notApplicable" as const },
        relations: { state: "notApplicable" as const, count: 0 }
      }
    };
    expect(stripModel(searchOnly, now).kind).toBe("searchable");
  });

  it("is error for a failed or stopped run, carrying the stage and never raw text", () => {
    const failed = stripModel(
      withRun(base(), { status: "failed", failedStage: "atomicNotes" }),
      now
    );
    expect(failed.kind).toBe("error");
    expect(failed.failedStage).toBe("atomicNotes");
    expect(stripModel(withRun(base(), { status: "canceled" }), now).kind).toBe("error");
  });

  it("puts what only the person can fix first, then a pause, then a failure", () => {
    const failed = withRun(base(), { status: "failed", failedStage: "embedding" });
    expect(stripModel({ ...failed, needsYou: "no_model.no_route" }, now)).toMatchObject({
      kind: "needsYou",
      blocker: "no_model.no_route"
    });
    expect(stripModel({ ...base(), paused: true }, now).kind).toBe("paused");
    expect(stripModel({ ...failed, paused: true }, now).kind).toBe("error");
  });

  it("expects more notes only while the notes step is still to finish", () => {
    expect(stripModel(base(), now).expectsNotes).toBe(true);
    expect(stripModel(doneProgress(now), now).expectsNotes).toBe(false);
  });
});

describe("the six steps", () => {
  it("run in the design's order with the words of the design", () => {
    const model = stripModel(base(), now);
    expect(model.steps.map((step) => step.id)).toEqual([
      "read",
      "chunks",
      "notes",
      "placed",
      "summary",
      "relations"
    ]);
    const value = (id: string) => model.steps.find((step) => step.id === id)?.value;
    expect(value("read")).toEqual({ key: "sourcePage.strip.values.pages", values: { count: 24 } });
    expect(value("chunks")).toEqual({
      key: "sourcePage.strip.values.searchable",
      values: { count: 142 }
    });
    expect(value("notes")).toEqual({
      key: "sourcePage.strip.values.notesOfEstimate",
      values: { count: 7, estimate: 18 }
    });
    expect(value("placed")).toEqual({
      key: "sourcePage.strip.values.placed",
      values: { count: 6 }
    });
    expect(value("summary")).toEqual({ key: "sourcePage.strip.values.writing" });
    expect(value("relations")).toEqual({ key: "sourcePage.strip.values.afterNotes" });
  });

  it("says 'so far' when the notes have no estimate, and nothing true is invented", () => {
    const noEstimate = base();
    noEstimate.steps.notes = { state: "running", soFar: 3, estimate: null };
    expect(stripModel(noEstimate, now).steps[2]?.value).toEqual({
      key: "sourcePage.strip.values.notesSoFar",
      values: { count: 3 }
    });
    noEstimate.steps.notes = { state: "running", soFar: 0, estimate: null };
    expect(stripModel(noEstimate, now).steps[2]?.value).toEqual({
      key: "sourcePage.strip.values.writing"
    });
    noEstimate.steps.chunks = { state: "running", indexed: 0 };
    expect(stripModel(noEstimate, now).steps[1]?.value).toBeNull();
  });

  it("uses the singular words for one", () => {
    const one = base();
    one.steps.read = { state: "done", pages: 1 };
    one.steps.placed = { state: "running", count: 1 };
    const model = stripModel(one, now);
    expect(model.steps[0]?.value?.key).toBe("sourcePage.strip.values.pagesOne");
    expect(model.steps[3]?.value?.key).toBe("sourcePage.strip.values.placedOne");
  });

  it("marks the steps a mode does not use", () => {
    const mode = base();
    mode.steps.notes = { state: "notApplicable", soFar: 0, estimate: null };
    expect(stripModel(mode, now).steps[2]).toMatchObject({
      state: "notApplicable",
      value: { key: "sourcePage.strip.values.notApplicable" }
    });
  });
});

describe("the time left", () => {
  it("comes from the pace of the notes written so far", () => {
    // 5 minutes for 7 of 18 notes: 11 notes more at 5/7 of a minute each.
    const left = remainingMs(base(), now);
    expect(left).not.toBeNull();
    expect(minutesOf(left as number)).toBe(8);
  });

  it("is unknown without an estimate, a first note, a start, or once the estimate is passed", () => {
    const progress = base();
    expect(
      remainingMs(
        {
          ...progress,
          steps: { ...progress.steps, notes: { state: "running", soFar: 0, estimate: 18 } }
        },
        now
      )
    ).toBeNull();
    expect(
      remainingMs(
        {
          ...progress,
          steps: { ...progress.steps, notes: { state: "running", soFar: 5, estimate: null } }
        },
        now
      )
    ).toBeNull();
    expect(
      remainingMs(
        {
          ...progress,
          steps: { ...progress.steps, notes: { state: "running", soFar: 18, estimate: 18 } }
        },
        now
      )
    ).toBeNull();
    expect(remainingMs(withRun(progress, { startedAt: null }), now)).toBeNull();
    expect(remainingMs(doneProgress(now), now)).toBeNull();
  });

  it("is never shown as less than a minute", () => {
    expect(minutesOf(1_000)).toBe(1);
    expect(minutesOf(4 * 60_000 + 20_000)).toBe(4);
  });

  it("is how long the finished run took, for the one-line form", () => {
    const done = stripModel(doneProgress(now), now);
    expect(done.tookMs).toBe(4 * 60_000);
  });
});

describe("the section ruler", () => {
  it("has one segment per section, wide by share, and a segment is never alone", () => {
    const sections = rulerSections(base());
    expect(sections.map((section) => section.title)).toEqual([
      "Introduction",
      "Bogotá",
      "Medellín",
      "Results",
      "Conclusion"
    ]);
    expect(sections.map((section) => section.state)).toEqual([
      "done",
      "done",
      "reading",
      "pending",
      "pending"
    ]);
    expect(sections.reduce((sum, section) => sum + section.widthPct, 0)).toBeCloseTo(100, 0);
    expect(rulerSections({ ...base(), sections: [base().sections[0] as never] })).toEqual([]);
  });

  it("names only the segments wide enough, and every one where nothing is measured", () => {
    const sections = rulerSections(base());
    expect(rulerLabelsShown(sections, 0)).toEqual(sections.map(() => true));
    // 13% of 300 px is 40 px: under the floor, no name; the others fit.
    const shown = rulerLabelsShown(sections, 300);
    expect(shown[4]).toBe(false);
    expect(shown.slice(0, 4)).toEqual([true, true, true, true]);
    for (const [index, section] of sections.entries())
      expect(shown[index]).toBe((section.widthPct / 100) * 300 >= rulerLabelMinPx);
  });
});
