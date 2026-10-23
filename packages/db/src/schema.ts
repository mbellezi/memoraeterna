import { relations, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  bigint,
  bigserial,
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

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector"
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
    /**
     * Gardener task state (F4 D5-D8, 0060). `scope_key`: two running jobs of one scope never
     * exist (claimable kinds only; inline ingestion stages keep null). `subject_key`: the outcome
     * cache's key with the type. `outcome` on a succeeded job; a blocker on a queued job set aside;
     * `quarantined_at` on a failed job whose input failed before. A succeeded job without an
     * outcome finished before 0060.
     */
    scopeKey: text("scope_key"),
    subjectKey: text("subject_key"),
    outcome: text("outcome"),
    blockedClass: text("blocked_class"),
    blockedReason: text("blocked_reason"),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    inputFingerprint: text("input_fingerprint"),
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
    runningScopeUidx: uniqueIndex("jobs_running_scope_uidx")
      .on(table.scopeKey)
      .where(sql`${table.scopeKey} is not null and ${table.status} = 'running'`),
    typeStatusIdx: index("jobs_type_status_idx").on(table.type, table.status),
    laneCheck: check("jobs_lane", sql`${table.lane} in ('heavy','light')`),
    dedupeKeyCheck: check(
      "jobs_dedupe_key",
      sql`${table.dedupeKey} is null or char_length(${table.dedupeKey}) between 1 and 200`
    ),
    gardenerCheck: check(
      "jobs_gardener",
      sql`(${table.scopeKey} is null or char_length(${table.scopeKey}) between 1 and 200)
        and (${table.subjectKey} is null or char_length(${table.subjectKey}) between 1 and 200)
        and (${table.inputFingerprint} is null or char_length(${table.inputFingerprint}) between 1 and 200)
        and (${table.outcome} is null or (${table.outcome} in ('done','no_change','skipped') and ${table.status} = 'succeeded'))
        and (${table.blockedClass} is null) = (${table.blockedReason} is null)
        and (${table.blockedClass} is null) = (${table.blockedAt} is null)
        and (${table.blockedClass} is null or (${table.status} = 'queued'
          and ${table.blockedClass} in ('paused','no_model','cap','download','waiting','offline')
          and char_length(${table.blockedReason}) between 1 and 64))
        and (${table.quarantinedAt} is null or ${table.status} = 'failed')`
    )
  })
);

/**
 * The Gardener's outcome cache (F4 D8, D9): per (kind, subject) the fingerprint of the last
 * successful job (an equal one skips), the current run of consecutive failed jobs with the
 * fingerprint they failed on (the second quarantines it) and the last job. Written in the
 * statement that finishes the job. `last_job_id` has no foreign key: retention prunes jobs.
 */
