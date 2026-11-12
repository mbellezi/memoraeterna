import { describe, expect, it } from "vitest";

import { pathMustShow, ribbonFailures, type RibbonReading } from "./path-ribbon.js";

const topic = (id: string) => `memora://topic/${id}`;
const reading = (over: Partial<RibbonReading>): RibbonReading => ({
  kind: "source",
  route: "deep link",
  state: "placed",
  segments: [topic("a")],
  expected: [topic("a")],
  mustShow: true,
  ...over
});

describe("pathMustShow", () => {
  it("asks a path of every kind but a topic, and of a topic below level 1", () => {
    for (const kind of ["source", "note", "entity", "question"] as const) {
      expect(pathMustShow(kind, false)).toBe(true);
    }
    expect(pathMustShow("topic", false)).toBe(false);
    expect(pathMustShow("topic", true)).toBe(true);
  });
});

describe("ribbonFailures", () => {
  it("passes a placed or tentative ribbon that shows the path of objects.locate", () => {
    expect(ribbonFailures(reading({}))).toEqual([]);
    expect(ribbonFailures(reading({ state: "tentative" }))).toEqual([]);
  });

  it("fails an unsorted ribbon whose empty path agrees with an empty locate", () => {
    const failures = ribbonFailures(reading({ state: "unsorted", segments: [], expected: [] }));
    expect(failures).toEqual([
      "source by deep link: objects.locate gives no topic on the primary path",
      'source by deep link: the ribbon is "unsorted", not placed or tentative',
      "source by deep link: the ribbon shows no segment"
    ]);
  });

  it("fails an error ribbon with no segment", () => {
    expect(
      ribbonFailures(reading({ kind: "entity", route: "Cmd-K", state: "error", segments: [] }))
    ).toContain('entity by Cmd-K: the ribbon is "error", not placed or tentative');
  });

  it("fails segments that differ from locate, in content or in order", () => {
    expect(ribbonFailures(reading({ segments: [topic("b")] }))).toEqual([
      `source by deep link: the ribbon shows [${topic("b")}], objects.locate gives [${topic("a")}]`
    ]);
    expect(
      ribbonFailures(
        reading({ segments: [topic("b"), topic("a")], expected: [topic("a"), topic("b")] })
      )
    ).toHaveLength(1);
  });

  it("lets a level-1 topic show no path, as long as locate agrees", () => {
    expect(
      ribbonFailures(
        reading({ kind: "topic", state: "unsorted", segments: [], expected: [], mustShow: false })
      )
    ).toEqual([]);
  });
});
