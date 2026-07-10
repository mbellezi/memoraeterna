import { describe, expect, it } from "vitest";

import { hashMarkdown, parseManagedNote } from "./frontmatter.js";

describe("Obsidian managed frontmatter", () => {
  it("parses managed identity without including frontmatter in the body", async () => {
    const body = "# Note\n\nBody";
    const hash = await hashMarkdown(body);
    const parsed = parseManagedNote(`---\nmemora_id: "967fca99-270a-4309-bff8-cad98f24a670"\nmemora_type: "atomic_note"\nmemora_source_id: "83f7509d-71ea-4276-922c-c305eb9f7420"\nmemora_managed: true\nmemora_sync_version: 2\nmemora_content_hash: "${hash}"\n---\n${body}\n`);
    expect(parsed?.frontmatter.memoraSyncVersion).toBe(2);
    expect(parsed?.markdown).toBe(body);
  });

  it("ignores unmanaged Markdown", () => {
    expect(parseManagedNote("# Normal note")).toBeNull();
  });
});
