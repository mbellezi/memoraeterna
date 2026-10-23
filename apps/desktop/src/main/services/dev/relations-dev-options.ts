// DEV knobs of the measurement campaigns that change one typed value of the relations configuration
// for a run (F3 T63's B1 sample, F4 C2's two neighbours). Read from the environment of a DEV run and
// ignored in a packaged build: a person's app never takes them from its environment.
import { relationsConfig, type RelationsConfig } from "@app/domain";

export const helperBatchKnob = "MEMORA_RELATIONS_HELPER_BATCH";
export const discoveryNeighboursKnob = "MEMORA_RELATIONS_DISCOVERY_NEIGHBOURS";

/**
 * The helper batch size of the MLX ranker for this run (B1 measures the bf16 perturbation of batch 1
 * against the product's 16): `MEMORA_RELATIONS_HELPER_BATCH=<1 to 64>`, DEV only. Null when unset or
 * packaged. A value that is not a whole number from 1 to 64 throws, so a run never measures the
 * product's batch while believing it measures another.
 */
export function helperBatchOverride(
  env: Readonly<Record<string, string | undefined>>,
  packaged: boolean
): number | null {
  if (packaged) return null;
  const text = env[helperBatchKnob]?.trim();
  if (!text) return null;
  if (!/^[1-9]\d?$/u.test(text) || Number(text) > 64)
    throw new Error(`${helperBatchKnob} must be a whole number from 1 to 64`);
  return Number(text);
}

/**
 * The source discovery neighbours of this run (C2 measures two before D21's rule may flip the
 * shipped one): `MEMORA_RELATIONS_DISCOVERY_NEIGHBOURS=1|2`, DEV only. Null when unset or packaged;
 * any other value throws.
 */
export function discoveryNeighboursOverride(
  env: Readonly<Record<string, string | undefined>>,
  packaged: boolean
): 1 | 2 | null {
  if (packaged) return null;
  const text = env[discoveryNeighboursKnob]?.trim();
  if (!text) return null;
  if (text !== "1" && text !== "2") throw new Error(`${discoveryNeighboursKnob} must be 1 or 2`);
  return text === "1" ? 1 : 2;
}

/** The typed configuration of this run: the shipped one, with what the knobs set, if any. */
export function relationsConfigForRun(
  env: Readonly<Record<string, string | undefined>>,
  packaged: boolean,
  base: RelationsConfig = relationsConfig
): RelationsConfig | undefined {
  const helperBatchSize = helperBatchOverride(env, packaged);
  const neighbours = discoveryNeighboursOverride(env, packaged);
  if (helperBatchSize === null && neighbours === null) return undefined;
  return {
    ...base,
    ...(helperBatchSize === null ? {} : { decide: { ...base.decide, helperBatchSize } }),
    ...(neighbours === null ? {} : { discovery: { ...base.discovery, neighbours } })
  };
}
