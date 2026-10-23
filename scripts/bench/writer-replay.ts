/**
 * Prompt-replay harness of the record-only local-writer benchmark (F4 T69, plan decisions 25 and 26).
 *
 * It reads the generative calls of a golden cassette (default `golden-small-f2`: summaries, atomic
 * notes, knowledge graph, entity and relation identity, topic names, topic overviews, relation typing
 * when the cassette holds it), puts each call's inputs back, and sends it to a local writer through the
 * product's own adapter. Validation, salvage and repair are the product's: its flows run with a caller
 * that talks to the writer (see `contracts/`). Per item it records the first answer's validity, the
 * repairs, the salvage, tokens per second, time to first text, the helper's memory, the swap used and
 * the yield against the recorded Codex answer; the same flow also runs on the recorded answer alone, so
 * the recording's own record sits beside the writer's. Nothing is adopted: the output is a record.
 *
 *   plan  no inference: counts, what could not be rebuilt, the recording's own first-pass record, and
 *         the hours each arm is projected to take at assumed rates
 *   run   replays one arm; holds the machine-wide local-model lock for the whole run; resumable
 *
 * Examples (the orchestrator's; see the T69 report):
 *   npx tsx scripts/bench/writer-replay.ts plan --data-root <checkout>/.cache
 *   npx tsx scripts/bench/writer-replay.ts run --arm m9b4 --data-root <checkout>/.cache --owner T69-m9b4
 *
 * Local inference holds `.cache/f2/LOCAL_MODEL_BUSY` of the data root and waits for any other local-model
 * process. A run needs the machine to itself: speeds are the measurement.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { cpus, loadavg, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import {
  MlxAdapter,
  MlxHelperHost,
  NodeLlamaCppAdapter,
  aiTaskRequestSchema,
  findLocalModelCatalogEntry,
  type AiModelAdapter
} from "@app/ai";
import { toStrictJsonSchema } from "@app/domain";

import { otherLocalModelJobs } from "../spikes/topic-tree/local-model-slot.ts";
import { waitForModelsOutsideTheLock, withLocalModelLock } from "../relations/local-model-lock.ts";
import {
  classifyRecordedCall,
  contractIds,
  writerTaskTypes,
  type ContractId,
  type PromptSource,
  type SchemaSource
} from "./contracts/index.ts";
import { arms, customArm, type ArmSpec } from "./replay-arms.ts";
import { readCassette } from "./replay-cassette.ts";
import { systemMemoryProbe, type MemoryProbe } from "./replay-metrics.ts";
import {
  manifestSchema,
  parseItemLines,
  type ItemRecord,
  type RunManifest
} from "./replay-records.ts";
import {
  recordedBaseline,
  replayItems,
  type ReplayEntry,
  type RunnerEnvironment,
  type WriterHandle
} from "./replay-runner.ts";
import { summarizeRun } from "./writer-report.ts";

const execFileAsync = promisify(execFile);

// --- options -------------------------------------------------------------------------------------

export interface Options {
  command: "plan" | "run";
  dataRoot: string;
  cassette: string;
  contracts: ContractId[];
  limit: number | null;
  perContract: number | null;
  promptSource: PromptSource;
  arm: string | null;
  modelDir: string | null;
  runtime: "mlx" | "gguf";
  label: string | null;
  helperPath: string | null;
  runId: string | null;
  resume: boolean;
  schema: boolean;
  schemaModule: string | null;
  seed: number | null;
  params: Record<string, unknown>;
  owner: string;
  lock: string | null;
  out: string | null;
  sampleIntervalMs: number;
  warmup: boolean;
}

export const usage = `Usage:
  writer-replay.ts plan [--data-root <.cache>] [--cassette <dir>] [--contracts a,b] [--prompts recorded|current] [--arm <id>] [--out <file>]
  writer-replay.ts run  --arm m4b|m9b4|q36-35b-a3b|gemma4-26b-a4b|custom [--data-root <.cache>] [--cassette <dir>]
        [--model-dir <dir>] [--runtime mlx|gguf --label <text>]   (custom arm)
        [--helper-path <file>] [--contracts a,b] [--limit N] [--per-contract N] [--prompts recorded|current]
        [--schema] [--schema-module <file>] [--seed N] [--param key=value]... [--run-id <id>] [--resume]
        [--owner <task id>] [--lock <file>] [--out <dir>] [--sample-interval-ms N] [--no-warmup]
Contracts: ${contractIds.join(", ")}`;

function coerce(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  const number = Number(value);
  return value.trim() !== "" && Number.isFinite(number) ? number : value;
}

export function parseOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Options {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      "data-root": { type: "string" },
      cassette: { type: "string" },
      contracts: { type: "string" },
      limit: { type: "string" },
      "per-contract": { type: "string" },
      prompts: { type: "string" },
      arm: { type: "string" },
      "model-dir": { type: "string" },
      runtime: { type: "string" },
      label: { type: "string" },
      "helper-path": { type: "string" },
      "run-id": { type: "string" },
      resume: { type: "boolean", default: false },
      schema: { type: "boolean", default: false },
      "schema-module": { type: "string" },
      seed: { type: "string" },
      param: { type: "string", multiple: true },
      owner: { type: "string" },
      lock: { type: "string" },
      out: { type: "string" },
      "sample-interval-ms": { type: "string" },
      "no-warmup": { type: "boolean", default: false }
    }
  });
  const command = positionals[0];
  if (command !== "plan" && command !== "run") throw new Error(`Unknown command.\n${usage}`);
  const dataRoot = resolve(
    values["data-root"] ?? env.MEMORA_BENCH_DATA_ROOT ?? join(process.cwd(), ".cache")
  );
  const contracts = values.contracts
    ? values.contracts.split(",").map((name) => {
        if (!(contractIds as readonly string[]).includes(name))
          throw new Error(`Unknown contract "${name}". Known: ${contractIds.join(", ")}`);
        return name as ContractId;
      })
    : [...contractIds];
  const promptSource = (values.prompts ?? "recorded") as PromptSource;
  if (promptSource !== "recorded" && promptSource !== "current")
    throw new Error("--prompts must be recorded or current.");
  const runtime = (values.runtime ?? "mlx") as "mlx" | "gguf";
  if (runtime !== "mlx" && runtime !== "gguf") throw new Error("--runtime must be mlx or gguf.");
  const integer = (name: string, value: string | undefined): number | null => {
    if (value === undefined) return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0)
      throw new Error(`--${name} must be a whole number.`);
    return parsed;
  };
  const params: Record<string, unknown> = {};
  for (const entry of values.param ?? []) {
    const at = entry.indexOf("=");
    if (at <= 0) throw new Error(`--param needs key=value, got "${entry}".`);
    params[entry.slice(0, at)] = coerce(entry.slice(at + 1));
  }
  return {
    command,
    dataRoot,
    cassette: resolve(values.cassette ?? join(dataRoot, "golden", "cassettes", "golden-small-f2")),
    contracts,
    limit: integer("limit", values.limit),
    perContract: integer("per-contract", values["per-contract"]),
    promptSource,
    arm: values.arm ?? null,
    modelDir: values["model-dir"] ? resolve(values["model-dir"]) : null,
    runtime,
    label: values.label ?? null,
    helperPath: resolve(
      values["helper-path"] ??
        (env.MEMORA_MLX_HELPER_PATH?.trim() ||
          // The built helper of the checkout the data root belongs to (the pinned one).
          join(dataRoot, "..", "native", "mlx-helper", ".build", "release", "memora-mlx-helper"))
    ),
    runId: values["run-id"] ?? null,
    resume: values.resume ?? false,
    schema: values.schema ?? false,
    schemaModule: values["schema-module"] ?? null,
    seed: integer("seed", values.seed),
    params,
    owner: values.owner ?? "T69",
    lock: values.lock ?? null,
    out: values.out ?? null,
    sampleIntervalMs: integer("sample-interval-ms", values["sample-interval-ms"]) ?? 1_000,
    warmup: !(values["no-warmup"] ?? false)
  };
}

// --- the entries ---------------------------------------------------------------------------------

export interface Census {
  /** Writer-class calls the cassette holds (remote runtime, generative task types). */
  calls: number;
  items: Partial<Record<ContractId, number>>;
  recordedRepairs: Partial<Record<ContractId, number>>;
  /** Taken apart but not put back: the reason and how many. */
  unreconstructable: Record<string, number>;
  /** Calls no contract of this harness reads (a legacy decider, an explanation). */
  other: number;
  /** Items whose prompt today differs from the recording's, per contract. */
  drift: Partial<Record<ContractId, number>>;
}

