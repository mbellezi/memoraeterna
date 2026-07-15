import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

const vector256 = customType<{ data: string }>({
  dataType: () => "vector(256)"
});

const vector768 = customType<{ data: string }>({
  dataType: () => "vector(768)"
});

const vector1024 = customType<{ data: string }>({
  dataType: () => "vector(1024)"
});

export const sourceItemType = pgEnum("source_item_type", [
  "PersonalNote",
  "DailyNote",
  "WebArticle",
  "Book",
  "BookChapter",
  "PeriodicalIssue",
  "AcademicPaper",
  "DocumentSection",
  "StandaloneArticle",
  "Video",
  "GenericDocument"
]);

export const jobStatus = pgEnum("job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled"
]);

export const ingestionRunStatus = pgEnum("ingestion_run_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "canceled"
]);

export const integrationClientStatus = pgEnum("integration_client_status", [
  "paired",
  "revoked",
  "disabled"
]);

export const obsidianSyncStatus = pgEnum("obsidian_sync_status", [
  "pending",
  "synced",
  "conflict",
  "deleted",
  "ignored"
]);

export const atomicNoteStatus = pgEnum("atomic_note_status", [
  "pending_review",
  "approved",
  "rejected",
  "archived"
]);

export const atomicNoteRelationStatus = pgEnum("atomic_note_relation_status", [
  "pending_review",
  "accepted",
  "rejected"
]);

export const documentStructureStatus = pgEnum("document_structure_status", [
  "draft",
  "in_review",
  "confirmed",
  "materialized",
  "superseded"
]);

export const documentDivisionReviewStatus = pgEnum("document_division_review_status", [
  "proposed",
  "accepted",
  "rejected",
  "edited"
]);

export const processingBatchStatus = pgEnum("processing_batch_status", [
  "pending",
  "running",
  "waiting_for_review",
  "succeeded",
  "partial",
  "failed",
  "canceled"
]);

export const ingestionRunKind = pgEnum("ingestion_run_kind", [
  "initial",
  "missing_stages",
  "reingestion",
  "retry_resume"
]);

export const ingestionRunStageStatus = pgEnum("ingestion_run_stage_status", [
  "pending",
  "running",
  "completed",
  "skipped",
  "failed",
  "canceled",
  "waiting_for_review"
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
};

export const sourceItems = pgTable(
  "source_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: sourceItemType("type").notNull(),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    sourceOrigin: text("source_origin").notNull().default("manual"),
    sourceUri: text("source_uri"),
    externalId: text("external_id"),
    parentSourceItemId: uuid("parent_source_item_id").references((): AnyPgColumn => sourceItems.id, {
      onDelete: "set null"
    }),
    contentHash: text("content_hash"),
    language: varchar("language", { length: 16 }).notNull().default("und"),
    summary: text("summary"),
    summaryGeneratedAt: timestamp("summary_generated_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    typeIdx: index("source_items_type_idx").on(table.type),
    sourceUriIdx: index("source_items_source_uri_idx").on(table.sourceUri),
    contentHashIdx: index("source_items_content_hash_idx").on(table.contentHash),
    externalIdIdx: index("source_items_external_id_idx").on(table.externalId),
    parentSourceItemIdx: index("source_items_parent_source_item_id_idx").on(table.parentSourceItemId)
  })
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    canonicalMarkdown: text("canonical_markdown").notNull(),
    contentHash: text("content_hash").notNull(),
    language: varchar("language", { length: 16 }).notNull().default("und"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    sourceItemIdx: index("documents_source_item_id_idx").on(table.sourceItemId),
    contentHashIdx: index("documents_content_hash_idx").on(table.contentHash)
  })
);

export const documentRevisions = pgTable(
  "document_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    supersedesRevisionId: uuid("supersedes_revision_id").references((): AnyPgColumn => documentRevisions.id, { onDelete: "set null" }),
    isCurrent: boolean("is_current").notNull().default(true),
    contentHash: text("content_hash").notNull(),
    structureHash: text("structure_hash"),
    createdByIngestionRunId: uuid("created_by_ingestion_run_id"),
    reason: text("reason").notNull().default("initial"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    documentRevisionUidx: uniqueIndex("document_revisions_document_revision_uidx").on(table.documentId, table.revision),
    currentDocumentUidx: uniqueIndex("document_revisions_current_document_uidx").on(table.documentId).where(sql`${table.isCurrent} = true`)
  })
);

