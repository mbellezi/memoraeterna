import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildPartRuler,
  buildSectionRuler,
  combineStepStates,
  decodeLibraryRowsCursor,
  encodeLibraryRowsCursor,
  libraryRowsCursorMax,
  libraryRowSorts,
  libraryRowStatuses,
  stepState,
  type SectionChunk,
  type SectionHeading
} from "./libraryRowsRepository.js";

describe("the library rows cursor", () => {
  it("round-trips for the sort and direction it was made for", () => {
    const id = randomUUID();
    for (const sort of libraryRowSorts) {
      const key =
        sort === "notes" || sort === "status"
          ? 4
          : sort === "title"
            ? "alpha"
            : "2026-01-01T10:00:00.000000Z";
      const cursor = encodeLibraryRowsCursor(sort, "desc", { key, id });
      expect(decodeLibraryRowsCursor(cursor, sort, "desc")).toEqual({ key, id });
    }
  });

  it("refuses a cursor made for another sort or direction, or a malformed one", () => {
    const id = randomUUID();
    const cursor = encodeLibraryRowsCursor("title", "asc", { key: "a", id });
    expect(() => decodeLibraryRowsCursor(cursor, "added", "asc")).toThrow(
      "errors.common.validationFailed"
    );
    expect(() => decodeLibraryRowsCursor(cursor, "title", "desc")).toThrow();
    expect(() => decodeLibraryRowsCursor("not a cursor", "title", "asc")).toThrow();
    const wrongKey = encodeLibraryRowsCursor("notes", "asc", { key: "x" as unknown as number, id });
    expect(() => decodeLibraryRowsCursor(wrongKey, "notes", "asc")).toThrow();
    const wrongInstant = encodeLibraryRowsCursor("added", "desc", { key: "yesterday", id });
    expect(() => decodeLibraryRowsCursor(wrongInstant, "added", "desc")).toThrow();
    const wrongId = encodeLibraryRowsCursor("title", "asc", { key: "a", id: "nope" });
    expect(() => decodeLibraryRowsCursor(wrongId, "title", "asc")).toThrow();
  });
});

describe("the cursor of a title sort", () => {
  const id = randomUUID();

  it("keeps the whole key while it fits and hands out nothing longer than the bound", () => {
    const short = encodeLibraryRowsCursor("title", "asc", { key: "alpha", id });
    expect(decodeLibraryRowsCursor(short, "title", "asc")).toEqual({ key: "alpha", id });
    // A title may be 1000 characters: Latin, Cyrillic or CJK keys all exceed any cursor bound.
    for (const key of ["a".repeat(1000), "щ".repeat(1000), "日".repeat(1000), "💥".repeat(900)]) {
      const cursor = encodeLibraryRowsCursor("title", "desc", { key, id });
      expect(cursor.length).toBeLessThanOrEqual(libraryRowsCursorMax);
      // The key is read back from the row the cursor names.
      expect(decodeLibraryRowsCursor(cursor, "title", "desc")).toEqual({ key: null, id });
    }
    expect(libraryRowsCursorMax).toBeLessThanOrEqual(600);
  });

  it("never drops the key of a numeric or timestamp sort", () => {
    const refused = encodeLibraryRowsCursor("notes", "asc", { key: null, id });
    expect(() => decodeLibraryRowsCursor(refused, "notes", "asc")).toThrow();
    const instant = encodeLibraryRowsCursor("added", "asc", { key: null, id });
    expect(() => decodeLibraryRowsCursor(instant, "added", "asc")).toThrow();
  });
});

describe("the vocabularies", () => {
  it("name the Library's five sorts and five statuses", () => {
    expect([...libraryRowSorts]).toEqual(["title", "added", "updated", "notes", "status"]);
    expect([...libraryRowStatuses].sort()).toEqual(
      ["failed", "needsYou", "processing", "ready", "storedOnly"].sort()
    );
  });
});

describe("the step state", () => {
  it("reads a stage's checkpoint", () => {
    expect(stepState(["a"], { a: { status: "completed" } }, [])).toBe("done");
    expect(stepState(["a"], { a: { status: "running" } }, [])).toBe("running");
    expect(stepState(["a"], { a: { status: "failed" } }, [])).toBe("failed");
    expect(stepState(["a"], {}, [])).toBe("pending");
  });

  it("does not apply a stage the run was admitted without or skipped", () => {
    expect(stepState(["a"], {}, ["b"])).toBe("notApplicable");
    expect(stepState(["a"], { a: { status: "skipped" } }, [])).toBe("notApplicable");
    // Waiting for a validated ranker is still to come.
    expect(stepState(["a"], { a: { status: "skipped", reason: "waiting_for_decider" } }, [])).toBe(
      "pending"
    );
  });

  it("combines the stages of a step: a failure, then work, then all done", () => {
    const done = { status: "completed" };
    expect(stepState(["a", "b"], { a: done, b: done }, [])).toBe("done");
    expect(stepState(["a", "b"], { a: done }, [])).toBe("pending");
    expect(stepState(["a", "b"], { a: done, b: { status: "running" } }, [])).toBe("running");
    expect(stepState(["a", "b"], { a: { status: "failed" }, b: { status: "running" } }, [])).toBe(
      "failed"
    );
    expect(stepState(["a", "b"], { a: done, b: { status: "skipped" } }, [])).toBe("done");
    expect(stepState(["a", "b"], { a: { status: "skipped" }, b: { status: "skipped" } }, [])).toBe(
      "notApplicable"
    );
  });
});

