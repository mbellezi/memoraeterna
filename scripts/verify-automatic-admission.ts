import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createPgPool,
  closePgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  createAutomaticMaintenanceRepository,
  createJobRepository,
  createOrganizationRepository,
  createWikiCuratorRepository,
  createWikiCollectionRepository,
  createKnowledgeAutomationRepository
} from "../packages/db/src/index.js";
import { CuratorPreviewSchema, CuratorChangeSetSchema } from "@app/domain";
import {
  curatorSampleSnapshot,
  curatorSampleCheckpoint
} from "../apps/desktop/src/main/services/prompt-samples.js";
import { defaultPromptPin } from "../apps/desktop/src/main/services/prompt-runtime.js";
import { KnowledgeAutomation } from "../apps/desktop/src/main/services/knowledge-automation.js";
import { AutomaticMaintenance } from "../apps/desktop/src/main/services/automatic-maintenance.js";
import { WikiCurator } from "../apps/desktop/src/main/services/wiki-curator.js";

const root = resolve(import.meta.dirname, ".."),
  work = await mkdtemp(join(tmpdir(), "memora-admission-"));
const paths = resolvePostgresSidecarPaths({ cwd: root, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: paths.binDir,
  dataDir: join(work, "data"),
  database: "admission",
  user: "admission",
  password: randomUUID()
});
let db: ReturnType<typeof createPgPool> | undefined;
try {
  const connection = await manager.start();
  db = createPgPool({ connectionString: connection.connectionString, max: 8 });
  await runMigrations(db, join(root, "packages/db/drizzle"), {
    seedFolder: join(root, "packages/db/seed")
  });
  let now = Date.now(),
    modelCalls = 0;
  const sample = curatorSampleSnapshot(defaultPromptPin());
  const options = {
    getPool: () => db!,
    now: () => now,
    ai: {
      pinOrganizationProfile: async () => sample.profile,
      runOrganizationTask: async () => {
        modelCalls++;
        throw new Error("Unexpected inference");
      }
    },
    contentLanguage: async () => "en",
    wake: () => {},
    cancelJob: async () => {}
  };
  const id = await new KnowledgeAutomation(options).initialize(),
    maintenance = createAutomaticMaintenanceRepository(db),
    curator = createWikiCuratorRepository(db),
    org = createOrganizationRepository(db);
  const policy = (await curator.policy(id))!,
    schedules = await maintenance.schedules(id),
    context = { profile: sample.profile, promptPin: defaultPromptPin(), contentLanguage: "en" };
  const first = (await maintenance.admit(
    [schedules.find((s) => s.policy.kind === "incremental")!],
    new Date(now),
    true,
    randomUUID(),
    context
  ))!;
  const child = await org.create(
    { ...sample, policy, maintenanceRunId: first.id, inputFingerprint: randomUUID() },
    curatorSampleCheckpoint()
  );
  const issue = {
    path: "targets.0.sections.0.markdown",
    message: "The original says others, not students."
  };
  const proposal = CuratorChangeSetSchema.parse({
    version: "automatic-wiki-v1",
    groupId: randomUUID(),
    policyRevisionId: policy.revisionId,
    explanation: "Fixture",
    targets: [
      {
        handle: "new_fixture",
        pageId: null,
        expectedRevisionId: null,
        title: "Fixture",
        purpose: "Fixture",
        role: { kind: "topic", role: "topic" },
        initialParent: null,
        sections: [
          {
            sectionId: null,
            expectedSectionRevisionId: null,
            title: "Fixture",
            markdown: "Students learn.",
            originalHandles: ["e1"]
          }
        ],
        links: [],
        tocGroups: []
      }
    ]
  });
  const failedCheckpoint = {
    ...curatorSampleCheckpoint(),
    calls: 4,
    repairs: 1,
    error: "organization.errors.evidence",
    proposal,
    validationIssues: [issue],
    supportAssessment: {
      proposalHash: "fixture",
      aiTaskRunId: randomUUID(),
      verdict: { supported: false, checkedTargets: ["new_fixture"], issues: [issue] }
    }
  };
  await org.checkpoint(child, "failed", failedCheckpoint);
  await maintenance.cancel(first.id);
  const duplicate = (await maintenance.admit(
    [schedules[0]!],
    new Date(now),
    true,
    randomUUID(),
    context
  ))!;
  const collection = createWikiCollectionRepository(db),
    bootstrap = await collection.bootstrap({
      version: "wiki-bootstrap-v1",
      policy,
      sourceIds: sample.sourceIds,
      noteIds: [],
      participation: null,
      ...context,
      admittedAt: new Date(now).toISOString()
    });
  const cursor = (await collection.get(bootstrap))!;
  cursor.checkpoint.state = "attention";
  cursor.checkpoint.childRunId = child;
  cursor.checkpoint.error = "organization.errors.evidence";
  await collection.checkpoint(cursor);
  const event = (
    await db.query(
      "insert into knowledge_impact_events(kind,input_id,fingerprint,source_ids,operation) values('wiki_page',gen_random_uuid(),'blocked-fixture','[]','updated') returning id"
    )
  ).rows[0].id;
  const delivery = (
    await db.query(
      "insert into knowledge_impact_deliveries(event_id,consumer,consumer_key,input_generation,status,checkpoint) values($1,'curator',$2,$3,'deferred',$4) on conflict(event_id,consumer,consumer_key,input_generation) do update set status=excluded.status,checkpoint=excluded.checkpoint returning id",
      [
        event,
        id,
        "blocked-fixture:" + policy.revisionId,
        { childRunId: child, blockedReason: "organization.errors.evidence" }
      ]
    )
  ).rows[0].id;
  await db.query(
    "update maintenance_runs set status='awaiting_review',checkpoint=jsonb_set(checkpoint,'{impactDeliveryId}',to_jsonb($2::text)) where id=$1",
    [duplicate.id, delivery]
  );
  const immutable = (await org.get(child))!.snapshot;
  await maintenance.settleRejections(id, policy.revisionId);
  assert.equal((await org.get(child))!.status, "rejected");
  assert.deepEqual((await org.get(child))!.snapshot, immutable);
  assert.equal((await org.get(child))!.checkpoint.calls, 4);
  assert.equal((await maintenance.get(first.id))!.status, "canceled");
  assert.equal((await maintenance.get(duplicate.id))!.status, "rejected");
  assert.equal((await collection.get(bootstrap))!.checkpoint.state, "rejected");
  const receipt = (
    await db.query("select status,receipt from knowledge_impact_deliveries where id=$1", [delivery])
  ).rows[0];
  assert.equal(receipt.status, "acknowledged");
  assert.equal(receipt.receipt.kind, "rejected");
  assert.equal(receipt.receipt.runId, child);
  await assert.rejects(org.retry(child));
  await assert.rejects(
    new (await import("../apps/desktop/src/main/services/wiki-collection.js")).WikiCollection(
      options
    ).command({ command: "bootstrapResume", id: bootstrap }),
    /organization.errors.rejected/
  );
  await maintenance.cancel(duplicate.id);
  assert.equal((await maintenance.get(duplicate.id))!.status, "rejected");
  await createJobRepository(db).clearCompletedOrFailed();
  const feedback = await curator.rejectionFeedback(sample.sourceIds);
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0]!.issues[0]!.previousText, "Students learn.");
  assert.equal(feedback[0]!.analysisId, child);
  assert.ok(
    feedback[0]!.originals.every((e) =>
      sample.evidence.some(
        (original) => e.contentHash === original.contentHash && e.chunkId === original.chunkId
      )
    )
  );
  assert.deepEqual(await curator.rejectionFeedback([]), []);
  assert.deepEqual(await curator.rejectionFeedback([randomUUID()]), []);
  assert.deepEqual(await curator.rejectionFeedback(sample.sourceIds.slice(0, -1)), []);
  assert.equal(await curator.rejected(immutable.inputFingerprint as string, id), child);
  const counts = async () =>
    (
      await db!.query(
        "select (select count(*) from maintenance_runs) runs,(select count(*) from jobs) jobs,(select count(*) from maintenance_occurrences) occurrences,(select count(*) from automatic_routine_calls) calls"
      )
    ).rows[0];
  const before = await counts();
  assert.equal((await maintenance.admissionBlock(id, policy.revisionId))!.runId, child);
  assert.ok((await maintenance.schedules(id)).every((s) => s.admissionBlock?.runId === child));
  // Cancel + cleanup, repeated calendar ticks and manual commands must not wrap the same decision again.
  for (let i = 0; i < 6; i++) {
    now += 120001;
    await new AutomaticMaintenance(options).tick();
    for (const s of await maintenance.schedules(id))
      assert.equal(
        (await maintenance.admit([s], new Date(now), false, undefined, context))?.id ?? null,
        null
      );
    assert.equal(
      await new AutomaticMaintenance(options).command({
        command: "automaticRun",
        scheduleId: schedules[0]!.id,
        requestId: randomUUID()
      }),
      null
    );
  }
  assert.deepEqual(await counts(), before);
  await assert.rejects(
    maintenance.manualAuthority(id, new Date(now), context),
    /maintenance.errors.retainedDecision/
  );
  now += 35 * 86400000;
  await new AutomaticMaintenance(options).tick();
  assert.deepEqual(await counts(), before);
  const edited = (await maintenance.schedules(id))[0]!;
  await maintenance.save(
    edited.id,
    edited.revision,
    {
      ...edited.policy,
      allowance: { ...edited.policy.allowance, tokens: edited.policy.allowance.tokens + 1 }
    },
    new Date(now)
  );
  assert.equal(
    await maintenance.admit(
      [(await maintenance.schedules(id)).find((s) => s.id === edited.id)!],
      new Date(now),
      true,
      randomUUID(),
      context
    ),
    null
  );
  assert.deepEqual(await counts(), before);
  // A settled outcome is visible in history, not an impossible human decision.
  assert.ok(
    !(await createKnowledgeAutomationRepository(db).tasks(0, true)).tasks.some(
      (t) =>
        t.id === child ||
        t.id === duplicate.id ||
        (t.kind === "schedule" && t.reason === "maintenance.errors.retainedDecision")
    )
  );
  const newEvent = (
    await db.query(
      "insert into knowledge_impact_events(kind,input_id,fingerprint,source_ids,operation) values('wiki_page',gen_random_uuid(),'genuinely-new-input','[]','updated') returning id"
    )
  ).rows[0].id;
  assert.equal(await maintenance.admissionBlock(id, policy.revisionId), null);
  await db.query(
    "update knowledge_impact_deliveries set status='acknowledged',receipt='{\"kind\":\"excluded\"}' where event_id=$1",
    [newEvent]
  );
  assert.equal((await maintenance.admissionBlock(id, policy.revisionId))!.runId, child);
  // Resolving the delivery permits a new occurrence, without changing the retained child or its records.
  await db.query(
    'update knowledge_impact_deliveries set status=\'acknowledged\',receipt=\'{"kind":"excluded","reason":"superseded_revision"}\' where id=$1',
    [delivery]
  );
  assert.equal(await maintenance.admissionBlock(id, policy.revisionId), null);
  const resumed = await maintenance.admit(
    [(await maintenance.schedules(id))[0]!],
    new Date(now),
    true,
    randomUUID(),
    context
  );
  assert.ok(resumed);
  await db.query(
    "update knowledge_impact_deliveries set status='deferred',receipt=null where id=$1",
    [delivery]
  );
  // A newly activated policy revision is a distinct admission generation.
  const service = new WikiCurator(options),
    preview = CuratorPreviewSchema.parse(
      await service.command({
        command: "preview",
        input: {
          policyId: id,
          wholeLibrary: true,
          sourceIds: [],
          limits: policy.limits,
          timezone: "UTC"
        }
      })
    );
  await service.command({
    command: "activate",
    policyId: id,
    revisionId: preview.policy.revisionId,
    previewHash: preview.previewHash
  });
  assert.equal(await maintenance.admissionBlock(id, preview.policy.revisionId), null);
  assert.ok(
    await maintenance.admit(
      [(await maintenance.schedules(id))[0]!],
      new Date(now),
      true,
      randomUUID(),
      context
    )
  );
  assert.equal((await org.get(child))!.status, "rejected");
  assert.equal(modelCalls, 0);
  const eventsBefore = (await db.query("select count(*)::int n from knowledge_impact_events"))
    .rows[0].n;
  for (let i = 0; i < 6; i++) {
    const extra = await org.create(
      { ...sample, policy, inputFingerprint: randomUUID() },
      curatorSampleCheckpoint()
    );
    await org.checkpoint(extra, "failed", {
      ...failedCheckpoint,
      validationIssues: [{ ...issue, message: "Specific diagnostic ".repeat(20) }]
    });
    assert.equal(await org.rejectValidation(extra), true);
  }
  const bounded = await curator.rejectionFeedback(sample.sourceIds);
  assert.ok(bounded.length <= 4);
  assert.ok(JSON.stringify(bounded).length <= 6002);
  assert.ok(bounded.every((r) => r.issues.length <= 2));
  assert.equal(
    (await db.query("select count(*)::int n from knowledge_impact_events")).rows[0].n,
    eventsBefore
  );
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "cancel-and-cleanup-do-not-recreate-occurrences",
        "timer-and-manual-admission-share-guard",
        "month-and-routine-edits-do-not-reset-decisions",
        "terminal-validation-rejection-and-parent-settlement",
        "canceled-history-and-budget-preserved",
        "feedback-bound-to-original-source-scope",
        "rejected-bootstrap-cannot-resume",
        "no-impossible-human-decision",
        "new-inputs-unblock-inspection",
        "bounded-context-without-new-impact-events",
        "resolved-delivery-unblocks-admission",
        "new-policy-generation-unblocks-admission",
        "history-and-zero-model-usage-preserved"
      ],
      actualModel: false
    })
  );
} finally {
  if (db) await closePgPool(db);
  await manager.stop();
  await rm(work, { recursive: true, force: true });
}
