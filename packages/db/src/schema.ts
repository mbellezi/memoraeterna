import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
    sourceUri: text("source_uri"),
    externalId: text("external_id"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => ({
    typeIdx: index("source_items_type_idx").on(table.type),
    sourceUriIdx: index("source_items_source_uri_idx").on(table.sourceUri),
    externalIdIdx: index("source_items_external_id_idx").on(table.externalId)
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
    storagePathIdx: uniqueIndex("document_assets_storage_path_uidx").on(table.storageBase, table.relativePath)
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
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
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

export const sourceItemsRelations = relations(sourceItems, ({ many }) => ({
  documents: many(documents),
  assets: many(documentAssets),
  spans: many(sourceSpans),
  chunks: many(chunks),
  ingestionRuns: many(ingestionRuns),
  obsidianSyncFiles: many(obsidianSyncFiles)
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
