import {
  aiClassIds,
  supportsTask,
  type AiCapability,
  type AiClassId,
  type AiPresetId,
  type AiPresetMode,
  type DecisionsFallbackReason,
  type HardwareProfileResult,
  type HardwareReason
} from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import type {
  AiClassRouteTarget,
  AiClassRoutes,
  AiClassTest,
  AiDecisionsStatus,
  AiProfile,
  AiProviderConfig,
  LocalModelView
} from "../../../../shared/ipc";

/**
 * What the AI section of Settings v2 shows, as plain functions over the answers of `window.app.ai`,
 * `hardware.profile` and `localModels` (F5 T163, design record §7.6, docs/f5-decisions.md D17): the
 * four setup cards, which models a job may be given, how a test reads, what This Mac says, the
 * words of a provider's state and of the Decisions opt-in, and the figures of the local models.
 * Nothing here reads the app or the DOM.
 */

// ---------------------------------------------------------------------------
// Routes

/** The five workload classes and the generative judge, in the order the section lists them. */
export const routeOrder: readonly AiClassRouteTarget[] = [...aiClassIds, "judge"];

/** The registry id of a route's row: `ai.route.<name>` (the data-setting-id a link finds it by). */
export const routeEntryId = (route: AiClassRouteTarget): string => `ai.route.${route}`;

/** The route a registry id names, or null. */
export function routeOfEntryId(id: string): AiClassRouteTarget | null {
  const name = id.startsWith("ai.route.") ? id.slice("ai.route.".length) : null;
  return routeOrder.find((route) => route === name) ?? null;
}

/**
 * Whether a profile can be offered for a route; the main process checks the choice again. A profile
 * serves a job by what its model can do: a ranker only decides, a writer writes and judges.
 */
export function profileOffered(profile: AiProfile, route: AiClassRouteTarget): boolean {
  if (profile.status !== "active" || !profile.modelId) return false;
  const generates = profile.capabilities.some((capability) =>
    ["text-generation", "structured-output", "summarization", "embedding"].includes(capability)
  );
  const generative =
    profile.providerConfigId !== null || (profile.localModelId !== null && generates);
  if (route === "embed") return supportsTask("embedding", profile.capabilities);
  if (route === "decide")
    return (
      profile.localModelId !== null && !generative && profile.capabilities.includes("reranking")
    );
  if (route === "judge") return generative && supportsTask("reranking", profile.capabilities);
  return supportsTask("structured-output", profile.capabilities);
}

/** The text of a stored test error: a localized key when the message catalog has it, else as is. */
export function testErrorText(t: Translator, error: string): string {
  if (/^[a-z][A-Za-z]*(\.[A-Za-z0-9_-]+)+$/u.test(error)) {
    const text = t(error as MessageKey);
    if (!text.startsWith("[[missing:")) return text;
  }
  return error;
}

/** The first message key an error carries (`errors.ai.noCompatibleModel`), or the fallback. */
export function errorKeyOf(error: unknown, fallback: MessageKey = "settingsAi.errors.write") {
  const match = error instanceof Error ? error.message.match(/errors\.[a-zA-Z0-9_.-]+/u) : null;
  return (match?.[0] as MessageKey | undefined) ?? fallback;
}

export type TestLineKind = "ok" | "failed" | "idle";

/** How a route's last test reads: its kind (the glyph and the colour) and its words. */
export function testLine(
  t: Translator,
  test: AiClassTest,
  route: AiClassRouteTarget
): { kind: TestLineKind; text: string } {
  if (test.state === "passed") {
    if (test.ms === null) return { kind: "ok", text: t("settingsAi.test.passed") };
    if (test.ms < 1000)
      return {
        kind: "ok",
        text: t("settingsAi.test.passedMs", { values: { ms: String(Math.round(test.ms)) } })
      };
    const seconds = new Intl.NumberFormat(t.locale, { maximumFractionDigits: 1 }).format(
      test.ms / 1000
    );
    return { kind: "ok", text: t("settingsAi.test.passedSeconds", { values: { seconds } }) };
  }
  if (test.state === "failed")
    return {
      kind: "failed",
      text: test.error
        ? t("settingsAi.test.failedWith", { values: { reason: testErrorText(t, test.error) } })
        : t("settingsAi.test.failed")
    };
  return {
    kind: "idle",
    text:
      test.state === "none" && route === "decide"
        ? t("settingsAi.test.none")
        : t("settingsAi.test.untested")
  };
}

