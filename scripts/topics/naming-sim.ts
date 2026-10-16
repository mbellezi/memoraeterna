// Naming in the replay (T29b, the `naming.renameDrift` row of spec section 9): the replay makes no
// model call, so naming is simulated from membership alone, as the service decides it (D11). A
// topic is named when it appears; an LLM-named topic is named again when the bottom-k membership
// sketch it was named with drifted by `renameDrift` or more (naming.ts `membershipDrift`). Several
// thresholds run side by side over the same tree: each keeps its own sketches, since a rename
// takes a new one. Calls are counted the way the service packs them: per tree level, at most
// `naming.maxTopicsPerCall` topics per call.
//
// Replay rows have synthetic content hashes (`rowContentHash`), so the sketch hashes item keys
// with a 32-bit mixer instead of the content hash; the estimate is the same bottom-k sketch.
import {
  getTopic,
  isLive,
  membershipDrift,
  membershipSketchSize,
  subtreeItems,
  walkTopics
} from "@app/domain/topic-tree";
import type { ItemKey, MembershipSketch, TopicTreeState } from "@app/domain/topic-tree";

/** A 32-bit mix of an item key (FNV-1a, then a murmur finalizer). */
export function itemHash(key: ItemKey): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** The bottom-k sketch of a topic's subtree members (naming.ts `membershipSketch`). */
export function replaySketch(
  state: TopicTreeState,
  topicId: string,
  size = membershipSketchSize
): MembershipSketch {
  const items = subtreeItems(state, topicId);
  const hashes = [...new Set(items.map(itemHash))].sort((a, b) => a - b).slice(0, size);
  return { n: items.length, hashes };
}

export interface NamingStep {
  /** Topics that appeared and got their first name (the same under every threshold). */
  named: number;
  /** Per threshold: topics named again because their members drifted. */
  renamed: Record<string, number>;
  /** Per threshold: model calls (first names plus renames), packed per level. */
  calls: Record<string, number>;
}

export interface NamingWeek {
  named: number;
  renamed: Record<string, number>;
  calls: Record<string, number>;
  /** Per threshold: the mean drift of the live named topics at the end (name staleness). */
  staleness: Record<string, number>;
  /** Live topics below the root at the end. */
  topics: number;
}

const key = (threshold: number): string => String(threshold);

export class NamingSimulator {
  private readonly sketches = new Map<number, Map<string, MembershipSketch>>();
  /** Per threshold: the most calls one step (one simulated day) made. */
  private readonly peak = new Map<number, number>();
  private week: { named: number; renamed: Map<number, number>; calls: Map<number, number> };

  constructor(
    readonly thresholds: readonly number[],
    private readonly maxTopicsPerCall: number
  ) {
    for (const threshold of thresholds) this.sketches.set(threshold, new Map());
    this.week = this.emptyWeek();
  }

  private emptyWeek() {
    return {
      named: 0,
      renamed: new Map(this.thresholds.map((threshold) => [threshold, 0])),
      calls: new Map(this.thresholds.map((threshold) => [threshold, 0]))
    };
  }

  /** Live topics below the root with their depth, and their current sketches. */
  private live(state: TopicTreeState): Map<string, { depth: number; sketch: MembershipSketch }> {
    const output = new Map<string, { depth: number; sketch: MembershipSketch }>();
    walkTopics(state, (node, depth) => {
      if (node.id === state.rootId || !isLive(node)) return;
      output.set(node.id, { depth, sketch: replaySketch(state, node.id) });
    });
    return output;
  }

  /** One naming pass after a day's changes: names new topics, renames drifted ones. */
  step(state: TopicTreeState): NamingStep {
    const live = this.live(state);
    const output: NamingStep = { named: 0, renamed: {}, calls: {} };
    let namedNow = 0;
    for (const threshold of this.thresholds) {
      const sketches = this.sketches.get(threshold) as Map<string, MembershipSketch>;
      for (const id of [...sketches.keys()]) if (!live.has(id)) sketches.delete(id);
      const perDepth = new Map<number, number>();
      let named = 0;
      let renamed = 0;
      for (const [id, { depth, sketch }] of live) {
        const then = sketches.get(id);
        if (then === undefined) named += 1;
        else if (membershipDrift(then, sketch) >= threshold) renamed += 1;
        else continue;
        sketches.set(id, sketch);
        perDepth.set(depth, (perDepth.get(depth) ?? 0) + 1);
      }
      let calls = 0;
      for (const count of perDepth.values()) calls += Math.ceil(count / this.maxTopicsPerCall);
      namedNow = named;
      output.renamed[key(threshold)] = renamed;
      output.calls[key(threshold)] = calls;
      this.peak.set(threshold, Math.max(this.peak.get(threshold) ?? 0, calls));
      this.week.renamed.set(threshold, (this.week.renamed.get(threshold) ?? 0) + renamed);
      this.week.calls.set(threshold, (this.week.calls.get(threshold) ?? 0) + calls);
    }
    output.named = namedNow;
    this.week.named += namedNow;
    return output;
  }

  /** The week's counts and the staleness of the names now; starts the next week. */
  takeWeek(state: TopicTreeState): NamingWeek {
    const live = this.live(state);
    const staleness: Record<string, number> = {};
    for (const threshold of this.thresholds) {
      const sketches = this.sketches.get(threshold) as Map<string, MembershipSketch>;
      let total = 0;
      let count = 0;
      for (const [id, { sketch }] of live) {
        const then = sketches.get(id);
        if (!then) continue;
        total += membershipDrift(then, sketch);
        count += 1;
      }
      staleness[key(threshold)] = count > 0 ? total / count : 0;
    }
    const week: NamingWeek = {
      named: this.week.named,
      renamed: Object.fromEntries(
        [...this.week.renamed].map(([threshold, count]) => [key(threshold), count])
      ),
      calls: Object.fromEntries(
        [...this.week.calls].map(([threshold, count]) => [key(threshold), count])
      ),
      staleness,
      topics: live.size
    };
    this.week = this.emptyWeek();
    return week;
  }

  /** Per threshold: the most calls of one step so far. */
  peakDayCalls(): Record<string, number> {
    return Object.fromEntries(
      this.thresholds.map((threshold) => [key(threshold), this.peak.get(threshold) ?? 0])
    );
  }

  /** Whether a topic is named under a threshold (tests). */
  has(threshold: number, topicId: string, state: TopicTreeState): boolean {
    return this.sketches.get(threshold)?.has(topicId) === true && isLive(getTopic(state, topicId));
  }
}
