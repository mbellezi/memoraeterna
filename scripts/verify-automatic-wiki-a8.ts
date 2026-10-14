import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createPgPool,
  closePgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  createSourceItemRepository,
  createDocumentRepository,
  createChunkRepository,
  createWikiRepository,
  createWikiCuratorRepository,
  createOrganizationRepository,
  createJobRepository,
  createAiConfigRepository,
  createAutomaticMaintenanceRepository,
  createInvestigationRepository,
  createObsidianSyncRepository,
  type PgPool
} from "../packages/db/src/index.js";
import {
  CuratorPreviewSchema,
  AutomaticWikiPolicySchema,
  ConsultationInputSchema,
  WikiPageContentSchema,
  initialCuratorLimits,
  type CuratorSnapshot,
  type OrganizationProfile
} from "@app/domain";
import { WikiCurator } from "../apps/desktop/src/main/services/wiki-curator.js";
import { ConsultationService } from "../apps/desktop/src/main/services/consultation-service.js";
import { InvestigationService } from "../apps/desktop/src/main/services/investigation-service.js";
import { ObsidianSyncService } from "../apps/desktop/src/main/services/obsidian-sync-service.js";
import { runObsidianSync } from "../apps/desktop/src/main/workers/obsidian-sync.worker.js";
import { promptAudit, capturePromptPin } from "../apps/desktop/src/main/services/prompt-runtime.js";
import { parseObsidianMarkdown } from "@app/integration-contracts";

// This verifier never starts Electron, Obsidian or an actual AI adapter. Native and
// model quality are independent release gates. Every source is a versioned fixture.
const root = resolve(import.meta.dirname, "..");
const work = await mkdtemp(join(tmpdir(), "memora-a8-"));
const migrations = join(root, "packages/db/drizzle");
const seedFolder = join(root, "packages/db/seed");
const paths = resolvePostgresSidecarPaths({ cwd: root, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: paths.binDir,
  dataDir: join(work, "data"),
  database: "a8",
  user: "a8",
  password: randomUUID()
});
const pools: PgPool[] = [];
const fixture = JSON.parse(
  await readFile(new URL("./fixtures/automatic-wiki/mixed-library.json", import.meta.url), "utf8")
);

async function digest(db: PgPool) {
  const tables = (
    await db.query("select tablename from pg_tables where schemaname='public' order by tablename")
  ).rows;
  const result: Record<string, { rows: number; sha256: string }> = {};
  for (const { tablename } of tables) {
    const rows = (
      await db.query(
        `select to_jsonb(t)::text value from public."${tablename.replaceAll('"', '""')}" t order by to_jsonb(t)::text`
      )
    ).rows;
    result[tablename] = {
      rows: rows.length,
      sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex")
    };
  }
  return result;
}

