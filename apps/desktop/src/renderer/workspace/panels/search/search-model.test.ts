import { describe, expect, it } from "vitest";
import { objectKinds } from "@app/domain";

import {
  isPassage,
  parseSearchAddress,
  reportedState,
  searchAddress,
  searchParams,
  toggleKind
} from "./search-model";
import { filterKinds } from "./SearchResultsView";

describe("the search results panel", () => {
  it("reads its query and kinds from its address", () => {
    expect(parseSearchAddress("memora://search?q=pH")).toEqual({ query: "pH", kinds: [] });
    expect(parseSearchAddress("memora://search?q=pH&kinds=note%2Csource")).toEqual({
      query: "pH",
      kinds: ["source", "note"]
    });
    expect(parseSearchAddress("memora://library")).toBeNull();
    expect(parseSearchAddress("memora://note/00000000-0000-4000-8000-000000000001")).toBeNull();
  });

  it("writes a filter into the address, and all kinds are the same as none", () => {
    expect(searchAddress("pH", ["topic"])).toBe("memora://search?q=pH&kinds=topic");
    expect(searchAddress("pH", [])).toBe("memora://search?q=pH");
    expect(searchAddress("pH", objectKinds)).toBe("memora://search?q=pH");
  });

  it("adds and takes off one kind at a time", () => {
    expect(toggleKind([], "note")).toEqual(["note"]);
    expect(toggleKind(["note"], "topic")).toEqual(["note", "topic"]);
    expect(toggleKind(["note", "topic"], "note")).toEqual(["topic"]);
    expect(toggleKind(["topic"], "topic")).toEqual([]);
    expect(toggleKind(["source", "note", "topic", "question"], "entity")).toEqual([]);
  });

  it("asks in full mode, for up to 50 rows", () => {
    expect(searchParams({ query: "pH", kinds: ["note"] })).toEqual({
      query: "pH",
      mode: "full",
      limit: 50,
      kinds: ["note"]
    });
    expect(searchParams({ query: "pH", kinds: [] })).not.toHaveProperty("kinds");
  });

  it("reports the four states", () => {
    expect(reportedState({ status: "idle", items: [] })).toBe("loading");
    expect(reportedState({ status: "loading", items: [] })).toBe("loading");
    expect(reportedState({ status: "error", items: [] })).toBe("error");
    expect(reportedState({ status: "ready", items: [] })).toBe("empty");
    expect(
      reportedState({
        status: "ready",
        items: [
          {
            address: "memora://note/00000000-0000-4000-8000-000000000001",
            kind: "note",
            title: "x",
            arms: [{ arm: "fts", rank: 1 }],
            score: 1
          }
        ]
      })
    ).toBe("success");
  });

  it("tells a passage of a source from the source", () => {
    const source = "memora://source/00000000-0000-4000-8000-000000000011";
    expect(isPassage(source)).toBe(false);
    expect(isPassage(`${source}#passage=00000000-0000-4000-8000-000000000091`)).toBe(true);
  });

  it("has a filter chip for every kind", () => {
    expect([...filterKinds].sort()).toEqual([...objectKinds].sort());
  });
});