export const documentStructures = pgTable(
  "document_structures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rootSourceItemId: uuid("root_source_item_id").notNull().references(() => sourceItems.id, { onDelete: "cascade" }),
    rootDocumentId: uuid("root_document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    format: text("format").notNull(),
    detectorVersion: text("detector_version").notNull(),
    status: documentStructureStatus("status").notNull().default("draft"),
    overallConfidence: doublePrecision("overall_confidence").notNull(),
    revision: integer("revision").notNull().default(1),
    rawEvidence: jsonb("raw_evidence").notNull().default(sql`'{}'::jsonb`),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: text("confirmed_by"),
    supersedesStructureId: uuid("supersedes_structure_id").references((): AnyPgColumn => documentStructures.id, { onDelete: "set null" }),
    ...timestamps
  },
  (table) => ({
    rootRevisionUidx: uniqueIndex("document_structures_root_revision_uidx").on(table.rootSourceItemId, table.revision),
    rootStatusIdx: index("document_structures_root_status_idx").on(table.rootSourceItemId, table.status)
  })
);

export const documentDivisions = pgTable(
  "document_divisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stableId: uuid("stable_id").notNull(),
    structureId: uuid("structure_id").notNull().references(() => documentStructures.id, { onDelete: "cascade" }),
    parentDivisionId: uuid("parent_division_id").references((): AnyPgColumn => documentDivisions.id, { onDelete: "cascade" }),
    childSourceItemId: uuid("child_source_item_id").references(() => sourceItems.id, { onDelete: "set null" }),
    childDocumentId: uuid("child_document_id").references(() => documents.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    level: integer("level").notNull(),
    position: integer("position").notNull(),
    startSelector: jsonb("start_selector").notNull(),
    endSelector: jsonb("end_selector").notNull(),
    startPage: integer("start_page"),
    endPage: integer("end_page"),
    startPageLabel: text("start_page_label"),
    endPageLabel: text("end_page_label"),
    markdownStart: integer("markdown_start"),
    markdownEnd: integer("markdown_end"),
    contentHash: text("content_hash"),
    confidence: doublePrecision("confidence").notNull(),
    evidence: jsonb("evidence").notNull().default(sql`'[]'::jsonb`),
    reviewStatus: documentDivisionReviewStatus("review_status").notNull().default("proposed"),
    isProcessable: boolean("is_processable").notNull().default(true),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    structureIdx: index("document_divisions_structure_id_idx").on(table.structureId),
    structureStableUidx: uniqueIndex("document_divisions_structure_stable_uidx").on(table.structureId, table.stableId),
    childSourceIdx: index("document_divisions_child_source_idx").on(table.childSourceItemId),
    siblingPositionUidx: uniqueIndex("document_divisions_sibling_position_uidx")
      .on(table.structureId, table.parentDivisionId, table.position).where(sql`${table.parentDivisionId} is not null`),
    rootPositionUidx: uniqueIndex("document_divisions_root_position_uidx")
      .on(table.structureId, table.position).where(sql`${table.parentDivisionId} is null`)
  })
);

export const documentAssets = pgTable(
  "document_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }),
    sourceItemId: uuid("source_item_id").references(() => sourceItems.id, { onDelete: "cascade" }),
    originalFileName: text("original_file_name").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storageBase: text("storage_base").notNull(),
    relativePath: text("relative_path").notNull(),
    role: text("role").notNull().default("source"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    documentIdx: index("document_assets_document_id_idx").on(table.documentId),
    sourceItemIdx: index("document_assets_source_item_id_idx").on(table.sourceItemId),
    sha256Idx: index("document_assets_sha256_idx").on(table.sha256),
    storagePathIdx: index("document_assets_storage_path_idx").on(table.storageBase, table.relativePath)
  })
);

export const sourceSpans = pgTable(
  "source_spans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    page: integer("page"),
    sourceBlockId: text("source_block_id"),
    boundingBox: jsonb("bounding_box"),
    selector: text("selector"),
    label: text("label"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    documentIdx: index("source_spans_document_id_idx").on(table.documentId),
    sourceItemIdx: index("source_spans_source_item_id_idx").on(table.sourceItemId)
  })
);

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    sourceSpanId: uuid("source_span_id").references(() => sourceSpans.id, { onDelete: "set null" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    tokenCount: integer("token_count"),
    contentHash: text("content_hash").notNull(),
    language: varchar("language", { length: 16 }).notNull().default("und"),
    chunkingVersion: text("chunking_version").notNull().default("markdown-v1"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    documentIdx: index("chunks_document_id_idx").on(table.documentId),
    sourceItemIdx: index("chunks_source_item_id_idx").on(table.sourceItemId),
    documentChunkUidx: uniqueIndex("chunks_document_chunk_index_uidx").on(table.documentId, table.chunkIndex)
  })
);

