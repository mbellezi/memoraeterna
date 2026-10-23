import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ChangesDiffSchema,
  ChangeSetSummarySchema,
  changeSetReadLimits,
  relationChangeSetKinds,
  TopicMessageParamsSchema
} from "@app/domain";
import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";
import type { StructureEvent, TopicRenamePayload } from "@app/domain/topic-tree";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import {
  ChangeSetCursorError,
  changeSetMessageParams,
  createChangeSetRepository,
  decodeChangeSetCursor,
  encodeChangeSetCursor,
  overviewDiffSide,
  relationDiffItems,
  topicDiffNodes,
  type RelationDiffEvent,
  type TopicDiffCurrent
} from "./changeSetRepository.js";
import { createJobRepository } from "./jobRepository.js";
import { createRelationEventRepository, humanRelationRunKinds } from "./relationEventRepository.js";
import {
  createRelationMatchRunRepository,
  relationMatchRunKinds
} from "./relationMatchRunRepository.js";
import { createSourceItemRepository } from "./sourceItemRepository.js";
import {
  createTopicOverviewRepository,
  type SaveTopicOverviewInput
} from "./topicOverviewRepository.js";
import { createTopicTreeRepository } from "./topicTreeRepository.js";

// The change-set read model (F4 D10, T77): the pure diff builders here; the view, the undo
// availability, every store's retention and the per-store undo against a real PostgreSQL below.
// The migration itself is verified by `npm run db:changes:verify`.
const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));
const uuidOf = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

describe("a change-set title's parameters", () => {
  it("clip a long title to the contract's 300 UTF-16 units without splitting a character", () => {
    const title = "📚".repeat(200);
    const params = changeSetMessageParams({ note: title, n: 3, ok: true, gone: undefined });
    expect(params.note).toBe("📚".repeat(150));
    expect(params).toMatchObject({ n: 3, ok: true });
    expect(TopicMessageParamsSchema.safeParse(params).success).toBe(true);
    expect(changeSetMessageParams({ note: `a${"📚".repeat(200)}` }).note).toHaveLength(299);
  });
});

describe("the topic diff", () => {
  const current = (
    id: number,
    parent: number | null,
    title: string | null,
    depth: number,
    touched = true
  ): TopicDiffCurrent => ({
    id: uuidOf(id),
    parentId: parent === null ? null : uuidOf(parent),
    title,
    retired: false,
    touched,
    depth
  });

  it("gives each touched topic its two sides and hangs it from its ancestors", () => {
    const { nodes, hidden } = topicDiffNodes(
      [
        {
          op: "topic.move",
          topicId: uuidOf(3),
          before: { parentId: uuidOf(1), position: 0 },
          after: { parentId: uuidOf(2), position: 1 }
        },
        {
          op: "topic.rename",
          topicId: uuidOf(3),
          before: { title: "Naps" },
          after: { title: "Short sleep" }
        },
        {
          op: "topic.create",
          topicId: uuidOf(4),
          before: null,
          after: { parentId: uuidOf(2), title: null }
        },
        {
          op: "topic.retire",
          topicId: uuidOf(5),
          before: { retiredAt: null },
          after: { retiredAt: "x" }
        }
      ],
      [
        current(0, null, null, 0, false),
        current(1, 0, "Sleep", 1, false),
        current(2, 0, "Rest", 1, false),
        current(3, 2, "Short sleep", 2),
        current(4, 2, null, 2),
        current(5, 1, "Old", 2)
      ],
      new Map([[uuidOf(2), { in: 3, out: 0 }]])
    );
    expect(hidden).toBe(0);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    // The shallowest first: ancestors precede what hangs from them.
    expect(nodes.map((node) => node.id).indexOf(uuidOf(0))).toBe(0);
    expect(byId.get(uuidOf(0))?.change).toBe("context");
    expect(byId.get(uuidOf(2))).toMatchObject({ change: "context", itemsIn: 3, itemsOut: 0 });
    // A move that also renames reads as moved, with both parents and both titles.
    expect(byId.get(uuidOf(3))).toMatchObject({
      change: "moved",
      parentBefore: uuidOf(1),
      parentAfter: uuidOf(2),
      titleBefore: "Naps",
      titleAfter: "Short sleep",
      existedBefore: true,
      existsAfter: true
    });
    expect(byId.get(uuidOf(4))).toMatchObject({
      change: "added",
      existedBefore: false,
      parentBefore: null,
      parentAfter: uuidOf(2)
    });
    expect(byId.get(uuidOf(5))).toMatchObject({ change: "removed", existsAfter: false });
  });

  it("keeps the shallowest nodes within the bound and counts the rest", () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      current(index + 10, index === 0 ? null : 10, `T${index}`, index === 0 ? 0 : 1)
    );
    const { nodes, hidden } = topicDiffNodes([], rows, new Map(), 4);
    expect(nodes).toHaveLength(4);
    expect(hidden).toBe(6);
    expect(nodes[0]?.id).toBe(uuidOf(10));
    expect(changeSetReadLimits.diffNodesMax).toBe(200);
  });
});

