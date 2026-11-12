import { describe, expect, it } from "vitest";

import { cardPlacement } from "./ObjectLinkModel";

const base = { cardWidth: 320, gap: 8, edge: 8 };

describe("where a card hangs", () => {
  it("goes past the end of the text block, in the margin, never over the rest of the line", () => {
    // A 544 px column from 32 to 576; the link ends at 300 on its line.
    const placement = cardPlacement({
      ...base,
      link: { left: 100, right: 300 },
      block: { left: 32, right: 576 },
      viewportWidth: 960
    });
    expect(placement).toEqual({ side: "right", sideOffset: 576 - 300 + 8 });
  });

  it("takes the left margin when the right has no room, with the offset mirrored", () => {
    const placement = cardPlacement({
      ...base,
      link: { left: 450, right: 600 },
      block: { left: 400, right: 940 },
      viewportWidth: 960
    });
    expect(placement).toEqual({ side: "left", sideOffset: 450 - 400 + 8 });
  });

  it("shows no card when neither margin holds it", () => {
    expect(
      cardPlacement({
        ...base,
        link: { left: 100, right: 300 },
        block: { left: 40, right: 920 },
        viewportWidth: 960
      })
    ).toBeNull();
  });

  it("honours the preferred side and falls back to the other", () => {
    const wide = {
      ...base,
      link: { left: 400, right: 500 },
      block: { left: 400, right: 560 },
      viewportWidth: 1440
    };
    expect(cardPlacement({ ...wide, prefer: "left" })?.side).toBe("left");
    expect(cardPlacement({ ...wide, prefer: "right" })?.side).toBe("right");
  });

  it("hangs beside the link itself when it has no block around it", () => {
    expect(
      cardPlacement({ ...base, link: { left: 100, right: 180 }, block: null, viewportWidth: 960 })
    ).toEqual({ side: "right", sideOffset: 8 });
  });
});
