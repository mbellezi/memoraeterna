import { z } from "zod";

/**
 * Typed configuration of the supervised MLX helper process: memory bounds, deadlines and the
 * environment the helper receives. Limits, timeouts and defaults live here, not in the host.
 */

export const mlxCacheLimitEnvironmentVariable = "MEMORA_MLX_CACHE_LIMIT_MB";
export const mlxMemoryLimitEnvironmentVariable = "MEMORA_MLX_MEMORY_LIMIT_MB";

export const mlxRuntimeConfigSchema = z
  .object({
    /**
     * Cap of MLX's reusable GPU buffer cache, in MiB. Without it the cache grows during long
     * batched scoring or embedding runs and pushes the host into swap. 0 returns buffers at once.
     */
    cacheLimitMb: z.number().int().min(0).max(65_536),
    /** Optional relaxed cap of all MLX allocations, in MiB. Unset leaves MLX's own default. */
    memoryLimitMb: z.number().int().min(256).max(1_048_576).optional(),
    /**
     * Deadline of one request that states none, from the moment it starts executing, not from its
     * wait for a turn. The adapters state their workload class's local deadline (F3 D31).
     */
    requestTimeoutMs: z.number().int().min(100).max(3_600_000),
    /** Deadline of `health`, which also pays the process start. */
    healthTimeoutMs: z.number().int().min(100).max(600_000),
    /** How long a killed helper gets to exit after SIGTERM before it receives SIGKILL. */
    killGraceMs: z.number().int().min(10).max(60_000),
    /**
     * How long an idle helper gets to exit after the protocol's `shutdown` before the host sends it
     * signals (F4 D23). A busy helper is not asked: its request is cancelled and it is signalled.
     */
    shutdownGraceMs: z.number().int().min(10).max(60_000),
    /**
     * How long a request the host cancelled (at its deadline or on an abort) may take to answer
     * before the helper is killed (F3 D31). A helper without `cancel` is killed at once.
     */
    cancelGraceMs: z.number().int().min(10).max(60_000),
    /**
     * How long after its first answer a fresh helper is watched for exiting. A helper that exits
     * after every request is respawned instead of being written to while it dies.
     */
    persistenceProbeMs: z.number().int().min(0).max(5_000),
    /** Characters of helper diagnostics (stderr) kept for error reports. */
    stderrTailChars: z.number().int().min(0).max(100_000)
  })
  .strict();

export type MlxRuntimeConfig = z.infer<typeof mlxRuntimeConfigSchema>;
export type MlxRuntimeConfigInput = Partial<MlxRuntimeConfig>;

export const defaultMlxRuntimeConfig: MlxRuntimeConfig = {
  cacheLimitMb: 1_024,
  requestTimeoutMs: 10 * 60_000,
  healthTimeoutMs: 30_000,
  killGraceMs: 1_000,
  shutdownGraceMs: 2_000,
  cancelGraceMs: 2_000,
  persistenceProbeMs: 50,
  stderrTailChars: 2_000
};

const limitEnvironmentSchema = z
  .string()
  .trim()
  .regex(/^\d{1,9}$/u)
  .transform(Number);

/**
 * Resolves the configuration. Precedence: explicit input, then the two operator variables
 * (`MEMORA_MLX_CACHE_LIMIT_MB`, `MEMORA_MLX_MEMORY_LIMIT_MB`), then the defaults. A variable that
 * is not a whole number inside the schema's range is ignored, so a typo never disables a bound.
 */
