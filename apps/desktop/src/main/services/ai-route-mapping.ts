import { isDedicatedRanker } from "@app/ai";
import {
  createAiConfigRepository,
  createSettingsRepository,
  operationRouteKey,
  workloadClassRouteKey,
  withTransaction,
  type JsonObject,
  type PgPool
} from "@app/db";
import {
  AiClassIdSchema,
  generativeDecideOperations,
  type AiCapability,
  type AiClassId
} from "@app/domain";
import { z } from "zod";

/**
 * `mapLegacyRoutesV1` (F3 D34, spec 3.6): the seven task routes of the settings before F3 become the
 * five class routes, and every operation keeps the model (and the parameters) it ran on.
 *
 * A call resolves its model through its route keys in order: `op:<operation>`, the class route of
 * the class it states, its task route. Before F3 only a few callers stated a class, so a task route
 * alone chose the model. Once every caller states its class, a class route would choose instead; so
 * the mapping
 *
 * 1. fills each class route that is not set from its legacy task (`embed` from `embedding`,
 *    `write-fast` from `summarization` else `structured-output`, `write-quality` from
 *    `atomic-note-generation`, `answer` from `text-generation`) and never overwrites one that is set;
 *    `class:decide` is never written, it holds the F2-seeded validated ranker only;
 * 2. writes an `op:` override for each legacy operation whose task route differs from its class
 *    route, pointing at the task route's profile, so nothing changes silently;
 * 3. always writes the generative-decide operations (`op:note_matching_reranking`, ...) from the
 *    `reranking` task route when it holds a generative model, and leaves them unset otherwise, so
 *    such a call fails visibly instead of reaching the ranker (D16, R5).
 *
 * The planning is pure over {@link RouteMappingFacts}; the store reads the facts and writes the plan
 * in one transaction. A route is only useful with its profile task, which holds the parameters, so
 * every written route comes with the profile task of its key (the parameters of the legacy route
 * are copied).
 */

export const classMapSettingKey = "ai.routes.classMap.v1";

/** The seven tasks the settings routed before F3. */
export const legacyTasks = [
  "embedding",
  "summarization",
  "text-generation",
  "structured-output",
  "knowledge-graph-generation",
  "atomic-note-generation",
  "reranking"
] as const;
export type LegacyTask = (typeof legacyTasks)[number];

/** A legacy operation: the task it runs, the class it states and how it resolved before F3. */
export interface LegacyOperation {
  operation: string;
  task: LegacyTask;
  class: AiClassId;
  /** The caller stated its class before F3 (F2 topic callers), so the class route chose already. */
  classedBefore?: true;
}

const writeFast = (operation: string, task: LegacyTask): LegacyOperation => ({
  operation,
  task,
  class: "write-fast"
});
const writeQuality = (operation: string, task: LegacyTask): LegacyOperation => ({
  operation,
  task,
  class: "write-quality"
});

/**
 * Every operation that ran on a generative task route before F3. The static test of the callers
 * fails when an `operation:` of the product code is in neither this table, the operation lists
 * below, nor the internal operations: a new operation of a legacy task needs a line here.
 */
export const legacyOperations: readonly LegacyOperation[] = [
  writeFast("summary", "summarization"),
  writeFast("summary_map", "summarization"),
  writeFast("summary_reduce", "summarization"),
  writeFast("hierarchy_summary", "summarization"),
  writeFast("relation_explanation", "text-generation"),
  writeFast("source_relation_explanation", "text-generation"),
  { ...writeFast("topic_areas", "structured-output"), classedBefore: true },
  { ...writeFast("topic_name", "structured-output"), classedBefore: true },
  { ...writeFast("topic_overview", "structured-output"), classedBefore: true },
  ...["atomic_notes", "source_chunks", "catalog_metadata"].flatMap((kind) => [
    writeQuality(`graph_${kind}`, "knowledge-graph-generation"),
    writeQuality(`graph_${kind}_repair`, "knowledge-graph-generation")
  ]),
  writeQuality("entity_identity_resolution", "knowledge-graph-generation"),
  writeQuality("relation_type_resolution", "knowledge-graph-generation"),
  writeQuality("relation_labels", "knowledge-graph-generation"),
  writeQuality("atomic_note_generation", "atomic-note-generation"),
  writeQuality("atomic_note_repair", "atomic-note-generation"),
  { operation: "wiki-consultation", task: "structured-output", class: "answer" },
  { operation: "note_matching_reranking", task: "reranking", class: "decide" },
  { operation: "note_matching_reranking_repair", task: "reranking", class: "decide" },
  { operation: "source_relation_matching", task: "reranking", class: "decide" }
];

/** Operations of the embedding task: `class:embed` is the embedding route itself, so they need no override. */
export const embedOperations: readonly string[] = [
  "note_embedding",
  "note_creation_embedding",
  "note_matching_embedding",
  "topic_label_embedding",
  "benchmark_note_warmup"
];

