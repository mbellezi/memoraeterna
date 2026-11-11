import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createAtomicNoteRelationRepository,
  createGardenerFindingRepository,
  createNoteMatchStateRepository,
  createPgPool,
  createRelationMatchRunRepository,
  createSourceItemRepository,
  createTopicOverviewRepository,
  createTopicTreeRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool,
  type SaveTopicOverviewInput
} from "@app/db";
import {
  InboxListSchema,
  inboxKinds,
  relationRoutingCases,
  type BudgetSnapshot,
  type InboxItem,
  type InboxKind
} from "@app/domain";
import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";

import type { AppEvent } from "../../../shared/app-events.js";
import { RelationMatchBacklog } from "../relations/relation-match-backlog.js";
import { RelationReviewService } from "../relation-review-service.js";
import { ChangesService } from "./changes-service.js";
import { InboxService, type InboxServiceOptions } from "./inbox-service.js";

// F4 D29 on a real PostgreSQL database: one ordered listing of what waits for the owner across
// the stores, its counts, and every verb carried out through the store's own writer.
const workspace = resolve(import.meta.dirname, "../../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const snapshot = (
  state: "open" | "paused" | "exhausted",
  options: { month?: string; continued?: boolean } = {}
): BudgetSnapshot => ({
  month: options.month ?? "2026-10",
  day: "2026-10-24",
  money: {
    spentUsd: state === "open" ? 1 : 4.123,
    reservedUsd: 0,
    capUsd: 5,
    pauseShare: 0.8,
    continued: options.continued ?? false,
    state,
    priceTableVersion: "test"
  },
  calls: { usedCalls: 0, reservedCalls: 0, capCalls: 800, state: "open" }
});

