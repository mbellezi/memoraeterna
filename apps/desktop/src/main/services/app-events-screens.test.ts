import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// F4 D26: the three screens that polled a job or a download learn from pushed events now. This
// pins the removal so a timer cannot creep back in (the quality ratchet counts the total).
const source = (file: string) =>
  readFileSync(join(import.meta.dirname, "../../renderer/components", file), "utf8");

describe("screens that follow jobs and downloads without a timer", () => {
  it.each([
    ["JobsView.tsx", "job.progress"],
    ["RelationLabelsCard.tsx", "job.progress"],
    ["LocalModelsView.tsx", "model.download"]
  ])("%s listens to %s and starts no interval", (file, eventType) => {
    const text = source(file);

    expect(text).not.toMatch(/\bsetInterval\s*\(/u);
    expect(text).toContain(`"${eventType}"`);
    // The payload-less `jobsChanged` push is gone: no screen subscribes to it any more.
    expect(text).not.toContain("jobs.subscribe");
  });
});