/** Operations of the validated ranker (`rank`, `rankPairs`): they resolve `class:decide` only. */
export const rankerOperations: readonly string[] = [
  "topic_gate",
  "topic_overview_support",
  "relation_decide",
  "class_test_decide"
];

/** Operations introduced by F3 itself: they have no legacy route, so their class route chooses. */
export const f3Operations: readonly string[] = [
  "relation_typing",
  "relation_typing_repair",
  "relation_escalation"
];

/**
 * Operations that choose their model apart from the routes: settings diagnostics, which run the
 * model under test or the legacy task route of a prompt sample, and the DEV probes of a task
 * route's backend (the lane probe on `reranking`, the strict-schema probe on `structured-output`),
 * and the opt-in OpenAI Decisions decider and its key test, which run on a provider and a lane of
 * their own with the person's Platform key (plan decision 30).
 */
export const internalOperations: readonly string[] = [
  "local_model_test",
  "prompt_catalog_sample",
  "class_test",
  "lane_probe",
  "schema_probe",
  "relation_decide_decisions",
  "decisions_key_test"
];

/** The legacy tasks each class takes its route from, in order; `decide` is never mapped. */
export const legacyClassChains: Record<Exclude<AiClassId, "decide">, readonly LegacyTask[]> = {
  embed: ["embedding"],
  "write-fast": ["summarization", "structured-output"],
  "write-quality": ["atomic-note-generation"],
  answer: ["text-generation"]
};

// --- Facts and resolution ---------------------------------------------------------------------

export interface RouteMappingProfile {
  id: string;
  status: string;
  isDefault: boolean;
  modelId: string | null;
  capabilities: readonly string[];
  providerConfigId: string | null;
  localModelId: string | null;
}

export interface RouteMappingFacts {
  profiles: readonly RouteMappingProfile[];
  routes: ReadonlyArray<{ task: string; profileId: string }>;
  profileTasks: ReadonlyArray<{ profileId: string; task: string; parameters: JsonObject }>;
}

export interface ResolvedRoute {
  profileId: string;
  /** The route key that chose the profile; its profile task holds the parameters. */
  key: string;
  parameters: JsonObject;
}

/** Whether a profile can serve a call at all: active, with a model on a provider or a local model. */
function usable(profile: RouteMappingProfile | undefined): profile is RouteMappingProfile {
  return (
    profile !== undefined &&
    profile.status === "active" &&
    profile.modelId !== null &&
    (profile.providerConfigId !== null || profile.localModelId !== null)
  );
}

/** A generative profile (a remote model, or a local model that is not a dedicated ranker). */
export function isGenerativeProfile(profile: RouteMappingProfile): boolean {
  return (
    profile.providerConfigId !== null ||
    (profile.localModelId !== null && !isDedicatedRanker(profile.capabilities as AiCapability[]))
  );
}

/**
 * Mirrors `getDefaultTask`: the first route key with a route chooses the profile, otherwise the
 * default profile serves the task; the chosen key's profile task must exist, and a route whose
 * profile cannot serve yields nothing (it never falls through).
 */
export function resolveRoute(
  facts: RouteMappingFacts,
  keys: readonly string[],
  task: string
): ResolvedRoute | null {
  const profiles = new Map(facts.profiles.map((profile) => [profile.id, profile]));
  const routes = new Map(facts.routes.map((route) => [route.task, route.profileId]));
  const routedKey = keys.find((key) => routes.has(key));
  const key = routedKey ?? task;
  const profileId =
    routedKey !== undefined
      ? routes.get(routedKey)
      : facts.profiles.find((profile) => profile.isDefault && profile.status === "active")?.id;
  if (profileId === undefined || !usable(profiles.get(profileId))) return null;
  const row = facts.profileTasks.find(
    (entry) => entry.profileId === profileId && entry.task === key
  );
  return row ? { profileId, key, parameters: row.parameters } : null;
}

const canonical = (value: JsonObject): string =>
  JSON.stringify(
    Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  );

function sameRoute(left: ResolvedRoute | null, right: ResolvedRoute | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.profileId === right.profileId && canonical(left.parameters) === canonical(right.parameters)
  );
}

// --- The plan ---------------------------------------------------------------------------------

export interface PlannedRoute {
  key: string;
  profileId: string;
  parameters: JsonObject;
  /** The legacy route key the profile and parameters came from. */
  from: string;
}

export interface RouteMappingPlan {
  classRoutes: PlannedRoute[];
  operationRoutes: PlannedRoute[];
}

export const ClassMapStateSchema = z
  .object({
    version: z.literal(1),
    mappedAt: z.string(),
    /** Route keys the mapping wrote, so a preset can release the overrides it wrote. */
    classRoutes: z.array(z.string()),
    operationRoutes: z.array(z.string()),
    /** Classes a person routed themselves (a preset or a custom choice): the mapping leaves them alone. */
    releasedClasses: z.array(AiClassIdSchema).default([])
  })
  .strict();
