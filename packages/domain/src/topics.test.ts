import { describe, expect, it } from "vitest";

import { AtomicNoteRelationTypeSchema } from "./knowledge.js";
import * as topics from "./topics.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-15T12:00:00.000Z";

describe("topic vocabulary", () => {
  it("has no switch, shadow tree or topic modes (D2)", () => {
    expect(topics.topicTreeStatuses).toEqual(["active", "retired"]);
    expect(topics.TopicTreeStatusSchema.safeParse("shadow").success).toBe(false);
    expect(topics.topicChangeSetOrigins).not.toContain("switch");
    expect(topics.TopicChangeSetOriginSchema.safeParse("switch").success).toBe(false);
    expect(topics.topicsPhases).toEqual(["building", "active"]);
    for (const phase of ["legacy", "ready_to_switch", "switching"]) {
      expect(topics.TopicsPhaseSchema.safeParse(phase).success).toBe(false);
    }
    expect(Object.keys(topics)).not.toContain("topicGateModes");
    expect(Object.keys(topics)).not.toContain("TopicGateModeSchema");
  });

  it("has no overview request, switch or switch progress contract (T31 and the wipe own them)", () => {
    const names = Object.keys(topics);
    expect(names.filter((name) => /switch/iu.test(name))).toEqual([]);
    expect(names).not.toContain("TopicOverviewInputSchema");
    expect(names).not.toContain("TopicsSwitchProgressSchema");
  });
});

const node = (overrides: Record<string, unknown> = {}) => ({
  id: id(1),
  parentId: null,
  title: "Memory",
  nameState: "named",
  management: "ai",
  items: 12,
  directItems: 2,
  unsorted: 1,
  children: 4,
  health: "good",
  newThisWeek: 3,
  position: 0,
  updatedAt: at,
  ...overrides
});

const noteLeaf = (overrides: Record<string, unknown> = {}) => ({
  kind: "note",
  id: id(10),
  title: "Retrieval strengthens memory",
  sourceTitle: "Make It Stick",
  provenance: "ai",
  role: "primary",
  unsorted: false,
  ...overrides
});

const sourceLeaf = (overrides: Record<string, unknown> = {}) => ({
  kind: "source",
  id: id(11),
  title: "Make It Stick",
  noteCount: 6,
  role: "primary",
  unsorted: false,
  ...overrides
});

