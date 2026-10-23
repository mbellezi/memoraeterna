/**
 * The replay loop of the prompt-replay harness (F4 T69): for each recorded call it runs the product's
 * own flow (validation, salvage, repair) with a caller that sends the prompts to a local writer, and
 * writes what happened. The writer, the clock and the memory probe are injected, so the loop is tested
 * without a model; `writer-replay.ts` wires the real ones.
 */
import { aiTaskRequestSchema, type AiTaskRequest, type AiTaskResult } from "@app/ai";

import {
  type FlowOutcome,
  type PreparedItem,
  type PromptSource,
  type ReplayCall,
  type ReplayCaller,
  type SchemaSource
} from "./contracts/index.ts";
import { effectiveParameters, workloadClassOf, type ArmSpec } from "./replay-arms.ts";
import { composeInput, type RecordedCall } from "./replay-cassette.ts";
import { callSpeed, MemorySampler, type MemoryProbe } from "./replay-metrics.ts";
import type { CallRecord, ItemRecord } from "./replay-records.ts";

/** The local writer as the loop sees it. `call` is the adapter's streaming run. */
export interface WriterHandle {
  /** The process whose resident memory the run reports (the MLX helper, or this process for GGUF). */
  helperPid(): number | undefined;
  /** Whether the runtime announces that it takes an output schema. */
  supportsSchema(): boolean;
  call(request: AiTaskRequest, onText: (delta: string) => void): Promise<AiTaskResult>;
}

export interface RunnerEnvironment {
  writer: WriterHandle;
  probe: MemoryProbe;
  /** Monotonic milliseconds. */
  clock(): number;
  now(): Date;
  sampleIntervalMs?: number;
}

export interface RunnerSettings {
  arm: ArmSpec;
  promptSource: PromptSource;
  seed?: number | undefined;
  overrides?: Record<string, unknown> | undefined;
  /** Sends the contract's schema when the runtime announces `schema`; null never sends one. */
  schemaSource: SchemaSource | null;
}

export interface ReplayEntry {
  recorded: RecordedCall;
  item: PreparedItem;
}

/** The answer of a call as text: a generative adapter returns a string. */
function answerText(output: unknown): string {
  return typeof output === "string" ? output : (JSON.stringify(output) ?? "");
}

/** The product's flow on the recorded answer alone: what the recording itself needed. */
export async function recordedBaseline(
  entry: ReplayEntry,
  promptSource: PromptSource
): Promise<{ outcome: FlowOutcome; repairCalls: number; firstPassClean: boolean }> {
  let calls = 0;
  let repairCalls = 0;
  const caller: ReplayCaller = async (call) => {
    calls += 1;
    if (calls === 1) return { output: entry.recorded.output, durationMs: 0 };
    if (call.isRepair) repairCalls += 1;
    throw new Error("replay_exhausted");
  };
  const outcome = await entry.item.run(caller, promptSource);
  return {
    outcome,
    repairCalls,
    firstPassClean: repairCalls === 0 && outcome.ok && outcome.salvagedItems === 0
  };
}

/** The grammar compile time the MLX helper reported for a call (`requestOptions.grammar`), or null. */
function grammarCompileMs(result: AiTaskResult): number | null {
  const grammar = result.requestOptions?.grammar;
  if (typeof grammar !== "object" || grammar === null || Array.isArray(grammar)) return null;
  const value = (grammar as Record<string, unknown>).compileMs;
  return typeof value === "number" ? value : null;
}

