import type { QueryResultRow } from "pg";

import { asJsonObject, mapTimestamp } from "./sql.js";
import type { JsonObject, Queryable } from "./types.js";

export interface AiProviderConfigRecord {
  id: string;
  provider: string;
  displayName: string;
  credentialRef: string | null;
  baseUrl: string | null;
  defaultParameters: JsonObject;
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
  outputLanguage: string;
  providerConfigId: string | null;
  localModelId: string | null;
  modelId: string | null;
  runtime: string | null;
  capabilities: string[];
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ProviderRow extends QueryResultRow {
  id: string; provider: string; displayName: string; credentialRef: string | null;
  baseUrl: string | null; defaultParameters: unknown; status: string; metadata: unknown;
  createdAt: unknown; updatedAt: unknown;
}

interface ProfileRow extends QueryResultRow {
  id: string; name: string; description: string | null; isDefault: boolean;
  privacyMode: string; outputLanguage: string; providerConfigId: string | null;
  localModelId: string | null; modelId: string | null; runtime: string | null;
  capabilities: unknown; status: string; createdAt: unknown; updatedAt: unknown;
}

const providerReturning = `id, provider, display_name as "displayName", credential_ref as "credentialRef",
  base_url as "baseUrl", default_parameters as "defaultParameters", status, metadata,
  created_at as "createdAt", updated_at as "updatedAt"`;
const profileReturning = `id, name, description, is_default as "isDefault", privacy_mode as "privacyMode",
  output_language as "outputLanguage", provider_config_id as "providerConfigId",
  local_model_id as "localModelId", model_id as "modelId", runtime, capabilities,
  status, created_at as "createdAt", updated_at as "updatedAt"`;

function mapProvider(row: ProviderRow): AiProviderConfigRecord {
  return {
    ...row,
    defaultParameters: asJsonObject(row.defaultParameters),
    metadata: asJsonObject(row.metadata),
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

function mapProfile(row: ProfileRow): AiProfileRecord {
  return {
    ...row,
    capabilities: Array.isArray(row.capabilities) ? row.capabilities.map(String) : [],
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

export function createAiConfigRepository(db: Queryable) {
  return {
    async upsertProvider(input: {
      id?: string;
      provider: string;
      displayName: string;
      credentialRef?: string | null;
      baseUrl?: string | null;
      defaultParameters?: JsonObject;
      status?: string;
      metadata?: JsonObject;
    }): Promise<AiProviderConfigRecord> {
      const result = input.id
        ? await db.query<ProviderRow>(
            `update ai_provider_configs set provider = $2, display_name = $3, credential_ref = $4,
               base_url = $5, default_parameters = $6, status = $7, metadata = $8, updated_at = now()
             where id = $1 returning ${providerReturning}`,
            [input.id, input.provider, input.displayName, input.credentialRef ?? null,
              input.baseUrl ?? null, input.defaultParameters ?? {}, input.status ?? "configured",
              input.metadata ?? {}]
          )
        : await db.query<ProviderRow>(
            `insert into ai_provider_configs (
               provider, display_name, credential_ref, base_url, default_parameters, status, metadata
             ) values ($1, $2, $3, $4, $5, $6, $7) returning ${providerReturning}`,
            [input.provider, input.displayName, input.credentialRef ?? null,
              input.baseUrl ?? null, input.defaultParameters ?? {}, input.status ?? "configured",
              input.metadata ?? {}]
          );
      const row = result.rows[0];
      if (!row) throw new Error("AI provider configuration write returned no row.");
      return mapProvider(row);
    },

    async listProviders(): Promise<AiProviderConfigRecord[]> {
      const result = await db.query<ProviderRow>(`select ${providerReturning} from ai_provider_configs order by display_name`);
      return result.rows.map(mapProvider);
    },

    async createProfile(input: {
      name: string;
      description?: string | null;
      isDefault?: boolean;
      privacyMode?: string;
      outputLanguage?: string;
    }): Promise<AiProfileRecord> {
      const result = await db.query<ProfileRow>(
        `with unset_default as (
           update ai_profile_sets set is_default = false, updated_at = now() where $3::boolean = true
           returning id
         )
         insert into ai_profile_sets (name, description, is_default, privacy_mode, output_language)
         select $1, $2, $3, $4, $5 where (select count(*) from unset_default) >= 0
         returning ${profileReturning}`,
        [input.name, input.description ?? null, input.isDefault ?? false,
          input.privacyMode ?? "allow_remote", input.outputLanguage ?? "ui"]
      );
      const row = result.rows[0];
      if (!row) throw new Error("AI profile insert returned no row.");
      return mapProfile(row);
    },

    async cloneProfile(profileId: string, name: string): Promise<AiProfileRecord> {
      const result = await db.query<ProfileRow>(
        `with profile as (
           insert into ai_profile_sets (
             name, description, is_default, privacy_mode, output_language, provider_config_id,
             local_model_id, model_id, runtime, capabilities, status
           )
           select $2, source.description, false, source.privacy_mode, source.output_language,
                  source.provider_config_id, source.local_model_id, source.model_id, source.runtime,
                  source.capabilities, source.status
           from ai_profile_sets as source where source.id = $1
           returning *
         ), copied_tasks as (
           insert into ai_profile_tasks (profile_id, task, parameters, fallback_policy, status)
           select profile.id, source_task.task, source_task.parameters, source_task.fallback_policy, source_task.status
           from ai_profile_tasks as source_task
           cross join profile
           where source_task.profile_id = $1
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

    async updateProfile(input: {
      id: string;
      name?: string;
      privacyMode?: string;
      outputLanguage?: string;
      providerConfigId?: string | null;
      localModelId?: string | null;
      modelId?: string | null;
      runtime?: string | null;
      capabilities?: string[];
    }): Promise<AiProfileRecord> {
      const result = await db.query<ProfileRow>(
        `update ai_profile_sets set
           name = coalesce($2, name), privacy_mode = coalesce($3, privacy_mode),
           output_language = coalesce($4, output_language),
           provider_config_id = case when $5::boolean then $6::uuid else provider_config_id end,
           local_model_id = case when $5::boolean then $7::uuid else local_model_id end,
           model_id = case when $5::boolean then $8 else model_id end,
           runtime = case when $5::boolean then $9 else runtime end,
           capabilities = case when $5::boolean then $10::jsonb else capabilities end,
           updated_at = now()
         where id = $1 returning ${profileReturning}`,
        [input.id, input.name ?? null, input.privacyMode ?? null, input.outputLanguage ?? null,
          input.modelId !== undefined, input.providerConfigId ?? null, input.localModelId ?? null,
          input.modelId ?? null, input.runtime ?? null, JSON.stringify(input.capabilities ?? [])]
      );
      const row = result.rows[0];
      if (!row) throw new Error("AI profile update returned no row.");
      return mapProfile(row);
    },

    async listProfileTasks(profileId?: string): Promise<Array<{
      profileId: string;
      task: string;
      parameters: JsonObject;
    }>> {
      const result = await db.query<QueryResultRow & Record<string, unknown>>(
        `select profile_id as "profileId", task, parameters
         from ai_profile_tasks
         where status = 'active' and ($1::uuid is null or profile_id = $1)
         order by task`,
        [profileId ?? null]
      );
      return result.rows.map((row) => ({
        profileId: String(row.profileId),
        task: String(row.task),
        parameters: asJsonObject(row.parameters)
      }));
    },

    async listTaskRoutes(): Promise<Array<{ task: string; profileId: string }>> {
      const result = await db.query<QueryResultRow & { task: string; profileId: string }>(
        `select task, profile_id as "profileId" from ai_task_profile_routes order by task`
      );
      return result.rows.map((row) => ({ task: row.task, profileId: row.profileId }));
    },

    async setTaskRoute(task: string, profileId: string): Promise<void> {
      await db.query(
        `insert into ai_task_profile_routes (task, profile_id) values ($1, $2)
         on conflict (task) do update set profile_id = excluded.profile_id, updated_at = now()`,
        [task, profileId]
      );
    },

    async getDefaultTask(task: string): Promise<{
      profileId: string;
      providerConfigId: string | null;
      localModelId: string | null;
      provider: string;
      credentialRef: string | null;
      baseUrl: string | null;
      modelId: string;
      runtime: string;
      managedPath: string | null;
      repository: string | null;
      revision: string | null;
      quantization: string | null;
      requiredCapabilities: string[];
      parameters: JsonObject;
      modelDefaultParameters: JsonObject;
      providerMetadata: JsonObject;
      outputLanguage: string;
    } | null> {
      const result = await db.query<QueryResultRow & Record<string, unknown>>(
        `with chosen_profile as (
           select coalesce(
             (select profile_id from ai_task_profile_routes where task = $1),
             (select id from ai_profile_sets where is_default = true and status = 'active' limit 1)
           ) as id
         )
         select p.id as "profileId", p.provider_config_id as "providerConfigId",
                p.local_model_id as "localModelId", coalesce(c.provider, 'local-' || lm.runtime) as provider,
                c.credential_ref as "credentialRef", c.base_url as "baseUrl",
                p.model_id as "modelId", p.runtime, p.capabilities as "requiredCapabilities", t.parameters,
                coalesce(c.default_parameters, lm.default_parameters, '{}'::jsonb) as "modelDefaultParameters",
                coalesce(c.metadata, '{}'::jsonb) as "providerMetadata", p.output_language as "outputLanguage",
                lm.managed_path as "managedPath", lm.repository, lm.revision, lm.quantization
         from ai_profile_sets p
         join chosen_profile selected on selected.id = p.id
         join ai_profile_tasks t on t.profile_id = p.id
         left join ai_provider_configs c on c.id = p.provider_config_id
         left join local_models lm on lm.id = p.local_model_id and lm.status = 'ready'
         where p.status = 'active' and t.status = 'active' and t.task = $1
           and (c.id is not null or lm.id is not null)
         limit 1`,
        [task]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        profileId: String(row.profileId),
        providerConfigId: row.providerConfigId === null ? null : String(row.providerConfigId),
        localModelId: row.localModelId === null ? null : String(row.localModelId),
        provider: String(row.provider), credentialRef: row.credentialRef === null ? null : String(row.credentialRef),
        baseUrl: row.baseUrl === null ? null : String(row.baseUrl), modelId: String(row.modelId),
        runtime: String(row.runtime),
        managedPath: row.managedPath === null ? null : String(row.managedPath),
        repository: row.repository === null ? null : String(row.repository),
        revision: row.revision === null ? null : String(row.revision),
        quantization: row.quantization === null ? null : String(row.quantization),
        requiredCapabilities: Array.isArray(row.requiredCapabilities) ? row.requiredCapabilities.map(String) : [],
        parameters: asJsonObject(row.parameters),
        modelDefaultParameters: asJsonObject(row.modelDefaultParameters),
        providerMetadata: asJsonObject(row.providerMetadata),
        outputLanguage: String(row.outputLanguage)
      };
    },

    async setProfileTask(input: {
      profileId: string; task: string; parameters?: JsonObject; fallbackPolicy?: string;
    }): Promise<void> {
      await db.query(
        `insert into ai_profile_tasks (profile_id, task, parameters, fallback_policy)
         values ($1, $2, $3, $4)
         on conflict (profile_id, task) do update set
           parameters = excluded.parameters, fallback_policy = excluded.fallback_policy,
           updated_at = now()`,
        [input.profileId, input.task, input.parameters ?? {}, input.fallbackPolicy ?? "block"]
      );
    },

    async recordTaskRun(input: {
      profileId?: string | null; taskType: string; provider: string; modelId: string;
      runtime: string; capabilitiesUsed?: string[]; inputHash?: string | null;
      adapter?: string | null; repository?: string | null; revision?: string | null;
      quantization?: string | null; parameters?: JsonObject;
      outputHash?: string | null; inputTokens?: number | null; outputTokens?: number | null;
      costEstimate?: number | null; durationMs: number; status: string; error?: string | null;
    }): Promise<string> {
      const result = await db.query<QueryResultRow & { id: string }>(
        `insert into ai_task_runs (
           profile_id, task_type, provider, model_id, runtime, adapter, repository, revision,
           quantization, parameters, capabilities_used,
           input_hash, output_hash, input_tokens, output_tokens, cost_estimate,
           duration_ms, status, error, finished_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
         returning id`,
        [input.profileId ?? null, input.taskType, input.provider, input.modelId, input.runtime,
          input.adapter ?? null, input.repository ?? null, input.revision ?? null, input.quantization ?? null,
          input.parameters ?? {}, JSON.stringify(input.capabilitiesUsed ?? []), input.inputHash ?? null,
          input.outputHash ?? null, input.inputTokens ?? null, input.outputTokens ?? null,
          input.costEstimate ?? null, input.durationMs, input.status, input.error ?? null]
      );
      const row = result.rows[0];
      if (!row) throw new Error("AI task run insert returned no row.");
      return row.id;
    }
  };
}
