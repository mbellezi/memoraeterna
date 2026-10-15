import { describe, expect, it } from "vitest";

import { lensAfterNavigation, lensAfterTopicChange } from "./wiki-lens";

describe("the lens of the Wiki", () => {
  it("shows a topic that is opened in the Topic lens, from the Map too", () => {
    expect(lensAfterNavigation("map", { type: "topic" })).toBe("topic");
    expect(lensAfterNavigation("topic", { type: "topic" })).toBe("topic");
  });

  it("leaves the lens alone for anything else", () => {
    expect(lensAfterNavigation("map", { type: "source" })).toBe("map");
    expect(lensAfterNavigation("map", { type: "legacyPage" })).toBe("map");
  });

  it("shows a topic that changed (Back, Forward, a link elsewhere) in the Topic lens", () => {
    expect(lensAfterTopicChange("map", "a", "b")).toBe("topic");
    expect(lensAfterTopicChange("map", null, "b")).toBe("topic");
    expect(lensAfterTopicChange("map", "a", null)).toBe("topic");
  });

  it("keeps the lens while the topic stays the same", () => {
    expect(lensAfterTopicChange("map", "a", "a")).toBe("map");
    expect(lensAfterTopicChange("map", null, null)).toBe("map");
  });
});
