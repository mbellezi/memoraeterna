import { totalmem } from "node:os";

import { findLocalModelCatalogEntry, redactSensitiveText } from "@app/ai";
import {
  createAiConfigRepository,
  createLocalModelRepository,
  createSettingsRepository,
  operationRouteKey,
  workloadClassRouteKey,
  withTransaction,
  type AiProfileRecord,
  type LocalModelRecord,
  type PgClient,
  type PgPool
} from "@app/db";
import {
  aiClassIds,
  AiPresetModeSchema,
  generativeDecideOperations,
  NoteDeciderModeSchema,
  planAiPreset,
  relationsDeciderModeSettingKey,
  supportsTask,
  type AiCapability,
  type AiClassId,
  type AiPresetId,
  type AiPresetMode,
  type AiPresetPlan,
  type NoteDeciderMode,
  type PresetMachine,
  type PresetTarget
} from "@app/domain";
import { z } from "zod";

import type {
  AiApplyPresetInput,
  AiApplyPresetResult,
  AiClassRoute,
  AiClassRouteTarget,
  AiClassRoutes,
  AiClassTest,
  AiProfile,
  AiProfileCreate,
  AiProfileUpdate,
  AiSetClassRouteInput
} from "../../shared/ipc.js";
import {
  ClassMapStateSchema,
  classMapSettingKey,
  isGenerativeProfile,
  legacyOperationKeys,
  type ClassMapState,
  type RouteMappingProfile
} from "./ai-route-mapping.js";
import type { AiService } from "./ai-service.js";
import { buildBatchRerankPrompt, parseBatchRerankOutput } from "./knowledge-processing.js";
import { renderPrompt } from "./prompt-runtime.js";

/**
 * Settings › AI over the workload classes (F3 D34, spec 3.6): which model serves each of the five
 * classes and the generative judge, the Local, Hybrid and Cloud presets that seed them, and one
 * test call per class. The class routes are `class:<class>` rows of `ai_task_profile_routes`; the
 * judge is the four generative-decide `op:` routes plus the legacy `reranking` task route, which
 * source-relation processing still reads for its configuration fingerprint.
 *
 * A failed test never falls back: the class stays unverified with its reason shown, and the route
 * keeps its model. A preset that needs a model this machine does not have writes nothing.
 */

export const presetSettingKey = "ai.preset.v1";
export const classTestsSettingKey = "ai.classTests.v1";
/** The note decider mode the matcher reads (T51); one key for both. */
export const deciderModeSettingKey = relationsDeciderModeSettingKey;

const PresetStateSchema = z.object({ mode: AiPresetModeSchema, at: z.string() }).strict();
const StoredTestSchema = z
  .object({
    profileId: z.string().nullable(),
    model: z.string().nullable(),
    state: z.enum(["passed", "failed", "none"]),
    ms: z.number().int().nonnegative().nullable(),
    at: z.string(),
    error: z.string().nullable()
  })
  .strict();
type StoredTest = z.infer<typeof StoredTestSchema>;

/** What the class tests and the preset flow need of the AI service. */
export type ClassRoutesAi = Pick<AiService, "runDefaultTask" | "rank"> & {
  listProfiles(): Promise<AiProfile[]>;
  createProfile(input: AiProfileCreate): Promise<AiProfile>;
  updateProfile(input: AiProfileUpdate): Promise<AiProfile>;
};

export interface AiClassRouteServiceOptions {
  getPool: () => PgPool | null;
  ai: ClassRoutesAi;
  /** The machine; defaults to this one. Its memory decides the Local preset's writer. */
  machine?: { platform: string; arch: string; totalMemoryBytes?: number };
  /** Maps the legacy routes once before the first read or write (the AI service's own guard). */
  ensureLegacyMapping?: () => Promise<void>;
  logger?: Pick<Console, "error" | "info">;
  now?: () => Date;
  /** Bound for one test call; the scheduler's class deadline applies inside it. */
  testTimeoutMs?: number;
  /**
   * Told after the setup (`ai.preset.v1`) was written, with its new mode. The opt-in remote decider
   * stops sending when the setup stops offering it (plan decision 30); a failure here is logged and
   * never fails the change of setup.
   */
  onPresetChanged?: (mode: AiPresetMode) => void | Promise<void>;
}

