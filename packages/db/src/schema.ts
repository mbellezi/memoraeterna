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

export const sourceItemType = pgEnum("source_item_type", [
  "PersonalNote",
  "DailyNote",
  "WebArticle",
  "Book",
  "BookChapter",
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

export const ingestionRuns = pgTable(
  "ingestion_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceItemId: uuid("source_item_id").references(() => sourceItems.id, { onDelete: "set null" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
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
    sourceItemId: uuid("source_item_id").references(() => sourceItems.id, { onDelete: "set null" }),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
    memoraType: text("memora_type").notNull(),
    relativePath: text("relative_path").notNull(),
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
    status: text("status").notNull().default("configured"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({ providerIdx: index("ai_provider_configs_provider_idx").on(table.provider) })
);

export const aiProfileSets = pgTable(
  "ai_profile_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    isDefault: boolean("is_default").notNull().default(false),
    privacyMode: text("privacy_mode").notNull().default("allow_remote"),
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
    providerConfigId: uuid("provider_config_id").references(() => aiProviderConfigs.id, {
      onDelete: "set null"
    }),
    modelId: text("model_id").notNull(),
    runtime: text("runtime").notNull().default("remote"),
    requiredCapabilities: jsonb("required_capabilities").notNull().default(sql`'[]'::jsonb`),
    parameters: jsonb("parameters").notNull().default(sql`'{}'::jsonb`),
    fallbackPolicy: text("fallback_policy").notNull().default("block"),
    status: text("status").notNull().default("active"),
    ...timestamps
  },
  (table) => ({
    profileTaskUidx: uniqueIndex("ai_profile_tasks_profile_task_uidx").on(table.profileId, table.task)
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
    generatedAtIdx: index("source_summaries_generated_at_idx").on(table.generatedAt)
  })
);

export const atomicNotes = pgTable(
  "atomic_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
    claimId: uuid("claim_id"),
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
