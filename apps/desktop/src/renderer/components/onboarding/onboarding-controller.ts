// The first-run onboarding as a state machine outside React (F4 D31, spec 3.11): the question
// whether the view is due, the languages, the AI mode with its tier card, the setup that applies
// and tests it, and the first source. It makes exactly the calls of `first-run-sequence.ts` (the
// fixture the first-run end-to-end test plays), so every rule is tested without a renderer and the
// screen cannot drift from the proof.
//
// A failure never blocks (decision 31): a step that fails stays visible with a retry and a way to
// go on without it; a failed class test is a finding, not a stop; the relations ranker installs
// beside everything else and relations wait for it.
import type { AiPresetId } from "@app/domain";
import type { LanguageCode, MessageKey } from "@app/i18n";

import type { ModelDownloadEvent } from "../../../shared/app-events";
import { firstRunClassTests } from "../../../shared/first-run-sequence";
import type {
  AiApplyPresetResult,
  AiClassRouteTarget,
  AiProfile,
  AiProviderConfig,
  AppSettings,
  DesktopApi,
  LocalModelView
} from "../../../shared/ipc";
import {
  codexProviderId,
  codexWriterCapabilities,
  localRefusal,
  localSetupAvailable,
  writerCapabilities,
  type LocalRefusal,
  type OnboardingHardware
} from "../../../shared/onboarding";
import {
  defaultPreset,
  errorMessageKey,
  failedTestCount,
  modeOptions,
  modelRole,
  modelsToInstall,
  waitingTests,
  type ClassTestView,
  type DownloadView,
  type Load,
  type ModelRole,
  type OnboardingMessage
} from "./onboarding-model";

/** The parts of the preload the onboarding calls. */
export interface OnboardingApi {
  onAppEvent: DesktopApi["onAppEvent"];
  onboarding: Pick<DesktopApi["onboarding"], "state" | "finish">;
  settings: Pick<DesktopApi["settings"], "updateApp">;
  hardware: Pick<DesktopApi["hardware"], "profile">;
  localModels: Pick<DesktopApi["localModels"], "list" | "download">;
  ai: Pick<
    DesktopApi["ai"],
    | "connectOpenAiCodex"
    | "saveProvider"
    | "createProfile"
    | "updateProfile"
    | "applyPreset"
    | "testClassRoute"
  >;
}

export interface OnboardingDeps {
  api: () => OnboardingApi;
  /** The interface and content languages the app has when the first run starts. */
  initial: () => { language: LanguageCode; contentLanguage: LanguageCode };
  /** Names stored with the writer (data the person sees later in Settings), already translated. */
  names: () => { profile: string; codexProvider: string };
  /** Told with the stored settings once the languages were saved: the app shows them from then on. */
  onSettings?: (saved: AppSettings) => void;
}

export const keyProviders = ["google", "openai-compatible"] as const;
export type KeyProvider = (typeof keyProviders)[number];

export type OnboardingPhase =
  | "checking"
  /** Not due, skipped, or the question failed: the app shows. */
  | "off"
  | "languages"
  | "mode"
  | "testing"
  | "source"
  /** The first source was saved: the app shows and opens it. */
  | "done";

export type SetupStepName = "writer" | "models" | "preset" | "tests";
export type SetupStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface WriterState {
  method: "codex" | "key";
  codex: {
    status: "idle" | "connecting" | "connected" | "failed";
    models: string[];
    modelId: string;
    error: OnboardingMessage | null;
  };
  key: { provider: KeyProvider; baseUrl: string; modelId: string; hasKey: boolean };
}

export interface BlockedView {
  reason: AiApplyPresetResult["blocked"][number]["reason"];
  route: AiClassRouteTarget | null;
  modelName: string | null;
}

export interface SetupState {
  status: "idle" | "running" | "failed" | "done";
  steps: Record<SetupStepName, SetupStepStatus>;
  downloads: DownloadView[];
  tests: ClassTestView[];
  blocked: BlockedView[];
  failure: { step: SetupStepName; message: OnboardingMessage } | null;
}

