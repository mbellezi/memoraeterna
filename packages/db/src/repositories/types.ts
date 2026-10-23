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
  | "PeriodicalIssue"
  | "AcademicPaper"
  | "DocumentSection"
  | "StandaloneArticle"
  | "Video"
  | "GenericDocument";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
/** `heavy` runs ingestion; `light` runs short tree and projection work that never waits behind it. */
export type JobLane = "heavy" | "light";
export type IngestionRunStatus = "pending" | "running" | "succeeded" | "failed" | "canceled";
export type ObsidianSyncStatus =
  "pending" | "synced" | "conflict" | "deleted" | "ignored" | "retired";
export type AtomicNoteStatus = "active" | "pending_review" | "approved" | "rejected" | "archived";
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
  generationId: string | null;
  isCurrent: boolean;
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
  generationId: string | null;
  supersessionStatus: string;
  ownership?: "source" | "knowledge";
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

/**
 * A stored note relation (relations v2, F3 D8/D9). `sourceAtomicNoteId < targetAtomicNoteId` by
 * UUID: the columns are the canonical pair, never the direction, which `direction` holds.
 */
export interface AtomicNoteRelationRecord {
  id: string;
  sourceAtomicNoteId: string;
  targetAtomicNoteId: string;
  /** Null for an untyped relations v2 row. */
  relationType: string | null;
  vectorScore: number | null;
  graphScore: number | null;
  rerankScore: number | null;
  finalScore: number;
  explanation: string;
  status: AtomicNoteRelationStatus;
  matchingProfileId: string | null;
  matchingModel: string | null;
  metadata: JsonObject;
  /** The stored direction: the audit record, a typer guess included. Readers use `shownDirection`. */
  direction: "lo_to_hi" | "hi_to_lo" | "symmetric" | "unknown";
  /** Where the direction came from (decision 31b); null on a legacy row or a symmetric relation. */
  directionSource: "typer" | "decider" | "owner" | null;
  /** The direction the relation may be shown in; `unknown` for a guess nobody confirmed. */
  shownDirection: "lo_to_hi" | "hi_to_lo" | "symmetric" | "unknown";
  band: "apply" | "suggest" | null;
  probability: number | null;
  deciderKey: string | null;
  typerKey: string | null;
  vetoedAt: Date | null;
  vetoSource: "explainer" | "typer" | null;
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
  lane: JobLane;
  /** Set only while the job waits in the queue; claiming or retrying it drops the key. */
  dedupeKey: string | null;
  /** Gardener task state (F4 D5-D8): see `@app/domain` `gardenerStateOf`. */
  scopeKey: string | null;
  subjectKey: string | null;
  outcome: JobOutcome | null;
  blockedClass: string | null;
  blockedReason: string | null;
  blockedAt: Date | null;
  quarantinedAt: Date | null;
  inputFingerprint: string | null;
  /**
   * The dedupe key the job held when this process claimed it (from `claimNext` only): a job set
   * aside by a blocker gets it back (D7).
   */
  claimedDedupeKey?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type JobOutcome = "done" | "no_change" | "skipped";

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
  breadcrumbs?: Array<{ id: string; title: string }>;
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
  graphScore: number;
  finalScore: number;
}

export interface GraphEntitySearchRecord {
  entityId: string;
  entityType: string;
  canonicalName: string;
  aliases: string[];
  description: string | null;
  sourceItemId: string;
  sourceTitle: string;
  sourceType: SourceItemType;
  breadcrumbs?: Array<{ id: string; title: string }>;
  excerpt: string;
  graphScore: number;
  finalScore: number;
}

export interface GraphRelationSearchRecord {
  relationId: string;
  subjectEntityId: string;
  subjectName: string;
  predicate: string;
  displayLabel?: string;
  objectEntityId: string;
  objectName: string;
  sourceItemId: string;
  sourceTitle: string;
  sourceType: SourceItemType;
  breadcrumbs?: Array<{ id: string; title: string }>;
  excerpt: string;
  graphScore: number;
  finalScore: number;
}

export interface AtomicNoteSearchRecord {
  noteId: string;
  sourceItemId: string;
  sourceTitle: string;
  sourceType: SourceItemType;
  breadcrumbs?: Array<{ id: string; title: string }>;
  title: string;
  ideaStatement: string;
  excerpt: string;
  status: Exclude<AtomicNoteStatus, "rejected">;
  textScore: number;
  vectorScore: number;
  graphScore: number;
  finalScore: number;
}

export interface GraphEntityRecord {
  id: string;
  type: string;
  canonicalName: string;
  normalizedName: string;
  aliases: string[];
  description: string | null;
  language: string;
  confidence: number;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface IngestionRunRecord {
  id: string;
  sourceItemId: string | null;
  jobId: string | null;
  batchId: string | null;
  runKind: "initial" | "missing_stages" | "reingestion" | "retry_resume";
  requestedStages: unknown[];
  effectiveStages: unknown[];
  planVersion: string;
  inputDocumentRevisionId: string | null;
  inputHashes: JsonObject;
  supersedesRunId: string | null;
  previousArtifactPolicy: string;
  trigger: string;
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
