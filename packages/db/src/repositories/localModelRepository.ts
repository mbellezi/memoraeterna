import type { QueryResultRow } from "pg";

import { asJsonObject, mapNullableTimestamp, mapTimestamp } from "./sql.js";
import type { JsonObject, Queryable } from "./types.js";

export type LocalModelStatus = "not_downloaded" | "downloading" | "verifying" | "ready" | "failed" | "removing";

export interface LocalModelRecord {
  id: string;
  catalogId: string;
  modelId: string;
  displayName: string;
  family: string;
  variant: string;
  repository: string;
  revision: string;
  runtime: "gguf" | "mlx";
  format: string;
  quantization: string;
  managedPath: string | null;
  expectedSizeBytes: number;
  installedSizeBytes: number;
  manifestHash: string;
  capabilities: string[];
  licenseName: string;
  licenseUrl: string;
  licenseAcceptedAt: Date | null;
  status: LocalModelStatus;
  lastError: string | null;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface LocalModelFileRecord {
  id: string;
  localModelId: string;
  relativePath: string;
  expectedSizeBytes: number;
  downloadedSizeBytes: number;
  sha256: string;
  status: string;
}

export interface LocalModelDownloadRecord {
  id: string;
  localModelId: string;
  jobId: string;
  currentFile: string | null;
  downloadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  checkpoint: JsonObject;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface LocalModelRow extends QueryResultRow, Omit<LocalModelRecord, "capabilities" | "metadata" | "createdAt" | "updatedAt" | "licenseAcceptedAt"> {
  capabilities: unknown;
  metadata: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  licenseAcceptedAt: unknown;
}

interface LocalModelFileRow extends QueryResultRow, LocalModelFileRecord {}

interface LocalModelDownloadRow extends QueryResultRow, Omit<LocalModelDownloadRecord, "checkpoint" | "startedAt" | "completedAt" | "createdAt" | "updatedAt"> {
  checkpoint: unknown;
  startedAt: unknown;
  completedAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

const modelReturning = `id, catalog_id as "catalogId", model_id as "modelId", display_name as "displayName",
  family, variant, repository, revision, runtime, format, quantization, managed_path as "managedPath",
  expected_size_bytes as "expectedSizeBytes", installed_size_bytes as "installedSizeBytes",
  manifest_hash as "manifestHash", capabilities, license_name as "licenseName", license_url as "licenseUrl",
  license_accepted_at as "licenseAcceptedAt", status, last_error as "lastError", metadata,
  created_at as "createdAt", updated_at as "updatedAt"`;

const downloadReturning = `id, local_model_id as "localModelId", job_id as "jobId", current_file as "currentFile",
  downloaded_bytes as "downloadedBytes", total_bytes as "totalBytes", bytes_per_second as "bytesPerSecond",
  eta_seconds as "etaSeconds", checkpoint, error, started_at as "startedAt", completed_at as "completedAt",
  created_at as "createdAt", updated_at as "updatedAt"`;

export function createLocalModelRepository(db: Queryable) {
  return {
    async upsertModel(input: {
      catalogId: string; modelId: string; displayName: string; family: string; variant: string;
      repository: string; revision: string; runtime: "gguf" | "mlx"; format: string;
      quantization: string; expectedSizeBytes: number; manifestHash: string; capabilities: string[];
      licenseName: string; licenseUrl: string; metadata?: JsonObject;
    }): Promise<LocalModelRecord> {
      const result = await db.query<LocalModelRow>(
        `insert into local_models (
           catalog_id, model_id, display_name, family, variant, repository, revision, runtime, format,
           quantization, expected_size_bytes, manifest_hash, capabilities, license_name, license_url, metadata
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         on conflict (catalog_id) do update set
           model_id = excluded.model_id, display_name = excluded.display_name, family = excluded.family,
           variant = excluded.variant, repository = excluded.repository, revision = excluded.revision,
           runtime = excluded.runtime, format = excluded.format, quantization = excluded.quantization,
           expected_size_bytes = excluded.expected_size_bytes, manifest_hash = excluded.manifest_hash,
           capabilities = excluded.capabilities, license_name = excluded.license_name,
           license_url = excluded.license_url, metadata = excluded.metadata, updated_at = now()
         returning ${modelReturning}`,
        [input.catalogId, input.modelId, input.displayName, input.family, input.variant, input.repository,
          input.revision, input.runtime, input.format, input.quantization, input.expectedSizeBytes,
          input.manifestHash, JSON.stringify(input.capabilities), input.licenseName, input.licenseUrl,
          input.metadata ?? {}]
      );
      return mapModel(requiredRow(result.rows[0], "Local model upsert"));
    },

    async listModels(): Promise<LocalModelRecord[]> {
      const result = await db.query<LocalModelRow>(`select ${modelReturning} from local_models order by display_name`);
      return result.rows.map(mapModel);
    },

    async findById(id: string): Promise<LocalModelRecord | null> {
      const result = await db.query<LocalModelRow>(`select ${modelReturning} from local_models where id = $1`, [id]);
      return result.rows[0] ? mapModel(result.rows[0]) : null;
    },

    async findByCatalogId(catalogId: string): Promise<LocalModelRecord | null> {
      const result = await db.query<LocalModelRow>(`select ${modelReturning} from local_models where catalog_id = $1`, [catalogId]);
      return result.rows[0] ? mapModel(result.rows[0]) : null;
    },

    async updateModel(id: string, input: {
      status?: LocalModelStatus; managedPath?: string | null; installedSizeBytes?: number;
      lastError?: string | null; licenseAcceptedAt?: Date | null; metadata?: JsonObject;
    }): Promise<LocalModelRecord> {
      const result = await db.query<LocalModelRow>(
        `update local_models set
           status = coalesce($2, status), managed_path = case when $3::boolean then $4 else managed_path end,
           installed_size_bytes = coalesce($5, installed_size_bytes),
           last_error = case when $6::boolean then $7 else last_error end,
           license_accepted_at = case when $8::boolean then $9 else license_accepted_at end,
           metadata = coalesce($10, metadata), updated_at = now()
         where id = $1 returning ${modelReturning}`,
        [id, input.status ?? null, "managedPath" in input, input.managedPath ?? null,
          input.installedSizeBytes ?? null, "lastError" in input, input.lastError ?? null,
          "licenseAcceptedAt" in input, input.licenseAcceptedAt ?? null, input.metadata ?? null]
      );
      return mapModel(requiredRow(result.rows[0], "Local model update"));
    },

    async replaceFiles(localModelId: string, files: Array<{ path: string; sizeBytes: number; sha256: string }>): Promise<void> {
      await db.query(`delete from local_model_files where local_model_id = $1`, [localModelId]);
      for (const file of files) {
        await db.query(
          `insert into local_model_files (local_model_id, relative_path, expected_size_bytes, sha256)
           values ($1,$2,$3,$4)`,
          [localModelId, file.path, file.sizeBytes, file.sha256]
        );
      }
    },

    async listFiles(localModelId: string): Promise<LocalModelFileRecord[]> {
      const result = await db.query<LocalModelFileRow>(
        `select id, local_model_id as "localModelId", relative_path as "relativePath",
                expected_size_bytes as "expectedSizeBytes", downloaded_size_bytes as "downloadedSizeBytes",
                sha256, status from local_model_files where local_model_id = $1 order by relative_path`,
        [localModelId]
      );
      return result.rows.map((row) => ({ ...row, expectedSizeBytes: Number(row.expectedSizeBytes), downloadedSizeBytes: Number(row.downloadedSizeBytes) }));
    },

    async updateFileProgress(localModelId: string, relativePath: string, downloadedSizeBytes: number, status: string): Promise<void> {
      await db.query(
        `update local_model_files set downloaded_size_bytes = $3, status = $4, updated_at = now()
         where local_model_id = $1 and relative_path = $2`,
        [localModelId, relativePath, downloadedSizeBytes, status]
      );
    },

    async createDownload(input: { localModelId: string; jobId: string; totalBytes: number }): Promise<LocalModelDownloadRecord> {
      const result = await db.query<LocalModelDownloadRow>(
        `insert into local_model_downloads (local_model_id, job_id, total_bytes)
         values ($1,$2,$3) returning ${downloadReturning}`,
        [input.localModelId, input.jobId, input.totalBytes]
      );
      return mapDownload(requiredRow(result.rows[0], "Local model download insert"));
    },

    async updateDownload(jobId: string, input: {
      currentFile?: string | null; downloadedBytes?: number; bytesPerSecond?: number; etaSeconds?: number | null;
      checkpoint?: JsonObject; error?: string | null; startedAt?: Date | null; completedAt?: Date | null;
    }): Promise<LocalModelDownloadRecord> {
      const result = await db.query<LocalModelDownloadRow>(
        `update local_model_downloads set
           current_file = case when $2::boolean then $3 else current_file end,
           downloaded_bytes = coalesce($4, downloaded_bytes), bytes_per_second = coalesce($5, bytes_per_second),
           eta_seconds = case when $6::boolean then $7 else eta_seconds end,
           checkpoint = coalesce($8, checkpoint), error = case when $9::boolean then $10 else error end,
           started_at = case when $11::boolean then $12 else started_at end,
           completed_at = case when $13::boolean then $14 else completed_at end, updated_at = now()
         where job_id = $1 returning ${downloadReturning}`,
        [jobId, "currentFile" in input, input.currentFile ?? null, input.downloadedBytes ?? null,
          input.bytesPerSecond ?? null, "etaSeconds" in input, input.etaSeconds ?? null,
          input.checkpoint ?? null, "error" in input, input.error ?? null,
          "startedAt" in input, input.startedAt ?? null, "completedAt" in input, input.completedAt ?? null]
      );
      return mapDownload(requiredRow(result.rows[0], "Local model download update"));
    },

    async latestDownload(localModelId: string): Promise<LocalModelDownloadRecord | null> {
      const result = await db.query<LocalModelDownloadRow>(
        `select ${downloadReturning} from local_model_downloads where local_model_id = $1 order by created_at desc limit 1`,
        [localModelId]
      );
      return result.rows[0] ? mapDownload(result.rows[0]) : null;
    },

    async profilesUsing(localModelId: string): Promise<string[]> {
      const result = await db.query<QueryResultRow & { name: string }>(
        `select distinct p.name from ai_profile_sets p join ai_profile_tasks t on t.profile_id = p.id
         where t.local_model_id = $1 and p.status = 'active' and t.status = 'active' order by p.name`,
        [localModelId]
      );
      return result.rows.map((row) => row.name);
    },

    async deleteModel(id: string): Promise<boolean> {
      const result = await db.query(`delete from local_models where id = $1`, [id]);
      return (result.rowCount ?? 0) > 0;
    }
  };
}

function mapModel(row: LocalModelRow): LocalModelRecord {
  return {
    ...row,
    expectedSizeBytes: Number(row.expectedSizeBytes),
    installedSizeBytes: Number(row.installedSizeBytes),
    capabilities: Array.isArray(row.capabilities) ? row.capabilities.map(String) : [],
    metadata: asJsonObject(row.metadata),
    licenseAcceptedAt: mapNullableTimestamp(row.licenseAcceptedAt),
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

function mapDownload(row: LocalModelDownloadRow): LocalModelDownloadRecord {
  return {
    ...row,
    downloadedBytes: Number(row.downloadedBytes),
    totalBytes: Number(row.totalBytes),
    bytesPerSecond: Number(row.bytesPerSecond),
    etaSeconds: row.etaSeconds === null ? null : Number(row.etaSeconds),
    checkpoint: asJsonObject(row.checkpoint),
    startedAt: mapNullableTimestamp(row.startedAt),
    completedAt: mapNullableTimestamp(row.completedAt),
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

function requiredRow<T>(row: T | undefined, operation: string): T {
  if (!row) throw new Error(`${operation} returned no row.`);
  return row;
}
