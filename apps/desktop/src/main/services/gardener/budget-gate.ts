// The RemoteBudget in the Gardener's background policy (F4 D7, D14; spec 3.1 "gate at claim": an
// exhausted budget class). The budget refuses each background remote attempt at admission
// (`RemoteBudgetRefusal`, which the supervisor maps to a `cap` blocker); this gate also leaves out of
// the claim a background kind whose route the budget refuses now, so its rows wait stamped instead of
// being claimed only to be refused, and so the rows it held clear as soon as it stops holding them
// (the person continues past the pause share, raises the cap, a day or month rolls over, a route
// moves to a local model). A kind is metered by the route its calls resolve: the operation route
// they try first when it has one, else its class route.
import {
  gardenerBlocker,
  gardenerTaskKind,
  relationExplainBackfillJobType,
  type AiClassId,
  type BudgetSnapshot,
  type GardenerBlocker,
  type GardenerBlockerKey,
  type GardenerClearingEvent
} from "@app/domain";

import { relationExplanationOperation } from "../ai-task-parameters.js";
import type { KindGate } from "./background-gate.js";

/**
 * How the route of an AI class is metered now: `money` a priced remote route (the monthly cap),
 * `calls` a subscription route (the daily background calls), `none` a local route or no route.
 */
export type RouteMetering = "money" | "calls" | "none";

/** The classes whose routes the budget meters for background kinds (generative and embedding). */
export const meteredRouteClasses: readonly AiClassId[] = ["write-fast", "write-quality", "embed"];

/**
 * A route the budget meters: a class route, or the operation route a kind's calls resolve before
 * it (`op:<operation>`, then the class route, then `task`: `aiRouteKeys`).
 */
export interface MeteredRoute {
  routeClass: AiClassId;
  operation?: string;
  /** The task those calls run; absent: the class's own task (`structured-output`, `embedding`). */
  task?: "text-generation";
}

/**
 * The background kinds whose calls resolve an operation route before their class route. Their
 * operation route may name another provider than the class route (a legacy library's mapped route,
 * the soak's money window), and the budget refuses by the route a call takes, so the gate holds
 * them by it: otherwise their rows refused at admission are set free at the next re-gate while the
 * budget still refuses them (gate S 10-25: cleared, claimed again before the person continued).
 */
export const kindRouteOperations: Readonly<Record<string, Omit<MeteredRoute, "routeClass">>> = {
  [relationExplainBackfillJobType]: {
    operation: relationExplanationOperation,
    task: "text-generation"
  }
};

/** The key the gate holds a metered route by. */
function meteredRouteKey(route: MeteredRoute): string {
  return route.operation ? `op:${route.operation}>${route.routeClass}` : route.routeClass;
}

/** The route the budget meters a background kind by, or null when it meters none. */
export function kindMeteredRoute(type: string): MeteredRoute | null {
  const kind = gardenerTaskKind(type);
  if (!kind?.remote || !kind.routeClass || !meteredRouteClasses.includes(kind.routeClass))
    return null;
  return { routeClass: kind.routeClass, ...kindRouteOperations[type] };
}

/** Every route the gate meters: each class route, and each operation route a kind resolves. */
function meteredRoutes(): MeteredRoute[] {
  const routes = new Map<string, MeteredRoute>(
    meteredRouteClasses.map((routeClass) => [routeClass, { routeClass }])
  );
  for (const type of Object.keys(kindRouteOperations)) {
    const route = kindMeteredRoute(type);
    if (route) routes.set(meteredRouteKey(route), route);
  }
  return [...routes.values()];
}

/** Every reason the budget gate holds work by: its rows clear once it stops holding them. */
export const budgetGateReasons: readonly GardenerBlockerKey[] = [
  "cap.money_80",
  "cap.money_100",
  "cap.subscription_daily"
];

/** The blocker the budget holds a route of `metering` by now, or null. */
export function budgetBlocker(
  snapshot: Pick<BudgetSnapshot, "money" | "calls">,
  metering: RouteMetering
): GardenerBlocker | null {
  if (metering === "money") {
    if (snapshot.money.state === "exhausted") return gardenerBlocker("cap", "money_100");
    if (snapshot.money.state === "paused") return gardenerBlocker("cap", "money_80");
  }
  if (metering === "calls" && snapshot.calls.state === "exhausted")
    return gardenerBlocker("cap", "subscription_daily");
  return null;
}

