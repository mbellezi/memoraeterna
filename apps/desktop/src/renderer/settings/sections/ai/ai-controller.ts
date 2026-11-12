import type { AiPresetId, BudgetSnapshot, HardwareProfileResult } from "@app/domain";
import type { MessageKey } from "@app/i18n";

import type {
  AiApplyPresetResult,
  AiClassRouteTarget,
  AiClassRoutes,
  AiDecisionsStatus,
  AiProfile,
  AiProfileTask,
  AiProviderConfig,
  DesktopApi,
  LocalModelView
} from "../../../../shared/ipc";
import { applyModelDownloadEvent } from "../../../lib/model-download-events";
import { errorKeyOf, routeOrder } from "./ai-model";

/**
 * What the AI section knows and does, as a small store outside React so every rule is tested without
 * a renderer (the pattern of `settings-store.ts`). It reads what the section shows in independent
 * parts, so one that fails is told in its own place and the others stay: the routes with the
 * profiles and providers (the section's core), This Mac, the Decisions status, the local models and
 * the month's spend. It reads once when the section is shown and again on `settings.changed` for the
 * AI store and on the pushed `model.download` events: never on a timer. A write runs through
 * `mutate`, which says what failed in the area it belongs to, in the person's words, and keeps what
 * was shown.
 */

export type Load<T> = { status: "loading" } | { status: "error" } | { status: "ready"; value: T };

export interface AiCore {
  routes: AiClassRoutes;
  profiles: AiProfile[];
  providers: AiProviderConfig[];
  profileTasks: AiProfileTask[];
}

export interface ModelsData {
  models: LocalModelView[];
  /** A Hugging Face token is saved (never its value). */
  token: boolean;
}

/** Where a notice belongs: each area of the section says its own failure. */
export type AiArea =
  "setup" | "routes" | "providers" | "models" | "profiles" | "decisions" | "hardware";

/** The state of the setup block: nothing, a switch waiting for the yes, applying, or told why not. */
export type SetupStage =
  | { kind: "idle" }
  | { kind: "asking"; setup: AiPresetId }
  | {
      kind: "working";
      setup: AiPresetId;
      phase: "applying" | "testing";
      route: AiClassRouteTarget | null;
    }
  | { kind: "done"; setup: AiPresetId }
  | { kind: "blocked"; setup: AiPresetId; blocked: AiApplyPresetResult["blocked"] };

export interface AiSnapshot {
  core: Load<AiCore>;
  hardware: Load<HardwareProfileResult>;
  decisions: Load<AiDecisionsStatus>;
  models: Load<ModelsData>;
  budget: Load<BudgetSnapshot>;
  setup: SetupStage;
  /** A provider profile chosen for the judge, waiting for the person to read what it receives. */
  pendingJudge: string | null;
  /** The routes whose test is running now. */
  testing: readonly AiClassRouteTarget[];
  /** A route (or the setup) is being written. */
  writing: boolean;
  notices: Readonly<Partial<Record<AiArea, MessageKey>>>;
  /** Turning Decisions on waits for the person to read the notice. */
  decisionsAsking: boolean;
  decisionsBusy: boolean;
  /** What the last Decisions action came to ("The OpenAI key was saved."). */
  decisionsNote: MessageKey | null;
  redetecting: boolean;
  redetected: boolean;
}

export type AiApi = Pick<DesktopApi, "ai" | "hardware" | "localModels" | "budget" | "onAppEvent">;

export interface AiControllerOptions {
  /** Settings' markers read again after a write that does not announce itself. */
  refreshMarkers?: () => void;
}

const loading = { status: "loading" } as const;
const ready = <T>(value: T): Load<T> => ({ status: "ready", value });

const initial: AiSnapshot = {
  core: loading,
  hardware: loading,
  decisions: loading,
  models: loading,
  budget: loading,
  setup: { kind: "idle" },
  pendingJudge: null,
  testing: [],
  writing: false,
  notices: {},
  decisionsAsking: false,
  decisionsBusy: false,
  decisionsNote: null,
  redetecting: false,
  redetected: false
};