export const gardenerOutcomes = pgTable(
  "gardener_outcomes",
  {
    kind: text("kind").notNull(),
    subjectKey: text("subject_key").notNull(),
    lastOutcome: text("last_outcome").notNull(),
    lastFingerprint: text("last_fingerprint"),
    failedFingerprint: text("failed_fingerprint"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastErrorClass: text("last_error_class"),
    lastJobId: uuid("last_job_id"),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => ({
    pk: primaryKey({ columns: [table.kind, table.subjectKey] }),
    quarantinedIdx: index("gardener_outcomes_quarantined_idx")
      .on(table.quarantinedAt)
      .where(sql`${table.quarantinedAt} is not null`),
    values: check(
      "gardener_outcomes_values",
      sql`char_length(${table.kind}) between 1 and 200 and char_length(${table.subjectKey}) between 1 and 200
        and ${table.lastOutcome} in ('done','no_change','skipped','failed')
        and (${table.lastFingerprint} is null or char_length(${table.lastFingerprint}) between 1 and 200)
        and (${table.failedFingerprint} is null or char_length(${table.failedFingerprint}) between 1 and 200)
        and (${table.lastErrorClass} is null or char_length(${table.lastErrorClass}) between 1 and 200)
        and ${table.consecutiveFailures} >= 0
        and (${table.quarantinedAt} is null or ${table.consecutiveFailures} >= 1)`
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
    // The scheduler's view of the call (F3 D29-D31), null on rows written before it: the lane
    // (`local` or `remote:<providerConfigId>`), the workload class, the priority (0 = P0), the
    // effective total deadline and whether the call met it or was aborted by it (`none` when it had
    // none), the time spent sleeping for retries off the lane and re-waiting for the lane between
    // attempts (excluded from the deadline). `is_repair` marks a second call for the same items
    // after a validation failure; `schema_mode` how structured output was requested.
    lane: text("lane"),
    workloadClass: text("workload_class"),
    priority: smallint("priority"),
    deadlineMs: integer("deadline_ms"),
    deadlineOutcome: text("deadline_outcome"),
    isRepair: boolean("is_repair").notNull().default(false),
    schemaMode: text("schema_mode"),
    retryWaitMs: integer("retry_wait_ms"),
    requeueMs: integer("requeue_ms"),
    // The RemoteBudget's view of the call (F4 D14, 0061), null on rows written before it (unknown):
    // who it spent for (`user`, `background`, `interactive`), the job it ran for (no foreign key: the
    // audit outlives pruned jobs), and the US$ the monthly ledger counts beyond the reported tokens on
    // a priced route: every admitted attempt's estimate when the usage misses a count, else the
    // estimates of failed attempts the provider accepted and reported no usage for.
    budgetClass: text("budget_class"),
    jobId: uuid("job_id"),
    budgetEstimateUsd: doublePrecision("budget_estimate_usd"),
    status: text("status").notNull(),
    error: text("error"),
    // The call's start: the row is written when the call ends, so it is stored as finishedAt - durationMs.
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true })
  },
  (table) => ({
    taskIdx: index("ai_task_runs_task_type_idx").on(table.taskType),
    classIdx: index("ai_task_runs_started_class_idx").on(table.startedAt, table.workloadClass),
    laneCheck: check(
      "ai_task_runs_lane",
      sql`${table.lane} is null or ${table.lane} = 'local' or ${table.lane} ~ '^remote:.{1,200}$'`
    ),
    classCheck: check(
      "ai_task_runs_workload_class",
      sql`${table.workloadClass} is null or ${table.workloadClass} in ('embed','decide','write-fast','write-quality','answer')`
    ),
    priorityCheck: check(
      "ai_task_runs_priority",
      sql`${table.priority} is null or ${table.priority} between 0 and 3`
    ),
    deadlineCheck: check(
      "ai_task_runs_deadline",
      sql`(${table.deadlineMs} is null or ${table.deadlineMs} > 0)
        and (${table.deadlineOutcome} is null or ${table.deadlineOutcome} in ('met','aborted','none'))`
    ),
    schemaModeCheck: check(
      "ai_task_runs_schema_mode",
      sql`${table.schemaMode} is null or ${table.schemaMode} in ('strict','json','grammar','none')`
    ),
    waitsCheck: check(
      "ai_task_runs_waits",
      sql`(${table.retryWaitMs} is null or ${table.retryWaitMs} >= 0)
        and (${table.requeueMs} is null or ${table.requeueMs} >= 0)`
    ),
    budgetClassCheck: check(
      "ai_task_runs_budget_class",
      sql`(${table.budgetClass} is null or ${table.budgetClass} in ('user','background','interactive'))
        and (${table.budgetEstimateUsd} is null or ${table.budgetEstimateUsd} >= 0)`
    ),
    // The monthly ledger of background remote spend (D14): background rows, and the unclassified
    // P2/P3 rows written before 0061, by start time.
    budgetLedgerIdx: index("ai_task_runs_budget_ledger_idx")
      .on(table.startedAt)
      .where(
        sql`${table.lane} like 'remote:%' and (${table.budgetClass} = 'background' or (${table.budgetClass} is null and ${table.priority} between 2 and 3))`
      )
  })
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
    // Full-text document of a note for relation retrieval (F3 D28): title and idea weigh A, the
    // first 4,000 body characters B. The 'simple' configuration keeps every language alike and
    // f_unaccent (migration 0053) makes the expression immutable, so the column can be generated.
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      (): SQL => sql`setweight(to_tsvector('simple', f_unaccent(coalesce(${atomicNotes.title}, ''))), 'A') ||
        setweight(to_tsvector('simple', f_unaccent(coalesce(${atomicNotes.ideaStatement}, ''))), 'A') ||
        setweight(to_tsvector('simple', f_unaccent(left(coalesce(${atomicNotes.bodyMarkdown}, ''), 4000))), 'B')`
    ),
    ...timestamps
  },
  (table) => ({
    sourceItemIdx: index("atomic_notes_source_item_id_idx").on(table.createdFromSourceItemId),
    statusIdx: index("atomic_notes_status_idx").on(table.status),
    sourceGenerationUidx: uniqueIndex("atomic_notes_source_generation_key_uidx").on(
      table.createdFromSourceItemId,
      table.generationId,
      table.generationKey
    ),
    searchTsvIdx: index("atomic_notes_search_tsv_idx").using("gin", table.searchTsv),
    titleTrgmIdx: index("atomic_notes_title_trgm_idx").using(
      "gin",
      sql`f_unaccent(${table.title}) gin_trgm_ops`
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

/** Every relation type a reader may meet (`noteRelationReadTypes` of `@app/domain`, F3 D10). */
const noteRelationReadTypesSql = sql.raw(
  "('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related')"
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
    // Null marks an untyped relations v2 row (neutral stance, typed later; F3 D20).
    relationType: text("relation_type"),
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
    // Relations v2 (F3 D8, D9): the pair is stored once (source < target by UUID) and reads in
    // `direction`; automation's band, calibrated probability and veto stay apart from `status`,
    // which keeps its human meaning (`pending_review` = no human verdict). Legacy rows: band null.
    direction: text("direction").notNull(),
    // Where `direction` came from (decision 31b): the typer's guess from note position is kept but
    // never shown; `decider` and `owner` directions are. Null on legacy rows and on relations that
    // read the same both ways.
    directionSource: text("direction_source"),
    band: text("band"),
    probability: real("probability"),
    deciderKey: text("decider_key"),
    typerKey: text("typer_key"),
    vetoedAt: timestamp("vetoed_at", { withTimezone: true }),
    vetoSource: text("veto_source"),
    ...timestamps
  },
  (table) => ({
    sourceIdx: index("atomic_note_relations_source_id_idx").on(table.sourceAtomicNoteId),
    targetIdx: index("atomic_note_relations_target_id_idx").on(table.targetAtomicNoteId),
    sourceTargetUidx: uniqueIndex("atomic_note_relations_source_target_uidx").on(
      table.sourceAtomicNoteId,
      table.targetAtomicNoteId
    ),
    pair: check(
      "atomic_note_relations_pair",
      sql`${table.sourceAtomicNoteId} < ${table.targetAtomicNoteId}`
    ),
    values: check(
      "atomic_note_relations_values",
      sql`${table.direction} in ('lo_to_hi','hi_to_lo','symmetric','unknown')
        and (${table.band} is null or ${table.band} in ('apply','suggest'))
        and (${table.probability} is null or ${table.probability} between 0 and 1)
        and (${table.vetoSource} is null or ${table.vetoSource} in ('explainer','typer'))
        and (${table.vetoSource} is null) = (${table.vetoedAt} is null)
        and (${table.directionSource} is null or ${table.directionSource} in ('typer','decider','owner'))
        and (${table.relationType} is null or ${table.relationType} in ${noteRelationReadTypesSql})`
    ),
    v2: check(
      "atomic_note_relations_v2",
      sql`(${table.relationType} is not null or ${table.band} is not null)
        and (${table.direction} <> 'unknown' or ${table.band} is null)
        and (${table.band} is not null or ${table.directionSource} is null)
        and (${table.band} is null or (
          (${table.relationType} is null or ${table.relationType} in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as'))
          and case when ${table.relationType} in ('supports','extends','depends_on','example_of','clarifies')
                then (${table.direction} in ('lo_to_hi','hi_to_lo') and ${table.directionSource} is not null)
                  or (${table.direction} = 'symmetric' and ${table.directionSource} is not distinct from 'owner')
                else ${table.direction} = 'symmetric' and ${table.directionSource} is null end))`
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
    // `probability`: a generative verdict in [0, 1] with its type per direction. `log_odds`: a
    // ranker's raw, uncalibrated score per direction, with no per-direction type (F3 D12).
    scoreScale: text("score_scale").notNull().default("probability")
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
    scoreScale: check(
      "relation_decisions_score_scale",
      sql`${table.scoreScale} in ('probability','log_odds')`
    ),
    directions: check(
      "relation_decisions_directions",
      sql`(${table.loToHiScore} is not null or ${table.hiToLoScore} is not null)
        and case when ${table.scoreScale} = 'log_odds' then
              ${table.loToHiRelationType} is null and ${table.hiToLoRelationType} is null
              and (${table.loToHiScore} is null or (${table.loToHiScore} > '-Infinity'::float8 and ${table.loToHiScore} < 'Infinity'::float8))
              and (${table.hiToLoScore} is null or (${table.hiToLoScore} > '-Infinity'::float8 and ${table.hiToLoScore} < 'Infinity'::float8))
            else
              (${table.loToHiScore} is null) = (${table.loToHiRelationType} is null)
              and (${table.hiToLoScore} is null) = (${table.hiToLoRelationType} is null)
              and coalesce(${table.loToHiScore}, 0) between 0 and 1
              and coalesce(${table.hiToLoScore}, 0) between 0 and 1
            end`
    ),
    decidedAt: check(
      "relation_decisions_decided_at",
      sql`(${table.loToHiScore} is null) = (${table.loToHiDecidedAt} is null)
        and (${table.hiToLoScore} is null) = (${table.hiToLoDecidedAt} is null)
        and (${table.loToHiScore} is not null or ${table.loToHiAiTaskRunId} is null)
        and (${table.hiToLoScore} is not null or ${table.hiToLoAiTaskRunId} is null)`
    ),
    types: check(
      "relation_decisions_types",
      sql`coalesce(${table.loToHiRelationType}, 'related') in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related')
        and coalesce(${table.hiToLoRelationType}, 'related') in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related')`
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

// The typer's verdict on an unordered note pair (F3 D20), reused only while both notes' rendered
// inputs are unchanged. `none` is a veto: the pair keeps this row and no relation is persisted, so
// recalibration never asks again. `direction` is null for `none`.
export const relationTypings = pgTable(
  "relation_typings",
  {
    pairKey: text("pair_key").notNull(),
    typerKey: text("typer_key").notNull(),
    loHash: text("lo_hash").notNull(),
    hiHash: text("hi_hash").notNull(),
    relationType: text("relation_type").notNull(),
    direction: text("direction"),
    aiTaskRunId: uuid("ai_task_run_id").references(() => aiTaskRuns.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pairKey, table.typerKey] }),
    verdict: check(
      "relation_typings_verdict",
      sql`${table.relationType} in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','none')
        and case when ${table.relationType} = 'none' then ${table.direction} is null
                 when ${table.relationType} in ('supports','extends','depends_on','example_of','clarifies')
                   then ${table.direction} in ('lo_to_hi','hi_to_lo')
                 else ${table.direction} = 'symmetric' end
        and char_length(${table.pairKey}) between 1 and 200 and char_length(${table.typerKey}) between 1 and 200
        and char_length(${table.loHash}) between 1 and 200 and char_length(${table.hiHash}) between 1 and 200`
    )
  })
);

// Per-note matching state (F3 D19): the cosine of the note's k-th vector candidate when it was
// decided, which later notes compare against to include it as a reverse neighbour.
export const noteMatchState = pgTable(
  "note_match_state",
  {
    noteId: uuid("note_id")
      .primaryKey()
      .references(() => atomicNotes.id, { onDelete: "cascade" }),
    deciderKey: text("decider_key").notNull(),
    spaceKey: text("space_key").notNull(),
    kthCosine: real("kth_cosine"),
    /**
     * The note's rendered decision input hash when it was matched (F4 D16, MATCH): an edit that
     * leaves it and the space unchanged is not matched again. Null: match again (rows before 0060).
     */
    inputHash: text("input_hash"),
    matchedAt: timestamp("matched_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    values: check(
      "note_match_state_values",
      sql`char_length(${table.deciderKey}) between 1 and 200 and char_length(${table.spaceKey}) between 1 and 200
        and (${table.kthCosine} is null or ${table.kthCosine} between -1 and 1)
        and (${table.inputHash} is null or char_length(${table.inputHash}) between 1 and 200)`
    )
  })
);

// Per-root source matching state (F3 D27): arrival order, the nearest root found by discovery and
// its cosine (reverse neighbours beat it), in one embedding space.
export const sourceMatchState = pgTable(
  "source_match_state",
  {
    rootId: uuid("root_id")
      .primaryKey()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    matchSeq: bigserial("match_seq", { mode: "number" }).notNull(),
    nearestRootId: uuid("nearest_root_id").references(() => sourceItems.id, {
      onDelete: "set null"
    }),
    nearestCosine: real("nearest_cosine"),
    spaceKey: text("space_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    matchedAt: timestamp("matched_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    seqUidx: uniqueIndex("source_match_state_match_seq_uidx").on(table.matchSeq),
    nearestIdx: index("source_match_state_space_nearest_idx").on(
      table.spaceKey,
      table.nearestRootId
    ),
    values: check(
      "source_match_state_values",
      sql`(${table.nearestRootId} is null or ${table.nearestRootId} <> ${table.rootId})
        and (${table.nearestCosine} is null or ${table.nearestCosine} between -1 and 1)
        and char_length(${table.spaceKey}) between 1 and 200 and char_length(${table.fingerprint}) between 1 and 200`
    )
  })
);

// One automatic (or review) pass over relations (F3 D14); its events can be reverted exactly.
export const relationMatchRuns = pgTable(
  "relation_match_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    // Runs keep the root ID without a foreign key: history outlives a deleted source (F2 D32).
    rootId: uuid("root_id"),
    deciderKey: text("decider_key"),
    calibrationVersion: text("calibration_version"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: text("outcome"),
    counts: jsonb("counts")
      .notNull()
      .default(sql`'{}'::jsonb`),
    timings: jsonb("timings")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // A run is a change-set (F4 D10): its localized title (null: the kind's default key), its risk
    // (D11), the owner's verdict when it waited for review, and when it was reverted.
    titleKey: text("title_key"),
    titleParams: jsonb("title_params")
      .notNull()
      .default(sql`'{}'::jsonb`),
    risk: text("risk").notNull().default("low"),
    reviewStatus: text("review_status"),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    // The job that ran the pass; no foreign key, so pruning old jobs never touches the run.
    jobId: uuid("job_id")
  },
  (table) => ({
    rootIdx: index("relation_match_runs_root_started_idx").on(table.rootId, table.startedAt),
    startedIdx: index("relation_match_runs_started_idx").on(table.startedAt),
    values: check(
      "relation_match_runs_values",
      sql`${table.kind} in ('match','link','type','promote','discover','review','veto','reconcile','retype')
        and (${table.outcome} is null or char_length(${table.outcome}) between 1 and 200)
        and jsonb_typeof(${table.counts}) = 'object' and jsonb_typeof(${table.timings}) = 'object'`
    ),
    changeSet: check(
      "relation_match_runs_change_set",
      sql`(${table.titleKey} is null or char_length(${table.titleKey}) between 1 and 200)
        and jsonb_typeof(${table.titleParams}) = 'object'
        and ${table.risk} in ('low','medium','high')
        and (${table.reviewStatus} is null or ${table.reviewStatus} in ('pending_review','kept','dismissed'))
        and (${table.undoneAt} is null or ${table.outcome} = 'reverted')`
    )
  })
);

// Append-only log of every automatic relation change (F3 D14), with the row before and after.
// Events keep relation IDs without foreign keys (F2 D32): history outlives deleted relations.
export const relationEvents = pgTable(
  "relation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Global append order: reverting a run walks its events backwards.
    seq: bigserial("seq", { mode: "number" }).notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => relationMatchRuns.id, { onDelete: "cascade" }),
    relationKind: text("relation_kind").notNull(),
    relationId: uuid("relation_id"),
    pairKey: text("pair_key").notNull(),
    kind: text("kind").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    seqUidx: uniqueIndex("relation_events_seq_uidx").on(table.seq),
    runIdx: index("relation_events_run_idx").on(table.runId),
    relationIdx: index("relation_events_relation_idx").on(table.relationId),
    values: check(
      "relation_events_values",
      sql`${table.relationKind} in ('note','source')
        and ${table.kind} in ('applied','suggested','typed','untyped','vetoed','kept','removed','promoted','retired','reconciled')
        and char_length(${table.pairKey}) between 1 and 200`
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
    // A judged relation carries the judge's scores; a promoted one (design E, F3 D27) has none
    // (unknown stays unknown) and counts the note relations it was promoted from.
    importance: doublePrecision("importance"),
    confidence: doublePrecision("confidence"),
    status: atomicNoteRelationStatus("status").notNull().default("pending_review"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    origin: text("origin").notNull().default("judged"),
    supportCount: integer("support_count"),
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
      sql`(${table.importance} is null or ${table.importance} between 0 and 1)
        and (${table.confidence} is null or ${table.confidence} between 0 and 1)`
    ),
    origin: check(
      "source_relations_origin",
      sql`${table.origin} in ('judged','promoted')
        and (${table.origin} <> 'judged' or (${table.importance} is not null and ${table.confidence} is not null))
        and (${table.origin} <> 'promoted' or (${table.supportCount} is not null and ${table.supportCount} >= 1))
        and (${table.supportCount} is null or ${table.supportCount} >= 1)`
    ),
    type: check(
      "source_relations_type",
      sql`${table.relationType} in ('supports','contradicts','extends','depends_on','example_of','clarifies','same_as','contrasts','similar_to','mentions','related')`
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
    chunkIdx: index("embeddings_256_chunk_id_idx").on(table.chunkId),
    // Note retrieval (F3 D28): the ANN query orders by the raw distance, so the partial index
    // serves it. The global HNSW index of migration 0001 stays for the other targets.
    noteHnswIdx: index("embeddings_256_note_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops"))
      .where(sql`${table.targetType} = 'atomic_note'`)
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
    chunkIdx: index("embeddings_768_chunk_id_idx").on(table.chunkId),
    // Note retrieval (F3 D28): the ANN query orders by the raw distance, so the partial index
    // serves it. The global HNSW index of migration 0001 stays for the other targets.
    noteHnswIdx: index("embeddings_768_note_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops"))
      .where(sql`${table.targetType} = 'atomic_note'`)
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
    chunkIdx: index("embeddings_1024_chunk_id_idx").on(table.chunkId),
    // Note retrieval (F3 D28): the ANN query orders by the raw distance, so the partial index
    // serves it. The global HNSW index of migration 0008 stays for the other targets.
    noteHnswIdx: index("embeddings_1024_note_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops"))
      .where(sql`${table.targetType} = 'atomic_note'`)
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
    kind: text("kind").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [primaryKey({ columns: [t.previousId, t.nextId] })]
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
    // The change-set view lists every store newest first; retention reads the oldest (F4 D10).
    createdIdx: index("topic_change_sets_created_idx").on(table.createdAt),
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
        and ${table.decidedBy} in ('build','auto','gate','fallback','fallback-none','human','rebuild')
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

/**
 * The lazy overview of a topic (F2 T31, D16): prose written when its page opens, cached per member
 * fingerprint, prompt revision and content language. Only `topicOverviewRepository` writes it (D9).
 */
export const topicOverviews = pgTable(
  "topic_overviews",
  {
    topicId: uuid("topic_id")
      .primaryKey()
      .references(() => topics.id, { onDelete: "cascade" }),
    /** `[{text, citations:[n]}]`: the markers in the text name rows of `topic_overview_citations`. */
    paragraphs: jsonb("paragraphs").notNull(),
    /** The evidence it was written from, in prompt order (`noteId`, `chunkId`, `contentHash`, ...). */
    evidence: jsonb("evidence")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** The topic's members (primary placements of its subtree) when it was written. */
    memberFingerprint: text("member_fingerprint").notNull(),
    /** Notes the topic held when it was written. */
    memberCount: integer("member_count").notNull(),
    inputHash: text("input_hash").notNull(),
    promptRevisionId: text("prompt_revision_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    runtime: text("runtime").notNull(),
    aiTaskRunId: uuid("ai_task_run_id").references(() => aiTaskRuns.id, { onDelete: "set null" }),
    language: varchar("language", { length: 16 }).notNull(),
    /** The ranker's support check: status, unsupported paragraphs, sentence counts, model, runs. */
    support: jsonb("support")
      .notNull()
      .default(sql`'{"status":"unchecked","unsupported":[]}'::jsonb`),
    writtenAt: timestamp("written_at", { withTimezone: true }).notNull().defaultNow(),
    /** Divergences kept beside the prose (F4 D17): `[{existing, new, summary}]`, never merged in. */
    divergences: jsonb("divergences")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Every write raises it; the replaced text is kept in `topic_overview_versions` (undo). */
    version: integer("version").notNull().default(1)
  },
  (table) => ({
    shapeCheck: check(
      "topic_overviews_shape",
      sql`jsonb_typeof(${table.paragraphs}) = 'array' and jsonb_array_length(${table.paragraphs}) between 1 and 12
        and jsonb_typeof(${table.evidence}) = 'array' and jsonb_array_length(${table.evidence}) <= 40
        and jsonb_typeof(${table.support}) = 'object' and ${table.memberCount} >= 0`
    ),
    versionCheck: check(
      "topic_overviews_version",
      sql`${table.version} >= 1 and jsonb_typeof(${table.divergences}) = 'array'
        and jsonb_array_length(${table.divergences}) <= 40`
    ),
    textCheck: check(
      "topic_overviews_text",
      sql`char_length(${table.memberFingerprint}) between 1 and 200 and char_length(${table.inputHash}) between 1 and 200
        and char_length(${table.promptRevisionId}) between 1 and 200 and char_length(${table.language}) >= 1`
    )
  })
);

/** The citations of an overview: `n` is the marker number, pointing at an exact chunk and span. */
export const topicOverviewCitations = pgTable(
  "topic_overview_citations",
  {
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topicOverviews.topicId, { onDelete: "cascade" }),
    n: smallint("n").notNull(),
    /** Null once the passage was replaced: the excerpt stays readable and the citation unavailable. */
    chunkId: uuid("chunk_id").references(() => chunks.id, { onDelete: "set null" }),
    sourceSpanId: uuid("source_span_id").references(() => sourceSpans.id, {
      onDelete: "set null"
    }),
    noteId: uuid("note_id").references(() => atomicNotes.id, { onDelete: "set null" }),
    excerpt: text("excerpt").notNull(),
    /** SHA-256 of the whole passage the writer saw. */
    excerptHash: text("excerpt_hash").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.topicId, table.n] }),
    noteIdx: index("topic_overview_citations_note_idx")
      .on(table.noteId)
      .where(sql`${table.noteId} is not null`),
    chunkIdx: index("topic_overview_citations_chunk_idx")
      .on(table.chunkId)
      .where(sql`${table.chunkId} is not null`),
    spanIdx: index("topic_overview_citations_span_idx")
      .on(table.sourceSpanId)
      .where(sql`${table.sourceSpanId} is not null`),
    citationCheck: check(
      "topic_overview_citations_citation",
      sql`${table.n} between 1 and 40 and char_length(${table.excerpt}) between 1 and 1200
        and char_length(${table.excerptHash}) between 1 and 200`
    )
  })
);

