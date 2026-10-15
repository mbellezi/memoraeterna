import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
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

const bytea = customType<{ data: Buffer }>({
  dataType: () => "bytea"
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
  "ignored",
  "retired"
]);

export const atomicNoteStatus = pgEnum("atomic_note_status", [
  "active",
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

export const obsidianLayoutMigrations = pgTable(
  "obsidian_layout_migrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    binding: text("binding").notNull(),
    status: text("status").notNull().default("preview"),
    config: jsonb("config").notNull(),
    previousConfig: jsonb("previous_config"),
    targets: jsonb("targets").notNull(),
    ...timestamps
  },
  (t) => [index("obsidian_layout_binding_idx").on(t.binding, t.createdAt)]
);

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
    parentSourceItemId: uuid("parent_source_item_id").references(
      (): AnyPgColumn => sourceItems.id,
      {
        onDelete: "set null"
      }
    ),
    contentHash: text("content_hash"),
    language: varchar("language", { length: 16 }).notNull().default("und"),
    summary: text("summary"),
    summaryGeneratedAt: timestamp("summary_generated_at", { withTimezone: true }),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    typeIdx: index("source_items_type_idx").on(table.type),
    sourceUriIdx: index("source_items_source_uri_idx").on(table.sourceUri),
    contentHashIdx: index("source_items_content_hash_idx").on(table.contentHash),
    externalIdIdx: index("source_items_external_id_idx").on(table.externalId),
    parentSourceItemIdx: index("source_items_parent_source_item_id_idx").on(
      table.parentSourceItemId
    )
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
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    supersedesRevisionId: uuid("supersedes_revision_id").references(
      (): AnyPgColumn => documentRevisions.id,
      { onDelete: "set null" }
    ),
    isCurrent: boolean("is_current").notNull().default(true),
    contentHash: text("content_hash").notNull(),
    structureHash: text("structure_hash"),
    createdByIngestionRunId: uuid("created_by_ingestion_run_id"),
    reason: text("reason").notNull().default("initial"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    documentRevisionUidx: uniqueIndex("document_revisions_document_revision_uidx").on(
      table.documentId,
      table.revision
    ),
    currentDocumentUidx: uniqueIndex("document_revisions_current_document_uidx")
      .on(table.documentId)
      .where(sql`${table.isCurrent} = true`)
  })
);

export const documentStructures = pgTable(
  "document_structures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rootSourceItemId: uuid("root_source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    rootDocumentId: uuid("root_document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    format: text("format").notNull(),
    detectorVersion: text("detector_version").notNull(),
    status: documentStructureStatus("status").notNull().default("draft"),
    overallConfidence: doublePrecision("overall_confidence").notNull(),
    revision: integer("revision").notNull().default(1),
    rawEvidence: jsonb("raw_evidence")
      .notNull()
      .default(sql`'{}'::jsonb`),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: text("confirmed_by"),
    supersedesStructureId: uuid("supersedes_structure_id").references(
      (): AnyPgColumn => documentStructures.id,
      { onDelete: "set null" }
    ),
    ...timestamps
  },
  (table) => ({
    rootRevisionUidx: uniqueIndex("document_structures_root_revision_uidx").on(
      table.rootSourceItemId,
      table.revision
    ),
    rootStatusIdx: index("document_structures_root_status_idx").on(
      table.rootSourceItemId,
      table.status
    )
  })
);

export const documentDivisions = pgTable(
  "document_divisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stableId: uuid("stable_id").notNull(),
    structureId: uuid("structure_id")
      .notNull()
      .references(() => documentStructures.id, { onDelete: "cascade" }),
    parentDivisionId: uuid("parent_division_id").references(
      (): AnyPgColumn => documentDivisions.id,
      { onDelete: "cascade" }
    ),
    childSourceItemId: uuid("child_source_item_id").references(() => sourceItems.id, {
      onDelete: "set null"
    }),
    childDocumentId: uuid("child_document_id").references(() => documents.id, {
      onDelete: "set null"
    }),
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
    evidence: jsonb("evidence")
      .notNull()
      .default(sql`'[]'::jsonb`),
    reviewStatus: documentDivisionReviewStatus("review_status").notNull().default("proposed"),
    isProcessable: boolean("is_processable").notNull().default(true),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    structureIdx: index("document_divisions_structure_id_idx").on(table.structureId),
    structureStableUidx: uniqueIndex("document_divisions_structure_stable_uidx").on(
      table.structureId,
      table.stableId
    ),
    childSourceIdx: index("document_divisions_child_source_idx").on(table.childSourceItemId),
    siblingPositionUidx: uniqueIndex("document_divisions_sibling_position_uidx")
      .on(table.structureId, table.parentDivisionId, table.position)
      .where(sql`${table.parentDivisionId} is not null`),
    rootPositionUidx: uniqueIndex("document_divisions_root_position_uidx")
      .on(table.structureId, table.position)
      .where(sql`${table.parentDivisionId} is null`)
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
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    documentIdx: index("document_assets_document_id_idx").on(table.documentId),
    sourceItemIdx: index("document_assets_source_item_id_idx").on(table.sourceItemId),
    sha256Idx: index("document_assets_sha256_idx").on(table.sha256),
    storagePathIdx: index("document_assets_storage_path_idx").on(
      table.storageBase,
      table.relativePath
    )
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
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    documentIdx: index("chunks_document_id_idx").on(table.documentId),
    sourceItemIdx: index("chunks_source_item_id_idx").on(table.sourceItemId),
    documentChunkUidx: uniqueIndex("chunks_document_chunk_index_uidx").on(
      table.documentId,
      table.chunkIndex
    )
  })
);

export const entities = pgTable(
  "entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    canonicalName: text("canonical_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    aliases: jsonb("aliases")
      .notNull()
      .default(sql`'[]'::jsonb`),
    description: text("description"),
    language: varchar("language", { length: 16 }).notNull().default("und"),
    confidence: doublePrecision("confidence").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    typeNameIdx: index("entities_type_normalized_name_idx").on(table.type, table.normalizedName),
    canonicalNameIdx: index("entities_canonical_name_idx").on(table.canonicalName)
  })
);

export const entityIdentityKeys = pgTable("entity_identity_keys", {
  fingerprint: text("fingerprint").primaryKey(),
  entityId: uuid("entity_id")
    .notNull()
    .references(() => entities.id, { onDelete: "cascade" }),
  sourceItemId: uuid("source_item_id").references(() => sourceItems.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const entityIdentityEmbeddings256 = pgTable(
  "entity_identity_embeddings_256",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    spaceKey: text("space_key").notNull(),
    contentHash: text("content_hash").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    runtime: text("runtime").notNull(),
    embedding: vector256("embedding").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    entitySpaceUidx: uniqueIndex("entity_identity_embeddings_256_entity_space_uidx").on(
      table.entityId,
      table.spaceKey
    )
  })
);

export const entityIdentityEmbeddings768 = pgTable(
  "entity_identity_embeddings_768",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    spaceKey: text("space_key").notNull(),
    contentHash: text("content_hash").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    runtime: text("runtime").notNull(),
    embedding: vector768("embedding").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    entitySpaceUidx: uniqueIndex("entity_identity_embeddings_768_entity_space_uidx").on(
      table.entityId,
      table.spaceKey
    )
  })
);

export const entityIdentityEmbeddings1024 = pgTable(
  "entity_identity_embeddings_1024",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    spaceKey: text("space_key").notNull(),
    contentHash: text("content_hash").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    runtime: text("runtime").notNull(),
    embedding: vector1024("embedding").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    entitySpaceUidx: uniqueIndex("entity_identity_embeddings_1024_entity_space_uidx").on(
      table.entityId,
      table.spaceKey
    )
  })
);

export const entityMentions = pgTable(
  "entity_mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    chunkId: uuid("chunk_id")
      .notNull()
      .references(() => chunks.id, { onDelete: "cascade" }),
    sourceSpanId: uuid("source_span_id").references(() => sourceSpans.id, { onDelete: "set null" }),
    surfaceText: text("surface_text").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    sourceIdx: index("entity_mentions_source_item_id_idx").on(table.sourceItemId),
    chunkIdx: index("entity_mentions_chunk_id_idx").on(table.chunkId),
    entityChunkUidx: uniqueIndex("entity_mentions_entity_chunk_uidx").on(
      table.entityId,
      table.chunkId
    )
  })
);

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    evidenceChunkId: uuid("evidence_chunk_id")
      .notNull()
      .references(() => chunks.id, { onDelete: "cascade" }),
    sourceSpanId: uuid("source_span_id").references(() => sourceSpans.id, { onDelete: "set null" }),
    text: text("text").notNull(),
    contentHash: text("content_hash").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    sourceIdx: index("claims_source_item_id_idx").on(table.sourceItemId),
    evidenceIdx: index("claims_evidence_chunk_id_idx").on(table.evidenceChunkId),
    sourceHashUidx: uniqueIndex("claims_source_content_hash_uidx").on(
      table.sourceItemId,
      table.contentHash
    )
  })
);

export const claimEntityLinks = pgTable(
  "claim_entity_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    claimEntityUidx: uniqueIndex("claim_entity_links_claim_entity_uidx").on(
      table.claimId,
      table.entityId
    ),
    entityIdx: index("claim_entity_links_entity_id_idx").on(table.entityId)
  })
);