/** A fixed pair the ranker smoke scores: the relevant passage must outrank the other. */
const rankerSmoke = {
  query: "What is the capital of France?",
  documents: ["Paris is the capital of France.", "Bananas are rich in potassium."]
};
/** A fixed synthetic pair for the generative judge: one decide-only call. */
const judgeSmoke = {
  source: {
    title: "Spaced practice",
    ideaStatement: "Reviewing material at increasing intervals improves long-term recall."
  },
  candidate: {
    alias: 1,
    title: "Distributed practice",
    ideaStatement: "Spreading study sessions over time improves retention compared with cramming."
  }
};

type RouteName = AiClassRouteTarget;
type Profiles = Partial<Record<RouteName, AiProfileRecord>>;
type Resolved = { profile: AiProfileRecord } | { create: LocalModelRecord };
interface Resolution {
  resolved: Partial<Record<RouteName, Resolved>>;
  blocked: AiApplyPresetResult["blocked"];
}

export class AiClassRouteService {
  public constructor(private readonly options: AiClassRouteServiceOptions) {}

  /** The routes, their tests and the decider mode as Settings shows them. */
  public async view(): Promise<AiClassRoutes> {
    await this.options.ensureLegacyMapping?.();
    return this.readView();
  }

  /**
   * Seeds the class routes, the generative judge and the note decider mode from a preset (after
   * the person confirmed) and tests one call per class. `custom` only records the mode, so the
   * routes can be edited one by one. Nothing is written when a model the preset needs is missing.
   */
  public async applyPreset(input: AiApplyPresetInput): Promise<AiApplyPresetResult> {
    await this.options.ensureLegacyMapping?.();
    if (input.preset === "custom") {
      await this.writeSetting(presetSettingKey, { mode: "custom", at: this.nowIso() });
      await this.presetChanged("custom");
      return { applied: true, blocked: [], view: await this.readView() };
    }
    const planned = planAiPreset(input.preset, this.machine());
    if (!planned.ok) {
      return {
        applied: false,
        blocked: [{ route: null, reason: planned.reason, catalogId: null, modelName: null }],
        view: await this.readView()
      };
    }
    const resolution = await this.resolve(planned.plan);
    if (resolution.blocked.length > 0)
      return { applied: false, blocked: resolution.blocked, view: await this.readView() };
    const profiles = await this.createMissingProfiles(resolution);
    await this.writePreset(input.preset, planned.plan, profiles);
    await this.presetChanged(input.preset);
    if (input.test ?? true) for (const route of routeNames) await this.runTest(route);
    return { applied: true, blocked: [], view: await this.readView() };
  }

  /**
   * What a setup gives, read without writing: the profile each route would point at when one
   * already exists (a route that needs a profile created, a model not yet installed or a blocked
   * setup has none) and the note decider mode the setup stores. Settings v2 uses it to mark a route
   * "changed" and to put one route back (F5 T160); nothing is created or written here.
   */
  public async presetDefaults(preset: AiPresetId): Promise<{
    routes: Partial<Record<RouteName, string>>;
    deciderMode: NoteDeciderMode | null;
  }> {
    await this.options.ensureLegacyMapping?.();
    const planned = planAiPreset(preset, this.machine());
    if (!planned.ok) return { routes: {}, deciderMode: null };
    const resolution = await this.resolve(planned.plan);
    const routes: Partial<Record<RouteName, string>> = {};
    for (const route of routeNames) {
      const resolved = resolution.resolved[route];
      if (resolved && "profile" in resolved) routes[route] = resolved.profile.id;
    }
    return { routes, deciderMode: planned.plan.deciderMode };
  }