describe("the section ruler", () => {
  const chunks = (lengths: number[]): SectionChunk[] =>
    lengths.map((length, chunkIndex) => ({ chunkIndex, length }));
  const heading = (chunkIndex: number, level: number, title: string): SectionHeading => ({
    chunkIndex,
    level,
    title
  });
  const base = {
    title: "The source",
    chunks: chunks([100, 100, 200, 100, 100, 100]),
    headings: [
      heading(0, 1, "The source"),
      heading(1, 2, "Intro"),
      heading(2, 2, "Methods ##"),
      heading(3, 2, "Results"),
      heading(4, 2, "Discussion")
    ],
    notesByChunk: new Map([
      [1, 2],
      [2, 1]
    ]),
    running: true,
    notesDone: false
  };

  it("makes one section per heading of the shallowest level used twice, sized by length", () => {
    const ruler = buildSectionRuler(base);
    expect(ruler.map((section) => section.title)).toEqual([
      "The source",
      "Intro",
      "Methods",
      "Results",
      "Discussion"
    ]);
    expect(ruler.reduce((sum, section) => sum + section.share, 0)).toBeCloseTo(1, 10);
    expect(ruler.map((section) => section.share)).toEqual(
      [100, 100, 200, 100, 200].map((n) => n / 700)
    );
    expect(ruler.map((section) => section.notes)).toEqual([0, 2, 1, 0, 0]);
  });

  it("reads the first section after the last one with notes while the run is active", () => {
    expect(buildSectionRuler(base).map((section) => section.state)).toEqual([
      "done",
      "done",
      "done",
      "reading",
      "pending"
    ]);
    expect(
      buildSectionRuler({ ...base, notesByChunk: new Map() }).map((section) => section.state)
    ).toEqual(["reading", "pending", "pending", "pending", "pending"]);
  });

  it("reads nothing once the run is over", () => {
    expect(
      buildSectionRuler({ ...base, running: false, notesDone: true }).map(
        (section) => section.state
      )
    ).toEqual(["done", "done", "done", "done", "done"]);
    expect(buildSectionRuler({ ...base, running: false }).map((section) => section.state)).toEqual([
      "done",
      "done",
      "done",
      "pending",
      "pending"
    ]);
  });

  it("is one section when no heading level is used twice, and empty with no text", () => {
    const one = buildSectionRuler({ ...base, headings: [heading(0, 1, "Only title")] });
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ title: "The source", share: 1, notes: 3 });
    expect(buildSectionRuler({ ...base, chunks: [] })).toEqual([]);
  });

  it("merges neighbouring sections past the limit, named after the first", () => {
    const many = Array.from({ length: 10 }, (_, index) => heading(index, 2, `S${index}`));
    const ruler = buildSectionRuler({
      title: "T",
      chunks: chunks(Array.from({ length: 10 }, () => 10)),
      headings: many,
      notesByChunk: new Map([[1, 1]]),
      running: true,
      notesDone: false,
      limit: 4
    });
    expect(ruler.map((section) => section.title)).toEqual(["S0", "S3", "S6", "S9"]);
    expect(ruler.reduce((sum, section) => sum + section.share, 0)).toBeCloseTo(1, 10);
    expect(ruler.map((section) => section.state)).toEqual([
      "reading",
      "pending",
      "pending",
      "pending"
    ]);
  });
});

describe("the ruler of a book's parts", () => {
  const part = (
    title: string,
    extra: Partial<Parameters<typeof buildPartRuler>[0][number]> = {}
  ) => ({
    title,
    length: 100,
    notes: 0,
    active: false,
    failed: false,
    hasRun: true,
    ...extra
  });

  it("has a segment per part, wide by its text, and reads each part's state from its runs", () => {
    const ruler = buildPartRuler([
      part("One", { length: 300, notes: 4 }),
      part("Two", { length: 100, active: true }),
      part("Three", { hasRun: false }),
      part("Four", { failed: true })
    ]);
    expect(ruler.map((section) => [section.title, section.state, section.notes])).toEqual([
      ["One", "done", 4],
      ["Two", "reading", 0],
      ["Three", "pending", 0],
      ["Four", "pending", 0]
    ]);
    expect(ruler[0]!.share).toBeCloseTo(300 / 600, 10);
    expect(ruler.reduce((sum, section) => sum + section.share, 0)).toBeCloseTo(1, 10);
  });

  it("shares the ruler equally while nothing is chunked, and merges past the limit", () => {
    const idle = buildPartRuler([part("A", { length: 0 }), part("B", { length: 0 })]);
    expect(idle.map((section) => section.share)).toEqual([0.5, 0.5]);
    const many = buildPartRuler(
      Array.from({ length: 100 }, (_, index) => part(`Part ${index}`)),
      40
    );
    expect(many).toHaveLength(34);
    expect(many[0]!.title).toBe("Part 0");
    expect(many.reduce((sum, section) => sum + section.share, 0)).toBeCloseTo(1, 10);
    expect(buildPartRuler([])).toEqual([]);
  });
});

describe("combining the steps of several runs", () => {
  it("fails on a failure, works while one works, and ignores what does not apply", () => {
    expect(combineStepStates([])).toBe("pending");
    expect(combineStepStates(["done", "failed"])).toBe("failed");
    expect(combineStepStates(["done", "running", "pending"])).toBe("running");
    expect(combineStepStates(["notApplicable", "notApplicable"])).toBe("notApplicable");
    expect(combineStepStates(["notApplicable", "done", "done"])).toBe("done");
    expect(combineStepStates(["notApplicable", "done", "pending"])).toBe("pending");
  });
});
