import { describe, expect, it } from "vitest";

import { stepLevel } from "./use-overflow-level";

describe("stepping a label down its forms", () => {
  const at = (level: number, contentWidth: number, roomWidth: number) =>
    stepLevel({ level, levels: 3, contentWidth, roomWidth });

  it("keeps the form that fits, and goes one form down while the content is wider than the room", () => {
    expect(at(0, 100, 120)).toBe(0);
    expect(at(0, 121, 120)).toBe(1);
    expect(at(1, 121, 120)).toBe(2);
  });

  it("ignores half a pixel of rounding", () => {
    expect(at(0, 120.4, 120)).toBe(0);
    expect(at(0, 120.6, 120)).toBe(1);
  });

  it("stops at the last form, which is the one that is clipped, never cut in a word before it", () => {
    expect(at(2, 500, 120)).toBe(2);
  });

  it("stays at the first form where nothing has a width", () => {
    expect(at(0, 0, 0)).toBe(0);
  });
});