/** The test of a route, whichever row of the view holds it. */
export function testOf(routes: AiClassRoutes, route: AiClassRouteTarget): AiClassTest {
  return route === "judge"
    ? routes.judge.test
    : (routes.classes.find((entry) => entry.id === route)?.test ?? {
        state: "untested",
        model: null,
        ms: null,
        at: null,
        error: null
      });
}

export interface RouteView {
  route: AiClassRouteTarget;
  profileId: string | null;
  modelId: string | null;
  remote: boolean;
  options: AiProfile[];
  test: AiClassTest;
}

/** What one route's row shows: the profile it points at, the ones it may point at and its test. */
export function routeView(
  routes: AiClassRoutes,
  profiles: readonly AiProfile[],
  route: AiClassRouteTarget
): RouteView {
  const options = profiles.filter((profile) => profileOffered(profile, route));
  if (route === "judge")
    return {
      route,
      profileId: routes.judge.profileId,
      modelId: routes.judge.modelId,
      remote: routes.judge.remote,
      options,
      test: routes.judge.test
    };
  const entry = routes.classes.find((candidate) => candidate.id === route);
  return {
    route,
    profileId: entry?.profileId ?? null,
    modelId: entry?.modelId ?? null,
    remote: entry?.remote ?? false,
    options,
    test: testOf(routes, route)
  };
}

/** No setup yet and no profile pointed at anything: the routes have nothing to say. */
export function routesAreEmpty(routes: AiClassRoutes): boolean {
  return (
    routes.preset === null &&
    routes.classes.every((entry) => entry.profileId === null) &&
    routes.judge.profileId === null
  );
}

// ---------------------------------------------------------------------------
// The setup cards

export const setupOrder: readonly AiPresetMode[] = ["local", "hybrid", "cloud", "custom"];

export const setupNameKeys: Record<AiPresetMode, MessageKey> = {
  local: "settingsAi.preset.name.local",
  hybrid: "settingsAi.preset.name.hybrid",
  cloud: "settingsAi.preset.name.cloud",
  custom: "settingsAi.preset.name.custom"
};
export const setupHelpKeys: Record<AiPresetMode, MessageKey> = {
  local: "settingsAi.preset.local.help",
  hybrid: "settingsAi.preset.hybrid.help",
  cloud: "settingsAi.preset.cloud.help",
  custom: "settingsAi.preset.custom.help"
};

export interface SetupCard {
  id: AiPresetMode;
  /** False when this Mac cannot run the setup: the card shows why and cannot be chosen. */
  available: boolean;
  /** One line under the help: why it is unavailable, or what to know before choosing it. */
  note: MessageKey | null;
  recommended: boolean;
  /** The informative month of a cloud setup on an API key, from the price table. */
  estimateUsd: number | null;
  /** The setup the library is on now. */
  current: boolean;
}

/** The four cards, from the routes (what main says is available) and, when read, This Mac. */
export function setupCards(
  routes: AiClassRoutes,
  hardware: HardwareProfileResult | null
): SetupCard[] {
  const recommendation = hardware?.recommendation ?? null;
  return setupOrder.map((id) => {
    if (id === "custom")
      return {
        id,
        available: true,
        note: null,
        recommended: false,
        estimateUsd: null,
        current: routes.preset === "custom"
      };
    const preset = routes.presets.find((candidate) => candidate.id === id);
    let available = preset?.available ?? true;
    let note: MessageKey | null = null;
    if (id === "local") {
      const refused = recommendation?.local;
      if (preset && !preset.available) note = "settingsAi.preset.local.unavailableSilicon";
      else if (refused?.offer === "unavailable") {
        available = false;
        note =
          refused.unavailableReason === "memory"
            ? "settingsAi.preset.local.unavailableMemory"
            : refused.unavailableReason === "no_local_writer_for_platform"
              ? "settingsAi.preset.local.unavailableSystem"
              : "settingsAi.preset.local.unavailableSilicon";
      } else if (recommendation?.reasons.includes("local_quality_unverified"))
        note = "settingsAi.preset.local.unverified";
    }
    const estimate =
      id !== "local" && recommendation
        ? (recommendation.costs[id].routes.find((route) => route.kind === "api")?.monthlyUsd ??
          null)
        : null;
    return {
      id,
      available,
      note,
      recommended: recommendation?.recommended === id,
      estimateUsd: estimate !== null && estimate > 0 ? estimate : null,
      current: routes.preset === id
    };
  });
}

/** Whether switching to a setup deserves the warning that writing may stay on hold. */
export function setupNeedsWriterWarning(
  setup: AiPresetId,
  hardware: HardwareProfileResult | null
): boolean {
  return (
    setup === "local" &&
    hardware !== null &&
    hardware.recommendation.reasons.includes("local_quality_unverified")
  );
}