export const entities = pgTable(
  "entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    canonicalName: text("canonical_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    aliases: jsonb("aliases").notNull().default(sql`'[]'::jsonb`),
    description: text("description"),
    language: varchar("language", { length: 16 }).notNull().default("und"),
    confidence: doublePrecision("confidence").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    typeNameUidx: uniqueIndex("entities_type_normalized_name_uidx").on(table.type, table.normalizedName),
    canonicalNameIdx: index("entities_canonical_name_idx").on(table.canonicalName)
  })
);

export const entityMentions = pgTable(
  "entity_mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId: uuid("entity_id").notNull().references(() => entities.id, { onDelete: "cascade" }),
    sourceItemId: uuid("source_item_id").notNull().references(() => sourceItems.id, { onDelete: "cascade" }),
    chunkId: uuid("chunk_id").notNull().references(() => chunks.id, { onDelete: "cascade" }),
    sourceSpanId: uuid("source_span_id").references(() => sourceSpans.id, { onDelete: "set null" }),
    surfaceText: text("surface_text").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    sourceIdx: index("entity_mentions_source_item_id_idx").on(table.sourceItemId),
    chunkIdx: index("entity_mentions_chunk_id_idx").on(table.chunkId),
    entityChunkUidx: uniqueIndex("entity_mentions_entity_chunk_uidx").on(table.entityId, table.chunkId)
  })
);

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceItemId: uuid("source_item_id").notNull().references(() => sourceItems.id, { onDelete: "cascade" }),
    evidenceChunkId: uuid("evidence_chunk_id").notNull().references(() => chunks.id, { onDelete: "cascade" }),
    sourceSpanId: uuid("source_span_id").references(() => sourceSpans.id, { onDelete: "set null" }),
    text: text("text").notNull(),
    contentHash: text("content_hash").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    sourceIdx: index("claims_source_item_id_idx").on(table.sourceItemId),
    evidenceIdx: index("claims_evidence_chunk_id_idx").on(table.evidenceChunkId),
    sourceHashUidx: uniqueIndex("claims_source_content_hash_uidx").on(table.sourceItemId, table.contentHash)
  })
);

export const claimEntityLinks = pgTable(
  "claim_entity_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id").notNull().references(() => claims.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id").notNull().references(() => entities.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    claimEntityUidx: uniqueIndex("claim_entity_links_claim_entity_uidx").on(table.claimId, table.entityId),
    entityIdx: index("claim_entity_links_entity_id_idx").on(table.entityId)
  })
);

export const entityRelations = pgTable(
  "entity_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectEntityId: uuid("subject_entity_id").notNull().references(() => entities.id, { onDelete: "cascade" }),
    predicate: text("predicate").notNull(),
    objectEntityId: uuid("object_entity_id").notNull().references(() => entities.id, { onDelete: "cascade" }),
    sourceItemId: uuid("source_item_id").notNull().references(() => sourceItems.id, { onDelete: "cascade" }),
    evidenceChunkId: uuid("evidence_chunk_id").notNull().references(() => chunks.id, { onDelete: "cascade" }),
    sourceSpanId: uuid("source_span_id").references(() => sourceSpans.id, { onDelete: "set null" }),
    confidence: doublePrecision("confidence").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    sourceIdx: index("entity_relations_source_item_id_idx").on(table.sourceItemId),
    subjectIdx: index("entity_relations_subject_entity_id_idx").on(table.subjectEntityId),
    objectIdx: index("entity_relations_object_entity_id_idx").on(table.objectEntityId),
    evidenceUidx: uniqueIndex("entity_relations_evidence_uidx").on(
      table.sourceItemId, table.subjectEntityId, table.predicate, table.objectEntityId, table.evidenceChunkId
    )
  })
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    status: jobStatus("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    result: jsonb("result"),
    error: text("error"),
    progress: integer("progress").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => ({
    queueIdx: index("jobs_queue_idx").on(table.status, table.priority, table.runAfter),
    lockedIdx: index("jobs_locked_idx").on(table.lockedBy, table.lockedAt)
  })
);

