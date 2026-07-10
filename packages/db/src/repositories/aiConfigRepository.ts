import type { QueryResultRow } from "pg";

import { asJsonObject, mapTimestamp } from "./sql.js";
import type { JsonObject, Queryable } from "./types.js";

export interface AiProviderConfigRecord {
  id: string;
  provider: string;
  displayName: string;
  credentialRef: string | null;
  baseUrl: string | null;
  status: string;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface AiProfileRecord {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  privacyMode: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ProviderRow extends QueryResultRow {
  id: string; provider: string; displayName: string; credentialRef: string | null;
  baseUrl: string | null; status: string; metadata: unknown; createdAt: unknown; updatedAt: unknown;
}

interface ProfileRow extends QueryResultRow {
  id: string; name: string; description: string | null; isDefault: boolean;
  privacyMode: string; status: string; createdAt: unknown; updatedAt: unknown;
}

const providerReturning = `id, provider, display_name as "displayName", credential_ref as "credentialRef",
  base_url as "baseUrl", status, metadata, created_at as "createdAt", updated_at as "updatedAt"`;
const profileReturning = `id, name, description, is_default as "isDefault", privacy_mode as "privacyMode",
  status, created_at as "createdAt", updated_at as "updatedAt"`;

function mapProvider(row: ProviderRow): AiProviderConfigRecord {
  return { ...row, metadata: asJsonObject(row.metadata), createdAt: mapTimestamp(row.createdAt), updatedAt: mapTimestamp(row.updatedAt) };
}

function mapProfile(row: ProfileRow): AiProfileRecord {
  return { ...row, createdAt: mapTimestamp(row.createdAt), updatedAt: mapTimestamp(row.updatedAt) };
}

export function createAiConfigRepository(db: Queryable) {
  return {
    async upsertProvider(input: {
      id?: string;
      provider: string;
      displayName: string;
      credentialRef?: string | null;
      baseUrl?: string | null;
      status?: string;
      metadata?: JsonObject;
    }): Promise<AiProviderConfigRecord> {
      const result = input.id
        ? await db.query<ProviderRow>(
            `update ai_provider_configs set provider = $2, display_name = $3, credential_ref = $4,
               base_url = $5, status = $6, metadata = $7, updated_at = now()
             where id = $1 returning ${providerReturning}`,
            [input.id, input.provider, input.displayName, input.credentialRef ?? null,
              input.baseUrl ?? null, input.status ?? "configured", input.metadata ?? {}]
          )
        : await db.query<ProviderRow>(
            `insert into ai_provider_configs (provider, display_name, credential_ref, base_url, status, metadata)
             values ($1, $2, $3, $4, $5, $6) returning ${providerReturning}`,
            [input.provider, input.displayName, input.credentialRef ?? null,
              input.baseUrl ?? null, input.status ?? "configured", input.metadata ?? {}]
          );
      const row = result.rows[0];
      if (!row) throw new Error("AI provider configuration write returned no row.");
      return mapProvider(row);
    },

    async listProviders(): Promise<AiProviderConfigRecord[]> {
      const result = await db.query<ProviderRow>(`select ${providerReturning} from ai_provider_configs order by display_name`);
      return result.rows.map(mapProvider);
    },

    async createProfile(input: { name: string; description?: string | null; isDefault?: boolean; privacyMode?: string }): Promise<AiProfileRecord> {
      const result = await db.query<ProfileRow>(
        `with unset_default as (
           update ai_profile_sets set is_default = false, updated_at = now() where $3::boolean = true
           returning id
         )
         insert into ai_profile_sets (name, description, is_default, privacy_mode)
         select $1, $2, $3, $4 where (select count(*) from unset_default) >= 0
         returning ${profileReturning}`,
        [input.name, input.description ?? null, input.isDefault ?? false, input.privacyMode ?? "allow_remote"]
      );
      const row = result.rows[0];
      if (!row) throw new Error("AI profile insert returned no row.");
      return mapProfile(row);
    },

    async cloneProfile(profileId: string, name: string): Promise<AiProfileRecord> {
      const result = await db.query<ProfileRow>(
        `with profile as (
           insert into ai_profile_sets (name, description, is_default, privacy_mode, status)
           select $2, description, false, privacy_mode, status from ai_profile_sets where id = $1
           returning *
         ), copied_tasks as (
           insert into ai_profile_tasks (
             profile_id, task, provider_config_id, model_id, runtime,
             required_capabilities, parameters, fallback_policy, status
           )
           select profile.id, task, provider_config_id, model_id, runtime,
                  required_capabilities, parameters, fallback_policy, status
           from ai_profile_tasks, profile where ai_profile_tasks.profile_id = $1
         )
         select ${profileReturning} from profile`,
        [profileId, name]
      );
      const row = result.rows[0];
      if (!row) throw new Error("AI profile to clone was not found.");
      return mapProfile(row);
    },

    async listProfiles(): Promise<AiProfileRecord[]> {
      const result = await db.query<ProfileRow>(`select ${profileReturning} from ai_profile_sets order by is_default desc, name`);
      return result.rows.map(mapProfile);
    },

    async getDefaultTask(task: string): Promise<{
      profileId: string;
      providerConfigId: string;
      provider: string;
      credentialRef: string | null;
      baseUrl: string | null;
      modelId: string;
      runtime: string;
      requiredCapabilities: string[];
      parameters: JsonObject;
      providerMetadata: JsonObject;
    } | null> {
      const result = await db.query<QueryResultRow & Record<string, unknown>>(
        `select p.id as "profileId", t.provider_config_id as "providerConfigId",
                c.provider, c.credential_ref as "credentialRef", c.base_url as "baseUrl",
                t.model_id as "modelId", t.runtime, t.required_capabilities as "requiredCapabilities",
                t.parameters, c.metadata as "providerMetadata"
         from ai_profile_sets p
         join ai_profile_tasks t on t.profile_id = p.id
         join ai_provider_configs c on c.id = t.provider_config_id
         where p.is_default = true and p.status = 'active' and t.status = 'active' and t.task = $1
         limit 1`,
        [task]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        profileId: String(row.profileId), providerConfigId: String(row.providerConfigId),
        provider: String(row.provider), credentialRef: row.credentialRef === null ? null : String(row.credentialRef),
        baseUrl: row.baseUrl === null ? null : String(row.baseUrl), modelId: String(row.modelId),
        runtime: String(row.runtime),
        requiredCapabilities: Array.isArray(row.requiredCapabilities) ? row.requiredCapabilities.map(String) : [],
        parameters: asJsonObject(row.parameters), providerMetadata: asJsonObject(row.providerMetadata)
      };
    },

    async setProfileTask(input: {
      profileId: string; task: string; providerConfigId?: string | null; modelId: string;
      runtime?: string; requiredCapabilities?: string[]; parameters?: JsonObject; fallbackPolicy?: string;
    }): Promise<void> {
      await db.query(
        `insert into ai_profile_tasks (
           profile_id, task, provider_config_id, model_id, runtime,
           required_capabilities, parameters, fallback_policy
         ) values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (profile_id, task) do update set
           provider_config_id = excluded.provider_config_id, model_id = excluded.model_id,
           runtime = excluded.runtime, required_capabilities = excluded.required_capabilities,
           parameters = excluded.parameters, fallback_policy = excluded.fallback_policy,
           updated_at = now()`,
        [input.profileId, input.task, input.providerConfigId ?? null, input.modelId,
          input.runtime ?? "remote", JSON.stringify(input.requiredCapabilities ?? []), input.parameters ?? {},
          input.fallbackPolicy ?? "block"]
      );
    },

    async recordTaskRun(input: {
      profileId?: string | null; taskType: string; provider: string; modelId: string;
      runtime: string; capabilitiesUsed?: string[]; inputHash?: string | null;
      outputHash?: string | null; inputTokens?: number | null; outputTokens?: number | null;
      costEstimate?: number | null; durationMs: number; status: string; error?: string | null;
    }): Promise<string> {
      const result = await db.query<QueryResultRow & { id: string }>(
        `insert into ai_task_runs (
           profile_id, task_type, provider, model_id, runtime, capabilities_used,
           input_hash, output_hash, input_tokens, output_tokens, cost_estimate,
           duration_ms, status, error, finished_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
         returning id`,
        [input.profileId ?? null, input.taskType, input.provider, input.modelId, input.runtime,
          JSON.stringify(input.capabilitiesUsed ?? []), input.inputHash ?? null, input.outputHash ?? null,
          input.inputTokens ?? null, input.outputTokens ?? null, input.costEstimate ?? null,
          input.durationMs, input.status, input.error ?? null]
      );
      const row = result.rows[0];
      if (!row) throw new Error("AI task run insert returned no row.");
      return row.id;
    }
  };
}
