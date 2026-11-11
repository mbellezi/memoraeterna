import { describe, expect, it } from "vitest";

import { createScreenScroll } from "./legacy-views";

describe("the scroll of Settings and the old screens", () => {
  it("brings each screen back where it was, and starts a chosen Settings section at the top", () => {
    const memory = createScreenScroll();
    const box = { scrollTop: 0 };
    memory.show("settings", box);
    box.scrollTop = 480;
    memory.remember("settings", 480);
    // Another old screen in the same box starts at its own offset.
    memory.show("jobs", box);
    expect(box.scrollTop).toBe(0);
    box.scrollTop = 120;
    memory.remember("jobs", 120);
    // Back to Settings: where it was.
    memory.show("settings", box);
    expect(box.scrollTop).toBe(480);
    // A Settings section chosen while Settings shows: the top, at once.
    memory.resetSettings();
    expect(box.scrollTop).toBe(0);
    // The stack covers the screens; Activity opens a Settings section: Settings opens at the top,
    // and Jobs keeps its offset.
    memory.remember("settings", 300);
    memory.show("settings", null);
    memory.resetSettings();
    memory.show("settings", box);
    expect(box.scrollTop).toBe(0);
    memory.show("jobs", box);
    expect(box.scrollTop).toBe(120);
  });
});