export function resolveMlxRuntimeConfig(
  input: MlxRuntimeConfigInput = {},
  environment: NodeJS.ProcessEnv = process.env
): MlxRuntimeConfig {
  const fromEnvironment: MlxRuntimeConfigInput = {};
  const cache = readLimit(environment[mlxCacheLimitEnvironmentVariable]);
  if (cache !== undefined && mlxRuntimeConfigSchema.shape.cacheLimitMb.safeParse(cache).success) {
    fromEnvironment.cacheLimitMb = cache;
  }
  const memory = readLimit(environment[mlxMemoryLimitEnvironmentVariable]);
  if (
    memory !== undefined &&
    mlxRuntimeConfigSchema.shape.memoryLimitMb.safeParse(memory).success
  ) {
    fromEnvironment.memoryLimitMb = memory;
  }
  const explicit = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  );
  return mlxRuntimeConfigSchema.parse({
    ...defaultMlxRuntimeConfig,
    ...fromEnvironment,
    ...explicit
  });
}

/**
 * The environment of the helper process: a minimal set of the host's variables plus the memory
 * bounds from the typed configuration. Secrets and application variables are never forwarded.
 */
export function mlxHelperEnvironment(
  config: MlxRuntimeConfig,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LC_ALL"] as const) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.LANG = source.LANG ?? "en_US.UTF-8";
  environment[mlxCacheLimitEnvironmentVariable] = String(config.cacheLimitMb);
  if (config.memoryLimitMb !== undefined) {
    environment[mlxMemoryLimitEnvironmentVariable] = String(config.memoryLimitMb);
  }
  return environment;
}

/** `serial` or `product`: the lane mode of a DEV run (F3 D29); ignored in packaged builds. */
export const aiLanesEnvironmentVariable = "MEMORA_AI_LANES";

const laneMilliseconds = z.number().int().positive().max(3_600_000);

/**
 * Typed configuration of the AI lane scheduler (F3 D29-D31): lane limits and their adaptation to
 * rate limits, the aging of background priorities, and the deadlines of local runtimes. Remote
 * deadlines and retries live in `aiRuntimeConfigSchema` (remote-execution.ts).
 */
export const aiLaneRuntimeConfigSchema = z
  .object({
    /** `serial` runs every lane at one call (golden and re-match runs); `product` uses the limits. */
    mode: z.enum(["product", "serial"]),
    lanes: z
      .object({
        /** Concurrent calls of one API-key provider configuration, and its upper bound under AIMD. */
        apiKeyMax: z.number().int().min(1).max(32),
        /** Concurrent calls of one ChatGPT/Codex OAuth configuration. */
        codexMax: z.number().int().min(1).max(32),
        /** The lowest limit a rate limit can halve a remote lane to. */
        minimum: z.number().int().min(1).max(32),
        /** Consecutive successful responses that raise a remote lane's limit by one. */
        increaseAfterSuccesses: z.number().int().min(1).max(10_000),
        /** Factor a rate-limited lane's limit is multiplied by (rounded down, never below `minimum`). */
        decreaseFactor: z.number().gt(0).lt(1),
        /**
         * Longest pause of a rate-limited lane. A longer stated reset (a plan limit of an hour) is
         * not waited out by every entry: after this the next call asks again and fails visibly.
         */
        maxPauseMs: laneMilliseconds
      })
      .strict(),
    aging: z
      .object({
        /** Waiting time after which a P3 entry competes as P2. */
        p3ToP2Ms: laneMilliseconds,
        /** Further waiting time after which a P2 entry (or an aged P3 entry) competes as P1. */
        p2ToP1Ms: laneMilliseconds
      })
      .strict(),
    breaker: z
      .object({
        /** Consecutive transient failures of a remote lane that open its breaker (F3 D32). */
        failureThreshold: z.number().int().min(1).max(1_000),
        /** How long an open breaker fails new entries fast before it lets one probe through. */
        openMs: laneMilliseconds
      })
      .strict(),
    localDeadlines: z
      .object({
        /** Total deadline of one local call per workload class, from its execution start. */
        totalMs: z
          .object({
            embed: laneMilliseconds,
            decide: laneMilliseconds,
            "write-fast": laneMilliseconds,
            "write-quality": laneMilliseconds,
            answer: laneMilliseconds
          })
          .strict(),
        /** Longest silence between tokens of a streamed local generation, once it started. */
        tokenStallMs: laneMilliseconds,
        /**
         * How long a local call may take to settle after its deadline cancelled it. A GGUF call
         * still running then is abandoned and its runtime is `wedged` until it is disposed.
         */
        graceMs: laneMilliseconds,
        /**
         * The longest one step of disposing a GGUF runtime may take (F4 D23): waiting for a load that
         * was aborted, then the model, then the engine. A step over it is abandoned and logged by name.
         */
        disposeMs: laneMilliseconds
      })
      .strict(),
    /** Which local models stay loaded (F3 D39); the embedder and the ranker are always kept. */
    residency: z
      .object({
        /** Idle time after the last call of the local generative model before it is unloaded. */
        generativeIdleUnloadMs: laneMilliseconds,
        /**
         * Memory kept free beyond the catalog minimums of the resident models. The writer stays
         * beside the ranker only when both fit with it; otherwise the ranker leaves while it runs.
         */
        headroomBytes: z.number().int().nonnegative().max(1_099_511_627_776),
        /**
         * Before a generative model loads, free plus inactive memory must exceed its catalog
         * minimum by this much; otherwise the call is refused (`blocked: memory`), never swapped.
         */
        loadMarginBytes: z.number().int().nonnegative().max(1_099_511_627_776)
      })
      .strict()
  })
  .strict();