  /** Runs one test call for a class (or the judge) and records the outcome. */
  public async testClassRoute(route: RouteName): Promise<AiClassRoutes> {
    await this.options.ensureLegacyMapping?.();
    await this.runTest(route);
    return this.readView();
  }

  /**
   * Points a class (or the judge) at a profile: the Custom mode. The mapping's `op:` overrides for
   * the class go, so the class route decides from now on, and the mapping leaves the class alone.
   */
  public async setClassRoute(input: AiSetClassRouteInput): Promise<AiClassRoutes> {
    await this.options.ensureLegacyMapping?.();
    const state = await this.readState();
    const profile = state.profiles.find((candidate) => candidate.id === input.profileId);
    if (!profile || profile.status !== "active" || !profile.modelId)
      throw new Error("errors.ai.noCompatibleModel");
    if (!profileFitsRoute(profile, input.route)) throw new Error("errors.ai.noCompatibleModel");
    await withTransaction(this.requirePool(), async (client) => {
      const config = createAiConfigRepository(client);
      await this.pointRoutes(config, state.routes, routeKeysOf(input.route), profile.id);
      if (input.route === "judge")
        await this.pointRoutes(config, state.routes, ["reranking"], profile.id);
      await this.releaseClasses(client, input.route === "judge" ? ["decide"] : [input.route]);
      await createSettingsRepository(client).set(presetSettingKey, {
        mode: "custom",
        at: this.nowIso()
      });
    });
    await this.presetChanged("custom");
    return this.readView();
  }

  /** Sets the note decider mode, or clears it so the mode is derived from the routes (D16, C7). */
  public async setDeciderMode(mode: NoteDeciderMode | null): Promise<AiClassRoutes> {
    const settings = createSettingsRepository(this.requirePool());
    if (mode === null) await settings.delete(deciderModeSettingKey);
    else
      await settings.set(deciderModeSettingKey, JSON.stringify(NoteDeciderModeSchema.parse(mode)));
    return this.readView();
  }

  // --- Reading ----------------------------------------------------------------------------

  private async readState() {
    const pool = this.requirePool();
    const config = createAiConfigRepository(pool);
    const settings = createSettingsRepository(pool);
    const [profiles, providers, routes, preset, tests, mode] = await Promise.all([
      config.listProfiles(),
      config.listProviders(),
      config.listTaskRoutes(),
      settings.get(presetSettingKey),
      settings.get(classTestsSettingKey),
      settings.get(deciderModeSettingKey)
    ]);
    const presetState = PresetStateSchema.safeParse(preset);
    const storedTests = z.record(z.string(), StoredTestSchema).safeParse(tests);
    const decider = NoteDeciderModeSchema.safeParse(mode);
    return {
      profiles,
      providers,
      routes: new Map(routes.map((route) => [route.task, route.profileId])),
      preset: presetState.success ? presetState.data.mode : null,
      tests: storedTests.success ? storedTests.data : ({} as Record<string, StoredTest>),
      deciderMode: decider.success ? decider.data : null
    };
  }