export interface LoadedEntries {
  entries: ReplayEntry[];
  census: Census;
}

const bump = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** Reads the cassette and classifies every writer call; the entries are the ones this run replays. */
export async function loadEntries(
  options: Pick<Options, "cassette" | "contracts" | "limit" | "perContract">
): Promise<LoadedEntries> {
  const calls = await readCassette(options.cassette, {
    taskTypes: writerTaskTypes,
    runtime: "remote"
  });
  const census: Census = {
    calls: calls.length,
    items: {},
    recordedRepairs: {},
    unreconstructable: {},
    other: 0,
    drift: {}
  };
  const wanted = new Set(options.contracts);
  const taken: Partial<Record<ContractId, number>> = {};
  const entries: ReplayEntry[] = [];
  for (const recorded of calls) {
    const classified = classifyRecordedCall(recorded);
    if (classified.kind === "not_a_writer_call") census.other += 1;
    else if (classified.kind === "recorded_repair")
      bump(census.recordedRepairs as Record<string, number>, classified.contract);
    else if (classified.kind === "unreconstructable")
      bump(census.unreconstructable, `${classified.contract ?? "unknown"}:${classified.reason}`);
    else {
      const { item } = classified;
      bump(census.items as Record<string, number>, item.contract);
      if (item.current !== item.body) bump(census.drift as Record<string, number>, item.contract);
      if (!wanted.has(item.contract)) continue;
      const count = taken[item.contract] ?? 0;
      if (options.perContract !== null && count >= options.perContract) continue;
      if (options.limit !== null && entries.length >= options.limit) continue;
      taken[item.contract] = count + 1;
      entries.push({ recorded, item });
    }
  }
  return { entries, census };
}