describe("topics.tree", () => {
  it("fills the defaults and keeps the bounds of a request", () => {
    expect(topics.TopicTreeInputSchema.parse({})).toEqual({
      parentId: null,
      limit: 100,
      includeItems: false,
      itemLimit: 5
    });
    expect(
      topics.TopicTreeInputSchema.parse({
        parentId: id(1),
        cursor: "abc",
        limit: 200,
        includeItems: true,
        itemLimit: 50
      })
    ).toMatchObject({ parentId: id(1), cursor: "abc", limit: 200, itemLimit: 50 });
    for (const bad of [
      { limit: 0 },
      { limit: 201 },
      { itemLimit: 51 },
      { itemLimit: -1 },
      { parentId: "root" },
      { cursor: "x".repeat(201) },
      { cursor: "" },
      { unknown: true }
    ]) {
      expect(topics.TopicTreeInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("round-trips an answer with both kinds of leaf and refuses extra or missing fields", () => {
    const answer = {
      generation: 7,
      parent: node(),
      nodes: [node({ id: id(2), parentId: id(1), title: null, nameState: "unnamed" })],
      items: [noteLeaf(), sourceLeaf({ role: "secondary" })],
      moreItems: 3,
      unsorted: 1,
      nextCursor: null
    };
    expect(topics.TopicTreeSchema.parse(answer)).toEqual(answer);
    expect(topics.TopicTreeSchema.safeParse({ ...answer, extra: 1 }).success).toBe(false);
    expect(
      topics.TopicTreeSchema.safeParse({ ...answer, parent: { ...node(), extra: 1 } }).success
    ).toBe(false);
    expect(topics.TopicTreeSchema.safeParse({ ...answer, items: [{ kind: "page" }] }).success).toBe(
      false
    );
    expect(
      topics.TopicTreeSchema.safeParse({ ...answer, parent: node({ items: -1 }) }).success
    ).toBe(false);
    expect(
      topics.TopicTreeSchema.safeParse({ ...answer, parent: node({ updatedAt: "yesterday" }) })
        .success
    ).toBe(false);
    expect(
      topics.TopicTreeSchema.safeParse({
        ...answer,
        nodes: Array.from({ length: 201 }, () => node())
      }).success
    ).toBe(false);
  });

  it("counts titles in characters, as the database does, so an emoji at the bound passes", () => {
    const title = "🧠".repeat(120);
    expect(title.length).toBe(240);
    expect(topics.TopicNodeSummarySchema.parse(node({ title })).title).toBe(title);
    expect(topics.TopicNodeSummarySchema.safeParse(node({ title: "🧠".repeat(121) })).success).toBe(
      false
    );
    expect(topics.TopicNodeSummarySchema.safeParse(node({ title: "" })).success).toBe(false);
  });
});

describe("topics.path, topics.notes and topics.changeSets.get", () => {
  it("accepts a path of at most eight topics and refuses a ninth", () => {
    const entry = (n: number) => ({ id: id(n), title: n === 1 ? null : `Level ${n}` });
    const answer = {
      resolvedId: id(8),
      redirectedFrom: id(9),
      path: Array.from({ length: 8 }, (_, n) => entry(n + 1))
    };
    expect(topics.TopicPathSchema.parse(answer)).toEqual(answer);
    expect(
      topics.TopicPathSchema.safeParse({ ...answer, path: [...answer.path, entry(9)] }).success
    ).toBe(false);
    expect(topics.TopicPathInputSchema.safeParse({ id: "x" }).success).toBe(false);
  });

  it("scopes a leaf page and refuses an unknown scope, kind or limit", () => {
    expect(topics.TopicNotesInputSchema.parse({ id: id(1) })).toEqual({
      id: id(1),
      limit: 50,
      scope: "direct",
      kind: "all"
    });
    expect(
      topics.TopicNotesInputSchema.parse({ id: id(1), scope: "subtree", kind: "note", limit: 100 })
    ).toMatchObject({ scope: "subtree", kind: "note", limit: 100 });
    for (const bad of [{ scope: "all" }, { kind: "source" }, { limit: 101 }, { limit: 0 }]) {
      expect(topics.TopicNotesInputSchema.safeParse({ id: id(1), ...bad }).success).toBe(false);
    }
    const page = { items: [noteLeaf(), sourceLeaf()], nextCursor: "next" };
    expect(topics.TopicNotesSchema.parse(page)).toEqual(page);
  });

  it("round-trips a change-set with its two sides and bounds both", () => {
    const summary = {
      id: id(20),
      origin: "rebalance",
      status: "applied",
      titleKey: "topics.changeSets.split",
      titleParams: { count: 3, name: "Memory", dry: false, none: null },
      risk: "low",
      at,
      undo: "available"
    };
    const side = {
      topics: [{ id: id(1), title: null, parentTitle: "Learning" }],
      items: [{ kind: "note", id: id(10), title: "A note", topicId: id(1), topicTitle: null }]
    };
    const detail = { summary, before: side, after: side, truncated: false };
    expect(topics.TopicChangeSetSchema.parse(detail)).toEqual(detail);
    expect(
      topics.TopicChangeSetSchema.safeParse({
        ...detail,
        after: { ...side, topics: Array.from({ length: 51 }, () => side.topics[0]) }
      }).success
    ).toBe(false);
    expect(
      topics.TopicChangeSetSchema.safeParse({
        ...detail,
        summary: { ...summary, titleParams: { nested: { no: true } } }
      }).success
    ).toBe(false);
    expect(
      topics.TopicChangeSetSchema.safeParse({
        ...detail,
        summary: { ...summary, origin: "switch" }
      }).success
    ).toBe(false);
  });
});

describe("topics.page", () => {
  const page = () => ({
    generation: 3,
    topic: {
      ...node(),
      description: "How memory works.",
      aliases: ["Remembering"],
      nameLanguage: "en",
      coherence: 0.81
    },
    redirectedFrom: null,
    path: [
      { id: id(100), title: null },
      { id: id(1), title: "Memory" }
    ],
    counts: { notes: 23, sources: 3, subtopics: 2 },
    subtopics: [{ id: id(2), title: "Retrieval", items: 9, description: null, health: "good" }],
    centralNotes: [
      {
        id: id(10),
        title: "Retrieval strengthens memory",
        idea: "Recall beats rereading.",
        sourceId: id(30),
        sourceTitle: "Make It Stick",
        relationCount: 4,
        provenance: "human",
        centrality: 0.93,
        movedFrom: { id: id(3), title: null, at }
      }
    ],
    moreNotes: 22,
    sources: [{ id: id(30), title: "Make It Stick", subtitle: null, noteCount: 9 }],
    relatedTopics: [{ id: id(4), title: "Sleep", relationCount: 6 }],
    relationStances: {
      supports: 4,
      contrasts: 1,
      extends: 0,
      similar_to: 2,
      depends_on: 0,
      clarifies: 0,
      mentions: 0,
      related: 3
    },
    lastChange: {
      changeSetId: id(40),
      titleKey: "topics.changeSets.place",
      titleParams: { count: 1 },
      at,
      undo: "blocked"
    },
    overview: { status: "absent", canWrite: false }
  });

  it("defaults the number of central notes and bounds it", () => {
    expect(topics.TopicPageInputSchema.parse({ id: id(1) })).toEqual({ id: id(1), noteLimit: 6 });
    expect(topics.TopicPageInputSchema.safeParse({ id: id(1), noteLimit: 21 }).success).toBe(false);
    expect(topics.TopicPageInputSchema.safeParse({ id: id(1), noteLimit: 0 }).success).toBe(false);
  });

  it("round-trips a page and keeps every stance count of the relation vocabulary", () => {
    expect(topics.TopicPageSchema.parse(page())).toEqual(page());
    expect(Object.keys(topics.TopicRelationStancesSchema.shape).sort()).toEqual(
      [...AtomicNoteRelationTypeSchema.options].sort()
    );
    expect([...topics.topicRelationStanceTypes]).toEqual([...AtomicNoteRelationTypeSchema.options]);
    const missing = page();
    delete (missing.relationStances as Record<string, number>).contrasts;
    expect(topics.TopicPageSchema.safeParse(missing).success).toBe(false);
  });

  it("bounds the lists of a page", () => {
    const over = (key: string, value: unknown) => ({ ...page(), [key]: value });
    expect(
      topics.TopicPageSchema.safeParse(over("subtopics", Array(17).fill(page().subtopics[0])))
        .success
    ).toBe(false);
    expect(
      topics.TopicPageSchema.safeParse(over("centralNotes", Array(21).fill(page().centralNotes[0])))
        .success
    ).toBe(false);
    expect(
      topics.TopicPageSchema.safeParse(over("sources", Array(21).fill(page().sources[0]))).success
    ).toBe(false);
    expect(
      topics.TopicPageSchema.safeParse(
        over("relatedTopics", Array(9).fill(page().relatedTopics[0]))
      ).success
    ).toBe(false);
    const tooManyAliases = {
      ...page(),
      topic: { ...page().topic, aliases: Array.from({ length: 11 }, (_, n) => `Alias ${n}`) }
    };
    expect(topics.TopicPageSchema.safeParse(tooManyAliases).success).toBe(false);
  });

  it("carries the four states of an overview", () => {
    const ready = {
      status: "ready",
      stale: false,
      paragraphs: [{ text: "Memory is rebuilt at each recall [1].", citations: [1] }],
      citations: [
        {
          n: 1,
          chunkId: id(50),
          sourceSpanId: id(51),
          sourceTitle: "Make It Stick",
          excerpt: "Retrieval practice…",
          available: true
        }
      ],
      evidence: { used: 1, total: 3 },
      writtenAt: at,
      model: "writer",
      language: "en",
      support: { status: "verified", unsupported: [] }
    };
    for (const state of [
      { status: "absent", canWrite: true, reasonKey: "topics.overview.noRoute" },
      { status: "writing" },
      ready,
      { status: "failed", messageKey: "topics.overview.failed" }
    ]) {
      expect(topics.TopicOverviewStateSchema.parse(state)).toEqual(state);
    }
    expect(topics.TopicOverviewStateSchema.safeParse({ status: "stale" }).success).toBe(false);
    expect(
      topics.TopicOverviewStateSchema.safeParse({
        ...ready,
        support: { status: "maybe", unsupported: [] }
      }).success
    ).toBe(false);
  });
});

describe("topics.shape", () => {
  const shape = () => ({
    generation: 5,
    summary: {
      items: 120,
      topics: 14,
      meanDepth: 2.4,
      reachable: 1,
      unsortedShare: 0.02,
      needsVector: 1,
      soft: 2,
      hard: 0
    },
    nodes: [
      {
        id: id(1),
        parentId: null,
        depth: 0,
        title: null,
        management: "ai",
        items: 120,
        directItems: 2,
        children: 3,
        health: "good",
        newThisWeek: 4,
        coherence: null
      }
    ],
    truncated: false,
    warnings: [
      {
        topicId: id(2),
        code: "single-child",
        params: { invariant: "I6", severity: "soft", awaitingApproval: false },
        changeSetId: null,
        pendingReview: false
      },
      {
        topicId: null,
        code: "pending-review",
        params: { origin: "areas" },
        changeSetId: id(9),
        pendingReview: true
      }
    ],
    changedToday: []
  });

  it("defaults the request and bounds depth and cells", () => {
    expect(topics.TopicShapeInputSchema.parse({})).toEqual({
      rootId: null,
      depth: 4,
      nodeLimit: 2000
    });
    for (const bad of [{ depth: 0 }, { depth: 8 }, { nodeLimit: 2001 }, { nodeLimit: 0 }]) {
      expect(topics.TopicShapeInputSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("reaches the tree's hard depth cap (7) and no deeper", () => {
    expect(topics.topicReadLimits.shapeDepthMax).toBe(7);
    // The root and seven levels are the longest path a read can name.
    expect(topics.topicReadLimits.pathMax).toBe(topics.topicReadLimits.shapeDepthMax + 1);
    for (const depth of [1, 4, 5, 6, 7]) {
      expect(topics.TopicShapeInputSchema.parse({ depth }).depth).toBe(depth);
    }
    expect(topics.TopicShapeInputSchema.safeParse({ depth: 8 }).success).toBe(false);
    expect(topics.TopicShapeInputSchema.safeParse({ depth: 7.5 }).success).toBe(false);
    expect(topics.TopicShapeInputSchema.parse({ depth: 7, nodeLimit: 2000 })).toEqual({
      rootId: null,
      depth: 7,
      nodeLimit: 2000
    });
  });

  it("round-trips an answer and refuses shares outside 0..1 and more than 2,000 cells", () => {
    expect(topics.TopicShapeSchema.parse(shape())).toEqual(shape());
    const share = shape();
    share.summary.unsortedShare = 1.2;
    expect(topics.TopicShapeSchema.safeParse(share).success).toBe(false);
    const cells = shape();
    cells.nodes = Array.from({ length: 2001 }, () => shape().nodes[0] as never);
    expect(topics.TopicShapeSchema.safeParse(cells).success).toBe(false);
    const warnings = shape();
    warnings.warnings = Array.from({ length: 51 }, () => shape().warnings[0] as never);
    expect(topics.TopicShapeSchema.safeParse(warnings).success).toBe(false);
  });
});

describe("human operations, undo, review, status and re-embedding", () => {
  it("accepts each mutation by operation and refuses a missing token or a stray field", () => {
    const valid = [
      { op: "rename", id: id(1), title: "  Retrieval  ", expectedUpdatedAt: at },
      { op: "move", id: id(1), parentId: id(2), position: 3, expectedUpdatedAt: at },
      { op: "move", id: id(1), parentId: id(2), expectedUpdatedAt: at },
      { op: "create", parentId: id(2), title: "New topic" },
      { op: "pin", id: id(1) },
      { op: "unpin", id: id(1) },
      { op: "placeItem", item: { kind: "note", id: id(10) }, topicId: id(1), role: "secondary" }
    ];
    for (const mutation of valid) {
      expect(topics.TopicMutationSchema.safeParse(mutation).success, JSON.stringify(mutation)).toBe(
        true
      );
    }
    expect(topics.TopicMutationSchema.parse(valid[0]).op).toBe("rename");
    expect((topics.TopicMutationSchema.parse(valid[0]) as { title: string }).title).toBe(
      "Retrieval"
    );
    for (const bad of [
      { op: "rename", id: id(1), title: "x" },
      { op: "rename", id: id(1), title: "   ", expectedUpdatedAt: at },
      { op: "rename", id: id(1), title: "x".repeat(121), expectedUpdatedAt: at },
      { op: "move", id: id(1), expectedUpdatedAt: at },
      { op: "pin", id: id(1), extra: true },
      { op: "delete", id: id(1) },
      { op: "placeItem", item: { kind: "page", id: id(10) }, topicId: id(1), role: "primary" }
    ]) {
      expect(topics.TopicMutationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(topics.TopicMutationResultSchema.parse({ changeSetId: id(5), generation: 9 })).toEqual({
      changeSetId: id(5),
      generation: 9
    });
  });

  it("answers an undo with the change-set that records it or with at most ten blockers", () => {
    expect(
      topics.TopicUndoResultSchema.parse({ status: "undone", changeSetId: id(6), generation: 10 })
    ).toMatchObject({ status: "undone" });
    const blockers = [
      { kind: "changeSet", changeSetId: id(7), objects: [`topic:${id(1)}`] },
      { kind: "itemDeleted", item: `note:${id(10)}` },
      { kind: "notApplied", status: "undone" },
      { kind: "conflict", code: "depthCap", topicId: id(1), item: null, reason: "too deep" }
    ];
    expect(topics.TopicUndoResultSchema.parse({ status: "blocked", blockers })).toEqual({
      status: "blocked",
      blockers
    });
    expect(
      topics.TopicUndoResultSchema.safeParse({
        status: "blocked",
        blockers: Array.from({ length: 11 }, () => blockers[1])
      }).success
    ).toBe(false);
    expect(topics.TopicUndoInputSchema.safeParse({ changeSetId: "x" }).success).toBe(false);
  });

  it("reviews with apply or dismiss only", () => {
    expect(
      topics.TopicReviewInputSchema.parse({ changeSetId: id(8), decision: "dismiss" })
    ).toEqual({ changeSetId: id(8), decision: "dismiss" });
    expect(
      topics.TopicReviewInputSchema.safeParse({ changeSetId: id(8), decision: "later" }).success
    ).toBe(false);
    expect(topics.TopicReviewResultSchema.parse({ status: "dismissed" })).toEqual({
      status: "dismissed"
    });
  });

  it("reports a status that never blocks and refuses the removed phases", () => {
    const status = {
      phase: "building",
      blocked: "waiting_for_embeddings",
      counts: { items: 40, placed: 10, pending: 30, needsGate: 0 },
      dailyCapReached: true,
      reembedNotes: 12
    };
    expect(topics.TopicsStatusSchema.parse(status)).toEqual(status);
    expect(
      topics.TopicsStatusSchema.parse({ phase: "active", counts: status.counts })
    ).toMatchObject({ phase: "active" });
    expect(topics.TopicsStatusSchema.safeParse({ ...status, phase: "switching" }).success).toBe(
      false
    );
    expect(topics.TopicsStatusSchema.safeParse({ ...status, blocked: "stuck" }).success).toBe(
      false
    );
  });

  it("requires an explicit confirmation to re-embed", () => {
    expect(topics.TopicReembedInputSchema.parse({ confirm: true })).toEqual({ confirm: true });
    expect(topics.TopicReembedInputSchema.safeParse({ confirm: false }).success).toBe(false);
    expect(topics.TopicReembedInputSchema.safeParse({}).success).toBe(false);
    expect(topics.TopicReembedResultSchema.parse({ queued: 0 })).toEqual({ queued: 0 });
  });

  it("names the failures a handler reports with message keys", () => {
    expect(topics.topicErrorKeys).toEqual([
      "topics.errors.stale",
      "topics.errors.cycle",
      "topics.errors.duplicateTitle",
      "topics.errors.notFound",
      "topics.errors.protected",
      "topics.errors.unavailable"
    ]);
    expect(topics.TopicErrorKeySchema.safeParse("topics.errors.other").success).toBe(false);
  });
});

describe("topicsChanged", () => {
  it("carries a bounded list of topics or null, and nothing else", () => {
    const event = { treeId: id(1), generation: 4, topicIds: [id(2), id(3)], changeSetId: id(4) };
    expect(topics.TopicsChangedEventSchema.parse(event)).toEqual(event);
    expect(
      topics.TopicsChangedEventSchema.parse({ ...event, topicIds: null, changeSetId: null })
    ).toMatchObject({ topicIds: null });
    expect(
      topics.TopicsChangedEventSchema.safeParse({
        ...event,
        topicIds: Array.from({ length: 201 }, (_, n) => id(n + 10))
      }).success
    ).toBe(false);
    expect(topics.TopicsChangedEventSchema.safeParse({ ...event, extra: 1 }).success).toBe(false);
    expect(topics.TopicsChangedEventSchema.safeParse({ ...event, generation: -1 }).success).toBe(
      false
    );
  });
});
