// A recording stand-in for the preload, for the onboarding's tests: every call is noted by the IPC
// channel it would use (the names of `first-run-sequence.ts`), and every payload is parsed with the
// schema of the real handler, so a call the controller gets wrong fails here as it would there.
import { presetCatalogIds } from "@app/domain";

import type { AppEventHandler, AppEventType, ModelDownloadEvent } from "../../../shared/app-events";
import { ipcChannels } from "../../../shared/ipc";
import {
  aiApplyPresetInputSchema,
  aiProfileCreateSchema,
  aiProfileUpdateSchema,
  aiProviderConfigInputSchema,
  appSettingsSchema,
  appSettingsUpdateSchema,
  defaultAppSettings,
  localModelDownloadInputSchema
} from "../../../shared/ipc";
import type {
  AiClassRoutes,
  AiClassRouteTarget,
  AiApplyPresetResult,
  AppSettings,
  LocalModelView
} from "../../../shared/ipc";
import { OnboardingHardwareSchema, type OnboardingHardware } from "../../../shared/onboarding";
import type { OnboardingApi } from "./onboarding-controller";

const gib = 1024 ** 3;

export const macHardware: OnboardingHardware = OnboardingHardwareSchema.parse({
  platform: "darwin",
  nativeArch: "arm64",
  translated: false,
  chip: "Apple M4 Max",
  memoryBytes: 48 * gib,
  workingSetBytes: 36 * gib,
  recommended: "hybrid",
  local: {
    available: true,
    unavailableReason: null,
    writerCatalogId: presetCatalogIds.writerLarge
  },
  estimates: [
    { preset: "local", monthlyUsd: null },
    { preset: "hybrid", monthlyUsd: 0.39 },
    { preset: "cloud", monthlyUsd: 0.45 }
  ]
});

export const windowsHardware: OnboardingHardware = OnboardingHardwareSchema.parse({
  platform: "win32",
  nativeArch: "x64",
  translated: false,
  chip: null,
  memoryBytes: 16 * gib,
  workingSetBytes: null,
  recommended: "hybrid",
  local: {
    available: false,
    unavailableReason: "no_local_writer_for_platform",
    writerCatalogId: null
  },
  estimates: [
    { preset: "local", monthlyUsd: null },
    { preset: "hybrid", monthlyUsd: 0.39 },
    { preset: "cloud", monthlyUsd: 0.45 }
  ]
});

/** An 8 GB Apple silicon Mac: Local runs here, but the tier table says its writer does not fit. */
export const smallMacHardware: OnboardingHardware = OnboardingHardwareSchema.parse({
  ...macHardware,
  chip: "Apple M1",
  memoryBytes: 8 * gib,
  workingSetBytes: 5 * gib,
  local: { available: false, unavailableReason: "memory", writerCatalogId: null }
});

const modelRow = (catalogId: string, expectedSizeBytes: number, status = "not_downloaded") =>
  ({
    id: crypto.randomUUID(),
    catalogId,
    displayName: catalogId,
    expectedSizeBytes,
    status,
    lastError: null
  }) as unknown as LocalModelView;

export const catalogRows = (): LocalModelView[] => [
  modelRow(presetCatalogIds.embedding, 0.6 * gib),
  modelRow(presetCatalogIds.rankerMlx, 0.64 * gib),
  modelRow(presetCatalogIds.rankerGguf, 0.64 * gib),
  modelRow(presetCatalogIds.writerLarge, 5.5 * gib),
  modelRow(presetCatalogIds.writerSmall, 2.4 * gib)
];

export interface RecordedOptions {
  /** `onboarding.state`: whether the view is due. */
  due?: boolean;
  /** `pending` never answers: the card stays on its loading state. */
  hardware?: OnboardingHardware | "error" | "pending";
  models?: LocalModelView[] | "error";
  /**
   * What a download request does: `instant` settles at once (the model is ready when the call
   * returns), `event` answers "downloading" and publishes the ready event on the next tick,
   * `manual` leaves the event to the test.
   */
  installs?: "instant" | "event" | "manual";
  codexModels?: string[];
  /** Class tests that fail or throw. */
  failingTests?: AiClassRouteTarget[];
  throwingTests?: AiClassRouteTarget[];
  /** The answers of `ai.applyPreset`, in order; the last one repeats. */
  presetAnswers?: Array<Pick<AiApplyPresetResult, "applied" | "blocked">>;
  /** Calls that throw once, by channel. */
  failOnce?: string[];
}

export interface Recorded {
  api: OnboardingApi;
  /** The IPC channel of each call, in order. */
  calls: string[];
  /** The payloads, by channel, in order. */
  payloads: Record<string, unknown[]>;
  emit(event: ModelDownloadEvent): void;
  listeners(): number;
  settings: AppSettings[];
}

export const downloadEvent = (
  catalogId: string,
  status: ModelDownloadEvent["status"],
  extra: Partial<ModelDownloadEvent> = {}
): ModelDownloadEvent => ({
  type: "model.download",
  localModelId: crypto.randomUUID(),
  catalogId,
  status,
  currentFile: null,
  downloadedBytes: 0,
  totalBytes: 0,
  bytesPerSecond: 0,
  etaSeconds: null,
  error: null,
  ...extra
});

const classIds = ["embed", "decide", "write-fast", "write-quality", "answer"] as const;

