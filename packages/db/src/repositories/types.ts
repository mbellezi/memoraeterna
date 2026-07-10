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
export type AtomicNoteStatus = "pending_review" | "approved" | "rejected" | "archived";
export type AtomicNoteRelationStatus = "pending_review" | "accepted" | "rejected";

export interface SourceItemRecord {
  id: string;
  type: SourceItemType;
  title: string;
  subtitle: string | null;
  sourceOrigin: string;
  sourceUri: string | null;
  externalId: string | null;
  parentSourceItemId: string | null;
  contentHash: string | null;
  language: string;
  summary: string | null;
  summaryGeneratedAt: Date | null;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface SourceSummaryRecord {
  id: string;
  sourceItemId: string;
  summary: string;
  language: string;
  profileId: string | null;
  aiTaskRunId: string | null;
  provider: string;
  model: string;
  runtime: string;
  promptVersion: string;
  inputHash: string;
  outputHash: string;
  generatedAt: Date;
  metadata: JsonObject;
  createdAt: Date;
}

export interface AtomicNoteRecord {
  id: string;
  title: string;
  bodyMarkdown: string;
  ideaStatement: string;
  language: string;
  status: AtomicNoteStatus;
  createdFromSourceItemId: string;
  sourceSpanId: string | null;
  evidenceChunkId: string;
  generationProfileId: string | null;
  aiTaskRunId: string | null;
  generationProvider: string;
  generationModel: string;
  generationRuntime: string;
  generationPromptVersion: string;
  generationKey: string;
  metadata: JsonObject;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AtomicNoteRelationRecord {
  id: string;
  sourceAtomicNoteId: string;
  targetAtomicNoteId: string;
  relationType: string;
  vectorScore: number | null;
  graphScore: number | null;
  rerankScore: number | null;
  finalScore: number;
  explanation: string;
  status: AtomicNoteRelationStatus;
  matchingProfileId: string | null;
  matchingModel: string | null;
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
  progress: number;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  finishedAt: Date | null;
  cancelRequestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SourceSpanRecord {
  id: string;
  documentId: string;
  sourceItemId: string;
  startOffset: number;
  endOffset: number;
  page: number | null;
  sourceBlockId: string | null;
  boundingBox: JsonObject | null;
  selector: string | null;
  label: string | null;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChunkRecord {
  id: string;
  documentId: string;
  sourceItemId: string;
  sourceSpanId: string | null;
  chunkIndex: number;
  content: string;
  tokenCount: number | null;
  contentHash: string;
  language: string;
  chunkingVersion: string;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface SearchEvidenceRecord {
  sourceItemId: string;
  sourceTitle: string;
  sourceType: SourceItemType;
  documentId: string;
  chunkId: string;
  sourceSpanId: string | null;
  excerpt: string;
  page: number | null;
  sourceBlockId: string | null;
  boundingBox: JsonObject | null;
  selector: string | null;
  textScore: number;
  vectorScore: number;
  finalScore: number;
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
  memoraId: string;
  entityType: string;
  entityId: string;
  sourceItemId: string | null;
  documentId: string | null;
  memoraType: string;
  relativePath: string;
  frontmatterHash: string;
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

export type IntegrationClientStatus = "paired" | "revoked" | "disabled";

export interface IntegrationClientRecord {
  id: string;
  clientType: string;
  displayName: string;
  tokenHash: string;
  scopes: string[];
  capabilities: string[];
  contractVersion: string;
  status: IntegrationClientStatus;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