export const processingBatches = pgTable(
  "processing_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    trigger: text("trigger").notNull(),
    requestedPlan: jsonb("requested_plan").notNull(),
    effectivePlan: jsonb("effective_plan").notNull(),
    reingestionPolicy: text("reingestion_policy").notNull().default("reuse_valid"),
    status: processingBatchStatus("status").notNull().default("pending"),
    progress: integer("progress").notNull().default(0),
    totalItems: integer("total_items").notNull().default(0),
    completedItems: integer("completed_items").notNull().default(0),
    failedItems: integer("failed_items").notNull().default(0),
    matchingBarrierReleasedAt: timestamp("matching_barrier_released_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({ statusIdx: index("processing_batches_status_idx").on(table.status) })
);

export const ingestionRuns = pgTable(
  "ingestion_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceItemId: uuid("source_item_id").references(() => sourceItems.id, { onDelete: "set null" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    batchId: uuid("batch_id").references(() => processingBatches.id, { onDelete: "set null" }),
    runKind: ingestionRunKind("run_kind").notNull().default("initial"),
    requestedStages: jsonb("requested_stages").notNull().default(sql`'[]'::jsonb`),
    effectiveStages: jsonb("effective_stages").notNull().default(sql`'[]'::jsonb`),
    planVersion: text("plan_version").notNull().default("1"),
    inputDocumentRevisionId: uuid("input_document_revision_id").references(() => documentRevisions.id, { onDelete: "set null" }),
    inputHashes: jsonb("input_hashes").notNull().default(sql`'{}'::jsonb`),
    supersedesRunId: uuid("supersedes_run_id").references((): AnyPgColumn => ingestionRuns.id, { onDelete: "set null" }),
    previousArtifactPolicy: text("previous_artifact_policy").notNull().default("reuse_valid"),
    trigger: text("trigger").notNull().default("interactive_import"),
    status: ingestionRunStatus("status").notNull().default("pending"),
    currentStage: text("current_stage").notNull().default("queued"),
    stagesCheckpoint: jsonb("stages_checkpoint").notNull().default(sql`'{}'::jsonb`),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => ({
    sourceItemIdx: index("ingestion_runs_source_item_id_idx").on(table.sourceItemId),
    jobIdx: index("ingestion_runs_job_id_idx").on(table.jobId),
    statusIdx: index("ingestion_runs_status_idx").on(table.status)
  })
);

export const ingestionRunStages = pgTable(
  "ingestion_run_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ingestionRunId: uuid("ingestion_run_id").notNull().references(() => ingestionRuns.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    status: ingestionRunStageStatus("status").notNull().default("pending"),
    skipReason: text("skip_reason"),
    progress: integer("progress").notNull().default(0),
    inputHash: text("input_hash"),
    outputHash: text("output_hash"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
    ...timestamps
  },
  (table) => ({
    runStageUidx: uniqueIndex("ingestion_run_stages_run_stage_uidx").on(table.ingestionRunId, table.stage),
    statusIdx: index("ingestion_run_stages_status_idx").on(table.status)
  })
);

export const knowledgeGenerations = pgTable(
  "knowledge_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceItemId: uuid("source_item_id").notNull().references(() => sourceItems.id, { onDelete: "cascade" }),
    documentRevisionId: uuid("document_revision_id").references(() => documentRevisions.id, { onDelete: "set null" }),
    stage: text("stage").notNull(),
    ingestionRunId: uuid("ingestion_run_id").references(() => ingestionRuns.id, { onDelete: "set null" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    aiTaskRunId: uuid("ai_task_run_id"),
    supersedesGenerationId: uuid("supersedes_generation_id").references((): AnyPgColumn => knowledgeGenerations.id, { onDelete: "set null" }),
    status: text("status").notNull().default("current"),
    inputHash: text("input_hash"),
    outputHash: text("output_hash"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    sourceStageIdx: index("knowledge_generations_source_stage_idx").on(table.sourceItemId, table.stage, table.status),
    runStageUidx: uniqueIndex("knowledge_generations_run_stage_uidx").on(table.ingestionRunId, table.stage)
      .where(sql`${table.ingestionRunId} is not null`)
  })
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const storageSettings = pgTable("storage_settings", {
  id: text("id").primaryKey().default("default"),
  obsidianVaultPath: text("obsidian_vault_path"),
  obsidianManagedRoot: text("obsidian_managed_root").notNull().default("Memora"),
  obsidianSyncEnabled: boolean("obsidian_sync_enabled").notNull().default(false),
  obsidianSyncPaused: boolean("obsidian_sync_paused").notNull().default(false),
  deletePolicy: text("delete_policy").notNull().default("tombstone"),
  uploadCopyEnabled: boolean("upload_copy_enabled").notNull().default(false),
  uploadCopyBasePath: text("upload_copy_base_path"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const integrationClients = pgTable(
  "integration_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientType: text("client_type").notNull(),
    displayName: text("display_name").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopes: jsonb("scopes").notNull().default(sql`'[]'::jsonb`),
    capabilities: jsonb("capabilities").notNull().default(sql`'[]'::jsonb`),
    contractVersion: text("contract_version").notNull().default("1.0.0"),
    status: integrationClientStatus("status").notNull().default("paired"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => ({
    clientTypeIdx: index("integration_clients_client_type_idx").on(table.clientType),
    tokenHashIdx: uniqueIndex("integration_clients_token_hash_uidx").on(table.tokenHash)
  })
);

export const obsidianSyncFiles = pgTable(
  "obsidian_sync_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memoraId: uuid("memora_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    sourceItemId: uuid("source_item_id").references(() => sourceItems.id, { onDelete: "set null" }),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
    memoraType: text("memora_type").notNull(),
    relativePath: text("relative_path").notNull(),
    frontmatterHash: text("frontmatter_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    mtimeMs: bigint("mtime_ms", { mode: "number" }).notNull(),
    syncVersion: integer("sync_version").notNull().default(1),
    status: obsidianSyncStatus("status").notNull().default("pending"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    memoraIdUidx: uniqueIndex("obsidian_sync_files_memora_id_uidx").on(table.memoraId),
    relativePathUidx: uniqueIndex("obsidian_sync_files_relative_path_uidx").on(table.relativePath),
    sourceItemIdx: index("obsidian_sync_files_source_item_id_idx").on(table.sourceItemId),
    documentIdx: index("obsidian_sync_files_document_id_idx").on(table.documentId),
    statusIdx: index("obsidian_sync_files_status_idx").on(table.status)
  })
);

export const bibliographicWorks = pgTable(
  "bibliographic_works",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    canonicalTitle: text("canonical_title"),
    language: varchar("language", { length: 16 }).notNull().default("und"),
    identifiers: jsonb("identifiers").notNull().default(sql`'{}'::jsonb`),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    titleIdx: index("bibliographic_works_title_idx").on(table.title),
    canonicalTitleIdx: index("bibliographic_works_canonical_title_idx").on(table.canonicalTitle)
  })
);

export const bibliographicInstances = pgTable(
  "bibliographic_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workId: uuid("work_id")
      .notNull()
      .references(() => bibliographicWorks.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    edition: text("edition"),
    volume: text("volume"),
    issue: text("issue"),
    publicationDate: text("publication_date"),
    publisher: text("publisher"),
    isbn: text("isbn"),
    issn: text("issn"),
    doi: text("doi"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    workIdx: index("bibliographic_instances_work_id_idx").on(table.workId),
    isbnIdx: index("bibliographic_instances_isbn_idx").on(table.isbn),
    issnIdx: index("bibliographic_instances_issn_idx").on(table.issn),
    doiIdx: index("bibliographic_instances_doi_idx").on(table.doi)
  })
);

export const sourceItemBibliographicLinks = pgTable(
  "source_item_bibliographic_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    workId: uuid("work_id")
      .notNull()
      .references(() => bibliographicWorks.id, { onDelete: "cascade" }),
    instanceId: uuid("instance_id").references(() => bibliographicInstances.id, { onDelete: "set null" }),
    relationType: text("relation_type").notNull().default("instance_of"),
    pages: text("pages"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    sourceWorkUidx: uniqueIndex("source_item_bibliographic_links_source_work_uidx").on(
      table.sourceItemId,
      table.workId
    )
  })
);

export const aiProviderConfigs = pgTable(
  "ai_provider_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    credentialRef: text("credential_ref"),
    baseUrl: text("base_url"),
    defaultParameters: jsonb("default_parameters").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("configured"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({ providerIdx: index("ai_provider_configs_provider_idx").on(table.provider) })
);

export const localModels = pgTable(
  "local_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    catalogId: text("catalog_id").notNull(),
    modelId: text("model_id").notNull(),
    displayName: text("display_name").notNull(),
    family: text("family").notNull(),
    variant: text("variant").notNull(),
    repository: text("repository").notNull(),
    revision: text("revision").notNull(),
    runtime: text("runtime").notNull(),
    format: text("format").notNull(),
    quantization: text("quantization").notNull(),
    managedPath: text("managed_path"),
    expectedSizeBytes: bigint("expected_size_bytes", { mode: "number" }).notNull(),
    installedSizeBytes: bigint("installed_size_bytes", { mode: "number" }).notNull().default(0),
    manifestHash: text("manifest_hash").notNull(),
    capabilities: jsonb("capabilities").notNull().default(sql`'[]'::jsonb`),
    defaultParameters: jsonb("default_parameters").notNull().default(sql`'{}'::jsonb`),
    licenseName: text("license_name").notNull(),
    licenseUrl: text("license_url").notNull(),
    licenseAcceptedAt: timestamp("license_accepted_at", { withTimezone: true }),
    status: text("status").notNull().default("not_downloaded"),
    lastError: text("last_error"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    catalogUidx: uniqueIndex("local_models_catalog_id_uidx").on(table.catalogId),
    runtimeIdx: index("local_models_runtime_idx").on(table.runtime),
    statusIdx: index("local_models_status_idx").on(table.status)
  })
);

export const localModelFiles = pgTable(
  "local_model_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    localModelId: uuid("local_model_id")
      .notNull()
      .references(() => localModels.id, { onDelete: "cascade" }),
    relativePath: text("relative_path").notNull(),
    expectedSizeBytes: bigint("expected_size_bytes", { mode: "number" }).notNull(),
    downloadedSizeBytes: bigint("downloaded_size_bytes", { mode: "number" }).notNull().default(0),
    sha256: text("sha256").notNull(),
    status: text("status").notNull().default("pending"),
    ...timestamps
  },
  (table) => ({
    modelPathUidx: uniqueIndex("local_model_files_model_path_uidx").on(table.localModelId, table.relativePath),
    statusIdx: index("local_model_files_status_idx").on(table.status)
  })
);

export const localModelDownloads = pgTable(
  "local_model_downloads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    localModelId: uuid("local_model_id")
      .notNull()
      .references(() => localModels.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    currentFile: text("current_file"),
    downloadedBytes: bigint("downloaded_bytes", { mode: "number" }).notNull().default(0),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
    bytesPerSecond: bigint("bytes_per_second", { mode: "number" }).notNull().default(0),
    etaSeconds: integer("eta_seconds"),
    checkpoint: jsonb("checkpoint").notNull().default(sql`'{}'::jsonb`),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => ({
    jobUidx: uniqueIndex("local_model_downloads_job_id_uidx").on(table.jobId),
    modelIdx: index("local_model_downloads_model_id_idx").on(table.localModelId)
  })
);

export const aiProfileSets = pgTable(
  "ai_profile_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    isDefault: boolean("is_default").notNull().default(false),
    privacyMode: text("privacy_mode").notNull().default("allow_remote"),
    outputLanguage: varchar("output_language", { length: 16 }).notNull().default("ui"),
    providerConfigId: uuid("provider_config_id").references(() => aiProviderConfigs.id, {
      onDelete: "set null"
    }),
    localModelId: uuid("local_model_id").references(() => localModels.id, { onDelete: "set null" }),
    modelId: text("model_id"),
    runtime: text("runtime"),
    capabilities: jsonb("capabilities").notNull().default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("active"),
    ...timestamps
  },
  (table) => ({ defaultIdx: index("ai_profile_sets_default_idx").on(table.isDefault) })
);

export const aiProfileTasks = pgTable(
  "ai_profile_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => aiProfileSets.id, { onDelete: "cascade" }),
    task: text("task").notNull(),
    parameters: jsonb("parameters").notNull().default(sql`'{}'::jsonb`),
    fallbackPolicy: text("fallback_policy").notNull().default("block"),
    status: text("status").notNull().default("active"),
    ...timestamps
  },
  (table) => ({
    profileTaskUidx: uniqueIndex("ai_profile_tasks_profile_task_uidx").on(table.profileId, table.task)
  })
);

export const aiTaskProfileRoutes = pgTable(
  "ai_task_profile_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    task: text("task").notNull(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => aiProfileSets.id, { onDelete: "cascade" }),
    ...timestamps
  },
  (table) => ({
    taskUidx: uniqueIndex("ai_task_profile_routes_task_uidx").on(table.task),
    profileIdx: index("ai_task_profile_routes_profile_id_idx").on(table.profileId)
  })
);

export const aiModelCapabilities = pgTable(
  "ai_model_capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerConfigId: uuid("provider_config_id").references(() => aiProviderConfigs.id, {
      onDelete: "cascade"
    }),
    modelId: text("model_id").notNull(),
    capability: text("capability").notNull(),
    limits: jsonb("limits").notNull().default(sql`'{}'::jsonb`),
    requirements: jsonb("requirements").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("available"),
    ...timestamps
  },
  (table) => ({
    modelCapabilityUidx: uniqueIndex("ai_model_capabilities_model_capability_uidx").on(
      table.providerConfigId,
      table.modelId,
      table.capability
    )
  })
);

