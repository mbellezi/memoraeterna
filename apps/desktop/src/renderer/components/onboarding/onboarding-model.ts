// What the first-run onboarding shows and decides, as pure functions (F4 D31, spec 3.11): the tier
// card's options from the hardware profile and the model list, which catalog models a setup
// installs, how a model's download reads, and the message keys of every localized part. The
// controller holds the state; nothing here touches the preload.
import { presetCatalogIds, type AiPresetId } from "@app/domain";
import { messages, type InterpolationValues, type MessageKey } from "@app/i18n";

import type { AiClassRouteTarget, LocalModelView } from "../../../shared/ipc";
import { firstRunClassTests } from "../../../shared/first-run-sequence";
import {
  localRefusal,
  runsMlx,
  type LocalRefusal,
  type OnboardingHardware
} from "../../../shared/onboarding";

export { firstRunClassTests };

/** A line of copy as the controller states it: a key and its parameters, translated by the view. */
export interface OnboardingMessage {
  key: MessageKey;
  values?: InterpolationValues;
}

/** A read that is in flight, failed, or answered. */
export type Load<T> = { status: "loading" } | { status: "error" } | { status: "ready"; value: T };

/** Whether the catalog has a message under this key (a leaf of the English messages). */
export function isMessageKey(value: string): value is MessageKey {
  let node: unknown = messages.en;
  for (const part of value.split(".")) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, part)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string";
}

/**
 * The failure a handler reported as `new Error("errors.…")`, when the catalog has that message;
 * otherwise `fallback`. Raw error text never reaches the screen.
 */
export function errorMessageKey(error: unknown, fallback: MessageKey): MessageKey {
  const found = (error instanceof Error ? error.message : String(error)).match(
    /errors\.[A-Za-z0-9_.-]+/u
  )?.[0];
  return found !== undefined && isMessageKey(found) ? found : fallback;
}

// --- Models the setups install ---------------------------------------------------------------

/** The ranker the first-run ranker installs on its own (decision 19): MLX where it runs. */
export function rankerCatalogId(hardware: Pick<OnboardingHardware, "platform" | "nativeArch">) {
  return runsMlx(hardware) ? presetCatalogIds.rankerMlx : presetCatalogIds.rankerGguf;
}

/**
 * The catalog models a setup needs installed before it can be applied: the embedder always (Cloud
 * falls back to it), and for Local the writer the tier table names. The ranker is not among them:
 * it installs on its own once the embedding route exists and never blocks (decision 19). Without a
 * reading of this computer no writer is guessed: the main process names the one it applies
 * (`model_missing`), and the controller installs that, so a model nobody needs is never fetched.
 */
export function modelsToInstall(
  preset: AiPresetId,
  hardware: Pick<OnboardingHardware, "local"> | null
): string[] {
  const writer = preset === "local" ? (hardware?.local.writerCatalogId ?? null) : null;
  return writer ? [presetCatalogIds.embedding, writer] : [presetCatalogIds.embedding];
}

export type ModelRole = "embedder" | "ranker" | "writer";

/** Which part of the setup a catalog model is; models the onboarding does not install have none. */
export function modelRole(catalogId: string): ModelRole | null {
  if (catalogId === presetCatalogIds.embedding) return "embedder";
  if (catalogId === presetCatalogIds.rankerMlx || catalogId === presetCatalogIds.rankerGguf)
    return "ranker";
  if (catalogId === presetCatalogIds.writerLarge || catalogId === presetCatalogIds.writerSmall)
    return "writer";
  return null;
}

export const modelRoleKeys: Record<ModelRole, MessageKey> = {
  embedder: "onboarding.setup.models.embedder",
  ranker: "onboarding.setup.models.ranker",
  writer: "onboarding.setup.models.writer"
};

// --- The tier card ---------------------------------------------------------------------------

export const presetOrder: readonly AiPresetId[] = ["local", "hybrid", "cloud"];

export const presetNameKeys: Record<AiPresetId, MessageKey> = {
  local: "settings.ai.classes.setup.local",
  hybrid: "settings.ai.classes.setup.hybrid",
  cloud: "settings.ai.classes.setup.cloud"
};

export const presetHintKeys: Record<AiPresetId, MessageKey> = {
  local: "settings.ai.classes.setup.localHint",
  hybrid: "settings.ai.classes.setup.hybridHint",
  cloud: "settings.ai.classes.setup.cloudHint"
};

/** What the card says when Local is refused: Apple silicon, or the memory its writer needs. */
export const localRefusalKeys: Record<LocalRefusal, MessageKey> = {
  requires_apple_silicon: "onboarding.mode.unavailable",
  no_local_writer_for_platform: "onboarding.mode.unavailable",
  memory: "onboarding.mode.unavailableMemory"
};