describe("the relation diff", () => {
  const image = (status: string, type: string | null) => ({
    from: uuidOf(1),
    to: uuidOf(2),
    status,
    band: "suggest",
    type
  });
  const event = (
    relationId: string | null,
    kind: string,
    before: RelationDiffEvent["before"],
    after: RelationDiffEvent["after"]
  ): RelationDiffEvent => ({
    relationKind: "note",
    relationId,
    pairKey: `p-${relationId}`,
    kind,
    before,
    after
  });

  it("groups a pass's events per relation, first before against last after", () => {
    const { relations, hidden } = relationDiffItems(
      [
        event(uuidOf(10), "suggested", null, image("pending_review", null)),
        event(
          uuidOf(10),
          "typed",
          image("pending_review", null),
          image("pending_review", "supports")
        ),
        event(
          uuidOf(11),
          "vetoed",
          image("pending_review", "extends"),
          image("pending_review", "extends")
        ),
        event(uuidOf(12), "suggested", null, image("pending_review", null)),
        event(uuidOf(12), "removed", image("pending_review", null), null)
      ],
      new Map([
        [`note:${uuidOf(1)}`, "Sleep and memory"],
        [`note:${uuidOf(2)}`, "Naps"]
      ])
    );
    // Created and deleted within the pass: nothing remains to show.
    expect(hidden).toBe(1);
    expect(relations).toEqual([
      {
        relationKind: "note",
        relationId: uuidOf(10),
        change: "created",
        events: ["suggested", "typed"],
        from: { id: uuidOf(1), title: "Sleep and memory" },
        to: { id: uuidOf(2), title: "Naps" },
        before: null,
        after: { status: "pending_review", band: "suggest", type: "supports" }
      },
      expect.objectContaining({ relationId: uuidOf(11), change: "changed", events: ["vetoed"] })
    ]);
  });
});

describe("the relation passes that are change-sets", () => {
  it("are every run kind but the human ones, as the view and its titles have them", () => {
    expect([...relationChangeSetKinds].sort()).toEqual(
      relationMatchRunKinds
        .filter((kind) => !(humanRelationRunKinds as readonly string[]).includes(kind))
        .sort()
    );
  });
});

describe("the overview diff side and the cursor", () => {
  it("bounds a stored text and drops malformed parts", () => {
    expect(overviewDiffSide(null, 1)).toBeNull();
    expect(
      overviewDiffSide(
        {
          paragraphs: [{ text: "One.", citations: [1, 0, "x"] }, { text: "" }, "bad"],
          divergences: [{ existing: "E1", new: "E2", summary: "Differs." }, { existing: "E1" }]
        },
        3
      )
    ).toEqual({
      version: 3,
      paragraphs: [{ text: "One.", citations: [1] }],
      divergences: [{ existing: "E1", new: "E2", summary: "Differs." }]
    });
  });

  it("round-trips a cursor and refuses a forged one", () => {
    const row = { at: "2026-10-23T12:00:00.123456Z", kind: "topic" as const, id: uuidOf(7) };
    expect(decodeChangeSetCursor(encodeChangeSetCursor(row))).toEqual(row);
    expect(() => decodeChangeSetCursor("bm90LWEtY3Vyc29y")).toThrow(ChangeSetCursorError);
    expect(() => decodeChangeSetCursor("%%%")).toThrow(ChangeSetCursorError);
  });
});