export class AiSettingsController {
  private snapshot: AiSnapshot = initial;
  private readonly listeners = new Set<() => void>();
  private stops: Array<() => void> = [];
  private holders = 0;
  private started = false;
  /** Grows when the section stops, so an answer that comes after is dropped. */
  private epoch = 0;

  constructor(
    private readonly api: () => AiApi,
    private readonly options: AiControllerOptions = {}
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): AiSnapshot => this.snapshot;

  /** The preload's API, for the pages that call it themselves inside `mutate`. */
  get app(): AiApi {
    return this.api();
  }

  /** Follows the bus and reads everything once for as long as anyone holds the controller. */
  retain(): () => void {
    this.holders += 1;
    if (!this.started) {
      this.started = true;
      const app = this.api();
      this.stops = [
        app.onAppEvent("settings.changed", (event) => {
          if (event.stores.includes("ai")) {
            void this.loadCore();
            void this.loadDecisions();
            void this.loadModels();
          }
        }),
        app.onAppEvent("model.download", (event) => this.onDownload(event))
      ];
      this.loadAll();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders -= 1;
      if (this.holders === 0) this.stop();
    };
  }

  private stop(): void {
    this.started = false;
    this.epoch += 1;
    for (const stop of this.stops.splice(0)) stop();
    this.snapshot = initial;
  }

  /** The person asked to try the part that failed again. */
  retry(): void {
    if (!this.started) return;
    this.loadAll();
  }

  private loadAll(): void {
    void this.loadCore();
    void this.loadHardware();
    void this.loadDecisions();
    void this.loadModels();
    void this.loadBudget();
  }

  // --- reads ------------------------------------------------------------------------------------

  /** Settles a read into a `Load`: the answer, or, when there was no answer before, an error. */
  private settle(
    key: "core" | "hardware" | "decisions" | "models" | "budget",
    read: () => Promise<unknown>
  ): Promise<void> {
    const epoch = this.epoch;
    if (this.snapshot[key].status === "error") this.set({ [key]: loading } as Partial<AiSnapshot>);
    // A call that throws before it answers is a failed read like any other.
    return Promise.resolve()
      .then(read)
      .then(
        (value) => {
          if (epoch === this.epoch) this.set({ [key]: ready(value) } as Partial<AiSnapshot>);
        },
        () => {
          // A value that was shown stays shown; only a first read can fail.
          if (epoch === this.epoch && this.snapshot[key].status !== "ready")
            this.set({ [key]: { status: "error" } } as Partial<AiSnapshot>);
        }
      );
  }

  loadCore(): Promise<void> {
    return this.settle("core", async () => {
      const app = this.api();
      const [routes, profiles, providers] = await Promise.all([
        app.ai.classRoutes(),
        app.ai.listProfiles(),
        app.ai.listProviders()
      ]);
      // The task parameters are for the profiles page only; a failed read leaves it with none.
      const profileTasks = await app.ai.listProfileTasks().catch(() => []);
      return { routes, profiles, providers, profileTasks };
    });
  }

  loadHardware(refresh = false): Promise<void> {
    return this.settle("hardware", () =>
      this.api().hardware.profile(refresh ? { refresh: true } : undefined)
    );
  }

  loadDecisions(): Promise<void> {
    return this.settle("decisions", () => this.api().ai.decisionsStatus());
  }

  loadModels(): Promise<void> {
    return this.settle("models", async () => {
      const app = this.api();
      const [models, token] = await Promise.all([
        app.localModels.list(),
        app.localModels.hasRepositoryToken()
      ]);
      return { models, token };
    });
  }

  loadBudget(): Promise<void> {
    return this.settle("budget", () => this.api().budget.snapshot());
  }