describe.skipIf(!sidecarInstalled)("the Inbox on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const published: AppEvent[] = [];
  const handlers = new Map<string, Array<(event: AppEvent) => void>>();
  const retryJob = vi.fn<(jobId: string) => Promise<unknown>>();
  const accept = vi.fn();
  const budget = {
    snapshot: vi.fn<() => Promise<BudgetSnapshot>>(),
    continue: vi.fn<() => Promise<BudgetSnapshot>>()
  };
  let conflicts: NonNullable<InboxServiceOptions["obsidianConflicts"]> = async () => [];
  const relationsChanged = vi.fn();

  const build = (overrides: Partial<InboxServiceOptions> = {}) =>
    new InboxService({
      getPool: () => pool ?? null,
      changes: new ChangesService({ getPool: () => pool ?? null, relationsChanged }),
      reviewRelation: (input) =>
        new RelationReviewService({ getPool: () => pool ?? null, relationsChanged }).review(input),
      matchBacklog: () => ({ accept }),
      retryJob,
      budget,
      obsidianConflicts: () => conflicts(),
      events: {
        publish: (event) => published.push(event),
        subscribe: (type, handler) => {
          const list = handlers.get(type) ?? [];
          list.push(handler as (event: AppEvent) => void);
          handlers.set(type, list);
          return () => undefined;
        }
      },
      refreshDelayMs: 5,
      ...overrides
    });
  let inbox = build();

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-inbox-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_inbox_test",
        user: "memora_inbox_test",
        password: `inbox-${randomUUID()}`,
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
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    inbox.dispose();
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const db = pool!;
    for (const table of [
      "topic_overview_versions",
      "topic_overviews",
      "relation_events",
      "relation_match_runs",
      "atomic_note_relations",
      "gardener_findings",
      "gardener_outcomes",
      "note_match_state",
      "jobs"
    ])
      await db.query(`delete from ${table}`);
    published.length = 0;
    handlers.clear();
    retryJob.mockReset();
    accept.mockReset();
    budget.snapshot.mockReset();
    budget.continue.mockReset();
    relationsChanged.mockReset();
    conflicts = async () => [];
    inbox.dispose();
    inbox = build();
  });

  /** A source with a chunk, and a note on it with current evidence. */
  const seedNote = async (title: string) => {
    const db = pool!;
    const sourceId = randomUUID(),
      documentId = randomUUID(),
      chunkId = randomUUID(),
      id = randomUUID();
    await db.query(`insert into source_items (id, type, title) values ($1, 'PersonalNote', $2)`, [
      sourceId,
      title
    ]);
    await db.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, $3, 'seed', $4)`,
      [documentId, sourceId, title, `hash-${documentId}`]
    );
    await db.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, $4, $5)`,
      [chunkId, documentId, sourceId, `${title} passage.`, `chunk-${chunkId}`]
    );
    await db.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
         supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key)
       values ($1, $2, $3, $4, 'pending_review', 'current', 'source', $5, $5, $6, 'seed', 'seed',
               'local', 'seed', $7)`,
      [id, title, `${title} body.`, `${title} idea.`, sourceId, chunkId, `key-${id}`]
    );
    return { id, sourceId };
  };

  /** A finished pass that suggested one typed relation; it waits for review when asked. */
  const seedPass = async (pendingReview: boolean) => {
    const notes = [await seedNote("Retrieval"), await seedNote("Feedback")].sort((a, b) =>
      a.id < b.id ? -1 : 1
    );
    const runs = createRelationMatchRunRepository(pool!);
    const run = await runs.start({ kind: "match", pendingReview });
    const written = await createAtomicNoteRelationRepository(pool!).upsert({
      loAtomicNoteId: notes[0]!.id,
      hiAtomicNoteId: notes[1]!.id,
      direction: "lo_to_hi",
      relationType: "supports",
      band: "suggest",
      probability: 0.6,
      finalScore: 0.6,
      explanation: "knowledge.relations.explanations.reranked",
      runId: run.id
    });
    await runs.finish(run.id, { outcome: "completed" });
    return { runId: run.id, relationId: written.relation.id, notes };
  };

  /** A suggested `contradicts` relation, or a withdrawn one when `vetoed`. */
  const seedRelation = async (kind: "contradicts" | "supports", vetoed = false) => {
    const notes = [await seedNote("Alpha"), await seedNote("Beta")].sort((a, b) =>
      a.id < b.id ? -1 : 1
    );
    const runs = createRelationMatchRunRepository(pool!);
    const run = await runs.start({ kind: "match" });
    const relations = createAtomicNoteRelationRepository(pool!);
    const written = await relations.upsert({
      loAtomicNoteId: notes[0]!.id,
      hiAtomicNoteId: notes[1]!.id,
      direction: kind === "contradicts" ? "symmetric" : "lo_to_hi",
      relationType: kind,
      band: "suggest",
      probability: 0.6,
      finalScore: 0.6,
      explanation: "knowledge.relations.explanations.reranked",
      runId: run.id
    });
    if (vetoed) await relations.veto(written.relation.id, "explainer", run.id);
    return { id: written.relation.id, notes };
  };

  /** A suggested relation of a stored type and probability (null: the decider wrote none). */
  const seedSuggestion = async (type: string, probability: number | null) => {
    const notes = [await seedNote("Gamma"), await seedNote("Delta")].sort((a, b) =>
      a.id < b.id ? -1 : 1
    );
    const run = await createRelationMatchRunRepository(pool!).start({ kind: "match" });
    const written = await createAtomicNoteRelationRepository(pool!).upsert({
      loAtomicNoteId: notes[0]!.id,
      hiAtomicNoteId: notes[1]!.id,
      direction: type === "contradicts" ? "symmetric" : "lo_to_hi",
      relationType: type,
      band: "suggest",
      probability,
      finalScore: probability ?? 0.5,
      explanation: "knowledge.relations.explanations.reranked",
      runId: run.id
    });
    return { id: written.relation.id, notes };
  };

  /** A subject that failed twice on one input: its job, and the outcome that quarantined it. */
  const seedQuarantine = async (subjectKey: string, minutesAgo = 10) => {
    const db = pool!;
    const jobId = randomUUID();
    await db.query(
      `insert into jobs (id, type, status, lane, payload, attempts, max_attempts, error, finished_at,
         subject_key)
       values ($1, 'topic-overview', 'failed', 'light', '{}'::jsonb, 6, 6, 'boom', now(), $2)`,
      [jobId, subjectKey]
    );
    await db.query(
      `insert into gardener_outcomes (kind, subject_key, last_outcome, failed_fingerprint,
         consecutive_failures, last_error_class, last_job_id, quarantined_at)
       values ('topic-overview', $1, 'failed', 'fp', 2, 'invalid_output', $2,
               now() - make_interval(mins => $3))`,
      [subjectKey, jobId, minutesAgo]
    );
    return { jobId, id: `topic-overview|${subjectKey}` };
  };

  const finding = (
    kind: "duplicate" | "backlog" | "budget",
    fingerprint: string,
    params: Record<string, string | number> = {},
    refs: string[] = [],
    risk: "low" | "medium" | "high" = "low"
  ) =>
    createGardenerFindingRepository(pool!).record([
      { kind, fingerprint, objectRefs: refs, params, risk }
    ]);

  const openFindingId = async (kind: string) =>
    (
      await pool!.query<{ id: string }>(
        "select id from gardener_findings where kind = $1 and status = 'open'",
        [kind]
      )
    ).rows[0]!.id;

  const idsOf = (items: readonly InboxItem[]) => items.map((item) => `${item.kind}:${item.id}`);

  it("lists nothing and counts zero for an empty library", async () => {
    expect(await inbox.list({})).toEqual({ items: [], nextCursor: null });
    const counts = await inbox.counts();
    expect(counts.total).toBe(0);
    expect(Object.keys(counts.byKind).sort()).toEqual([...inboxKinds].sort());
  });

  it("lists every kind by risk then age, names the objects by title and offers each kind's verbs", async () => {
    const pass = await seedPass(true);
    const contradiction = await seedRelation("contradicts");
    const withdrawn = await seedRelation("supports", true);
    const subject = await seedNote("Subject");
    const quarantine = await seedQuarantine(`note:${subject.id}`);
    const [noteA, noteB] = [await seedNote("Nap"), await seedNote("Sleep")];
    await finding("duplicate", "dup:1", { reason: "vector", cosine: 0.98 }, [
      `memora://note/${noteA.id}`,
      `memora://note/${noteB.id}`
    ]);
    await finding("backlog", "match:abc", { task: "match", reason: "decider_changed", notes: 12 });
    await finding(
      "budget",
      "money_100:2026-10",
      { month: "2026-10", spentUsd: 5, capUsd: 5 },
      [],
      "high"
    );
    conflicts = async () => [
      {
        id: randomUUID(),
        path: "Notes/a.md",
        variant: "editorial",
        at: new Date("2026-10-01T00:00:00Z")
      }
    ];

    const list = await inbox.list({});
    InboxListSchema.parse(list);
    expect(list.nextCursor).toBeNull();
    const byKind = new Map<InboxKind, InboxItem>(list.items.map((item) => [item.kind, item]));
    expect([...byKind.keys()].sort()).toEqual([...inboxKinds].sort());

    // High risk first (the budget), then medium by age, then low by age.
    expect(list.items[0]).toMatchObject({ kind: "budget", risk: "high", variant: "money_100" });
    const risks = list.items.map((item) => item.risk);
    expect(risks).toEqual(
      [...risks].sort((a, b) => "high medium low".indexOf(a) - "high medium low".indexOf(b))
    );

    expect(byKind.get("review")).toMatchObject({
      id: `relation:${pass.runId}`,
      variant: "relation",
      actions: ["apply", "dismiss"],
      changeSet: { kind: "relation", status: "pending_review" }
    });
    expect(byKind.get("contradiction")).toMatchObject({
      id: contradiction.id,
      variant: "relation",
      params: { relationType: "contradicts" },
      actions: ["apply", "dismiss"]
    });
    expect(
      byKind
        .get("contradiction")!
        .objects.map((object) => object.title)
        .sort()
    ).toEqual(["Alpha", "Beta"]);
    expect(byKind.get("withdrawn")).toMatchObject({
      id: withdrawn.id,
      variant: "explainer",
      actions: ["apply", "dismiss"]
    });
    expect(byKind.get("quarantined")).toMatchObject({
      id: quarantine.id,
      variant: "refresh",
      params: { errorClass: "invalid_output", failures: 2 },
      actions: ["retry", "dismiss"],
      objects: [{ kind: "note", id: subject.id, title: "Subject" }]
    });
    expect(byKind.get("duplicate")).toMatchObject({
      variant: "vector",
      params: { cosine: 0.98 },
      actions: ["dismiss"]
    });
    expect(byKind.get("duplicate")!.objects.map((object) => object.title)).toEqual([
      "Nap",
      "Sleep"
    ]);
    expect(byKind.get("backlog")).toMatchObject({
      variant: "match",
      params: { notes: 12 },
      actions: ["apply", "dismiss"]
    });
    expect(byKind.get("obsidian_conflict")).toMatchObject({
      variant: "editorial",
      params: { path: "Notes/a.md" },
      actions: []
    });

    const counts = await inbox.counts();
    expect(counts.total).toBe(list.items.length);
    expect(counts.byKind).toMatchObject(Object.fromEntries(inboxKinds.map((kind) => [kind, 1])));
    // The pass's suggested relation (0.6, below "high") is its own item (D33).
    expect(byKind.get("suggestion")).toMatchObject({
      id: pass.relationId,
      risk: "medium",
      variant: "relation",
      params: { relationType: "supports", probability: 0.6 },
      actions: ["apply", "dismiss"]
    });
    expect(
      byKind
        .get("suggestion")!
        .objects.map((object) => object.title)
        .sort()
    ).toEqual(["Feedback", "Retrieval"]);
    expect(counts.byRisk).toEqual({
      high: list.items.filter((item) => item.risk === "high").length,
      medium: list.items.filter((item) => item.risk === "medium").length,
      low: list.items.filter((item) => item.risk === "low").length
    });
  });

  it("routes a suggested relation by the one rule of routesToInbox, and counts what it lists (D33)", async () => {
    const expectedIds: string[] = [];
    const contradictionIds: string[] = [];
    const notListed: string[] = [];
    for (const row of relationRoutingCases) {
      const seeded = await seedSuggestion(row.stance, row.probability);
      if (!row.routes) notListed.push(seeded.id);
      else if (row.stance === "contradicts") contradictionIds.push(seeded.id);
      else expectedIds.push(seeded.id);
    }
    const list = await inbox.list({});
    const listed = (kind: InboxKind) =>
      list.items.filter((item) => item.kind === kind).map((item) => item.id);
    expect(listed("suggestion").sort()).toEqual([...expectedIds].sort());
    // A suggested contradicts is listed once, under its own kind, at any confidence.
    expect(listed("contradiction").sort()).toEqual([...contradictionIds].sort());
    for (const id of notListed) expect(list.items.map((item) => item.id)).not.toContain(id);
    const counts = await inbox.counts();
    expect(counts.byKind.suggestion).toBe(expectedIds.length);
    expect(counts.byKind.contradiction).toBe(contradictionIds.length);
    expect(counts.total).toBe(expectedIds.length + contradictionIds.length);
    // The kind filter reads the arm alone.
    const only = await inbox.list({ kinds: ["suggestion"] });
    expect(only.items.map((item) => item.id).sort()).toEqual([...expectedIds].sort());
  });

  it("words a suggestion with the probability stored, and null when the decider wrote none", async () => {
    const medium = await seedSuggestion("supports", 0.64);
    const unknown = await seedSuggestion("extends", null);
    const items = (await inbox.list({ kinds: ["suggestion"] })).items;
    expect(items.find((item) => item.id === medium.id)?.params).toEqual({
      relationType: "supports",
      probability: 0.64
    });
    expect(items.find((item) => item.id === unknown.id)?.params).toEqual({
      relationType: "extends",
      probability: null
    });
  });

  it("lists no suggestion that was withdrawn, rejected or accepted", async () => {
    const withdrawn = await seedRelation("supports", true);
    const rejected = await seedSuggestion("supports", 0.64);
    const accepted = await seedSuggestion("supports", 0.64);
    await pool!.query("update atomic_note_relations set status = 'rejected' where id = $1", [
      rejected.id
    ]);
    await pool!.query("update atomic_note_relations set status = 'accepted' where id = $1", [
      accepted.id
    ]);
    const list = await inbox.list({ kinds: ["suggestion"] });
    expect(list.items).toEqual([]);
    expect((await inbox.counts()).byKind.suggestion).toBe(0);
    // The withdrawn one is the withdrawn kind's, never a suggestion.
    expect(idsOf((await inbox.list({ kinds: ["withdrawn"] })).items)).toEqual([
      `withdrawn:${withdrawn.id}`
    ]);
  });

  it("keeps or removes a suggestion through the review writer, and it leaves the Inbox", async () => {
    const keep = await seedSuggestion("supports", 0.64);
    const remove = await seedSuggestion("supports", null);
    expect(await inbox.act({ kind: "suggestion", id: keep.id, action: "apply" })).toEqual({
      status: "done",
      undoable: false
    });
    expect(await inbox.act({ kind: "suggestion", id: remove.id, action: "dismiss" })).toEqual({
      status: "done",
      undoable: false
    });
    expect((await inbox.list({})).items).toEqual([]);
    const status = async (id: string) =>
      (
        await pool!.query<{ status: string; vetoed: boolean }>(
          "select status::text as status, vetoed_at is not null as vetoed from atomic_note_relations where id = $1",
          [id]
        )
      ).rows[0]!;
    // Kept is a human verdict; removed is the rejected status, never the withdrawn state.
    expect(await status(keep.id)).toEqual({ status: "accepted", vetoed: false });
    expect(await status(remove.id)).toEqual({ status: "rejected", vetoed: false });
    expect(await inbox.act({ kind: "suggestion", id: keep.id, action: "dismiss" })).toEqual({
      status: "stale"
    });
    expect(await inbox.act({ kind: "suggestion", id: randomUUID(), action: "apply" })).toEqual({
      status: "gone"
    });
    await expect(
      inbox.act({ kind: "suggestion", id: "not-a-uuid", action: "apply" })
    ).rejects.toThrow("inbox.errors.invalidItem");
  });

  it("pages by risk and age with a cursor that never repeats or skips an item, vault conflicts included", async () => {
    for (let n = 0; n < 4; n += 1) await finding("duplicate", `dup:${n}`, { reason: "title" });
    for (let n = 0; n < 3; n += 1) await seedQuarantine(`note:${randomUUID()}`, 30 - n);
    const vault = [1, 2].map((n) => ({
      id: randomUUID(),
      path: `Notes/${n}.md`,
      variant: "editorial" as const,
      at: new Date(Date.UTC(2026, 9, 1, 0, n))
    }));
    conflicts = async () => vault;
    const all = await inbox.list({ limit: 50 });
    expect(all.items).toHaveLength(9);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await inbox.list({ limit: 2, ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...idsOf(page.items));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(5);
    expect(seen).toEqual(idsOf(all.items));
    expect(new Set(seen).size).toBe(9);
  });

  it("filters by kinds and by risk, and refuses a cursor it cannot read", async () => {
    await seedQuarantine(`note:${randomUUID()}`);
    await finding("duplicate", "dup:1", { reason: "title" });
    await finding("budget", "money_100:2026-10", {}, [], "high");
    conflicts = async () => [{ id: randomUUID(), path: "a.md", variant: "deleted", at: null }];

    expect((await inbox.list({ kinds: ["duplicate"] })).items.map((item) => item.kind)).toEqual([
      "duplicate"
    ]);
    expect(
      (await inbox.list({ kinds: ["obsidian_conflict"] })).items.map((item) => item.variant)
    ).toEqual(["deleted"]);
    expect((await inbox.list({ risk: "high" })).items.map((item) => item.kind)).toEqual(["budget"]);
    expect((await inbox.list({ risk: "medium" })).items.map((item) => item.kind).sort()).toEqual([
      "obsidian_conflict",
      "quarantined"
    ]);
    await expect(inbox.list({ cursor: "not a cursor" })).rejects.toThrow(
      "inbox.errors.invalidCursor"
    );
  });

  it("applies and dismisses a change-set that waits, through the changes writer", async () => {
    const kept = await seedPass(true);
    const dropped = await seedPass(true);
    expect(
      await inbox.act({ kind: "review", id: `relation:${kept.runId}`, action: "apply" })
    ).toEqual({
      status: "done",
      undoable: true
    });
    expect(
      await inbox.act({ kind: "review", id: `relation:${dropped.runId}`, action: "dismiss" })
    ).toEqual({
      status: "done",
      undoable: false
    });
    // Both left the review list, and the dismissed pass is reverted: its relation is gone. The kept
    // pass's relation is still a suggestion at 0.6, which D33 keeps in the Inbox.
    expect(idsOf((await inbox.list({})).items)).toEqual([`suggestion:${kept.relationId}`]);
    expect(
      (await pool!.query("select 1 from atomic_note_relations where id = $1", [dropped.relationId]))
        .rowCount
    ).toBe(0);
    // A second request for a verdict that stands is the item gone, not a second write.
    expect(
      await inbox.act({ kind: "review", id: `relation:${kept.runId}`, action: "apply" })
    ).toEqual({
      status: "done",
      undoable: true
    });
    // The other verdict on one that stands is not carried out, and never reads as done.
    expect(
      await inbox.act({ kind: "review", id: `relation:${kept.runId}`, action: "dismiss" })
    ).toEqual({ status: "stale" });
    expect(
      await inbox.act({ kind: "review", id: `relation:${dropped.runId}`, action: "apply" })
    ).toEqual({ status: "stale" });
    expect(
      await inbox.act({ kind: "review", id: `relation:${randomUUID()}`, action: "apply" })
    ).toEqual({ status: "gone" });
  });

  it("takes an applied change-set back", async () => {
    const pass = await seedPass(true);
    await inbox.act({ kind: "review", id: `relation:${pass.runId}`, action: "apply" });
    expect(
      await inbox.act({ kind: "review", id: `relation:${pass.runId}`, action: "undo" })
    ).toEqual({
      status: "done",
      undoable: false
    });
    expect(
      (await pool!.query("select 1 from atomic_note_relations where id = $1", [pass.relationId]))
        .rowCount
    ).toBe(0);
  });

  it("keeps or removes a suggested contradiction and a withdrawn relation, final in both directions", async () => {
    const contradiction = await seedRelation("contradicts");
    const withdrawn = await seedRelation("supports", true);
    expect(
      await inbox.act({ kind: "contradiction", id: contradiction.id, action: "apply" })
    ).toEqual({
      status: "done",
      undoable: false
    });
    expect(await inbox.act({ kind: "withdrawn", id: withdrawn.id, action: "dismiss" })).toEqual({
      status: "done",
      undoable: false
    });
    expect((await inbox.list({})).items).toEqual([]);
    const status = async (id: string) =>
      (
        await pool!.query<{ status: string }>(
          "select status::text as status from atomic_note_relations where id = $1",
          [id]
        )
      ).rows[0]!.status;
    expect(await status(contradiction.id)).toBe("accepted");
    expect(await status(withdrawn.id)).toBe("rejected");
    // A verdict that already stands is never overwritten: the other one answers stale.
    expect(
      await inbox.act({ kind: "contradiction", id: contradiction.id, action: "dismiss" })
    ).toEqual({
      status: "stale"
    });
    expect(await inbox.act({ kind: "withdrawn", id: randomUUID(), action: "apply" })).toEqual({
      status: "gone"
    });
    expect(relationsChanged).toHaveBeenCalled();
  });

  it("retries a quarantined subject through the supervisor's retry, and dismisses it until it quarantines again", async () => {
    const one = await seedQuarantine(`note:${randomUUID()}`);
    const two = await seedQuarantine(`note:${randomUUID()}`);
    retryJob.mockResolvedValue({ id: one.jobId });
    expect(await inbox.act({ kind: "quarantined", id: one.id, action: "retry" })).toEqual({
      status: "done",
      undoable: false
    });
    expect(retryJob).toHaveBeenCalledWith(one.jobId);

    expect(await inbox.act({ kind: "quarantined", id: two.id, action: "dismiss" })).toEqual({
      status: "done",
      undoable: true
    });
    // The dismissed item is not listed or counted; the retried one stays until the job runs.
    expect(idsOf((await inbox.list({ kinds: ["quarantined"] })).items)).toEqual([
      `quarantined:${one.id}`
    ]);
    expect((await inbox.counts()).byKind.quarantined).toBe(1);

    expect(await inbox.act({ kind: "quarantined", id: two.id, action: "undo" })).toEqual({
      status: "done",
      undoable: false
    });
    expect((await inbox.counts()).byKind.quarantined).toBe(2);

    // A newer quarantine of a dismissed subject is a new item.
    await inbox.act({ kind: "quarantined", id: two.id, action: "dismiss" });
    await pool!.query(
      "update gardener_outcomes set quarantined_at = now() + interval '1 minute' where subject_key = $1",
      [two.id.split("|")[1]]
    );
    expect((await inbox.counts()).byKind.quarantined).toBe(2);

    // A subject whose job is gone offers no Retry that cannot run, and has no place for the
    // stamp: the mark is released.
    const orphan = await seedQuarantine(`note:${randomUUID()}`);
    await pool!.query("delete from jobs where id = $1", [orphan.jobId]);
    const listed = (await inbox.list({ kinds: ["quarantined"] })).items.find(
      (entry) => entry.id === orphan.id
    );
    expect(listed?.actions).toEqual(["dismiss"]);
    expect(await inbox.act({ kind: "quarantined", id: orphan.id, action: "dismiss" })).toEqual({
      status: "done",
      undoable: false
    });
    expect(
      await inbox
        .act({ kind: "quarantined", id: "not-an-id", action: "retry" })
        .catch((error: Error) => error.message)
    ).toBe("inbox.errors.invalidItem");
  });

  /** Two live topics, "Sleep" and "Memory", of the one active tree (built on first use). */
  let topicIds: { sleep: string; memory: string } | null = null;
  const seedTopics = async () => {
    if (topicIds) return topicIds;
    const trees = createTopicTreeRepository(pool!);
    const rootId = randomUUID();
    const ids = { sleep: randomUUID(), memory: randomUUID() };
    const tree = await trees.createTree({
      id: randomUUID(),
      rootId,
      spaceKey: "test:inbox:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config: {},
      configHash: "test",
      seed: 1
    });
    const sources = createSourceItemRepository(pool!);
    const placed = [
      await sources.create({ type: "Book", title: "Sleep" }),
      await sources.create({ type: "Book", title: "Memory" })
    ];
    await trees.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: (["sleep", "memory"] as const).map((name) =>
        topicRecord(ids[name], rootId, {
          role: "topic",
          title: name === "sleep" ? "Sleep" : "Memory",
          nameState: "provisional",
          nameSource: "tfidf",
          nameLanguage: "en"
        })
      ),
      placements: [
        { item: itemKey("source", placed[0]!.id), placement: placementRecord(ids.sleep) },
        { item: itemKey("source", placed[1]!.id), placement: placementRecord(ids.memory) }
      ]
    });
    topicIds = ids;
    return ids;
  };

  /** An overview of the topic with the given paragraphs and the Divergences kept beside them. */
  const overview = (
    topicId: string,
    paragraphs: string[],
    divergences: SaveTopicOverviewInput["divergences"] = []
  ): SaveTopicOverviewInput => ({
    topicId,
    paragraphs: paragraphs.map((text) => ({ text, citations: [] })),
    evidence: [],
    memberFingerprint: `m-${paragraphs.length}`,
    memberCount: 1,
    inputHash: `i-${paragraphs.join("|")}`,
    promptRevisionId: "p",
    provider: "test",
    model: "test",
    runtime: "none",
    aiTaskRunId: null,
    language: "en",
    support: { status: "unchecked", unsupported: [] },
    divergences,
    citations: []
  });

  it("lists the Divergences an automatic overview patch kept as a high-risk contradiction, with its change-set (D17)", async () => {
    const topicId = (await seedTopics()).sleep;
    const overviews = createTopicOverviewRepository(pool!);
    // The first write has nothing to disagree with; the patch keeps two Divergences beside it.
    await overviews.write(overview(topicId, ["Naps help."]));
    const patched = await overviews.write(
      overview(
        topicId,
        ["Naps help.", "Long naps can hurt."],
        [
          { existing: "1", new: "2", summary: "Long naps can leave a person groggy." },
          { existing: "1", new: "3", summary: "Some sleepers lose the night after a nap." }
        ]
      )
    );
    if (patched.kind !== "written" || !patched.changeSetId) throw new Error("not written");
    // The owner's apply of a proposal they read is not sent to the Inbox again.
    const proposal = await overviews.propose(
      overview(
        topicId,
        ["Naps help.", "Long naps can hurt.", "Short ones do not."],
        [
          { existing: "1", new: "2", summary: "Long naps can leave a person groggy." },
          { existing: "1", new: "3", summary: "Some sleepers lose the night after a nap." },
          { existing: "2", new: "4", summary: "Twenty minutes is enough." }
        ]
      )
    );
    if (proposal.kind !== "proposed") throw new Error("not proposed");

    const counts = await inbox.counts();
    expect(counts.byKind.contradiction).toBe(1);
    expect(counts.byKind.review).toBe(1);
    expect(counts.byRisk.high).toBe(1);
    const listed = (await inbox.list({ kinds: ["contradiction"] })).items;
    expect(listed).toHaveLength(1);
    const item = listed[0]!;
    expect(item).toMatchObject({
      kind: "contradiction",
      risk: "high",
      variant: "divergence",
      params: { divergences: 2 },
      objects: [{ kind: "topic", id: topicId, title: "Sleep" }],
      actions: ["apply", "dismiss"]
    });
    expect(item.id).toMatch(/^divergence:/u);
    expect(item.changeSet).toMatchObject({
      kind: "overview",
      id: patched.changeSetId,
      status: "applied"
    });
    // The Divergences are listed first: high risk.
    expect((await inbox.list({})).items[0]).toMatchObject({ kind: "contradiction", id: item.id });

    // Dismissing it can be taken back; keeping it beside the text is the last word.
    expect(await inbox.act({ kind: "contradiction", id: item.id, action: "dismiss" })).toEqual({
      status: "done",
      undoable: true
    });
    expect((await inbox.counts()).byKind.contradiction).toBe(0);
    expect(await inbox.act({ kind: "contradiction", id: item.id, action: "undo" })).toEqual({
      status: "done",
      undoable: false
    });
    expect(await inbox.act({ kind: "contradiction", id: item.id, action: "apply" })).toEqual({
      status: "done",
      undoable: false
    });
    expect(await inbox.act({ kind: "contradiction", id: item.id, action: "apply" })).toEqual({
      status: "gone"
    });
    const stored = await pool!.query<{ status: string }>(
      "select status from gardener_findings where kind = 'divergence'"
    );
    expect(stored.rows.map((row) => row.status)).toEqual(["resolved"]);
    // Either verdict leaves the overview as it was.
    expect((await overviews.readContext(topicId))?.stored?.divergences).toHaveLength(2);
    // An ID that names no Divergence and no relation is refused.
    await expect(
      inbox.act({ kind: "contradiction", id: "divergence:not-a-uuid", action: "apply" })
    ).rejects.toThrow("inbox.errors.invalidItem");
  });

  it("closes a Divergence's item when the patch that kept it is undone", async () => {
    const topicId = (await seedTopics()).memory;
    const overviews = createTopicOverviewRepository(pool!);
    await overviews.write(overview(topicId, ["Spacing helps."]));
    const patched = await overviews.write(
      overview(
        topicId,
        ["Spacing helps.", "Cramming works for a day."],
        [{ existing: "1", new: "2", summary: "Cramming helps the next day only." }]
      )
    );
    if (patched.kind !== "written" || !patched.changeSetId) throw new Error("not written");
    expect((await inbox.counts()).byKind.contradiction).toBe(1);
    const undone = await overviews.undoVersion(patched.changeSetId);
    expect(undone.kind).toBe("undone");
    expect((await inbox.counts()).byKind.contradiction).toBe(0);
    // A patch that adds no Divergence sends nothing.
    await overviews.write(overview(topicId, ["Spacing helps.", "Sleep consolidates."]));
    expect((await inbox.counts()).byKind.contradiction).toBe(0);
  });

  it("dismisses a finding for good and takes the dismissal back", async () => {
    await finding("duplicate", "dup:1", { reason: "title" });
    const id = await openFindingId("duplicate");
    expect(await inbox.act({ kind: "duplicate", id, action: "dismiss" })).toEqual({
      status: "done",
      undoable: true
    });
    expect((await inbox.counts()).byKind.duplicate).toBe(0);
    // AUDIT finding it again leaves it dismissed.
    await finding("duplicate", "dup:1", { reason: "title" });
    expect((await inbox.counts()).byKind.duplicate).toBe(0);
    expect(await inbox.act({ kind: "duplicate", id, action: "dismiss" })).toEqual({
      status: "gone"
    });
    expect(await inbox.act({ kind: "duplicate", id, action: "undo" })).toEqual({
      status: "done",
      undoable: false
    });
    expect((await inbox.counts()).byKind.duplicate).toBe(1);
    // A finding is only reachable through its own kind.
    expect(await inbox.act({ kind: "backlog", id, action: "dismiss" })).toEqual({ status: "gone" });
    expect(await inbox.act({ kind: "duplicate", id, action: "apply" })).toEqual({
      status: "unsupported"
    });
  });

  it("accepts the MATCH backlog through its service and maps what it answers", async () => {
    await finding("backlog", "match:abc", { task: "match", reason: "decider_changed", notes: 3 });
    await finding("backlog", "other:1", { task: "audit" });
    const matchId = (
      await pool!.query<{ id: string }>(
        "select id from gardener_findings where fingerprint = 'match:abc'"
      )
    ).rows[0]!.id;
    const otherId = (
      await pool!.query<{ id: string }>(
        "select id from gardener_findings where fingerprint = 'other:1'"
      )
    ).rows[0]!.id;
    accept.mockResolvedValueOnce({ status: "queued", queued: 3 });
    expect(await inbox.act({ kind: "backlog", id: matchId, action: "apply" })).toEqual({
      status: "done",
      undoable: false,
      queued: 3
    });
    expect(accept).toHaveBeenCalledWith(matchId);
    for (const [answer, status] of [
      [{ status: "waiting" }, "waiting"],
      [{ status: "stale" }, "stale"],
      [{ status: "closed" }, "gone"]
    ] as const) {
      accept.mockResolvedValueOnce(answer);
      expect(await inbox.act({ kind: "backlog", id: matchId, action: "apply" })).toEqual({
        status
      });
    }
    // Only the MATCH backlog is accepted by this writer.
    expect(await inbox.act({ kind: "backlog", id: otherId, action: "apply" })).toEqual({
      status: "unsupported"
    });
  });

  it("takes the MATCH backlog from its offer to its acceptance, through the real backlog service", async () => {
    const wake = vi.fn();
    const backlog = new RelationMatchBacklog({
      getPool: () => pool!,
      deciderKey: async () => "decider-new",
      spaceKey: async () => "space-1",
      wake
    });
    const matched = [await seedNote("First"), await seedNote("Second")];
    for (const note of matched)
      await createNoteMatchStateRepository(pool!).record({
        noteId: note.id,
        deciderKey: "decider-old",
        spaceKey: "space-1",
        kthCosine: null
      });
    inbox.dispose();
    inbox = build({ matchBacklog: () => backlog });

    expect(await backlog.offer()).toMatchObject({ status: "offered", notes: 2 });
    const [offered] = (await inbox.list({ kinds: ["backlog"] })).items;
    expect(offered).toMatchObject({
      variant: "match",
      params: { notes: 2 },
      actions: ["apply", "dismiss"]
    });

    expect(await inbox.act({ kind: "backlog", id: offered!.id, action: "apply" })).toEqual({
      status: "done",
      undoable: false,
      queued: 2
    });
    expect(wake).toHaveBeenCalled();
    const queued = await pool!.query<{ type: string }>(
      "select type from jobs where type = 'relation-match'"
    );
    expect(queued.rows).toHaveLength(2);
    // Accepted: the item left the Inbox for good, and the same decider is not offered again.
    expect((await inbox.counts()).byKind.backlog).toBe(0);
    expect(await backlog.offer()).toMatchObject({ status: "closed" });
    expect(await inbox.act({ kind: "backlog", id: offered!.id, action: "apply" })).toEqual({
      status: "gone"
    });
  });

  it("posts the MATCH offer of a decider that changed while the app ran when the Inbox opens", async () => {
    const backlog = new RelationMatchBacklog({
      getPool: () => pool!,
      deciderKey: async () => "decider-new",
      spaceKey: async () => "space-1"
    });
    const note = await seedNote("Matched long ago");
    await createNoteMatchStateRepository(pool!).record({
      noteId: note.id,
      deciderKey: "decider-old",
      spaceKey: "space-1",
      kthCosine: null
    });
    inbox.dispose();
    inbox = build({ matchBacklog: () => backlog });
    expect((await inbox.counts()).byKind.backlog).toBe(0);

    const opened = await inbox.list({});
    expect(opened.items.map((entry) => entry.kind)).toEqual(["backlog"]);
    expect(opened.items[0]).toMatchObject({ variant: "match", params: { notes: 1 } });
    // The new offer reached the badge without waiting for an event.
    await vi.waitFor(() =>
      expect(published.at(-1)).toMatchObject({ type: "inbox.changed", total: 1 })
    );
  });

  it("reads for Home without offering the MATCH backlog, writing, or scanning the vault twice", async () => {
    const backlog = new RelationMatchBacklog({
      getPool: () => pool!,
      deciderKey: async () => "decider-new",
      spaceKey: async () => "space-1"
    });
    const note = await seedNote("Matched long ago");
    await createNoteMatchStateRepository(pool!).record({
      noteId: note.id,
      deciderKey: "decider-old",
      spaceKey: "space-1",
      kthCosine: null
    });
    const scans = vi.fn(async () => [] as Awaited<ReturnType<typeof conflicts>>);
    const before = await pool!.query<{ n: number }>(
      "select count(*)::int as n from gardener_findings"
    );
    const publishedBefore = published.length;
    inbox.dispose();
    inbox = build({ matchBacklog: () => backlog, obsidianConflicts: scans });

    const opened = await inbox.list({ limit: 3 }, { offer: false });
    const counts = await inbox.counts({ cached: true });

    expect(opened.items).toEqual([]);
    expect(counts.total).toBe(0);
    expect(scans).toHaveBeenCalledTimes(1);
    const after = await pool!.query<{ n: number }>(
      "select count(*)::int as n from gardener_findings"
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(published.length).toBe(publishedBefore);
    // The Inbox itself still offers it when it opens.
    expect((await inbox.list({})).items.map((entry) => entry.kind)).toEqual(["backlog"]);
  });

  it("asks the MATCH backlog at most once a minute, only for the first page that can hold it", async () => {
    let clock = 1_000_000;
    const offer = vi.fn<() => Promise<unknown>>(async () => ({ status: "none", notes: 0 }));
    inbox.dispose();
    inbox = build({ matchBacklog: () => ({ accept, offer }), now: () => clock });
    await inbox.list({});
    await inbox.list({});
    expect(offer).toHaveBeenCalledTimes(1);
    clock += 61_000;
    await inbox.list({ kinds: ["duplicate"] });
    expect(offer).toHaveBeenCalledTimes(1);
    await inbox.list({ kinds: ["backlog"] });
    expect(offer).toHaveBeenCalledTimes(2);
    clock += 61_000;
    await finding("duplicate", "dup:1", { reason: "title" });
    await finding("duplicate", "dup:2", { reason: "title" });
    const first = await inbox.list({ limit: 1 });
    expect(offer).toHaveBeenCalledTimes(3);
    clock += 61_000;
    await inbox.list({ limit: 1, cursor: first.nextCursor! });
    expect(offer).toHaveBeenCalledTimes(3);
  });

  it("lists the Inbox even when the MATCH backlog cannot be offered", async () => {
    const warn = vi.fn();
    inbox.dispose();
    inbox = build({
      matchBacklog: () => ({
        accept,
        offer: async () => {
          throw new Error("no decider");
        }
      }),
      logger: { warn }
    });
    await finding("duplicate", "dup:1", { reason: "title" });
    expect((await inbox.list({})).items).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  it("keeps a dismissed MATCH offer dismissed, and moves a stale one out of the way", async () => {
    let decider = "decider-new";
    const backlog = new RelationMatchBacklog({
      getPool: () => pool!,
      deciderKey: async () => decider,
      spaceKey: async () => "space-1"
    });
    const note = await seedNote("Only");
    await createNoteMatchStateRepository(pool!).record({
      noteId: note.id,
      deciderKey: "decider-old",
      spaceKey: "space-1",
      kthCosine: null
    });
    inbox.dispose();
    inbox = build({ matchBacklog: () => backlog });

    await backlog.offer();
    const [offered] = (await inbox.list({ kinds: ["backlog"] })).items;
    expect(await inbox.act({ kind: "backlog", id: offered!.id, action: "dismiss" })).toEqual({
      status: "done",
      undoable: true
    });
    expect(await backlog.offer()).toMatchObject({ status: "closed" });
    expect((await inbox.counts()).byKind.backlog).toBe(0);

    // The owner takes the dismissal back; the decider changed since, so the old offer is stale.
    await inbox.act({ kind: "backlog", id: offered!.id, action: "undo" });
    decider = "decider-newer";
    expect(await inbox.act({ kind: "backlog", id: offered!.id, action: "apply" })).toEqual({
      status: "stale"
    });
    expect((await inbox.counts()).byKind.backlog).toBe(0);
  });

  it("keeps the budget's items in step with its meters and continues past the pause share", async () => {
    await inbox.syncBudget(snapshot("paused"));
    const items = (await inbox.list({ kinds: ["budget"] })).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      variant: "money_80",
      risk: "medium",
      params: { month: "2026-10", spentUsd: 4.12, capUsd: 5 },
      actions: ["apply", "dismiss"]
    });

    budget.continue.mockResolvedValueOnce(snapshot("open", { continued: true }));
    expect(await inbox.act({ kind: "budget", id: items[0]!.id, action: "apply" })).toEqual({
      status: "done",
      undoable: false
    });
    expect((await inbox.counts()).byKind.budget).toBe(0);

    // Used up: a high-risk item that can only be dismissed; the 80% item of the month is closed.
    await inbox.syncBudget(snapshot("paused"));
    await inbox.syncBudget(snapshot("exhausted"));
    const exhausted = (await inbox.list({ kinds: ["budget"] })).items;
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toMatchObject({
      variant: "money_100",
      risk: "high",
      actions: ["dismiss"]
    });
    expect(await inbox.act({ kind: "budget", id: exhausted[0]!.id, action: "apply" })).toEqual({
      status: "unsupported"
    });

    // A dismissal holds while the month stays used up, and the cap rising closes the rest.
    await inbox.act({ kind: "budget", id: exhausted[0]!.id, action: "dismiss" });
    await inbox.syncBudget(snapshot("exhausted"));
    expect((await inbox.counts()).byKind.budget).toBe(0);
    await inbox.syncBudget(snapshot("open"));
    expect((await inbox.counts()).byKind.budget).toBe(0);

    // The pause still holding after a continue answers waiting.
    await inbox.syncBudget(snapshot("paused", { month: "2026-11" }));
    const next = (await inbox.list({ kinds: ["budget"] })).items[0]!;
    budget.continue.mockResolvedValueOnce(snapshot("paused", { month: "2026-11" }));
    expect(await inbox.act({ kind: "budget", id: next.id, action: "apply" })).toEqual({
      status: "waiting"
    });
  });

  it("dates a vault conflict by its stored row, else by when it was first listed", async () => {
    let clock = Date.parse("2026-10-24T08:00:00.000Z");
    inbox.dispose();
    inbox = build({ now: () => clock });
    const revision = randomUUID();
    await pool!.query(
      `insert into obsidian_projection_revisions (id, memora_id, revision_id, binding_hash,
         relative_path, content, editable_hash, generated_hash, rendered_hash, status, created_at)
       values ($1, $2, 'r1', 'b', 'Topic.md', '', 'e', 'g', 'r', 'conflict',
               '2026-10-20T10:00:00.123456Z')`,
      [revision, randomUUID()]
    );
    const unknown = randomUUID();
    conflicts = async () => [
      { id: revision, path: "Topic.md", variant: "projection", at: null },
      { id: unknown, path: "Note.md", variant: "editorial", at: null }
    ];
    const first = (await inbox.list({ kinds: ["obsidian_conflict"] })).items;
    expect(first.map((entry) => [entry.id, entry.at])).toEqual([
      [`projection:${revision}`, "2026-10-20T10:00:00.123000Z"],
      [`editorial:${unknown}`, "2026-10-24T08:00:00.000000Z"]
    ]);
    // Read again later: the one without a stored time keeps its first time and its place.
    clock += 3_600_000;
    const again = (await inbox.list({ kinds: ["obsidian_conflict"] })).items;
    expect(again.map((entry) => entry.at)).toEqual(first.map((entry) => entry.at));
  });

  it("offers no verb on an Obsidian conflict", async () => {
    expect(
      await inbox.act({
        kind: "obsidian_conflict",
        id: `editorial:${randomUUID()}`,
        action: "apply"
      })
    ).toEqual({ status: "unsupported" });
  });

  it("publishes the counts when they change, once for a burst of events", async () => {
    budget.snapshot.mockResolvedValue(snapshot("open"));
    inbox.start();
    await vi.waitFor(() =>
      expect(published.filter((event) => event.type === "inbox.changed")).toHaveLength(1)
    );
    expect(published.at(-1)).toMatchObject({ type: "inbox.changed", total: 0 });
    await finding("duplicate", "dup:1", { reason: "title" });
    for (const handler of handlers.get("job.progress") ?? []) {
      handler({ type: "job.progress" } as AppEvent);
      handler({ type: "job.progress" } as AppEvent);
    }
    await vi.waitFor(() =>
      expect(published.filter((event) => event.type === "inbox.changed")).toHaveLength(2)
    );
    expect(published.at(-1)).toMatchObject({ type: "inbox.changed", total: 1 });
    // Nothing changed: nothing is published.
    for (const handler of handlers.get("changes.changed") ?? [])
      handler({ type: "changes.changed" } as AppEvent);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(published.filter((event) => event.type === "inbox.changed")).toHaveLength(2);
  });

  it("lists the rest of the Inbox when the vault cannot be read", async () => {
    const warn = vi.fn();
    inbox.dispose();
    inbox = build({ logger: { warn } });
    await finding("duplicate", "dup:1", { reason: "title" });
    conflicts = async () => {
      throw new Error("vault gone");
    };
    expect((await inbox.list({})).items).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });
});