  private async readView(): Promise<AiClassRoutes> {
    const state = await this.readState();
    const profile = (key: string) => {
      const id = state.routes.get(key);
      return id ? state.profiles.find((candidate) => candidate.id === id) : undefined;
    };
    const testOf = (route: RouteName, current: AiProfileRecord | undefined): AiClassTest => {
      const stored = state.tests[route];
      if (stored && current && stored.profileId === current.id)
        return {
          state: stored.state,
          model: stored.model,
          ms: stored.ms,
          at: stored.at,
          error: stored.error
        };
      return {
        state: route === "decide" && !current ? "none" : "untested",
        model: null,
        ms: null,
        at: null,
        error: null
      };
    };
    const classes: AiClassRoute[] = aiClassIds.map((id) => {
      const current = profile(workloadClassRouteKey(id));
      return {
        id,
        profileId: current?.id ?? null,
        profileName: current?.name ?? null,
        modelId: current?.modelId ?? null,
        runtime: runtimeOf(current),
        remote: current?.providerConfigId != null,
        test: testOf(id, current)
      };
    });
    const operationProfiles = generativeDecideOperations.map((operation) =>
      state.routes.get(operationRouteKey(operation))
    );
    const judge =
      profile(operationRouteKey("source_relation_matching")) ??
      profile(operationRouteKey("note_matching_reranking"));
    const provider = judge?.providerConfigId
      ? state.providers.find((candidate) => candidate.id === judge.providerConfigId)
      : undefined;
    const machine = this.machine();
    return {
      preset: state.preset,
      presets: (["local", "hybrid", "cloud"] as const).map((id) => {
        const planned = planAiPreset(id, machine);
        return { id, available: planned.ok, reason: planned.ok ? null : planned.reason };
      }),
      classes,
      judge: {
        profileId: judge?.id ?? null,
        profileName: judge?.name ?? null,
        modelId: judge?.modelId ?? null,
        runtime: runtimeOf(judge),
        remote: judge?.providerConfigId != null,
        providerName: provider?.displayName ?? null,
        routed:
          operationProfiles.every((id) => id !== undefined) &&
          new Set(operationProfiles).size === 1,
        deciderMode: state.deciderMode,
        test: testOf("judge", judge)
      }
    };
  }

  // --- Presets ----------------------------------------------------------------------------

  private machine(): PresetMachine {
    const machine = this.options.machine ?? { platform: process.platform, arch: process.arch };
    return {
      platform: machine.platform,
      arch: machine.arch,
      totalMemoryBytes: this.options.machine?.totalMemoryBytes ?? totalmem()
    };
  }

  /** The profile (or the model to give one) behind each want of a plan, or why it is blocked. */
  private async resolve(plan: AiPresetPlan): Promise<Resolution> {
    const state = await this.readState();
    const models = createLocalModelRepository(this.requirePool());
    const blocked: AiApplyPresetResult["blocked"] = [];
    const resolved: Partial<Record<RouteName, Resolved>> = {};
    const resolveTarget = async (
      route: RouteName,
      target: PresetTarget
    ): Promise<Resolved | null> => {
      if (target.kind === "remote-writer") {
        const writer = chooseRemoteWriter(state.profiles);
        if (writer) return { profile: writer };
        blocked.push({ route, reason: "no_remote_profile", catalogId: null, modelName: null });
        return null;
      }
      if (target.kind === "installed-ranker") return this.installedRanker(state.profiles, models);
      if (target.kind === "provider-embedding") {
        const remote = state.profiles.find(
          (profile) =>
            profile.status === "active" &&
            profile.providerConfigId !== null &&
            profile.modelId !== null &&
            supportsTask("embedding", profile.capabilities)
        );
        return remote
          ? { profile: remote }
          : resolveTarget(route, { kind: "local-model", catalogId: target.fallbackCatalogId });
      }
      const model = await models.findByCatalogId(target.catalogId);
      const ranker = route === "decide";
      const ready =
        model !== null &&
        model.status === "ready" &&
        (!ranker || model.capabilities.includes("reranking"));
      if (!ready) {
        // A ranker that is still downloading or not yet validated waits (decision 19, C7): the
        // preset applies, note matching skips until it validates, and nothing is blocked.
        if (!ranker)
          blocked.push({
            route,
            reason: "model_missing",
            catalogId: target.catalogId,
            modelName: findLocalModelCatalogEntry(target.catalogId)?.displayName ?? null
          });
        return null;
      }
      const existing = state.profiles.find(
        (profile) =>
          profile.localModelId === model.id && profile.status === "active" && profile.modelId
      );
      return existing ? { profile: existing } : { create: model };
    };
    for (const route of routeNames) {
      const result = await resolveTarget(
        route,
        route === "judge" ? plan.generativeDecide : plan.classes[route]
      );
      if (result) resolved[route] = result;
    }
    return { resolved, blocked };
  }

