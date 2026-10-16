import {
  findLocalModelCatalogEntry,
  isRankerCatalogEntry,
  localModelSeedDirectories,
  redactSensitiveText,
  resolveLocalModelSeedRoot
} from "@app/ai";

import type {
  AiProfile,
  AiProfileCreate,
  AiProfileUpdate,
  LocalModelView
} from "../../shared/ipc.js";
import type { DecideRouteStatus } from "./ai-service.js";

/**
 * DEV-only local model install at startup (`MEMORA_LOCAL_MODEL_INSTALL=<catalogId>[,<catalogId>...]`,
 * F2 T22c). A measurement profile cloned from the owner's DEV profile has no ranker, so the topic
 * placement gate (`class:decide`) never decides. Installing one normally needs the Settings screen;
 * this knob does the same from the DEV seed folder (`MEMORA_LOCAL_MODEL_SEED_DIR`, the artifacts
 * already fetched into `.cache/models`), without a UI:
 *
 * 1. the model is installed through the normal install path (sizes and SHA-256 checked against the
 *    catalog pins, the ranker's artifact checks, then the decide validation run);
 * 2. the AI profile the Settings flow creates for a local model is created for it, so the existing
 *    seeding of `class:decide` routes it.
 *
 * Idempotent: a model that is installed and validated, and already held by a profile, is left alone.
 * It never calls a remote provider and never reaches the network: it is refused when packaged or
 * without the seed folder, and a model whose pinned files the seed lacks is not installed. One log
 * line per model states the outcome. It runs at startup once the local models are started; the
 * golden run and the pilots wait for it, and its validation goes through the AI queue like any
 * local call.
 */

export const localModelInstallKnob = "MEMORA_LOCAL_MODEL_INSTALL";

export type LocalModelInstallRefusalCode = "packaged" | "noSeedFolder" | "invalidValue";

export class LocalModelInstallRefusal extends Error {
  public constructor(
    public readonly code: LocalModelInstallRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "LocalModelInstallRefusal";
  }
}

const catalogIdShape = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * Reads the knob: the catalog ids it names (trimmed, without duplicates, in order), or none when it
 * is unset. Refused when packaged, when the seed folder is not set (the seed supplies the files,
 * nothing is downloaded), or when the value holds no id or an id of the wrong shape. Whether an id
 * is a catalog entry that can be seeded is decided per model, and logged.
 */
export function readLocalModelInstallKnob(
  env: Readonly<Record<string, string | undefined>>,
  options: { isPackaged: boolean; baseDirectory: string }
): string[] {
  const raw = env[localModelInstallKnob]?.trim();
  if (!raw) return [];
  if (options.isPackaged)
    throw new LocalModelInstallRefusal(
      "packaged",
      `${localModelInstallKnob} is refused in packaged builds`
    );
  if (!resolveLocalModelSeedRoot(env, options))
    throw new LocalModelInstallRefusal(
      "noSeedFolder",
      `${localModelInstallKnob} needs MEMORA_LOCAL_MODEL_SEED_DIR: the seed folder supplies the files`
    );
  const ids = [
    ...new Set(
      raw
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    )
  ];
  if (ids.length === 0 || ids.some((id) => !catalogIdShape.test(id)))
    throw new LocalModelInstallRefusal(
      "invalidValue",
      `${localModelInstallKnob} must be a comma separated list of catalog ids`
    );
  return ids;
}

export type LocalModelInstallState = "ready" | "refused" | "failed";

export interface LocalModelInstallOutcome {
  catalogId: string;
  state: LocalModelInstallState;
  /** What the log line says after the catalog id. */
  message: string;
}

/** The local model service operations the knob uses (see `LocalModelService`). */
export interface LocalModelInstallModels {
  list(): Promise<LocalModelView[]>;
  installFromSeed(catalogId: string): Promise<LocalModelView>;
  test(catalogId: string): Promise<string>;
}

/** The AI service operations the knob uses: the ones the Settings profile flow calls. */
export interface LocalModelInstallAi {
  listProfiles(): Promise<AiProfile[]>;
  createProfile(input: AiProfileCreate): Promise<AiProfile>;
  updateProfile(input: AiProfileUpdate): Promise<AiProfile>;
  decideRouteStatus(operation?: string): Promise<DecideRouteStatus>;
}

export interface LocalModelInstallStartupOptions {
  env: Readonly<Record<string, string | undefined>>;
  isPackaged: boolean;
  workspaceRoot: string;
  models: LocalModelInstallModels;
  ai: LocalModelInstallAi;
  logger: Pick<Console, "info" | "warn">;
}

/**
 * Runs at startup. Never throws: a refusal or a failure is logged and startup continues, so a
 * mistyped knob cannot keep the app from starting. Returns the outcome of each model.
 */