// --- plan ----------------------------------------------------------------------------------------

export interface ArmProjection {
  arm: string;
  label: string;
  hours: number;
  assumption: string;
}

export interface RecordedBaselineRow {
  items: number;
  /** Items whose recorded answer needed no repair call and ended usable. */
  noRepair: number;
  /** Items that also had nothing salvaged. */
  firstPassClean: number;
  repairCalls: number;
  salvagedItems: number;
  ok: number;
}

export interface Plan {
  cassette: string;
  promptSource: PromptSource;
  census: Census;
  selected: Partial<Record<ContractId, number>>;
  recordedTokens: { input: number; output: number };
  /** The product's flow on each recorded answer: what the recording needed (no model involved). */
  recordedBaseline: Partial<Record<ContractId, RecordedBaselineRow>>;
  projections: ArmProjection[];
}

/** Hours an arm is projected to take at its assumed rates, a tenth more for repairs. */
export function projectHours(
  entries: readonly ReplayEntry[],
  arm: Pick<ArmSpec, "assumed">
): number {
  let seconds = 0;
  for (const { recorded } of entries) {
    const inputTokens = recorded.inputTokens ?? Math.ceil(recorded.input.length / 3);
    const outputTokens = recorded.outputTokens ?? 800;
    seconds += inputTokens / arm.assumed.prefillTps + outputTokens / arm.assumed.decodeTps;
  }
  return (seconds * 1.1) / 3_600;
}