  /** The best validated local ranker among the profiles: MLX first where MLX runs (decision 12). */
  private async installedRanker(
    profiles: readonly AiProfileRecord[],
    models: ReturnType<typeof createLocalModelRepository>
  ): Promise<Resolved | null> {
    const machine = this.machine();
    const mlx = machine.platform === "darwin" && machine.arch === "arm64";
    const found: Array<{ profile: AiProfileRecord; runtime: string }> = [];
    for (const profile of profiles) {
      if (!profile.localModelId || profile.status !== "active") continue;
      const model = await models.findById(profile.localModelId);
      if (!model || model.status !== "ready" || !profileFitsRoute(profile, "decide")) continue;
      if (model.runtime === "mlx" && !mlx) continue;
      found.push({ profile, runtime: model.runtime });
    }
    const best = found.find((entry) => entry.runtime === "mlx") ?? found[0];
    return best ? { profile: best.profile } : null;
  }

  /** Gives each installed local model without a profile the profile the Settings flow creates. */
  private async createMissingProfiles(resolution: Resolution): Promise<Profiles> {
    const profiles: Profiles = {};
    const created = new Map<string, AiProfileRecord>();
    for (const route of routeNames) {
      const resolved = resolution.resolved[route];
      if (!resolved) continue;
      if ("profile" in resolved) {
        profiles[route] = resolved.profile;
        continue;
      }
      const model = resolved.create;
      let profile = created.get(model.id);
      if (!profile) {
        const made = await this.options.ai.createProfile({
          name: `${model.displayName} (${model.runtime.toUpperCase()})`,
          isDefault: false,
          privacyMode: "offline_only",
          outputLanguage: "ui"
        });
        const updated = await this.options.ai.updateProfile({
          id: made.id,
          modelId: model.modelId,
          capabilities: model.capabilities as AiCapability[],
          localModelId: model.id,
          runtime: model.runtime
        });
        profile = (await createAiConfigRepository(this.requirePool()).listProfiles()).find(
          (candidate) => candidate.id === updated.id
        );
        if (!profile) throw new Error("errors.common.notFound");
        created.set(model.id, profile);
      }
      profiles[route] = profile;
    }
    return profiles;
  }

  private async writePreset(
    preset: AiPresetId,
    plan: AiPresetPlan,
    profiles: Profiles
  ): Promise<void> {
    const state = await this.readState();
    await withTransaction(this.requirePool(), async (client) => {
      const config = createAiConfigRepository(client);
      for (const classId of aiClassIds) {
        const profile = profiles[classId];
        if (profile) await this.pointRoutes(config, state.routes, routeKeysOf(classId), profile.id);
      }
      // The judge: the four generative-decide routes and the `reranking` task route they mirror.
      if (profiles.judge)
        await this.pointRoutes(
          config,
          state.routes,
          [...routeKeysOf("judge"), "reranking"],
          profiles.judge.id
        );
      await this.releaseClasses(client, aiClassIds);
      const settings = createSettingsRepository(client);
      // A bare string is JSON text for the `jsonb` column.
      await settings.set(deciderModeSettingKey, JSON.stringify(plan.deciderMode));
      await settings.set(presetSettingKey, { mode: preset, at: this.nowIso() });
    });
  }

  // --- Writing ----------------------------------------------------------------------------

  /** Points route keys at a profile; a key that already names it keeps its parameters. */
  private async pointRoutes(
    config: ReturnType<typeof createAiConfigRepository>,
    routes: ReadonlyMap<string, string>,
    keys: readonly string[],
    profileId: string
  ): Promise<void> {
    for (const key of keys) {
      if (routes.get(key) === profileId) continue;
      await config.setProfileTask({ profileId, task: key, parameters: {} });
      await config.setTaskRoute(key, profileId);
    }
  }

