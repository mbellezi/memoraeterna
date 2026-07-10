import { describe, expect, it } from "vitest";

import { createWebCapture, parseYouTubeVideoId } from "./capture.js";

describe("Chrome capture payloads", () => {
  it("extracts supported YouTube video URLs", () => {
    expect(parseYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=10")).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });

  it("builds a valid web capture", () => {
    const payload = createWebCapture({
      url: "https://example.com/article",
      title: "Article",
      html: "<main>Content</main>",
      textContent: "Content",
      selection: "",
      metadata: { language: "en" }
    });
    expect(payload.url).toBe("https://example.com/article");
    expect(payload.html).toContain("Content");
  });
});
