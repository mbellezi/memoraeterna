import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  editableTargetType,
  isOutwardProjection,
  obsidianEditOperationSchema,
  obsidianManifestSchema,
  obsidianMemoraTypeSchema,
  parseObsidianMarkdown,
  serializeManagedFrontmatter,
  wikiGeneratedEnd,
  wikiGeneratedStart
} from "./index.js";

// A topic's map of content is projected outward only (F2 T33): it is a managed vault file that
// no editorial operation can target, so a vault edit of a MOC never writes back to the topic tree.
const id = randomUUID();
const hash = "a".repeat(64);
const moc =
  serializeManagedFrontmatter(
    {
      memoraId: id,
      memoraType: "topic",
      memoraManaged: true,
      memoraSyncVersion: 1,
      memoraContentHash: hash,
      memoraWikiSchema: 2,
      memoraLayout: 2,
      memoraLayoutLanguage: "en",
      memoraRevisionId: "revision"
    },
    'aliases: ["Old name"]'
  ) + `\n# Topic\n\n${wikiGeneratedStart}\n\n- [[Memora/Notes/A|A]]\n\n${wikiGeneratedEnd}\n`;

describe("the topic projection type", () => {
  it("is a managed outward projection whose aliases stay user frontmatter", () => {
    expect(obsidianMemoraTypeSchema.parse("topic")).toBe("topic");
    expect(isOutwardProjection("topic")).toBe(true);
    const parsed = parseObsidianMarkdown(moc);
    expect(parsed?.frontmatter).toMatchObject({ memoraId: id, memoraType: "topic" });
    expect(parsed?.userFrontmatter).toBe('aliases: ["Old name"]');
  });

  it("needs the outward projection identity (schema and revision) to parse", () => {
    expect(parseObsidianMarkdown(moc.replace(/memora_revision_id: .*\n/, ""))).toBeNull();
  });

  it("is never an editorial target", () => {
    expect(editableTargetType("topic")).toBeNull();
    expect(editableTargetType("atomic_note")).toBe("atomic_note");
    const operation = {
      version: 1,
      operationId: randomUUID(),
      vaultId: randomUUID(),
      binding: hash,
      targetId: id,
      targetType: "topic",
      kind: "edit",
      relativePath: "Memora/Topics/Topic/Topic.md",
      baseRevision: "revision",
      baseVersion: 1,
      baseHash: hash,
      content: moc,
      occurredAt: new Date().toISOString()
    };
    expect(obsidianEditOperationSchema.safeParse(operation).success).toBe(false);
    expect(
      obsidianEditOperationSchema.safeParse({ ...operation, targetType: "wiki_index" }).success
    ).toBe(true);
  });

  it("is never offered to the plugin in an editorial manifest", () => {
    const manifest = {
      binding: { vaultId: randomUUID(), binding: hash, managedRoot: "Memora" },
      cursor: null,
      files: [
        {
          targetId: id,
          targetType: "topic",
          relativePath: "Memora/Topics/Topic/Topic.md",
          revision: "revision",
          syncVersion: 1,
          contentHash: hash,
          content: moc
        }
      ]
    };
    expect(obsidianManifestSchema.safeParse(manifest).success).toBe(false);
  });
});
