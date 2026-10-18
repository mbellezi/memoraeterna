// DEV knobs of F3's measurement campaigns that change one typed value of the relations configuration
// for a run (T63's B1 sample). Read from the environment of a DEV run and ignored in a packaged build:
// a person's app never takes them from its environment.
import { relationsConfig, type RelationsConfig } from "@app/domain";

export const helperBatchKnob = "MEMORA_RELATIONS_HELPER_BATCH";

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

/** The typed configuration of this run: the shipped one, with the helper batch the knob set, if any. */
export function relationsConfigForRun(
  env: Readonly<Record<string, string | undefined>>,
  packaged: boolean,
  base: RelationsConfig = relationsConfig
): RelationsConfig | undefined {
  const helperBatchSize = helperBatchOverride(env, packaged);
  if (helperBatchSize === null) return undefined;
  return { ...base, decide: { ...base.decide, helperBatchSize } };
}
