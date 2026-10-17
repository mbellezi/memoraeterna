// The registration of the re-match harness in the job supervisor (F3 T52b). It is separate and
// small because the supervisor is built at startup, before a run is prepared: it gets this registry
// then, and the harness binds its handler once its checks passed.
import type { JobRecord, JsonObject } from "@app/db";

import type { HeavyJobRegistry } from "../job-lanes.js";

/** The DEV heavy job that runs a re-match. */
export const rematchJobType = "relation-rematch";

export type RematchHandler = (job: JobRecord, signal: AbortSignal) => Promise<JsonObject>;

export interface RematchJobSlot {
  registry: HeavyJobRegistry;
  bind(handler: RematchHandler): void;
}

/** A claim before the handler is bound fails the job. */
export function createRematchJobSlot(): RematchJobSlot {
  let handler: RematchHandler | null = null;
  return {
    registry: {
      [rematchJobType]: {
        execute: async (job, signal) => {
          if (!handler) throw new Error("The re-match harness is not prepared");
          return handler(job, signal);
        }
      }
    },
    bind: (next) => {
      handler = next;
    }
  };
}
