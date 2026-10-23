import type { AiWorkloadClass, LaneAdmission } from "@app/ai";
import {
  BackgroundBlockedError,
  autonomyHoldsKind,
  autonomyRefusesCall,
  defaultGardenerConfig,
  gardenerBlocker,
  gardenerBlockerKey,
  gardenerKindPolicy,
  highestGardenerBlocker,
  type GardenerBlocker,
  type GardenerBlockerKey,
  type GardenerConfig,
  type GardenerKindPolicy,
  type KnowledgeControls
} from "@app/domain";

import type { PowerSnapshot } from "./power-signals.js";

/**
 * A further gate on a kind (spec 3.1 "gate at claim": no route, no decider, an exhausted budget
 * class), added by the services that know it (the remote budget, the AI routes). `reasons` names
 * every reason it may return, so rows it held clear once it stops holding them.
 */
export interface KindGate {
  readonly reasons: readonly GardenerBlockerKey[];
  blocker(type: string, policy: GardenerKindPolicy): GardenerBlocker | null;
}

/** A further gate on one background model call (an exhausted budget class). */
export interface CallGate {
  readonly reasons: readonly GardenerBlockerKey[];
  blocker(call: BackgroundCall): GardenerBlocker | null;
}

/** What the gate reads of one model call at admission. */
export interface BackgroundCall {
  readonly remote: boolean;
  readonly generative: boolean;
  readonly workloadClass: AiWorkloadClass;
}

/** The global state the gates read: the controls and the machine. */
export interface GateState {
  readonly controls: KnowledgeControls;
  readonly power: PowerSnapshot;
  readonly config: GardenerConfig;
}

/** The workload classes that write with a generative model; embedding and deciding do not. */
const generativeClasses: ReadonlySet<AiWorkloadClass> = new Set([
  "write-fast",
  "write-quality",
  "answer"
]);

/** The reasons the controls and the machine hold work by; they clear when they stop holding. */
export const controlGateReasons: readonly GardenerBlockerKey[] = [
  "paused.user_pause",
  "paused.autonomy_off",
  "paused.only_idle_user_active",
  "paused.only_ac_on_battery"
];

/** The "paused" holds every background task shares: pause, only idle, only on AC. */
function sharedHolds(state: GateState): GardenerBlocker[] {
  const holds: GardenerBlocker[] = [];
  if (state.controls.paused) holds.push(gardenerBlocker("paused", "user_pause"));
  if (state.controls.onlyIdle && state.power.idleMs < state.config.power.onlyIdleAfterMs)
    holds.push(gardenerBlocker("paused", "only_idle_user_active"));
  if (state.controls.onlyOnAc && state.power.onBattery)
    holds.push(gardenerBlocker("paused", "only_ac_on_battery"));
  return holds;
}

/**
 * The blocker a global gate holds every row of a kind by now, or null (D7 "gate at claim"). Only
 * Gardener kinds whose rows are all background work are held: pause, only idle and only on AC
 * hold each of them; autonomy Off holds the generative ones. Ingestion, its stages and the mixed
 * link kinds are never held here (their background calls are, at admission).
 */
export function kindBlocker(
  type: string,
  state: GateState,
  gates: readonly KindGate[] = []
): GardenerBlocker | null {
  const policy = gardenerKindPolicy(type);
  if (!policy || policy.budget !== "background") return null;
  const holds: Array<GardenerBlocker | null> = sharedHolds(state);
  if (autonomyHoldsKind(type, state.controls.autonomy))
    holds.push(gardenerBlocker("paused", "autonomy_off"));
  for (const gate of gates) holds.push(gate.blocker(type, policy));
  return highestGardenerBlocker(holds);
}

/**
 * The blocker that refuses one background model call now, or null (D7 "gate at admission"). User
 * and interactive calls are never refused, whatever their priority: P2 also carries user imports.
 */
export function callBlocker(
  call: BackgroundCall,
  state: GateState,
  gates: readonly CallGate[] = []
): GardenerBlocker | null {
  const holds: Array<GardenerBlocker | null> = sharedHolds(state);
  if (autonomyRefusesCall(state.controls.autonomy, call))
    holds.push(gardenerBlocker("paused", "autonomy_off"));
  for (const gate of gates) holds.push(gate.blocker(call));
  return highestGardenerBlocker(holds);
}

export interface BackgroundGateOptions {
  /** The controls as last read (never a query on the claim path). */
  controls: () => KnowledgeControls;
  power: () => PowerSnapshot;
  /** The local lane's duty cycle for background calls now (D15); 1 when left out. */
  dutyCycle?: () => number;
  config?: GardenerConfig;
  kindGates?: readonly KindGate[];
  callGates?: readonly CallGate[];
  /** Wall clock in milliseconds. */
  now?: () => number;
}

/**
 * The Gardener's global gates (F4 D7, D12, D15): pause, autonomy, only idle and only on AC, plus
 * the gates other services add. At claim it names the kinds to leave out of the claim, so their
 * rows are never claimed (attempts and dedupe keys untouched); at admission it refuses background
 * model calls with a `BackgroundBlockedError` and remembers the refusal for the call's job, so the
 * supervisor sets the task aside even when its executor swallowed the error.
 */