export const aiTaskRuns = pgTable(
  "ai_task_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id").references(() => aiProfileSets.id, { onDelete: "set null" }),
    taskType: text("task_type").notNull(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    runtime: text("runtime").notNull(),
    adapter: text("adapter"),
    repository: text("repository"),
    revision: text("revision"),
    quantization: text("quantization"),
    parameters: jsonb("parameters").notNull().default(sql`'{}'::jsonb`),
    capabilitiesUsed: jsonb("capabilities_used").notNull().default(sql`'[]'::jsonb`),
    inputHash: text("input_hash"),
    outputHash: text("output_hash"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costEstimate: doublePrecision("cost_estimate"),
    durationMs: integer("duration_ms").notNull(),
    status: text("status").notNull(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true })
  },
  (table) => ({ taskIdx: index("ai_task_runs_task_type_idx").on(table.taskType) })
);

export const sourceSummaries = pgTable(
  "source_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    generationId: uuid("generation_id").references(() => knowledgeGenerations.id, { onDelete: "set null" }),
    isCurrent: boolean("is_current").notNull().default(true),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    language: varchar("language", { length: 16 }).notNull().default("und"),
    profileId: uuid("profile_id").references(() => aiProfileSets.id, { onDelete: "set null" }),
    aiTaskRunId: uuid("ai_task_run_id").references(() => aiTaskRuns.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    runtime: text("runtime").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputHash: text("input_hash").notNull(),
    outputHash: text("output_hash").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    sourceItemIdx: index("source_summaries_source_item_id_idx").on(table.sourceItemId),
    generatedAtIdx: index("source_summaries_generated_at_idx").on(table.generatedAt),
    currentSourceUidx: uniqueIndex("source_summaries_current_source_uidx").on(table.sourceItemId).where(sql`${table.isCurrent} = true`)
  })
);

