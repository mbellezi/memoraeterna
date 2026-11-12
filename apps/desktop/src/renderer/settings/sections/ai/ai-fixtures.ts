import {
  HardwareProfileSchema,
  recommendSetup,
  type HardwareProfile,
  type HardwareProfileResult,
  type HardwareTierId
} from "@app/domain";

import type {
  AiClassRoutes,
  AiDecisionsStatus,
  AiProfile,
  AiProviderConfig,
  LocalModelView
} from "../../../../shared/ipc";
import type { SettingDescription } from "../../../../shared/ipc-settings-describe";
import { settingsRegistryV2, type Json } from "../../../../shared/settings-registry";

/**
 * What the AI section reads, as plain data: the fake `window.app` of the screens tool and the tests
 * of the section answer from it. The names of the models stand for the person's own content, so they
 * stay as they are in every language; the chrome around them is the app's own copy.
 */

const gib = 1024 ** 3;

export const ids = {
  profileEmbed: "11111111-1111-4111-8111-111111111111",
  profileRank: "22222222-2222-4222-8222-222222222222",
  profileCodex: "33333333-3333-4333-8333-333333333333",
  profileCompat: "44444444-4444-4444-8444-444444444444",
  providerCodex: "55555555-5555-4555-8555-555555555555",
  providerCompat: "66666666-6666-4666-8666-666666666666",
  modelEmbed: "77777777-7777-4777-8777-777777777777",
  modelRank: "88888888-8888-4888-8888-888888888888",
  modelWriter: "99999999-9999-4999-8999-999999999999",
  modelWriterLarge: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
} as const;

const now = new Date("2026-11-12T08:40:00.000Z");

/** The facts a probe reports for each tier of the tier table (decision 25). */
const machines: Record<
  HardwareTierId,
  {
    platform: HardwareProfile["platform"];
    arch: HardwareProfile["nativeArch"];
    gib: number;
    gpu: HardwareProfile["gpu"]["kind"];
    chip: string;
    vramGib?: number;
  }
> = {
  "apple-8": { platform: "darwin", arch: "arm64", gib: 8, gpu: "apple", chip: "Apple M2" },
  "apple-16": { platform: "darwin", arch: "arm64", gib: 16, gpu: "apple", chip: "Apple M3" },
  "apple-24": { platform: "darwin", arch: "arm64", gib: 24, gpu: "apple", chip: "Apple M3 Pro" },
  "apple-32": { platform: "darwin", arch: "arm64", gib: 32, gpu: "apple", chip: "Apple M3 Pro" },
  "apple-48": { platform: "darwin", arch: "arm64", gib: 48, gpu: "apple", chip: "Apple M3 Max" },
  "apple-64": { platform: "darwin", arch: "arm64", gib: 64, gpu: "apple", chip: "Apple M3 Max" },
  "apple-96": { platform: "darwin", arch: "arm64", gib: 96, gpu: "apple", chip: "Apple M3 Ultra" },
  "apple-128": { platform: "darwin", arch: "arm64", gib: 128, gpu: "apple", chip: "Apple M4 Max" },
  "mac-intel": {
    platform: "darwin",
    arch: "x64",
    gib: 16,
    gpu: "integrated",
    chip: "Intel Core i7"
  },
  "windows-basic": {
    platform: "win32",
    arch: "x64",
    gib: 8,
    gpu: "integrated",
    chip: "Intel Core i5"
  },
  "windows-standard": {
    platform: "win32",
    arch: "x64",
    gib: 16,
    gpu: "discrete",
    chip: "AMD Ryzen 7",
    vramGib: 8
  },
  "windows-large": {
    platform: "win32",
    arch: "x64",
    gib: 64,
    gpu: "discrete",
    chip: "AMD Ryzen 9",
    vramGib: 24
  },
  other: { platform: "linux", arch: "x64", gib: 16, gpu: "none", chip: "Generic CPU" }
};

