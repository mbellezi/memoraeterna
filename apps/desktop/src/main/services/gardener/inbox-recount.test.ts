import { describe, expect, it } from "vitest";

import { recountDelayMs } from "./inbox-service.js";

describe("the quiet time before the Inbox recounts", () => {
  it("keeps the base delay while the count is cheap", () => {
    expect(recountDelayMs(3_000, 0)).toBe(3_000);
    expect(recountDelayMs(3_000, 20)).toBe(3_000);
    expect(recountDelayMs(5, 0)).toBe(5);
  });

  it("waits ten times as long as a slow count took, up to a minute", () => {
    expect(recountDelayMs(3_000, 800)).toBe(8_000);
    expect(recountDelayMs(3_000, 4_000)).toBe(40_000);
    expect(recountDelayMs(3_000, 60_000)).toBe(60_000);
  });
});