export const atomicNotes = pgTable(
  "atomic_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    generationId: uuid("generation_id").references(() => knowledgeGenerations.id, { onDelete: "set null" }),
    supersessionStatus: text("supersession_status").notNull().default("current"),
    title: text("title").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    ideaStatement: text("idea_statement").notNull(),
    language: varchar("language", { length: 16 }).notNull().default("und"),
    status: atomicNoteStatus("status").notNull().default("pending_review"),
    createdFromSourceItemId: uuid("created_from_source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    sourceSpanId: uuid("source_span_id").references(() => sourceSpans.id, { onDelete: "set null" }),
    evidenceChunkId: uuid("evidence_chunk_id")
      .notNull()
      .references(() => chunks.id, { onDelete: "cascade" }),
    generationProfileId: uuid("generation_profile_id").references(() => aiProfileSets.id, { onDelete: "set null" }),
    aiTaskRunId: uuid("ai_task_run_id").references(() => aiTaskRuns.id, { onDelete: "set null" }),
    generationProvider: text("generation_provider").notNull(),
    generationModel: text("generation_model").notNull(),
    generationRuntime: text("generation_runtime").notNull(),
    generationPromptVersion: text("generation_prompt_version").notNull(),
    generationKey: text("generation_key").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => ({
    sourceItemIdx: index("atomic_notes_source_item_id_idx").on(table.createdFromSourceItemId),
    statusIdx: index("atomic_notes_status_idx").on(table.status),
    sourceGenerationUidx: uniqueIndex("atomic_notes_source_generation_key_uidx").on(
      table.createdFromSourceItemId,
      table.generationId,
      table.generationKey
    )
  })
);

export const atomicNoteSourceLinks = pgTable(
  "atomic_note_source_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    atomicNoteId: uuid("atomic_note_id")
      .notNull()
      .references(() => atomicNotes.id, { onDelete: "cascade" }),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    chunkId: uuid("chunk_id")
      .notNull()
      .references(() => chunks.id, { onDelete: "cascade" }),
    sourceSpanId: uuid("source_span_id").references(() => sourceSpans.id, { onDelete: "set null" }),
    claimId: uuid("claim_id").references(() => claims.id, { onDelete: "set null" }),
    relationType: text("relation_type").notNull().default("derived_from"),
    confidence: doublePrecision("confidence"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    noteIdx: index("atomic_note_source_links_note_id_idx").on(table.atomicNoteId),
    sourceIdx: index("atomic_note_source_links_source_id_idx").on(table.sourceItemId),
    noteChunkUidx: uniqueIndex("atomic_note_source_links_note_chunk_uidx").on(table.atomicNoteId, table.chunkId)
  })
);