/** `hardware.profile` for a tier: the probed profile, the free disk and the recommendation for it. */
export function hardwareFixture(
  tier: HardwareTierId,
  options: { translated?: boolean; complete?: boolean } = {}
): HardwareProfileResult {
  const machine = machines[tier];
  const apple = machine.gpu === "apple";
  const profile = HardwareProfileSchema.parse({
    version: 1,
    platform: machine.platform,
    processArch: machine.arch === "arm64" && !options.translated ? "arm64" : "x64",
    nativeArch: machine.arch,
    translated: options.translated ?? false,
    osRelease: "25.0.0",
    cpu: { brand: machine.chip, physicalCores: 8, logicalCores: 8 },
    memoryBytes: machine.gib * gib,
    gpu: {
      kind: machine.gpu,
      name: apple ? machine.chip : null,
      cores: apple ? 18 : null,
      vramBytes: machine.vramGib ? machine.vramGib * gib : null
    },
    workingSet: apple ? { bytes: Math.floor(machine.gib * 0.66 * gib), source: "estimated" } : null,
    npu: { present: apple, name: null },
    complete: options.complete ?? true,
    probedAt: now.toISOString()
  });
  return {
    profile,
    freeDiskBytes: 412 * gib,
    localWriterBytes: apple ? Math.round(2.4 * gib) : null,
    recommendation: recommendSetup(profile)
  };
}

export const tierIds = Object.keys(machines) as HardwareTierId[];

const profile = (
  id: string,
  name: string,
  modelId: string,
  capabilities: AiProfile["capabilities"],
  where: { providerConfigId: string } | { localModelId: string }
): AiProfile => ({
  id,
  name,
  description: null,
  isDefault: false,
  outputLanguage: "ui",
  providerConfigId: "providerConfigId" in where ? where.providerConfigId : null,
  localModelId: "localModelId" in where ? where.localModelId : null,
  modelId,
  runtime: "providerConfigId" in where ? "remote" : "mlx",
  capabilities,
  status: "active"
});

export const profilesFixture: AiProfile[] = [
  profile(ids.profileEmbed, "Qwen3-Embedding-0.6B", "Qwen3-Embedding-0.6B", ["embedding"], {
    localModelId: ids.modelEmbed
  }),
  profile(ids.profileRank, "Qwen3-Reranker-0.6B", "Qwen3-Reranker-0.6B", ["reranking"], {
    localModelId: ids.modelRank
  }),
  profile(
    ids.profileCodex,
    "gpt-5.6-luna",
    "gpt-5.6-luna",
    [
      "text-generation",
      "structured-output",
      "summarization",
      "knowledge-graph-generation",
      "atomic-note-generation"
    ],
    { providerConfigId: ids.providerCodex }
  ),
  profile(
    ids.profileCompat,
    "gpt-6-luna",
    "gpt-6-luna",
    ["text-generation", "structured-output", "summarization"],
    { providerConfigId: ids.providerCompat }
  )
];

export const providersFixture: AiProviderConfig[] = [
  {
    id: ids.providerCodex,
    provider: "openai-codex",
    displayName: "gpt-5.6-luna",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    modelId: "gpt-5.6-luna",
    capabilities: ["text-generation", "structured-output", "summarization", "requires-network"],
    defaultParameters: {},
    parameterCapabilities: {},
    secretConfigured: true,
    status: "active"
  },
  {
    id: ids.providerCompat,
    provider: "openai-compatible",
    displayName: "gpt-6-luna",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-6-luna",
    capabilities: ["text-generation", "structured-output", "requires-network", "requires-api-key"],
    defaultParameters: {},
    parameterCapabilities: {},
    secretConfigured: true,
    status: "active"
  }
];

const passed = (model: string, ms: number) =>
  ({ state: "passed", model, ms, at: now.toISOString(), error: null }) as const;
const untested = { state: "untested", model: null, ms: null, at: null, error: null } as const;