export interface OnboardingSnapshot {
  phase: OnboardingPhase;
  /** The step of three the indicator marks; the setup belongs to the second. */
  step: 1 | 2 | 3;
  languages: {
    language: LanguageCode;
    contentLanguage: LanguageCode;
    save: "idle" | "saving" | "failed";
  };
  mode: {
    hardware: Load<OnboardingHardware>;
    catalog: Load<LocalModelView[]>;
    selected: AiPresetId;
    /** Set when a chosen setup was refused: Local off Apple silicon, or where it does not fit. */
    refusal: LocalRefusal | null;
    writer: WriterState;
  };
  setup: SetupState;
  /** The source the first run ended on; the app opens it. */
  openedSourceId: string | null;
  /** What the import said about its outcome, for the toast that follows the opened source. */
  openedStatus: MessageKey | null;
  skipping: boolean;
  /** Polite announcement; a new `id` announces again. */
  announcement: { id: number; message: OnboardingMessage } | null;
}

const setupStepOrder: readonly SetupStepName[] = ["writer", "models", "preset", "tests"];

const initialWriter = (): WriterState => ({
  method: "codex",
  codex: { status: "idle", models: [], modelId: "", error: null },
  key: { provider: "google", baseUrl: "", modelId: "", hasKey: false }
});

const initialSetup = (): SetupState => ({
  status: "idle",
  steps: { writer: "pending", models: "pending", preset: "pending", tests: "pending" },
  downloads: [],
  tests: waitingTests(),
  blocked: [],
  failure: null
});

/** A step that failed with a message the screen shows. */
class StepFailure extends Error {
  public constructor(public readonly failure: OnboardingMessage) {
    super(failure.key);
  }
}

const roleOrder: readonly ModelRole[] = ["embedder", "writer", "ranker"];

