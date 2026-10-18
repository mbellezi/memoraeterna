// When the catalog-header refresh may run, and what it may spend (plan decisions 26 and 27, F3 T53h).
//
// The refresh rebuilds a hierarchy root's header chunk after a late summary and brings an upgraded
// library up to date: it embeds the header and extracts its graph again. A measurement run pins its
// extraction and replays a recording that holds no such call, so it must never queue the refresh, and
// it says so in its summary. The live product keeps it on, and spends remotely at a daily cap, so a
// large upgraded library never bursts graph calls at the app's start.
import type { Queryable } from "@app/db";

import { isExtractionPinned } from "./extraction-pin.js";

/** The environment a policy reads: the process's, or a runner's own. */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/** The typed configuration of the refresh's spending. */
export const catalogHeaderConfig = {
  /**
   * Roots per local day whose graph is extracted again on a remote route; the roots left wait for
   * the next day. A local route is not counted.
   */
  dailyRemoteRoots: 50,
  /** The setting that holds the day's count: `{ day, calls, interactiveCalls }`. */
  dailyRootsSettingKey: "catalogHeader.dailyRoots"
} as const;

/** Why a refresh is off. */
export type CatalogHeaderOffReason =
  | "switch"
  | "relations_rematch"
  | "golden_run"
  | "extraction_pin"
  | "cassette_replay"
  | "topics_e2e";

export type CatalogHeaderPolicy =
  { refresh: "on"; reason: null } | { refresh: "off"; reason: CatalogHeaderOffReason };

/**
 * The DEV knobs of a measurement run: the relation re-match, the golden runner and its pairs and
 * probe, and the extraction pin. Reading one needs nothing but the environment, so the policy is
 * known when the job supervisor starts, before the runner has prepared anything.
 */
const measurementKnobs: ReadonlyArray<
  readonly [name: string, reason: CatalogHeaderOffReason, value?: string]
> = [
  ["MEMORA_RELATIONS_REMATCH", "relations_rematch"],
  ["MEMORA_GOLDEN_RUN", "golden_run"],
  ["MEMORA_GOLDEN_SOURCE_PAIRS", "golden_run"],
  ["MEMORA_GOLDEN_NOTE_PAIRS", "golden_run"],
  ["MEMORA_GOLDEN_SCHEMA_PROBE", "golden_run"],
  ["MEMORA_GOLDEN_PIN", "extraction_pin", "extraction"]
];

let held: CatalogHeaderOffReason | null = null;

/**
 * A DEV runner that works in this process and not through the environment (the E6 runner) holds the
 * refresh off for its run, and releases it with `null` when the run ends.
 */
export function holdCatalogHeaderRefresh(reason: CatalogHeaderOffReason | null): void {
  held = reason;
}

/**
 * Whether the refresh may run. `MEMORA_CATALOG_HEADERS=off` turns it off and `on` forces it on (a
 * live proof on a recorded profile); otherwise a measurement run turns it off: a runner that holds
 * it, a pinned extraction, a DEV measurement knob, or a cassette replay. The product sets none.
 */
export function catalogHeaderPolicy(env: EnvLike = process.env): CatalogHeaderPolicy {
  const switchValue = env.MEMORA_CATALOG_HEADERS?.trim().toLowerCase();
  if (switchValue === "off") return { refresh: "off", reason: "switch" };
  if (switchValue === "on") return { refresh: "on", reason: null };
  if (held) return { refresh: "off", reason: held };
  for (const [name, reason, value] of measurementKnobs) {
    const set = env[name]?.trim();
    if (set && (value === undefined || set.toLowerCase() === value))
      return { refresh: "off", reason };
  }
  // A runner that set the pin in this process without a knob of its own to read from.
  if (isExtractionPinned()) return { refresh: "off", reason: "extraction_pin" };
  if (env.MEMORA_AI_CASSETTE?.trim().toLowerCase() === "replay")
    return { refresh: "off", reason: "cassette_replay" };
  return { refresh: "on", reason: null };
}

export function catalogHeaderRefreshEnabled(env: EnvLike = process.env): boolean {
  return catalogHeaderPolicy(env).refresh === "on";
}

/** What a measurement run records in its summary: the policy it ran under and the jobs it saw. */
export interface CatalogHeaderFacts {
  refresh: "on" | "off";
  reason: CatalogHeaderOffReason | null;
  /** `catalog-header` jobs created since the app started: 0 in a measurement run. */
  jobs: number;
}

/** The policy and the number of refresh jobs this app run has queued (`since`: when it started). */
export async function readCatalogHeaderFacts(
  db: Queryable,
  options: { env?: EnvLike; since?: Date } = {}
): Promise<CatalogHeaderFacts> {
  const policy = catalogHeaderPolicy(options.env);
  const since = options.since ?? new Date(Date.now() - process.uptime() * 1000);
  const found = await db.query<{ jobs: number }>(
    `select count(*)::int as jobs from jobs where type = 'catalog-header' and created_at >= $1`,
    [since]
  );
  return { refresh: policy.refresh, reason: policy.reason, jobs: Number(found.rows[0]?.jobs ?? 0) };
}
