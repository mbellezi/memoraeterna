// The DEV knobs of the opt-in Decisions decider (F3 plan decision 30), read from the environment of
// a DEV run and ignored in a packaged build: a person's app never takes them from its environment.
import { decisionsDailyCapMaxUsd } from "@app/domain";

export interface DecisionsDevOptions {
  /** `MEMORA_RELATIONS_DECISIONS=on`: the decider is on without the opt-in, for a proof run. */
  devDecisions: boolean;
  /** `MEMORA_RELATIONS_DECISIONS_KEY_FILE`: a file holding the key, read instead of the secure store. */
  devDecisionsKeyFile?: string;
  /** `MEMORA_RELATIONS_DECISIONS_CAP_USD`: the day's spend cap, never above the schema's maximum. */
  devDecisionsCapUsd?: number;
}

export function decisionsDevOptions(
  env: Readonly<Record<string, string | undefined>>,
  packaged: boolean
): DecisionsDevOptions {
  if (packaged) return { devDecisions: false };
  const cap = Number(env.MEMORA_RELATIONS_DECISIONS_CAP_USD);
  const keyFile = env.MEMORA_RELATIONS_DECISIONS_KEY_FILE;
  return {
    devDecisions: env.MEMORA_RELATIONS_DECISIONS === "on",
    ...(keyFile ? { devDecisionsKeyFile: keyFile } : {}),
    // A cap of Infinity (or any figure above the maximum) is the maximum; zero, a negative figure
    // and text that is not a number leave the typed cap alone.
    ...(cap > 0 ? { devDecisionsCapUsd: Math.min(cap, decisionsDailyCapMaxUsd) } : {})
  };
}
