import { describe, expect, it } from "vitest";

import { diffRootPlacements, type RootPlacementRow } from "./relations-rematch-composites.js";

const row = (
  rootId: string,
  hasCurrentNotes: boolean,
  placement: RootPlacementRow["placement"]
): RootPlacementRow => ({ rootId, title: `Title ${rootId}`, hasCurrentNotes, placement });
const at = (topicId: string, needsVector = false) => ({ topicId, needsVector });

describe("the topic re-placements a composite backfill causes (3.20)", () => {
  const written = new Set(["noted", "bare", "waiting"]);

  it("counts the roots of the written nodes and reports the ones that moved", () => {
    const before = [
      row("noted", true, at("topic-a")),
      row("bare", false, at("topic-unsorted", true)),
      row("waiting", false, null),
      row("elsewhere", false, at("topic-z"))
    ];
    const after = [
      row("noted", true, at("topic-a")),
      row("bare", false, at("topic-b")),
      row("waiting", false, at("topic-c")),
      row("elsewhere", false, at("topic-y"))
    ];
    const result = diffRootPlacements(before, after, written);
    expect(result).toMatchObject({
      backfilledRoots: 3,
      withCurrentNotes: 1,
      moved: 2,
      movedWithCurrentNotes: 0
    });
    expect(result.moves).toEqual([
      {
        rootId: "bare",
        title: "Title bare",
        hasCurrentNotes: false,
        before: at("topic-unsorted", true),
        after: at("topic-b")
      },
      {
        rootId: "waiting",
        title: "Title waiting",
        hasCurrentNotes: false,
        before: null,
        after: at("topic-c")
      }
    ]);
    // A root that is not among the written nodes' roots is none of the backfill's doing.
    expect(result.moves.map((move) => move.rootId)).not.toContain("elsewhere");
  });

  it("flags a root with current notes that moved, which 3.20 expects never to happen", () => {
    const result = diffRootPlacements(
      [row("noted", true, at("topic-a"))],
      [row("noted", true, at("topic-b"))],
      written
    );
    expect(result).toMatchObject({ moved: 1, movedWithCurrentNotes: 1 });
  });

  it("sees a change of the needs-vector flag alone as a move, and no change as none", () => {
    expect(
      diffRootPlacements(
        [row("bare", false, at("topic-a", true))],
        [row("bare", false, at("topic-a", false))],
        written
      ).moved
    ).toBe(1);
    expect(
      diffRootPlacements(
        [row("bare", false, at("topic-a")), row("waiting", false, null)],
        [row("bare", false, at("topic-a")), row("waiting", false, null)],
        written
      )
    ).toMatchObject({ backfilledRoots: 2, moved: 0, moves: [] });
  });

  it("shows a bounded list of moves and counts the rest", () => {
    const ids = Array.from({ length: 40 }, (_, index) => `root-${index}`);
    const result = diffRootPlacements(
      ids.map((id) => row(id, false, null)),
      ids.map((id) => row(id, false, at("topic"))),
      new Set(ids)
    );
    expect(result.moved).toBe(40);
    expect(result.moves).toHaveLength(25);
  });
});