export type AiLaneRuntimeConfig = z.infer<typeof aiLaneRuntimeConfigSchema>;
export type AiLocalDeadlines = AiLaneRuntimeConfig["localDeadlines"];
export interface AiLaneRuntimeConfigInput {
  mode?: AiLaneRuntimeConfig["mode"];
  lanes?: Partial<AiLaneRuntimeConfig["lanes"]>;
  aging?: Partial<AiLaneRuntimeConfig["aging"]>;
  breaker?: Partial<AiLaneRuntimeConfig["breaker"]>;
  localDeadlines?: Partial<Omit<AiLocalDeadlines, "totalMs">> & {
    totalMs?: Partial<AiLocalDeadlines["totalMs"]>;
  };
  residency?: Partial<AiLocalResidencyConfig>;
}
export type AiLocalResidencyConfig = AiLaneRuntimeConfig["residency"];

const gib = 1_024 ** 3;

/**
 * Local deadlines per class = min(cap, 3 x p99 rounded up) (F3 D31, T61), caps embed 30 s per batch,
 * decide 10 s per call, write-fast 180 s, write-quality 900 s, answer 300 s. The p99s are of the
 * recorded E6 runs on the owner's Mac (Qwen3.5-9B MLX writer, 2026-10-17) and of M1's ranker calls:
 * write-fast 46.4 s (62 calls) -> 140 s; write-quality 116.6 s (211 calls; the two calls above it
 * ran away to the 32,768-token cap for ~10 min) -> 350 s; decide 1.0 s for the MLX ranker (141
 * calls) but 6.1 s for the 9B generative decider (117 calls), so the cap binds. Embed batches and
 * local answers are not recorded yet and keep their caps. Lane values (cal.): B5 measures Codex.
 */
export const defaultAiLaneRuntimeConfig: AiLaneRuntimeConfig = {
  mode: "product",
  lanes: {
    apiKeyMax: 4,
    codexMax: 2,
    minimum: 1,
    increaseAfterSuccesses: 20,
    decreaseFactor: 0.5,
    maxPauseMs: 60_000
  },
  aging: { p3ToP2Ms: 60_000, p2ToP1Ms: 120_000 },
  breaker: { failureThreshold: 5, openMs: 30_000 },
  localDeadlines: {
    totalMs: {
      embed: 30_000,
      decide: 10_000,
      "write-fast": 140_000,
      "write-quality": 350_000,
      answer: 300_000
    },
    tokenStallMs: 60_000,
    graceMs: 2_000,
    disposeMs: 2_000
  },
  residency: { generativeIdleUnloadMs: 300_000, headroomBytes: 4 * gib, loadMarginBytes: gib }
};

