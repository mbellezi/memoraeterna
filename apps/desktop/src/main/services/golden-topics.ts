/**
 * G1 (F2 D23): how a golden run treats the Topic Tree Engine's AI work.
 *
 * - `MEMORA_GOLDEN_TOPICS=deterministic` (the default in a golden run): the engine places and
 *   rebalances but makes no topic AI call (no gate, naming, Areas, labels or overview), so existing
 *   replays keep their cassettes and timing.
 * - `full`: every topic call runs. F2 measurements use it in `record` mode on cassette copies, with
 *   the topic barrier below, so the recorded `topic.*` calls replay at 0 misses.
 *
 * The knob is read only when `MEMORA_GOLDEN_RUN` is set and the build is not packaged. Every other
 * run (DEV, packaged, E6) behaves as `full` and ignores both variables, whatever their value.
 *
 * The barrier makes the items present at every build and naming call a function of the manifest
 * order instead of lane timing: topic jobs stay queued while a source ingests, and the light lane is
 * drained at each source boundary (`per-source`, the default) or once after the whole batch
 * (`batch`). The topic service owns the hold; the golden runner drives it (`golden-runner.ts`).
 */

export const goldenTopicsKnob = "MEMORA_GOLDEN_TOPICS";
export const goldenTopicsArrivalKnob = "MEMORA_GOLDEN_TOPICS_ARRIVAL";

export const goldenTopicsModes = ["deterministic", "full"] as const;
export type GoldenTopicsMode = (typeof goldenTopicsModes)[number];

export const goldenTopicsArrivals = ["per-source", "batch"] as const;
export type GoldenTopicsArrival = (typeof goldenTopicsArrivals)[number];

export interface GoldenTopicsConfig {
  /** True only for a DEV golden run; false means the knobs were not read. */
  golden: boolean;
  mode: GoldenTopicsMode;
  /** When a `full` golden run lets topic jobs run; `per-source` outside a golden run too. */
  arrival: GoldenTopicsArrival;
}

/** What every non-golden run behaves as. */
export const nonGoldenTopicsConfig: GoldenTopicsConfig = {
  golden: false,
  mode: "full",
  arrival: "per-source"
};

/**
 * Reads G1. Outside a golden run (`MEMORA_GOLDEN_RUN` unset, or a packaged build) both variables
 * are ignored without an error. Inside one, an unknown value is an error, and an arrival only
 * makes sense with `full` (a deterministic run has no topic AI work to schedule).
 */
export function readGoldenTopicsConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: { isPackaged: boolean }
): GoldenTopicsConfig {
  if (options.isPackaged || !env.MEMORA_GOLDEN_RUN?.trim()) return nonGoldenTopicsConfig;
  const rawMode = env[goldenTopicsKnob]?.trim();
  const mode = (rawMode || "deterministic") as GoldenTopicsMode;
  if (!goldenTopicsModes.includes(mode))
    throw new Error(`${goldenTopicsKnob} must be deterministic or full (or unset)`);
  const rawArrival = env[goldenTopicsArrivalKnob]?.trim();
  const arrival = (rawArrival || "per-source") as GoldenTopicsArrival;
  if (!goldenTopicsArrivals.includes(arrival))
    throw new Error(`${goldenTopicsArrivalKnob} must be per-source or batch (or unset)`);
  if (rawArrival && mode !== "full")
    throw new Error(`${goldenTopicsArrivalKnob} only applies with ${goldenTopicsKnob}=full`);
  return { golden: true, mode, arrival };
}

/**
 * The topic service's job barrier (spec 3.5 `holdTopicJobs`/`releaseTopicJobs`). While held, topic
 * jobs stay `queued` (nothing is dropped) and run, in content-key order, after the release.
 */
export interface GoldenTopicBarrier {
  hold(): void | Promise<void>;
  release(): void | Promise<void>;
}

/** Job types of the Topic Tree Engine: `topic-place`, `topic-gate`, `topic-name`, and so on. */
export const topicJobTypePrefix = "topic-";
