import { posix } from "node:path";

import type { TopicProjectionRows, TopicProjectionTopic } from "@app/db";
import { parseObsidianMarkdown, serializeManagedFrontmatter } from "@app/integration-contracts";
import { describe, expect, it } from "vitest";

import {
  planTopicProjection,
  renderTopicMoc,
  topicAliases,
  topicProjectionConfig,
  withTopicAliases,
  type TopicPlanContext
} from "./obsidian-topic-projection.js";

const u = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const topic = (
  id: string,
  parentId: string | null,
  title: string | null,
  extra: Partial<TopicProjectionTopic> = {}
): TopicProjectionTopic => ({
  id,
  parentId,
  role: parentId ? "topic" : "root",
  title,
  nameState: title ? "named" : "unnamed",
  aliases: [],
  description: null,
  position: 0,
  ...extra
});
const ids = {
  root: u(1),
  area: u(2),
  leaf: u(3),
  other: u(4),
  unnamed: u(5),
  merged: u(6),
  older: u(7),
  empty: u(8)
};
const note = (n: number) => u(100 + n);
const source = (n: number) => u(200 + n);

function rows(): TopicProjectionRows {
  return {
    treeId: u(50),
    generation: 7,
    rootId: ids.root,
    topics: [
      topic(ids.root, null, null),
      topic(ids.area, ids.root, "Memory", { position: 0 }),
      topic(ids.leaf, ids.area, "Forgetting curve", { position: 0, aliases: ["Ebbinghaus"] }),
      topic(ids.other, ids.area, "Spacing", { position: 1, description: "When to review." }),
      topic(ids.unnamed, ids.area, null, { position: 2 }),
      topic(ids.empty, ids.root, "Empty", { position: 1 })
    ],
    redirects: [
      { id: ids.merged, title: "Retention curve", redirectTo: ids.leaf },
      { id: ids.older, title: "Decay", redirectTo: ids.merged }
    ],
    placements: [
      { topicId: ids.leaf, kind: "note", itemId: note(2), rootSourceId: source(1), waiting: false },
      { topicId: ids.leaf, kind: "note", itemId: note(1), rootSourceId: source(2), waiting: false },
      { topicId: ids.leaf, kind: "note", itemId: note(3), rootSourceId: source(1), waiting: true },
      {
        topicId: ids.other,
        kind: "note",
        itemId: note(4),
        rootSourceId: source(2),
        waiting: false
      },
      {
        topicId: ids.unnamed,
        kind: "note",
        itemId: note(5),
        rootSourceId: source(2),
        waiting: false
      },
      { topicId: ids.root, kind: "source", itemId: source(3), rootSourceId: null, waiting: false }
    ]
  };
}

function context(overrides: Partial<TopicPlanContext> = {}) {
  const paths = new Map<string, string>();
  const registered = new Map<string, string>();
  const base: TopicPlanContext = {
    folder: "Memora/Topics",
    rootFile: "Topics",
    language: "en",
    wholeLibrary: true,
    projected: () => true,
    registered: (id) => registered.has(id),
    reserve: (id, path) => {
      const final = registered.get(id) ?? path;
      paths.set(id, final);
      return final;
    },
    ...overrides
  };
  return { base, paths, registered };
}

