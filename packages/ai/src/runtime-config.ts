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
    /** Deadline of one request from the moment it starts executing, not from its wait for a turn. */
    requestTimeoutMs: z.number().int().min(100).max(3_600_000),
    /** Deadline of `health`, which also pays the process start. */
    healthTimeoutMs: z.number().int().min(100).max(600_000),
    /** How long a killed helper gets to exit after SIGTERM before it receives SIGKILL. */
    killGraceMs: z.number().int().min(10).max(60_000),
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

function readLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = limitEnvironmentSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
