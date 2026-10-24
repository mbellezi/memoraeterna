import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PostgresSidecarManager,
  closePgPool,
  createPgPool,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import {
  MatchingConfigurationSchema,
  recommendedMatchingConfiguration,
  relationsConfig
} from "@app/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SettingsService } from "../settings-service.js";
import { sourceJudgeRequestSettings } from "../source-relation-processing.js";
import { matchBacklogFingerprint, RelationMatchBacklog } from "./relation-match-backlog.js";
import { matchValueHashes } from "./relation-match-values.js";

// Saving a changed matching value (F4 Q4, plan 4.3 "saving settings never invalidates coverage") on
// a real database: nothing is enqueued and no stored decision, typing, relation or key is rewritten;
// the decisions made while other values were in force are counted and offered as one `backlog`
// finding of the Inbox; accepting it queues them at the lowest priority; dismissing it keeps them.
const workspace = resolve(import.meta.dirname, "../../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));
const quiet = { error: () => undefined, warn: () => undefined };
const space = "space-1";
const hour = 3_600_000;

describe.skipIf(!sidecarInstalled)("a change of the matching values on a real PostgreSQL", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  let clock = new Date("2026-10-01T12:00:00Z");
  let settings: SettingsService;
  let backlog: RelationMatchBacklog;
  const db = () => pool!;

  const newBacklog = (pageSize = 500) =>
    new RelationMatchBacklog({
      getPool: () => db(),
      deciderKey: async () => "decider-now",
      spaceKey: async () => space,
      matchingValues: async () => MatchingConfigurationSchema.parse(await settings.getApp()),
      config: {
        ...relationsConfig,
        match: { ...relationsConfig.match, backlogPageSize: pageSize }
      },
      now: () => clock
    });

  /** A service whose saves are noted like the product's: the backlog is told, fire and forget. */
  const newSettings = () =>
    new SettingsService(workDir, {
      getDatabasePool: () => db(),
      requireDatabase: true,
      logger: quiet,
      onMatchingValuesChanged: async (change) => {
        await backlog.offerSettings({ before: change.before });
      }
    });

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-match-settings-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_match_settings_test",
      user: "memora_match_settings_test",
      password: `match-settings-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 6 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const client = db();
    for (const table of [
      "jobs",
      "gardener_findings",
      "note_match_state",
      "source_matching_decisions",
      "relation_typings"
    ])
      await client.query(`delete from ${table}`);
    await client.query(
      "delete from settings where key in ('app.preferences', 'relations.match.valuesHistory.v1')"
    );
    clock = new Date("2026-10-01T12:00:00Z");
    backlog = newBacklog();
    settings = newSettings();
  });

  // --- the library ----------------------------------------------------------------------------

  const seedSource = async (title: string, parent?: string) => {
    const sourceId = randomUUID();
    await db().query(
      `insert into source_items (id, type, title, parent_source_item_id) values ($1, $2, $3, $4)`,
      [sourceId, parent ? "DocumentSection" : "PersonalNote", title, parent ?? null]
    );
    const documentId = randomUUID();
    await db().query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, $3, 'seed', $4)`,
      [documentId, sourceId, title, `hash-${documentId}`]
    );
    const chunkId = randomUUID();
    await db().query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, $4, $5)`,
      [chunkId, documentId, sourceId, `${title} passage.`, `chunk-${chunkId}`]
    );
    return { sourceId, chunkId };
  };

  /** A current note whose match state says it was decided at `at`. */
  const seedDecidedNote = async (
    source: { sourceId: string; chunkId: string },
    title: string,
    at: Date,
    status = "pending_review"
  ) => {
    const id = randomUUID();
    await db().query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
         supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key)
       values ($1, $2, $3, $4, $5, 'current', 'source', $6, $6, $7, 'seed', 'seed', 'local',
               'seed', $8)`,
      [
        id,
        title,
        `${title} body.`,
        `${title} idea.`,
        status,
        source.sourceId,
        source.chunkId,
        `key-${id}`
      ]
    );
    await db().query(
      `insert into note_match_state (note_id, decider_key, space_key, kth_cosine, input_hash, matched_at)
       values ($1, 'decider-now', $2, null, $3, $4)`,
      [id, space, `input-${id}`, at]
    );
    return { id, ...source };
  };

  /** A source pair the judge decided at `at`, between two roots. */
  const seedPair = async (from: string, to: string, at: Date) => {
    const key = `pair-${randomUUID()}`;
    await db().query(
      `insert into source_matching_decisions (key, source_root_id, target_root_id, metadata, created_at)
       values ($1, $2, $3, '{}'::jsonb, $4)`,
      [key, from, to, at]
    );
    await db().query(
      `insert into relation_typings (pair_key, typer_key, lo_hash, hi_hash, relation_type, direction, decided_at)
       values ($1, 'typer-1', 'lo', 'hi', 'supports', 'lo_to_hi', $2)`,
      [key, at]
    );
    return key;
  };

  const before = (milliseconds: number) => new Date(clock.getTime() - milliseconds);

  /** Every row of the tables that hold decisions, typings, relations and keys, as plain text. */
  const stored = async () => {
    const tables = [
      "note_match_state",
      "source_matching_decisions",
      "relation_typings",
      "atomic_note_relations",
      "source_relations",
      "entity_identity_keys",
      "source_match_state"
    ];
    const snapshot: Record<string, string> = {};
    for (const table of tables)
      snapshot[table] = JSON.stringify(
        (await db().query(`select * from ${table} order by 1, 2`)).rows
      );
    return snapshot;
  };

  const jobCount = async () =>
    Number(
      (await db().query<{ count: number }>("select count(*)::int as count from jobs")).rows[0]!
        .count
    );

  const findings = async () =>
    (
      await db().query<{
        id: string;
        fingerprint: string;
        status: string;
        params: Record<string, unknown>;
      }>(
        `select id, fingerprint, status, params from gardener_findings where kind = 'backlog'
          order by created_at, id`
      )
    ).rows;

  /** Opens the history at the calibrated values, then lets the clock move on. */
  const baseline = async () => {
    await settings.getApp();
    expect(await backlog.offerSettings()).toEqual({ status: "none", notes: 0, pairs: 0 });
  };

  /** The finding of an offer, whether this call made it or found the save's own offer made. */
  const offered = (offer: Awaited<ReturnType<typeof backlog.offerSettings>>) => {
    if (offer.status !== "offered" && offer.status !== "updated")
      throw new Error(`expected an offer, got ${offer.status}`);
    return offer;
  };

  const advance = (milliseconds: number) => {
    clock = new Date(clock.getTime() + milliseconds);
  };

  /** A save of source values, as Settings makes it, and the offer that follows it. */
  const saveSource = async (
    changes: Partial<typeof recommendedMatchingConfiguration.sourceRelationSettings>
  ) => {
    await settings.updateApp({
      sourceRelationSettings: { ...(await settings.getApp()).sourceRelationSettings, ...changes }
    });
    // The save's own offer ran without being awaited: this one follows it.
    return backlog.offerSettings();
  };

  // --- tests ----------------------------------------------------------------------------------

  it("enqueues no job and rewrites no decision, typing, relation or key when a value is saved", async () => {
    const book = await seedSource("Book");
    const other = await seedSource("Other");
    const note = await seedDecidedNote(book, "Spacing", before(2 * hour));
    await seedDecidedNote(other, "Retrieval", before(3 * hour));
    await seedPair(book.sourceId, other.sourceId, before(2 * hour));
    await baseline();
    const snapshot = await stored();
    expect(await jobCount()).toBe(0);

    const offer = await saveSource({ evidenceChunksPerSource: 3, maxRelationsPerPair: 6 });
    await settings.updateApp({
      relationTypeSimilarityThreshold: 0.8,
      entityIdentitySimilarityThreshold: 0.8
    });
    await settings.updateApp({ atomicNoteMatchingSettings: { maxRerankOutputTokens: 2048 } });
    await backlog.offerSettings();

    expect(offered(offer)).toMatchObject({ notes: 0, pairs: 1 });
    expect(await jobCount()).toBe(0);
    expect(await stored()).toEqual(snapshot);
    // The saved values are in force for the next decision.
    const saved = await settings.getApp();
    expect(saved.sourceRelationSettings).toMatchObject({
      evidenceChunksPerSource: 3,
      maxRelationsPerPair: 6
    });
    expect(saved.relationTypeSimilarityThreshold).toBe(0.8);
    expect(note.id).toBeTruthy();
  });

  it("changes the source pair key only through the six request-shaping values", () => {
    const judge = relationsConfig.sourceJudge;
    const hashOf = (
      changes: Partial<typeof recommendedMatchingConfiguration.sourceRelationSettings>
    ) =>
      matchValueHashes(
        MatchingConfigurationSchema.parse({
          ...recommendedMatchingConfiguration,
          sourceRelationSettings: {
            ...recommendedMatchingConfiguration.sourceRelationSettings,
            ...changes
          }
        }),
        judge
      );
    const calibrated = hashOf({});
    for (const changes of [
      { evidenceChunksPerSource: 3 },
      { evidenceMaxCharacters: 900 },
      { summaryMaxCharacters: 1100 },
      { maxOutputTokens: 2048 },
      { maxRelationsPerPair: 5 },
      { includeWeakTypes: true }
    ])
      expect(hashOf(changes).pair, JSON.stringify(changes)).not.toBe(calibrated.pair);
    // The floors and the input budget decide what is kept of a verdict, never the request.
    for (const changes of [
      { minImportance: 0.5 },
      { minConfidence: 0.5 },
      { maxInputTokens: 30000 }
    ])
      expect(hashOf(changes), JSON.stringify(changes)).toEqual(calibrated);
    expect(
      sourceJudgeRequestSettings(recommendedMatchingConfiguration.sourceRelationSettings, judge)
    ).toMatchObject({ evidenceChunksPerSource: 2, maxRelationsPerPair: 4 });
  });

  it("offers the notes and pairs decided while other values were in force, as one backlog item", async () => {
    const book = await seedSource("Book");
    const chapter = await seedSource("Chapter", book.sourceId);
    const loose = await seedSource("Loose");
    await seedDecidedNote(chapter, "In chapter", before(3 * hour));
    await seedDecidedNote(loose, "Alone", before(2 * hour));
    await seedDecidedNote(loose, "Rejected", before(2 * hour), "rejected");
    await seedPair(book.sourceId, loose.sourceId, before(2 * hour));
    await seedPair(loose.sourceId, book.sourceId, before(hour));
    await baseline();

    // A note value and a pair value change in one save: both kinds are counted in one offer.
    await settings.updateApp({
      atomicNoteMatchingSettings: { maxRerankOutputTokens: 2048 },
      sourceRelationSettings: {
        ...(await settings.getApp()).sourceRelationSettings,
        summaryMaxCharacters: 1100
      }
    });
    const offer = await backlog.offerSettings();
    expect(offered(offer)).toMatchObject({ notes: 2, pairs: 2 });
    expect(await findings()).toEqual([
      expect.objectContaining({
        status: "open",
        params: { task: "match", reason: "settings_changed", notes: 2, pairs: 2 }
      })
    ]);
    // Offered again, the open finding is updated, not duplicated; nothing is queued.
    expect(await backlog.offerSettings()).toMatchObject({ status: "updated", notes: 2, pairs: 2 });
    expect(await findings()).toHaveLength(1);
    expect(await jobCount()).toBe(0);
  });

  it("offers nothing for a value no stored decision was made under", async () => {
    const loose = await seedSource("Loose");
    await seedDecidedNote(loose, "Alone", before(2 * hour));
    await seedPair(loose.sourceId, loose.sourceId, before(2 * hour));
    await baseline();
    // The thresholds, the identity limits, the floors and the input budget apply to new work only.
    await settings.updateApp({ relationTypeSimilarityThreshold: 0.8 });
    await settings.updateApp({
      canonicalMatchingSettings: {
        ...(await settings.getApp()).canonicalMatchingSettings,
        confirmationBatchSize: 6
      }
    });
    expect(
      await saveSource({ minImportance: 0.6, minConfidence: 0.7, maxInputTokens: 30000 })
    ).toEqual({
      status: "none",
      notes: 0,
      pairs: 0
    });
    expect(await findings()).toEqual([]);
    expect(await jobCount()).toBe(0);
  });

  it("starts the history from the values a first save replaced", async () => {
    const loose = await seedSource("Loose");
    await seedDecidedNote(loose, "Alone", before(2 * hour));
    // No offer was made before: the very first save still counts what the earlier values decided.
    await settings.getApp();
    await settings.updateApp({ atomicNoteMatchingSettings: { maxRerankOutputTokens: 2048 } });
    expect(offered(await backlog.offerSettings())).toMatchObject({ notes: 1, pairs: 0 });
  });

  it("queues the notes and the roots at the lowest priority when the owner accepts, and rewrites nothing", async () => {
    const book = await seedSource("Book");
    const chapter = await seedSource("Chapter", book.sourceId);
    const loose = await seedSource("Loose");
    const inChapter = await seedDecidedNote(chapter, "In chapter", before(3 * hour));
    const alone = await seedDecidedNote(loose, "Alone", before(2 * hour));
    await seedPair(book.sourceId, loose.sourceId, before(2 * hour));
    await seedPair(book.sourceId, loose.sourceId, before(hour));
    await seedPair(loose.sourceId, book.sourceId, before(hour));
    await baseline();
    await settings.updateApp({ atomicNoteMatchingSettings: { maxRerankOutputTokens: 2048 } });
    const offer = offered(await saveSource({ evidenceMaxCharacters: 900 }));
    const snapshot = await stored();

    expect(await newBacklog(1).accept(offer.findingId)).toEqual({ status: "queued", queued: 4 });
    const queued = await db().query<{
      type: string;
      priority: number;
      dedupeKey: string | null;
      scopeKey: string | null;
      payload: Record<string, unknown>;
    }>(
      `select type, priority, dedupe_key as "dedupeKey", scope_key as "scopeKey", payload
         from jobs where status = 'queued' order by type, dedupe_key`
    );
    const links = queued.rows.filter((job) => job.type === "relation-link");
    const matches = queued.rows.filter((job) => job.type === "relation-match");
    // One link job per root that judged a pair, each carrying the backlog flag.
    expect(links.map((job) => job.dedupeKey).sort()).toEqual(
      [`relation-link:${book.sourceId}`, `relation-link:${loose.sourceId}`].sort()
    );
    for (const job of links) {
      expect(job.priority).toBe(-1);
      expect(job.payload).toMatchObject({ backlog: true, discover: true });
      expect(job.payload.regenerate).toBeUndefined();
    }
    expect(matches.map((job) => job.payload.noteId).sort()).toEqual(
      [inChapter.id, alone.id].sort()
    );
    for (const job of matches)
      expect(job).toMatchObject({ priority: -1, payload: { backlog: true } });
    // The notes' jobs are scoped to their hierarchy roots.
    expect(matches.find((job) => job.payload.noteId === inChapter.id)?.scopeKey).toBe(
      `root:${book.sourceId}`
    );
    expect((await findings())[0]).toMatchObject({ status: "resolved" });
    // Queueing re-decided nothing, and asking again queues nothing more.
    expect(await stored()).toEqual(snapshot);
    expect(await backlog.accept(offer.findingId)).toEqual({ status: "closed" });
    expect(await jobCount()).toBe(4);
  });

  it("keeps a dismissed offer closed, and offers a later change anew", async () => {
    const loose = await seedSource("Loose");
    await seedPair(loose.sourceId, loose.sourceId, before(2 * hour));
    await baseline();
    const first = offered(await saveSource({ maxOutputTokens: 2048 }));
    await db().query(
      "update gardener_findings set status = 'dismissed', closed_at = now() where id = $1",
      [first.findingId]
    );
    expect(await backlog.offerSettings()).toEqual({ status: "closed", notes: 0, pairs: 1 });
    expect(await backlog.accept(first.findingId)).toEqual({ status: "closed" });
    expect(await jobCount()).toBe(0);

    // Another value: a new moment in force, so a new offer; the dismissed one stays dismissed.
    advance(hour);
    const second = offered(await saveSource({ maxOutputTokens: 3072 }));
    expect(second).toMatchObject({ pairs: 1 });
    expect((await findings()).map((finding) => finding.status)).toEqual(["dismissed", "open"]);
  });

  it("counts only the decisions made under values other than the ones in force", async () => {
    const loose = await seedSource("Loose");
    await seedPair(loose.sourceId, loose.sourceId, before(5 * hour));
    await baseline();
    advance(hour);
    await saveSource({ summaryMaxCharacters: 1100 });
    // Decided while the changed value was in force.
    await seedPair(loose.sourceId, loose.sourceId, new Date(clock.getTime() + 10 * 60_000));
    advance(2 * hour);
    // Back to the calibrated value: only what the changed value decided is under other values.
    const back = await saveSource({ summaryMaxCharacters: 1000 });
    expect(offered(back)).toMatchObject({ pairs: 1 });
    expect((await findings()).filter((finding) => finding.status === "open")).toHaveLength(1);
  });

  it("resolves an accepted-moot offer as stale when the values changed again", async () => {
    const loose = await seedSource("Loose");
    await seedPair(loose.sourceId, loose.sourceId, before(2 * hour));
    await baseline();
    const first = offered(await saveSource({ maxOutputTokens: 2048 }));
    advance(hour);
    await saveSource({ maxOutputTokens: 4096 });
    // The first offer was for values no longer in force.
    expect(await backlog.accept(first.findingId)).toEqual({ status: "closed" });
    await db().query(
      "update gardener_findings set status = 'open', closed_at = null where id = $1",
      [first.findingId]
    );
    expect(await backlog.accept(first.findingId)).toEqual({ status: "stale" });
    expect(await jobCount()).toBe(0);
  });

  it("does not collide with the offer of a changed decider", async () => {
    const loose = await seedSource("Loose");
    const note = await seedDecidedNote(loose, "Alone", before(2 * hour));
    await db().query("update note_match_state set decider_key = 'decider-old' where note_id = $1", [
      note.id
    ]);
    await seedPair(loose.sourceId, loose.sourceId, before(2 * hour));
    await baseline();
    const decider = await backlog.offer();
    expect(decider).toMatchObject({ status: "offered", notes: 1 });
    const values = await saveSource({ maxOutputTokens: 2048 });
    expect(offered(values)).toMatchObject({ pairs: 1 });
    expect((await findings()).map((finding) => [finding.params.reason, finding.status])).toEqual([
      ["decider_changed", "open"],
      ["settings_changed", "open"]
    ]);
    // Each offer closes its own kind only.
    expect((await findings())[0]!.fingerprint).toBe(matchBacklogFingerprint("decider-now"));
  });
});