/** The Hybrid setup: search and comparison on this Mac, writing on the ChatGPT subscription. */
export const routesFixture: AiClassRoutes = {
  preset: "hybrid",
  presets: [
    { id: "local", available: true, reason: null },
    { id: "hybrid", available: true, reason: null },
    { id: "cloud", available: true, reason: null }
  ],
  classes: [
    {
      id: "embed",
      profileId: ids.profileEmbed,
      profileName: "Qwen3-Embedding-0.6B",
      modelId: "Qwen3-Embedding-0.6B",
      runtime: "mlx",
      remote: false,
      test: passed("Qwen3-Embedding-0.6B", 38)
    },
    {
      id: "decide",
      profileId: ids.profileRank,
      profileName: "Qwen3-Reranker-0.6B",
      modelId: "Qwen3-Reranker-0.6B",
      runtime: "mlx",
      remote: false,
      test: passed("Qwen3-Reranker-0.6B", 112)
    },
    {
      id: "write-fast",
      profileId: ids.profileCodex,
      profileName: "gpt-5.6-luna",
      modelId: "gpt-5.6-luna",
      runtime: "remote",
      remote: true,
      test: passed("gpt-5.6-luna", 1400)
    },
    {
      id: "write-quality",
      profileId: ids.profileCompat,
      profileName: "gpt-6-luna",
      modelId: "gpt-6-luna",
      runtime: "remote",
      remote: true,
      test: passed("gpt-6-luna", 2100)
    },
    {
      id: "answer",
      profileId: ids.profileCodex,
      profileName: "gpt-5.6-luna",
      modelId: "gpt-5.6-luna",
      runtime: "remote",
      remote: true,
      test: passed("gpt-5.6-luna", 1800)
    }
  ],
  judge: {
    profileId: ids.profileCodex,
    profileName: "gpt-5.6-luna",
    modelId: "gpt-5.6-luna",
    runtime: "remote",
    remote: true,
    providerName: "gpt-5.6-luna",
    routed: true,
    deciderMode: null,
    test: untested
  }
};

/** No setup chosen and nothing routed: the first run before its second step. */
export const routesEmptyFixture: AiClassRoutes = {
  preset: null,
  presets: routesFixture.presets,
  classes: routesFixture.classes.map((entry) => ({
    ...entry,
    profileId: null,
    profileName: null,
    modelId: null,
    runtime: null,
    remote: false,
    test: untested
  })),
  judge: {
    ...routesFixture.judge,
    profileId: null,
    profileName: null,
    modelId: null,
    runtime: null,
    remote: false,
    providerName: null,
    routed: false,
    test: untested
  }
};

const localModel = (
  id: string,
  catalogId: string,
  displayName: string,
  status: LocalModelView["status"],
  more: Partial<LocalModelView> = {}
): LocalModelView => ({
  id,
  catalogId,
  modelId: displayName,
  displayName,
  family: "Qwen3",
  variant: "base",
  repository: "mlx-community/example",
  revision: "0123456789abcdef",
  runtime: "mlx",
  format: "safetensors",
  quantization: "4-bit",
  capabilities: ["text-generation", "structured-output"],
  parameterCapabilities: {},
  defaultParameters: {},
  recommendedParameters: null,
  minimumMemoryBytes: 8 * gib,
  recommendedMemoryBytes: 16 * gib,
  expectedSizeBytes: 2.4 * gib,
  installedSizeBytes: status === "ready" ? 2.4 * gib : 0,
  licenseName: "Apache-2.0",
  licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
  requiresLicenseAcceptance: false,
  licenseAccepted: true,
  status,
  compatible: true,
  compatibilityReason: "compatible",
  profilesUsing: [],
  lastError: null,
  download: null,
  ...more
});