export const relationTypes = pgTable(
  "relation_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    predicate: text("predicate").notNull(),
    definition: text("definition").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({ predicateUidx: uniqueIndex("relation_types_predicate_uidx").on(table.predicate) })
);

export const relationTypeAliases = pgTable("relation_type_aliases", {
  alias: text("alias").primaryKey(),
  relationTypeId: uuid("relation_type_id")
    .notNull()
    .references(() => relationTypes.id, { onDelete: "cascade" }),
  metadata: jsonb("metadata")
    .notNull()
    .default(sql`'{}'::jsonb`),
  ...timestamps
});

export const relationTypeEmbeddings256 = pgTable(
  "relation_type_embeddings_256",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    relationTypeId: uuid("relation_type_id")
      .notNull()
      .references(() => relationTypes.id, { onDelete: "cascade" }),
    spaceKey: text("space_key").notNull(),
    contentHash: text("content_hash").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    runtime: text("runtime").notNull(),
    embedding: vector256("embedding").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    typeSpaceUidx: uniqueIndex("relation_type_embeddings_256_type_space_uidx").on(
      table.relationTypeId,
      table.spaceKey
    )
  })
);

export const relationTypeEmbeddings768 = pgTable(
  "relation_type_embeddings_768",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    relationTypeId: uuid("relation_type_id")
      .notNull()
      .references(() => relationTypes.id, { onDelete: "cascade" }),
    spaceKey: text("space_key").notNull(),
    contentHash: text("content_hash").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    runtime: text("runtime").notNull(),
    embedding: vector768("embedding").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    typeSpaceUidx: uniqueIndex("relation_type_embeddings_768_type_space_uidx").on(
      table.relationTypeId,
      table.spaceKey
    )
  })
);

export const relationTypeEmbeddings1024 = pgTable(
  "relation_type_embeddings_1024",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    relationTypeId: uuid("relation_type_id")
      .notNull()
      .references(() => relationTypes.id, { onDelete: "cascade" }),
    spaceKey: text("space_key").notNull(),
    contentHash: text("content_hash").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    runtime: text("runtime").notNull(),
    embedding: vector1024("embedding").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    typeSpaceUidx: uniqueIndex("relation_type_embeddings_1024_type_space_uidx").on(
      table.relationTypeId,
      table.spaceKey
    )
  })
);

export const entityRelations = pgTable(
  "entity_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectEntityId: uuid("subject_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    predicate: text("predicate").notNull(),
    relationTypeId: uuid("relation_type_id").references(() => relationTypes.id, {
      onDelete: "restrict"
    }),
    objectEntityId: uuid("object_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    evidenceChunkId: uuid("evidence_chunk_id")
      .notNull()
      .references(() => chunks.id, { onDelete: "cascade" }),
    sourceSpanId: uuid("source_span_id").references(() => sourceSpans.id, { onDelete: "set null" }),
    confidence: doublePrecision("confidence").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    sourceIdx: index("entity_relations_source_item_id_idx").on(table.sourceItemId),
    subjectIdx: index("entity_relations_subject_entity_id_idx").on(table.subjectEntityId),
    objectIdx: index("entity_relations_object_entity_id_idx").on(table.objectEntityId),
    evidenceUidx: uniqueIndex("entity_relations_evidence_uidx").on(
      table.sourceItemId,
      table.subjectEntityId,
      table.predicate,
      table.objectEntityId,
      table.evidenceChunkId
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
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    /** `heavy` (ingestion) or `light` (tree and projection work); each lane has its own workers. */
    lane: text("lane").notNull().default("heavy"),
    /** At most one queued job per key. Claiming or retrying a job drops its key. */
    dedupeKey: text("dedupe_key"),
    ...timestamps
  },
  (table) => ({
    queueIdx: index("jobs_queue_idx").on(table.status, table.priority, table.runAfter),
    lockedIdx: index("jobs_locked_idx").on(table.lockedBy, table.lockedAt),
    laneQueueIdx: index("jobs_lane_queue_idx")
      .on(table.lane, table.priority.desc().nullsFirst(), table.runAfter)
      .where(sql`${table.status} = 'queued'`),
    dedupeQueuedUidx: uniqueIndex("jobs_dedupe_queued_uidx")
      .on(table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null and ${table.status} = 'queued'`),
    laneCheck: check("jobs_lane", sql`${table.lane} in ('heavy','light')`),
    dedupeKeyCheck: check(
      "jobs_dedupe_key",
      sql`${table.dedupeKey} is null or char_length(${table.dedupeKey}) between 1 and 200`
    )
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
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    requestedStages: jsonb("requested_stages")
      .notNull()
      .default(sql`'[]'::jsonb`),
    effectiveStages: jsonb("effective_stages")
      .notNull()
      .default(sql`'[]'::jsonb`),
    planVersion: text("plan_version").notNull().default("1"),
    inputDocumentRevisionId: uuid("input_document_revision_id").references(
      () => documentRevisions.id,
      { onDelete: "set null" }
    ),
    inputHashes: jsonb("input_hashes")
      .notNull()
      .default(sql`'{}'::jsonb`),
    supersedesRunId: uuid("supersedes_run_id").references((): AnyPgColumn => ingestionRuns.id, {
      onDelete: "set null"
    }),
    previousArtifactPolicy: text("previous_artifact_policy").notNull().default("reuse_valid"),
    trigger: text("trigger").notNull().default("interactive_import"),
    status: ingestionRunStatus("status").notNull().default("pending"),
    currentStage: text("current_stage").notNull().default("queued"),
    stagesCheckpoint: jsonb("stages_checkpoint")
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    ingestionRunId: uuid("ingestion_run_id")
      .notNull()
      .references(() => ingestionRuns.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    status: ingestionRunStageStatus("status").notNull().default("pending"),
    skipReason: text("skip_reason"),
    progress: integer("progress").notNull().default(0),
    inputHash: text("input_hash"),
    outputHash: text("output_hash"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // First time the stage began; kept across retries, so it spans every attempt and the waits between them.
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Wall-clock instrumentation. `attempts` counts transitions into running (0 = not recorded);
    // `attemptStartedAt` and `endedAt` bound the latest attempt whatever its outcome (completed,
    // skipped, failed or canceled); `endedAt` is null while an attempt is running or unrecorded.
    attempts: integer("attempts").notNull().default(0),
    attemptStartedAt: timestamp("attempt_started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    error: text("error"),
    ...timestamps
  },
  (table) => ({
    runStageUidx: uniqueIndex("ingestion_run_stages_run_stage_uidx").on(
      table.ingestionRunId,
      table.stage
    ),
    statusIdx: index("ingestion_run_stages_status_idx").on(table.status)
  })
);

export const knowledgeGenerations = pgTable(
  "knowledge_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    documentRevisionId: uuid("document_revision_id").references(() => documentRevisions.id, {
      onDelete: "set null"
    }),
    stage: text("stage").notNull(),
    ingestionRunId: uuid("ingestion_run_id").references(() => ingestionRuns.id, {
      onDelete: "set null"
    }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    aiTaskRunId: uuid("ai_task_run_id"),
    supersedesGenerationId: uuid("supersedes_generation_id").references(
      (): AnyPgColumn => knowledgeGenerations.id,
      { onDelete: "set null" }
    ),
    status: text("status").notNull().default("current"),
    inputHash: text("input_hash"),
    outputHash: text("output_hash"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    sourceStageIdx: index("knowledge_generations_source_stage_idx").on(
      table.sourceItemId,
      table.stage,
      table.status
    ),
    runStageUidx: uniqueIndex("knowledge_generations_run_stage_uidx")
      .on(table.ingestionRunId, table.stage)
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

// Local, non-telemetry record of the objects the user opened: one row per object address
// (`memora://<kind>/<id>`), with a title snapshot, the last open time, an open count and a pin.
// It holds no foreign keys: an object that no longer exists is simply left out of reads.
export const viewHistory = pgTable(
  "view_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    objectId: uuid("object_id").notNull(),
    address: text("address").notNull(),
    title: text("title").notNull(),
    // The object that hosted this open (a note opened inside its source), to open it again.
    parentAddress: text("parent_address"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    openCount: integer("open_count").notNull().default(1),
    pinned: boolean("pinned").notNull().default(false),
    pinnedAt: timestamp("pinned_at", { withTimezone: true })
  },
  (table) => ({
    addressUidx: uniqueIndex("view_history_address_uidx").on(table.address),
    orderIdx: index("view_history_order_idx").on(table.pinned, table.openedAt),
    kindCheck: check(
      "view_history_kind",
      sql`${table.kind} in ('source','note','topic','question','entity')`
    ),
    addressCheck: check(
      "view_history_address",
      sql`${table.address} = 'memora://' || ${table.kind} || '/' || ${table.objectId}::text`
    ),
    titleCheck: check("view_history_title", sql`char_length(${table.title}) between 1 and 300`),
    countCheck: check("view_history_open_count", sql`${table.openCount} >= 1`),
    pinCheck: check("view_history_pin", sql`(${table.pinned}) = (${table.pinnedAt} is not null)`),
    parentCheck: check(
      "view_history_parent",
      sql`${table.parentAddress} is null or ${table.parentAddress} like 'memora://%/%'`
    )
  })
);

export const integrationClients = pgTable(
  "integration_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientType: text("client_type").notNull(),
    displayName: text("display_name").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopes: jsonb("scopes")
      .notNull()
      .default(sql`'[]'::jsonb`),
    capabilities: jsonb("capabilities")
      .notNull()
      .default(sql`'[]'::jsonb`),
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
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    creators: jsonb("creators")
      .notNull()
      .default(sql`'[]'::jsonb`),
    identifiers: jsonb("identifiers")
      .notNull()
      .default(sql`'{}'::jsonb`),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    creators: jsonb("creators")
      .notNull()
      .default(sql`'[]'::jsonb`),
    pageCount: integer("page_count"),
    series: text("series"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    instanceId: uuid("instance_id").references(() => bibliographicInstances.id, {
      onDelete: "set null"
    }),
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
    defaultParameters: jsonb("default_parameters")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("configured"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    capabilities: jsonb("capabilities")
      .notNull()
      .default(sql`'[]'::jsonb`),
    defaultParameters: jsonb("default_parameters")
      .notNull()
      .default(sql`'{}'::jsonb`),
    licenseName: text("license_name").notNull(),
    licenseUrl: text("license_url").notNull(),
    licenseAcceptedAt: timestamp("license_accepted_at", { withTimezone: true }),
    status: text("status").notNull().default("not_downloaded"),
    lastError: text("last_error"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    modelPathUidx: uniqueIndex("local_model_files_model_path_uidx").on(
      table.localModelId,
      table.relativePath
    ),
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
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    currentFile: text("current_file"),
    downloadedBytes: bigint("downloaded_bytes", { mode: "number" }).notNull().default(0),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
    bytesPerSecond: bigint("bytes_per_second", { mode: "number" }).notNull().default(0),
    etaSeconds: integer("eta_seconds"),
    checkpoint: jsonb("checkpoint")
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    capabilities: jsonb("capabilities")
      .notNull()
      .default(sql`'[]'::jsonb`),
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
    parameters: jsonb("parameters")
      .notNull()
      .default(sql`'{}'::jsonb`),
    fallbackPolicy: text("fallback_policy").notNull().default("block"),
    status: text("status").notNull().default("active"),
    ...timestamps
  },
  (table) => ({
    profileTaskUidx: uniqueIndex("ai_profile_tasks_profile_task_uidx").on(
      table.profileId,
      table.task
    )
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
    limits: jsonb("limits")
      .notNull()
      .default(sql`'{}'::jsonb`),
    requirements: jsonb("requirements")
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    parameters: jsonb("parameters")
      .notNull()
      .default(sql`'{}'::jsonb`),
    capabilitiesUsed: jsonb("capabilities_used")
      .notNull()
      .default(sql`'[]'::jsonb`),
    promptCompositions: jsonb("prompt_compositions")
      .notNull()
      .default(sql`'[]'::jsonb`),
    inputHash: text("input_hash"),
    outputHash: text("output_hash"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costEstimate: doublePrecision("cost_estimate"),
    durationMs: integer("duration_ms").notNull(),
    // Wall-clock instrumentation, null when unknown. `queueMs` is the wait between admission and the
    // start of execution in the AI execution queue; `attempt` is the caller's zero-based retry index
    // (0 = first try, 1 = first repair or retry) for pipeline calls that report one.
    queueMs: integer("queue_ms"),
    attempt: integer("attempt"),
    status: text("status").notNull(),
    error: text("error"),
    // The call's start: the row is written when the call ends, so it is stored as finishedAt - durationMs.
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true })
  },
  (table) => ({ taskIdx: index("ai_task_runs_task_type_idx").on(table.taskType) })
);

// Retain canonical task audit independently from user-prunable monitoring data.
export const monitoringOperations = pgTable(
  "monitoring_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    operation: text("operation").notNull(),
    taskType: text("task_type"),
    stage: text("stage").notNull(),
    context: jsonb("context")
      .notNull()
      .default(sql`'{}'::jsonb`),
    sources: jsonb("sources")
      .notNull()
      .default(sql`'[]'::jsonb`),
    provider: text("provider"),
    modelId: text("model_id"),
    runtime: text("runtime"),
    profileId: uuid("profile_id"),
    aiTaskRunId: uuid("ai_task_run_id").references(() => aiTaskRuns.id, { onDelete: "set null" }),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    tokenUsage: jsonb("token_usage")
      .notNull()
      .default(sql`'{}'::jsonb`),
    costEstimate: doublePrecision("cost_estimate"),
    parameters: jsonb("parameters")
      .notNull()
      .default(sql`'{}'::jsonb`),
    details: jsonb("details")
      .notNull()
      .default(sql`'{}'::jsonb`),
    debugRecorded: boolean("debug_recorded").notNull().default(false),
    input: jsonb("input"),
    output: jsonb("output"),
    error: text("error")
  },
  (table) => ({
    startedIdx: index("monitoring_operations_started_idx").on(table.startedAt, table.id),
    kindStatusIdx: index("monitoring_operations_kind_status_idx").on(
      table.kind,
      table.status,
      table.startedAt
    )
  })
);

export const aiTaskRunSources = pgTable(
  "ai_task_run_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    aiTaskRunId: uuid("ai_task_run_id")
      .notNull()
      .references(() => aiTaskRuns.id, { onDelete: "cascade" }),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    runSourceUidx: uniqueIndex("ai_task_run_sources_run_source_uidx").on(
      table.aiTaskRunId,
      table.sourceItemId
    ),
    sourceItemIdx: index("ai_task_run_sources_source_item_id_idx").on(table.sourceItemId)
  })
);

export const sourceSummaries = pgTable(
  "source_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    generationId: uuid("generation_id").references(() => knowledgeGenerations.id, {
      onDelete: "set null"
    }),
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
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    sourceItemIdx: index("source_summaries_source_item_id_idx").on(table.sourceItemId),
    generatedAtIdx: index("source_summaries_generated_at_idx").on(table.generatedAt),
    currentSourceUidx: uniqueIndex("source_summaries_current_source_uidx")
      .on(table.sourceItemId)
      .where(sql`${table.isCurrent} = true`)
  })
);

