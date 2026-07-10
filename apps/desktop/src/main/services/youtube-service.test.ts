import { describe, expect, it } from "vitest";

import { YouTubeService } from "./youtube-service.js";

describe("YouTubeService", () => {
  it("normalizes mocked metadata and transcript to Markdown", async () => {
    const service = new YouTubeService(async () => ({
      basic_info: { title: "A video", author: "A channel", duration: 42 },
      getTranscript: async () => ({ transcript: { segments: [
        { start_ms: 0, snippet: { text: "First idea." } },
        { start_ms: 1000, snippet: { text: "Second idea." } }
      ] } })
    }));
    const result = await service.capture("dQw4w9WgXcQ");
    expect(result.markdown).toContain("## Transcript");
    expect(result.markdown).toContain("First idea.");
    expect(result.metadata.transcriptAvailable).toBe(true);
  });

  it("keeps the capture useful when a transcript is unavailable", async () => {
    const service = new YouTubeService(async () => ({
      basic_info: { title: "No captions" },
      getTranscript: async () => { throw new Error("unavailable"); }
    }));
    const result = await service.capture("dQw4w9WgXcQ");
    expect(result.markdown).toBe("# No captions");
    expect(result.metadata.transcriptAvailable).toBe(false);
  });
});