export async function buildPlan(
  options: Pick<
    Options,
    "cassette" | "contracts" | "limit" | "perContract" | "promptSource" | "arm"
  >
): Promise<Plan> {
  const { entries, census } = await loadEntries(options);
  const selected: Plan["selected"] = {};
  const baseline: Plan["recordedBaseline"] = {};
  let input = 0;
  let output = 0;
  for (const entry of entries) {
    const contract = entry.item.contract;
    selected[contract] = (selected[contract] ?? 0) + 1;
    input += entry.recorded.inputTokens ?? 0;
    output += entry.recorded.outputTokens ?? 0;
    const result = await recordedBaseline(entry, options.promptSource);
    const row = (baseline[contract] ??= {
      items: 0,
      noRepair: 0,
      firstPassClean: 0,
      repairCalls: 0,
      salvagedItems: 0,
      ok: 0
    });
    row.items += 1;
    row.noRepair += result.repairCalls === 0 && result.outcome.ok ? 1 : 0;
    row.firstPassClean += result.firstPassClean ? 1 : 0;
    row.repairCalls += result.repairCalls;
    row.salvagedItems += result.outcome.salvagedItems;
    row.ok += result.outcome.ok ? 1 : 0;
  }
  const chosen = options.arm
    ? [arms[options.arm]].filter((arm) => arm !== undefined)
    : Object.values(arms);
  return {
    cassette: options.cassette,
    promptSource: options.promptSource,
    census,
    selected,
    recordedTokens: { input, output },
    recordedBaseline: baseline,
    projections: chosen.map((arm) => ({
      arm: arm.id,
      label: arm.label,
      hours: projectHours(entries, arm),
      assumption: `${arm.assumed.decodeTps} tok/s decode, ${arm.assumed.prefillTps} tok/s prefill: ${arm.assumed.source}`
    }))
  };
}

export function renderPlan(plan: Plan): string {
  const lines = [`Cassette ${plan.cassette}; first ask sends the ${plan.promptSource} prompt.`, ""];
  lines.push(
    `Writer calls ${plan.census.calls}; replayed contracts: ${JSON.stringify(plan.census.items)}`,
    `Recorded repairs (not replayed): ${JSON.stringify(plan.census.recordedRepairs)}`,
    `Not taken apart: ${JSON.stringify(plan.census.unreconstructable)}; other calls: ${plan.census.other}`,
    `Prompt differs from today's: ${JSON.stringify(plan.census.drift)}`,
    `Selected: ${JSON.stringify(plan.selected)}; recorded tokens in ${plan.recordedTokens.input}, out ${plan.recordedTokens.output}`,
    "",
    "The recording under the product's flow (no model): items, no repair needed, clean (nothing salvaged), repair calls, salvaged items, usable at the end"
  );
  for (const [contract, row] of Object.entries(plan.recordedBaseline))
    lines.push(
      `  ${contract}: ${row.items}, ${row.noRepair}, ${row.firstPassClean}, ${row.repairCalls}, ${row.salvagedItems}, ${row.ok}`
    );
  lines.push(
    "",
    "Projected hours at assumed rates (an assumption, replaced by the run's own speeds):"
  );
  for (const projection of plan.projections)
    lines.push(`  ${projection.arm}: ${projection.hours.toFixed(1)} h (${projection.assumption})`);
  return `${lines.join("\n")}\n`;
}

// --- the real writer -----------------------------------------------------------------------------

