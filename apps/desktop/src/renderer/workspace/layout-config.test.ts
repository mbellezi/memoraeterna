import { describe, expect, it } from "vitest";

import { contextMode, layoutConfig, prevShowsAt, tierFor, topMinFor } from "./layout-config";

describe("layoutConfig (design record §4.9)", () => {
  it("holds the A1 and A2 constants", () => {
    expect(layoutConfig).toMatchObject({
      topMin: 568,
      topMinAtWindowMin: 552,
      maxSpines: 6,
      contextDockedFrom: 1280,
      compactBelow: 1180,
      omniMin: 240,
      windowMin: 960,
      contextStripW: 40
    });
  });

  it("picks the §4.9 tier per window width", () => {
    const at = (width: number) => {
      const { name, railW, navW, ctxW, prevW, spineW, rowH, ind, topPl, topGap } = tierFor(width);
      return [name, railW, navW, ctxW, prevW, spineW, rowH, ind, topPl, topGap];
    };
    expect(at(960)).toEqual(["compact", 64, 224, 304, 216, 40, 28, 8, 16, 12]);
    expect(at(1179)).toEqual(["compact", 64, 224, 304, 216, 40, 28, 8, 16, 12]);
    expect(at(1180)).toEqual(["narrow", 72, 256, 304, 224, 40, 28, 12, 24, 16]);
    expect(at(1279)).toEqual(["narrow", 72, 256, 304, 224, 40, 28, 12, 24, 16]);
    expect(at(1280)).toEqual(["standard", 72, 256, 304, 224, 40, 28, 12, 24, 16]);
    expect(at(1439)).toEqual(["standard", 72, 256, 304, 224, 40, 28, 12, 24, 16]);
    expect(at(1440)).toEqual(["wide", 72, 272, 320, 240, 40, 28, 12, 24, 16]);
    expect(at(2560)).toEqual(["wide", 72, 272, 320, 240, 40, 28, 12, 24, 16]);
    expect(tierFor(layoutConfig.compactBelow).name).toBe("narrow");
    expect(tierFor(layoutConfig.compactBelow - 1).name).toBe("compact");
  });

  it("docks the context panel from 1280 px and draws a strip below", () => {
    expect(contextMode(1279)).toBe("strip");
    expect(contextMode(1280)).toBe("docked");
    expect(contextMode(960)).toBe("strip");
  });

  it("bends the top floor to 552 only at a 960-999 px window", () => {
    expect(topMinFor(960)).toBe(552);
    expect(topMinFor(999)).toBe(552);
    expect(topMinFor(1000)).toBe(568);
    expect(topMinFor(1440)).toBe(568);
  });

  it("shows the previous panel from an 848 px stack at every tier (one container query)", () => {
    for (const width of [960, 1180, 1280, 1440]) expect(prevShowsAt(tierFor(width))).toBe(848);
  });
});