async function exercise(db: PgPool, withNotes: boolean) {
  const sources = createSourceItemRepository(db),
    docs = createDocumentRepository(db);
  const chunks = createChunkRepository(db),
    wiki = createWikiRepository(db);
  const runs = createOrganizationRepository(db),
    jobs = createJobRepository(db);
  const policies = createWikiCuratorRepository(db),
    maintenance = createAutomaticMaintenanceRepository(db);
  const investigations = createInvestigationRepository(db);
  async function source(title: string, text: string | null) {
    const item = await sources.create({ type: text ? "GenericDocument" : "Book", title });
    if (!text) return { id: item.id, chunk: null, text };
    const document = await docs.create({
      sourceItemId: item.id,
      title,
      canonicalMarkdown: text,
      contentHash: text
    });
    const id = randomUUID(),
      span = randomUUID();
    await chunks.replaceDocumentChunks(document.id, item.id, [
      {
        id,
        sourceSpanId: span,
        chunkIndex: 0,
        content: text,
        contentHash: text,
        span: { id: span, startOffset: 0, endOffset: text.length }
      }
    ]);
    return { id: item.id, chunk: id, text };
  }
  const aData = fixture.sources.find((s: any) => s.key === "A");
  const bData = fixture.sources.find((s: any) => s.key === "B");
  const a = await source(aData.title, aData.text),
    b = await source(bData.title, bData.text);
  const catalog = await source("Catalogue only — études", null);
  const noteIds: string[] = [];
  if (withNotes) {
    const note = fixture.notes[0],
      id = randomUUID();
    await db.query(
      "insert into atomic_notes(id,title,idea_statement,body_markdown,created_from_source_item_id,evidence_chunk_id,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key) values($1::uuid,$2,$3,$3,$4,$5,'synthetic','fixture','test','fixture-v1',$1::text)",
      [id, note.title, note.text, a.id, a.chunk]
    );
    noteIds.push(id);
  }
  const profile: OrganizationProfile = {
    profileId: randomUUID(),
    providerConfigId: null,
    localModelId: randomUUID(),
    provider: "synthetic",
    modelId: "a8-deterministic",
    runtime: "test",
    revision: "1",
    privacy: "offline_only",
    identityHash: "a8-deterministic",
    parameters: { maxTokens: 2048, contextWindow: 128000 },
    contextWindow: 128000
  };
  let calls = 0,
    notifications = 0;
  const draft = (s: CuratorSnapshot) => {
    const ref = (kind: string, id: string) =>
      "r" + (s.references.findIndex((r) => r.kind === kind && r.id === id) + 1);
    const topic = s.pages.find((p) => p.kind === "topic"),
      index = s.pages.find((p) => p.kind === "collection");
    const handle = topic ? ref("page", topic.id) : "new_topic";
    return {
      explanation: "Keep independently attributed findings and reading identities.",
      topics: [
        {
          handle,
          title: topic?.title ?? "Learning evidence",
          purpose:
            topic?.automatic?.purpose ?? "Compare retrieval and distributed-practice findings.",
          sections: [
            {
              id: topic?.sections.find((section) => !section.protected)?.id ?? null,
              title: "Findings",
              markdown: s.evidence.map((e) => e.excerpt + " [" + e.handle + "]").join("\n\n"),
              originalHandles: s.evidence.map((e) => e.handle)
            }
          ],
          links: []
        }
      ],
      indexes: [
        {
          handle: index ? ref("page", index.id) : "new_index",
          title: index?.title ?? "Reading learning evidence",
          purpose:
            index?.automatic?.purpose ?? "Navigate independently attributed learning findings.",
          owner: { topic: handle },
          groups: [
            {
              id: index?.automatic?.groups[0]?.id ?? null,
              title: "Originals and selected notes",
              explanation: null,
              originalHandles: [],
              targets: s.references
                .filter((r) => r.kind === "source" || r.kind === "atomic_note")
                .map((r) => ref(r.kind, r.id))
            }
          ]
        }
      ]
    };
  };
  const ai = {
    pinOrganizationProfile: async () => profile,
    runConsultationEmbedding: async () => null,
    runOrganizationTask: async (
      _p: any,
      prompt: string,
      context: any,
      signal: AbortSignal,
      _max: number,
      guard?: () => Promise<void>
    ) => {
      await guard?.();
      signal.throwIfAborted();
      await context.onProviderStart?.();
      calls++;
      let output: any;
      if (prompt.split("\n").some((line) => line.startsWith("COMPILED KNOWLEDGE: "))) {
        const originals = JSON.parse(
          prompt
            .split("\n")
            .find((line) => line.startsWith("ORIGINALS: "))!
            .slice(11)
        );
        const compiled = JSON.parse(
          prompt
            .split("\n")
            .find((line) => line.startsWith("COMPILED KNOWLEDGE: "))!
            .slice(20)
        );
        output = {
          paragraphs: [
            {
              markdown: originals.map((e: any) => e.excerpt + " [" + e.handle + "]").join("\n\n"),
              citations: originals.map((e: any) => e.handle),
              contextIds: compiled.map((c: any) => c.id)
            }
          ],
          gaps: ["No sample sizes or delayed-test duration were supplied."],
          ...(prompt.includes("explicitly followed question")
            ? {
                change: {
                  meaningful: true,
                  explanation: [
                    "The new same-conditions replication qualifies the earlier finding."
                  ]
                }
              }
            : {})
        };
      } else {
        const run = (await runs.get(context.organizationRunId))!;
        output =
          context.stage === "support"
            ? {
                supported: true,
                checkedTargets: run.checkpoint.proposal.targets.map((t: any) => t.handle),
                issues: []
              }
            : draft(run.snapshot as CuratorSnapshot);
      }
      const aiTaskRunId = await createAiConfigRepository(db).recordTaskRun({
        ...context,
        promptCompositions: promptAudit(prompt),
        taskType: "structured-output",
        provider: "synthetic",
        modelId: "a8-deterministic",
        runtime: "test",
        durationMs: 1,
        status: "succeeded",
        inputTokens: 100,
        outputTokens: 50
      });
      return {
        output,
        aiTaskRunId,
        inputTokens: 100,
        outputTokens: 50,
        providerId: "synthetic",
        modelId: "a8-deterministic",
        runtime: "test",
        durationMs: 1,
        taskType: "structured-output" as const
      };
    }
  };
  const options = {
    getPool: () => db,
    ai,
    contentLanguage: async () => "en",
    wake: () => {},
    cancelJob: (id: string) => jobs.requestCancel(id)
  };
  const curator = new WikiCurator(options),
    consultation = new ConsultationService(options);
  const follow = new InvestigationService({
    ...options,
    consultation,
    notify: () => notifications++
  });
  let sync: ObsidianSyncService | undefined;
  try {
    const beforeSetup = await digest(db);
    const preview = CuratorPreviewSchema.parse(
      await curator.command({
        command: "preview",
        input: {
          sourceIds: [],
          wholeLibrary: true,
          includeDescendants: false,
          excludedSourceIds: [],
          profileOverrideId: profile.profileId,
          limits: initialCuratorLimits,
          timezone: "Europe/London"
        }
      })
    );
    assert.equal(calls, 0);
    assert.equal((await maintenance.schedules()).length, 0);
    const policy = AutomaticWikiPolicySchema.parse(
      await curator.command({
        command: "activate",
        policyId: preview.policy.id,
        revisionId: preview.policy.revisionId,
        previewHash: preview.previewHash
      })
    );
    await curator.command({
      command: "activate",
      policyId: policy.id,
      revisionId: policy.revisionId,
      previewHash: preview.previewHash
    });
    assert.equal((await maintenance.schedules(policy.id)).length, 4);
    assert.equal(calls, 0);
    assert.equal((await db.query("select count(*)::int n from wiki_pages")).rows[0].n, 0);
    const execute = async (id: string) => {
      const run = (await curator.get(id))!,
        job = (await jobs.findById(run.jobId!))!;
      await curator.execute(job, new AbortController().signal);
      await jobs.update(job.id, { status: "succeeded" });
      const settled = (await curator.get(id))!;
      assert.equal(settled.status, "applied", JSON.stringify(settled.checkpoint.validationIssues));
      return settled;
    };
    const start = (ids: string[]) =>
      curator.command({
        command: "start",
        input: { policyId: policy.id, policyRevisionId: policy.revisionId, sourceIds: ids, noteIds }
      }) as Promise<any>;
    const first = await execute((await start([a.id, b.id])).id);
    assert.equal(calls, 2);
    const topic = (await wiki.list()).find((p) => p.kind === "topic")!;
    const index = (await wiki.list()).find((p) => p.kind === "collection")!;
    const firstPage = (await wiki.get(topic.id))!,
      firstIndex = (await wiki.get(index.id))!;
    assert.deepEqual(firstPage.evidence.map((e) => e.chunkId).sort(), [a.chunk, b.chunk].sort());
    const humanId = randomUUID(),
      content = WikiPageContentSchema.strip().parse(firstPage);
    content.sections.push({
      id: humanId,
      sectionRevisionId: randomUUID(),
      title: "Personal interpretation",
      kind: "prose",
      markdown: fixture.existingPages[0].text,
      protected: true,
      provenance: "human",
      evidenceIds: [],
      evidenceReview: "needs_review"
    });
    await wiki.save({
      version: 2,
      id: topic.id,
      expectedRevisionId: firstPage.revisionId,
      content,
      evidenceChunkIds: []
    });
    const human = (await wiki.get(topic.id))!.sections.find((s) => s.id === humanId)!;
    // Ask compiles the actual generated topic first despite high-ranking raw noise.
    for (let i = 0; i < 15; i++)
      await source(
        "Learning evidence",
        `Learning evidence learning evidence unrelated astronomy ${i}.`
      );
    const answer = await consultation.ask(
      ConsultationInputSchema.parse({
        version: "knowledge-consultation-v2",
        requestId: randomUUID(),
        question: "Learning evidence retrieval retention"
      })
    );
    assert.ok(answer.contexts.some((c) => c.pageId === topic.id));
    assert.ok(answer.evidence.some((e) => e.chunkId === a.chunk));
    assert.ok(answer.evidence.some((e) => e.chunkId === b.chunk));
    const compiledChunks = new Set([a.chunk, b.chunk]);
    assert.deepEqual(
      answer.evidence
        .slice(0, 2)
        .map((e) => e.chunkId)
        .sort(),
      [...compiledChunks].sort()
    );
    const expanded = answer.evidence.filter((e) => !compiledChunks.has(e.chunkId));
    assert.ok(
      expanded.length <= compiledChunks.size,
      "Raw lexical matches cannot dominate compiled-original count"
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(expanded)) <=
        Buffer.byteLength(
          JSON.stringify(answer.evidence.filter((e) => compiledChunks.has(e.chunkId)))
        ),
      "Raw expansion cannot dominate original-evidence bytes"
    );
    assert.equal((await investigations.list()).length, 0);
    assert.equal((await wiki.list()).length, 2, "Ask does not persist a page");
    const askCalls = calls;
    const saved = await consultation.save(answer.id);
    assert.ok(saved);
    const followed = (await follow.follow({ answerId: answer.id, policyId: policy.id }))!;
    assert.equal(calls, askCalls, "Explicit Save and Follow reuse existing inference");
    assert.match(
      (await wiki.get(followed.answerPageId))!.sections.map((s) => s.markdown).join("\n"),
      /sample sizes/
    );
    const priorAnswer = (await investigations.get(followed.id))!.current;
    // A separately authorized next occurrence retains the original shared debit.
    const firstOccurrence = await maintenance.get(first.snapshot.maintenanceRunId!);
    await maintenance.cancel(firstOccurrence!.id);
    const schedule = (await maintenance.schedules(policy.id)).find(
      (s) => s.policy.kind === "daily"
    )!;
    const occurrence = (await maintenance.admit([schedule], new Date(), true, randomUUID(), {
      profile,
      promptPin: capturePromptPin(),
      contentLanguage: "en"
    }))!;
    occurrence.status = "inspecting";
    occurrence.checkpoint.startedAt = new Date().toISOString();
    await maintenance.checkpoint(occurrence);
    await follow.tick(occurrence);
    assert.equal(calls, askCalls, "Unchanged inspection is no-call");
    const cData = fixture.sources.find((s: any) => s.key === "C");
    const c = await source(cData.title, cData.text);
    const later = await execute((await start([c.id])).id);
    assert.deepEqual(later.snapshot.sourceIds.toSorted(), [a.id, b.id, c.id].toSorted());
    const updated = (await wiki.get(topic.id))!,
      updatedIndex = (await wiki.get(index.id))!;
    assert.deepEqual(
      updated.sections.find((s) => s.id === humanId),
      human
    );
    assert.equal(updated.sections.find((s) => s.id !== humanId)!.id, firstPage.sections[0]!.id);
    assert.match(updated.sections.find((s) => s.id !== humanId)!.markdown, /not reproduced/);
    assert.equal(updatedIndex.automatic!.groups[0]!.id, firstIndex.automatic!.groups[0]!.id);
    assert.equal((await wiki.list()).filter((p) => p.kind === "topic").length, 1);
    assert.deepEqual(
      (await wiki.get(topic.id, firstPage.revisionId))!.sections,
      firstPage.sections
    );
    const beforeRefresh = calls;
    await follow.tick((await maintenance.get(occurrence.id))!);
    const refreshed = (await investigations.get(followed.id))!;
    assert.equal(calls, beforeRefresh + 1, JSON.stringify(refreshed.history));
    assert.equal(notifications, 1);
    assert.equal(refreshed.history.length, 2);
    assert.ok(refreshed.current.evidence.some((e) => e.chunkId === c.chunk));
    assert.ok(refreshed.history.some((h) => h.previous?.id === priorAnswer.id));
    const noChangeCalls = calls,
      noChangeNotifications = notifications;
    assert.equal((await start([c.id])).id, later.id);
    await follow.tick((await maintenance.get(occurrence.id))!);
    assert.equal(calls, noChangeCalls);
    assert.equal(notifications, noChangeNotifications);
    // Pause and restart cannot initialize new work, rewrite old pins or move files.
    await curator.command({ command: "pause", policyId: policy.id });
    const beforeRestart = await digest(db);
    assert.equal((await runMigrations(db, migrations, { seedFolder })).seed.applied, false);
    assert.deepEqual(
      await digest(db),
      beforeRestart,
      "Idempotent startup preserves every public table byte"
    );
    assert.equal((await policies.policy(policy.id))!.state, "paused");
    assert.deepEqual((await curator.get(first.id))!.snapshot, first.snapshot);
    assert.equal(calls, noChangeCalls);
    // Real temporary filesystem projection, independently from the actual editor gate.
    const vault = join(work, withNotes ? "vault-notes" : "vault-originals");
    await mkdir(vault);
    const settings = {
      obsidianVaultPath: vault,
      managedRoot: "Memora",
      obsidianSyncEnabled: true,
      obsidianSyncPaused: false,
      deletionPolicy: "tombstone" as const,
      uploadCopiesEnabled: false,
      uploadCopiesFolderPath: null,
      updatedAt: new Date().toISOString()
    };
    sync = new ObsidianSyncService({
      getPool: () => db,
      getStorageSettings: async () => settings,
      getLocale: async () => "en",
      writeProjection: async (input) => {
        const result = await runObsidianSync({ action: "write", ...input });
        return { mtimeMs: Number(result.mtimeMs) };
      }
    });
    const projectionId = (await sync.wiki.enqueue(true))!,
      projectionJob = (await jobs.findById(projectionId))!;
    await jobs.update(projectionId, { status: "running" });
    const projectionResult = await sync.wiki.execute(projectionJob);
    await jobs.update(projectionId, { status: "succeeded", result: projectionResult });
    const registry = createObsidianSyncRepository(db),
      files = await registry.list();
    const indexFile = (await registry.findByMemoraId(index.id))!;
    const rendered = await readFile(join(vault, indexFile.relativePath), "utf8");
    assert.equal(parseObsidianMarkdown(rendered)!.frontmatter.memoraLayout, 2);
    for (const member of updatedIndex.automatic!.memberships) {
      const file = (await registry.findByMemoraId(member.target.id))!;
      assert.ok(file, "Every canonical reading membership has one registered projection");
      assert.equal(files.filter((f) => f.memoraId === member.target.id).length, 1);
      assert.ok(rendered.includes(file.relativePath.replace(/\.md$/, "")), member.target.id);
    }
    assert.ok(await registry.findByMemoraId(catalog.id));
    assert.equal(calls, noChangeCalls);
    const afterProjection = await digest(db);
    for (const table of [
      "source_summaries",
      "entities",
      "embeddings_256",
      "embeddings_768",
      "embeddings_1024"
    ]) {
      assert.ok(beforeSetup[table], `Required optional-artifact inventory: ${table}`);
      assert.deepEqual(afterProjection[table], beforeSetup[table], `No hidden optional ${table}`);
    }
    assert.equal(
      (await db.query("select count(*)::int n from atomic_notes")).rows[0].n,
      noteIds.length
    );
    assert.equal(
      (await db.query("select count(*)::int n from ai_task_runs where cost_estimate is not null"))
        .rows[0].n,
      0
    );
    // Scale after projection: export's disclosed bound is independent of lazy tree reads.
    await db.query(
      `with ids as (select gen_random_uuid() id, gen_random_uuid() revision, i from generate_series(1,1201) i), pages as (insert into wiki_pages(id,current_revision_id,title,kind) select id,revision,'Scale '||lpad(i::text,4,'0'),'topic' from ids) insert into wiki_page_revisions(id,page_id,number,origin,content,content_hash) select revision,id,1,'human',jsonb_build_object('title','Scale '||lpad(i::text,4,'0'),'kind','topic','sections','[]'::jsonb),'scale' from ids`
    );
    const seen = new Set<string>();
    let after: { id: string; title: string; position: number } | null = null;
    do {
      const page = await wiki.tree({ parentId: null, after, limit: 37 });
      for (const item of page.items) {
        assert.ok(!seen.has(item.id));
        seen.add(item.id);
      }
      after = page.next;
    } while (after);
    assert.ok(seen.size >= 1201);
    const last = (await db.query("select id from wiki_pages where title='Scale 1201'")).rows[0].id;
    assert.ok(seen.has(last));
    assert.ok(
      (await wiki.tree({ parentId: null, after: null, limit: 1, pathTo: last })).path.some(
        (p) => p.id === last
      )
    );
    const times: number[] = [];
    for (let sample = 0; sample < 25; sample++) {
      const started = performance.now();
      await wiki.tree({ parentId: null, after: null, limit: 50 });
      if (sample) times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    return {
      variant: withNotes ? "selected-existing-notes" : "originals-only",
      calls,
      actualModel: false,
      notes: noteIds.length,
      projectedFiles: files.length,
      tableDigestsOnRestart: Object.keys(beforeRestart).length,
      navigableRoots: seen.size,
      treeQuerySamples: times.length,
      treeQueryP95Ms: times[Math.ceil(times.length * 0.95) - 1],
      nativeLatencyMs: null,
      cost: null
    };
  } finally {
    follow.shutdown();
    await sync?.shutdown();
  }
}

try {
  const connection = await manager.start();
  const main = createPgPool({ connectionString: connection.connectionString, max: 8 });
  pools.push(main);
  const results = [];
  for (const withNotes of [false, true]) {
    const name = withNotes ? "a8_notes" : "a8_originals";
    await main.query(`create database ${name}`);
    const url = new URL(connection.connectionString);
    url.pathname = "/" + name;
    const db = createPgPool({ connectionString: url.toString(), max: 8 });
    pools.push(db);
    assert.equal((await runMigrations(db, migrations, { seedFolder })).seed.applied, true);
    results.push(await exercise(db, withNotes));
  }
  console.log(
    JSON.stringify(
      { ok: true, kind: "deterministic-service-postgresql-filesystem", results },
      null,
      2
    )
  );
} finally {
  for (const pool of pools.reverse()) await closePgPool(pool);
  await manager.stop();
  await rm(work, { recursive: true, force: true });
}