describe("planning topic maps", () => {
  it("places every named topic as a folder note under its parent, the root as the folder's note", () => {
    const { base } = context();
    const projection = planTopicProjection(rows(), base)!;
    const where = Object.fromEntries(projection.planned.map((p) => [p.topic.id, p.path]));
    expect(where).toEqual({
      [ids.root]: "Memora/Topics/Topics.md",
      [ids.area]: "Memora/Topics/Memory/Memory.md",
      [ids.empty]: "Memora/Topics/Empty/Empty.md",
      [ids.leaf]: "Memora/Topics/Memory/Forgetting curve/Forgetting curve.md",
      [ids.other]: "Memora/Topics/Memory/Spacing/Spacing.md"
    });
    // Parents first, so a child's folder is known when it is placed.
    expect(projection.planned.map((p) => p.topic.id).indexOf(ids.area)).toBeLessThan(
      projection.planned.map((p) => p.topic.id).indexOf(ids.leaf)
    );
    expect(projection.planned[0]!.title).toBe("All topics");
    expect(projection.subtreeNotes.get(ids.area)).toBe(5);
  });

  it("waits for an unnamed topic's first name, unless it already has a file", () => {
    const { base, registered } = context();
    expect(planTopicProjection(rows(), base)!.byId.has(ids.unnamed)).toBe(false);
    registered.set(ids.unnamed, "Memora/Topics/Memory/Unnamed topic/Unnamed topic.md");
    const projection = planTopicProjection(rows(), base)!;
    expect(projection.byId.get(ids.unnamed)).toMatchObject({
      title: "Unnamed topic",
      path: "Memora/Topics/Memory/Unnamed topic/Unnamed topic.md"
    });
  });

  it("keeps a registered path when the topic is renamed or moved", () => {
    const { base, registered } = context();
    registered.set(ids.leaf, "Memora/Topics/Old area/Old name/Old name.md");
    const projection = planTopicProjection(rows(), base)!;
    expect(projection.byId.get(ids.leaf)!.path).toBe("Memora/Topics/Old area/Old name/Old name.md");
  });

  it("gives two titles with one portable name two folders", () => {
    const data = rows();
    data.topics.push(topic(u(9), ids.area, "Spacing?", { position: 3 }));
    const projection = planTopicProjection(data, context().base)!;
    expect(posix.dirname(projection.byId.get(u(9))!.path)).toBe(
      `Memora/Topics/Memory/Spacing — ${u(9).slice(0, 8)}`
    );
  });

  it("maps only the topics that hold projected items when the scope is narrowed", () => {
    const projected = new Set([note(4)]);
    const { base } = context({
      wholeLibrary: false,
      projected: (_kind, id) => projected.has(id)
    });
    const projection = planTopicProjection(rows(), base)!;
    expect([...projection.byId.keys()].sort()).toEqual([ids.root, ids.area, ids.other].sort());
    expect(projection.direct.get(ids.leaf)).toBeUndefined();
  });

  it("returns nothing without an active tree", () => {
    expect(planTopicProjection(null, context().base)).toBeNull();
  });
});

describe("aliases", () => {
  it("lists the current title when the file kept an older name, stored aliases and merged titles", () => {
    const { base, registered } = context();
    registered.set(ids.leaf, "Memora/Topics/Memory/Old name/Old name.md");
    const projection = planTopicProjection(rows(), base)!;
    const leaf = projection.byId.get(ids.leaf)!;
    // Redirects are followed through a retired successor (Decay → Retention curve → leaf).
    expect(topicAliases(projection, leaf)).toEqual([
      "Forgetting curve",
      "Ebbinghaus",
      "Decay",
      "Retention curve"
    ]);
    const fresh = planTopicProjection(rows(), context().base)!;
    expect(topicAliases(fresh, fresh.byId.get(ids.leaf)!)).toEqual([
      "Ebbinghaus",
      "Decay",
      "Retention curve"
    ]);
  });

  it("never repeats a name, never writes a reserved field and stays bounded", () => {
    const data = rows();
    data.topics[2]!.aliases = ["ebbinghaus", "EBBINGHAUS", 'memora_id: "x"', "<!-- memora:x -->"];
    data.redirects = Array.from({ length: 40 }, (_, n) => ({
      id: u(500 + n),
      title: `Name ${String(n).padStart(2, "0")}`,
      redirectTo: ids.leaf
    }));
    const projection = planTopicProjection(data, context().base)!;
    const aliases = topicAliases(projection, projection.byId.get(ids.leaf)!);
    expect(aliases).toHaveLength(topicProjectionConfig.maxAliases);
    expect(aliases[0]).toBe("ebbinghaus");
    expect(aliases.some((alias) => /memora/.test(alias))).toBe(false);
  });

  it("replaces only the aliases line of the user frontmatter", () => {
    expect(withTopicAliases("", [])).toBe("");
    expect(withTopicAliases("", ["A"])).toBe('aliases: ["A"]');
    expect(withTopicAliases('aliases: ["Old"]\ntags: [x]', ["New"])).toBe(
      'aliases: ["New"]\ntags: [x]'
    );
    expect(withTopicAliases("aliases:\n  - Old\n  - Other\ncssclass: wide", [])).toBe(
      "cssclass: wide"
    );
    const frontmatter = serializeManagedFrontmatter(
      {
        memoraId: ids.leaf,
        memoraType: "topic",
        memoraManaged: true,
        memoraSyncVersion: 1,
        memoraContentHash: "a".repeat(64),
        memoraWikiSchema: 1,
        memoraRevisionId: "r"
      },
      withTopicAliases("", ['Quote " and: colon'])
    );
    const parsed = parseObsidianMarkdown(
      frontmatter + "\n# T\n\n<!-- memora:generated:start -->\n\n<!-- memora:generated:end -->\n"
    );
    expect(parsed?.userFrontmatter).toBe('aliases: ["Quote \\" and: colon"]');
  });
});