export interface OpenedWriter extends WriterHandle {
  helperSha256: string | null;
  capabilities: string[];
  dispose(): Promise<void>;
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/** The catalog's text capabilities, which every generative arm declares. */
function writerCapabilities() {
  return [...findLocalModelCatalogEntry("mlx-qwen3.5-9b-4bit")!.capabilities];
}

async function runAdapter(
  adapter: AiModelAdapter,
  request: Parameters<WriterHandle["call"]>[0],
  onText: (delta: string) => void
) {
  if (!adapter.runStreaming) return adapter.run(request);
  return adapter.runStreaming(request, undefined, (event) => {
    if (event.kind === "text") onText(event.delta);
  });
}

export async function openRealWriter(
  arm: ArmSpec,
  modelDir: string,
  helperPath: string | null
): Promise<OpenedWriter> {
  const identity = arm.catalogId ? findLocalModelCatalogEntry(arm.catalogId) : undefined;
  const common = {
    modelId: arm.catalogId ?? arm.id,
    modelPath: modelDir,
    capabilities: writerCapabilities(),
    ...(identity ? { repository: identity.repository, revision: identity.revision } : {})
  };
  if (arm.runtime === "gguf") {
    const adapter = new NodeLlamaCppAdapter(common);
    return {
      helperSha256: null,
      capabilities: ["schema"],
      helperPid: () => process.pid,
      supportsSchema: () => true,
      call: (request, onText) => runAdapter(adapter, request, onText),
      dispose: () => adapter.dispose()
    };
  }
  if (!helperPath) throw new Error("An MLX arm needs --helper-path (or MEMORA_MLX_HELPER_PATH).");
  await stat(helperPath);
  await stat(join(dirname(helperPath), "mlx.metallib")).catch(() => {
    throw new Error(`The helper ${helperPath} needs mlx.metallib beside it.`);
  });
  const host = new MlxHelperHost({ helperPath, config: { cancelGraceMs: 2_000 } });
  await host.health();
  const adapter = new MlxAdapter({ ...common, helperPath, host });
  return {
    helperSha256: await sha256File(helperPath),
    capabilities: [...(host.capabilities ?? [])],
    helperPid: () => host.pid,
    supportsSchema: () => host.capabilities?.has("schema") === true,
    call: (request, onText) => runAdapter(adapter, request, onText),
    dispose: () => host.dispose()
  };
}

// --- the run -------------------------------------------------------------------------------------

export interface Dependencies {
  openWriter(arm: ArmSpec, modelDir: string, helperPath: string | null): Promise<OpenedWriter>;
  /** Holds the local-model lock (and waits for the slot) while `work` runs. */
  withLock<T>(work: () => Promise<T>): Promise<T>;
  probe: MemoryProbe;
  /** What the machine says about itself, for the manifest. */
  machine(): Promise<Record<string, string | null>>;
  now(): Date;
  clock(): number;
  log(message: string): void;
}

async function readCommand(command: string, args: string[]): Promise<string | null> {
  try {
    return (await execFileAsync(command, args, { timeout: 5_000 })).stdout.trim();
  } catch {
    return null;
  }
}

export function defaultDependencies(lock: string, owner: string): Dependencies {
  return {
    openWriter: openRealWriter,
    withLock: (work) =>
      withLocalModelLock(
        { path: lock, owner, onWait: (path) => console.info(`Waiting for ${path} to disappear`) },
        async () => {
          await waitForModelsOutsideTheLock(otherLocalModelJobs, {
            onWait: (jobs) =>
              console.info(`Waiting for other local-model processes:\n  ${jobs.join("\n  ")}`)
          });
          return work();
        }
      ),
    probe: systemMemoryProbe,
    async machine() {
      const [chip, release, thermal, power] = await Promise.all([
        readCommand("sysctl", ["-n", "machdep.cpu.brand_string"]),
        readCommand("sw_vers", ["-productVersion"]),
        readCommand("pmset", ["-g", "therm"]),
        readCommand("pmset", ["-g", "batt"])
      ]);
      return {
        platform: `${process.platform}/${process.arch}`,
        chip,
        macos: release,
        cpus: String(cpus().length),
        memoryGiB: (totalmem() / 1024 ** 3).toFixed(1),
        loadAverage: loadavg()
          .map((value) => value.toFixed(2))
          .join(" "),
        thermal: thermal?.replace(/\s+/gu, " ") ?? null,
        power: power?.split("\n")[0] ?? null,
        node: process.version
      };
    },
    now: () => new Date(),
    clock: () => performance.now(),
    log: (message) => console.info(message)
  };
}

/** The default schema source: a strict schema for a contract that has one (today the overview's). */
export const defaultSchemaSource: SchemaSource = (_contract, answer) =>
  toStrictJsonSchema(answer.contract, answer.name);

async function loadSchemaSource(path: string): Promise<SchemaSource> {
  const module = (await import(pathToFileURL(resolve(path)).href)) as {
    schemaForContract?: SchemaSource;
    default?: SchemaSource;
  };
  const source = module.schemaForContract ?? module.default;
  if (typeof source !== "function")
    throw new Error(
      `${path} must export schemaForContract(contract, answer) or a default function.`
    );
  return source;
}

export function resolveArm(options: Options): { arm: ArmSpec; modelDir: string } {
  if (options.arm === "custom" && !options.modelDir)
    throw new Error("A custom arm needs --model-dir.");
  const arm =
    options.arm === "custom"
      ? customArm({
          label: options.label ?? "custom",
          runtime: options.runtime,
          modelDir: options.modelDir ?? "",
          ...(Object.keys(options.params).length > 0 ? { parameters: options.params } : {})
        })
      : options.arm
        ? arms[options.arm]
        : undefined;
  if (!arm)
    throw new Error(`--arm must be one of ${Object.keys(arms).join(", ")}, custom.\n${usage}`);
  const modelDir = options.modelDir ?? join(options.dataRoot, arm.directory);
  return { arm, modelDir };
}

async function readDone(path: string): Promise<{ keys: Set<string>; records: ItemRecord[] }> {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    // A run that has not started has no lines.
  }
  const records = parseItemLines(text);
  return { keys: new Set(records.map((record) => record.key)), records };
}