  private onDownload(event: Parameters<Parameters<AiApi["onAppEvent"]>[1]>[0]): void {
    const models = this.snapshot.models;
    if (models.status !== "ready") return;
    // Only `model.download` events arrive here.
    const update = applyModelDownloadEvent(
      models.value.models,
      event as Parameters<typeof applyModelDownloadEvent>[1]
    );
    this.set({ models: ready({ ...models.value, models: update.models }) });
    if (update.reload) void this.loadModels();
  }

  // --- writes -----------------------------------------------------------------------------------

  /**
   * Runs one write of an area. It says what failed in that area (the message key an error carries,
   * else "could not save"), clears the notice on success, reads what the write can change and asks
   * Settings to read its markers again. Answers whether it worked.
   */
  async mutate(
    area: AiArea,
    action: () => Promise<unknown>,
    reads: { models?: boolean; decisions?: boolean } = {}
  ): Promise<boolean> {
    try {
      await action();
    } catch (error) {
      this.notice(area, errorKeyOf(error));
      return false;
    }
    this.notice(area, null);
    await Promise.all([
      this.loadCore(),
      reads.models ? this.loadModels() : Promise.resolve(),
      reads.decisions ? this.loadDecisions() : Promise.resolve()
    ]);
    this.options.refreshMarkers?.();
    return true;
  }

  notice(area: AiArea, key: MessageKey | null): void {
    const notices = { ...this.snapshot.notices };
    if (key === null) delete notices[area];
    else notices[area] = key;
    this.set({ notices });
  }

  private replaceRoutes(routes: AiClassRoutes): void {
    const core = this.snapshot.core;
    if (core.status === "ready") this.set({ core: ready({ ...core.value, routes }) });
  }

  // --- the setup ---------------------------------------------------------------------------------

  /** A card was chosen. Custom is a record of the person's own routes and applies at once. */
  selectSetup(mode: AiPresetId | "custom"): void {
    this.notice("setup", null);
    if (mode === "custom") {
      this.set({ setup: { kind: "idle" } });
      void this.write(async () => {
        const result = await this.api().ai.applyPreset({ preset: "custom" });
        this.replaceRoutes(result.view);
      }, "setup");
      return;
    }
    this.set({ setup: { kind: "asking", setup: mode } });
  }

  cancelSetup(): void {
    if (this.snapshot.setup.kind === "asking") this.set({ setup: { kind: "idle" } });
  }

  /** The yes: seeds every route, then tests one call of each, one by one so each shows as it lands. */
  async confirmSetup(): Promise<void> {
    const stage = this.snapshot.setup;
    if (stage.kind !== "asking") return;
    const setup = stage.setup;
    this.set({
      setup: { kind: "working", setup, phase: "applying", route: null },
      writing: true
    });
    let result: AiApplyPresetResult;
    try {
      result = await this.api().ai.applyPreset({ preset: setup, test: false });
    } catch (error) {
      this.set({ setup: { kind: "idle" }, writing: false });
      this.notice("setup", errorKeyOf(error));
      return;
    }
    this.replaceRoutes(result.view);
    if (!result.applied) {
      this.set({ setup: { kind: "blocked", setup, blocked: result.blocked }, writing: false });
      return;
    }
    for (const route of routeOrder) {
      this.set({ setup: { kind: "working", setup, phase: "testing", route } });
      await this.testRoute(route);
    }
    this.set({ setup: { kind: "done", setup }, writing: false });
    this.options.refreshMarkers?.();
    void this.loadDecisions();
  }

  // --- the routes --------------------------------------------------------------------------------

  /** One call to the route's model; the view answers with its result. */
  async testRoute(route: AiClassRouteTarget): Promise<void> {
    this.set({ testing: [...this.snapshot.testing, route] });
    try {
      this.replaceRoutes(await this.api().ai.testClassRoute(route));
      this.notice("routes", null);
    } catch (error) {
      this.notice("routes", errorKeyOf(error));
    } finally {
      this.set({ testing: this.snapshot.testing.filter((candidate) => candidate !== route) });
    }
  }

