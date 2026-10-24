// The two models of the first run in Hybrid (F4 T90): which ones this machine installs, where their
// files come from, and the local model service the run is wired with.
//
//   download   the live record: the pinned files come from Hugging Face into the scratch profile, as
//              a clean install downloads them (Q5).
//   seed       the replay: the pinned files come from the DEV seed folder (`MEMORA_LOCAL_MODEL_SEED_DIR`),
//              through the normal install path with its size and SHA-256 checks and, for the ranker,
//              the artifact checks and the decide validation; the network is closed.
//   synthetic  the harness's own self-test: no file moves, the install is simulated in time.
import { constants } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  assertLocalModelSeeded,
  createDecideValidation,
  findLocalModelCatalogEntry,
  LocalModelSeedError,
  qwen3RerankerPrompt,
  rankerCatalogArtifactSha256,
  resolveManagedModelPath,
  runRankerSmoke,
  sha256File,
  localModelSeedDirectories
} from "@app/ai";
import type { RankRequest, RankResult } from "@app/ai";
import { createLocalModelRepository } from "@app/db";
import { machineRunsMlx } from "@app/domain";

import type { ModelDownloadEvent } from "../../../shared/app-events.js";
import type { LocalModelDownloadInput, LocalModelView } from "../../../shared/ipc.js";
import { LocalModelService } from "../local-model-service.js";
import type { LocalModelServiceOptions } from "../local-model-service.js";
import { UsageError, firstRunModels } from "./config.js";

export type ModelsMode = "download" | "seed" | "synthetic";

export interface FirstRunModelPlan {
  embedding: string;
  ranker: string;
  rankerRuntime: "mlx" | "gguf";
}

/** The models a clean install of this machine gets: MLX first where MLX runs (decision 12). */
export function firstRunModelPlan(
  machine: { platform: string; arch: string } = { platform: process.platform, arch: process.arch }
): FirstRunModelPlan {
  const mlx = machineRunsMlx(machine);
  return {
    embedding: firstRunModels.embedding,
    ranker: mlx ? firstRunModels.rankerMlx : firstRunModels.rankerGguf,
    rankerRuntime: mlx ? "mlx" : "gguf"
  };
}

/** The pinned size of a catalog entry, in bytes. */
export function pinnedBytes(catalogId: string): number {
  const entry = findLocalModelCatalogEntry(catalogId);
  if (!entry) throw new Error(`The local model catalog has no entry ${catalogId}`);
  return entry.files.reduce((total, file) => total + file.sizeBytes, 0);
}

/** What `copyModelsToSeed` did with one model. */
export interface SeedBackOutcome {
  catalogId: string;
  /** Files copied into the seed folder. */
  copied: string[];
  /** Files the seed folder already held at the declared size. */
  present: string[];
}

/**
 * After a live recording: copies the models it downloaded into the seed folder, so the replays can
 * install them with the real checks (the scratch profile is deleted, Q5). Only files the download
 * verified (the pinned size is checked again here) and the seed does not hold yet are copied, as a
 * copy-on-write clone where the volume has one; nothing already in the seed is replaced. A model
 * with no seed folder is skipped.
 */