export const atomicNoteEntityLinks = pgTable(
  "atomic_note_entity_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    atomicNoteId: uuid("atomic_note_id").notNull().references(() => atomicNotes.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id").notNull().references(() => entities.id, { onDelete: "cascade" }),
    relationType: text("relation_type").notNull().default("about"),
    confidence: doublePrecision("confidence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    noteEntityUidx: uniqueIndex("atomic_note_entity_links_note_entity_uidx").on(table.atomicNoteId, table.entityId),
    entityIdx: index("atomic_note_entity_links_entity_id_idx").on(table.entityId)
  })
);

export const atomicNoteRelations = pgTable(
  "atomic_note_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceAtomicNoteId: uuid("source_atomic_note_id")
      .notNull()
      .references(() => atomicNotes.id, { onDelete: "cascade" }),
    targetAtomicNoteId: uuid("target_atomic_note_id")
      .notNull()
      .references(() => atomicNotes.id, { onDelete: "cascade" }),
    relationType: text("relation_type").notNull().default("related"),
    vectorScore: doublePrecision("vector_score"),
    graphScore: doublePrecision("graph_score"),
    rerankScore: doublePrecision("rerank_score"),
    finalScore: doublePrecision("final_score").notNull(),
    explanation: text("explanation").notNull(),
    status: atomicNoteRelationStatus("status").notNull().default("pending_review"),
    matchingProfileId: uuid("matching_profile_id").references(() => aiProfileSets.id, { onDelete: "set null" }),
    matchingModel: text("matching_model"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    sourceIdx: index("atomic_note_relations_source_id_idx").on(table.sourceAtomicNoteId),
    targetIdx: index("atomic_note_relations_target_id_idx").on(table.targetAtomicNoteId),
    sourceTargetUidx: uniqueIndex("atomic_note_relations_source_target_uidx").on(
      table.sourceAtomicNoteId,
      table.targetAtomicNoteId
    )
  })
);

