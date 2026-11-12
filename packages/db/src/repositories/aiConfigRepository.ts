import type { QueryResultRow } from "pg";

import { bumpingGenerationAfter } from "./aiConfigGeneration.js";
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
  id: string;
  provider: string;
  displayName: string;
  credentialRef: string | null;
  baseUrl: string | null;
  defaultParameters: unknown;
  status: string;
  metadata: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

interface ProfileRow extends QueryResultRow {
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
  capabilities: unknown;
  status: string;
  createdAt: unknown;
  updatedAt: unknown;
}

const providerReturning = `id, provider, display_name as "displayName", credential_ref as "credentialRef",
  base_url as "baseUrl", default_parameters as "defaultParameters", status, metadata,
  created_at as "createdAt", updated_at as "updatedAt"`;
const profileReturning = `id, name, description, is_default as "isDefault", privacy_mode as "privacyMode",
  output_language as "outputLanguage", provider_config_id as "providerConfigId",
  local_model_id as "localModelId", model_id as "modelId", runtime, capabilities,
  status, created_at as "createdAt", updated_at as "updatedAt"`;

/**
 * Route keys of `ai_task_profile_routes.task` (D18). A task route is keyed by the task itself; an
 * operation override by `op:<operation>`; a workload-class route by `class:<class>`. Each route
 * has the profile task of the same key, which holds its parameters.
 */
export const operationRoutePrefix = "op:";
export const workloadClassRoutePrefix = "class:";

export function operationRouteKey(operation: string): string {
  return `${operationRoutePrefix}${operation}`;
}

export function workloadClassRouteKey(workloadClass: string): string {
  return `${workloadClassRoutePrefix}${workloadClass}`;
}

/**
 * The route keys a call resolves, in order: its operation override, then the class route of a
 * class the caller stated (never a class derived from the task type), then the task route.
 */
export function aiRouteKeys(
  task: string,
  options: { operation?: string | undefined; workloadClass?: string | undefined } = {}
): string[] {
  return [
    ...(options.operation ? [operationRouteKey(options.operation)] : []),
    ...(options.workloadClass ? [workloadClassRouteKey(options.workloadClass)] : []),
    task
  ];
}