export const atomicNotes = pgTable(
  "atomic_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    generationId: uuid("generation_id").references(() => knowledgeGenerations.id, {
      onDelete: "set null"
    }),
    supersessionStatus: text("supersession_status").notNull().default("current"),
    title: text("title").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    ideaStatement: text("idea_statement").notNull(),
    language: varchar("language", { length: 16 }).notNull().default("und"),
    status: atomicNoteStatus("status").notNull().default("active"),
    createdFromSourceItemId: uuid("created_from_source_item_id").notNull(),
    ownership: text("ownership").notNull().default("source"),
    owningSourceItemId: uuid("owning_source_item_id").references(() => sourceItems.id, {
      onDelete: "cascade"
    }),
    owningChunkId: uuid("owning_chunk_id").references(() => chunks.id, { onDelete: "cascade" }),
    sourceSpanId: uuid("source_span_id").references(() => sourceSpans.id, { onDelete: "set null" }),
    evidenceChunkId: uuid("evidence_chunk_id").notNull(),
    generationProfileId: uuid("generation_profile_id").references(() => aiProfileSets.id, {
      onDelete: "set null"
    }),
    aiTaskRunId: uuid("ai_task_run_id").references(() => aiTaskRuns.id, { onDelete: "set null" }),
    generationProvider: text("generation_provider").notNull(),
    generationModel: text("generation_model").notNull(),
    generationRuntime: text("generation_runtime").notNull(),
    generationPromptVersion: text("generation_prompt_version").notNull(),
    generationKey: text("generation_key").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    noteChunkUidx: uniqueIndex("atomic_note_source_links_note_chunk_uidx").on(
      table.atomicNoteId,
      table.chunkId
    )
  })
);