export async function copyModelsToSeed(
  plan: FirstRunModelPlan,
  userDataPath: string,
  seedDir: string,
  lookup: typeof findLocalModelCatalogEntry = findLocalModelCatalogEntry
): Promise<SeedBackOutcome[]> {
  const outcomes: SeedBackOutcome[] = [];
  for (const catalogId of [plan.embedding, plan.ranker]) {
    const entry = lookup(catalogId);
    const folder = localModelSeedDirectories[catalogId];
    if (!entry || !folder) continue;
    const outcome: SeedBackOutcome = { catalogId, copied: [], present: [] };
    const from = join(userDataPath, "local-models", catalogId);
    const to = join(seedDir, folder);
    for (const file of entry.files) {
      const source = resolveManagedModelPath(from, file.path);
      const target = resolveManagedModelPath(to, file.path);
      const sizeOf = async (path: string) => (await stat(path).catch(() => null))?.size ?? null;
      if ((await sizeOf(source)) !== file.sizeBytes)
        throw new Error(`${catalogId}/${file.path} was not downloaded at its pinned size`);
      if ((await sizeOf(target)) === file.sizeBytes) {
        outcome.present.push(file.path);
        continue;
      }
      await mkdir(join(target, ".."), { recursive: true });
      const partial = `${target}.partial`;
      await rm(partial, { force: true });
      await copyFile(source, partial, constants.COPYFILE_FICLONE);
      await rename(partial, target);
      outcome.copied.push(file.path);
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * A replay installs from the seed folder and never from the network: before anything is created,
 * the folder must hold every pinned file of both models at its declared size (the install itself
 * verifies the bytes). The message says where the files go.
 */
export async function assertModelsSeeded(
  plan: FirstRunModelPlan,
  seedDir: string,
  check: (
    entry: NonNullable<ReturnType<typeof findLocalModelCatalogEntry>>,
    seedRoot: string
  ) => Promise<void> = assertLocalModelSeeded
): Promise<void> {
  for (const catalogId of [plan.embedding, plan.ranker]) {
    const entry = findLocalModelCatalogEntry(catalogId);
    if (!entry) throw new UsageError(`The local model catalog has no entry ${catalogId}`);
    try {
      await check(entry, seedDir);
    } catch (error) {
      if (!(error instanceof LocalModelSeedError)) throw error;
      const folder = localModelSeedDirectories[catalogId];
      throw new UsageError(
        `The seed folder ${seedDir} cannot install ${catalogId}: ${error.message}. ` +
          `Put its pinned files under ${join(seedDir, folder ?? "<seed folder>")} ` +
          "(the live record's scratch profile keeps them under local-models/<catalog id>), " +
          "or pass --seed-dir / set MEMORA_LOCAL_MODEL_SEED_DIR"
      );
    }
  }
}

/** A `fetch` that fails: a replay has no network, and a model the seed lacks must not be downloaded. */
export const offlineFetch: typeof fetch = async () => {
  throw new Error("The network is closed in a replay of the first run (seeded models only).");
};

export interface FirstRunModelsOptions extends LocalModelServiceOptions {
  mode: ModelsMode;
  repositoryRoot: string;
  /** Seed mode: the folder of the seeded models. */
  seedDir: string | null;
  /** Synthetic mode: where the placeholder files go, and how long an install takes. */
  synthetic?: { modelsDirectory: string; installDelayMs: number; helperPath: string };
}

/** The local model service of the run: the real one (downloading, or installing from the seed), or the stand-in. */
export function createFirstRunModels(options: FirstRunModelsOptions): LocalModelService {
  const { mode, repositoryRoot, seedDir, synthetic, ...service } = options;
  if (mode === "synthetic") {
    if (!synthetic) throw new Error("The synthetic models need their directory");
    return new SyntheticLocalModelService(service, synthetic);
  }
  if (mode === "seed") {
    if (!seedDir) throw new UsageError("A replay needs the seed folder of the models");
    return new LocalModelService({
      ...service,
      isPackaged: false,
      workspaceRoot: repositoryRoot,
      env: { MEMORA_LOCAL_MODEL_SEED_DIR: seedDir },
      fetch: offlineFetch
    });
  }
  return new LocalModelService({
    ...service,
    isPackaged: false,
    workspaceRoot: repositoryRoot,
    env: {}
  });
}

/** The smoke test's scores as a ranker that works would give them (the model card's own values). */
async function passingRank(request: RankRequest): Promise<RankResult> {
  const card =
    request.instruction === qwen3RerankerPrompt.defaultInstruction &&
    request.query.startsWith("What is the capital");
  const logOdds = request.documents.map((_, index) =>
    card ? [7.625, -11.375][index]! : index === 0 ? 8 : -8
  );
  return {
    logOdds,
    scores: logOdds.map((value) => 1 / (1 + Math.exp(-value))),
    tokenCounts: logOdds.map(() => 100),
    truncated: logOdds.map(() => false)
  };
}

/**
 * The stand-in for the install of the harness's self-test: a request marks the model downloading,
 * a moment later it is ready with a placeholder file, and a ranker carries the validation a passing
 * model test leaves. It announces the same `model.download` events and settles the same way as the
 * real service, so everything above it (the first-run ranker, the events, the blockers) runs as
 * in a real install. No file of the model exists and none is read.
 */
export class SyntheticLocalModelService extends LocalModelService {
  private readonly installs = new Map<string, Promise<void>>();
  private readonly stand: NonNullable<FirstRunModelsOptions["synthetic"]>;
  private readonly service: LocalModelServiceOptions;

  public constructor(
    service: LocalModelServiceOptions,
    stand: NonNullable<FirstRunModelsOptions["synthetic"]>
  ) {
    super(service);
    this.service = service;
    this.stand = stand;
  }

  public override async requestDownload(input: LocalModelDownloadInput): Promise<LocalModelView> {
    const current = (await this.list()).find((view) => view.catalogId === input.catalogId);
    if (!current) throw new Error("errors.localModels.notFound");
    if (current.status === "ready" || this.installs.has(current.catalogId)) return current;
    const pool = this.service.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    await createLocalModelRepository(pool).updateModel(current.id, {
      status: "downloading",
      lastError: null
    });
    this.publishInstall(current, "downloading", 0);
    this.installs.set(
      current.catalogId,
      this.finish(current).catch((error: unknown) => {
        this.service.logger?.error(error instanceof Error ? error.message : String(error));
      })
    );
    return { ...current, status: "downloading" };
  }

  public override async shutdown(): Promise<void> {
    await Promise.all(this.installs.values());
    await super.shutdown();
  }

  private async finish(view: LocalModelView): Promise<void> {
    const pool = this.service.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    const half = Math.max(1, Math.round(this.stand.installDelayMs / 2));
    const total = pinnedBytes(view.catalogId);
    await new Promise<void>((done) => setTimeout(done, half));
    this.publishInstall(view, "downloading", Math.round(total / 2));
    await new Promise<void>((done) => setTimeout(done, half));
    await mkdir(this.stand.modelsDirectory, { recursive: true });
    const managedPath = join(this.stand.modelsDirectory, `${view.catalogId}.placeholder`);
    await writeFile(managedPath, "");
    const repository = createLocalModelRepository(pool);
    const record = await repository.findById(view.id);
    const entry = findLocalModelCatalogEntry(view.catalogId);
    const ranker = entry?.capabilities.includes("reranking") === true;
    const metadata =
      ranker && entry
        ? {
            ...(record?.metadata ?? {}),
            decideValidation: createDecideValidation(
              {
                runtime: entry.runtime === "mlx" ? "mlx" : "gguf",
                revision: entry.revision,
                artifactSha256: rankerCatalogArtifactSha256(entry),
                runtimeBuild: `memora-mlx-helper@sha256:${await sha256File(this.stand.helperPath)}`
              },
              await runRankerSmoke(passingRank)
            )
          }
        : undefined;
    await repository.updateModel(view.id, {
      status: "ready",
      managedPath,
      installedSizeBytes: total,
      lastError: null,
      ...(metadata ? { metadata } : {})
    });
    this.publishInstall(view, "ready", total);
    this.service.onModelSettled?.(view.catalogId);
  }

  private publishInstall(
    view: LocalModelView,
    status: ModelDownloadEvent["status"],
    bytes: number
  ): void {
    const total = pinnedBytes(view.catalogId);
    this.service.onDownload?.({
      type: "model.download",
      localModelId: view.id,
      catalogId: view.catalogId,
      status,
      currentFile: null,
      downloadedBytes: Math.min(bytes, total),
      totalBytes: total,
      bytesPerSecond: 0,
      etaSeconds: null,
      error: null
    });
  }
}