  /**
   * Hands classes over to the person or a preset: the `op:` overrides the mapping wrote for them
   * are removed and the mapping leaves the classes alone from now on.
   */
  private async releaseClasses(client: PgClient, classes: readonly AiClassId[]): Promise<void> {
    const settings = createSettingsRepository(client);
    const parsed = ClassMapStateSchema.safeParse(await settings.get(classMapSettingKey));
    const state = parsed.success ? parsed.data : null;
    const released = new Set(legacyOperationKeys(classes));
    const dropped = (state?.operationRoutes ?? []).filter((key) => released.has(key));
    const config = createAiConfigRepository(client);
    for (const key of dropped) await config.deleteTaskRoute(key);
    const next: ClassMapState = {
      version: 1,
      mappedAt: state?.mappedAt ?? this.nowIso(),
      classRoutes: state?.classRoutes ?? [],
      operationRoutes: (state?.operationRoutes ?? []).filter((key) => !dropped.includes(key)),
      releasedClasses: [...new Set([...(state?.releasedClasses ?? []), ...classes])]
    };
    await settings.set(classMapSettingKey, next);
  }

  private async writeSetting(key: string, value: unknown): Promise<void> {
    await createSettingsRepository(this.requirePool()).set(key, value);
  }

  private async presetChanged(mode: AiPresetMode): Promise<void> {
    try {
      await this.options.onPresetChanged?.(mode);
    } catch (error) {
      this.options.logger?.error("Telling the opt-in deciders about the new setup failed", error);
    }
  }

  // --- Tests ------------------------------------------------------------------------------

  private async runTest(route: RouteName): Promise<void> {
    const state = await this.readState();
    const key =
      route === "judge" ? operationRouteKey("note_matching_reranking") : routeKeysOf(route)[0]!;
    const profileId = state.routes.get(key);
    const profile = profileId
      ? state.profiles.find((candidate) => candidate.id === profileId)
      : undefined;
    // An unrouted class has nothing to test, and a test never reaches another model.
    if (!profile) return;
    const started = Date.now();
    let outcome: Pick<StoredTest, "state" | "error">;
    try {
      await this.execute(route);
      outcome = { state: "passed", error: null };
    } catch (error) {
      outcome = { state: "failed", error: describeError(error) };
      this.options.logger?.info(`AI class test ${route} failed: ${outcome.error}`);
    }
    const entry: StoredTest = {
      profileId: profile.id,
      model: profile.modelId,
      ms: Date.now() - started,
      at: this.nowIso(),
      ...outcome
    };
    const latest = await this.readState();
    await this.writeSetting(classTestsSettingKey, { ...latest.tests, [route]: entry });
  }

