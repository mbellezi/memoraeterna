import { findLocalModelCatalogEntry, isRankerCatalogEntry, redactSensitiveText } from "@app/ai";
import { createSettingsRepository } from "@app/db";
import type { PgPool } from "@app/db";
import { z } from "zod";

import type {
  AiProfile,
  AiProfileCreate,
  AiProfileUpdate,
  AiTaskRoute,
  LocalModelDownloadInput,
  LocalModelView
} from "../../shared/ipc.js";

/**
 * The first-run ranker (owner decision 19). The first time a library gets its embedding route (the
 * zero-config first run: one AI profile plus the default local embedding model, Q4), the local
 * Qwen3-Reranker-0.6B is installed next to the embedding model, so the topic placement gate has a
 * decider from the start:
 *
 * 1. the MLX entry where this machine runs MLX, else the GGUF one, is downloaded through the local
 *    model catalog like the embedding model (pinned files, sizes and SHA-256, resumable, progress
 *    and errors on its row in Settings > Local models);
 * 2. the install validates it for `decide` (artifact checks and the smoke test,
 *    `LocalModelService`);
 * 3. once validated it gets the AI profile the Settings flow creates for a local model, so the
 *    route seeding gives it `class:decide`, and the gate's recheck finds the ready route and sends
 *    the notes the no-decider fallback placed back to the gate.
 *
 * It never blocks the first run and never throws: a refused, failed or canceled download, or a
 * ranker that does not validate, is recorded and logged, the model's row shows the error, and the
 * topic gate keeps its no-decider fallback. It happens once per library (the state is a setting):
 * a ranker the owner removes later is not installed again, and a library that had its embedding
 * route before this existed gets no download. A start finishes what an earlier one left (an
 * interrupted download resumes in `LocalModelService.start`; a validated ranker without a profile
 * gets one).
 */

export const firstRunRankerSettingKey = "local-models.first-run-ranker";

/** The catalog entries of the ranker, MLX first where MLX runs (decision 12). */
export const firstRunRankerCatalogIds = {
  mlx: "mlx-qwen3-reranker-0.6b",
  gguf: "gguf-qwen3-reranker-0.6b-q8-0"
} as const;

export const FirstRunRankerStateSchema = z.object({
  /** The catalog entry the first run chose, or null when it chose none (`skipped`). */
  catalogId: z.string().nullable(),
  /**
   * `requested`: downloading or waiting to validate; `ready`: validated and routed; `failed`: the
   * download or the validation failed (a later success on its row completes it); `skipped`: no
   * ranker entry runs on this machine.
   */
  state: z.enum(["requested", "ready", "failed", "skipped"]),
  /** A localized error key or a short reason. */
  reason: z.string().max(400).nullable(),
  at: z.string()
});
export type FirstRunRankerState = z.infer<typeof FirstRunRankerStateSchema>;

/** What the first-run ranker needs of the local model service. */
export interface FirstRunRankerModels {
  list(): Promise<LocalModelView[]>;
  requestDownload(input: LocalModelDownloadInput): Promise<LocalModelView>;
}

/** What it needs of the AI service: the routes and the Settings profile flow. */
export interface FirstRunRankerAi {
  listTaskRoutes(): Promise<AiTaskRoute[]>;
  listProfiles(): Promise<AiProfile[]>;
  createProfile(input: AiProfileCreate): Promise<AiProfile>;
  updateProfile(input: AiProfileUpdate): Promise<AiProfile>;
}

/** Where the state lives (a setting of the library). */
export interface FirstRunRankerStore {
  get(): Promise<unknown>;
  set(state: FirstRunRankerState): Promise<void>;
}

export interface FirstRunRankerOptions {
  models: FirstRunRankerModels;
  ai: FirstRunRankerAi;
  store: FirstRunRankerStore;
  /** Whether this machine runs MLX (macOS on Apple silicon); defaults to this one. */
  machine?: { platform: string; arch: string };
  /** False turns the first-run ranker off (golden runs pin their own routes). */
  enabled?: boolean;
  logger?: Pick<Console, "info" | "warn">;
  now?: () => Date;
}