// ---------------------------------------------------------------------------
// This Mac

export type MacKind = "silicon" | "intel" | "windows" | "other";

export interface MacFacts {
  kind: MacKind;
  chip: string | null;
  facts: Array<{ label: MessageKey; value: string }>;
}

export const macTitleKeys: Record<MacKind, MessageKey> = {
  silicon: "settingsAi.thisMac.title.silicon",
  intel: "settingsAi.thisMac.title.intel",
  windows: "settingsAi.thisMac.title.windows",
  other: "settingsAi.thisMac.title.other"
};

export const hardwareReasonKeys: Record<HardwareReason, MessageKey> = {
  local_quality_unverified: "settingsAi.thisMac.reason.local_quality_unverified",
  local_memory_too_small: "settingsAi.thisMac.reason.local_memory_too_small",
  local_requires_apple_silicon: "settingsAi.thisMac.reason.local_requires_apple_silicon",
  local_writer_unavailable: "settingsAi.thisMac.reason.local_writer_unavailable",
  running_under_rosetta: "settingsAi.thisMac.reason.running_under_rosetta",
  ranker_slow_on_cpu: "settingsAi.thisMac.reason.ranker_slow_on_cpu",
  probe_incomplete: "settingsAi.thisMac.reason.probe_incomplete"
};

export const recommendationWhyKeys: Record<AiPresetId, MessageKey> = {
  local: "settingsAi.thisMac.why.local",
  hybrid: "settingsAi.thisMac.why.hybrid",
  cloud: "settingsAi.thisMac.why.cloud"
};

/** A size in the interface language: 640 MB, 1.2 GB, 21 GB. */
export function formatSize(locale: string, bytes: number): string {
  const gigabyte = 1024 ** 3;
  const [value, unit] =
    bytes >= gigabyte ? [bytes / gigabyte, "gigabyte"] : [bytes / 1024 ** 2, "megabyte"];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: value >= 10 ? 0 : 1
  }).format(value);
}

/**
 * An amount in US dollars in the interface language ("US$ 12,00", "$12.00"). Whole amounts from ten up
 * drop the cents; a price keeps the digits it has (up to four), so a finer one is not rounded away.
 */
export function formatUsd(locale: string, usd: number): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: usd >= 10 && Number.isInteger(usd) ? 0 : 2,
    maximumFractionDigits: 4
  }).format(usd);
}

/** What was spent: cents, and four digits below one cent so a small total is not read as nothing. */
export function formatSpend(locale: string, usd: number): string {
  const digits = usd > 0 && usd < 0.01 ? 4 : 2;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(usd);
}

/** The kind of machine, then the figures the card lists (only those the probe found). */
export function macFacts(t: Translator, result: HardwareProfileResult): MacFacts {
  const { profile } = result;
  const kind: MacKind =
    profile.platform === "darwin"
      ? profile.nativeArch === "arm64"
        ? "silicon"
        : "intel"
      : profile.platform === "win32"
        ? "windows"
        : "other";
  const facts: MacFacts["facts"] = [
    {
      label:
        kind === "silicon"
          ? "settingsAi.thisMac.fact.memoryUnified"
          : "settingsAi.thisMac.fact.memory",
      value: formatSize(t.locale, profile.memoryBytes)
    }
  ];
  if (profile.workingSet)
    facts.push({
      label: "settingsAi.thisMac.fact.gpuMemory",
      value: formatSize(t.locale, profile.workingSet.bytes)
    });
  else if (profile.gpu.kind === "discrete" && profile.gpu.vramBytes)
    facts.push({
      label: "settingsAi.thisMac.fact.graphicsMemory",
      value: formatSize(t.locale, profile.gpu.vramBytes)
    });
  if (result.freeDiskBytes !== null)
    facts.push({
      label: "settingsAi.thisMac.fact.disk",
      value: formatSize(t.locale, result.freeDiskBytes)
    });
  facts.push({
    label: "settingsAi.thisMac.fact.detected",
    value: detectedLabel(t, profile.probedAt)
  });
  return { kind, chip: profile.cpu.brand, facts };
}

/** "today, 08:40" when the probe ran today, else the date and the time. */
export function detectedLabel(t: Translator, iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = new Intl.DateTimeFormat(t.locale, { hour: "2-digit", minute: "2-digit" }).format(at);
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) return t("settingsAi.thisMac.detectedToday", { values: { time } });
  const date = new Intl.DateTimeFormat(t.locale, { day: "numeric", month: "short" }).format(at);
  return t("settingsAi.thisMac.detectedOn", { values: { date, time } });
}

