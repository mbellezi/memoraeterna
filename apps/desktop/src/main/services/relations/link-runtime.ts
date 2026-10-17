// How this process runs the link jobs of relations v2 (F3 D24, D26, 5.6). The product runs them
// with the `relations` worker's full pool, small-source coalescing and the daily cap. DEV tooling
// that replays or measures (a golden run, T52b's re-match harness) switches to drain mode: one link
// job at a time, first in, first out, no coalescing and no daily counting, and the heavy lane claims
// its next job only once the relation jobs queued so far have run (job-supervisor.ts), so every
// prompt is a function of the arrival order and two replays give the same relations.
// `MEMORA_GOLDEN_RELATIONS=local` also switches relation remote calls off for a non-regression
// replay (R3): pairs with no cached typing are persisted untyped and discovery is deferred.

export const goldenRelationsKnob = "MEMORA_GOLDEN_RELATIONS";

export const goldenRelationsModes = ["live", "local"] as const;
export type GoldenRelationsMode = (typeof goldenRelationsModes)[number];

export interface RelationLinkRuntime {
  /**
   * One link job at a time in admission order, no coalescing, no daily counting, and the heavy lane
   * held while relation jobs are pending.
   */
  drain: boolean;
  /** No remote relation call: untyped persistence, discovery deferred. */
  remoteCallsOff: boolean;
}

export const productLinkRuntime: Readonly<RelationLinkRuntime> = Object.freeze({
  drain: false,
  remoteCallsOff: false
});

let current: RelationLinkRuntime = { ...productLinkRuntime };

/** Sets the link runtime of this process (DEV tooling, before its run starts). */
export function setRelationLinkRuntime(runtime: Partial<RelationLinkRuntime>): void {
  current = { ...current, ...runtime };
}

/** Back to the product runtime (tests, and a tool whose run ended). */
export function resetRelationLinkRuntime(): void {
  current = { ...productLinkRuntime };
}

export function relationLinkRuntime(): Readonly<RelationLinkRuntime> {
  return current;
}

/**
 * Reads `MEMORA_GOLDEN_RELATIONS` for a golden run: `live` (the default) or `local`. Outside a
 * golden run (`MEMORA_GOLDEN_RUN` unset) or in a packaged build the variable is ignored.
 */
export function readGoldenRelationsMode(
  env: Readonly<Record<string, string | undefined>>,
  options: { isPackaged: boolean }
): GoldenRelationsMode | null {
  if (options.isPackaged || !env.MEMORA_GOLDEN_RUN?.trim()) return null;
  const value = (env[goldenRelationsKnob]?.trim() || "live") as GoldenRelationsMode;
  if (!goldenRelationsModes.includes(value))
    throw new Error(
      `${goldenRelationsKnob} must be ${goldenRelationsModes.join(" or ")} (or unset)`
    );
  return value;
}

/** The link runtime of a golden run: drain mode, with relation remote calls off under `local`. */
export function goldenLinkRuntime(mode: GoldenRelationsMode): RelationLinkRuntime {
  return { drain: true, remoteCallsOff: mode === "local" };
}