  /** One small call of the class, on the class's own route; it throws when the answer is not good. */
  private async execute(route: RouteName): Promise<void> {
    const { ai } = this.options;
    const signal = AbortSignal.timeout(this.options.testTimeoutMs ?? 180_000);
    const context = {
      stage: "class_test",
      origin: "settings",
      priority: "P0" as const,
      budgetClass: "interactive" as const,
      sourceItemIds: [] as string[]
    };
    const invalid = () => new Error("settings.ai.classes.errors.invalidOutput");
    if (route === "embed") {
      const result = await ai.runDefaultTask(
        "embedding",
        renderPrompt("diagnostics.local_embedding"),
        {
          ...context,
          operation: "class_test",
          workloadClass: "embed",
          embeddingInputType: "document"
        },
        signal
      );
      const vector = z.array(z.number().finite()).safeParse(result?.output);
      if (!vector.success || ![256, 768, 1024].includes(vector.data.length)) throw invalid();
      return;
    }
    if (route === "decide") {
      const result = await ai.rank(
        {
          operation: "class_test_decide",
          instruction: renderPrompt("diagnostics.local_ranking"),
          query: rankerSmoke.query,
          documents: rankerSmoke.documents,
          priority: "P0",
          stage: "class_test"
        },
        signal
      );
      const [relevant, other] = result.scores;
      if (relevant === undefined || other === undefined || !(relevant > other)) throw invalid();
      return;
    }
    if (route === "judge") {
      const result = await ai.runDefaultTask(
        "reranking",
        buildBatchRerankPrompt(judgeSmoke.source, [judgeSmoke.candidate]),
        { ...context, operation: "note_matching_reranking", workloadClass: "decide" },
        signal,
        { maxOutputTokens: 512 }
      );
      const parsed = parseBatchRerankOutput(result?.output, [judgeSmoke.candidate.alias]);
      if (!parsed.decisions.has(judgeSmoke.candidate.alias)) throw invalid();
      return;
    }
    const result = await ai.runDefaultTask(
      "structured-output",
      renderPrompt("diagnostics.local_generation"),
      { ...context, operation: "class_test", workloadClass: route },
      signal,
      { maxOutputTokens: 64 }
    );
    const text =
      typeof result?.output === "string" ? result.output : JSON.stringify(result?.output ?? "");
    if (!result || !/\bok\b/i.test(text)) throw invalid();
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}

/** The five classes and the judge, in the order Settings lists and tests them. */
export const routeNames: readonly RouteName[] = [...aiClassIds, "judge"];

/** The route keys a class (or the judge) lives under. */
export function routeKeysOf(route: RouteName): string[] {
  return route === "judge"
    ? generativeDecideOperations.map((operation) => operationRouteKey(operation))
    : [workloadClassRouteKey(route)];
}

function asMappingProfile(profile: AiProfileRecord): RouteMappingProfile {
  return {
    id: profile.id,
    status: profile.status,
    isDefault: profile.isDefault,
    modelId: profile.modelId,
    capabilities: profile.capabilities,
    providerConfigId: profile.providerConfigId,
    localModelId: profile.localModelId
  };
}

/** Whether a profile can be the model of a route (the check Custom and the ranker lookup apply). */
export function profileFitsRoute(profile: AiProfileRecord, route: RouteName): boolean {
  if (route === "embed") return supportsTask("embedding", profile.capabilities);
  const generative = isGenerativeProfile(asMappingProfile(profile));
  // `class:decide` holds validated dedicated rankers only (D16): a generative or a decision-only
  // remote model is the judge's, never the ranker's.
  if (route === "decide")
    return (
      profile.localModelId !== null && !generative && profile.capabilities.includes("reranking")
    );
  if (route === "judge") return generative && supportsTask("reranking", profile.capabilities);
  return supportsTask("structured-output", profile.capabilities);
}

/** The user's remote profile for the write classes: the default one when remote, else the oldest. */
export function chooseRemoteWriter(profiles: readonly AiProfileRecord[]): AiProfileRecord | null {
  return (
    profiles
      .filter(
        (profile) =>
          profile.status === "active" &&
          profile.providerConfigId !== null &&
          profile.modelId !== null &&
          supportsTask("structured-output", profile.capabilities)
      )
      .toSorted(
        (left, right) =>
          Number(right.isDefault) - Number(left.isDefault) ||
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.id.localeCompare(right.id)
      )[0] ?? null
  );
}

function runtimeOf(profile: AiProfileRecord | undefined): "remote" | "gguf" | "mlx" | null {
  const runtime = profile?.runtime;
  return runtime === "remote" || runtime === "gguf" || runtime === "mlx" ? runtime : null;
}

/** A one-line reason: a localized key as it is, anything else redacted and short. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^[a-z][A-Za-z]*(\.[A-Za-z0-9_-]+)+$/u.test(message)) return message;
  return redactSensitiveText(error)
    .replace(/postgres(?:ql)?:\/\/\S+/giu, "[redacted]")
    .replace(/\s+/gu, " ")
    .slice(0, 300);
}