describe.skipIf(!sidecarInstalled)("change-sets on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const db = () => pool!;
  const changeSets = () => createChangeSetRepository(db());
  const runs = () => createRelationMatchRunRepository(db());
  const events = () => createRelationEventRepository(db());
  const topicIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  let treeId = "";
  let buildId = "";

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-change-sets-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_change_sets_test",
        user: "memora_change_sets_test",
        password: `change-sets-${randomUUID()}`,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000
      });
      try {
        connection = await manager.start();
      } catch (error) {
        await manager.stop().catch(() => undefined);
        if (attempt >= 3) throw error;
      }
    }
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, resolve(workspace, "packages/db/drizzle"), {
      seedFolder: resolve(workspace, "packages/db/seed")
    });
    const sources = createSourceItemRepository(db());
    const items = [];
    for (let index = 0; index < topicIds.length; index += 1)
      items.push(await sources.create({ type: "Book", title: `Book ${index}` }));
    const trees = createTopicTreeRepository(db());
    const rootId = randomUUID();
    const tree = await trees.createTree({
      id: randomUUID(),
      rootId,
      spaceKey: "test:change-sets:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config: {},
      configHash: "test",
      seed: 1
    });
    const built = await trees.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: topicIds.map((id, position) =>
        topicRecord(id, rootId, {
          role: "topic",
          title: `Topic ${position}`,
          nameState: "provisional",
          nameSource: "tfidf",
          nameLanguage: "en",
          position
        })
      ),
      placements: items.map((item, index) => ({
        item: itemKey("source", item.id),
        placement: placementRecord(topicIds[index]!, { itemFingerprint: "v1" })
      }))
    });
    expect(built.kind).toBe("applied");
    treeId = tree.id;
    buildId = (built as { changeSetId: string }).changeSetId;
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  /** The current name fields of a topic, as a rename's `before`. */
  async function nameOf(topicId: string): Promise<TopicRenamePayload> {
    const records = await createTopicTreeRepository(db()).readTreeRecords(treeId);
    const topic = records.topics.find((entry) => entry.id === topicId)!;
    return {
      title: topic.title,
      nameState: topic.nameState,
      nameSource: topic.nameSource,
      nameLanguage: topic.nameLanguage,
      namedChangeSetId: topic.namedChangeSetId,
      aliases: topic.aliases
    };
  }

  /** One applied change-set renaming a topic (provisional names: no change-set names it). */
  async function rename(
    topicId: string,
    title: string,
    origin: "rebalance" | "naming" = "rebalance",
    named = false
  ): Promise<string> {
    const trees = createTopicTreeRepository(db());
    const tree = (await trees.tree(treeId))!;
    const id = randomUUID();
    const before = await nameOf(topicId);
    const after: TopicRenamePayload = named
      ? { ...before, title, nameState: "named", nameSource: "llm", namedChangeSetId: id }
      : { ...before, title };
    const events: StructureEvent[] = [{ op: "topic.rename", topicId, before, after }];
    const result = await trees.applyChangeSet({
      id,
      treeId,
      expectedGeneration: tree.generation,
      origin,
      titleKey: `topics.changeSets.${origin}`,
      events
    });
    expect(result.kind).toBe("applied");
    return id;
  }

  async function undo(changeSetId: string): Promise<string> {
    const result = await createTopicTreeRepository(db()).undoChangeSet({
      treeId,
      changeSetId,
      titleKey: "topics.changeSets.undo"
    });
    expect(result.kind).toBe("applied");
    return (result as { changeSetId: string }).changeSetId;
  }

  const createdAt = async (id: string): Promise<Date> =>
    (
      await db().query<{ at: Date }>(
        `select created_at as at from topic_change_sets where id = $1
         union all select created_at from topic_overview_versions where id = $1`,
        [id]
      )
    ).rows[0]!.at;

  const exists = async (table: string, id: string): Promise<boolean> =>
    ((await db().query(`select 1 from ${table} where id = $1`, [id])).rowCount ?? 0) > 0;

  /** A finished relation pass with one event per relation ID. */
  async function pass(
    kind: "link" | "match" | "review" | "veto",
    relationIds: Array<string | null>,
    options: { pendingReview?: boolean; finish?: boolean } = {}
  ): Promise<string> {
    const run = await runs().start({ kind, pendingReview: options.pendingReview ?? false });
    for (const relationId of relationIds)
      await events().append({
        runId: run.id,
        relationKind: "note",
        relationId,
        pairKey: `pair-${relationId ?? randomUUID()}`,
        kind: "suggested",
        before: null,
        after: null
      });
    if (options.finish !== false) await runs().finish(run.id, { outcome: "completed" });
    return run.id;
  }

  it("lists change-sets of every store, never a human, open or empty pass", async () => {
    const applied = await pass("link", [randomUUID()]);
    const review = await pass("review", [randomUUID()]);
    const veto = await pass("veto", [randomUUID()]);
    const open = await pass("link", [randomUUID()], { finish: false });
    const empty = await pass("link", []);
    const page = await changeSets().list({ kind: "relation", limit: 50 });
    const ids = page.items.map((item) => item.id);
    expect(ids).toContain(applied);
    for (const id of [review, veto, open, empty]) expect(ids).not.toContain(id);
    for (const item of page.items) expect(() => ChangeSetSummarySchema.parse(item)).not.toThrow();
    expect(await changeSets().get("relation", review)).toBeNull();
    const build = await changeSets().get("topic", buildId);
    expect(build).toMatchObject({ status: "applied", undo: "unavailable", subjectId: treeId });
  });

  it("pages newest first with a keyset cursor, filtered by kind, status and risk", async () => {
    for (let index = 0; index < 5; index += 1) await pass("match", [randomUUID()]);
    const all = await changeSets().list({ limit: 50 });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<ReturnType<typeof changeSets>["list"]>> =
        await changeSets().list({ limit: 2, cursor });
      seen.push(...page.items.map((item) => `${item.kind}:${item.id}`));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.items.map((item) => `${item.kind}:${item.id}`));
    const times = all.items.map((item) => Date.parse(item.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(
      (await changeSets().list({ status: "undone", limit: 50 })).items.every(
        (item) => item.status === "undone"
      )
    ).toBe(true);
    expect((await changeSets().list({ risk: "high", limit: 50 })).items).toEqual([]);
    await expect(changeSets().list({ limit: 2, cursor: "bad" })).rejects.toThrow(
      ChangeSetCursorError
    );
  });

  it("reads a later pass on the same relation, or a later change-set on the same topic, as blocking", async () => {
    const relation = randomUUID();
    const first = await pass("link", [relation]);
    const second = await pass("link", [relation]);
    expect((await changeSets().get("relation", first))?.undo).toBe("blocked");
    expect((await changeSets().get("relation", second))?.undo).toBe("available");
    // A reverted later pass no longer blocks (its revert put the row back).
    expect((await events().revertRun(second)).kind).toBe("reverted");
    expect((await changeSets().get("relation", first))?.undo).toBe("available");
    expect((await changeSets().get("relation", second))?.status).toBe("undone");

    const early = await rename(topicIds[0]!, "Early");
    const late = await rename(topicIds[0]!, "Late");
    expect((await changeSets().get("topic", early))?.undo).toBe("blocked");
    expect((await changeSets().get("topic", late))?.undo).toBe("available");
    const diff = ChangesDiffSchema.parse(await changeSets().diff("topic", late));
    expect(
      diff.kind === "topic" && diff.nodes.find((node) => node.id === topicIds[0])
    ).toMatchObject({
      change: "renamed",
      titleBefore: "Early",
      titleAfter: "Late"
    });
  });

  it("prunes topic change-sets past the window, an undo pair only together, never a proposal", async () => {
    const trees = createTopicTreeRepository(db());
    // Timeline on topics 1-3: X, X2, U1 = undo(X), Y, U2 = undo(Y), Z; a pending proposal P and a
    // naming change-set N that names topic 3.
    const x = await rename(topicIds[1]!, "X");
    const x2 = await rename(topicIds[2]!, "X2");
    const u1 = await undo(x);
    const named = await rename(topicIds[3]!, "Named", "naming", true);
    const y = await rename(topicIds[3]!, "Y");
    const u2 = await undo(y);
    const z = await rename(topicIds[2]!, "Z");
    // A later naming change-set: N stays only because it still names topic 3.
    const n2 = await rename(topicIds[1]!, "N2", "naming");
    const tree = (await trees.tree(treeId))!;
    const proposal = await trees.applyChangeSet({
      treeId,
      expectedGeneration: tree.generation,
      origin: "rebalance",
      titleKey: "topics.changeSets.proposal",
      status: "pending_review",
      events: [
        {
          op: "topic.rename",
          topicId: topicIds[2]!,
          before: await nameOf(topicIds[2]!),
          after: { ...(await nameOf(topicIds[2]!)), title: "Proposed" }
        }
      ]
    });
    expect(proposal.kind).toBe("pending");
    const proposalId = (proposal as { changeSetId: string }).changeSetId;
    const rejected = await trees.recordRejectedChangeSet({
      treeId,
      origin: "rebuild",
      titleKey: "topics.changeSets.rebuild"
    });
    const prune = async (before: Date) => {
      let total = 0;
      for (let deleted = -1; deleted !== 0; total += deleted)
        deleted = await trees.pruneChangeSets({ before, limit: 2 });
      return total;
    };

    // Before U1: X waits for its undo, X2 goes (with the earlier renames of topic 0).
    await prune(await createdAt(u1));
    expect(await exists("topic_change_sets", x2)).toBe(false);
    expect(await exists("topic_change_sets", x)).toBe(true);
    // Past U1: X and its undo go together.
    await prune(new Date((await createdAt(u1)).getTime() + 1));
    expect(await exists("topic_change_sets", x)).toBe(false);
    expect(await exists("topic_change_sets", u1)).toBe(false);
    // Past everything: the newest of each origin stays (the build, U2, Z, N2), so Y stays with its undo;
    // the proposal, the rejected rebuild and the change-set that names a topic stay.
    await prune(new Date(Date.now() + 60_000));
    for (const id of [buildId, u2, y, z, n2, proposalId, rejected.changeSetId, named])
      expect(await exists("topic_change_sets", id), id).toBe(true);
    const events = await db().query(
      "select 1 from topic_structure_events where change_set_id = $1",
      [x]
    );
    expect(events.rowCount).toBe(0);
  });

  it("prunes finished relation passes, never one that waits, carries a verdict or is human", async () => {
    const old = await pass("link", [randomUUID()]);
    const pending = await pass("match", [randomUUID()], { pendingReview: true });
    const kept = await pass("match", [randomUUID()], { pendingReview: true });
    expect((await events().reviewRun(kept, "keep")).kind).toBe("kept");
    const dismissed = await pass("match", [null], { pendingReview: true });
    expect((await events().reviewRun(dismissed, "dismiss")).kind).toBe("dismissed");
    const human = await pass("review", [randomUUID()]);
    const open = await pass("link", [randomUUID()], { finish: false });
    expect(await changeSets().pendingCounts()).toMatchObject({ byKind: { relation: 1 } });
    let deleted = 0;
    for (let batch = -1; batch !== 0; deleted += batch)
      batch = await events().pruneRuns({ before: new Date(Date.now() + 60_000), limit: 3 });
    expect(deleted).toBeGreaterThan(0);
    expect(await exists("relation_match_runs", old)).toBe(false);
    for (const id of [pending, kept, dismissed, human, open])
      expect(await exists("relation_match_runs", id), id).toBe(true);
    expect(
      (await db().query("select 1 from relation_events where run_id = $1", [old])).rowCount
    ).toBe(0);
  });

  it("undoes an overview write exactly and prunes a write only with its undo", async () => {
    const overviews = createTopicOverviewRepository(db());
    const topicId = topicIds[0]!;
    const input = (text: string): SaveTopicOverviewInput => ({
      topicId,
      paragraphs: [{ text, citations: [1] }],
      evidence: [],
      memberFingerprint: `m-${text}`,
      memberCount: 1,
      inputHash: `i-${text}`,
      promptRevisionId: "p",
      provider: "test",
      model: "test",
      runtime: "none",
      aiTaskRunId: null,
      language: "en",
      support: { status: "verified", unsupported: [] },
      citations: [
        {
          n: 1,
          chunkId: randomUUID(),
          sourceSpanId: null,
          noteId: null,
          excerpt: text,
          excerptHash: "h"
        }
      ]
    });
    const first = await overviews.write(input("One."));
    expect(first).toMatchObject({ kind: "written", version: 1, changeSetId: null });
    const second = await overviews.write(input("Two."));
    const third = await overviews.write({ ...input("Three."), change: { origin: "patch" } });
    if (second.kind !== "written" || third.kind !== "written") throw new Error("not written");
    const restored = await overviews.undoVersion(third.changeSetId!);
    expect(restored).toMatchObject({ kind: "undone", version: 4 });
    const stored = (await overviews.readContext(topicId))!.stored!;
    expect(stored.paragraphs).toEqual([{ text: "Two.", citations: [1] }]);
    expect(stored.support).toEqual({ status: "verified", unsupported: [] });
    expect(stored.citations.map((citation) => citation.excerpt)).toEqual(["Two."]);
    // The undo itself is not undone; the undone write reads so; a second undo is refused.
    expect(await overviews.undoVersion(third.changeSetId!)).toEqual({
      kind: "blocked",
      code: "not_applied"
    });
    const undoId = (restored as { undoId: string }).undoId;
    expect(await overviews.undoVersion(undoId)).toEqual({ kind: "blocked", code: "not_undoable" });
    const proposal = await overviews.propose(input("Proposed."));
    expect(proposal.kind).toBe("proposed");

    // Before the undo: the patch waits for it; the first write's change-set (v1 -> v2) goes.
    for (let batch = -1; batch !== 0;)
      batch = await overviews.pruneVersions({ before: await createdAt(undoId), limit: 1 });
    expect(await exists("topic_overview_versions", second.changeSetId!)).toBe(false);
    expect(await exists("topic_overview_versions", third.changeSetId!)).toBe(true);
    for (let batch = -1; batch !== 0;)
      batch = await overviews.pruneVersions({ before: new Date(Date.now() + 60_000), limit: 1 });
    expect(await exists("topic_overview_versions", third.changeSetId!)).toBe(false);
    expect(await exists("topic_overview_versions", undoId)).toBe(false);
    expect(await exists("topic_overview_versions", (proposal as { id: string }).id)).toBe(true);
  });

  it("prunes succeeded and canceled jobs past the window, never a download, a failed job or the newest of a type", async () => {
    const jobs = createJobRepository(db());
    const make = async (
      type: string,
      status: "succeeded" | "canceled" | "failed",
      daysAgo: number
    ) => {
      const job = await jobs.create({ type, lane: "light" });
      await jobs.update(job.id, {
        status,
        finishedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
      });
      return job.id;
    };
    const old = await make("topic-place", "succeeded", 40);
    const canceled = await make("topic-audit", "canceled", 40);
    const download = await make("local-model-download", "succeeded", 400);
    const failed = await make("topic-place", "failed", 400);
    // The only Areas job: its outcome is what `latestByType` reads as final for the build.
    const settled = await make("topic-areas", "succeeded", 40);
    const recent = await make("topic-place", "succeeded", 1);
    const audit = await make("topic-audit", "succeeded", 1);
    const before = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let deleted = 0;
    for (let batch = -1; batch !== 0; deleted += batch)
      batch = await jobs.pruneFinished({ before, limit: 1 });
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await exists("jobs", old)).toBe(false);
    expect(await exists("jobs", canceled)).toBe(false);
    for (const id of [download, failed, settled, recent, audit])
      expect(await exists("jobs", id), id).toBe(true);
    expect((await jobs.latestByType("topic-areas"))?.id).toBe(settled);
  });
});