export const atomicNoteEntityLinks = pgTable(
  "atomic_note_entity_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    atomicNoteId: uuid("atomic_note_id")
      .notNull()
      .references(() => atomicNotes.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    relationType: text("relation_type").notNull().default("about"),
    confidence: doublePrecision("confidence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    noteEntityUidx: uniqueIndex("atomic_note_entity_links_note_entity_uidx").on(
      table.atomicNoteId,
      table.entityId
    ),
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
    matchingProfileId: uuid("matching_profile_id").references(() => aiProfileSets.id, {
      onDelete: "set null"
    }),
    matchingModel: text("matching_model"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
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

// Relation decider verdicts on an unordered note pair, one row per pair and decider. Each direction
// keeps its raw score apart from calibration (thresholds), for the content hashes it was decided on,
// with the AI run and the time of its own decision.
export const relationDecisions = pgTable(
  "relation_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pairKey: text("pair_key").notNull(),
    loAtomicNoteId: uuid("lo_atomic_note_id")
      .notNull()
      .references(() => atomicNotes.id, { onDelete: "cascade" }),
    hiAtomicNoteId: uuid("hi_atomic_note_id")
      .notNull()
      .references(() => atomicNotes.id, { onDelete: "cascade" }),
    loContentHash: text("lo_content_hash").notNull(),
    hiContentHash: text("hi_content_hash").notNull(),
    deciderKey: text("decider_key").notNull(),
    loToHiScore: doublePrecision("lo_to_hi_score"),
    loToHiRelationType: text("lo_to_hi_relation_type"),
    loToHiAiTaskRunId: uuid("lo_to_hi_ai_task_run_id").references(() => aiTaskRuns.id, {
      onDelete: "set null"
    }),
    loToHiDecidedAt: timestamp("lo_to_hi_decided_at", { withTimezone: true }),
    hiToLoScore: doublePrecision("hi_to_lo_score"),
    hiToLoRelationType: text("hi_to_lo_relation_type"),
    hiToLoAiTaskRunId: uuid("hi_to_lo_ai_task_run_id").references(() => aiTaskRuns.id, {
      onDelete: "set null"
    }),
    hiToLoDecidedAt: timestamp("hi_to_lo_decided_at", { withTimezone: true }),
    relationType: text("relation_type"),
    accepted: boolean("accepted").notNull().default(false)
  },
  (table) => ({
    pairDeciderUidx: uniqueIndex("relation_decisions_pair_decider_uidx").on(
      table.pairKey,
      table.deciderKey
    ),
    loIdx: index("relation_decisions_lo_note_idx").on(table.loAtomicNoteId),
    hiIdx: index("relation_decisions_hi_note_idx").on(table.hiAtomicNoteId),
    pair: check(
      "relation_decisions_pair",
      sql`${table.loAtomicNoteId} < ${table.hiAtomicNoteId} and ${table.pairKey} = ${table.loAtomicNoteId}::text || ':' || ${table.hiAtomicNoteId}::text`
    ),
    directions: check(
      "relation_decisions_directions",
      sql`(${table.loToHiScore} is not null or ${table.hiToLoScore} is not null)
        and (${table.loToHiScore} is null) = (${table.loToHiRelationType} is null)
        and (${table.hiToLoScore} is null) = (${table.hiToLoRelationType} is null)
        and coalesce(${table.loToHiScore}, 0) between 0 and 1
        and coalesce(${table.hiToLoScore}, 0) between 0 and 1`
    ),
    decidedAt: check(
      "relation_decisions_decided_at",
      sql`(${table.loToHiScore} is null) = (${table.loToHiDecidedAt} is null)
        and (${table.hiToLoScore} is null) = (${table.hiToLoDecidedAt} is null)
        and (${table.loToHiScore} is not null or ${table.loToHiAiTaskRunId} is null)
        and (${table.hiToLoScore} is not null or ${table.hiToLoAiTaskRunId} is null)`
    ),
    accepted: check(
      "relation_decisions_accepted",
      sql`(${table.relationType} is not null) = ${table.accepted}`
    ),
    types: check(
      "relation_decisions_types",
      sql`coalesce(${table.loToHiRelationType}, 'related') in ('supports','contrasts','extends','similar_to','depends_on','clarifies','mentions','related')
        and coalesce(${table.hiToLoRelationType}, 'related') in ('supports','contrasts','extends','similar_to','depends_on','clarifies','mentions','related')
        and coalesce(${table.relationType}, 'related') in ('supports','contrasts','extends','similar_to','depends_on','clarifies','mentions','related')`
    )
  })
);

// The explanation of a note relation, written on demand when the owner opens the relation and cached
// for the inputs it was written from (`input_hash`: both notes' idea statements and evidence
// passages, the type and the direction). It is a derived annotation kept beside the relation row, so
// writing it never changes the relation (its fingerprint or the legacy wiki impacts of an update).
export const atomicNoteRelationExplanations = pgTable(
  "atomic_note_relation_explanations",
  {
    relationId: uuid("relation_id")
      .primaryKey()
      .references(() => atomicNoteRelations.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    inputHash: text("input_hash").notNull(),
    promptVersion: text("prompt_version").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    runtime: text("runtime").notNull(),
    aiTaskRunId: uuid("ai_task_run_id").references(() => aiTaskRuns.id, { onDelete: "set null" }),
    language: varchar("language", { length: 16 }).notNull(),
    writtenAt: timestamp("written_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    text: check(
      "atomic_note_relation_explanations_text",
      sql`char_length(${table.text}) between 1 and 4000`
    )
  })
);

export const sourceRelations = pgTable(
  "source_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    targetSourceItemId: uuid("target_source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    identityKey: text("identity_key").notNull(),
    relationType: text("relation_type").notNull(),
    // Prose written by the earlier matcher. Relations decided without prose (source-relations-v5)
    // leave it null; their explanation is written on open (source_relation_explanations).
    sourceIdea: text("source_idea"),
    targetIdea: text("target_idea"),
    explanation: text("explanation"),
    importance: doublePrecision("importance").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    status: atomicNoteRelationStatus("status").notNull().default("pending_review"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    identity: uniqueIndex("source_relations_identity_uidx").on(table.identityKey),
    source: index("source_relations_source_idx").on(table.sourceItemId),
    target: index("source_relations_target_idx").on(table.targetSourceItemId),
    endpoints: check(
      "source_relations_distinct_endpoints",
      sql`${table.sourceItemId} <> ${table.targetSourceItemId}`
    ),
    scores: check(
      "source_relations_scores",
      sql`${table.importance} between 0 and 1 and ${table.confidence} between 0 and 1`
    ),
    type: check(
      "source_relations_type",
      sql`${table.relationType} in ('supports','contrasts','extends','similar_to','depends_on','clarifies','mentions','related')`
    )
  })
);

export const sourceRelationEvidence = pgTable(
  "source_relation_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    relationId: uuid("relation_id")
      .notNull()
      .references(() => sourceRelations.id, { onDelete: "cascade" }),
    evidenceKey: text("evidence_key").notNull(),
    origin: text("origin").notNull(),
    sourceChunkId: uuid("source_chunk_id").references(() => chunks.id, { onDelete: "set null" }),
    targetChunkId: uuid("target_chunk_id").references(() => chunks.id, { onDelete: "set null" }),
    noteRelationId: uuid("note_relation_id").references(() => atomicNoteRelations.id, {
      onDelete: "set null"
    }),
    sourceNoteId: uuid("source_note_id").references(() => atomicNotes.id, { onDelete: "set null" }),
    targetNoteId: uuid("target_note_id").references(() => atomicNotes.id, { onDelete: "set null" }),
    snapshot: jsonb("snapshot").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    identity: uniqueIndex("source_relation_evidence_uidx").on(table.relationId, table.evidenceKey),
    relation: index("source_relation_evidence_relation_idx").on(table.relationId),
    note: index("source_relation_evidence_note_idx").on(table.noteRelationId),
    origin: check(
      "source_relation_evidence_origin",
      sql`${table.origin} in ('atomic_notes', 'source_analysis')`
    )
  })
);

// The explanation of a source relation, written on demand when the owner opens the relation and
// cached for the inputs it was written from (`input_hash`: both sources' titles and evidence
// passages, the type, the direction and the content language). Like note relation explanations, it
// is kept beside the relation row, so writing it never changes the relation.
export const sourceRelationExplanations = pgTable(
  "source_relation_explanations",
  {
    relationId: uuid("relation_id")
      .primaryKey()
      .references(() => sourceRelations.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    inputHash: text("input_hash").notNull(),
    promptVersion: text("prompt_version").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    runtime: text("runtime").notNull(),
    aiTaskRunId: uuid("ai_task_run_id").references(() => aiTaskRuns.id, { onDelete: "set null" }),
    language: varchar("language", { length: 16 }).notNull(),
    writtenAt: timestamp("written_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    text: check(
      "source_relation_explanations_text",
      sql`char_length(${table.text}) between 1 and 4000`
    )
  })
);

export const sourceMatchingDecisions = pgTable("source_matching_decisions", {
  key: text("key").primaryKey(),
  sourceRootId: uuid("source_root_id")
    .notNull()
    .references(() => sourceItems.id, { onDelete: "cascade" }),
  targetRootId: uuid("target_root_id")
    .notNull()
    .references(() => sourceItems.id, { onDelete: "cascade" }),
  metadata: jsonb("metadata")
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const sourceMatchingRuns = pgTable("source_matching_runs", {
  key: text("key").primaryKey(),
  sourceRootId: uuid("source_root_id")
    .notNull()
    .references(() => sourceItems.id, { onDelete: "cascade" }),
  state: jsonb("state").notNull(),
  ...timestamps
});

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
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    targetUidx: uniqueIndex("embeddings_256_target_model_uidx").on(
      table.targetType,
      table.targetId,
      table.model
    ),
    chunkIdx: index("embeddings_256_chunk_id_idx").on(table.chunkId)
  })
);

export const embeddings768 = pgTable(
  "embeddings_768",
  { ...createEmbeddingColumns(), embedding: vector768("embedding").notNull() },
  (table) => ({
    targetUidx: uniqueIndex("embeddings_768_target_model_uidx").on(
      table.targetType,
      table.targetId,
      table.model
    ),
    chunkIdx: index("embeddings_768_chunk_id_idx").on(table.chunkId)
  })
);

