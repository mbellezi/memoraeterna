// The plan of a relation re-match run (F3 T52b, spec 3.17): which roots are released in which order,
// and what the visibility fence lets retrieval see while it runs. Pure; no database, no clock.
import type { RetrievalFence } from "@app/db";
import { createRng } from "@app/domain/topic-tree";

/**
 * The order roots are released in. `manifest` is the library's own order within each partition,
 * tuning roots first (S0, R16). `seeded` shuffles each partition in turn (tuning, then held-out) with
 * one generator, `createRng(seed).shuffle` of the topic-tree engine (Mulberry32, Fisher-Yates from
 * the end), over the partition's roots in manifest order: S1 is 20261031 and S2 is 20261032 (spec 5.3).
 * Anything that must reproduce an order offline uses the same call.
 */
export type RematchOrder = { kind: "manifest" } | { kind: "seeded"; seed: number };

/**
 * `arrival` releases roots one at a time behind the visibility fence, each as soon as the previous
 * root's decide step committed (back-to-back, with no wait for link jobs). `burst` is the batch
 * reference: every root is visible from the start, decided in manifest order.
 */
export type RematchMode = { kind: "arrival"; order: RematchOrder } | { kind: "burst" };

export interface RematchRecord {
  id: string;
  title: string;
  /** Notes created from this source that matching considers (not rejected, archived or superseded). */
  notes: number;
}

export interface RematchRoot {
  id: string;
  title: string;
  /** `tuning` or `holdout` for the fixture; null for a library with no partitions. */
  partition: string | null;
  /** The root itself and the sources below it that hold notes, in ingestion order. */
  records: RematchRecord[];
  notes: number;
}

export class RematchPlanError extends Error {
  public constructor(
    public readonly code: "invalidKnob" | "mappingMismatch" | "unknownRoot" | "noRoots",
    message: string
  ) {
    super(message);
    this.name = "RematchPlanError";
  }
}

const maxSeed = 4_294_967_295;

/** Reads `arrival:<seed>` (`manifest`, `S0` or a positive integer) or `burst`. */
export function parseRematchKnob(value: string): RematchMode {
  const text = value.trim();
  if (text === "burst") return { kind: "burst" };
  const match = /^arrival:(.+)$/u.exec(text);
  if (match) {
    const seed = match[1]!.trim();
    if (seed === "manifest" || seed === "S0")
      return { kind: "arrival", order: { kind: "manifest" } };
    if (/^[1-9]\d{0,9}$/u.test(seed) && Number(seed) <= maxSeed)
      return { kind: "arrival", order: { kind: "seeded", seed: Number(seed) } };
  }
  throw new RematchPlanError(
    "invalidKnob",
    "MEMORA_RELATIONS_REMATCH must be burst, arrival:manifest (S0) or arrival:<seed> with a seed from 1 to 4294967295"
  );
}

const partitionOrder = ["tuning", "holdout"] as const;

/** The partitions in release order: tuning, held-out, any other by name, then roots with none. */
function partitionGroups(roots: readonly RematchRoot[]): RematchRoot[][] {
  const labels = [...new Set(roots.map((root) => root.partition))];
  const rank = (label: string | null) =>
    label === null
      ? partitionOrder.length + 1
      : (partitionOrder as readonly string[]).includes(label)
        ? (partitionOrder as readonly string[]).indexOf(label)
        : partitionOrder.length;
  labels.sort((a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b)));
  return labels.map((label) => roots.filter((root) => root.partition === label));
}

/**
 * The release order of `roots`, given in manifest order. Every root appears once. Tuning roots come
 * before held-out roots in every order ("held-out arrives after the library"), also when the raw
 * manifest interleaves them.
 */
export function releaseOrder(roots: readonly RematchRoot[], mode: RematchMode): RematchRoot[] {
  const seeded = mode.kind === "arrival" && mode.order.kind === "seeded";
  const rng = seeded ? createRng(mode.order.kind === "seeded" ? mode.order.seed : 1) : null;
  return partitionGroups(roots).flatMap((group) => (rng ? rng.shuffle([...group]) : group));
}