export type ClassMapState = z.infer<typeof ClassMapStateSchema>;

/** The routes the mapping would write now; empty once it has run (idempotent). */
export function planLegacyRouteMapping(
  facts: RouteMappingFacts,
  releasedClasses: readonly AiClassId[] = []
): RouteMappingPlan {
  const released = new Set<AiClassId>(releasedClasses);
  const routes = new Map(facts.routes.map((route) => [route.task, route.profileId]));
  const profiles = new Map(facts.profiles.map((profile) => [profile.id, profile]));
  const classRoutes: PlannedRoute[] = [];
  const parametersOf = (profileId: string, key: string): JsonObject =>
    facts.profileTasks.find((entry) => entry.profileId === profileId && entry.task === key)
      ?.parameters ?? {};

  for (const [classId, chain] of Object.entries(legacyClassChains) as Array<
    [Exclude<AiClassId, "decide">, readonly LegacyTask[]]
  >) {
    const key = workloadClassRouteKey(classId);
    if (released.has(classId) || routes.has(key)) continue;
    for (const task of chain) {
      const profileId = routes.get(task);
      if (profileId === undefined || !usable(profiles.get(profileId))) continue;
      classRoutes.push({
        key,
        profileId,
        parameters: parametersOf(profileId, task),
        from: task
      });
      break;
    }
  }

  const mapped = withPlannedRoutes(facts, classRoutes);
  const operationRoutes: PlannedRoute[] = [];
  for (const entry of legacyOperations) {
    const key = operationRouteKey(entry.operation);
    if (entry.class === "decide" || released.has(entry.class) || routes.has(key)) continue;
    const before = resolveRoute(
      facts,
      entry.classedBefore ? [workloadClassRouteKey(entry.class), entry.task] : [entry.task],
      entry.task
    );
    const after = resolveRoute(
      mapped,
      [workloadClassRouteKey(entry.class), entry.task],
      entry.task
    );
    if (before === null || sameRoute(before, after)) continue;
    operationRoutes.push({
      key,
      profileId: before.profileId,
      parameters: before.parameters,
      from: before.key
    });
  }

  // The generative-decide operations are written whenever the `reranking` route holds a generative
  // model, and never left to fall through to `class:decide` otherwise (D16, R5).
  const rerankingProfileId = routes.get("reranking");
  const reranking = rerankingProfileId ? profiles.get(rerankingProfileId) : undefined;
  if (rerankingProfileId && usable(reranking) && isGenerativeProfile(reranking)) {
    for (const operation of generativeDecideOperations) {
      const key = operationRouteKey(operation);
      if (routes.has(key) || released.has("decide")) continue;
      operationRoutes.push({
        key,
        profileId: rerankingProfileId,
        parameters: parametersOf(rerankingProfileId, "reranking"),
        from: "reranking"
      });
    }
  }
  return { classRoutes, operationRoutes };
}

/** The facts after a plan is written (a route and its profile task per planned key). */
export function withPlannedRoutes(
  facts: RouteMappingFacts,
  planned: readonly PlannedRoute[]
): RouteMappingFacts {
  const keys = new Set(planned.map((route) => route.key));
  return {
    profiles: facts.profiles,
    routes: [
      ...facts.routes.filter((route) => !keys.has(route.task)),
      ...planned.map((route) => ({ task: route.key, profileId: route.profileId }))
    ],
    profileTasks: [
      ...facts.profileTasks.filter(
        (entry) =>
          !planned.some((route) => route.key === entry.task && route.profileId === entry.profileId)
      ),
      ...planned.map((route) => ({
        profileId: route.profileId,
        task: route.key,
        parameters: route.parameters
      }))
    ]
  };
}

export function applyRouteMappingPlan(
  facts: RouteMappingFacts,
  plan: RouteMappingPlan
): RouteMappingFacts {
  return withPlannedRoutes(facts, [...plan.classRoutes, ...plan.operationRoutes]);
}

// --- The effective models (the dump) ----------------------------------------------------------

export interface EffectiveRoute {
  operation: string;
  task: LegacyTask;
  class: AiClassId;
  /** The profile and parameters the call resolves, or null when it fails to resolve. */
  route: { profileId: string; parameters: JsonObject } | null;
}

/**
 * The model each legacy operation runs on. `legacy` follows the route keys of F3's predecessor (the
 * operation override, the class route only for callers that already stated a class, the task
 * route); `classed` follows the keys of every caller stating its class. The mapping holds when
 * both dumps are equal before and after it ran, for every operation whose legacy model resolved.
 */