  /**
   * A profile was chosen for a route. A provider's model for the judge discloses what it receives
   * before it applies; every other choice writes at once (and makes the setup Custom).
   */
  chooseProfile(route: AiClassRouteTarget, profileId: string): void {
    const core = this.snapshot.core;
    const profile =
      core.status === "ready"
        ? core.value.profiles.find((candidate) => candidate.id === profileId)
        : undefined;
    if (route === "judge" && profile?.providerConfigId) {
      this.set({ pendingJudge: profileId });
      return;
    }
    void this.writeRoute(route, profileId);
  }

  confirmJudge(): void {
    const profileId = this.snapshot.pendingJudge;
    this.set({ pendingJudge: null });
    if (profileId) void this.writeRoute("judge", profileId);
  }

  cancelJudge(): void {
    this.set({ pendingJudge: null });
  }

  private async writeRoute(route: AiClassRouteTarget, profileId: string): Promise<void> {
    await this.write(async () => {
      this.replaceRoutes(await this.api().ai.setClassRoute({ route, profileId }));
      void this.loadDecisions();
    }, "routes");
  }

  /** A write of the core: one at a time, with its failure told in its area. */
  private async write(action: () => Promise<void>, area: AiArea): Promise<void> {
    this.set({ writing: true });
    try {
      await action();
      this.notice(area, null);
      this.options.refreshMarkers?.();
    } catch (error) {
      this.notice(area, errorKeyOf(error));
    } finally {
      this.set({ writing: false });
    }
  }

  // --- This Mac ----------------------------------------------------------------------------------

  /** "Detect again": probes once more and shows the new figures. */
  async redetect(): Promise<void> {
    this.set({ redetecting: true, redetected: false });
    try {
      const value = await this.api().hardware.profile({ refresh: true });
      this.set({ hardware: ready(value), redetected: true });
      this.notice("hardware", null);
    } catch (error) {
      this.notice("hardware", errorKeyOf(error, "settingsAi.thisMac.error"));
    } finally {
      this.set({ redetecting: false });
    }
  }

  // --- OpenAI Decisions --------------------------------------------------------------------------

  askEnableDecisions(): void {
    this.set({ decisionsAsking: true, decisionsNote: null });
  }

  cancelEnableDecisions(): void {
    this.set({ decisionsAsking: false });
  }

  /** Runs one call of the Decisions opt-in and shows its answer; `note` says what it came to. */
  async decisionsAction(
    action: (api: AiApi["ai"]) => Promise<AiDecisionsStatus>,
    note: MessageKey | null
  ): Promise<boolean> {
    this.set({ decisionsBusy: true, decisionsNote: null });
    try {
      const status = await action(this.api().ai);
      this.set({ decisions: ready(status), decisionsAsking: false, decisionsNote: note });
      this.notice("decisions", null);
      this.options.refreshMarkers?.();
      return true;
    } catch (error) {
      this.set({ decisionsAsking: false });
      this.notice("decisions", errorKeyOf(error));
      return false;
    } finally {
      this.set({ decisionsBusy: false });
    }
  }

  /** Asks OpenAI whether the saved key works; the answer is a message key for the row to show. */
  async testDecisionsKey(): Promise<{ ok: boolean; key: MessageKey }> {
    try {
      const status = await this.api().ai.testDecisionsKey();
      this.set({ decisions: ready(status) });
      return status.keyInvalid
        ? { ok: false, key: "settingsAi.decisions.key.invalid" }
        : { ok: true, key: "settingsAi.decisions.key.testOk" };
    } catch (error) {
      return { ok: false, key: errorKeyOf(error) };
    }
  }

  // --- internals ---------------------------------------------------------------------------------

  private set(patch: Partial<AiSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