export const localModelsFixture: LocalModelView[] = [
  localModel(ids.modelEmbed, "mlx-qwen3-embedding-0.6b", "Qwen3-Embedding-0.6B", "ready", {
    capabilities: ["embedding"],
    expectedSizeBytes: 1.2 * gib,
    installedSizeBytes: 1.2 * gib,
    profilesUsing: ["Qwen3-Embedding-0.6B"]
  }),
  localModel(ids.modelRank, "mlx-qwen3-reranker-0.6b", "Qwen3-Reranker-0.6B", "ready", {
    capabilities: ["reranking"],
    expectedSizeBytes: 0.5 * gib,
    installedSizeBytes: 0.5 * gib,
    profilesUsing: ["Qwen3-Reranker-0.6B"]
  }),
  localModel(
    ids.modelWriter,
    "mlx-qwen3-4b-instruct-2507-4bit",
    "Qwen3-4B-Instruct",
    "not_downloaded",
    {
      expectedSizeBytes: 2.3 * gib
    }
  ),
  localModel(ids.modelWriterLarge, "mlx-qwen3.5-9b-4bit", "Qwen3.5-9B", "downloading", {
    expectedSizeBytes: 5.6 * gib,
    download: {
      jobId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      currentFile: "model.safetensors",
      downloadedBytes: 2.3 * gib,
      totalBytes: 5.6 * gib,
      bytesPerSecond: 21 * 1024 ** 2,
      etaSeconds: 162
    }
  })
];

export const decisionsFixture: AiDecisionsStatus = {
  state: "off",
  enabled: false,
  presetAllowed: true,
  keyStored: false,
  keyInvalid: false,
  fallbackReason: null,
  model: "gpt-6-luna",
  priceInputPerMillionUsd: 0.15,
  bodyCharacters: 1200,
  spentTodayUsd: 0,
  dailyCapUsd: 1,
  requestsToday: 0,
  calibrated: false,
  lastUsedAt: null
};

export const budgetFixture = {
  month: "2026-11",
  day: "2026-11-12",
  money: {
    spentUsd: 3.1,
    reservedUsd: 0,
    capUsd: 12,
    pauseShare: 0.8,
    continued: false,
    state: "open",
    priceTableVersion: "2026-11"
  },
  calls: { usedCalls: 12, reservedCalls: 0, capCalls: 200, state: "open" }
} as const;

/**
 * What `settings.describe` answers for the AI section: the entries that store something, at their
 * default except the ones the fixture changes (a route on another model).
 */
export function describeFixture(
  changed: Readonly<Record<string, { value: Json; default: Json | null }>> = defaultChanges
): SettingDescription[] {
  return settingsRegistryV2
    .filter((entry) => entry.store.kind !== "none")
    .map((entry) => {
      const known = changed[entry.id];
      return {
        id: entry.id,
        value: known?.value ?? (entry.control === "switch" ? false : null),
        default: known ? known.default : null,
        changed: known !== undefined
      };
    });
}

const defaultChanges: Record<string, { value: Json; default: Json | null }> = {
  "ai.route.write-quality": { value: ids.profileCompat, default: ids.profileCodex },
  themeMode: { value: "light", default: "dark" }
};

/**
 * The call paths of the fake `window.app`, for the section as the person sees it: Hybrid on a Mac with
 * Apple silicon and 32 GB, a ChatGPT sign-in and a compatible key saved, no Google key, the local
 * embedder and ranker installed, one writer on its way.
 */
export function aiCalls(
  tier: HardwareTierId = "apple-32",
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    "settings.describe": { entries: describeFixture() },
    "ai.classRoutes": routesFixture,
    "ai.listProfiles": profilesFixture,
    "ai.listProviders": providersFixture,
    "ai.listProfileTasks": [],
    "ai.decisionsStatus": decisionsFixture,
    "hardware.profile": hardwareFixture(tier),
    "localModels.list": localModelsFixture,
    "localModels.hasRepositoryToken": false,
    "budget.snapshot": budgetFixture,
    ...overrides
  };
}