export function describeEffectiveRoutes(
  facts: RouteMappingFacts,
  mode: "legacy" | "classed"
): EffectiveRoute[] {
  return legacyOperations.map((entry) => {
    const keys = [
      operationRouteKey(entry.operation),
      ...(mode === "classed" || entry.classedBefore ? [workloadClassRouteKey(entry.class)] : []),
      entry.task
    ];
    const resolved = resolveRoute(facts, keys, entry.task);
    return {
      operation: entry.operation,
      task: entry.task,
      class: entry.class,
      route: resolved ? { profileId: resolved.profileId, parameters: resolved.parameters } : null
    };
  });
}

/** Operations whose legacy model resolved but whose classed model differs: empty when nothing changed. */
export function effectiveRouteChanges(
  before: readonly EffectiveRoute[],
  after: readonly EffectiveRoute[]
): Array<{ operation: string; before: EffectiveRoute["route"]; after: EffectiveRoute["route"] }> {
  return before.flatMap((entry, index) => {
    const next = after[index]!;
    if (entry.route === null) return [];
    const same =
      next.route !== null &&
      next.route.profileId === entry.route.profileId &&
      canonical(next.route.parameters) === canonical(entry.route.parameters);
    return same ? [] : [{ operation: entry.operation, before: entry.route, after: next.route }];
  });
}

// --- The store --------------------------------------------------------------------------------

export interface RouteMappingStore {
  read(): Promise<{ facts: RouteMappingFacts; state: ClassMapState | null }>;
  /** Writes every planned route with its profile task and the state, atomically. */
  write(plan: RouteMappingPlan, state: ClassMapState): Promise<void>;
}

export function createRouteMappingStore(pool: PgPool): RouteMappingStore {
  return {
    async read() {
      const config = createAiConfigRepository(pool);
      const profileTasks = await config.listProfileTasks();
      const [profiles, routes, stored] = await Promise.all([
        config.listProfiles(),
        config.listTaskRoutes(),
        createSettingsRepository(pool).get(classMapSettingKey)
      ]);
      const parsed = ClassMapStateSchema.safeParse(stored);
      return {
        facts: {
          profiles: profiles.map((profile) => ({
            id: profile.id,
            status: profile.status,
            isDefault: profile.isDefault,
            modelId: profile.modelId,
            capabilities: profile.capabilities,
            providerConfigId: profile.providerConfigId,
            localModelId: profile.localModelId
          })),
          routes,
          profileTasks
        },
        state: parsed.success ? parsed.data : null
      };
    },
    async write(plan, state) {
      await withTransaction(pool, async (client) => {
        const config = createAiConfigRepository(client);
        for (const route of [...plan.classRoutes, ...plan.operationRoutes]) {
          await config.setProfileTask({
            profileId: route.profileId,
            task: route.key,
            parameters: route.parameters
          });
          await config.setTaskRoute(route.key, route.profileId);
        }
        await createSettingsRepository(client).set(classMapSettingKey, state);
      });
    }
  };
}

export interface RouteMappingResult {
  /** The keys written by this run; empty when the mapping had nothing to do. */
  classRoutes: string[];
  operationRoutes: string[];
}

/**
 * Runs the mapping once more: it fills what is missing and records what it wrote in
 * `ai.routes.classMap.v1`. Idempotent: a second run writes nothing, and a route that is set is
 * never overwritten.
 */
export async function mapLegacyRoutesV1(
  store: RouteMappingStore,
  now: () => Date = () => new Date()
): Promise<RouteMappingResult> {
  const { facts, state } = await store.read();
  const plan = planLegacyRouteMapping(facts, state?.releasedClasses ?? []);
  const written = {
    classRoutes: plan.classRoutes.map((route) => route.key),
    operationRoutes: plan.operationRoutes.map((route) => route.key)
  };
  if (written.classRoutes.length === 0 && written.operationRoutes.length === 0) return written;
  await store.write(plan, {
    version: 1,
    mappedAt: now().toISOString(),
    classRoutes: [...new Set([...(state?.classRoutes ?? []), ...written.classRoutes])],
    operationRoutes: [...new Set([...(state?.operationRoutes ?? []), ...written.operationRoutes])],
    releasedClasses: state?.releasedClasses ?? []
  });
  return written;
}

/** The generative-decide operations that have no route among these route keys (D16, R5). */
export function unroutedGenerativeDecide(routeKeys: Iterable<string>): string[] {
  const keys = new Set(routeKeys);
  return generativeDecideOperations.filter((operation) => !keys.has(operationRouteKey(operation)));
}

/** The legacy operations of a class, for releasing the overrides the mapping wrote for it. */
export function legacyOperationKeys(classIds: readonly AiClassId[]): string[] {
  return legacyOperations
    .filter((entry) => entry.class !== "decide" && classIds.includes(entry.class))
    .map((entry) => operationRouteKey(entry.operation));
}