describe("rendering a map of content", () => {
  const render = (id: string) => {
    const { base, paths } = context();
    const projection = planTopicProjection(rows(), base)!;
    const titles = new Map<string, string>();
    for (let n = 1; n <= 5; n += 1) {
      paths.set(note(n), `Memora/Notes/Note ${n}.md`);
      titles.set(note(n), `Note ${n}`);
    }
    for (let n = 1; n <= 3; n += 1) {
      paths.set(source(n), `Memora/Sources/Source ${n}.md`);
      titles.set(source(n), `Source ${n}`);
    }
    paths.set(u(900), "Memora/Home.md");
    return renderTopicMoc(projection, projection.byId.get(id)!, {
      language: "en",
      link: (target, title) => `[[${paths.get(target)!.replace(/\.md$/, "")}|${title}]]`,
      pathOf: (target) => paths.get(target),
      titleOf: (_kind, target) => titles.get(target)!,
      home: { id: u(900), title: "Home" }
    });
  };

  it("lists the notes by centrality, their sources by contribution, the way up and the app link", () => {
    const moc = render(ids.leaf);
    expect(moc.editorial).toBe("# Forgetting curve\n\n");
    const lines = moc.generated.split("\n");
    expect(lines[0]).toBe(
      `Up: [[Memora/Topics/Memory/Memory|Memory]] · [Open in Memora Eterna](memora://topic/${ids.leaf})`
    );
    // Placement order is centrality order (the repository sorts it); waiting items are marked.
    const notes = lines.filter((line) => line.startsWith("- [[Memora/Notes/"));
    expect(notes).toEqual([
      "- [[Memora/Notes/Note 2|Note 2]]",
      "- [[Memora/Notes/Note 1|Note 1]]",
      "- [[Memora/Notes/Note 3|Note 3]] · Unsorted"
    ]);
    const sources = lines.filter((line) => line.startsWith("- [[Memora/Sources/"));
    expect(sources).toEqual([
      "- [[Memora/Sources/Source 1|Source 1]]",
      "- [[Memora/Sources/Source 2|Source 2]]"
    ]);
    expect(moc.generated).toContain("## Central notes");
    expect(moc.generated).toContain("## Contributing sources");
  });

  it("lists subtopics with their note counts, linking an unnamed one to the app", () => {
    const moc = render(ids.area);
    expect(moc.generated).toContain("## Subtopics");
    expect(moc.generated).toContain(
      "- [[Memora/Topics/Memory/Forgetting curve/Forgetting curve|Forgetting curve]] · 3 notes"
    );
    expect(moc.generated).toContain("- [[Memora/Topics/Memory/Spacing/Spacing|Spacing]] · 1 note");
    expect(moc.generated).toContain(`- [Unnamed topic](memora://topic/${ids.unnamed}) · 1 note`);
  });

  it("names the root's direct items as unsorted and leads up to the vault home", () => {
    const moc = render(ids.root);
    expect(moc.title).toBe("All topics");
    expect(moc.generated.split("\n")[0]).toContain("Up: [[Memora/Home|Home]]");
    expect(moc.generated).toContain(
      "## Contributing sources\n\n- [[Memora/Sources/Source 3|Source 3]]"
    );
  });

  it("says when a topic holds nothing yet, and changes its revision with its content", () => {
    expect(render(ids.empty).generated).toContain(
      "No notes or sources have been placed in this topic yet."
    );
    expect(render(ids.leaf).revision).not.toBe(render(ids.other).revision);
    expect(render(ids.leaf).revision).toBe(render(ids.leaf).revision);
  });
});