function routesView(
  tests: Partial<Record<AiClassRouteTarget, "passed" | "failed" | "none">>
): AiClassRoutes {
  const testOf = (route: AiClassRouteTarget) => {
    const state = tests[route] ?? "passed";
    return {
      state,
      model: null,
      ms: state === "passed" ? 800 : null,
      at: null,
      error: state === "failed" ? "errors.ai.invalidOutput" : null
    };
  };
  return {
    preset: "hybrid",
    presets: [],
    classes: classIds.map((id) => ({
      id,
      profileId: null,
      profileName: null,
      modelId: null,
      runtime: null,
      remote: false,
      test: testOf(id)
    })),
    judge: {
      profileId: null,
      profileName: null,
      modelId: null,
      runtime: null,
      remote: false,
      providerName: null,
      routed: true,
      deciderMode: null,
      test: testOf("judge")
    }
  } as unknown as AiClassRoutes;
}

export function recordedApi(options: RecordedOptions = {}): Recorded {
  const calls: string[] = [];
  const payloads: Record<string, unknown[]> = {};
  const listeners = new Set<AppEventHandler<"model.download">>();
  const saved: AppSettings[] = [];
  const failures = new Set(options.failOnce ?? []);
  const installs = options.installs ?? "instant";
  let presetCall = 0;
  const testStates: Partial<Record<AiClassRouteTarget, "passed" | "failed" | "none">> = {};
  for (const route of options.failingTests ?? []) testStates[route] = "failed";

  const note = (channel: string, payload?: unknown) => {
    calls.push(channel);
    (payloads[channel] ??= []).push(payload);
    if (failures.delete(channel)) throw new Error("errors.common.unknown");
  };

  const emit = (event: ModelDownloadEvent) => {
    for (const listener of [...listeners]) listener(event);
  };

  const api: OnboardingApi = {
    onAppEvent: (<T extends AppEventType>(type: T, handler: AppEventHandler<T>) => {
      if (type !== "model.download") return () => undefined;
      const listener = handler as unknown as AppEventHandler<"model.download">;
      listeners.add(listener);
      return () => void listeners.delete(listener);
    }) as OnboardingApi["onAppEvent"],
    onboarding: {
      state: async () => {
        note(ipcChannels.onboardingState);
        const show = options.due ?? true;
        return { outcome: null, at: null, libraryEmpty: show, show };
      },
      finish: async (input) => {
        note(ipcChannels.onboardingFinish, input);
        return {
          outcome: input.outcome,
          at: new Date(0).toISOString(),
          libraryEmpty: true,
          show: false
        };
      }
    },
    settings: {
      updateApp: async (update) => {
        note(ipcChannels.appSettingsUpdate, update);
        const parsed = appSettingsUpdateSchema.parse(update);
        const next = appSettingsSchema.parse({
          ...defaultAppSettings,
          language: "en",
          ...parsed,
          updatedAt: new Date(0).toISOString()
        });
        saved.push(next);
        return next;
      }
    },
    hardware: {
      profile: async () => {
        note(ipcChannels.hardwareProfile);
        if (options.hardware === "error") throw new Error("errors.common.unknown");
        if (options.hardware === "pending") return new Promise<OnboardingHardware>(() => undefined);
        return options.hardware ?? macHardware;
      }
    },
    localModels: {
      list: async () => {
        note(ipcChannels.localModelsList);
        if (options.models === "error") throw new Error("errors.common.unknown");
        return options.models ?? catalogRows();
      },
      download: async (input) => {
        note(ipcChannels.localModelsDownload, localModelDownloadInputSchema.parse(input));
        const row = modelRow(input.catalogId, 0, installs === "instant" ? "ready" : "downloading");
        if (installs === "event")
          queueMicrotask(() => emit(downloadEvent(input.catalogId, "ready")));
        return row;
      }
    },
    ai: {
      connectOpenAiCodex: async () => {
        note(ipcChannels.aiOpenAiCodexConnect);
        return options.codexModels ?? ["gpt-5.6-luna", "gpt-5.6"];
      },
      saveProvider: async (input) => {
        note(ipcChannels.aiProvidersSave, aiProviderConfigInputSchema.parse(input));
        return { id: crypto.randomUUID(), ...input } as never;
      },
      createProfile: async (input) => {
        note(ipcChannels.aiProfilesCreate, aiProfileCreateSchema.parse(input));
        return { id: crypto.randomUUID(), name: input.name } as never;
      },
      updateProfile: async (input) => {
        note(ipcChannels.aiProfilesUpdate, aiProfileUpdateSchema.parse(input));
        return { id: input.id } as never;
      },
      applyPreset: async (input) => {
        note(ipcChannels.aiApplyPreset, aiApplyPresetInputSchema.parse(input));
        const answers = options.presetAnswers ?? [{ applied: true, blocked: [] }];
        const answer = answers[Math.min(presetCall, answers.length - 1)]!;
        presetCall += 1;
        return { ...answer, view: routesView({}) };
      },
      testClassRoute: async (route) => {
        note(ipcChannels.aiTestClassRoute, route);
        if (options.throwingTests?.includes(route)) throw new Error("errors.common.unknown");
        return routesView(testStates);
      }
    }
  };
  return { api, calls, payloads, emit, listeners: () => listeners.size, settings: saved };
}

/** Lets the controller's pending promises run. */
export async function settle(times = 20): Promise<void> {
  for (let index = 0; index < times; index += 1)
    await new Promise<void>((done) => setTimeout(done, 0));
}