/** The partitions of a fixture mapping, by root title. */
export function assignPartitions(
  roots: readonly Omit<RematchRoot, "partition">[],
  partitionOfTitle: ReadonlyMap<string, string>
): RematchRoot[] {
  const missing = roots.filter((root) => !partitionOfTitle.has(root.title.trim()));
  if (missing.length > 0)
    throw new RematchPlanError(
      "mappingMismatch",
      `${missing.length} library roots are not in the fixture mapping, for example ${missing
        .slice(0, 3)
        .map((root) => `"${root.title}"`)
        .join(", ")}`
    );
  return roots.map((root) => ({ ...root, partition: partitionOfTitle.get(root.title.trim())! }));
}

export interface RematchPlan {
  /** The roots to release, in release order. */
  order: RematchRoot[];
  /** Roots with notes that are not released: visible and matched already, or hidden for good. */
  others: RematchRoot[];
  /** Roots with no note to match. */
  withoutNotes: RematchRoot[];
}

/** Stands for the title of two roots in a lookup, so that the title selects neither. */
const ambiguous = Object.freeze({
  id: "",
  title: "",
  partition: null,
  records: [],
  notes: 0
}) as RematchRoot;

/**
 * Chooses and orders the roots of a run. `selection` names the roots to release (by title or ID, in
 * the order of the list, which is the manifest order of the run); absent, every root with notes is
 * released in library order.
 */
export function buildRematchPlan(
  library: readonly RematchRoot[],
  mode: RematchMode,
  selection: readonly string[] | null = null
): RematchPlan {
  const withNotes = library.filter((root) => root.notes > 0);
  const withoutNotes = library.filter((root) => root.notes === 0);
  let chosen = withNotes;
  if (selection) {
    const byKey = new Map<string, RematchRoot>();
    for (const root of withNotes) {
      byKey.set(root.id, root);
      // A title that names two roots is ambiguous and cannot select one of them.
      byKey.set(root.title.trim(), byKey.has(root.title.trim()) ? ambiguous : root);
    }
    chosen = selection.map((key) => {
      const root = byKey.get(key.trim());
      if (!root || root === ambiguous)
        throw new RematchPlanError(
          "unknownRoot",
          `The roots list names "${key}", which is no root with notes (or its title names two roots)`
        );
      return root;
    });
    if (new Set(chosen).size !== chosen.length)
      throw new RematchPlanError("unknownRoot", "The roots list names a root twice");
  }
  if (chosen.length === 0) throw new RematchPlanError("noRoots", "The run has no root to release");
  const order =
    mode.kind === "burst"
      ? releaseOrder(chosen, { kind: "arrival", order: { kind: "manifest" } })
      : releaseOrder(chosen, mode);
  const released = new Set(order);
  return { order, others: withNotes.filter((root) => !released.has(root)), withoutNotes };
}

/**
 * What retrieval may see during a run: `visible` roots from the start (the background that is
 * already matched, or every root in a burst) and the roots released so far. The fence is a snapshot
 * handed to each call, so a release never changes a statement already running.
 */
export class RematchFence {
  private readonly visible: string[];
  private readonly seen: Set<string>;

  public constructor(initiallyVisible: readonly string[] = []) {
    this.visible = [...initiallyVisible];
    this.seen = new Set(this.visible);
  }

  /** Makes a root's notes visible, together with everything below it. */
  public release(rootId: string): void {
    if (this.seen.has(rootId)) return;
    this.seen.add(rootId);
    this.visible.push(rootId);
  }

  public isVisible(rootId: string): boolean {
    return this.seen.has(rootId);
  }

  public visibleRootIds(): string[] {
    return [...this.visible];
  }

  public retrievalFence(): RetrievalFence {
    return { rootSourceItemIds: this.visibleRootIds() };
  }
}
