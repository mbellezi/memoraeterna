import { describe, expect, it } from "vitest";
import { routeObsidianLink } from "./obsidian-link";

const id = "00000000-0000-4000-8000-0000000000a1";
const relation = "00000000-0000-4000-8000-0000000000b1";

describe("a link from Obsidian", () => {
  it("to a wiki page leads to the Wiki with the notice, whatever the page was", () => {
    expect(routeObsidianLink({ kind: "wiki", id })).toEqual({ type: "removedWikiPage" });
    expect(routeObsidianLink({ kind: "wiki", id, revision: relation })).toEqual({
      type: "removedWikiPage"
    });
  });

  it("to a source opens it in the Library, coming from the Wiki, with its relation if it names one", () => {
    expect(routeObsidianLink({ kind: "source", id })).toEqual({
      type: "source",
      target: { sourceItemId: id, origin: "wiki" }
    });
    expect(routeObsidianLink({ kind: "source", id, relation })).toEqual({
      type: "source",
      target: { sourceItemId: id, origin: "wiki", sourceRelationId: relation }
    });
  });
});