export const embeddings1024 = pgTable(
  "embeddings_1024",
  { ...createEmbeddingColumns(), embedding: vector1024("embedding").notNull() },
  (table) => ({
    targetUidx: uniqueIndex("embeddings_1024_target_model_uidx").on(
      table.targetType,
      table.targetId,
      table.model
    ),
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
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    kindCreatedIdx: index("similarity_debug_runs_kind_created_at_idx").on(
      table.kind,
      table.createdAt
    )
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
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
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

// Wiki identities are independent from source hierarchy and derived graph records.
export const wikiPages = pgTable(
  "wiki_pages",
  {
    management: text("management").notNull().default("human_managed"),
    role: text("role"),
    tocOwnerKind: text("toc_owner_kind"),
    tocOwnerId: uuid("toc_owner_id"),
    id: uuid("id").primaryKey().defaultRandom(),
    currentRevisionId: uuid("current_revision_id"),
    parentId: uuid("parent_id").references((): AnyPgColumn => wikiPages.id, {
      onDelete: "restrict"
    }),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    position: integer("position").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("wiki_pages_parent_position_idx").on(table.parentId, table.position),
    uniqueIndex("wiki_toc_owner_idx").on(table.role, table.tocOwnerKind, table.tocOwnerId),
    check("wiki_pages_not_self_parent", sql`${table.parentId} is distinct from ${table.id}`)
  ]
);
export const wikiPageRevisions = pgTable(
  "wiki_page_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "restrict" }),
    parentRevisionId: uuid("parent_revision_id"),
    number: integer("number").notNull(),
    origin: text("origin").notNull(),
    content: jsonb("content").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("wiki_page_revisions_number_idx").on(table.pageId, table.number)]
);
export const wikiEvidence = pgTable(
  "wiki_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "restrict" }),
    sourceItemId: uuid("source_item_id").notNull(),
    documentId: uuid("document_id").notNull(),
    chunkId: uuid("chunk_id").notNull(),
    sourceSpanId: uuid("source_span_id"),
    snapshot: jsonb("snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("wiki_evidence_page_chunk_idx").on(table.pageId, table.chunkId),
    index("wiki_evidence_source_idx").on(table.sourceItemId)
  ]
);

export const organizationSettingsRevisions = pgTable("organization_settings_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  configuration: jsonb("configuration").notNull(),
  hash: text("hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});
export const organizationSettingsActivations = pgTable("organization_settings_activations", {
  id: uuid("id").primaryKey().defaultRandom(),
  revisionId: uuid("revision_id")
    .notNull()
    .references(() => organizationSettingsRevisions.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});
export const organizationRuns = pgTable(
  "organization_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    status: text("status").notNull().default("queued"),
    snapshot: jsonb("snapshot").notNull(),
    checkpoint: jsonb("checkpoint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("organization_runs_job_idx").on(t.jobId),
    index("organization_runs_status_idx").on(t.status),
    check(
      "organization_runs_status_check",
      sql`${t.status} in ('queued','analyzing','awaiting_review','applied','sample_passed','rejected','canceled','failed')`
    )
  ]
);
export const organizationSteps = pgTable(
  "organization_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => organizationRuns.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    aiTaskRunId: uuid("ai_task_run_id").references(() => aiTaskRuns.id, { onDelete: "restrict" }),
    artifact: jsonb("artifact").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex("organization_steps_sequence_idx").on(t.runId, t.sequence)]
);
export const organizationProposals = pgTable("organization_proposals", {
  runId: uuid("run_id")
    .primaryKey()
    .references(() => organizationRuns.id, { onDelete: "restrict" }),
  proposal: jsonb("proposal").notNull(),
  decision: text("decision"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});
export const organizationReceipts = pgTable("organization_receipts", {
  runId: uuid("run_id")
    .primaryKey()
    .references(() => organizationRuns.id, { onDelete: "restrict" }),
  revisionId: uuid("revision_id")
    .notNull()
    .references(() => wikiPageRevisions.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

// Exact section consumers survive deletion of their original inputs.
export const wikiDependencies = pgTable(
  "wiki_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => wikiPageRevisions.id, { onDelete: "restrict" }),
    sectionId: uuid("section_id").notNull(),
    kind: text("kind").notNull(),
    inputId: uuid("input_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    staleReason: text("stale_reason"),
    changedAt: timestamp("changed_at", { withTimezone: true })
  },
  (t) => [
    uniqueIndex("wiki_dependencies_consumer_idx").on(t.revisionId, t.sectionId, t.kind, t.inputId),
    index("wiki_dependencies_input_idx").on(t.kind, t.inputId),
    index("wiki_dependencies_revision_idx").on(t.revisionId)
  ]
);
export const knowledgeImpactEvents = pgTable(
  "knowledge_impact_events",
  {
    sourceIds: jsonb("source_ids").notNull().default([]),
    causalRunId: uuid("causal_run_id"),
    causalGroupId: uuid("causal_group_id"),
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    inputId: uuid("input_id").notNull(),
    operation: text("operation").notNull(),
    fingerprint: text("fingerprint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true })
  },
  (t) => [
    index("knowledge_impact_events_pending_idx").on(t.consumedAt, t.createdAt),
    index("knowledge_impact_events_input_idx").on(t.kind, t.inputId)
  ]
);

export const maintenanceSchedules = pgTable(
  "maintenance_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    revision: integer("revision").notNull().default(1),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    policy: jsonb("policy").notNull(),
    lastError: text("last_error"),
    nextAt: timestamp("next_at", { withTimezone: true }).notNull(),
    lastRunId: uuid("last_run_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("maintenance_schedules_due_idx").on(t.nextAt)]
);
export const maintenanceRuns = pgTable(
  "maintenance_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "restrict" }),
    scopeKey: text("scope_key").notNull(),
    period: text("period").notNull(),
    scheduleIds: jsonb("schedule_ids").notNull(),
    status: text("status").notNull().default("queued"),
    snapshot: jsonb("snapshot").notNull(),
    checkpoint: jsonb("checkpoint").notNull(),
    proposal: jsonb("proposal"),
    reservation: jsonb("reservation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("maintenance_runs_job_idx").on(t.jobId),
    index("maintenance_runs_period_idx").on(t.scopeKey, t.period),
    check(
      "maintenance_runs_status_check",
      sql`${t.status} in ('queued','inspecting','analyzing','awaiting_review','no_change','applied','rejected','canceled','failed','sample_passed')`
    )
  ]
);
export const maintenanceOccurrencesTable = pgTable(
  "maintenance_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => maintenanceSchedules.id, { onDelete: "restrict" }),
    occurrenceKey: text("occurrence_key").notNull(),
    dueFrom: timestamp("due_from", { withTimezone: true }).notNull(),
    dueUntil: timestamp("due_until", { withTimezone: true }).notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => maintenanceRuns.id, { onDelete: "restrict" })
  },
  (t) => [uniqueIndex("maintenance_occurrences_identity_idx").on(t.scheduleId, t.occurrenceKey)]
);
export const maintenanceSteps = pgTable(
  "maintenance_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => maintenanceRuns.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    aiTaskRunId: uuid("ai_task_run_id").references(() => aiTaskRuns.id, { onDelete: "restrict" }),
    artifact: jsonb("artifact").notNull()
  },
  (t) => [uniqueIndex("maintenance_steps_sequence_idx").on(t.runId, t.sequence)]
);
export const maintenanceReceipts = pgTable(
  "maintenance_receipts",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => maintenanceRuns.id, { onDelete: "restrict" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "restrict" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => wikiPageRevisions.id, { onDelete: "restrict" })
  },
  (t) => [uniqueIndex("maintenance_receipts_run_page_idx").on(t.runId, t.pageId)]
);
export const maintenanceDecisions = pgTable(
  "maintenance_decisions",
  {
    key: text("key").primaryKey(),
    pageId: uuid("page_id").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => maintenanceRuns.id, { onDelete: "restrict" }),
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("maintenance_decisions_page_idx").on(t.pageId, t.createdAt)]
);
export const maintenanceBudgetReservations = pgTable(
  "maintenance_budget_reservations",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => maintenanceRuns.id, { onDelete: "restrict" }),
    scopeKey: text("scope_key").notNull(),
    period: text("period").notNull(),
    reservation: jsonb("reservation").notNull()
  },
  (t) => [
    uniqueIndex("maintenance_budget_run_period_idx").on(t.runId, t.period),
    index("maintenance_budget_scope_period_idx").on(t.scopeKey, t.period)
  ]
);

/** Transactional invalidation coalesces canonical changes; delivery history is the filesystem outbox/base. */
export const obsidianProjectionClock = pgTable("obsidian_projection_clock", {
  id: integer("id").primaryKey(),
  generation: bigint("generation", { mode: "number" }).notNull().default(1)
});
export const obsidianProjectionRevisions = pgTable(
  "obsidian_projection_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memoraId: uuid("memora_id").notNull(),
    revisionId: text("revision_id").notNull(),
    bindingHash: text("binding_hash").notNull(),
    relativePath: text("relative_path").notNull(),
    content: text("content").notNull(),
    editableHash: text("editable_hash").notNull(),
    generatedHash: text("generated_hash").notNull(),
    renderedHash: text("rendered_hash").notNull(),
    baseHash: text("base_hash"),
    beforeContent: text("before_content"),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("obsidian_projection_target_idx").on(table.memoraId, table.createdAt),
    index("obsidian_projection_pending_idx").on(table.status)
  ]
);

export const obsidianEditorialOperations = pgTable(
  "obsidian_editorial_operations",
  {
    id: uuid("id").primaryKey(),
    clientId: uuid("client_id").notNull(),
    vaultId: uuid("vault_id").notNull(),
    bindingHash: text("binding_hash").notNull(),
    targetId: uuid("target_id").notNull(),
    requestHash: text("request_hash").notNull(),
    request: jsonb("request").notNull(),
    receipt: jsonb("receipt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("obsidian_editorial_target_idx").on(table.targetId, table.createdAt)]
);
export const atomicNoteRevisions = pgTable(
  "atomic_note_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => atomicNotes.id, { onDelete: "cascade" }),
    previous: jsonb("previous").notNull(),
    current: jsonb("current").notNull(),
    origin: text("origin").notNull().default("human"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("atomic_note_revisions_note_idx").on(table.noteId, table.createdAt)]
);

export const promptRevisions = pgTable(
  "prompt_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    promptId: text("prompt_id").notNull(),
    scope: text("scope").notNull(),
    domainId: uuid("domain_id"),
    fields: jsonb("fields").notNull(),
    origin: text("origin").notNull(),
    legacy: jsonb("legacy"),
    legacyKey: text("legacy_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index("prompt_revisions_leaf_idx").on(t.promptId, t.createdAt),
    uniqueIndex("prompt_revisions_legacy_idx").on(t.legacyKey),
    check(
      "prompt_revisions_scope_check",
      sql`${t.scope} in ('global','function','domain','domain_function') and ((${t.scope} in ('domain','domain_function')) = (${t.domainId} is not null))`
    )
  ]
);
export const promptActivations = pgTable(
  "prompt_activations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => promptRevisions.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("prompt_activations_revision_idx").on(t.revisionId)]
);
export const promptValidations = pgTable(
  "prompt_validations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => promptRevisions.id, { onDelete: "restrict" }),
    compositionHash: text("composition_hash").notNull(),
    samplePassed: boolean("sample_passed").notNull().default(false),
    auditIds: jsonb("audit_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex("prompt_validations_composition_idx").on(t.revisionId, t.compositionHash)]
);

// Successor curation extends the existing wiki and organization owners.
export const wikiPolicyRevisions = pgTable("wiki_policy_revisions", {
  id: uuid("id").primaryKey(),
  policyId: uuid("policy_id").notNull(),
  policy: jsonb("policy").notNull(),
  preview: jsonb("preview").notNull(),
  previewHash: text("preview_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});
export const wikiPolicyActivations = pgTable(
  "wiki_policy_activations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    policyId: uuid("policy_id").notNull(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => wikiPolicyRevisions.id, { onDelete: "restrict" }),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("wiki_policy_activation_lookup_idx").on(t.policyId, t.createdAt)]
);
export const wikiTocGroups = pgTable(
  "wiki_toc_groups",
  {
    id: uuid("id").primaryKey(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "restrict" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => wikiPageRevisions.id, { onDelete: "restrict" }),
    snapshot: jsonb("snapshot").notNull()
  },
  (t) => [index("wiki_toc_page_idx").on(t.pageId)]
);
export const wikiMemberships = pgTable(
  "wiki_memberships",
  {
    id: uuid("id").primaryKey(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "restrict" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => wikiTocGroups.id, { onDelete: "restrict" }),
    targetKind: text("target_kind").notNull(),
    targetId: uuid("target_id").notNull(),
    position: integer("position").notNull(),
    snapshot: jsonb("snapshot").notNull()
  },
  (t) => [
    index("wiki_membership_order_idx").on(t.groupId, t.position, t.id),
    index("wiki_membership_target_idx").on(t.targetKind, t.targetId)
  ]
);
export const wikiSectionAssessments = pgTable("wiki_section_assessments", {
  sectionRevisionId: uuid("section_revision_id").primaryKey(),
  sectionId: uuid("section_id").notNull(),
  pageId: uuid("page_id")
    .notNull()
    .references(() => wikiPages.id, { onDelete: "restrict" }),
  assessment: jsonb("assessment").notNull()
});
export const wikiGroupReceipts = pgTable(
  "wiki_group_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => organizationRuns.id, { onDelete: "restrict" }),
    groupId: uuid("group_id").notNull(),
    inputFingerprint: text("input_fingerprint").notNull(),
    targets: jsonb("targets").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex("wiki_group_receipt_run_idx").on(t.runId, t.groupId)]
);

// A3 extends canonical impacts; leases/checkpoints do not acknowledge another consumer.
export const knowledgeImpactDeliveries = pgTable(
  "knowledge_impact_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => knowledgeImpactEvents.id, { onDelete: "restrict" }),
    consumer: text("consumer").notNull(),
    consumerKey: text("consumer_key").notNull(),
    inputGeneration: text("input_generation").notNull(),
    status: text("status").notNull().default("pending"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    deferUntil: timestamp("defer_until", { withTimezone: true }),
    checkpoint: jsonb("checkpoint").notNull().default({}),
    receipt: jsonb("receipt"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("knowledge_impact_delivery_generation_idx").on(
      t.eventId,
      t.consumer,
      t.consumerKey,
      t.inputGeneration
    ),
    index("knowledge_impact_delivery_pending_idx").on(t.consumer, t.status, t.deferUntil),
    check(
      "knowledge_impact_delivery_state_check",
      sql`${t.status} in ('pending','leased','deferred','acknowledged')`
    ),
    check(
      "knowledge_impact_delivery_receipt_check",
      sql`${t.status}<>'acknowledged' or ${t.receipt} is not null`
    )
  ]
);
export const wikiSourceCoverage = pgTable(
  "wiki_source_coverage",
  {
    policyId: uuid("policy_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    inputFingerprint: text("input_fingerprint").notNull(),
    status: text("status").notNull(),
    checkpoint: jsonb("checkpoint").notNull(),
    runId: uuid("run_id").references(() => organizationRuns.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    primaryKey({ columns: [t.policyId, t.sourceId] }),
    index("wiki_source_coverage_state_idx").on(t.policyId, t.status)
  ]
);

/** Setup identity is independent of preset version and schedule display names. */
export const automaticRoutineBindings = pgTable(
  "automatic_routine_bindings",
  {
    policyId: uuid("policy_id").notNull(),
    kind: text("kind").notNull(),
    scopeKey: text("scope_key").notNull(),
    presetVersion: text("preset_version").notNull(),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => maintenanceSchedules.id, { onDelete: "restrict" })
  },
  (t) => [
    uniqueIndex("automatic_routine_binding_identity_idx").on(t.policyId, t.kind, t.scopeKey),
    uniqueIndex("automatic_routine_binding_schedule_idx").on(t.scheduleId)
  ]
);
export const automaticRoutineCalls = pgTable(
  "automatic_routine_calls",
  {
    organizationRunId: uuid("organization_run_id")
      .notNull()
      .references(() => organizationRuns.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => maintenanceRuns.id, { onDelete: "restrict" }),
    policyId: uuid("policy_id").notNull(),
    period: text("period").notNull(),
    tokens: integer("tokens").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("automatic_routine_call_identity_idx").on(t.organizationRunId, t.sequence),
    index("automatic_routine_call_policy_period_idx").on(t.policyId, t.period)
  ]
);

export const wikiInvestigations = pgTable(
  "wiki_investigations",
  {
    id: uuid("id").primaryKey(),
    requestId: uuid("request_id").notNull(),
    identity: text("identity").notNull(),
    question: text("question").notNull(),
    answerPageId: uuid("answer_page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "restrict" }),
    policyId: uuid("policy_id").notNull(),
    policyRevisionId: uuid("policy_revision_id")
      .notNull()
      .references(() => wikiPolicyRevisions.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull().default(1),
    state: text("state").notNull(),
    input: jsonb("input").notNull(),
    current: jsonb("current").notNull(),
    lastInputFingerprint: text("last_input_fingerprint"),
    gaps: jsonb("gaps").notNull(),
    attention: text("attention"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("wiki_investigation_request_idx").on(t.requestId),
    uniqueIndex("wiki_investigation_identity_idx").on(t.identity),
    index("wiki_investigation_policy_state_idx").on(t.policyId, t.state),
    check(
      "wiki_investigation_state_check",
      sql`${t.state} in ('followed','paused','resolved','awaiting_evidence')`
    )
  ]
);
export const wikiInvestigationEvaluations = pgTable(
  "wiki_investigation_evaluations",
  {
    id: uuid("id").primaryKey(),
    investigationId: uuid("investigation_id")
      .notNull()
      .references(() => wikiInvestigations.id, { onDelete: "restrict" }),
    inputFingerprint: text("input_fingerprint").notNull(),
    compositionHash: text("composition_hash").notNull(),
    status: text("status").notNull(),
    result: jsonb("result"),
    previous: jsonb("previous"),
    snapshot: jsonb("snapshot").notNull(),
    runId: uuid("run_id").references(() => organizationRuns.id, { onDelete: "restrict" }),
    changedUnderstanding: jsonb("changed_understanding").notNull().default([]),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("wiki_investigation_evaluation_identity_idx").on(
      t.investigationId,
      t.inputFingerprint,
      t.compositionHash
    ),
    index("wiki_investigation_evaluation_history_idx").on(t.investigationId, t.createdAt)
  ]
);

/** Immutable original attribution survives deletion of live source links. */
export const atomicNoteEvidence = pgTable(
  "atomic_note_evidence",
  {
    noteId: uuid("note_id")
      .notNull()
      .references(() => atomicNotes.id, { onDelete: "cascade" }),
    chunkId: uuid("chunk_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    snapshot: jsonb("snapshot").notNull()
  },
  (t) => [
    primaryKey({ columns: [t.noteId, t.chunkId] }),
    index("atomic_note_evidence_source_idx").on(t.sourceId)
  ]
);
export const atomicNoteEvolution = pgTable(
  "atomic_note_evolution",
  {
    previousId: uuid("previous_id")
      .notNull()
      .references(() => atomicNotes.id, { onDelete: "restrict" }),
    nextId: uuid("next_id")
      .notNull()
      .references(() => atomicNotes.id, { onDelete: "restrict" }),
    /** The legacy organization run that recorded the evolution; no FK since the detach (0052). */
    runId: uuid("run_id").notNull(),
    kind: text("kind").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    primaryKey({ columns: [t.previousId, t.nextId] }),
    index("atomic_note_evolution_run_idx").on(t.runId)
  ]
);

// ---------------------------------------------------------------------------
// Topic Tree Engine (F2, migration 0053). One active tree per library (D2: `active|retired`); a
// topic and its index are one node. The engine is the single writer of these tables (D9): only
// `topicTreeRepository.ts` writes them, a guard trigger refuses AI-managed parent and management
// writes outside an engine transaction, and placements leave with their items by cascade (D32).
// Check lists mirror `@app/domain` `topics.ts` (topicTreeRepository.test.ts compares them).

export const topicTrees = pgTable(
  "topic_trees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: text("status").notNull().default("active"),
    /** Embedding space of every vector the tree compares (D26); spaces are never mixed. */
    spaceKey: text("space_key").notNull(),
    embeddingProvider: text("embedding_provider").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embeddingRuntime: text("embedding_runtime").notNull(),
    dimensions: smallint("dimensions").notNull(),
    config: jsonb("config").notNull(),
    /** Hash of the structural configuration (D39). */
    configHash: text("config_hash").notNull(),
    seed: bigint("seed", { mode: "number" }).notNull(),
    /** Applied change-sets; every write checks the generation it was computed from. */
    generation: bigint("generation", { mode: "number" }).notNull().default(0),
    /** The engine's logical clock (repair cooldowns). */
    clock: bigint("clock", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true })
  },
  (table) => ({
    activeUidx: uniqueIndex("topic_trees_active_uidx")
      .on(table.status)
      .where(sql`${table.status} = 'active'`),
    statusCheck: check("topic_trees_status", sql`${table.status} in ('active','retired')`),
    lifeCheck: check(
      "topic_trees_life",
      sql`(${table.status} = 'retired') = (${table.retiredAt} is not null)
        and (${table.status} <> 'active' or ${table.activatedAt} is not null)`
    ),
    dimensionsCheck: check("topic_trees_dimensions", sql`${table.dimensions} in (256,768,1024)`),
    countersCheck: check(
      "topic_trees_counters",
      sql`${table.generation} >= 0 and ${table.clock} >= 0`
    ),
    textCheck: check(
      "topic_trees_text",
      sql`char_length(${table.spaceKey}) between 1 and 300 and char_length(${table.configHash}) between 1 and 200`
    )
  })
);

export const topics = pgTable(
  "topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    treeId: uuid("tree_id")
      .notNull()
      .references(() => topicTrees.id, { onDelete: "restrict" }),
    /** The only parent pointer (D1); null exactly for the root. */
    parentId: uuid("parent_id").references((): AnyPgColumn => topics.id, { onDelete: "restrict" }),
    role: text("role").notNull().default("topic"),
    /** Null exactly when the topic is unnamed (the interface renders "Unnamed topic"). */
    title: text("title"),
    nameState: text("name_state").notNull().default("unnamed"),
    nameSource: text("name_source"),
    nameLanguage: varchar("name_language", { length: 16 }),
    namedChangeSetId: uuid("named_change_set_id"),
    description: text("description"),
    aliases: jsonb("aliases")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** `human` and `pinned` topics are protected from automation. */
    management: text("management").notNull().default("ai"),
    position: integer("position").notNull().default(0),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    /** A retired topic redirects to its successor; IDs are never reused. */
    redirectTo: uuid("redirect_to").references((): AnyPgColumn => topics.id, {
      onDelete: "restrict"
    }),
    createdChangeSetId: uuid("created_change_set_id"),
    ...timestamps
  },
  (table) => ({
    childrenIdx: index("topics_children_idx")
      .on(table.treeId, table.parentId, table.position)
      .where(sql`${table.retiredAt} is null`),
    rootUidx: uniqueIndex("topics_tree_root_uidx")
      .on(table.treeId)
      .where(sql`${table.role} = 'root' and ${table.retiredAt} is null`),
    // I7 backstop: live siblings never share a title, ignoring case and accents.
    siblingTitleUidx: uniqueIndex("topics_sibling_title_uidx")
      .on(table.parentId, sql`f_unaccent(lower(${table.title}))`)
      .where(sql`${table.retiredAt} is null and ${table.title} is not null`),
    roleCheck: check("topics_role", sql`${table.role} in ('root','topic')`),
    parentCheck: check(
      "topics_parent",
      sql`${table.parentId} is distinct from ${table.id} and (${table.role} = 'root') = (${table.parentId} is null)`
    ),
    nameStateCheck: check(
      "topics_name_state",
      sql`${table.nameState} in ('named','provisional','unnamed')
        and (${table.nameSource} is null or ${table.nameSource} in ('llm','human','tfidf'))
        and (${table.role} = 'root' or (${table.nameState} = 'unnamed') = (${table.title} is null))`
    ),
    textCheck: check(
      "topics_text",
      sql`(${table.title} is null or char_length(${table.title}) between 1 and 120)
        and (${table.description} is null or char_length(${table.description}) between 1 and 400)
        and (${table.nameLanguage} is null or char_length(${table.nameLanguage}) >= 1)
        and jsonb_typeof(${table.aliases}) = 'array' and jsonb_array_length(${table.aliases}) <= 10`
    ),
    managementCheck: check(
      "topics_management",
      sql`${table.management} in ('ai','human','pinned')`
    ),
    positionCheck: check("topics_position", sql`${table.position} >= 0`),
    redirectCheck: check(
      "topics_redirect",
      sql`(${table.redirectTo} is null or ${table.retiredAt} is not null) and ${table.redirectTo} is distinct from ${table.id}`
    )
  })
);

export const topicStats = pgTable(
  "topic_stats",
  {
    topicId: uuid("topic_id")
      .primaryKey()
      .references(() => topics.id, { onDelete: "cascade" }),
    spaceKey: text("space_key").notNull(),
    /** Items of the subtree that count (D8). */
    n: integer("n").notNull().default(0),
    /** Sum of their unit vectors: Float64, little-endian (D7); null until first computed. */
    ls: bytea("ls"),
    cosSqSum: doublePrecision("cos_sq_sum").notNull().default(0),
    lowCosPercentiles: real("low_cos_percentiles")
      .array()
      .notNull()
      .default(sql`'{}'::real[]`),
    coherence: real("coherence"),
    directItems: integer("direct_items").notNull().default(0),
    children: integer("children").notNull().default(0),
    health: text("health").notNull().default("good"),
    violations: jsonb("violations")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** The statistics need an exact recompute (a change or a cascade touched the subtree). */
    dirty: boolean("dirty").notNull().default(true),
    lastRepairAt: timestamp("last_repair_at", { withTimezone: true }),
    /** Tree clock of the last repair (cooldown); null when never repaired. */
    repairClock: bigint("repair_clock", { mode: "number" }),
    computedAt: timestamp("computed_at", { withTimezone: true })
  },
  (table) => ({
    dirtyIdx: index("topic_stats_dirty_idx")
      .on(table.topicId)
      .where(sql`${table.dirty}`),
    countsCheck: check(
      "topic_stats_counts",
      sql`${table.n} >= 0 and ${table.directItems} >= 0 and ${table.children} >= 0`
    ),
    healthCheck: check(
      "topic_stats_health",
      sql`${table.health} in ('good','attention','violation') and jsonb_typeof(${table.violations}) = 'array'`
    )
  })
);

export const topicChangeSets = pgTable(
  "topic_change_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    treeId: uuid("tree_id")
      .notNull()
      .references(() => topicTrees.id, { onDelete: "restrict" }),
    origin: text("origin").notNull(),
    status: text("status").notNull(),
    /** Localized, deterministic title: an i18n key and its parameters. */
    titleKey: text("title_key").notNull(),
    titleParams: jsonb("title_params")
      .notNull()
      .default(sql`'{}'::jsonb`),
    risk: text("risk").notNull().default("low"),
    undoOf: uuid("undo_of").references((): AnyPgColumn => topicChangeSets.id, {
      onDelete: "restrict"
    }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    aiTaskRunIds: jsonb("ai_task_run_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    summary: jsonb("summary")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** The tree generation this change-set produced; null until applied (apply order). */
    generation: bigint("generation", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    undoneAt: timestamp("undone_at", { withTimezone: true })
  },
  (table) => ({
    treeCreatedIdx: index("topic_change_sets_tree_created_idx").on(
      table.treeId,
      table.createdAt.desc()
    ),
    generationUidx: uniqueIndex("topic_change_sets_generation_uidx")
      .on(table.treeId, table.generation)
      .where(sql`${table.generation} is not null`),
    originCheck: check(
      "topic_change_sets_origin",
      sql`${table.origin} in ('build','place','gate','rebalance','audit','naming','areas','human','undo','rebuild')
        and (${table.origin} = 'undo') = (${table.undoOf} is not null)`
    ),
    statusCheck: check(
      "topic_change_sets_status",
      sql`${table.status} in ('applied','undone','pending_review','dismissed')
        and (${table.status} in ('applied','undone')) = (${table.generation} is not null)
        and (${table.status} in ('applied','undone')) = (${table.appliedAt} is not null)
        and (${table.status} = 'undone') = (${table.undoneAt} is not null)`
    ),
    riskCheck: check("topic_change_sets_risk", sql`${table.risk} in ('low','medium','high')`),
    jsonCheck: check(
      "topic_change_sets_json",
      sql`char_length(${table.titleKey}) between 1 and 200 and jsonb_typeof(${table.titleParams}) = 'object'
        and jsonb_typeof(${table.aiTaskRunIds}) = 'array' and jsonb_typeof(${table.summary}) = 'object'`
    )
  })
);

export const topicStructureEvents = pgTable(
  "topic_structure_events",
  {
    changeSetId: uuid("change_set_id")
      .notNull()
      .references(() => topicChangeSets.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    op: text("op").notNull(),
    // Events keep topic and item IDs without foreign keys (D32): history outlives deleted items.
    topicId: uuid("topic_id"),
    itemKind: text("item_kind"),
    itemId: uuid("item_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    /** Every topic the event reads or writes (undo dependency lookups). */
    refTopicIds: uuid("ref_topic_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`)
  },
  (table) => ({
    pk: primaryKey({ columns: [table.changeSetId, table.seq] }),
    topicIdx: index("topic_structure_events_topic_idx")
      .on(table.topicId)
      .where(sql`${table.topicId} is not null`),
    itemIdx: index("topic_structure_events_item_idx")
      .on(table.itemKind, table.itemId)
      .where(sql`${table.itemId} is not null`),
    refsIdx: index("topic_structure_events_refs_idx").using("gin", table.refTopicIds),
    opCheck: check(
      "topic_structure_events_op",
      sql`${table.op} in ('topic.create','topic.retire','topic.restore','topic.move','topic.rename',
        'topic.describe','topic.manage','item.place','item.unplace','item.move') and ${table.seq} >= 0`
    ),
    itemCheck: check(
      "topic_structure_events_item",
      sql`(${table.itemKind} is null) = (${table.itemId} is null)
        and (${table.itemKind} is null or ${table.itemKind} in ('note','source'))`
    )
  })
);

export const topicPlacements = pgTable(
  "topic_placements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    treeId: uuid("tree_id")
      .notNull()
      .references(() => topicTrees.id, { onDelete: "restrict" }),
    itemKind: text("item_kind").notNull(),
    // Placements leave with their item (D32); a statement trigger marks the paths dirty.
    noteId: uuid("note_id").references(() => atomicNotes.id, { onDelete: "cascade" }),
    sourceItemId: uuid("source_item_id").references(() => sourceItems.id, {
      onDelete: "cascade"
    }),
    /** A placed note's root source when it was placed (D8 dirty marking); derived, no FK. */
    rootSourceItemId: uuid("root_source_item_id"),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "restrict" }),
    role: text("role").notNull(),
    rank: smallint("rank").notNull(),
    management: text("management").notNull().default("ai"),
    decidedBy: text("decided_by").notNull(),
    /** Identity of the vector the placement was decided with. */
    itemFingerprint: text("item_fingerprint"),
    score: doublePrecision("score"),
    margin: doublePrecision("margin"),
    /** Cosine to the topic centroid at the last exact recompute. */
    centrality: real("centrality"),
    needsGate: boolean("needs_gate").notNull().default(false),
    needsSplitCheck: boolean("needs_split_check").notNull().default(false),
    needsVector: boolean("needs_vector").notNull().default(false),
    movedFromTopicId: uuid("moved_from_topic_id"),
    movedAt: timestamp("moved_at", { withTimezone: true }),
    changeSetId: uuid("change_set_id").references(() => topicChangeSets.id, {
      onDelete: "set null"
    }),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    rankUidx: uniqueIndex("topic_placements_item_rank_uidx").on(
      table.treeId,
      table.itemKind,
      sql`coalesce(${table.noteId}, ${table.sourceItemId})`,
      table.rank
    ),
    topicUidx: uniqueIndex("topic_placements_item_topic_uidx").on(
      table.treeId,
      table.itemKind,
      sql`coalesce(${table.noteId}, ${table.sourceItemId})`,
      table.topicId
    ),
    topicRoleIdx: index("topic_placements_topic_role_idx").on(
      table.topicId,
      table.role,
      table.centrality.desc()
    ),
    noteIdx: index("topic_placements_note_idx")
      .on(table.noteId)
      .where(sql`${table.noteId} is not null`),
    sourceIdx: index("topic_placements_source_idx")
      .on(table.sourceItemId)
      .where(sql`${table.sourceItemId} is not null`),
    flaggedIdx: index("topic_placements_flagged_idx")
      .on(table.treeId)
      .where(sql`${table.needsGate} or ${table.needsSplitCheck} or ${table.needsVector}`),
    itemCheck: check(
      "topic_placements_item",
      sql`(${table.itemKind} = 'note' and ${table.noteId} is not null and ${table.sourceItemId} is null)
        or (${table.itemKind} = 'source' and ${table.sourceItemId} is not null and ${table.noteId} is null
            and ${table.rootSourceItemId} is null)`
    ),
    rankCheck: check(
      "topic_placements_rank",
      sql`${table.rank} between 0 and 2 and ${table.role} in ('primary','secondary')
        and (${table.role} = 'primary') = (${table.rank} = 0)`
    ),
    decisionCheck: check(
      "topic_placements_decision",
      sql`${table.management} in ('ai','human')
        and ${table.decidedBy} in ('build','auto','gate','fallback','human','rebuild')
        and (${table.itemFingerprint} is null or char_length(${table.itemFingerprint}) between 1 and 200)`
    )
  })
);

export const topicGateDecisions = pgTable(
  "topic_gate_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    treeId: uuid("tree_id")
      .notNull()
      .references(() => topicTrees.id, { onDelete: "restrict" }),
    itemKind: text("item_kind").notNull(),
    itemId: uuid("item_id").notNull(),
    itemHash: text("item_hash").notNull(),
    descriptorSetHash: text("descriptor_set_hash").notNull(),
    deciderKey: text("decider_key").notNull(),
    /** Candidates in gate order: topicId, descriptorHash, cosine, labelCosine, logOdds. */
    candidates: jsonb("candidates").notNull(),
    chosenTopicId: uuid("chosen_topic_id"),
    noneOfThese: boolean("none_of_these").notNull().default(false),
    aiTaskRunId: uuid("ai_task_run_id").references(() => aiTaskRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    cacheUidx: uniqueIndex("topic_gate_decisions_cache_uidx").on(
      table.itemHash,
      table.descriptorSetHash,
      table.deciderKey
    ),
    itemIdx: index("topic_gate_decisions_item_idx").on(table.itemKind, table.itemId),
    decisionCheck: check(
      "topic_gate_decisions_decision",
      sql`${table.itemKind} in ('note','source') and ${table.noneOfThese} = (${table.chosenTopicId} is null)
        and jsonb_typeof(${table.candidates}) = 'array'`
    )
  })
);

export const topicDailyMetrics = pgTable(
  "topic_daily_metrics",
  {
    treeId: uuid("tree_id")
      .notNull()
      .references(() => topicTrees.id, { onDelete: "restrict" }),
    day: date("day").notNull(),
    opsApplied: integer("ops_applied").notNull().default(0),
    itemsMoved: integer("items_moved").notNull().default(0),
    primaryPathChanges: integer("primary_path_changes").notNull().default(0),
    unsortedShare: real("unsorted_share"),
    meanDepth: real("mean_depth"),
    fanoutInTarget: real("fanout_in_target"),
    hardViolations: integer("hard_violations"),
    softViolations: integer("soft_violations"),
    gateCalls: integer("gate_calls").notNull().default(0),
    namingCalls: integer("naming_calls").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.treeId, table.day] }),
    countsCheck: check(
      "topic_daily_metrics_counts",
      sql`${table.opsApplied} >= 0 and ${table.itemsMoved} >= 0 and ${table.primaryPathChanges} >= 0
        and ${table.gateCalls} >= 0 and ${table.namingCalls} >= 0`
    )
  })
);

export const topicCalibrations = pgTable(
  "topic_calibrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceKey: text("space_key").notNull(),
    /** Null for decider-independent parameters (stability, growth, structure). */
    deciderKey: text("decider_key"),
    params: jsonb("params").notNull(),
    metrics: jsonb("metrics")
      .notNull()
      .default(sql`'{}'::jsonb`),
    dataset: text("dataset").notNull(),
    active: boolean("active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    activeUidx: uniqueIndex("topic_calibrations_active_uidx")
      .on(table.spaceKey, sql`coalesce(${table.deciderKey}, '')`)
      .where(sql`${table.active}`),
    jsonCheck: check(
      "topic_calibrations_json",
      sql`jsonb_typeof(${table.params}) = 'object' and jsonb_typeof(${table.metrics}) = 'object'`
    )
  })
);