/** Whether the writer panel holds everything the chosen method needs to sign in. */
export function writerReady(writer: WriterState): boolean {
  if (writer.method === "codex")
    return writer.codex.status === "connected" && writer.codex.modelId.trim() !== "";
  return (
    writer.key.hasKey &&
    writer.key.modelId.trim() !== "" &&
    (writer.key.provider !== "openai-compatible" || isHttpUrl(writer.key.baseUrl))
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Whether the chosen setup can start: Hybrid and Cloud sign in to a writer first. */
export function canStartSetup(snapshot: OnboardingSnapshot): boolean {
  const { mode } = snapshot;
  if (snapshot.phase !== "mode") return false;
  if (mode.selected === "local")
    return mode.hardware.status !== "ready" || localSetupAvailable(mode.hardware.value);
  return writerReady(mode.writer);
}

export class OnboardingController {
  private snapshot: OnboardingSnapshot;
  private readonly listeners = new Set<() => void>();
  private epoch = 0;
  private started = false;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;
  private announcementId = 0;
  private contentLanguageTouched = false;
  /** The person picked a setup: a later read of the card keeps the pick. */
  private chose = false;
  private apiKey = "";
  private provider: AiProviderConfig | null = null;
  private profile: AiProfile | null = null;
  private readonly downloads = new Map<string, DownloadView>();
  private readonly waiters = new Map<
    string,
    Array<{ resolve: () => void; reject: (error: StepFailure) => void }>
  >();
  private readonly requested = new Set<string>();
  /** The newest read of the card; an older answer arriving later is dropped. */
  private cardRead = 0;

  public constructor(private deps: OnboardingDeps) {
    this.snapshot = {
      phase: "checking",
      step: 1,
      languages: { language: "en", contentLanguage: "en", save: "idle" },
      mode: {
        hardware: { status: "loading" },
        catalog: { status: "loading" },
        selected: "hybrid",
        refusal: null,
        writer: initialWriter()
      },
      setup: initialSetup(),
      openedSourceId: null,
      openedStatus: null,
      skipping: false,
      announcement: null
    };
  }

  /** Replaces what the first run reads from the app: its languages, names and settings callback. */
  public bind(bindings: Partial<Omit<OnboardingDeps, "api">>): void {
    this.deps = { ...this.deps, ...bindings };
  }

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public readonly getSnapshot = (): OnboardingSnapshot => this.snapshot;

  /** Asks whether the first run is due, and starts listening to the model installs. */
  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.disposed = false;
    this.contentLanguageTouched = false;
    this.update({ languages: { ...this.deps.initial(), save: "idle" } });
    this.unsubscribe = this.api().onAppEvent("model.download", (event) => this.onModelEvent(event));
    const epoch = this.epoch;
    try {
      const state = await this.api().onboarding.state();
      if (!this.live(epoch)) return;
      if (state.show) this.enter("languages");
      else this.update({ phase: "off" });
    } catch {
      // The app stays usable when the question fails: the first run is offered again next start.
      if (this.live(epoch)) this.update({ phase: "off" });
    }
  }

  /** Stops listening and lets go of everything in flight. */
  public dispose(): void {
    this.disposed = true;
    this.started = false;
    this.epoch += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.rejectWaiters();
  }

  // --- Step 1: languages ---------------------------------------------------------------------

  public setLanguage(language: LanguageCode): void {
    const contentLanguage = this.contentLanguageTouched
      ? this.snapshot.languages.contentLanguage
      : language;
    this.update({
      languages: { ...this.snapshot.languages, language, contentLanguage, save: "idle" }
    });
  }

  public setContentLanguage(contentLanguage: LanguageCode): void {
    this.contentLanguageTouched = true;
    this.update({ languages: { ...this.snapshot.languages, contentLanguage, save: "idle" } });
  }

  /** Stores both languages (the app shows the interface language from then on) and goes on. */
  public async submitLanguages(): Promise<void> {
    if (this.snapshot.phase !== "languages" || this.snapshot.languages.save === "saving") return;
    const epoch = this.epoch;
    const { language, contentLanguage } = this.snapshot.languages;
    this.update({ languages: { ...this.snapshot.languages, save: "saving" } });
    try {
      const saved = await this.api().settings.updateApp({ language, contentLanguage });
      if (!this.live(epoch)) return;
      this.deps.onSettings?.(saved);
      this.update({ languages: { ...this.snapshot.languages, save: "idle" } });
      this.enter("mode");
    } catch {
      if (this.live(epoch))
        this.update({ languages: { ...this.snapshot.languages, save: "failed" } });
    }
  }

  // --- Step 2: the AI mode -------------------------------------------------------------------

  /** Reads this computer and the model list for the tier card; the card needs neither to be usable. */
  public async loadCard(): Promise<void> {
    const epoch = this.epoch;
    const read = (this.cardRead += 1);
    this.update({
      mode: {
        ...this.snapshot.mode,
        hardware: { status: "loading" },
        catalog: { status: "loading" }
      }
    });
    const api = this.api();
    // Both reads start together: the card states what each setup downloads before anything is fetched.
    const reads = [api.hardware.profile(), api.localModels.list()] as const;
    const [hardware, catalog] = await Promise.allSettled(reads);
    if (!this.live(epoch) || read !== this.cardRead) return;
    const hardwareLoad: Load<OnboardingHardware> =
      hardware.status === "fulfilled"
        ? { status: "ready", value: hardware.value }
        : { status: "error" };
    const catalogLoad: Load<LocalModelView[]> =
      catalog.status === "fulfilled"
        ? { status: "ready", value: catalog.value }
        : { status: "error" };
    const options = modeOptions(
      hardwareLoad.status === "ready" ? hardwareLoad.value : null,
      catalogLoad.status === "ready" ? catalogLoad.value : null
    );
    this.update({
      mode: {
        ...this.snapshot.mode,
        hardware: hardwareLoad,
        catalog: catalogLoad,
        selected: this.chose ? this.snapshot.mode.selected : defaultPreset(options),
        refusal: null
      }
    });
  }

  public retryCard(): void {
    if (this.snapshot.phase === "mode") void this.loadCard();
  }

  /** Chooses a setup. Local is refused where it cannot run (decision 26): the refusal says why. */
  public selectPreset(preset: AiPresetId): void {
    if (this.snapshot.phase !== "mode") return;
    const hardware = this.snapshot.mode.hardware;
    const refusal =
      preset === "local" && hardware.status === "ready" ? localRefusal(hardware.value) : null;
    if (refusal) {
      this.update({ mode: { ...this.snapshot.mode, refusal } });
      return;
    }
    this.chose = true;
    // The key field goes with the writer panel, and the key with it.
    if (preset === "local") this.forgetKey();
    this.update({ mode: { ...this.snapshot.mode, selected: preset, refusal: null } });
  }

  /** The API key lives in the field and here; when the field goes, so does the key. */
  private forgetKey(): void {
    this.apiKey = "";
    const writer = this.snapshot.mode.writer;
    if (writer.key.hasKey) this.setWriter({ ...writer, key: { ...writer.key, hasKey: false } });
  }

  public setWriterMethod(method: WriterState["method"]): void {
    const writer = this.snapshot.mode.writer;
    if (this.snapshot.phase !== "mode" || writer.codex.status === "connecting") return;
    if (method !== "key") this.forgetKey();
    this.setWriter({ ...this.snapshot.mode.writer, method });
  }

  /** The ChatGPT sign-in, in the browser. Nothing is saved until the setup runs. */
  public async signInCodex(): Promise<void> {
    const writer = this.snapshot.mode.writer;
    if (this.snapshot.phase !== "mode" || writer.codex.status === "connecting") return;
    const epoch = this.epoch;
    this.setWriter({ ...writer, codex: { ...writer.codex, status: "connecting", error: null } });
    try {
      const models = await this.api().ai.connectOpenAiCodex();
      if (!this.live(epoch)) return;
      const current = this.snapshot.mode.writer;
      this.setWriter({
        ...current,
        codex: {
          status: "connected",
          models,
          modelId: models.includes(current.codex.modelId)
            ? current.codex.modelId
            : (models[0] ?? ""),
          error: null
        }
      });
    } catch (error) {
      if (!this.live(epoch)) return;
      this.setWriter({
        ...this.snapshot.mode.writer,
        codex: {
          ...this.snapshot.mode.writer.codex,
          status: "failed",
          error: { key: errorMessageKey(error, "errors.ai.oauthLoginFailed") }
        }
      });
    }
  }

  public setCodexModel(modelId: string): void {
    const writer = this.snapshot.mode.writer;
    this.setWriter({ ...writer, codex: { ...writer.codex, modelId } });
  }

  public setKeyProvider(provider: KeyProvider): void {
    const writer = this.snapshot.mode.writer;
    this.setWriter({ ...writer, key: { ...writer.key, provider } });
  }

  public setKeyField(field: "baseUrl" | "modelId", value: string): void {
    const writer = this.snapshot.mode.writer;
    this.setWriter({ ...writer, key: { ...writer.key, [field]: value } });
  }

  /** The API key stays here and in the call that saves it; the snapshot only says that one was typed. */
  public setApiKey(value: string): void {
    this.apiKey = value.trim();
    const writer = this.snapshot.mode.writer;
    this.setWriter({ ...writer, key: { ...writer.key, hasKey: this.apiKey !== "" } });
  }

  /** Whether the chosen setup can start: Hybrid and Cloud sign in to a writer first. */
  public canStartSetup(): boolean {
    return canStartSetup(this.snapshot);
  }

  /** Applies the chosen setup and tests it, one part after the other. */
  public startSetup(): void {
    if (!this.canStartSetup()) return;
    this.update({
      phase: "testing",
      step: 2,
      setup: {
        ...initialSetup(),
        status: "running",
        steps: {
          ...initialSetup().steps,
          writer: this.snapshot.mode.selected === "local" ? "skipped" : "pending"
        }
      }
    });
    this.announce({ key: "onboarding.live.testing" });
    void this.runSetup();
  }

  public back(): void {
    if (this.snapshot.phase === "mode") this.enter("languages");
  }

  // --- The setup ------------------------------------------------------------------------------

  /** Runs again from the part that failed; what is done stays done. */
  public retrySetup(): void {
    if (this.snapshot.phase !== "testing" || this.snapshot.setup.status !== "failed") return;
    this.update({
      setup: { ...this.snapshot.setup, status: "running", failure: null, blocked: [] }
    });
    void this.runSetup();
  }

  /**
   * On to the first source: after the checks, or without a part that failed. The models do not
   * need the writer: when its failure stopped the setup before them, they are asked for now and
   * install in the background, so the first source is still searchable and the ranker follows
   * (decision 19).
   */
  public continueToSource(): void {
    const { phase, setup } = this.snapshot;
    if (phase !== "testing" || (setup.status !== "done" && setup.status !== "failed")) return;
    if (setup.steps.models === "pending") void this.requestModelsInBackground();
    this.enter("source");
  }

  // --- Step 3: the first source ---------------------------------------------------------------

  /** The first source was saved: the first run is recorded and the app opens the source. */
  public async sourceSaved(sourceItemId: string, status?: MessageKey): Promise<void> {
    if (this.snapshot.phase !== "source") return;
    const epoch = this.epoch;
    try {
      await this.api().onboarding.finish({ outcome: "completed" });
    } catch {
      // The source is in the library either way, and the first run is never due for a full library.
    }
    if (!this.live(epoch)) return;
    this.update({ phase: "done", openedSourceId: sourceItemId, openedStatus: status ?? null });
  }

  // --- Skipping -------------------------------------------------------------------------------

  /** Leaves the first run from any step; downloads that started go on in the background. */
  public async skip(): Promise<void> {
    if (this.snapshot.skipping || ["checking", "off", "done"].includes(this.snapshot.phase)) return;
    this.epoch += 1;
    this.rejectWaiters();
    this.update({ skipping: true });
    try {
      await this.api().onboarding.finish({ outcome: "skipped" });
    } catch {
      // Not recording it only shows the first run again next time.
    }
    if (!this.disposed) this.update({ phase: "off", skipping: false });
  }

  // --- Internals ------------------------------------------------------------------------------

  private api(): OnboardingApi {
    return this.deps.api();
  }

  private live(epoch: number): boolean {
    return !this.disposed && epoch === this.epoch;
  }

  private enter(phase: "languages" | "mode" | "source"): void {
    const step = phase === "languages" ? 1 : phase === "mode" ? 2 : 3;
    this.update({ phase, step });
    this.announce({ key: liveKeys[phase], values: { current: step, total: 3 } });
    if (phase === "mode") void this.loadCard();
  }

  private setWriter(writer: WriterState): void {
    this.update({ mode: { ...this.snapshot.mode, writer } });
  }

  private announce(message: OnboardingMessage): void {
    this.announcementId += 1;
    this.update({ announcement: { id: this.announcementId, message } });
  }

  private update(patch: Partial<OnboardingSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private patchSetup(patch: Partial<SetupState>): void {
    this.update({ setup: { ...this.snapshot.setup, ...patch } });
  }

  private setStep(name: SetupStepName, status: SetupStepStatus): void {
    this.patchSetup({ steps: { ...this.snapshot.setup.steps, [name]: status } });
  }

  private async runSetup(): Promise<void> {
    const epoch = this.epoch;
    for (const name of setupStepOrder) {
      const status = this.snapshot.setup.steps[name];
      if (status === "done" || status === "skipped") continue;
      this.setStep(name, "running");
      try {
        await this.runStep(name, epoch);
      } catch (error) {
        if (!this.live(epoch)) return;
        const message =
          error instanceof StepFailure
            ? error.failure
            : { key: errorMessageKey(error, setupFailureKeys[name]) };
        this.patchSetup({
          status: "failed",
          steps: { ...this.snapshot.setup.steps, [name]: "failed" },
          failure: { step: name, message }
        });
        this.announce({ key: "onboarding.live.setupFailed" });
        return;
      }
      if (!this.live(epoch)) return;
      this.setStep(name, "done");
    }
    this.patchSetup({ status: "done" });
    this.announce({
      key: "onboarding.live.setupDone",
      values: { count: failedTestCount(this.snapshot.setup.tests) }
    });
  }

  private runStep(name: SetupStepName, epoch: number): Promise<void> {
    if (name === "writer") return this.runWriter();
    if (name === "models") return this.runModels();
    if (name === "preset") return this.runPreset();
    return this.runTests(epoch);
  }

  /** The writer's provider and profile, as Settings leaves them; each call is made once. */
  private async runWriter(): Promise<void> {
    const { ai } = this.api();
    const writer = this.snapshot.mode.writer;
    const codex = writer.method === "codex";
    if (!writerReady(writer))
      throw new StepFailure({ key: "onboarding.setup.failed.writerNotReady" });
    const modelId = (codex ? writer.codex.modelId : writer.key.modelId).trim();
    const capabilities = [...(codex ? codexWriterCapabilities : writerCapabilities)];
    if (!this.provider) {
      const baseUrl = writer.key.baseUrl.trim();
      this.provider = await ai.saveProvider(
        codex
          ? {
              provider: codexProviderId,
              displayName: this.deps.names().codexProvider,
              modelId,
              capabilities,
              defaultParameters: {}
            }
          : {
              provider: writer.key.provider,
              displayName: `${writer.key.provider} ${modelId}`,
              ...(writer.key.provider === "openai-compatible" && baseUrl ? { baseUrl } : {}),
              apiKey: this.apiKey,
              modelId,
              capabilities,
              defaultParameters: {}
            }
      );
      this.apiKey = "";
    }
    this.profile ??= await ai.createProfile({
      name: this.deps.names().profile,
      isDefault: true,
      privacyMode: "allow_remote",
      outputLanguage: "ui"
    });
    await ai.updateProfile({
      id: this.profile.id,
      providerConfigId: this.provider.id,
      modelId,
      runtime: "remote",
      capabilities
    });
  }

  /** The models the chosen setup installs, from the tier card's reading when there is one. */
  private setupModels(): string[] {
    const { hardware, selected } = this.snapshot.mode;
    return modelsToInstall(selected, hardware.status === "ready" ? hardware.value : null);
  }

  /** Asks for the models the setup needs and waits for them; progress comes from `model.download`. */
  private async runModels(): Promise<void> {
    const ids = this.setupModels();
    for (const catalogId of ids) await this.request(catalogId);
    await Promise.all(ids.map((catalogId) => this.waitFor(catalogId)));
  }

  /** The setup's models, asked for without waiting; a refused one shows on its row in Settings. */
  private async requestModelsInBackground(): Promise<void> {
    for (const catalogId of this.setupModels()) {
      try {
        await this.request(catalogId);
      } catch {
        // Nothing waits for it here: the model's row keeps the error and Settings retries it.
      }
    }
  }

  private async runPreset(): Promise<void> {
    const { ai } = this.api();
    const preset = this.snapshot.mode.selected;
    let result = await ai.applyPreset({ preset, test: false });
    if (!result.applied) {
      // A model the main process names that the machine-free guess missed is installed and the
      // setup applied once more (a Local writer the tier table chose differently).
      const missing = [
        ...new Set(
          result.blocked.flatMap((entry) =>
            entry.reason === "model_missing" &&
            entry.catalogId &&
            !this.requested.has(entry.catalogId)
              ? [entry.catalogId]
              : []
          )
        )
      ];
      if (missing.length > 0) {
        for (const catalogId of missing) await this.request(catalogId);
        await Promise.all(missing.map((catalogId) => this.waitFor(catalogId)));
        result = await ai.applyPreset({ preset, test: false });
      }
    }
    if (!result.applied) {
      this.patchSetup({
        blocked: result.blocked.map((entry) => ({
          reason: entry.reason,
          route: entry.route,
          modelName: entry.modelName
        }))
      });
      throw new StepFailure({ key: "onboarding.setup.failed.preset" });
    }
  }

  /** One test per class that has a route, one after the other; a failure is a finding, not a stop. */
  private async runTests(epoch: number): Promise<void> {
    const { ai } = this.api();
    for (const route of firstRunClassTests) {
      if (!this.live(epoch)) return;
      this.setTest(route, { state: "running", ms: null, error: null });
      try {
        const view = await ai.testClassRoute(route);
        if (!this.live(epoch)) return;
        const test =
          route === "judge"
            ? view.judge.test
            : view.classes.find((entry) => entry.id === route)?.test;
        this.setTest(route, {
          state: test?.state === "passed" ? "passed" : test?.state === "none" ? "none" : "failed",
          ms: test?.ms ?? null,
          error: test?.state === "failed" ? (test.error ?? null) : null
        });
      } catch (error) {
        if (!this.live(epoch)) return;
        this.setTest(route, {
          state: "failed",
          ms: null,
          error: errorMessageKey(error, "errors.common.unknown")
        });
      }
    }
  }

  private setTest(route: AiClassRouteTarget, patch: Partial<ClassTestView>): void {
    this.patchSetup({
      tests: this.snapshot.setup.tests.map((test) =>
        test.route === route ? { ...test, ...patch } : test
      )
    });
  }

  // --- Model installs ---------------------------------------------------------------------------

  private async request(catalogId: string): Promise<void> {
    this.requested.add(catalogId);
    const role = modelRole(catalogId);
    // A new request starts from waiting: a failure an earlier try left must not answer this one.
    if (role && this.downloads.get(catalogId)?.state !== "ready")
      this.recordDownload({
        catalogId,
        role,
        state: "waiting",
        downloadedBytes: 0,
        totalBytes: 0,
        etaSeconds: null,
        error: null
      });
    const view = await this.api().localModels.download({ catalogId, acceptLicense: false });
    if (view.status === "ready") this.settleDownload(catalogId, "ready", null);
    else if (view.status === "failed")
      this.settleDownload(catalogId, "failed", view.lastError ?? null);
  }

  /** Resolves when the model is ready, rejects when its install failed. */
  private waitFor(catalogId: string): Promise<void> {
    const known = this.downloads.get(catalogId);
    if (known?.state === "ready") return Promise.resolve();
    if (known?.state === "failed")
      return Promise.reject(new StepFailure({ key: failureKey(known.error) }));
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(catalogId) ?? [];
      list.push({ resolve, reject });
      this.waiters.set(catalogId, list);
    });
  }

  private onModelEvent(event: ModelDownloadEvent): void {
    const role = modelRole(event.catalogId);
    if (!role) return;
    const state =
      event.status === "ready"
        ? "ready"
        : event.status === "failed"
          ? "failed"
          : event.status === "verifying"
            ? "verifying"
            : event.status === "downloading"
              ? "downloading"
              : "waiting";
    this.recordDownload({
      catalogId: event.catalogId,
      role,
      state,
      downloadedBytes: event.downloadedBytes,
      totalBytes: event.totalBytes,
      etaSeconds: event.etaSeconds,
      error: state === "failed" ? failureKey(event.error) : null
    });
    if (state === "ready") this.settleDownload(event.catalogId, "ready", null);
    else if (state === "failed") this.settleDownload(event.catalogId, "failed", event.error);
  }

  private recordDownload(view: DownloadView): void {
    this.downloads.set(view.catalogId, view);
    this.patchSetup({
      downloads: [...this.downloads.values()].sort(
        (a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role)
      )
    });
  }

  private settleDownload(catalogId: string, state: "ready" | "failed", error: string | null): void {
    const known = this.downloads.get(catalogId);
    const role = modelRole(catalogId);
    if (role && known?.state !== state)
      this.recordDownload({
        ...(known ?? {
          catalogId,
          role,
          downloadedBytes: 0,
          totalBytes: 0,
          etaSeconds: null
        }),
        state,
        error: state === "failed" ? failureKey(error) : null
      });
    const waiting = this.waiters.get(catalogId) ?? [];
    this.waiters.delete(catalogId);
    for (const waiter of waiting)
      if (state === "ready") waiter.resolve();
      else waiter.reject(new StepFailure({ key: failureKey(error) }));
  }

  private rejectWaiters(): void {
    for (const list of this.waiters.values())
      for (const waiter of list) waiter.reject(new StepFailure({ key: "errors.common.unknown" }));
    this.waiters.clear();
  }
}

/** The message a failed install shows: its own key when the catalog has it. */
function failureKey(error: string | null): OnboardingMessage["key"] {
  return errorMessageKey(new Error(error ?? ""), "onboarding.setup.failed.models");
}

const liveKeys: Record<"languages" | "mode" | "source", MessageKey> = {
  languages: "onboarding.live.languages",
  mode: "onboarding.live.mode",
  source: "onboarding.live.source"
};

const setupFailureKeys: Record<SetupStepName, OnboardingMessage["key"]> = {
  writer: "onboarding.setup.failed.writer",
  models: "onboarding.setup.failed.models",
  preset: "onboarding.setup.failed.preset",
  tests: "onboarding.setup.failed.tests"
};