/** The reasons worth saying, in the order the tier table gives them, without the one the card shows as a card note. */
export function visibleReasons(result: HardwareProfileResult): HardwareReason[] {
  return result.recommendation.reasons;
}

// ---------------------------------------------------------------------------
// Providers

export type ProviderKind = "openai-codex" | "openai-compatible" | "google";

export const providerKinds: readonly ProviderKind[] = [
  "openai-codex",
  "openai-compatible",
  "google"
];

/** The registry id of a provider's credential row: `ai.provider.<kind>`. */
export const providerEntryId = (kind: ProviderKind): string => `ai.provider.${kind}`;

export function providerOfEntryId(id: string): ProviderKind | null {
  return providerKinds.find((kind) => providerEntryId(kind) === id) ?? null;
}

export type ProviderState = "connected" | "keySaved" | "none" | "notConnected";

export const providerStateKeys: Record<ProviderState, MessageKey> = {
  connected: "settingsAi.providers.status.connected",
  keySaved: "settingsAi.providers.status.keySaved",
  none: "settingsAi.providers.status.none",
  notConnected: "settingsAi.providers.status.notConnected"
};

/** The configurations of one provider kind and what is known of its credential. */
export function providerView(
  kind: ProviderKind,
  configs: readonly AiProviderConfig[]
): { configs: AiProviderConfig[]; state: ProviderState } {
  const own = configs.filter((config) => config.provider === kind);
  if (kind === "openai-codex")
    return { configs: own, state: own.length > 0 ? "connected" : "notConnected" };
  return {
    configs: own,
    state: own.some((config) => config.secretConfigured) ? "keySaved" : "none"
  };
}

export type ModelPurpose = "generation" | "embedding" | "reranking";

/** What a configured model is for: its first capability that names a job. */
export function purposeOf(capabilities: readonly string[]): ModelPurpose {
  if (capabilities.includes("embedding")) return "embedding";
  if (capabilities.includes("reranking") && !capabilities.includes("text-generation"))
    return "reranking";
  return "generation";
}

export const purposeKeys: Record<ModelPurpose, MessageKey> = {
  generation: "settingsAi.providers.purpose.generation",
  embedding: "settingsAi.providers.purpose.embedding",
  reranking: "settingsAi.providers.purpose.reranking"
};

/** The capabilities a model added for a purpose gets (a ChatGPT sign-in needs no API key). */
export function purposeCapabilities(purpose: ModelPurpose, kind: ProviderKind): AiCapability[] {
  const base: Record<ModelPurpose, AiCapability[]> = {
    generation: [
      "text-generation",
      "structured-output",
      "summarization",
      "knowledge-graph-generation",
      "atomic-note-generation",
      "requires-network",
      "requires-api-key"
    ],
    embedding: ["embedding", "requires-network", "requires-api-key"],
    reranking: ["reranking", "requires-network", "requires-api-key"]
  };
  return base[purpose].filter(
    (capability) => kind !== "openai-codex" || capability !== "requires-api-key"
  );
}

// ---------------------------------------------------------------------------
// Local models

export type LocalModelPurpose = "generation" | "embedding" | "ranking";
export type ModelFilter = "all" | LocalModelPurpose;

/**
 * A dedicated ranker generates nothing and embeds nothing. It declares `reranking` only once it is
 * validated for decide, so a ranker waiting for its validation is recognized by having no purpose.
 */
export function isRankerModel(model: Pick<LocalModelView, "capabilities">): boolean {
  return (
    !model.capabilities.includes("text-generation") && !model.capabilities.includes("embedding")
  );
}

export function localModelPurposes(
  model: Pick<LocalModelView, "capabilities">
): LocalModelPurpose[] {
  return [
    ...(model.capabilities.includes("text-generation") ? (["generation"] as const) : []),
    ...(model.capabilities.includes("embedding") ? (["embedding"] as const) : []),
    ...(isRankerModel(model) ? (["ranking"] as const) : [])
  ];
}

/**
 * What a ranker's row says besides its progress and error: while it installs, and when it failed,
 * what topic placement does without it; once installed, that it still needs its validation.
 */
export function rankerNoteKey(
  model: Pick<LocalModelView, "capabilities" | "status">
): MessageKey | null {
  if (model.status === "downloading" || model.status === "verifying")
    return "settingsAi.models.ranker.installing";
  if (model.status === "failed") return "settingsAi.models.ranker.fallback";
  if (model.status === "ready" && !model.capabilities.includes("reranking"))
    return "settingsAi.models.ranker.pending";
  return null;
}