export async function runLocalModelInstallStartup(
  options: LocalModelInstallStartupOptions
): Promise<LocalModelInstallOutcome[]> {
  let catalogIds: string[];
  try {
    catalogIds = readLocalModelInstallKnob(options.env, {
      isPackaged: options.isPackaged,
      baseDirectory: options.workspaceRoot
    });
  } catch (error) {
    options.logger.warn(`MODEL_INSTALL refused: ${describeError(error)}`);
    return [];
  }
  const outcomes: LocalModelInstallOutcome[] = [];
  for (const catalogId of catalogIds) {
    let outcome: LocalModelInstallOutcome;
    try {
      outcome = await ensureModel(catalogId, options);
    } catch (error) {
      outcome = { catalogId, state: "failed", message: describeError(error) };
    }
    if (outcome.state === "ready")
      options.logger.info(`MODEL_INSTALL ${catalogId}: ${outcome.message}`);
    else options.logger.warn(`MODEL_INSTALL ${catalogId}: ${outcome.state}: ${outcome.message}`);
    outcomes.push(outcome);
  }
  return outcomes;
}

async function ensureModel(
  catalogId: string,
  options: LocalModelInstallStartupOptions
): Promise<LocalModelInstallOutcome> {
  const { models, ai } = options;
  const entry = findLocalModelCatalogEntry(catalogId);
  if (!entry) return refused(catalogId, "unknown catalog id");
  if (!localModelSeedDirectories[catalogId])
    return refused(
      catalogId,
      `has no seed folder (seedable: ${Object.keys(localModelSeedDirectories).join(", ")})`
    );
  const find = async () => (await models.list()).find((view) => view.catalogId === catalogId);
  let view = await find();
  if (!view) return failed(catalogId, "is not in the model list");
  // What this start did or found, in order; `changed` is false when it only found things in place.
  const steps: string[] = [];
  let changed = false;
  // A ranker serves `decide` only once validated; the model then exposes `reranking`.
  const validated = (candidate: LocalModelView) =>
    !isRankerCatalogEntry(entry) || candidate.capabilities.includes("reranking");

  if (view.status !== "ready") {
    // The normal install path, with the seed folder as the source; a ranker is validated by it.
    let installed: LocalModelView;
    try {
      installed = await models.installFromSeed(catalogId);
    } catch (error) {
      return failed(catalogId, `install refused: ${describeError(error)}`);
    }
    if (installed.status !== "ready")
      return failed(catalogId, `install failed: ${installed.lastError ?? installed.status}`);
    steps.push("installed from the seed folder");
    changed = true;
    view = (await find()) ?? installed;
  } else {
    steps.push("already installed");
    if (!validated(view)) {
      // Installed earlier but never validated (or its validation was voided): the Settings test.
      try {
        await models.test(catalogId);
      } catch (error) {
        return failed(catalogId, `validation failed: ${describeError(error)}`);
      }
      changed = true;
      view = (await find()) ?? view;
    }
  }
  if (!validated(view))
    return failed(
      catalogId,
      `${steps[0]}, not validated for decide${view.lastError ? `: ${view.lastError}` : ""}`
    );
  if (isRankerCatalogEntry(entry)) steps.push("validated for decide");

  const profiles = await ai.listProfiles();
  const held = profiles.find(
    (profile) => profile.localModelId === view.id && profile.status === "active"
  );
  if (held) {
    steps.push(`profile "${held.name}" exists`);
  } else {
    const name = profileNameFor(view);
    // A profile an earlier start created but could not finish holds no model yet.
    const unfinished = profiles.find(
      (profile) =>
        profile.name === name &&
        !profile.modelId &&
        !profile.localModelId &&
        !profile.providerConfigId
    );
    // What the Settings screen does for a local model: the first profile becomes the default one.
    const profile =
      unfinished ??
      (await ai.createProfile({
        name,
        isDefault: profiles.length === 0,
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
    steps.push(`profile "${name}" created`);
    changed = true;
  }
  if (isRankerCatalogEntry(entry)) steps.push(`class:decide ${await decideStatus(ai)}`);
  return {
    catalogId,
    state: "ready",
    message: `${changed ? "" : "left alone: "}${steps.join(", ")}`
  };
}

/** The name the profile of a local model gets: its display name and runtime. */
function profileNameFor(view: Pick<LocalModelView, "displayName" | "runtime">): string {
  return `${view.displayName} (${view.runtime.toUpperCase()})`;
}

async function decideStatus(ai: LocalModelInstallAi): Promise<string> {
  try {
    return await ai.decideRouteStatus();
  } catch (error) {
    return `unknown (${describeError(error)})`;
  }
}

function refused(catalogId: string, message: string): LocalModelInstallOutcome {
  return { catalogId, state: "refused", message };
}

function failed(catalogId: string, message: string): LocalModelInstallOutcome {
  return { catalogId, state: "failed", message };
}

/** A one-line reason; secrets and connection strings are redacted. */
function describeError(error: unknown): string {
  return redactSensitiveText(error)
    .replace(/postgres(?:ql)?:\/\/\S+/giu, "[redacted]")
    .replace(/\s+/gu, " ")
    .slice(0, 400);
}