export const atomicNoteReviewEvents = pgTable(
  "atomic_note_review_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    atomicNoteId: uuid("atomic_note_id")
      .notNull()
      .references(() => atomicNotes.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    previousStatus: atomicNoteStatus("previous_status").notNull(),
    nextStatus: atomicNoteStatus("next_status").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    noteIdx: index("atomic_note_review_events_note_id_idx").on(table.atomicNoteId)
  })
);

function createEmbeddingColumns() {
  return {
    id: uuid("id").primaryKey().defaultRandom(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    chunkId: uuid("chunk_id").references(() => chunks.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    runtime: text("runtime").notNull(),
    usage: text("usage").notNull().default("retrieval"),
    strategy: text("strategy").notNull().default("native"),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  };
}

export const embeddings256 = pgTable(
  "embeddings_256",
  { ...createEmbeddingColumns(), embedding: vector256("embedding").notNull() },
  (table) => ({
    targetUidx: uniqueIndex("embeddings_256_target_model_uidx").on(table.targetType, table.targetId, table.model),
    chunkIdx: index("embeddings_256_chunk_id_idx").on(table.chunkId)
  })
);

export const embeddings768 = pgTable(
  "embeddings_768",
  { ...createEmbeddingColumns(), embedding: vector768("embedding").notNull() },
  (table) => ({
    targetUidx: uniqueIndex("embeddings_768_target_model_uidx").on(table.targetType, table.targetId, table.model),
    chunkIdx: index("embeddings_768_chunk_id_idx").on(table.chunkId)
  })
);

export const embeddings1024 = pgTable(
  "embeddings_1024",
  { ...createEmbeddingColumns(), embedding: vector1024("embedding").notNull() },
  (table) => ({
    targetUidx: uniqueIndex("embeddings_1024_target_model_uidx").on(table.targetType, table.targetId, table.model),
    chunkIdx: index("embeddings_1024_chunk_id_idx").on(table.chunkId)
  })
);

export const similarityDebugRuns = pgTable(
  "similarity_debug_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    queryText: text("query_text").notNull(),
    queryTargetId: uuid("query_target_id"),
    mode: text("mode").notNull(),
    model: text("model"),
    dimensions: integer("dimensions"),
    requestedLimit: integer("requested_limit").notNull(),
    strategy: text("strategy").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    kindCreatedIdx: index("similarity_debug_runs_kind_created_at_idx").on(table.kind, table.createdAt)
  })
);

export const similarityDebugResults = pgTable(
  "similarity_debug_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => similarityDebugRuns.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    targetLabel: text("target_label"),
    finalRank: integer("final_rank").notNull(),
    textRank: integer("text_rank"),
    vectorRank: integer("vector_rank"),
    graphRank: integer("graph_rank"),
    textScore: doublePrecision("text_score"),
    vectorScore: doublePrecision("vector_score"),
    metadataScore: doublePrecision("metadata_score"),
    graphScore: doublePrecision("graph_score"),
    rerankScore: doublePrecision("rerank_score"),
    fusionScore: doublePrecision("fusion_score"),
    finalScore: doublePrecision("final_score").notNull(),
    passedThreshold: boolean("passed_threshold"),
    explanation: text("explanation"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    runRankIdx: index("similarity_debug_results_run_rank_idx").on(table.runId, table.finalRank)
  })
);

export const sourceItemsRelations = relations(sourceItems, ({ many }) => ({
  documents: many(documents),
  assets: many(documentAssets),
  spans: many(sourceSpans),
  chunks: many(chunks),
  ingestionRuns: many(ingestionRuns),
  obsidianSyncFiles: many(obsidianSyncFiles),
  summaries: many(sourceSummaries),
  atomicNotes: many(atomicNotes)
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  sourceItem: one(sourceItems, {
    fields: [documents.sourceItemId],
    references: [sourceItems.id]
  }),
  assets: many(documentAssets),
  spans: many(sourceSpans),
  chunks: many(chunks),
  obsidianSyncFiles: many(obsidianSyncFiles)
}));

export const jobsRelations = relations(jobs, ({ many }) => ({
  ingestionRuns: many(ingestionRuns)
}));
