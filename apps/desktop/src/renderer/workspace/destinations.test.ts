import { describe, expect, it } from "vitest";

import {
  destinationForDigit,
  destinationIds,
  destinationRoots,
  isDestinationId,
  navigatorDefaults
} from "./destinations";
import { parseViewAddress } from "./route";

describe("destinations", () => {
  it("are exactly the five rail destinations, in rail order", () => {
    expect(destinationIds).toEqual(["home", "explore", "library", "inbox", "map"]);
    expect(isDestinationId("settings")).toBe(false);
    expect(isDestinationId("wiki")).toBe(false);
    expect(isDestinationId(1)).toBe(false);
    expect(isDestinationId("inbox")).toBe(true);
  });

  it("each start from a root view address of their own", () => {
    for (const destination of destinationIds)
      expect(parseViewAddress(destinationRoots[destination])?.view).toBe(destination);
    expect(destinationRoots.map).toBe("memora://map/relations");
  });

  it("show the navigator by default in Explore only (design record §20.1 row 30)", () => {
    expect(destinationIds.filter((destination) => navigatorDefaults[destination])).toEqual([
      "explore"
    ]);
  });

  it("map Cmd-1..5 in rail order", () => {
    expect([1, 2, 3, 4, 5].map(destinationForDigit)).toEqual([...destinationIds]);
    for (const digit of [0, 6, 7, 8, 9, 1.5]) expect(destinationForDigit(digit)).toBeNull();
  });
});