export class BackgroundGate {
  private readonly config: GardenerConfig;
  private readonly now: () => number;
  private readonly admissionBlocks = new Map<string, { blocker: GardenerBlocker; at: number }>();

  public constructor(private readonly options: BackgroundGateOptions) {
    this.config = options.config ?? defaultGardenerConfig;
    this.now = options.now ?? Date.now;
  }

  public state(): GateState {
    return { controls: this.options.controls(), power: this.options.power(), config: this.config };
  }

  /** The kinds among `types` a global gate holds now, each with its highest blocker. */
  public forKinds(types: Iterable<string>): Map<string, GardenerBlocker> {
    const state = this.state();
    const held = new Map<string, GardenerBlocker>();
    for (const type of types) {
      const blocker = kindBlocker(type, state, this.options.kindGates);
      if (blocker) held.set(type, blocker);
    }
    return held;
  }

  /** The kinds among `types` the claim leaves out now. */
  public heldKinds(types: readonly string[]): ReadonlySet<string> {
    return new Set(this.forKinds(types).keys());
  }

  /** Every reason this gate holds work by; its rows clear once the gate stops holding them. */
  public evaluatedReasons(): GardenerBlockerKey[] {
    return [
      ...new Set([
        ...controlGateReasons,
        ...(this.options.kindGates ?? []).flatMap((gate) => gate.reasons),
        ...(this.options.callGates ?? []).flatMap((gate) => gate.reasons)
      ])
    ];
  }

  /**
   * The evaluated reasons that hold anything now: at least one kind (`types`) or one kind of
   * background call. Rows of a reason that holds nothing any more are cleared.
   */
  public activeReasons(types: Iterable<string>): Set<GardenerBlockerKey> {
    const state = this.state();
    const active = new Set<GardenerBlockerKey>();
    for (const blocker of sharedHolds(state)) active.add(gardenerBlockerKey(blocker));
    if (state.controls.autonomy === "off") active.add("paused.autonomy_off");
    for (const type of types) {
      const policy = gardenerKindPolicy(type);
      if (!policy) continue;
      for (const gate of this.options.kindGates ?? []) {
        const blocker = gate.blocker(type, policy);
        if (blocker) active.add(gardenerBlockerKey(blocker));
      }
    }
    for (const gate of this.options.callGates ?? [])
      for (const call of representativeCalls) {
        const blocker = gate.blocker(call);
        if (blocker) active.add(gardenerBlockerKey(blocker));
      }
    return active;
  }

  /** The blocker that refuses one background model call now, or null. */
  public admission(entry: LaneAdmission): GardenerBlocker | null {
    if (entry.budgetClass !== "background") return null;
    return callBlocker(
      {
        remote: entry.lane !== "local",
        generative: generativeClasses.has(entry.workloadClass),
        workloadClass: entry.workloadClass
      },
      this.state(),
      this.options.callGates
    );
  }

  /**
   * The scheduler's admission hook: a background call a gate holds is refused with a
   * `BackgroundBlockedError`, and the refusal is kept for its job.
   */
  public readonly admit = (entry: LaneAdmission): BackgroundBlockedError | undefined => {
    const blocker = this.admission(entry);
    if (!blocker) return undefined;
    if (entry.jobId) this.rememberAdmissionBlock(entry.jobId, blocker);
    return new BackgroundBlockedError(blocker);
  };

  /** The local lane's duty cycle for background calls now. */
  public readonly dutyCycle = (): number => this.options.dutyCycle?.() ?? 1;

  /**
   * Remembers a refusal a job's call met outside the scheduler's admission (the RemoteBudget's,
   * D14), so the supervisor sets the task aside even when its executor swallowed the refusal.
   */
  public noteRefusal(jobId: string, blocker: GardenerBlocker): void {
    this.rememberAdmissionBlock(jobId, blocker);
  }

  /** The blocker a call of this job met at admission, once; undefined when none did. */
  public takeAdmissionBlock(jobId: string): GardenerBlocker | undefined {
    const entry = this.admissionBlocks.get(jobId);
    this.admissionBlocks.delete(jobId);
    return entry?.blocker;
  }

  private rememberAdmissionBlock(jobId: string, blocker: GardenerBlocker): void {
    const now = this.now();
    // Refusals of calls no job collects (a job that ended meanwhile) are forgotten after a while.
    for (const [id, entry] of this.admissionBlocks)
      if (now - entry.at > this.config.blockers.admissionBlockTtlMs)
        this.admissionBlocks.delete(id);
    const kept = this.admissionBlocks.get(jobId)?.blocker;
    // A job keeps the highest blocker its calls met.
    const chosen = highestGardenerBlocker([kept, blocker]) ?? blocker;
    this.admissionBlocks.set(jobId, { blocker: chosen, at: now });
  }
}

/** One call of each shape, to ask call gates whether they hold anything at all. */
const representativeCalls: readonly BackgroundCall[] = [
  { remote: true, generative: true, workloadClass: "write-fast" },
  { remote: true, generative: false, workloadClass: "embed" },
  { remote: false, generative: true, workloadClass: "write-fast" },
  { remote: false, generative: false, workloadClass: "decide" }
];