/** Instrumentation counters stay null (unknown) unless they are finite and non-negative. */
function nonNegativeInteger(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function positiveInteger(value: number | null | undefined): number | null {
  const rounded = nonNegativeInteger(value);
  return rounded !== null && rounded > 0 ? rounded : null;
}

/** A job id the audit can store; a caller's non-UUID job label stays out of the column. */
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

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

/**
 * The methods that change what a call resolves (a provider, a profile, a route, a profile task):
 * each bumps the AI configuration generation once it settles (F3 D38), so the hot-path caches drop
 * what they read. A test enumerates this repository and fails for a method in neither list.
 */
export const aiConfigRepositoryWriters = [
  "upsertProvider",
  "deleteProvider",
  "createProfile",
  "cloneProfile",
  "deleteProfile",
  "updateProfile",
  "setTaskRoute",
  "deleteTaskRoute",
  "seedTaskRoute",
  "cacheProviderModelContext",
  "setProfileTask"
] as const;
/** The methods that only read the configuration, or write the audit of a call. */
export const aiConfigRepositoryReaders = [
  "listProviders",
  "listProfiles",
  "listProfileTasks",
  "listTaskRoutes",
  "getDefaultTask",
  "getRoutedLocalModelStatus",
  "recordTaskRun"
] as const;

/**
 * The profile a task runs on ($1 task, $2 explicit profile, $3 route keys): the first route key
 * with a route, else the default profile. Shared by `getDefaultTask` and its install-state reader.
 */
const chosenProfileCte = `with route as (
           select r.profile_id, r.task
           from unnest($3::text[]) with ordinality as wanted(key, position)
           join ai_task_profile_routes r on r.task = wanted.key
           order by wanted.position
           limit 1
         ), chosen_profile as (
           select coalesce(
             $2::uuid,
             (select profile_id from route),
             (select id from ai_profile_sets where is_default = true and status = 'active' limit 1)
           ) as id,
           case when $2::uuid is null then coalesce((select task from route), $1) else $1 end
             as route_key
         )`;
/** The chosen profile is active and its task row serves the route key (`p`, `t`, `selected`). */
const servedProfileTask = `p.status = 'active' and (($2::uuid is not null and (t.status is null or t.status='active')) or (t.status = 'active' and t.task = selected.route_key))`;

export function createAiConfigRepository(db: Queryable) {
  return bumpingGenerationAfter(aiConfigMethods(db), aiConfigRepositoryWriters);
}

function aiConfigMethods(db: Queryable) {
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
            `with updated_provider as (
               update ai_provider_configs set provider = $2, display_name = $3, credential_ref = $4,
                 base_url = $5, default_parameters = $6, status = $7, metadata = $8, updated_at = now()
               where id = $1 returning ${providerReturning}
             ), updated_profiles as (
               update ai_profile_sets set
                 model_id = coalesce($8::jsonb ->> 'modelId', model_id),
                 capabilities = coalesce($8::jsonb -> 'capabilities', capabilities),
                 updated_at = now()
               where provider_config_id = $1 and exists (select 1 from updated_provider)
               returning id
             )
             select * from updated_provider
             where (select count(*) from updated_profiles) >= 0`,
            [
              input.id,
              input.provider,
              input.displayName,
              input.credentialRef ?? null,
              input.baseUrl ?? null,
              input.defaultParameters ?? {},
              input.status ?? "configured",
              input.metadata ?? {}
            ]
          )
        : await db.query<ProviderRow>(
            `insert into ai_provider_configs (
               provider, display_name, credential_ref, base_url, default_parameters, status, metadata
             ) values ($1, $2, $3, $4, $5, $6, $7) returning ${providerReturning}`,
            [
              input.provider,
              input.displayName,
              input.credentialRef ?? null,
              input.baseUrl ?? null,
              input.defaultParameters ?? {},
              input.status ?? "configured",
              input.metadata ?? {}
            ]
          );
      const row = result.rows[0];
      if (!row) throw new Error("AI provider configuration write returned no row.");
      return mapProvider(row);
    },

    async listProviders(): Promise<AiProviderConfigRecord[]> {
      const result = await db.query<ProviderRow>(
        `select ${providerReturning} from ai_provider_configs order by display_name`
      );
      return result.rows.map(mapProvider);
    },

    async deleteProvider(providerId: string): Promise<AiProviderConfigRecord | null> {
      const result = await db.query<ProviderRow>(
        `with unlinked_profiles as (
           update ai_profile_sets set provider_config_id = null, model_id = null, runtime = null,
             capabilities = '[]'::jsonb, updated_at = now()
           where provider_config_id = $1
           returning id
         )
         delete from ai_provider_configs
         where id = $1 and (select count(*) from unlinked_profiles) >= 0
         returning ${providerReturning}`,
        [providerId]
      );
      const row = result.rows[0];
      return row ? mapProvider(row) : null;
    },

    async createProfile(input: {
      name: string;
      description?: string | null;
      isDefault?: boolean;
      /** @deprecated Ignored: `privacy_mode` is no longer written (F5 T172); the column default applies. */
      privacyMode?: string;
      outputLanguage?: string;
    }): Promise<AiProfileRecord> {
      const result = await db.query<ProfileRow>(
        `with unset_default as (
           update ai_profile_sets set is_default = false, updated_at = now() where $3::boolean = true
           returning id
         )
         insert into ai_profile_sets (name, description, is_default, output_language)
         select $1, $2, $3, $4 where (select count(*) from unset_default) >= 0
         returning ${profileReturning}`,
        [
          input.name,
          input.description ?? null,
          input.isDefault ?? false,
          input.outputLanguage ?? "ui"
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error("AI profile insert returned no row.");
      return mapProfile(row);
    },

    async cloneProfile(profileId: string, name: string): Promise<AiProfileRecord> {
      const result = await db.query<ProfileRow>(
        `with profile as (
           insert into ai_profile_sets (
             name, description, is_default, output_language, provider_config_id,
             local_model_id, model_id, runtime, capabilities, status
           )
           select $2, source.description, false, source.output_language,
                  source.provider_config_id, source.local_model_id, source.model_id, source.runtime,
                  source.capabilities, source.status
           from ai_profile_sets as source where source.id = $1
           returning *
         ), copied_tasks as (
           insert into ai_profile_tasks (profile_id, task, parameters, status)
           select profile.id, source_task.task, source_task.parameters, source_task.status
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
      const result = await db.query<ProfileRow>(
        `select ${profileReturning} from ai_profile_sets order by is_default desc, name`
      );
      return result.rows.map(mapProfile);
    },

    async deleteProfile(profileId: string): Promise<boolean> {
      const result = await db.query("delete from ai_profile_sets where id = $1", [profileId]);
      return (result.rowCount ?? 0) > 0;
    },

    async updateProfile(input: {
      id: string;
      name?: string;
      /** @deprecated Ignored: `privacy_mode` is no longer written (F5 T172). */
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
           name = coalesce($2, name),
           output_language = coalesce($3, output_language),
           provider_config_id = case when $4::boolean then $5::uuid else provider_config_id end,
           local_model_id = case when $4::boolean then $6::uuid else local_model_id end,
           model_id = case when $4::boolean then $7 else model_id end,
           runtime = case when $4::boolean then $8 else runtime end,
           capabilities = case when $4::boolean then $9::jsonb else capabilities end,
           updated_at = now()
         where id = $1 returning ${profileReturning}`,
        [
          input.id,
          input.name ?? null,
          input.outputLanguage ?? null,
          input.modelId !== undefined,
          input.providerConfigId ?? null,
          input.localModelId ?? null,
          input.modelId ?? null,
          input.runtime ?? null,
          JSON.stringify(input.capabilities ?? [])
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error("AI profile update returned no row.");
      return mapProfile(row);
    },

    async listProfileTasks(profileId?: string): Promise<
      Array<{
        profileId: string;
        task: string;
        parameters: JsonObject;
      }>
    > {
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

    /** Removes a route (a class or operation override); its profile tasks stay. */
    async deleteTaskRoute(task: string): Promise<boolean> {
      const result = await db.query("delete from ai_task_profile_routes where task = $1", [task]);
      return (result.rowCount ?? 0) > 0;
    },

    /**
     * Routes a task that has no route to the profile, creating the profile task the route needs. An existing
     * route or profile task is left as it is. Returns whether a route was created.
     */
    async seedTaskRoute(task: string, profileId: string): Promise<boolean> {
      const result = await db.query<QueryResultRow & { count: string }>(
        `with ensured_task as (
           insert into ai_profile_tasks (profile_id, task, parameters)
           values ($2, $1, '{}'::jsonb)
           on conflict (profile_id, task) do nothing
           returning id
         ), seeded_route as (
           insert into ai_task_profile_routes (task, profile_id) values ($1, $2)
           on conflict (task) do nothing
           returning id
         )
         select count(*)::text as count from seeded_route
         where (select count(*) from ensured_task) >= 0`,
        [task, profileId]
      );
      return Number(result.rows[0]?.count ?? 0) > 0;
    },

    async cacheProviderModelContext(
      id: string,
      provider: string,
      modelId: string,
      baseUrl: string | null,
      limits: JsonObject
    ): Promise<void> {
      await db.query(
        "update ai_provider_configs set metadata=jsonb_set(metadata,'{modelLimits}',$4::jsonb) where id=$1 and metadata->>'modelId'=$2 and base_url is not distinct from $3 and provider=$5",
        [id, modelId, baseUrl, limits, provider]
      );
    },

    /**
     * The model a task runs on. Without an explicit profile, the first of `routeKeys` (in order)
     * that has a route chooses the profile, and that route key's profile task supplies the
     * parameters; with no route for any key, the default profile serves the task with its own
     * profile task. `routeKeys` defaults to the task alone, and the AI service passes the
     * operation override and a stated class route before it (`op:<operation>`, `class:<class>`).
     * A route whose profile cannot serve it yields null: it never falls through to another
     * route or to the default profile. `routeKey` names the key that chose the profile.
     */
    async getDefaultTask(
      task: string,
      explicitProfileId?: string,
      routeKeys: readonly string[] = [task]
    ): Promise<{
      routeKey: string;
      profileId: string;
      privacyMode: string;
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
        `${chosenProfileCte}
         select selected.route_key as "routeKey",
                p.id as "profileId", p.privacy_mode as "privacyMode", p.provider_config_id as "providerConfigId",
                p.local_model_id as "localModelId", coalesce(c.provider, 'local-' || lm.runtime) as provider,
                c.credential_ref as "credentialRef", c.base_url as "baseUrl",
                p.model_id as "modelId", p.runtime, p.capabilities as "requiredCapabilities", t.parameters,
                coalesce(c.default_parameters, lm.default_parameters, '{}'::jsonb) as "modelDefaultParameters",
                coalesce(c.metadata, '{}'::jsonb) as "providerMetadata", p.output_language as "outputLanguage",
                lm.managed_path as "managedPath", lm.repository, lm.revision, lm.quantization
         from ai_profile_sets p
         join chosen_profile selected on selected.id = p.id
         left join ai_profile_tasks t on t.profile_id = p.id and t.task = selected.route_key
         left join ai_provider_configs c on c.id = p.provider_config_id
         left join local_models lm on lm.id = p.local_model_id and lm.status = 'ready'
         where ${servedProfileTask}
           and (c.id is not null or lm.id is not null)
         limit 1`,
        [task, explicitProfileId ?? null, routeKeys.length > 0 ? [...routeKeys] : [task]]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        routeKey: String(row.routeKey),
        profileId: String(row.profileId),
        privacyMode: String(row.privacyMode),
        providerConfigId: row.providerConfigId === null ? null : String(row.providerConfigId),
        localModelId: row.localModelId === null ? null : String(row.localModelId),
        provider: String(row.provider),
        credentialRef: row.credentialRef === null ? null : String(row.credentialRef),
        baseUrl: row.baseUrl === null ? null : String(row.baseUrl),
        modelId: String(row.modelId),
        runtime: String(row.runtime),
        managedPath: row.managedPath === null ? null : String(row.managedPath),
        repository: row.repository === null ? null : String(row.repository),
        revision: row.revision === null ? null : String(row.revision),
        quantization: row.quantization === null ? null : String(row.quantization),
        requiredCapabilities: Array.isArray(row.requiredCapabilities)
          ? row.requiredCapabilities.map(String)
          : [],
        parameters: asJsonObject(row.parameters),
        modelDefaultParameters: asJsonObject(row.modelDefaultParameters),
        providerMetadata: asJsonObject(row.providerMetadata),
        outputLanguage: String(row.outputLanguage)
      };
    },

    /**
     * The install status of the local model `getDefaultTask` would choose (same arguments, route,
     * profile and task rows) if that model were ready; null when the chosen profile serves the task
     * through a provider or none serves it. F4 D7: a task whose routed model is still downloading
     * or being verified waits for it instead of failing.
     */
    async getRoutedLocalModelStatus(
      task: string,
      explicitProfileId?: string,
      routeKeys: readonly string[] = [task]
    ): Promise<string | null> {
      const result = await db.query<{ status: string }>(
        `${chosenProfileCte}
         select lm.status
         from ai_profile_sets p
         join chosen_profile selected on selected.id = p.id
         left join ai_profile_tasks t on t.profile_id = p.id and t.task = selected.route_key
         join local_models lm on lm.id = p.local_model_id
         where ${servedProfileTask} and p.provider_config_id is null
         limit 1`,
        [task, explicitProfileId ?? null, routeKeys.length > 0 ? [...routeKeys] : [task]]
      );
      return result.rows[0]?.status ?? null;
    },

    async setProfileTask(input: {
      profileId: string;
      task: string;
      parameters?: JsonObject;
    }): Promise<void> {
      await db.query(
        `insert into ai_profile_tasks (profile_id, task, parameters)
         values ($1, $2, $3)
         on conflict (profile_id, task) do update set
           parameters = excluded.parameters, updated_at = now()`,
        [input.profileId, input.task, input.parameters ?? {}]
      );
    },

    async recordTaskRun(input: {
      profileId?: string | null;
      taskType: string;
      provider: string;
      modelId: string;
      runtime: string;
      capabilitiesUsed?: string[];
      inputHash?: string | null;
      adapter?: string | null;
      repository?: string | null;
      revision?: string | null;
      quantization?: string | null;
      parameters?: JsonObject;
      outputHash?: string | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
      costEstimate?: number | null;
      durationMs: number;
      /** Wait in the AI execution queue before the call started; omitted when not measured. */
      queueMs?: number | null;
      /** Zero-based retry index reported by the caller; omitted when the caller reports none. */
      attempt?: number | null;
      status: string;
      error?: string | null;
      sourceItemIds?: string[];
      promptCompositions?: unknown[];
      /** The scheduler lane: `local` or `remote:<providerConfigId>`; omitted when unknown. */
      lane?: string | null;
      workloadClass?: string | null;
      /** 0 for P0 (interactive) to 3 for P3 (maintenance). */
      priority?: number | null;
      /** The effective total deadline of the call, from its execution start. */
      deadlineMs?: number | null;
      /** `met`, `aborted` (a deadline ended the call) or `none` (the call had no deadline). */
      deadlineOutcome?: "met" | "aborted" | "none" | null;
      /** A second call for the same items after a validation failure. */
      isRepair?: boolean;
      schemaMode?: "strict" | "json" | "grammar" | "none" | null;
      /** Time spent sleeping for retries, off the lane. */
      retryWaitMs?: number | null;
      /** Time spent waiting for the lane again between attempts, excluded from the deadline. */
      requeueMs?: number | null;
      /** Who the call spent for (F4 D14): `user`, `background` or `interactive`; omitted when unknown. */
      budgetClass?: "user" | "background" | "interactive" | null;
      /** The job the call ran for. */
      jobId?: string | null;
      /** The US$ estimate the call's attempts were admitted with on a priced route. */
      budgetEstimateUsd?: number | null;
    }): Promise<string> {
      const result = await db.query<QueryResultRow & { id: string }>(
        `with inserted_run as (
           insert into ai_task_runs (
             profile_id, task_type, provider, model_id, runtime, adapter, repository, revision,
             quantization, parameters, capabilities_used,
             input_hash, output_hash, input_tokens, output_tokens, cost_estimate,
             duration_ms, status, error, prompt_compositions, queue_ms, attempt, finished_at, started_at,
             lane, workload_class, priority, deadline_ms, deadline_outcome, is_repair, schema_mode,
             retry_wait_ms, requeue_ms, budget_class, job_id, budget_estimate_usd
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$21::jsonb,$22,$23,now(),
             -- The row is written when the call ends, so its real start is the end minus the measured duration.
             now() - ($17::integer * interval '1 millisecond'),
             $24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34::uuid,$35)
           returning id
         ), live_sources as (
           -- A source deleted before the run ends has no provenance row to hold, and its id never
           -- costs the run its audit row. The key-share lock keeps a listed source until this commits.
           select id from source_items where id = any($20::uuid[]) order by id for key share
         ), inserted_sources as (
           insert into ai_task_run_sources (ai_task_run_id, source_item_id)
           select inserted_run.id, live_sources.id
           from inserted_run cross join live_sources
           on conflict (ai_task_run_id, source_item_id) do nothing
           returning id
         )
         select id from inserted_run
         where (select count(*) from inserted_sources) >= 0`,
        [
          input.profileId ?? null,
          input.taskType,
          input.provider,
          input.modelId,
          input.runtime,
          input.adapter ?? null,
          input.repository ?? null,
          input.revision ?? null,
          input.quantization ?? null,
          input.parameters ?? {},
          JSON.stringify(input.capabilitiesUsed ?? []),
          input.inputHash ?? null,
          input.outputHash ?? null,
          input.inputTokens ?? null,
          input.outputTokens ?? null,
          input.costEstimate ?? null,
          input.durationMs,
          input.status,
          input.error ?? null,
          [...new Set(input.sourceItemIds ?? [])],
          JSON.stringify(input.promptCompositions ?? []),
          nonNegativeInteger(input.queueMs),
          nonNegativeInteger(input.attempt),
          input.lane ?? null,
          input.workloadClass ?? null,
          typeof input.priority === "number" &&
          Number.isInteger(input.priority) &&
          input.priority >= 0 &&
          input.priority <= 3
            ? input.priority
            : null,
          positiveInteger(input.deadlineMs),
          input.deadlineOutcome ?? null,
          input.isRepair === true,
          input.schemaMode ?? null,
          nonNegativeInteger(input.retryWaitMs),
          nonNegativeInteger(input.requeueMs),
          input.budgetClass ?? null,
          input.jobId && uuidPattern.test(input.jobId) ? input.jobId : null,
          typeof input.budgetEstimateUsd === "number" &&
          Number.isFinite(input.budgetEstimateUsd) &&
          input.budgetEstimateUsd >= 0
            ? input.budgetEstimateUsd
            : null
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error("AI task run insert returned no row.");
      return row.id;
    }
  };
}