export const modelStatusKeys: Record<LocalModelView["status"], MessageKey> = {
  not_downloaded: "settingsAi.models.status.not_downloaded",
  downloading: "settingsAi.models.status.downloading",
  verifying: "settingsAi.models.status.verifying",
  ready: "settingsAi.models.status.ready",
  failed: "settingsAi.models.status.failed",
  removing: "settingsAi.models.status.removing"
};

export const modelCompatibilityKeys: Record<LocalModelView["compatibilityReason"], MessageKey> = {
  compatible: "settingsAi.models.compat.compatible",
  unsupported_platform: "settingsAi.models.compat.unsupported_platform",
  insufficient_memory: "settingsAi.models.compat.insufficient_memory"
};

export function installedModels(models: readonly LocalModelView[]): LocalModelView[] {
  return models.filter((model) => model.status === "ready");
}

export function modelsSummary(t: Translator, models: readonly LocalModelView[]): string {
  const installed = installedModels(models);
  if (installed.length === 0) return t("settingsAi.models.summaryNone");
  const bytes = installed.reduce(
    (sum, model) => sum + (model.installedSizeBytes || model.expectedSizeBytes),
    0
  );
  return t(
    installed.length === 1 ? "settingsAi.models.summaryOne" : "settingsAi.models.summaryMany",
    { values: { count: installed.length, size: formatSize(t.locale, bytes) } }
  );
}

/** Installed first, then what is being installed, then the rest; by name inside each. */
export function sortModels(models: readonly LocalModelView[]): LocalModelView[] {
  const rank = (model: LocalModelView) =>
    model.status === "ready"
      ? 0
      : model.status === "downloading" || model.status === "verifying"
        ? 1
        : model.status === "failed"
          ? 2
          : 3;
  return [...models].sort(
    (a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName)
  );
}

export function filterModels(
  models: readonly LocalModelView[],
  filter: ModelFilter,
  compatibleOnly: boolean
): LocalModelView[] {
  return models.filter(
    (model) =>
      (filter === "all" || localModelPurposes(model).includes(filter)) &&
      (!compatibleOnly || model.compatible || model.status === "ready")
  );
}

/** Whole minutes (or seconds under a minute) left of a download. */
export function etaText(t: Translator, etaSeconds: number | null): string | null {
  if (etaSeconds === null) return null;
  if (etaSeconds < 60)
    return t("settingsAi.models.eta.seconds", { values: { seconds: etaSeconds } });
  return t("settingsAi.models.eta.minutes", { values: { minutes: Math.ceil(etaSeconds / 60) } });
}

// ---------------------------------------------------------------------------
// Profiles

export const profilesSummary = (t: Translator, count: number): string =>
  count === 0
    ? t("settingsAi.profiles.summaryNone")
    : t(count === 1 ? "settingsAi.profiles.summaryOne" : "settingsAi.profiles.summaryMany", {
        values: { count }
      });

// ---------------------------------------------------------------------------
// OpenAI Decisions

export const decisionsReasonKeys: Record<DecisionsFallbackReason, MessageKey> = {
  no_key: "settingsAi.decisions.reason.no_key",
  invalid_key: "settingsAi.decisions.reason.invalid_key",
  spend_cap: "settingsAi.decisions.reason.spend_cap",
  quota: "settingsAi.decisions.reason.quota",
  breaker_open: "settingsAi.decisions.reason.breaker_open",
  network: "settingsAi.decisions.reason.network",
  error: "settingsAi.decisions.reason.error"
};

export type DecisionsTone = "ok" | "idle" | "warn" | "blocked";

/** What the opt-in says of itself, in one line, and the glyph that goes with it. */
export function decisionsLine(
  t: Translator,
  status: AiDecisionsStatus
): { tone: DecisionsTone; text: string } {
  if (status.state === "unavailable_preset")
    return { tone: "blocked", text: t("settingsAi.decisions.unavailable") };
  if (status.state === "off") return { tone: "idle", text: t("settingsAi.decisions.off") };
  const reason = status.fallbackReason ? t(decisionsReasonKeys[status.fallbackReason]) : "";
  if (status.state === "fallback")
    return { tone: "warn", text: t("settingsAi.decisions.fallback", { values: { reason } }) };
  return {
    tone: status.fallbackReason ? "warn" : "ok",
    text: status.fallbackReason
      ? `${t("settingsAi.decisions.ready")} ${t("settingsAi.decisions.lastFallback", { values: { reason } })}`
      : t("settingsAi.decisions.ready")
  };
}

/** The switch can be turned on: the setup sends text out, and no action is running. */
export const decisionsCanTurnOn = (status: AiDecisionsStatus): boolean => status.presetAllowed;

export type { AiClassId };