/**
 * `MEMORA_DEV_LANE_PROBE=<report path>`: the DEV lane probe of F3 B5 (T47b), which measures the
 * Codex lane at several concurrencies. Ignored, and refused by the probe, in packaged builds.
 */
export const aiLaneProbeEnvironmentVariable = "MEMORA_DEV_LANE_PROBE";

/** What the DEV lane probe runs: the concurrencies it tries and how many calls it spends. */
export const aiLaneProbeConfigSchema = z
  .object({
    /** Concurrencies, ascending: the probe stops at the first level that sees a failure. */
    levels: z
      .array(z.number().int().min(1).max(8))
      .min(1)
      .max(8)
      .refine((levels) =>
        levels.every((level, index) => index === 0 || level > levels[index - 1]!)
      ),
    /** Calls of the whole probe, shared between the levels in proportion to their concurrency. */
    calls: z.number().int().min(1).max(500)
  })
  .strict()
  .refine((config) => config.calls >= config.levels.reduce((sum, level) => sum + level, 0));

export type AiLaneProbeConfig = z.infer<typeof aiLaneProbeConfigSchema>;

/** B5: about 40 decide-sized calls (about 60k tokens) at concurrency 1, 2 and 3. */
export const defaultAiLaneProbeConfig: AiLaneProbeConfig = { levels: [1, 2, 3], calls: 40 };

/**
 * Resolves the lane configuration. Precedence: explicit input, then `MEMORA_AI_LANES` in an
 * unpackaged build, then serial lanes for a golden run (`MEMORA_GOLDEN_RUN`) or a relation re-match
 * run (`MEMORA_RELATIONS_REMATCH`, F3 D5), then the defaults. An unknown value of the variable is
 * ignored.
 */
export function resolveAiLaneRuntimeConfig(
  input: AiLaneRuntimeConfigInput = {},
  context: { environment?: NodeJS.ProcessEnv; packaged?: boolean } = {}
): AiLaneRuntimeConfig {
  const environment = context.environment ?? process.env;
  const stated = context.packaged ? undefined : environment[aiLanesEnvironmentVariable]?.trim();
  const fromEnvironment =
    stated === "serial" || stated === "product"
      ? stated
      : !context.packaged &&
          (environment.MEMORA_GOLDEN_RUN?.trim() || environment.MEMORA_RELATIONS_REMATCH?.trim())
        ? "serial"
        : undefined;
  const { totalMs, ...localDeadlines } = input.localDeadlines ?? {};
  const lanes = { ...defaultAiLaneRuntimeConfig.lanes, ...definedEntries(input.lanes) };
  // The DEV lane probe tries concurrencies up to its top level, which the Codex lane must allow.
  if (!context.packaged && environment[aiLaneProbeEnvironmentVariable]?.trim())
    lanes.codexMax = Math.max(lanes.codexMax, ...defaultAiLaneProbeConfig.levels);
  return aiLaneRuntimeConfigSchema.parse({
    mode: input.mode ?? fromEnvironment ?? defaultAiLaneRuntimeConfig.mode,
    lanes,
    aging: { ...defaultAiLaneRuntimeConfig.aging, ...definedEntries(input.aging) },
    breaker: { ...defaultAiLaneRuntimeConfig.breaker, ...definedEntries(input.breaker) },
    localDeadlines: {
      ...defaultAiLaneRuntimeConfig.localDeadlines,
      ...definedEntries(localDeadlines),
      totalMs: { ...defaultAiLaneRuntimeConfig.localDeadlines.totalMs, ...definedEntries(totalMs) }
    },
    residency: { ...defaultAiLaneRuntimeConfig.residency, ...definedEntries(input.residency) }
  });
}

/** The total deadline of a local call of a workload class. */
export function localDeadlineMs(
  deadlines: AiLocalDeadlines,
  workloadClass: keyof AiLocalDeadlines["totalMs"]
): number {
  return deadlines.totalMs[workloadClass];
}

function definedEntries<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>;
}

function readLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = limitEnvironmentSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