export interface ModeOption {
  preset: AiPresetId;
  /** False when this computer cannot run the setup (Local off Apple silicon, or too small). */
  available: boolean;
  /** Why Local is refused here; null for an available setup. */
  refusal: LocalRefusal | null;
  recommended: boolean;
  /**
   * Bytes the setup still downloads (its models and the ranker that follows), or null when the
   * model list is unknown or lacks one of them.
   */
  downloadBytes: number | null;
  /** The informative monthly estimate in US dollars; null when it is not metered or not known. */
  monthlyUsd: number | null;
  /** Whether the writer is a cloud model (the text of the sources leaves this computer). */
  remoteWriter: boolean;
}

/** The three setups as the tier card offers them. Without the hardware, Hybrid is the safe lead. */
export function modeOptions(
  hardware: OnboardingHardware | null,
  models: readonly LocalModelView[] | null
): ModeOption[] {
  return presetOrder.map((preset) => {
    const refusal = preset === "local" && hardware ? localRefusal(hardware) : null;
    const wanted = hardware
      ? [...modelsToInstall(preset, hardware), rankerCatalogId(hardware)]
      : null;
    let downloadBytes: number | null = null;
    if (wanted && models) {
      const rows = wanted.map((id) => models.find((model) => model.catalogId === id));
      downloadBytes = rows.every((row) => row !== undefined)
        ? rows.reduce((sum, row) => sum + (row!.status === "ready" ? 0 : row!.expectedSizeBytes), 0)
        : null;
    }
    return {
      preset,
      available: refusal === null,
      refusal,
      recommended: hardware ? hardware.recommended === preset : preset === "hybrid",
      downloadBytes,
      monthlyUsd:
        hardware?.estimates.find((estimate) => estimate.preset === preset)?.monthlyUsd ?? null,
      remoteWriter: preset !== "local"
    };
  });
}

/** The setup chosen when the person has not chosen: the tier table's pick, else the first available. */
export function defaultPreset(options: readonly ModeOption[]): AiPresetId {
  return (
    options.find((option) => option.recommended && option.available) ??
    options.find((option) => option.available) ??
    options[0]!
  ).preset;
}

// --- Downloads, tests -------------------------------------------------------------------------

export interface DownloadView {
  catalogId: string;
  role: ModelRole;
  state: "waiting" | "downloading" | "verifying" | "ready" | "failed";
  downloadedBytes: number;
  totalBytes: number;
  etaSeconds: number | null;
  /** A message key set when the install failed. */
  error: MessageKey | null;
}

/** A share between 0 and 1, or null while the size is not known. */
export function downloadShare(download: Pick<DownloadView, "downloadedBytes" | "totalBytes">) {
  return download.totalBytes > 0
    ? Math.min(1, Math.max(0, download.downloadedBytes / download.totalBytes))
    : null;
}

export const classTestNameKeys: Record<AiClassRouteTarget, MessageKey> = {
  embed: "settings.ai.classes.classes.embed.name",
  decide: "settings.ai.classes.classes.decide.name",
  "write-fast": "settings.ai.classes.classes.writeFast.name",
  "write-quality": "settings.ai.classes.classes.writeQuality.name",
  answer: "settings.ai.classes.classes.answer.name",
  judge: "settings.ai.classes.judge.title"
};

export type ClassTestState = "waiting" | "running" | "passed" | "failed" | "none";

export interface ClassTestView {
  route: AiClassRouteTarget;
  state: ClassTestState;
  ms: number | null;
  /** The stored reason: a message key or a short redacted text. */
  error: string | null;
}

export const classTestStateKeys: Record<ClassTestState, MessageKey> = {
  waiting: "onboarding.setup.tests.waiting",
  running: "onboarding.setup.tests.running",
  passed: "onboarding.setup.tests.passed",
  failed: "onboarding.setup.tests.failed",
  none: "onboarding.setup.tests.none"
};

/** The fresh list of tests, in the order the sequence runs them. */
export function waitingTests(): ClassTestView[] {
  return firstRunClassTests.map((route) => ({
    route,
    state: "waiting" as const,
    ms: null,
    error: null
  }));
}

/** How many checks need attention after the tests ran. */
export function failedTestCount(tests: readonly ClassTestView[]): number {
  return tests.filter((test) => test.state === "failed").length;
}

// --- Formatting -------------------------------------------------------------------------------

/** A size in the interface language: 640 MB, 1.2 GB. */
export function formatSize(locale: string, bytes: number): string {
  const gigabyte = 1024 ** 3;
  const megabyte = 1024 ** 2;
  const [value, unit] =
    bytes >= gigabyte ? [bytes / gigabyte, "gigabyte"] : [bytes / megabyte, "megabyte"];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: value >= 10 ? 0 : 1
  }).format(value);
}

/** An amount in US dollars, in the interface language. */
export function formatUsd(locale: string, usd: number): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: usd < 10 ? 2 : 0,
    maximumFractionDigits: usd < 10 ? 2 : 0
  }).format(usd);
}

/** Minutes left for a download, rounded up; null when the time is not known. */
export function etaMinutes(etaSeconds: number | null): number | null {
  return etaSeconds === null ? null : Math.max(1, Math.ceil(etaSeconds / 60));
}