/**
 * The change-sets of overview writes (F4 D10, D17): one row per write that replaced an overview,
 * keeping the replaced text (`previous`) so the write can be undone exactly, and one row per
 * proposal that waits for the owner (`proposed`, Suggest autonomy) with the version it was made
 * on. `version` is the overview version the write produced. Only `topicOverviewRepository` writes
 * it (D9). Job IDs are provenance without a foreign key: pruning old jobs never touches it.
 */
export const topicOverviewVersions = pgTable(
  "topic_overview_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    origin: text("origin").notNull(),
    status: text("status").notNull(),
    titleKey: text("title_key").notNull(),
    titleParams: jsonb("title_params")
      .notNull()
      .default(sql`'{}'::jsonb`),
    risk: text("risk").notNull().default("low"),
    /** The overview version the change was made on (0: there was none). */
    baseVersion: integer("base_version").notNull(),
    /** The version it produced; null while it is a proposal (pending or dismissed). */
    version: integer("version"),
    undoOf: uuid("undo_of").references((): AnyPgColumn => topicOverviewVersions.id, {
      onDelete: "restrict"
    }),
    jobId: uuid("job_id"),
    /** The overview the write replaced (paragraphs, citations, evidence, support, provenance). */
    previous: jsonb("previous"),
    /** A proposal's text, applied only on the owner's verdict. */
    proposed: jsonb("proposed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    undoneAt: timestamp("undone_at", { withTimezone: true })
  },
  (table) => ({
    topicCreatedIdx: index("topic_overview_versions_topic_created_idx").on(
      table.topicId,
      table.createdAt.desc()
    ),
    createdIdx: index("topic_overview_versions_created_idx").on(table.createdAt),
    versionUidx: uniqueIndex("topic_overview_versions_version_uidx")
      .on(table.topicId, table.version)
      .where(sql`${table.version} is not null`),
    undoIdx: index("topic_overview_versions_undo_idx")
      .on(table.undoOf)
      .where(sql`${table.undoOf} is not null`),
    originCheck: check(
      "topic_overview_versions_origin",
      sql`${table.origin} in ('write','patch','rewrite','undo')
        and (${table.origin} = 'undo') = (${table.undoOf} is not null)`
    ),
    statusCheck: check(
      "topic_overview_versions_status",
      sql`${table.status} in ('applied','undone','pending_review','dismissed')
        and (${table.status} in ('applied','undone')) = (${table.version} is not null)
        and (${table.status} in ('applied','undone')) = (${table.appliedAt} is not null)
        and (${table.status} = 'undone') = (${table.undoneAt} is not null)
        and (${table.status} <> 'pending_review' or ${table.proposed} is not null)`
    ),
    valuesCheck: check(
      "topic_overview_versions_values",
      sql`${table.risk} in ('low','medium','high') and ${table.baseVersion} >= 0
        and (${table.version} is null or ${table.version} > ${table.baseVersion})
        and char_length(${table.titleKey}) between 1 and 200 and jsonb_typeof(${table.titleParams}) = 'object'
        and (${table.previous} is null or jsonb_typeof(${table.previous}) = 'object')
        and (${table.proposed} is null or jsonb_typeof(${table.proposed}) = 'object')`
    )
  })
);