/** The state as a library setting (`settings`, key `firstRunRankerSettingKey`). */
export function settingsFirstRunRankerStore(getPool: () => PgPool | null): FirstRunRankerStore {
  const settings = () => {
    const pool = getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return createSettingsRepository(pool);
  };
  return {
    get: () => settings().get(firstRunRankerSettingKey),
    set: async (state) => {
      await settings().set(firstRunRankerSettingKey, state);
    }
  };
}

/** What one `ensure` or settle step found or did. */
export type FirstRunRankerOutcome =
  | "disabled"
  | "waiting_for_embedding"
  | "requested"
  | "ready"
  | "failed"
  | "skipped"
  | "settled_earlier";

const rankerCatalogIds = new Set<string>(Object.values(firstRunRankerCatalogIds));

/** A ranker serves `decide` only once validated: its view then exposes `reranking`. */
const validated = (view: LocalModelView): boolean =>
  view.status === "ready" && view.capabilities.includes("reranking");

export class FirstRunRanker {
  private tail: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: FirstRunRankerOptions) {}

  /**
   * Starts the install when this library has an embedding route and never had a first-run ranker,
   * or finishes one an earlier start left. Never throws; calls run one after another.
   */
  public ensure(): Promise<FirstRunRankerOutcome> {
    return this.serial(() => this.ensureNow());
  }

  /**
   * A local model's download settled or a ranker was tested (`LocalModelService.onModelSettled`):
   * the first-run ranker records the outcome and, once validated, gives it its profile.
   */
  public onModelSettled(catalogId: string): Promise<FirstRunRankerOutcome | null> {
    if (!rankerCatalogIds.has(catalogId)) return Promise.resolve(null);
    return this.serial(async () => {
      const state = await this.read();
      if (!state || state.catalogId !== catalogId || state.state === "ready") return null;
      return this.finish(state);
    });
  }

  /** Routes a seeding created (`AiService.onRoutesSeeded`): the first embedding route starts it. */
  public onRoutesSeeded(tasks: readonly string[]): void {
    if (!tasks.includes("embedding")) return;
    void this.ensure();
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async ensureNow(): Promise<FirstRunRankerOutcome> {
    if (this.options.enabled === false) return "disabled";
    try {
      const state = await this.read();
      if (state) return state.state === "ready" ? "settled_earlier" : await this.finish(state);
      const routes = await this.options.ai.listTaskRoutes();
      if (!routes.some((route) => route.task === "embedding")) return "waiting_for_embedding";
      return await this.start();
    } catch (error) {
      this.options.logger?.warn(`FIRST_RUN_RANKER failed: ${describe(error)}`);
      return "failed";
    }
  }

  /** The first run: the ranker entry this machine runs, downloaded through the catalog. */
  private async start(): Promise<FirstRunRankerOutcome> {
    const views = await this.options.models.list();
    // A ranker that is already installed or on its way (Settings, or the DEV install knob).
    const present = views.find(
      (view) =>
        rankerCatalogIds.has(view.catalogId) &&
        ["ready", "downloading", "verifying"].includes(view.status)
    );
    if (present) {
      await this.write({ catalogId: present.catalogId, state: "requested", reason: null });
      return this.finish((await this.read())!);
    }
    const catalogId = this.choose(views);
    if (!catalogId) {
      await this.write({ catalogId: null, state: "skipped", reason: "incompatible" });
      this.options.logger?.info("FIRST_RUN_RANKER skipped: no ranker runs on this machine");
      return "skipped";
    }
    try {
      const view = await this.options.models.requestDownload({ catalogId, acceptLicense: false });
      await this.write({ catalogId, state: "requested", reason: null });
      this.options.logger?.info(`FIRST_RUN_RANKER ${catalogId}: download requested`);
      return view.status === "ready" ? this.finish((await this.read())!) : "requested";
    } catch (error) {
      await this.write({ catalogId, state: "failed", reason: describe(error) });
      this.options.logger?.warn(`FIRST_RUN_RANKER ${catalogId}: ${describe(error)}`);
      return "failed";
    }
  }

  /** MLX first where MLX runs (decision 12), else GGUF; only an entry this machine can run. */
  private choose(views: readonly LocalModelView[]): string | null {
    const machine = this.options.machine ?? { platform: process.platform, arch: process.arch };
    const runsMlx = machine.platform === "darwin" && machine.arch === "arm64";
    const order = runsMlx
      ? [firstRunRankerCatalogIds.mlx, firstRunRankerCatalogIds.gguf]
      : [firstRunRankerCatalogIds.gguf];
    for (const catalogId of order) {
      const entry = findLocalModelCatalogEntry(catalogId);
      const view = views.find((candidate) => candidate.catalogId === catalogId);
      if (entry && isRankerCatalogEntry(entry) && view?.compatible) return catalogId;
    }
    return null;
  }

  /** Records how the chosen ranker stands; a validated one gets its profile. */
  private async finish(state: FirstRunRankerState): Promise<FirstRunRankerOutcome> {
    if (state.catalogId === null) return state.state === "skipped" ? "skipped" : "failed";
    const view = (await this.options.models.list()).find(
      (candidate) => candidate.catalogId === state.catalogId
    );
    if (!view) return this.fail(state.catalogId, "errors.localModels.notFound");
    if (view.status === "downloading" || view.status === "verifying") {
      if (state.state !== "requested")
        await this.write({ catalogId: state.catalogId, state: "requested", reason: null });
      return "requested";
    }
    if (view.status === "failed" || view.status === "not_downloaded") {
      return this.fail(state.catalogId, view.lastError ?? "errors.localModels.notReady");
    }
    if (!validated(view))
      return this.fail(state.catalogId, "errors.localModels.rankerNotValidated");
    await this.ensureProfile(view);
    await this.write({ catalogId: state.catalogId, state: "ready", reason: null });
    this.options.logger?.info(`FIRST_RUN_RANKER ${state.catalogId}: validated and routed`);
    return "ready";
  }

  private async fail(catalogId: string, reason: string): Promise<FirstRunRankerOutcome> {
    const current = await this.read();
    if (current?.state !== "failed" || current.reason !== reason) {
      await this.write({ catalogId, state: "failed", reason });
      this.options.logger?.warn(`FIRST_RUN_RANKER ${catalogId}: ${reason}`);
    }
    return "failed";
  }

  /** The profile the Settings flow creates for a local model; the seeding routes `class:decide`. */
  private async ensureProfile(view: LocalModelView): Promise<void> {
    const { ai } = this.options;
    const profiles = await ai.listProfiles();
    if (profiles.some((profile) => profile.localModelId === view.id && profile.status === "active"))
      return;
    const name = `${view.displayName} (${view.runtime.toUpperCase()})`;
    // A profile an earlier start created but could not finish holds no model yet.
    const unfinished = profiles.find(
      (profile) =>
        profile.name === name &&
        !profile.modelId &&
        !profile.localModelId &&
        !profile.providerConfigId
    );
    const profile =
      unfinished ??
      (await ai.createProfile({
        name,
        // A ranker never becomes the default profile: it serves only `class:decide`.
        isDefault: false,
        privacyMode: "offline_only",
        outputLanguage: "ui"
      }));
    await ai.updateProfile({
      id: profile.id,
      modelId: view.modelId,
      capabilities: view.capabilities,
      localModelId: view.id,
      runtime: view.runtime
    });
  }

  private async read(): Promise<FirstRunRankerState | null> {
    const parsed = FirstRunRankerStateSchema.safeParse(await this.options.store.get());
    return parsed.success ? parsed.data : null;
  }

  private async write(state: Omit<FirstRunRankerState, "at">): Promise<void> {
    const now = this.options.now?.() ?? new Date();
    await this.options.store.set(
      FirstRunRankerStateSchema.parse({ ...state, at: now.toISOString() })
    );
  }
}

/** A one-line reason; secrets and connection strings are redacted. */
function describe(error: unknown): string {
  return redactSensitiveText(error)
    .replace(/postgres(?:ql)?:\/\/\S+/giu, "[redacted]")
    .replace(/\s+/gu, " ")
    .slice(0, 400);
}
