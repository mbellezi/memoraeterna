import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { createAiConfigRepository, createMatchingEvaluationRepository, createKnowledgeGraphRepository, type PgPool } from "@app/db";
import { ProcessingPlanRequestSchema } from "@app/domain";
import { manualIngestionInputSchema, containerSourceInputSchema } from "../../shared/ipc.js";
import type { IngestionService } from "./ingestion-service.js";
import type { HierarchicalIngestionService } from "./hierarchical-ingestion-service.js";
import type { SettingsService } from "./settings-service.js";
import type { BackupService } from "./backup-service.js";
import type { JobSupervisor } from "./job-supervisor.js";

const documentSchema = z.object({ key: z.string(), title: z.string(), content: z.string(), ideas: z.array(z.string()) });
const corpusSchema = z.object({
  version: z.literal("matching-pilot-v1"), description: z.string(),
  sources: z.array(z.union([documentSchema, z.object({ key: z.string(), title: z.string(), chapters: z.array(documentSchema) })])).length(12),
  expectedRootPairs: z.array(z.tuple([z.string(), z.string()])), forbiddenRootPairs: z.array(z.tuple([z.string(), z.string()])),
  zeroNoteSources: z.array(z.string()), identityChecks: z.array(z.unknown()), evaluationNotes: z.string()
}).strict();
const manifestSchema = z.object({
  version: z.literal("matching-pilot-v1"), startedAt: z.string(), ids: z.record(z.string(), z.string().uuid()),
  baselineBatchId: z.string().uuid().optional(), roundStartedAt: z.string().datetime().optional(),
  batchId: z.string().uuid().nullable(), originalDebugMode: z.boolean(), originalDebugFullCapture: z.boolean()
});

export function isMatchingPilotComplete(runs: Array<{ status?: unknown; stages_checkpoint?: unknown; job_status?: unknown }>): boolean {
  return runs.length > 0 && runs.every((run) => {
    if (["queued", "running"].includes(String(run.job_status))) return false;
    if (["failed", "canceled"].includes(String(run.status))) return true;
    if (run.status !== "succeeded") return false;
    const checkpoints = z.record(z.string(), z.object({ status: z.string() })).safeParse(run.stages_checkpoint);
    return checkpoints.success && ["atomicNoteMatching", "sourceMatching"].every((key) => {
      const stage = checkpoints.data[key];
      return !stage || ["completed", "skipped", "failed", "canceled"].includes(stage.status);
    });
  });
}