/** The manifest a run left in this folder, or null when there is none (or it is not one). */
async function readEarlierManifest(directory: string): Promise<RunManifest | null> {
  try {
    const parsed = manifestSchema.safeParse(
      JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface RunResult {
  directory: string;
  replayed: number;
  skipped: number;
}

export async function runCommand(options: Options, deps: Dependencies): Promise<RunResult> {
  const { arm, modelDir } = resolveArm(options);
  await stat(modelDir).catch(() => {
    throw new Error(`The model folder ${modelDir} does not exist.`);
  });
  const { entries } = await loadEntries(options);
  if (entries.length === 0) throw new Error("No call of the cassette matches the selection.");
  const schemaSource = options.schema
    ? options.schemaModule
      ? await loadSchemaSource(options.schemaModule)
      : defaultSchemaSource
    : null;
  const runId =
    options.runId ??
    `${arm.id}-${options.promptSource}${options.schema ? "-schema" : ""}-${deps.now().toISOString().replace(/[:.]/gu, "-")}`;
  const directory = resolve(options.out ?? join(options.dataRoot, "f4", "bench"), runId);
  const itemsPath = join(directory, "items.ndjson");
  const done = await readDone(itemsPath);
  const earlier = await readEarlierManifest(directory);
  if (done.keys.size > 0 && !options.resume)
    throw new Error(
      `${directory} already holds ${done.keys.size} items; pass --resume to continue it.`
    );
  if (done.keys.size > 0 && earlier) {
    const changed = [
      ["arm", earlier.arm.id, arm.id],
      ["prompts", earlier.selection.promptSource, options.promptSource],
      ["schema", earlier.schema.requested, options.schema],
      ["seed", earlier.seed, options.seed],
      ["cassette", earlier.cassette.directory, options.cassette]
    ].filter(([, before, now]) => before !== now);
    if (changed.length > 0)
      throw new Error(
        `Cannot resume ${directory}: ${changed.map(([name]) => String(name)).join(", ")} differ from the run it holds.`
      );
  }
  await mkdir(directory, { recursive: true });
  // A stopped run may have left a torn last line; the file keeps only whole items before new ones follow.
  if (done.records.length > 0)
    await writeFile(
      itemsPath,
      done.records.map((record) => `${JSON.stringify(record)}\n`).join("")
    );
  const lock = options.lock ?? join(options.dataRoot, "f2", "LOCAL_MODEL_BUSY");

  return deps.withLock(async () => {
    const writer = await deps.openWriter(arm, modelDir, options.helperPath);
    try {
      const environment: RunnerEnvironment = {
        writer,
        probe: deps.probe,
        clock: deps.clock,
        now: deps.now,
        sampleIntervalMs: options.sampleIntervalMs
      };
      const warmup = await warmUp(options, writer, deps);
      const swapBefore = (await deps.probe.sample(writer.helperPid())).swapUsedMiB;
      const machine = await deps.machine();
      const manifest: RunManifest = {
        schemaVersion: 1,
        task: "T69",
        runId,
        startedAt: earlier?.startedAt ?? deps.now().toISOString(),
        finishedAt: null,
        arm: {
          id: arm.id,
          label: arm.label,
          runtime: arm.runtime,
          catalogId: arm.catalogId,
          modelDir,
          parameterSource: arm.parameterSource
        },
        helper: {
          path: options.helperPath,
          sha256: writer.helperSha256,
          capabilities: writer.capabilities
        },
        cassette: { directory: options.cassette, items: entries.length },
        selection: {
          contracts: options.contracts,
          limit: options.limit,
          promptSource: options.promptSource
        },
        parameters: { ...arm.parameters, ...options.params },
        seed: options.seed,
        schema: { requested: options.schema, supported: writer.supportsSchema() },
        machine,
        warmup,
        swapBeforeMiB: swapBefore,
        swapAfterMiB: null,
        lock: { path: lock, owner: options.owner }
      };
      await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      deps.log(
        `${arm.label}: ${entries.length} items, ${done.keys.size} already done -> ${directory}`
      );
      const result = await replayItems(
        entries,
        environment,
        {
          arm,
          promptSource: options.promptSource,
          seed: options.seed ?? undefined,
          overrides: options.params,
          schemaSource
        },
        {
          done: done.keys,
          onRecord: async (record, progress) => {
            await appendFile(itemsPath, `${JSON.stringify(record)}\n`);
            const first = record.calls[0];
            deps.log(
              `[${progress.done}/${progress.total}] ${record.contract} ${record.firstPassClean ? "clean" : record.outcome.ok ? "repaired" : "FAILED"} ` +
                `${first ? `${(first.wallMs / 1000).toFixed(1)}s ${first.decodeTps?.toFixed(1) ?? "?"} tok/s` : ""}`
            );
          }
        }
      );
      const swapAfter = (await deps.probe.sample(writer.helperPid())).swapUsedMiB;
      const finished: RunManifest = {
        ...manifest,
        finishedAt: deps.now().toISOString(),
        swapAfterMiB: swapAfter
      };
      await writeFile(join(directory, "manifest.json"), `${JSON.stringify(finished, null, 2)}\n`);
      const all = await readDone(itemsPath);
      await writeFile(
        join(directory, "summary.json"),
        `${JSON.stringify(summarizeRun(finished, all.records), null, 2)}\n`
      );
      return { directory, ...result };
    } finally {
      await writer.dispose();
    }
  });
}

/** Two tiny calls: the first loads the model, the second shows the steady cost of a short call. */
async function warmUp(
  options: Options,
  writer: WriterHandle,
  deps: Dependencies
): Promise<{ loadMs: number | null; warmMs: number | null }> {
  if (!options.warmup) return { loadMs: null, warmMs: null };
  const request = aiTaskRequestSchema.parse({
    taskType: "text-generation",
    input: "Reply with the single word OK.",
    parameters: { maxTokens: 8, temperature: 0 },
    operation: "bench_warmup"
  });
  const timed = async () => {
    const started = deps.clock();
    await writer.call(request, () => undefined);
    return deps.clock() - started;
  };
  const loadMs = await timed();
  const warmMs = await timed();
  return { loadMs, warmMs };
}

export async function main(argv: readonly string[]): Promise<void> {
  const options = parseOptions(argv);
  if (options.command === "plan") {
    const plan = await buildPlan(options);
    process.stdout.write(renderPlan(plan));
    if (options.out) {
      await mkdir(resolve(options.out, ".."), { recursive: true });
      await writeFile(resolve(options.out), `${JSON.stringify(plan, null, 2)}\n`);
    }
    return;
  }
  const lock = options.lock ?? join(options.dataRoot, "f2", "LOCAL_MODEL_BUSY");
  const result = await runCommand(options, defaultDependencies(lock, options.owner));
  console.info(
    `Replayed ${result.replayed} items (${result.skipped} already done): ${result.directory}`
  );
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`[writer-replay] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