/** Builds the caller that sends one item's calls to the writer and logs each. */
export function makeCaller(
  environment: RunnerEnvironment,
  settings: RunnerSettings,
  log: CallRecord[]
): ReplayCaller {
  const { writer, probe, clock } = environment;
  return async (call: ReplayCall) => {
    const parameters = effectiveParameters(settings.arm, call, {
      seed: settings.seed,
      overrides: settings.overrides
    });
    const offered =
      settings.schemaSource !== null && call.answerContract !== undefined && writer.supportsSchema()
        ? settings.schemaSource(call.contract, call.answerContract)
        : null;
    const workloadClass = workloadClassOf(call);
    const input = composeInput(call.prompt, call.language);
    const request = aiTaskRequestSchema.parse({
      taskType: call.taskType,
      input,
      parameters,
      operation: call.operation,
      ...(workloadClass ? { workloadClass } : {}),
      ...(offered ? { outputSchema: offered } : {})
    });
    const sampler = new MemorySampler(
      probe,
      () => writer.helperPid(),
      environment.sampleIntervalMs
    );
    sampler.start();
    const started = clock();
    let firstTextAt: number | null = null;
    const base = {
      attempt: call.attempt,
      operation: call.operation,
      isRepair: call.isRepair,
      inputChars: input.length,
      parameters,
      schemaOffered: offered !== null
    };
    try {
      const result = await writer.call(request, () => {
        firstTextAt ??= clock();
      });
      const wallMs = clock() - started;
      const memory = await sampler.stop();
      const ttftMs = firstTextAt === null ? null : firstTextAt - started;
      const speed = callSpeed({
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        wallMs,
        ttftMs
      });
      const output = answerText(result.output);
      log.push({
        ...base,
        output,
        error: null,
        inputTokens: result.inputTokens ?? null,
        outputTokens: result.outputTokens ?? null,
        wallMs,
        ttftMs,
        prefillTps: speed.prefillTps,
        decodeTps: speed.decodeTps,
        schemaMode: result.schemaMode ?? null,
        grammarCompileMs: grammarCompileMs(result),
        peakHelperRssMiB: memory.peakHelperRssMiB,
        peakHelperFootprintMiB: memory.peakHelperFootprintMiB,
        peakSwapUsedMiB: memory.peakSwapUsedMiB,
        minMemoryLevel: memory.minMemoryLevel
      });
      return {
        output,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: wallMs,
        ttftMs,
        schemaMode: result.schemaMode ?? null
      };
    } catch (error) {
      const wallMs = clock() - started;
      const memory = await sampler.stop();
      log.push({
        ...base,
        output: "",
        error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "error",
        inputTokens: null,
        outputTokens: null,
        wallMs,
        ttftMs: null,
        prefillTps: null,
        decodeTps: null,
        schemaMode: null,
        peakHelperRssMiB: memory.peakHelperRssMiB,
        peakHelperFootprintMiB: memory.peakHelperFootprintMiB,
        peakSwapUsedMiB: memory.peakSwapUsedMiB,
        minMemoryLevel: memory.minMemoryLevel
      });
      throw error;
    }
  };
}

/** Replays one item: the baseline on the recorded answer, then the flow on the writer. */
export async function replayItem(
  entry: ReplayEntry,
  environment: RunnerEnvironment,
  settings: RunnerSettings
): Promise<ItemRecord> {
  const { item, recorded } = entry;
  const startedAt = environment.now().toISOString();
  const started = environment.clock();
  const baseline = await recordedBaseline(entry, settings.promptSource);
  const calls: CallRecord[] = [];
  const outcome = await item.run(makeCaller(environment, settings, calls), settings.promptSource);
  const recordedDigest = item.digestOf(recorded.output);
  const repairCalls = calls.filter((call) => call.isRepair).length;
  return {
    schemaVersion: 1,
    key: recorded.key,
    contract: item.contract,
    fidelity: item.fidelity,
    taskType: item.taskType,
    operation: item.operation,
    language: item.language,
    promptSource: settings.promptSource,
    promptDrift: item.current !== item.body,
    recorded: {
      providerId: recorded.providerId,
      modelId: recorded.modelId,
      inputTokens: recorded.inputTokens ?? null,
      outputTokens: recorded.outputTokens ?? null,
      durationMs: recorded.durationMs
    },
    baseline: {
      ok: baseline.outcome.ok,
      error: baseline.outcome.error,
      repairCalls: baseline.repairCalls,
      salvagedItems: baseline.outcome.salvagedItems,
      firstPassClean: baseline.firstPassClean
    },
    calls,
    outcome: { ok: outcome.ok, error: outcome.error, salvagedItems: outcome.salvagedItems },
    firstPassClean:
      repairCalls === 0 &&
      outcome.ok &&
      outcome.salvagedItems === 0 &&
      calls.every((call) => call.error === null),
    repairCalls,
    yield: outcome.digest && recordedDigest ? item.compare(outcome.digest, recordedDigest) : null,
    startedAt,
    wallMs: environment.clock() - started
  };
}

export interface RunProgress {
  done: number;
  total: number;
  record: ItemRecord;
}

/**
 * Replays the entries in order, skipping the keys already recorded (a resumed run). `onRecord` is
 * called as each item ends, so the caller appends it to the run's file before the next one starts.
 */
export async function replayItems(
  entries: readonly ReplayEntry[],
  environment: RunnerEnvironment,
  settings: RunnerSettings,
  options: {
    done?: ReadonlySet<string>;
    onRecord: (record: ItemRecord, progress: RunProgress) => Promise<void> | void;
    signal?: AbortSignal;
  }
): Promise<{ replayed: number; skipped: number }> {
  let replayed = 0;
  let skipped = 0;
  for (const [index, entry] of entries.entries()) {
    options.signal?.throwIfAborted();
    if (options.done?.has(entry.recorded.key)) {
      skipped += 1;
      continue;
    }
    const record = await replayItem(entry, environment, settings);
    replayed += 1;
    await options.onRecord(record, { done: index + 1, total: entries.length, record });
  }
  return { replayed, skipped };
}