export async function runMatchingPilot(options: {
  mode: string; isPackaged: boolean; userDataPath: string; workspaceRoot: string;
  pool: PgPool; ingestion: IngestionService; hierarchy: HierarchicalIngestionService;
  settings: SettingsService; jobs: JobSupervisor; backup: BackupService;
}) {
  if (options.isPackaged || !["inspect", "prepare", "run", "report", "rematch"].includes(options.mode)) throw new Error("Pilot requires an unpackaged DEV application and an explicit mode");
  const descriptor = JSON.parse(await readFile(join(options.userDataPath, "database/dev-connection.json"), "utf8"));
  if (descriptor.developmentOnly !== true || !resolve(options.userDataPath).endsWith("/@app/desktop")) throw new Error("Pilot refuses a non-DEV userData directory");
  const repository = createMatchingEvaluationRepository(options.pool);
  const preflight = await repository.preflight();
  console.log("MATCHING_PILOT", JSON.stringify({ event: "preflight", userDataPath: options.userDataPath, ...preflight }));
  if (options.mode === "inspect") return;
  const corpus = corpusSchema.parse(JSON.parse(await readFile(join(options.workspaceRoot, "scripts/fixtures/matching-pilot.json"), "utf8")));
  const outputDirectory = join(options.workspaceRoot, ".cache/matching-pilot");
  await mkdir(outputDirectory, { recursive: true });
  const limitsPath = join(outputDirectory, "limits.json");
  const limitsSchema = z.object({ maxReportedTokens: z.number().int().positive().max(10000000) }).strict();
  try { await readFile(limitsPath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(limitsPath, JSON.stringify({ maxReportedTokens: 600000 }, null, 2));
  }
  const readLimits = async () => limitsSchema.parse(JSON.parse(await readFile(limitsPath, "utf8")));
  const manifestPath = join(outputDirectory, "manifest.json");
  let manifest: z.infer<typeof manifestSchema>;
  try { manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (preflight.sources !== 0 || preflight.notes !== 0 || preflight.source_relations !== 0) throw new Error("Pilot preparation requires an empty DEV library; nothing was deleted");
    const settings = await options.settings.getApp();
    manifest = { version: corpus.version, startedAt: new Date().toISOString(), ids: {}, batchId: null,
      originalDebugMode: settings.debugMode, originalDebugFullCapture: settings.debugFullCapture };
    await writeFile(join(outputDirectory, "settings-before.json"), JSON.stringify(settings, null, 2));
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
  const save = () => writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  if (options.mode === "rematch" && !manifest.baselineBatchId) {
    if (!manifest.batchId) throw new Error("Complete the baseline pilot before rematching");
    const baselineProgress = await repository.progress(manifest.batchId, manifest.startedAt);
    if (!isMatchingPilotComplete(baselineProgress.runs) || baselineProgress.runs.some((run) => run.status !== "succeeded"
      || Object.values(run.stages_checkpoint ?? {}).some((stage) => ["failed", "canceled"].includes(String((stage as {status?:string}).status))))) {
      throw new Error("Finish or recover all baseline stages before rematching");
    }
    const baselineDirectory = join(outputDirectory, "baseline");
    await mkdir(baselineDirectory, { recursive: true });
    const baseline = await repository.snapshot(Object.values(manifest.ids), manifest.startedAt);
    await writeFile(join(baselineDirectory, "results.json"), JSON.stringify({ capturedAt: new Date().toISOString(), ...baseline }, null, 2), { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    for (const file of ["manifest.json", "settings-run.json", "routes.json", "progress.json"]) {
      await copyFile(join(outputDirectory, file), join(baselineDirectory, file), 1).catch((error) => { if (error.code !== "EEXIST") throw error; });
    }
    const backup = await options.backup.create(outputDirectory);
    await writeFile(join(baselineDirectory, "backup.json"), JSON.stringify(backup, null, 2));
    const removed = await repository.resetPilotMatching(Object.values(manifest.ids));
    const graph = createKnowledgeGraphRepository(options.pool);
    await graph.clearProjection();
    for (const id of Object.values(manifest.ids)) await graph.projectSource(id);
    manifest.baselineBatchId = manifest.batchId;
    manifest.batchId = null;
    manifest.roundStartedAt = new Date().toISOString();
    await save();
    console.log("MATCHING_PILOT", JSON.stringify({ event: "rematch_prepared", removed, backup: backup.path }));
  }
  if (options.mode === "prepare" || options.mode === "run" || options.mode === "rematch") {
    const ai = createAiConfigRepository(options.pool);
    const routes = [];
    for (const task of ["embedding", "summarization", "atomic-note-generation", "knowledge-graph-generation", "reranking"]) {
      const route = await ai.getDefaultTask(task);
      if (!route) throw new Error(`Pilot requires a configured ${task} profile`);
      routes.push({ task, profileId: route.profileId, provider: route.provider, model: route.modelId, runtime: route.runtime,
        parameters: route.parameters, modelDefaults: route.modelDefaultParameters, revision: route.revision });
    }
    await writeFile(join(outputDirectory, "routes.json"), JSON.stringify(routes, null, 2));
    // Only source content and ordinary descriptors reach ingestion. Gabarito labels never enter prompts.
    for (const source of corpus.sources) {
      if ("chapters" in source) {
        if (!manifest.ids[source.key]) {
          const root = await options.ingestion.createContainerSource(containerSourceInputSchema.parse({ descriptor: { type: "Book", title: source.title, language: "pt-BR" } }));
          manifest.ids[source.key] = root.sourceItemId; await save();
        }
        for (const child of source.chapters) await importDocument(child, manifest.ids[source.key]);
      } else await importDocument(source);
    }
    console.log("MATCHING_PILOT", JSON.stringify({ event: "prepared", roots: corpus.sources.length, records: Object.keys(manifest.ids).length }));
    if (options.mode === "prepare") return;
    await options.settings.updateApp({ debugMode: true, debugFullCapture: false });
    await writeFile(join(outputDirectory, "settings-run.json"), JSON.stringify(await options.settings.getApp(), null, 2));
    if (!manifest.batchId) {
      const batch = await options.hierarchy.process({ runKind: "initial", plan: ProcessingPlanRequestSchema.parse({
        preset: manifest.baselineBatchId ? "custom" : "full_knowledge", requestedStages: manifest.baselineBatchId ? ["atomicNoteMatching", "sourceMatching"] : [], scope: "source_and_children", targetSourceItemIds: corpus.sources.map((source) => manifest.ids[source.key]!)
      }) });
      manifest.batchId = batch.batchId; await save();
    }
    for (const item of await options.jobs.listWithRuns(1000)) {
      if (item.job.type === "ingestion" && item.job.status === "canceled" && item.ingestionRun?.batchId === manifest.batchId) {
        await options.jobs.retry(item.job.id);
      }
    }
    console.log("MATCHING_PILOT", JSON.stringify({ event: "started", batchId: manifest.batchId, reportedTokenStop: (await readLimits()).maxReportedTokens }));
    let previous = new Map<string, string>();
    for (;;) {
      const progress = await repository.progress(manifest.batchId!, manifest.startedAt);
      await writeFile(join(outputDirectory, "progress.json"), JSON.stringify(progress, null, 2));
      const statuses = progress.runs.map((run) => ({ title: run.title, status: run.status, stage: run.current_stage, error: run.error,
        matching: Object.fromEntries(Object.entries((run.stages_checkpoint ?? {}) as Record<string, { status?: string }>).filter(([key]) => ["atomicNoteMatching", "sourceMatching"].includes(key)).map(([key, value]) => [key, value.status])) }));
      const changes = statuses.filter((run) => previous.get(String(run.title)) !== JSON.stringify(run));
      if (changes.length) console.log("MATCHING_PILOT", JSON.stringify({ event: "progress", changes, usage: progress.usage }));
      previous = new Map(statuses.map((run) => [String(run.title), JSON.stringify(run)]));
      if (isMatchingPilotComplete(progress.runs)) break;
      if (Number(progress.usage.reported_tokens) >= (await readLimits()).maxReportedTokens) {
        await options.jobs.cancelForSources(Object.values(manifest.ids));
        console.log("MATCHING_PILOT", JSON.stringify({ event: "guard_stopped", usage: progress.usage }));
        break;
      }
      await new Promise((done) => setTimeout(done, 5000));
    }
  }
  const snapshot = await repository.snapshot(Object.values(manifest.ids), manifest.roundStartedAt ?? manifest.startedAt);
  await writeFile(join(outputDirectory, "results.json"), JSON.stringify({ version: corpus.version, capturedAt: new Date().toISOString(), ...snapshot }, null, 2));
  console.log("MATCHING_PILOT", JSON.stringify({ event: "report", path: join(outputDirectory, "results.json"), counts: Object.fromEntries(Object.entries(snapshot).map(([key, rows]) => [key, rows.length])) }));
  if (options.mode === "run" || options.mode === "rematch") await options.settings.updateApp({ debugMode: manifest.originalDebugMode, debugFullCapture: manifest.originalDebugFullCapture });

  async function importDocument(document: z.infer<typeof documentSchema>, parentSourceItemId?: string) {
    if (manifest.ids[document.key]) return;
    const result = await options.ingestion.createManual(manualIngestionInputSchema.parse({
      descriptor: { type: parentSourceItemId ? "BookChapter" : "StandaloneArticle", title: document.title, language: "pt-BR", ...(parentSourceItemId ? { parentSourceItemId } : {}) },
      content: document.content, duplicatePolicy: "ignore", processingPlan: { preset: "import_only", requestedStages: [] }
    }));
    manifest.ids[document.key] = result.sourceItemId; await save();
  }
}