/**
 * What the Gardener found or keeps for the owner (F4 D19, D29): AUDIT's duplicate notes, broken
 * links and redirect chains, and the `backlog` and `budget` Inbox items. A finding is unique per
 * kind and fingerprint, so finding it again updates it and a dismissal persists.
 */
export const gardenerFindings = pgTable(
  "gardener_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    fingerprint: text("fingerprint").notNull(),
    /** The objects it names (`memora://` addresses), in content order. */
    objectRefs: jsonb("object_refs")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Message parameters and details (scalars), never copy. */
    params: jsonb("params")
      .notNull()
      .default(sql`'{}'::jsonb`),
    risk: text("risk").notNull().default("low"),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true })
  },
  (table) => ({
    fingerprintUidx: uniqueIndex("gardener_findings_kind_fingerprint_uidx").on(
      table.kind,
      table.fingerprint
    ),
    openIdx: index("gardener_findings_open_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'open'`),
    values: check(
      "gardener_findings_values",
      sql`${table.kind} in ('duplicate','broken_link','redirect_chain','backlog','budget')
        and char_length(${table.fingerprint}) between 1 and 200
        and jsonb_typeof(${table.objectRefs}) = 'array' and jsonb_array_length(${table.objectRefs}) <= 50
        and jsonb_typeof(${table.params}) = 'object'
        and ${table.risk} in ('low','medium','high')
        and ${table.status} in ('open','dismissed','resolved')
        and (${table.status} = 'open') = (${table.closedAt} is null)`
    )
  })
);
