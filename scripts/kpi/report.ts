import type {
  AiKpi,
  AutomationKpi,
  JobsKpi,
  MatchingKpi,
  RunKpi,
  StageKpi,
  WikiKpi
} from "./aggregate.js";

/** Shape of the KPI report. It carries aggregates only: no identifiers, titles or note text. */

export type Section<T> =
  | { readonly available: true; readonly data: T }
  | { readonly available: false; readonly reason: string };

export interface LibraryKpi {
  readonly sources: {
    readonly total: number;
    readonly roots: number;
    readonly byType: Record<string, number>;
    readonly byOrigin: Record<string, number> | null;
  } | null;
  readonly documents: number | null;
  readonly chunks: number | null;
  readonly notes: {
    readonly total: number;
    /** Not rejected or archived, and not superseded. */
    readonly current: number;
    readonly byStatus: Record<string, number>;
  } | null;
  readonly noteRelations: {
    readonly total: number;
    readonly byStatus: Record<string, number>;
  } | null;
  readonly sourceRelations: {
    readonly total: number;
    readonly byStatus: Record<string, number>;
  } | null;
  readonly entities: number | null;
  /** Vector rows per embedding table. */
  readonly embeddings: Record<string, number>;
}

export interface ProcessingKpi {
  readonly runs: RunKpi;
  readonly stages: readonly StageKpi[];
}

export interface StuckJobsKpi {
  readonly thresholdMinutes: number;
  readonly running: number;
  readonly stuckRunning: number;
  readonly queuedOverdue: number;
  readonly byType: ReadonlyArray<{
    readonly type: string;
    readonly running: number;
    readonly stuckRunning: number;
    readonly queuedOverdue: number;
  }>;
  /** Ingestion runs marked running whose job is not running, which startup recovery resets. */
  readonly orphanedRunningIngestionRuns: number | null;
}

export interface JobsSection extends JobsKpi {
  readonly stuck: StuckJobsKpi | null;
}

export interface DatabaseInfo {
  readonly host: string;
  readonly port: number | null;
  readonly name: string;
  /** Label from the connection file or `--label`. */
  readonly label: string | null;
  /** Where the data came from, copied from the connection file when it records a restore. */
  readonly provenance: {
    readonly sourceName: string;
    readonly sha256: string;
    readonly dumpCreatedAt: string | null;
  } | null;
  readonly migrations: { readonly applied: number | null; readonly latestAt: string | null };
  /** Whether the database has the wall-clock instrumentation columns. */
  readonly instrumentation: {
    readonly stageAttempts: boolean;
    readonly aiQueueMs: boolean;
    readonly aiAttempt: boolean;
    readonly monitoring: boolean;
  };
}

export interface KpiReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly asOf: {
    readonly value: string | null;
    readonly basis: "latest-activity" | "now" | "explicit";
  };
  readonly database: DatabaseInfo;
  readonly library: Section<LibraryKpi>;
  readonly processing: Section<ProcessingKpi>;
  readonly ai: Section<AiKpi>;
  readonly matching: Section<MatchingKpi>;
  readonly wiki: Section<WikiKpi>;
  readonly organization: Section<AutomationKpi>;
  readonly maintenance: Section<AutomationKpi>;
  readonly jobs: Section<JobsSection>;
  /** Pieces that could not be measured on this database, with the reason. */
  readonly gaps: readonly string[];
}
