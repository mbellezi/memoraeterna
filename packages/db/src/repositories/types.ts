import type { QueryResult, QueryResultRow } from "pg";

export type JsonObject = Record<string, unknown>;

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<T>>;
}

export type SourceItemType =
  | "PersonalNote"
  | "DailyNote"
  | "WebArticle"
  | "Book"
  | "BookChapter"
  | "StandaloneArticle"
  | "Video"
  | "GenericDocument";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export type IngestionRunStatus = "pending" | "running" | "succeeded" | "failed" | "canceled";
export type ObsidianSyncStatus = "pending" | "synced" | "conflict" | "deleted" | "ignored";

export interface SourceItemRecord {
  id: string;
  type: SourceItemType;
  title: string;
  sourceUri: string | null;
  externalId: string | null;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentRecord {
  id: string;
  sourceItemId: string;
  title: string;
  canonicalMarkdown: string;
  contentHash: string;
  language: string;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentAssetRecord {
  id: string;
  documentId: string | null;
  sourceItemId: string | null;
  originalFileName: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  storageBase: string;
  relativePath: string;
  role: string;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobRecord {
  id: string;
  type: string;
  status: JobStatus;
  priority: number;
  payload: JsonObject;
  result: JsonObject | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IngestionRunRecord {
  id: string;
  sourceItemId: string | null;
  jobId: string | null;
  status: IngestionRunStatus;
  currentStage: string;
  stagesCheckpoint: JsonObject;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SettingRecord {
  key: string;
  value: unknown;
  updatedAt: Date;
}

export interface StorageSettingsRecord {
  id: string;
  obsidianVaultPath: string | null;
  obsidianManagedRoot: string;
  obsidianSyncEnabled: boolean;
  obsidianSyncPaused: boolean;
  deletePolicy: string;
  uploadCopyEnabled: boolean;
  uploadCopyBasePath: string | null;
  updatedAt: Date;
}

export interface ObsidianSyncFileRecord {
  id: string;
  sourceItemId: string | null;
  documentId: string | null;
  memoraType: string;
  relativePath: string;
  contentHash: string;
  mtimeMs: number;
  syncVersion: number;
  status: ObsidianSyncStatus;
  lastSyncedAt: Date | null;
  deletedAt: Date | null;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}
