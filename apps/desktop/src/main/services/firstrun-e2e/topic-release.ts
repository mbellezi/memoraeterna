// When the first-run end-to-end test (F4 T90, E6) lets the topic jobs run: policy a2 (orchestrator
// decision of 10-24, card E6A2). The harness holds the topic jobs while the imports run, so every
// release is a point a replay reproduces. The product never holds them: the old barrier (one release
// after both imports' heavy work) was the harness's own and put T1 at 22 min on E6's clock.
//
// a2: the topic work is released at the first division boundary where the first source has at
// least `firstSourceNotes` current notes (the topic bootstrap's own minimum is 12), drained on the
// light lane, then held again; then once per source, after its heavy work. Optional hardening
// (`repeatUntilT1`): after the first release, every later division boundary releases again until T1
// is seen. A boundary is the end of one of the source's heavy jobs (a division of an import; the
// self-test's notes arrive seeded, so its note embeddings stand in for the divisions). Each decision
// is a function of what the boundary read, never of the time, so two replays release at the same
// points. Pure: the runner reads the boundaries and runs the releases.
import { z } from "zod";

/** The only policy this harness runs; a record names it so a replay refuses another. */
export const topicReleasePolicies = ["a2"] as const;
export type TopicReleasePolicy = (typeof topicReleasePolicies)[number];

/**
 * The harness's own heavy job that runs a division release, registered through the supervisor's
 * DEV heavy jobs. A job, not a wait inside the import: the next division's import and the link jobs
 * share the root's scope, so an import row held `running` would keep the link jobs T1 needs from
 * being claimed. Queued with no scope (no Gardener kind: product code never queues it) and above
 * every heavy priority (imports 0, note embeddings 10), so in drain mode the heavy lane claims it
 * right after the boundary's link jobs and before the next division.
 */
export const topicReleaseJob = "firstrun-topic-release";
export const topicReleasePriority = 1_000;

/** The topic bootstrap keeps one topic up to its minimum of 12 items (topic-tree config `minItems`). */
export const defaultTopicReleaseNotes = 12;

/**
 * How the harness runs the link jobs of relations v2: `drain` (one at a time in admission order, the
 * heavy lane waiting for them), so the link prompts are a function of the arrival order.
 */
export const harnessLinkRuntimes = ["drain"] as const;
export type HarnessLinkRuntime = (typeof harnessLinkRuntimes)[number];
export const harnessLinkRuntime: HarnessLinkRuntime = "drain";

export const TopicReleaseSettingsSchema = z
  .object({
    policy: z.enum(topicReleasePolicies),
    /** The first source's current notes at the boundary of the first release. */
    firstSourceNotes: z.number().int().positive(),
    /** After the first release, release again at every division boundary until T1 is seen. */
    repeatUntilT1: z.boolean()
  })
  .strict();
export type TopicReleaseSettings = z.infer<typeof TopicReleaseSettingsSchema>;

export function topicReleaseSettings(
  overrides: Partial<Omit<TopicReleaseSettings, "policy">> = {}
): TopicReleaseSettings {
  return {
    policy: "a2",
    firstSourceNotes: overrides.firstSourceNotes ?? defaultTopicReleaseNotes,
    repeatUntilT1: overrides.repeatUntilT1 ?? false
  };
}

export type ReleaseSource = "first" | "second";

/** What a boundary read: whose heavy job ended, that source's notes, and whether T1 stands. */
export interface DivisionBoundary {
  source: ReleaseSource;
  notes: number;
  t1Seen: boolean;
}

/** One release of the topic work, as the report lists it. */
export interface TopicRelease {
  /** `division`: at a division boundary (a2); `source`: after a source's heavy work. */
  at: "division" | "source";
  source: ReleaseSource;
  /** 1-based division of the source whose end released it; null for a source release. */
  division: number | null;
  /** The source's current notes when the release was decided. */
  notes: number;
  /** Milliseconds since T0 the topic jobs were released, and when the light lane had drained. */
  releasedAtMs: number | null;
  drainedAtMs: number | null;
  /** `drained`, or why the drain ended early (a miss, the token cap, the lane budget, a ranker). */
  outcome: string;
}

/** The divisions of each source and whether a release has run: decides at each boundary. */
export class TopicReleasePlan {
  private readonly divisions: Record<ReleaseSource, number> = { first: 0, second: 0 };
  private released = false;
  /** T1 stands once seen: no boundary after it releases. */
  private t1Seen = false;

  public constructor(public readonly settings: TopicReleaseSettings) {}

  /** Counts the boundary and says whether the topic work is released there, and at which division. */
  public boundary(boundary: DivisionBoundary): { release: boolean; division: number } {
    this.divisions[boundary.source] += 1;
    const division = this.divisions[boundary.source];
    this.t1Seen ||= boundary.t1Seen;
    const release = this.t1Seen
      ? false
      : this.released
        ? this.settings.repeatUntilT1
        : boundary.source === "first" && boundary.notes >= this.settings.firstSourceNotes;
    if (release) this.released = true;
    return { release, division };
  }

  /** A source release ran (after a source's heavy work): later boundaries count as repeats. */
  public sourceReleased(): void {
    this.released = true;
  }

  public divisionsOf(source: ReleaseSource): number {
    return this.divisions[source];
  }
}

/**
 * Why a replay cannot use a cassette recorded under another release policy or link runtime (a
 * different order of the same calls misses); null when they match. A record from before E6A2 names
 * neither: it was made under the both-imports barrier and the product link runtime.
 */
export function releaseMismatch(
  recorded: {
    topicRelease?: TopicReleaseSettings | undefined;
    linkRuntime?: HarnessLinkRuntime | undefined;
  },
  settings: TopicReleaseSettings
): string | null {
  if (!recorded.topicRelease || !recorded.linkRuntime)
    return (
      "The cassette was recorded before the a2 topic release and the drain-mode link runtime " +
      "(the both-imports barrier): its calls come in another order, so record again"
    );
  if (recorded.linkRuntime !== harnessLinkRuntime)
    return `The cassette was recorded with the ${recorded.linkRuntime} link runtime, not ${harnessLinkRuntime}`;
  const theirs = recorded.topicRelease;
  if (theirs.policy !== settings.policy)
    return `The cassette was recorded with the ${theirs.policy} topic release, not ${settings.policy}`;
  if (theirs.firstSourceNotes !== settings.firstSourceNotes)
    return (
      `The cassette released the topic work at ${theirs.firstSourceNotes} first-source notes, not ` +
      `${settings.firstSourceNotes}: replay it with --topic-release-notes ${theirs.firstSourceNotes}`
    );
  if (theirs.repeatUntilT1 !== settings.repeatUntilT1)
    return theirs.repeatUntilT1
      ? "The cassette repeated the release until T1: replay it with --topic-release-repeat"
      : "The cassette released once at a division boundary: replay it without --topic-release-repeat";
  return null;
}