export interface RemoteBudgetGateOptions {
  /** The budget's meters now (`RemoteBudget.snapshot`). */
  snapshot: () => Promise<Pick<BudgetSnapshot, "money" | "calls">>;
  /** How a route is metered now, read with the AI configuration. */
  metering: (route: MeteredRoute) => Promise<RouteMetering>;
}

/**
 * The claim-time budget gate. The claim path is synchronous, so the gate answers from what its
 * last {@link RemoteBudgetGate.refresh} read: the budget's meters and the metering of each route
 * the remote kinds use ({@link kindMeteredRoute}). A kind is held only when its own route is
 * metered and refused now; a local route is never held (at 100% background work goes local-only,
 * D14).
 */
export class RemoteBudgetGate implements KindGate {
  public readonly reasons = budgetGateReasons;
  private holds = new Map<string, GardenerBlocker>();

  public constructor(private readonly options: RemoteBudgetGateOptions) {}

  public blocker(type: string): GardenerBlocker | null {
    const route = kindMeteredRoute(type);
    return route ? (this.holds.get(meteredRouteKey(route)) ?? null) : null;
  }

  /** Reads the budget and the routes again; answers whether what the gate holds changed. */
  public async refresh(): Promise<boolean> {
    const routes = meteredRoutes();
    const [snapshot, meterings] = await Promise.all([
      this.options.snapshot(),
      Promise.all(routes.map((route) => this.options.metering(route)))
    ]);
    const next = new Map<string, GardenerBlocker>();
    routes.forEach((route, index) => {
      const blocker = budgetBlocker(snapshot, meterings[index]!);
      if (blocker) next.set(meteredRouteKey(route), blocker);
    });
    const describe = (holds: Map<string, GardenerBlocker>) =>
      [...holds].map(([key, blocker]) => `${key}=${blocker.reason}`).join(",");
    const changed = describe(next) !== describe(this.holds);
    this.holds = next;
    return changed;
  }
}

export interface BudgetRelayOptions {
  budget: {
    snapshot(): Promise<BudgetSnapshot>;
    continuePastPause(): Promise<BudgetSnapshot>;
  };
  gate: Pick<RemoteBudgetGate, "refresh">;
  /** The background policy's blocker service: re-gates and clears rows (null before it exists). */
  blockers: () => {
    reconcile(): Promise<void>;
    notify(event: GardenerClearingEvent): Promise<void>;
  } | null;
  /** Publishes the meters after they changed (`budget.changed` on the event bus). */
  publish?: (snapshot: BudgetSnapshot) => void;
  logger?: Pick<Console, "warn">;
}

/**
 * Follows the RemoteBudget's changes (its `onChange`: a settle, a refusal, a rollover, a continue):
 * reads the meters once per burst, publishes them, refreshes the budget gate and re-gates when what
 * the gate holds changed. It also carries the Activity's "continue" action (D14: past the pause
 * share, remote background work resumes up to the cap once the person continues).
 */
export class BudgetRelay {
  private running: Promise<void> | null = null;
  private again = false;

  public constructor(private readonly options: BudgetRelayOptions) {}

  /** The budget changed: one read follows a burst of changes, and one more if it changed meanwhile. */
  public changed(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.follow().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.changed();
      }
    });
  }

  /** Resolves once the reads asked for so far have finished (tests, shutdown). */
  public async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  /**
   * The Activity's "continue" past the pause share: the budget records it, the gate reads it, and
   * the rows held by the pause (`cap.money_80`) are set free.
   */
  public async continuePastPause(): Promise<BudgetSnapshot> {
    const snapshot = await this.options.budget.continuePastPause();
    await this.options.gate.refresh();
    await this.options.blockers()?.notify("budget_continued");
    return snapshot;
  }

  private async follow(): Promise<void> {
    try {
      const snapshot = await this.options.budget.snapshot();
      this.options.publish?.(snapshot);
      if (await this.options.gate.refresh()) await this.options.blockers()?.reconcile();
    } catch (error) {
      this.options.logger?.warn("The remote budget's change could not be followed", error);
    }
  }
}
