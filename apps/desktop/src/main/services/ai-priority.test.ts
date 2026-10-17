import { describe, expect, it } from "vitest";

import { aiTaskPriority } from "./ai-priority.js";

describe("AI call priority", () => {
  it("serves what the user waits for at P0 and everything else as background work at P2", () => {
    expect(aiTaskPriority({ embeddingInputType: "query" })).toBe("P0");
    expect(aiTaskPriority({ origin: "consultation" })).toBe("P0");
    expect(aiTaskPriority({ origin: "settings" })).toBe("P0");
    expect(aiTaskPriority({ embeddingInputType: "document", origin: "ingestion" })).toBe("P2");
    expect(aiTaskPriority({ origin: "organization" })).toBe("P2");
    // A call without a priority is background work.
    expect(aiTaskPriority({})).toBe("P2");
  });

  it("lets a caller state its priority, also with the classes of the single queue it replaced", () => {
    expect(aiTaskPriority({ origin: "job", priority: "interactive" })).toBe("P0");
    expect(aiTaskPriority({ origin: "consultation", priority: "background" })).toBe("P2");
    expect(aiTaskPriority({ origin: "consultation", priority: "P3" })).toBe("P3");
    expect(aiTaskPriority({ origin: "ingestion", priority: "P1" })).toBe("P1");
    expect(aiTaskPriority({ embeddingInputType: "query", priority: "P2" })).toBe("P2");
  });
});
